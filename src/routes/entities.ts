import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { validateJson } from '../middleware/validation.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { createEntitySchema, updateEntitySchema, entityResponseSchema } from '../schemas/index.js';
import { setAclRequestSchema, SetAclRequest } from '../schemas/acl.js';
import * as response from '../utils/response.js';
import { getLogger } from '../middleware/request-context.js';
import { validatePropertiesAgainstSchema, formatValidationErrors } from '../utils/json-schema.js';
import { logEntityOperation } from '../utils/audit.js';
import {
  getCache,
  setCache,
  getEntityCacheKey,
  invalidateEntityCache,
  CACHE_TTL,
} from '../utils/cache.js';
import {
  applyFieldSelection,
  applyFieldSelectionToArray,
  ENTITY_ALLOWED_FIELDS,
} from '../utils/field-selection.js';
import {
  getEnrichedAclEntries,
  getOrCreateAcl,
  setEntityAcl,
  validateAclPrincipals,
  buildAclFilterClause,
  filterByAclPermission,
  hasPermissionByAclId,
  createResourceAcl,
} from '../utils/acl.js';

type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  JWT_SECRET: string;
  ENVIRONMENT: string;
};

const entities = new OpenAPIHono<{ Bindings: Bindings }>();

// Response schema for entity operations
const EntityResponseSchema = z
  .object({
    success: z.literal(true),
    data: entityResponseSchema,
    message: z.string().optional().openapi({ example: 'Resource created successfully' }),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('EntityResponse');

// Error response schema for entity operations
const EntityErrorResponseSchema = z
  .object({
    success: z.literal(false),
    error: z.string().openapi({ example: 'Type not found' }),
    code: z.string().openapi({ example: 'TYPE_NOT_FOUND' }),
    data: z
      .record(z.string(), z.unknown())
      .optional()
      .openapi({ description: 'Additional error details' }),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('EntityErrorResponse');

// Helper function to generate UUID
function generateUUID(): string {
  return crypto.randomUUID();
}

// Helper function to get current timestamp
function getCurrentTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}

// Helper function to find the latest version of an entity by any ID in its version chain
async function findLatestVersion(
  db: D1Database,
  entityId: string
): Promise<Record<string, unknown> | null> {
  // First, try direct match with is_latest
  const entity = await db
    .prepare('SELECT * FROM entities WHERE id = ? AND is_latest = 1')
    .bind(entityId)
    .first();

  if (entity) {
    return entity;
  }

  // If not found, this ID might be an old version. Find all entities that reference this ID
  // in their version chain and get the one with is_latest = 1
  const result = await db
    .prepare(
      `
    WITH RECURSIVE version_chain AS (
      -- Start with the given ID
      SELECT * FROM entities WHERE id = ?
      UNION ALL
      -- Find all entities that have this entity as previous_version
      SELECT e.* FROM entities e
      INNER JOIN version_chain vc ON e.previous_version_id = vc.id
    )
    SELECT * FROM version_chain WHERE is_latest = 1 LIMIT 1
  `
    )
    .bind(entityId)
    .first();

  return result || null;
}

/**
 * POST /api/entities route definition
 */
const createEntityRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Entities'],
  summary: 'Create entity',
  description:
    'Create a new entity. Authentication required. The creator is automatically granted write permission. Permission inheritance: If `acl` is not provided, creator gets write permission (private to creator). If `acl` is an empty array, entity is public (no ACL restrictions). If `acl` is provided with entries, uses those entries while ensuring creator has write permission.',
  operationId: 'createEntity',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth()] as const,
  request: {
    body: {
      content: {
        'application/json': {
          schema: createEntitySchema,
        },
      },
      required: true,
    },
  },
  responses: {
    201: {
      description: 'Entity created',
      content: {
        'application/json': {
          schema: EntityResponseSchema,
        },
      },
    },
    400: {
      description: 'Validation error or schema validation failed',
      content: {
        'application/json': {
          schema: EntityErrorResponseSchema,
        },
      },
    },
    401: {
      description: 'Unauthorized - authentication required',
      content: {
        'application/json': {
          schema: EntityErrorResponseSchema,
        },
      },
    },
    404: {
      description: 'Type not found',
      content: {
        'application/json': {
          schema: EntityErrorResponseSchema,
        },
      },
    },
  },
});

// Paginated entity list response schema
const EntityListResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.array(entityResponseSchema),
    metadata: z
      .object({
        hasMore: z.boolean().openapi({ example: true }),
        cursor: z
          .string()
          .optional()
          .openapi({ example: '1704067200:550e8400-e29b-41d4-a716-446655440000' }),
        total: z.number().int().optional().openapi({ example: 100 }),
      })
      .openapi({ description: 'Pagination metadata' }),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('EntityListResponse');

// OpenAPI-specific query schema for entity listing (without transforms for proper type inference)
const listEntitiesQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .openapi({
      param: { name: 'limit', in: 'query' },
      example: '20',
      description: 'Maximum number of items to return (1-100)',
    }),
  cursor: z
    .string()
    .optional()
    .openapi({
      param: { name: 'cursor', in: 'query' },
      example: '1704067200:550e8400-e29b-41d4-a716-446655440000',
      description: 'Cursor for pagination',
    }),
  include_deleted: z
    .string()
    .optional()
    .openapi({
      param: { name: 'include_deleted', in: 'query' },
      example: 'false',
      description: 'Whether to include deleted entities',
    }),
  fields: z
    .string()
    .optional()
    .openapi({
      param: { name: 'fields', in: 'query' },
      example: 'id,type_id,properties',
      description: 'Comma-separated list of fields to return',
    }),
  type_id: z
    .string()
    .optional()
    .openapi({
      param: { name: 'type_id', in: 'query' },
      example: 'Person',
      description: 'Filter by entity type',
    }),
  created_by: z
    .string()
    .uuid()
    .optional()
    .openapi({
      param: { name: 'created_by', in: 'query' },
      example: '550e8400-e29b-41d4-a716-446655440001',
      description: 'Filter by creator user ID',
    }),
  created_after: z
    .string()
    .optional()
    .openapi({
      param: { name: 'created_after', in: 'query' },
      example: '1704067200',
      description: 'Filter entities created after this Unix timestamp',
    }),
  created_before: z
    .string()
    .optional()
    .openapi({
      param: { name: 'created_before', in: 'query' },
      example: '1704153600',
      description: 'Filter entities created before this Unix timestamp',
    }),
});

/**
 * GET /api/entities route definition
 */
const listEntitiesRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Entities'],
  summary: 'List entities',
  description:
    'List entities with optional filtering and cursor-based pagination. ACL filtering is applied based on authentication status: authenticated users see entities they have read permission on, unauthenticated requests only see public entities (NULL acl_id).',
  operationId: 'listEntities',
  request: {
    query: listEntitiesQuerySchema,
  },
  responses: {
    200: {
      description: 'List of entities with pagination metadata',
      content: {
        'application/json': {
          schema: EntityListResponseSchema,
        },
      },
    },
    400: {
      description: 'Invalid query parameters or field selection',
      content: {
        'application/json': {
          schema: EntityErrorResponseSchema,
        },
      },
    },
  },
});

/**
 * POST /api/entities
 * Create a new entity
 */
entities.openapi(createEntityRoute, async c => {
  const data = c.req.valid('json');
  const db = c.env.DB;
  const user = c.get('user');

  const id = generateUUID();
  const now = getCurrentTimestamp();
  const userId = user.user_id;

  try {
    // Check if type_id exists and get its json_schema
    const typeRecord = await db
      .prepare('SELECT id, json_schema FROM types WHERE id = ?')
      .bind(data.type_id)
      .first();

    if (!typeRecord) {
      return c.json(
        {
          success: false as const,
          error: 'Type not found',
          code: 'TYPE_NOT_FOUND',
          timestamp: new Date().toISOString(),
        },
        404
      );
    }

    // Validate properties against the type's JSON schema (if defined)
    const schemaValidation = validatePropertiesAgainstSchema(
      data.properties,
      typeRecord.json_schema as string | null
    );

    if (!schemaValidation.valid) {
      return c.json(
        {
          success: false as const,
          error: `Property validation failed: ${formatValidationErrors(schemaValidation.errors)}`,
          code: 'SCHEMA_VALIDATION_FAILED',
          data: { validation_errors: schemaValidation.errors },
          timestamp: new Date().toISOString(),
        },
        400
      );
    }

    // Validate explicit ACL principals if provided
    if (data.acl && data.acl.length > 0) {
      const validation = await validateAclPrincipals(db, data.acl);
      if (!validation.valid) {
        return c.json(
          {
            success: false as const,
            error: `Invalid ACL entries: ${validation.errors.join(', ')}`,
            code: 'INVALID_ACL',
            timestamp: new Date().toISOString(),
          },
          400
        );
      }
    }

    // Create ACL for the new entity with permission inheritance
    // - undefined acl: creator gets write permission
    // - empty array: public (no ACL)
    // - explicit entries: uses entries + ensures creator has write
    const aclId = await createResourceAcl(db, userId, data.acl);

    // Convert properties to string
    const propertiesString = JSON.stringify(data.properties);

    // Insert the new entity (version 1) with ACL
    await db
      .prepare(
        `
      INSERT INTO entities (id, type_id, properties, version, previous_version_id, created_at, created_by, is_deleted, is_latest, acl_id)
      VALUES (?, ?, ?, 1, NULL, ?, ?, 0, 1, ?)
    `
      )
      .bind(id, data.type_id, propertiesString, now, userId, aclId)
      .run();

    // Fetch the created entity
    const created = await db.prepare('SELECT * FROM entities WHERE id = ?').bind(id).first();

    // Parse properties back to object
    const entityData = {
      id: created?.id as string,
      type_id: created?.type_id as string,
      properties: created?.properties ? JSON.parse(created.properties as string) : {},
      version: created?.version as number,
      previous_version_id: (created?.previous_version_id as string) || null,
      created_at: created?.created_at as number,
      created_by: created?.created_by as string,
      is_deleted: created?.is_deleted === 1,
      is_latest: created?.is_latest === 1,
    };

    // Log the create operation
    try {
      await logEntityOperation(db, c, 'create', id, userId, {
        type_id: data.type_id,
        properties: data.properties,
        acl_id: aclId,
      });
    } catch (auditError) {
      // Log but don't fail the request if audit logging fails
      getLogger(c)
        .child({ module: 'entities' })
        .warn('Failed to create audit log', { error: auditError });
    }

    return c.json(
      {
        success: true as const,
        data: entityData,
        message: 'Resource created successfully',
        timestamp: new Date().toISOString(),
      },
      201
    );
  } catch (error) {
    getLogger(c)
      .child({ module: 'entities' })
      .error('Error creating entity', error instanceof Error ? error : undefined);
    throw error;
  }
});

// Apply optionalAuth middleware for the list entities route
// Note: Must be registered before the openapi handler
entities.use('/', async (c, next) => {
  // Only apply to GET requests
  if (c.req.method === 'GET') {
    return optionalAuth()(c, next);
  }
  return next();
});

// Path parameters schema for entity ID
const EntityIdParamsSchema = z.object({
  id: z
    .string()
    .uuid()
    .openapi({
      param: { name: 'id', in: 'path' },
      example: '550e8400-e29b-41d4-a716-446655440000',
      description: 'Entity ID (UUID)',
    }),
});

// Query schema for field selection on single entity
const EntityFieldSelectionQuerySchema = z.object({
  fields: z
    .string()
    .optional()
    .openapi({
      param: { name: 'fields', in: 'query' },
      example: 'id,type_id,properties',
      description: 'Comma-separated list of fields to include in response',
    }),
});

/**
 * GET /api/entities/:id route definition
 */
const getEntityRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Entities'],
  summary: 'Get entity by ID',
  description:
    'Get the latest version of a specific entity. Supports field selection via the `fields` query parameter. Permission checking: Authenticated users must have read permission on the entity. Entities with NULL acl_id are accessible to all authenticated users. Unauthenticated requests can only access entities with NULL acl_id.',
  operationId: 'getEntityById',
  request: {
    params: EntityIdParamsSchema,
    query: EntityFieldSelectionQuerySchema,
  },
  responses: {
    200: {
      description: 'Entity found',
      content: {
        'application/json': {
          schema: EntityResponseSchema,
        },
      },
    },
    400: {
      description: 'Validation error (e.g., invalid fields requested)',
      content: {
        'application/json': {
          schema: EntityErrorResponseSchema,
        },
      },
    },
    403: {
      description: 'Forbidden - no permission to view this entity',
      content: {
        'application/json': {
          schema: EntityErrorResponseSchema,
        },
      },
    },
    404: {
      description: 'Entity not found',
      content: {
        'application/json': {
          schema: EntityErrorResponseSchema,
        },
      },
    },
  },
});

/**
 * GET /api/entities
 * List entities with optional filtering and cursor-based pagination
 */
entities.openapi(listEntitiesRoute, async c => {
  const rawQuery = c.req.valid('query');
  const db = c.env.DB;
  const kv = c.env.KV;
  const user = c.get('user');

  // Parse query parameters with proper type coercion
  const limitStr = rawQuery.limit ?? '20';
  const limit = Math.min(Math.max(parseInt(limitStr, 10) || 20, 1), 100);
  const includeDeleted = rawQuery.include_deleted === 'true';
  const cursor = rawQuery.cursor;
  const fields = rawQuery.fields;
  const typeId = rawQuery.type_id;
  const createdBy = rawQuery.created_by;
  const createdAfter = rawQuery.created_after ? parseInt(rawQuery.created_after, 10) : undefined;
  const createdBefore = rawQuery.created_before ? parseInt(rawQuery.created_before, 10) : undefined;

  try {
    let sql = 'SELECT * FROM entities WHERE is_latest = 1';
    const bindings: unknown[] = [];

    // Apply ACL filtering based on authentication status
    let aclFilter: Awaited<ReturnType<typeof buildAclFilterClause>> | null = null;

    if (user) {
      // Authenticated user: filter by accessible ACLs
      aclFilter = await buildAclFilterClause(db, kv, user.user_id, 'read');

      if (aclFilter.useFilter) {
        sql += ` AND ${aclFilter.whereClause}`;
        bindings.push(...aclFilter.bindings);
      }
    } else {
      // Unauthenticated: only show public resources (NULL acl_id)
      sql += ' AND acl_id IS NULL';
    }

    // Apply other filters
    if (!includeDeleted) {
      sql += ' AND is_deleted = 0';
    }

    if (typeId) {
      sql += ' AND type_id = ?';
      bindings.push(typeId);
    }

    if (createdBy) {
      sql += ' AND created_by = ?';
      bindings.push(createdBy);
    }

    if (createdAfter !== undefined && !isNaN(createdAfter)) {
      sql += ' AND created_at >= ?';
      bindings.push(createdAfter);
    }

    if (createdBefore !== undefined && !isNaN(createdBefore)) {
      sql += ' AND created_at <= ?';
      bindings.push(createdBefore);
    }

    // JSON property filters: extract property_<key> query parameters
    const allQueryParams = c.req.query();
    for (const [key, value] of Object.entries(allQueryParams)) {
      if (key.startsWith('property_')) {
        const propertyKey = key.substring('property_'.length);
        // Use SQLite's JSON1 extension to filter by property value
        // Try to parse value as number or boolean, otherwise treat as string
        let filterValue: string | number | boolean = value as string;

        // Check if value is a number
        const numValue = Number(value);
        if (!isNaN(numValue) && value !== '') {
          filterValue = numValue;
        } else if (value === 'true' || value === 'false') {
          // Check if value is a boolean
          filterValue = value === 'true';
        }

        // Use json_extract to get the value and compare
        // For strings, json_extract returns the raw value (not JSON-quoted)
        // For numbers and booleans, json_extract returns the JSON representation
        sql += ' AND json_extract(properties, ?) = ?';
        bindings.push(`$.${propertyKey}`, filterValue);
      }
    }

    // Cursor-based pagination: cursor is "created_at:id" for stable ordering
    if (cursor) {
      try {
        const [cursorTimestamp, cursorId] = cursor.split(':');
        const timestamp = parseInt(cursorTimestamp, 10);
        if (!isNaN(timestamp) && cursorId) {
          // Get records where created_at < cursor OR (created_at = cursor AND id < cursorId)
          sql += ' AND (created_at < ? OR (created_at = ? AND id < ?))';
          bindings.push(timestamp, timestamp, cursorId);
        }
      } catch {
        // Invalid cursor format, ignore and continue without cursor
        getLogger(c).child({ module: 'entities' }).warn('Invalid cursor format', { cursor });
      }
    }

    sql += ' ORDER BY created_at DESC, id DESC';

    // Fetch limit + 1 to check if there are more results
    // If using per-row ACL filtering, fetch more to account for filtered items
    const fetchLimit = aclFilter && !aclFilter.useFilter ? (limit + 1) * 3 : limit + 1;
    sql += ' LIMIT ?';
    bindings.push(fetchLimit);

    const { results } = await db
      .prepare(sql)
      .bind(...bindings)
      .all();

    // Apply per-row ACL filtering if needed (when user has too many accessible ACLs)
    let filteredResults = results;
    if (aclFilter && !aclFilter.useFilter) {
      filteredResults = filterByAclPermission(
        results as Array<{ acl_id?: number | null }>,
        aclFilter.accessibleAclIds
      );
    }

    // Check if there are more results
    const hasMore = filteredResults.length > limit;
    const items = hasMore ? filteredResults.slice(0, limit) : filteredResults;

    // Parse properties for each entity
    const entitiesData = items.map(entity => ({
      ...entity,
      properties: entity.properties ? JSON.parse(entity.properties as string) : {},
      is_deleted: entity.is_deleted === 1,
      is_latest: entity.is_latest === 1,
    }));

    // Apply field selection if requested
    const fieldSelection = applyFieldSelectionToArray(
      entitiesData as Record<string, unknown>[],
      fields,
      ENTITY_ALLOWED_FIELDS
    );

    if (!fieldSelection.success) {
      return c.json(
        {
          success: false as const,
          error: `Invalid fields requested: ${fieldSelection.invalidFields.join(', ')}`,
          code: 'INVALID_FIELDS',
          data: { allowed_fields: Array.from(ENTITY_ALLOWED_FIELDS) },
          timestamp: new Date().toISOString(),
        },
        400
      );
    }

    // Generate next cursor from the last item
    let nextCursor: string | undefined = undefined;
    if (hasMore && items.length > 0) {
      const lastItem = items[items.length - 1];
      nextCursor = `${lastItem.created_at}:${lastItem.id}`;
    }

    return c.json(
      {
        success: true as const,
        data: fieldSelection.data as z.infer<typeof entityResponseSchema>[],
        metadata: {
          hasMore,
          ...(nextCursor && { cursor: nextCursor }),
        },
        timestamp: new Date().toISOString(),
      },
      200
    );
  } catch (error) {
    getLogger(c)
      .child({ module: 'entities' })
      .error('Error listing entities', error instanceof Error ? error : undefined);
    throw error;
  }
});

// Apply optionalAuth middleware for the get entity by ID route
entities.use('/:id', async (c, next) => {
  // Only apply to GET requests (not PUT, DELETE, etc.)
  if (c.req.method === 'GET') {
    return optionalAuth()(c, next);
  }
  return next();
});

/**
 * GET /api/entities/:id
 * Get the latest version of a specific entity
 *
 * Supports field selection via the `fields` query parameter.
 * Example: GET /api/entities/123?fields=id,type_id,properties
 *
 * Caching: Individual entity lookups are cached for fast repeated access.
 * Cache is invalidated when entity is updated, deleted, or restored.
 * Note: Field selection is applied after cache retrieval for consistency.
 *
 * Permission checking:
 * - Authenticated users must have read permission on the entity
 * - Entities with NULL acl_id are accessible to all authenticated users
 * - Unauthenticated requests can only access entities with NULL acl_id
 */
entities.openapi(getEntityRoute, async c => {
  const { id } = c.req.valid('param');
  const { fields: fieldsParam } = c.req.valid('query');
  const db = c.env.DB;
  const kv = c.env.KV;
  const user = c.get('user');

  try {
    const entity = await findLatestVersion(db, id);

    if (!entity) {
      return c.json(
        {
          success: false as const,
          error: 'Entity not found',
          code: 'NOT_FOUND',
          timestamp: new Date().toISOString(),
        },
        404
      );
    }

    // Check permission
    const aclId = entity.acl_id as number | null;
    if (user) {
      // Authenticated user: check if they have read permission
      const canRead = await hasPermissionByAclId(db, kv, user.user_id, aclId, 'read');
      if (!canRead) {
        return c.json(
          {
            success: false as const,
            error: 'You do not have permission to view this entity',
            code: 'FORBIDDEN',
            timestamp: new Date().toISOString(),
          },
          403
        );
      }
    } else {
      // Unauthenticated: only allow access to public entities (NULL acl_id)
      if (aclId !== null) {
        return c.json(
          {
            success: false as const,
            error: 'Authentication required to view this entity',
            code: 'FORBIDDEN',
            timestamp: new Date().toISOString(),
          },
          403
        );
      }
    }

    // Try to get from cache (only for authenticated users with permission or public entities)
    const cacheKey = getEntityCacheKey(id);
    const cached = await getCache<Record<string, unknown>>(kv, cacheKey);
    if (cached) {
      // Apply field selection to cached response
      if (fieldsParam && cached.data) {
        const fieldSelection = applyFieldSelection(
          cached.data as Record<string, unknown>,
          fieldsParam,
          ENTITY_ALLOWED_FIELDS
        );
        if (!fieldSelection.success) {
          return c.json(
            {
              success: false as const,
              error: `Invalid fields requested: ${fieldSelection.invalidFields.join(', ')}`,
              code: 'INVALID_FIELDS',
              data: { allowed_fields: Array.from(ENTITY_ALLOWED_FIELDS) },
              timestamp: new Date().toISOString(),
            },
            400
          );
        }
        return c.json(
          {
            success: true as const,
            data: fieldSelection.data as z.infer<typeof entityResponseSchema>,
            timestamp: new Date().toISOString(),
          },
          200
        );
      }
      return c.json(cached as z.infer<typeof EntityResponseSchema>, 200);
    }

    // Parse properties back to object
    const result = {
      id: entity.id as string,
      type_id: entity.type_id as string,
      properties: entity.properties ? JSON.parse(entity.properties as string) : {},
      version: entity.version as number,
      previous_version_id: (entity.previous_version_id as string) || null,
      created_at: entity.created_at as number,
      created_by: entity.created_by as string,
      is_deleted: entity.is_deleted === 1,
      is_latest: entity.is_latest === 1,
    };

    const responseData = {
      success: true as const,
      data: result,
      timestamp: new Date().toISOString(),
    };

    // Cache the successful response (full data, field selection applied on retrieval)
    setCache(kv, cacheKey, responseData, CACHE_TTL.ENTITY).catch(() => {
      // Silently ignore cache write errors
    });

    // Apply field selection if requested
    if (fieldsParam) {
      const fieldSelection = applyFieldSelection(
        result as Record<string, unknown>,
        fieldsParam,
        ENTITY_ALLOWED_FIELDS
      );
      if (!fieldSelection.success) {
        return c.json(
          {
            success: false as const,
            error: `Invalid fields requested: ${fieldSelection.invalidFields.join(', ')}`,
            code: 'INVALID_FIELDS',
            data: { allowed_fields: Array.from(ENTITY_ALLOWED_FIELDS) },
            timestamp: new Date().toISOString(),
          },
          400
        );
      }
      return c.json(
        {
          success: true as const,
          data: fieldSelection.data as z.infer<typeof entityResponseSchema>,
          timestamp: new Date().toISOString(),
        },
        200
      );
    }

    return c.json(responseData, 200);
  } catch (error) {
    getLogger(c)
      .child({ module: 'entities' })
      .error('Error fetching entity', error instanceof Error ? error : undefined);
    throw error;
  }
});

/**
 * PUT /api/entities/:id route definition
 */
const updateEntityRoute = createRoute({
  method: 'put',
  path: '/{id}',
  tags: ['Entities'],
  summary: 'Update entity',
  description:
    'Update an entity by creating a new version with the provided properties. Requires authentication and write permission on the entity. The original entity ID continues to work for lookups and will return the latest version.',
  operationId: 'updateEntity',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth()] as const,
  request: {
    params: EntityIdParamsSchema,
    body: {
      content: {
        'application/json': {
          schema: updateEntitySchema,
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Entity updated (new version created)',
      content: {
        'application/json': {
          schema: EntityResponseSchema,
        },
      },
    },
    400: {
      description: 'Validation error or schema validation failed',
      content: {
        'application/json': {
          schema: EntityErrorResponseSchema,
        },
      },
    },
    401: {
      description: 'Unauthorized - authentication required',
      content: {
        'application/json': {
          schema: EntityErrorResponseSchema,
        },
      },
    },
    403: {
      description: 'Forbidden - no write permission on this entity',
      content: {
        'application/json': {
          schema: EntityErrorResponseSchema,
        },
      },
    },
    404: {
      description: 'Entity not found',
      content: {
        'application/json': {
          schema: EntityErrorResponseSchema,
        },
      },
    },
    409: {
      description: 'Conflict - entity is deleted (use restore endpoint first)',
      content: {
        'application/json': {
          schema: EntityErrorResponseSchema,
        },
      },
    },
  },
});

/**
 * PUT /api/entities/:id
 * Update entity (creates new version)
 *
 * Requires authentication and write permission on the entity.
 */
entities.openapi(updateEntityRoute, async c => {
  const { id } = c.req.valid('param');
  const data = c.req.valid('json');
  const db = c.env.DB;
  const kv = c.env.KV;
  const now = getCurrentTimestamp();
  const user = c.get('user');
  const userId = user.user_id;

  try {
    // Get the current latest version
    const currentVersion = await findLatestVersion(db, id);

    if (!currentVersion) {
      return c.json(
        {
          success: false as const,
          error: 'Entity not found',
          code: 'NOT_FOUND',
          timestamp: new Date().toISOString(),
        },
        404
      );
    }

    // Check write permission
    const aclId = currentVersion.acl_id as number | null;
    const canWrite = await hasPermissionByAclId(db, kv, userId, aclId, 'write');
    if (!canWrite) {
      return c.json(
        {
          success: false as const,
          error: 'You do not have permission to update this entity',
          code: 'FORBIDDEN',
          timestamp: new Date().toISOString(),
        },
        403
      );
    }

    // Check if entity is soft-deleted
    if (currentVersion.is_deleted === 1) {
      return c.json(
        {
          success: false as const,
          error: 'Cannot update deleted entity. Use restore endpoint first.',
          code: 'ENTITY_DELETED',
          timestamp: new Date().toISOString(),
        },
        409
      );
    }

    // Fetch the type's JSON schema for validation
    const typeRecord = await db
      .prepare('SELECT json_schema FROM types WHERE id = ?')
      .bind(currentVersion.type_id)
      .first();

    // Validate properties against the type's JSON schema (if defined)
    const schemaValidation = validatePropertiesAgainstSchema(
      data.properties,
      typeRecord?.json_schema as string | null
    );

    if (!schemaValidation.valid) {
      return c.json(
        {
          success: false as const,
          error: `Property validation failed: ${formatValidationErrors(schemaValidation.errors)}`,
          code: 'SCHEMA_VALIDATION_FAILED',
          data: { validation_errors: schemaValidation.errors },
          timestamp: new Date().toISOString(),
        },
        400
      );
    }

    const newVersion = (currentVersion.version as number) + 1;
    const propertiesString = JSON.stringify(data.properties);
    const newId = generateUUID(); // Generate NEW id for the new version

    // Start a transaction-like operation by updating in order
    // First, set current version's is_latest to false
    await db
      .prepare('UPDATE entities SET is_latest = 0 WHERE id = ?')
      .bind(currentVersion.id)
      .run();

    // Then insert new version with new ID, preserving the acl_id
    await db
      .prepare(
        `
      INSERT INTO entities (id, type_id, properties, version, previous_version_id, created_at, created_by, is_deleted, is_latest, acl_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?)
    `
      )
      .bind(
        newId,
        currentVersion.type_id,
        propertiesString,
        newVersion,
        currentVersion.id, // previous_version_id references the previous row's id
        now,
        userId,
        aclId
      )
      .run();

    // Fetch the new version
    const updated = await db.prepare('SELECT * FROM entities WHERE id = ?').bind(newId).first();

    const entityData = {
      id: updated?.id as string,
      type_id: updated?.type_id as string,
      properties: updated?.properties ? JSON.parse(updated.properties as string) : {},
      version: updated?.version as number,
      previous_version_id: (updated?.previous_version_id as string) || null,
      created_at: updated?.created_at as number,
      created_by: updated?.created_by as string,
      is_deleted: updated?.is_deleted === 1,
      is_latest: updated?.is_latest === 1,
    };

    // Log the update operation
    try {
      await logEntityOperation(db, c, 'update', newId, userId, {
        previous_version_id: currentVersion.id,
        old_properties: currentVersion.properties
          ? JSON.parse(currentVersion.properties as string)
          : {},
        new_properties: data.properties,
        version: newVersion,
      });
    } catch (auditError) {
      getLogger(c)
        .child({ module: 'entities' })
        .warn('Failed to create audit log', { error: auditError });
    }

    // Invalidate cache for both the original ID and the old version ID
    // since both can be used to look up this entity
    try {
      await Promise.all([
        invalidateEntityCache(kv, id),
        invalidateEntityCache(kv, currentVersion.id as string),
      ]);
    } catch (cacheError) {
      getLogger(c)
        .child({ module: 'entities' })
        .warn('Failed to invalidate cache', { error: cacheError });
    }

    return c.json(
      {
        success: true as const,
        data: entityData,
        message: 'Resource updated successfully',
        timestamp: new Date().toISOString(),
      },
      200
    );
  } catch (error) {
    getLogger(c)
      .child({ module: 'entities' })
      .error('Error updating entity', error instanceof Error ? error : undefined);
    throw error;
  }
});

// Delete success response schema
const DeleteSuccessResponseSchema = z
  .object({
    success: z.literal(true),
    message: z.string().openapi({ example: 'Resource deleted successfully' }),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('DeleteSuccessResponse');

/**
 * DELETE /api/entities/:id route definition
 */
const deleteEntityRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Entities'],
  summary: 'Delete entity',
  description:
    'Soft delete an entity by creating a new version with is_deleted = true. Requires authentication and write permission on the entity. The entity can be restored later using the restore endpoint.',
  operationId: 'deleteEntity',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth()] as const,
  request: {
    params: EntityIdParamsSchema,
  },
  responses: {
    200: {
      description: 'Entity deleted successfully',
      content: {
        'application/json': {
          schema: DeleteSuccessResponseSchema,
        },
      },
    },
    401: {
      description: 'Unauthorized - authentication required',
      content: {
        'application/json': {
          schema: EntityErrorResponseSchema,
        },
      },
    },
    403: {
      description: 'Forbidden - no write permission on this entity',
      content: {
        'application/json': {
          schema: EntityErrorResponseSchema,
        },
      },
    },
    404: {
      description: 'Entity not found',
      content: {
        'application/json': {
          schema: EntityErrorResponseSchema,
        },
      },
    },
    409: {
      description: 'Conflict - entity is already deleted',
      content: {
        'application/json': {
          schema: EntityErrorResponseSchema,
        },
      },
    },
  },
});

/**
 * DELETE /api/entities/:id
 * Soft delete entity (creates new version with is_deleted = true)
 *
 * Requires authentication and write permission on the entity.
 */
entities.openapi(deleteEntityRoute, async c => {
  const { id } = c.req.valid('param');
  const db = c.env.DB;
  const kv = c.env.KV;
  const now = getCurrentTimestamp();
  const user = c.get('user');
  const userId = user.user_id;

  try {
    // Get the current latest version
    const currentVersion = await findLatestVersion(db, id);

    if (!currentVersion) {
      return c.json(
        {
          success: false as const,
          error: 'Entity not found',
          code: 'NOT_FOUND',
          timestamp: new Date().toISOString(),
        },
        404
      );
    }

    // Check write permission
    const aclId = currentVersion.acl_id as number | null;
    const canWrite = await hasPermissionByAclId(db, kv, userId, aclId, 'write');
    if (!canWrite) {
      return c.json(
        {
          success: false as const,
          error: 'You do not have permission to delete this entity',
          code: 'FORBIDDEN',
          timestamp: new Date().toISOString(),
        },
        403
      );
    }

    // Check if already soft-deleted
    if (currentVersion.is_deleted === 1) {
      return c.json(
        {
          success: false as const,
          error: 'Entity is already deleted',
          code: 'ALREADY_DELETED',
          timestamp: new Date().toISOString(),
        },
        409
      );
    }

    const newVersion = (currentVersion.version as number) + 1;
    const newId = generateUUID();

    // Set current version's is_latest to false
    await db
      .prepare('UPDATE entities SET is_latest = 0 WHERE id = ?')
      .bind(currentVersion.id)
      .run();

    // Insert new version with is_deleted = 1 and new ID, preserving acl_id
    await db
      .prepare(
        `
      INSERT INTO entities (id, type_id, properties, version, previous_version_id, created_at, created_by, is_deleted, is_latest, acl_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?)
    `
      )
      .bind(
        newId,
        currentVersion.type_id,
        currentVersion.properties,
        newVersion,
        currentVersion.id,
        now,
        userId,
        aclId
      )
      .run();

    // Log the delete operation
    try {
      await logEntityOperation(db, c, 'delete', newId, userId, {
        previous_version_id: currentVersion.id,
        type_id: currentVersion.type_id,
        version: newVersion,
      });
    } catch (auditError) {
      getLogger(c)
        .child({ module: 'entities' })
        .warn('Failed to create audit log', { error: auditError });
    }

    // Invalidate cache for both the original ID and the old version ID
    try {
      await Promise.all([
        invalidateEntityCache(kv, id),
        invalidateEntityCache(kv, currentVersion.id as string),
      ]);
    } catch (cacheError) {
      getLogger(c)
        .child({ module: 'entities' })
        .warn('Failed to invalidate cache', { error: cacheError });
    }

    return c.json(
      {
        success: true as const,
        message: 'Resource deleted successfully',
        timestamp: new Date().toISOString(),
      },
      200
    );
  } catch (error) {
    getLogger(c)
      .child({ module: 'entities' })
      .error('Error deleting entity', error instanceof Error ? error : undefined);
    throw error;
  }
});

/**
 * POST /api/entities/:id/restore route definition
 */
const restoreEntityRoute = createRoute({
  method: 'post',
  path: '/{id}/restore',
  tags: ['Entities'],
  summary: 'Restore deleted entity',
  description:
    'Restore a soft-deleted entity by creating a new version with is_deleted = false. Requires authentication and write permission on the entity.',
  operationId: 'restoreEntity',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth()] as const,
  request: {
    params: EntityIdParamsSchema,
  },
  responses: {
    200: {
      description: 'Entity restored successfully',
      content: {
        'application/json': {
          schema: EntityResponseSchema,
        },
      },
    },
    401: {
      description: 'Unauthorized - authentication required',
      content: {
        'application/json': {
          schema: EntityErrorResponseSchema,
        },
      },
    },
    403: {
      description: 'Forbidden - no write permission on this entity',
      content: {
        'application/json': {
          schema: EntityErrorResponseSchema,
        },
      },
    },
    404: {
      description: 'Entity not found',
      content: {
        'application/json': {
          schema: EntityErrorResponseSchema,
        },
      },
    },
    409: {
      description: 'Conflict - entity is not deleted',
      content: {
        'application/json': {
          schema: EntityErrorResponseSchema,
        },
      },
    },
  },
});

/**
 * POST /api/entities/:id/restore
 * Restore a soft-deleted entity (creates new version with is_deleted = false)
 *
 * Requires authentication and write permission on the entity.
 */
entities.openapi(restoreEntityRoute, async c => {
  const { id } = c.req.valid('param');
  const db = c.env.DB;
  const kv = c.env.KV;
  const now = getCurrentTimestamp();
  const user = c.get('user');
  const userId = user.user_id;

  try {
    // Get the current latest version
    const currentVersion = await findLatestVersion(db, id);

    if (!currentVersion) {
      return c.json(
        {
          success: false as const,
          error: 'Entity not found',
          code: 'NOT_FOUND',
          timestamp: new Date().toISOString(),
        },
        404
      );
    }

    // Check write permission
    const aclId = currentVersion.acl_id as number | null;
    const canWrite = await hasPermissionByAclId(db, kv, userId, aclId, 'write');
    if (!canWrite) {
      return c.json(
        {
          success: false as const,
          error: 'You do not have permission to restore this entity',
          code: 'FORBIDDEN',
          timestamp: new Date().toISOString(),
        },
        403
      );
    }

    // Check if entity is not deleted
    if (currentVersion.is_deleted === 0) {
      return c.json(
        {
          success: false as const,
          error: 'Entity is not deleted',
          code: 'NOT_DELETED',
          timestamp: new Date().toISOString(),
        },
        409
      );
    }

    const newVersion = (currentVersion.version as number) + 1;
    const newId = generateUUID();

    // Set current version's is_latest to false
    await db
      .prepare('UPDATE entities SET is_latest = 0 WHERE id = ?')
      .bind(currentVersion.id)
      .run();

    // Insert new version with is_deleted = 0 and new ID, preserving acl_id
    await db
      .prepare(
        `
      INSERT INTO entities (id, type_id, properties, version, previous_version_id, created_at, created_by, is_deleted, is_latest, acl_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?)
    `
      )
      .bind(
        newId,
        currentVersion.type_id,
        currentVersion.properties,
        newVersion,
        currentVersion.id,
        now,
        userId,
        aclId
      )
      .run();

    // Fetch the restored version
    const restored = await db.prepare('SELECT * FROM entities WHERE id = ?').bind(newId).first();

    const entityData = {
      id: restored?.id as string,
      type_id: restored?.type_id as string,
      properties: restored?.properties ? JSON.parse(restored.properties as string) : {},
      version: restored?.version as number,
      previous_version_id: (restored?.previous_version_id as string) || null,
      created_at: restored?.created_at as number,
      created_by: restored?.created_by as string,
      is_deleted: restored?.is_deleted === 1,
      is_latest: restored?.is_latest === 1,
    };

    // Log the restore operation
    try {
      await logEntityOperation(db, c, 'restore', newId, userId, {
        previous_version_id: currentVersion.id,
        type_id: currentVersion.type_id,
        version: newVersion,
      });
    } catch (auditError) {
      getLogger(c)
        .child({ module: 'entities' })
        .warn('Failed to create audit log', { error: auditError });
    }

    // Invalidate cache for both the original ID and the old version ID
    try {
      await Promise.all([
        invalidateEntityCache(kv, id),
        invalidateEntityCache(kv, currentVersion.id as string),
      ]);
    } catch (cacheError) {
      getLogger(c)
        .child({ module: 'entities' })
        .warn('Failed to invalidate cache', { error: cacheError });
    }

    return c.json(
      {
        success: true as const,
        data: entityData,
        message: 'Entity restored successfully',
        timestamp: new Date().toISOString(),
      },
      200
    );
  } catch (error) {
    getLogger(c)
      .child({ module: 'entities' })
      .error('Error restoring entity', error instanceof Error ? error : undefined);
    throw error;
  }
});

// Response schema for entity version list
const EntityVersionListResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.array(entityResponseSchema),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('EntityVersionListResponse');

/**
 * GET /api/entities/:id/versions route definition
 */
const getEntityVersionsRoute = createRoute({
  method: 'get',
  path: '/{id}/versions',
  tags: ['Entities'],
  summary: 'Get all versions of an entity',
  description:
    'Get all versions of an entity, ordered by version number ascending. Permission checking: Authenticated users must have read permission on the entity. Entities with NULL acl_id are accessible to all authenticated users. Unauthenticated requests can only access entities with NULL acl_id (public).',
  operationId: 'getEntityVersions',
  request: {
    params: EntityIdParamsSchema,
  },
  responses: {
    200: {
      description: 'List of all versions of the entity',
      content: {
        'application/json': {
          schema: EntityVersionListResponseSchema,
        },
      },
    },
    403: {
      description: 'Forbidden - no permission to view this entity',
      content: {
        'application/json': {
          schema: EntityErrorResponseSchema,
        },
      },
    },
    404: {
      description: 'Entity not found',
      content: {
        'application/json': {
          schema: EntityErrorResponseSchema,
        },
      },
    },
  },
});

// Apply optionalAuth middleware for the get entity versions route
entities.use('/:id/versions', async (c, next) => {
  // Only apply to GET requests
  if (c.req.method === 'GET') {
    return optionalAuth()(c, next);
  }
  return next();
});

/**
 * GET /api/entities/:id/versions
 * Get all versions of an entity
 *
 * Permission checking:
 * - Authenticated users must have read permission on the entity
 * - Entities with NULL acl_id are accessible to all authenticated users
 * - Unauthenticated requests can only access entities with NULL acl_id (public)
 */
entities.openapi(getEntityVersionsRoute, async c => {
  const { id } = c.req.valid('param');
  const db = c.env.DB;
  const kv = c.env.KV;
  const user = c.get('user');

  try {
    // First, find the latest version to ensure the entity exists
    const latestVersion = await findLatestVersion(db, id);

    if (!latestVersion) {
      return c.json(
        {
          success: false as const,
          error: 'Entity not found',
          code: 'NOT_FOUND',
          timestamp: new Date().toISOString(),
        },
        404
      );
    }

    // Check permission
    const aclId = latestVersion.acl_id as number | null;
    if (user) {
      // Authenticated user: check if they have read permission
      const canRead = await hasPermissionByAclId(db, kv, user.user_id, aclId, 'read');
      if (!canRead) {
        return c.json(
          {
            success: false as const,
            error: 'You do not have permission to view this entity',
            code: 'FORBIDDEN',
            timestamp: new Date().toISOString(),
          },
          403
        );
      }
    } else {
      // Unauthenticated: only allow access to public entities (NULL acl_id)
      if (aclId !== null) {
        return c.json(
          {
            success: false as const,
            error: 'Authentication required to view this entity',
            code: 'FORBIDDEN',
            timestamp: new Date().toISOString(),
          },
          403
        );
      }
    }

    // Now get all versions in the chain using recursive CTE
    const { results } = await db
      .prepare(
        `
      WITH RECURSIVE version_chain AS (
        -- Start with version 1 (no previous_version_id)
        SELECT * FROM entities
        WHERE id = (
          SELECT id FROM entities WHERE id = ?
          UNION
          SELECT e1.id FROM entities e1
          WHERE e1.previous_version_id IS NULL
          AND EXISTS (
            WITH RECURSIVE temp_chain AS (
              SELECT id, previous_version_id FROM entities WHERE id = ?
              UNION ALL
              SELECT e2.id, e2.previous_version_id
              FROM entities e2
              INNER JOIN temp_chain tc ON e2.id = tc.previous_version_id
            )
            SELECT 1 FROM temp_chain WHERE temp_chain.id = e1.id
          )
        )
        UNION ALL
        -- Follow the chain forward
        SELECT e.* FROM entities e
        INNER JOIN version_chain vc ON e.previous_version_id = vc.id
      )
      SELECT * FROM version_chain ORDER BY version ASC
    `
      )
      .bind(id, id)
      .all();

    // Parse properties for each version
    const versions = results.map(entity => ({
      id: entity.id as string,
      type_id: entity.type_id as string,
      properties: entity.properties ? JSON.parse(entity.properties as string) : {},
      version: entity.version as number,
      previous_version_id: (entity.previous_version_id as string) || null,
      created_at: entity.created_at as number,
      created_by: entity.created_by as string,
      is_deleted: entity.is_deleted === 1,
      is_latest: entity.is_latest === 1,
    }));

    return c.json(
      {
        success: true as const,
        data: versions,
        timestamp: new Date().toISOString(),
      },
      200
    );
  } catch (error) {
    getLogger(c)
      .child({ module: 'entities' })
      .error('Error fetching entity versions', error instanceof Error ? error : undefined);
    throw error;
  }
});

// Path parameters schema for entity ID and version number
const EntityVersionParamsSchema = z.object({
  id: z
    .string()
    .uuid()
    .openapi({
      param: { name: 'id', in: 'path' },
      example: '550e8400-e29b-41d4-a716-446655440000',
      description: 'Entity ID (UUID)',
    }),
  version: z.string().openapi({
    param: { name: 'version', in: 'path' },
    example: '1',
    description: 'Version number (positive integer)',
  }),
});

/**
 * GET /api/entities/:id/versions/:version route definition
 */
const getEntityVersionRoute = createRoute({
  method: 'get',
  path: '/{id}/versions/{version}',
  tags: ['Entities'],
  summary: 'Get specific version of an entity',
  description:
    'Get a specific version of an entity by version number. Permission checking: Authenticated users must have read permission on the entity. Entities with NULL acl_id are accessible to all authenticated users. Unauthenticated requests can only access entities with NULL acl_id (public).',
  operationId: 'getEntityVersion',
  request: {
    params: EntityVersionParamsSchema,
  },
  responses: {
    200: {
      description: 'Entity version found',
      content: {
        'application/json': {
          schema: EntityResponseSchema,
        },
      },
    },
    400: {
      description: 'Invalid version number',
      content: {
        'application/json': {
          schema: EntityErrorResponseSchema,
        },
      },
    },
    403: {
      description: 'Forbidden - no permission to view this entity',
      content: {
        'application/json': {
          schema: EntityErrorResponseSchema,
        },
      },
    },
    404: {
      description: 'Entity or version not found',
      content: {
        'application/json': {
          schema: EntityErrorResponseSchema,
        },
      },
    },
  },
});

// Apply optionalAuth middleware for the get entity version route
entities.use('/:id/versions/:version', async (c, next) => {
  // Only apply to GET requests
  if (c.req.method === 'GET') {
    return optionalAuth()(c, next);
  }
  return next();
});

/**
 * GET /api/entities/:id/versions/:version
 * Get a specific version of an entity
 *
 * Permission checking:
 * - Authenticated users must have read permission on the entity
 * - Entities with NULL acl_id are accessible to all authenticated users
 * - Unauthenticated requests can only access entities with NULL acl_id (public)
 */
entities.openapi(getEntityVersionRoute, async c => {
  const { id, version: versionParam } = c.req.valid('param');
  const db = c.env.DB;
  const kv = c.env.KV;
  const user = c.get('user');

  try {
    // Parse version number
    const versionNumber = parseInt(versionParam, 10);
    if (isNaN(versionNumber) || versionNumber < 1) {
      return c.json(
        {
          success: false as const,
          error: 'Invalid version number',
          code: 'INVALID_VERSION',
          timestamp: new Date().toISOString(),
        },
        400
      );
    }

    // First, find the latest version to ensure the entity exists
    const latestVersion = await findLatestVersion(db, id);

    if (!latestVersion) {
      return c.json(
        {
          success: false as const,
          error: 'Entity not found',
          code: 'NOT_FOUND',
          timestamp: new Date().toISOString(),
        },
        404
      );
    }

    // Check permission
    const aclId = latestVersion.acl_id as number | null;
    if (user) {
      // Authenticated user: check if they have read permission
      const canRead = await hasPermissionByAclId(db, kv, user.user_id, aclId, 'read');
      if (!canRead) {
        return c.json(
          {
            success: false as const,
            error: 'You do not have permission to view this entity',
            code: 'FORBIDDEN',
            timestamp: new Date().toISOString(),
          },
          403
        );
      }
    } else {
      // Unauthenticated: only allow access to public entities (NULL acl_id)
      if (aclId !== null) {
        return c.json(
          {
            success: false as const,
            error: 'Authentication required to view this entity',
            code: 'FORBIDDEN',
            timestamp: new Date().toISOString(),
          },
          403
        );
      }
    }

    // Find the specific version in the chain
    const entity = await db
      .prepare(
        `
      WITH RECURSIVE version_chain AS (
        -- Start with version 1
        SELECT * FROM entities
        WHERE id = (
          SELECT id FROM entities WHERE id = ?
          UNION
          SELECT e1.id FROM entities e1
          WHERE e1.previous_version_id IS NULL
          AND EXISTS (
            WITH RECURSIVE temp_chain AS (
              SELECT id, previous_version_id FROM entities WHERE id = ?
              UNION ALL
              SELECT e2.id, e2.previous_version_id
              FROM entities e2
              INNER JOIN temp_chain tc ON e2.id = tc.previous_version_id
            )
            SELECT 1 FROM temp_chain WHERE temp_chain.id = e1.id
          )
        )
        UNION ALL
        -- Follow the chain forward
        SELECT e.* FROM entities e
        INNER JOIN version_chain vc ON e.previous_version_id = vc.id
      )
      SELECT * FROM version_chain WHERE version = ? LIMIT 1
    `
      )
      .bind(id, id, versionNumber)
      .first();

    if (!entity) {
      return c.json(
        {
          success: false as const,
          error: 'Version not found',
          code: 'NOT_FOUND',
          timestamp: new Date().toISOString(),
        },
        404
      );
    }

    const result = {
      id: entity.id as string,
      type_id: entity.type_id as string,
      properties: entity.properties ? JSON.parse(entity.properties as string) : {},
      version: entity.version as number,
      previous_version_id: (entity.previous_version_id as string) || null,
      created_at: entity.created_at as number,
      created_by: entity.created_by as string,
      is_deleted: entity.is_deleted === 1,
      is_latest: entity.is_latest === 1,
    };

    return c.json(
      {
        success: true as const,
        data: result,
        timestamp: new Date().toISOString(),
      },
      200
    );
  } catch (error) {
    getLogger(c)
      .child({ module: 'entities' })
      .error('Error fetching entity version', error instanceof Error ? error : undefined);
    throw error;
  }
});

// Response schema for entity history with diffs
const EntityHistoryDiffSchema = z
  .object({
    added: z.record(z.string(), z.unknown()).openapi({ description: 'Added properties' }),
    removed: z.record(z.string(), z.unknown()).openapi({ description: 'Removed properties' }),
    changed: z
      .record(z.string(), z.unknown())
      .openapi({ description: 'Changed properties with old/new values' }),
  })
  .openapi('EntityHistoryDiff');

const EntityHistoryVersionSchema = z
  .object({
    id: z.string().uuid().openapi({ example: '550e8400-e29b-41d4-a716-446655440000' }),
    version: z.number().int().positive().openapi({ example: 1 }),
    type_id: z.string().openapi({ example: 'Person' }),
    properties: z
      .record(z.string(), z.unknown())
      .openapi({ example: { name: 'John Doe', age: 30 } }),
    created_at: z.number().int().openapi({ example: 1704067200 }),
    created_by: z.string().uuid().openapi({ example: '550e8400-e29b-41d4-a716-446655440001' }),
    is_deleted: z.boolean().openapi({ example: false }),
    is_latest: z.boolean().openapi({ example: true }),
    diff: EntityHistoryDiffSchema.nullable().openapi({
      description: 'Diff from previous version. Null for first version.',
    }),
  })
  .openapi('EntityHistoryVersion');

const EntityHistoryListResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.array(EntityHistoryVersionSchema),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('EntityHistoryListResponse');

/**
 * GET /api/entities/:id/history route definition
 */
const getEntityHistoryRoute = createRoute({
  method: 'get',
  path: '/{id}/history',
  tags: ['Entities'],
  summary: 'Get version history with diffs',
  description:
    'Get version history with diffs showing what changed between versions. Permission checking: Authenticated users must have read permission on the entity. Entities with NULL acl_id are accessible to all authenticated users. Unauthenticated requests can only access entities with NULL acl_id (public).',
  operationId: 'getEntityHistory',
  request: {
    params: EntityIdParamsSchema,
  },
  responses: {
    200: {
      description: 'List of all versions with diffs',
      content: {
        'application/json': {
          schema: EntityHistoryListResponseSchema,
        },
      },
    },
    403: {
      description: 'Forbidden - no permission to view this entity',
      content: {
        'application/json': {
          schema: EntityErrorResponseSchema,
        },
      },
    },
    404: {
      description: 'Entity not found',
      content: {
        'application/json': {
          schema: EntityErrorResponseSchema,
        },
      },
    },
  },
});

// Apply optionalAuth middleware for the get entity history route
entities.use('/:id/history', async (c, next) => {
  // Only apply to GET requests
  if (c.req.method === 'GET') {
    return optionalAuth()(c, next);
  }
  return next();
});

/**
 * GET /api/entities/:id/history
 * Get version history with diffs showing what changed between versions
 *
 * Permission checking:
 * - Authenticated users must have read permission on the entity
 * - Entities with NULL acl_id are accessible to all authenticated users
 * - Unauthenticated requests can only access entities with NULL acl_id (public)
 */
entities.openapi(getEntityHistoryRoute, async c => {
  const { id } = c.req.valid('param');
  const db = c.env.DB;
  const kv = c.env.KV;
  const user = c.get('user');

  try {
    // First, find the latest version to ensure the entity exists
    const latestVersion = await findLatestVersion(db, id);

    if (!latestVersion) {
      return c.json(
        {
          success: false as const,
          error: 'Entity not found',
          code: 'NOT_FOUND',
          timestamp: new Date().toISOString(),
        },
        404
      );
    }

    // Check permission
    const aclId = latestVersion.acl_id as number | null;
    if (user) {
      // Authenticated user: check if they have read permission
      const canRead = await hasPermissionByAclId(db, kv, user.user_id, aclId, 'read');
      if (!canRead) {
        return c.json(
          {
            success: false as const,
            error: 'You do not have permission to view this entity',
            code: 'FORBIDDEN',
            timestamp: new Date().toISOString(),
          },
          403
        );
      }
    } else {
      // Unauthenticated: only allow access to public entities (NULL acl_id)
      if (aclId !== null) {
        return c.json(
          {
            success: false as const,
            error: 'Authentication required to view this entity',
            code: 'FORBIDDEN',
            timestamp: new Date().toISOString(),
          },
          403
        );
      }
    }

    // Get all versions in order
    const { results } = await db
      .prepare(
        `
      WITH RECURSIVE version_chain AS (
        -- Start with version 1
        SELECT * FROM entities
        WHERE id = (
          SELECT id FROM entities WHERE id = ?
          UNION
          SELECT e1.id FROM entities e1
          WHERE e1.previous_version_id IS NULL
          AND EXISTS (
            WITH RECURSIVE temp_chain AS (
              SELECT id, previous_version_id FROM entities WHERE id = ?
              UNION ALL
              SELECT e2.id, e2.previous_version_id
              FROM entities e2
              INNER JOIN temp_chain tc ON e2.id = tc.previous_version_id
            )
            SELECT 1 FROM temp_chain WHERE temp_chain.id = e1.id
          )
        )
        UNION ALL
        -- Follow the chain forward
        SELECT e.* FROM entities e
        INNER JOIN version_chain vc ON e.previous_version_id = vc.id
      )
      SELECT * FROM version_chain ORDER BY version ASC
    `
      )
      .bind(id, id)
      .all();

    // Calculate diffs between consecutive versions
    const history = results.map((entity, index) => {
      const parsedProps = entity.properties ? JSON.parse(entity.properties as string) : {};

      let diff = null;
      if (index > 0) {
        const prevEntity = results[index - 1];
        const prevProps = prevEntity.properties ? JSON.parse(prevEntity.properties as string) : {};

        diff = calculateDiff(prevProps, parsedProps);
      }

      return {
        id: entity.id as string,
        version: entity.version as number,
        type_id: entity.type_id as string,
        properties: parsedProps,
        created_at: entity.created_at as number,
        created_by: entity.created_by as string,
        is_deleted: entity.is_deleted === 1,
        is_latest: entity.is_latest === 1,
        diff: diff,
      };
    });

    return c.json(
      {
        success: true as const,
        data: history,
        timestamp: new Date().toISOString(),
      },
      200
    );
  } catch (error) {
    getLogger(c)
      .child({ module: 'entities' })
      .error('Error fetching entity history', error instanceof Error ? error : undefined);
    throw error;
  }
});

/**
 * Helper function to calculate differences between two JSON objects
 */
function calculateDiff(
  oldObj: Record<string, unknown>,
  newObj: Record<string, unknown>
): {
  added: Record<string, unknown>;
  removed: Record<string, unknown>;
  changed: Record<string, unknown>;
} {
  const diff = {
    added: {} as Record<string, unknown>,
    removed: {} as Record<string, unknown>,
    changed: {} as Record<string, unknown>,
  };

  // Check for added and changed properties
  for (const key in newObj) {
    if (!(key in oldObj)) {
      diff.added[key] = newObj[key];
    } else if (JSON.stringify(oldObj[key]) !== JSON.stringify(newObj[key])) {
      diff.changed[key] = {
        old: oldObj[key],
        new: newObj[key],
      };
    }
  }

  // Check for removed properties
  for (const key in oldObj) {
    if (!(key in newObj)) {
      diff.removed[key] = oldObj[key];
    }
  }

  return diff;
}

// Schema for embedded target entity in outbound link response
const OutboundLinkTargetEntitySchema = z
  .object({
    id: z.string().uuid().openapi({ example: '550e8400-e29b-41d4-a716-446655440002' }),
    type_id: z.string().openapi({ example: 'Person' }),
    properties: z.record(z.string(), z.unknown()).openapi({ example: { name: 'Jane Doe' } }),
  })
  .openapi('OutboundLinkTargetEntity');

// Schema for outbound link with embedded target entity
const OutboundLinkSchema = z
  .object({
    id: z.string().uuid().openapi({ example: '550e8400-e29b-41d4-a716-446655440003' }),
    type_id: z.string().openapi({ example: 'knows' }),
    source_entity_id: z
      .string()
      .uuid()
      .openapi({ example: '550e8400-e29b-41d4-a716-446655440000' }),
    target_entity_id: z
      .string()
      .uuid()
      .openapi({ example: '550e8400-e29b-41d4-a716-446655440002' }),
    properties: z.record(z.string(), z.unknown()).openapi({ example: { since: '2020-01-01' } }),
    version: z.number().int().positive().openapi({ example: 1 }),
    previous_version_id: z.string().uuid().nullable().openapi({ example: null }),
    created_at: z.number().int().positive().openapi({ example: 1704067200 }),
    created_by: z.string().uuid().openapi({ example: '550e8400-e29b-41d4-a716-446655440001' }),
    is_deleted: z.boolean().openapi({ example: false }),
    is_latest: z.boolean().openapi({ example: true }),
    target_entity: OutboundLinkTargetEntitySchema,
  })
  .openapi('OutboundLink');

// Response schema for outbound links list
const OutboundLinksResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.array(OutboundLinkSchema),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('OutboundLinksResponse');

// Query schema for outbound links
const OutboundLinksQuerySchema = z.object({
  type_id: z
    .string()
    .optional()
    .openapi({
      param: { name: 'type_id', in: 'query' },
      example: 'knows',
      description: 'Filter by link type ID',
    }),
  include_deleted: z
    .string()
    .optional()
    .openapi({
      param: { name: 'include_deleted', in: 'query' },
      example: 'false',
      description: 'Include soft-deleted links and entities',
    }),
});

/**
 * GET /api/entities/:id/outbound route definition
 */
const getEntityOutboundRoute = createRoute({
  method: 'get',
  path: '/{id}/outbound',
  tags: ['Entities'],
  summary: 'Get outbound links',
  description:
    'Get all links where this entity is the source. Permission checking: Authenticated users must have read permission on the source entity. Entities with NULL acl_id are accessible to all authenticated users. Unauthenticated requests can only access entities with NULL acl_id (public). Returned links and target entities are filtered by ACL permissions.',
  operationId: 'getEntityOutboundLinks',
  request: {
    params: EntityIdParamsSchema,
    query: OutboundLinksQuerySchema,
  },
  responses: {
    200: {
      description: 'Outbound links',
      content: {
        'application/json': {
          schema: OutboundLinksResponseSchema,
        },
      },
    },
    403: {
      description: 'Forbidden - no permission to view this entity',
      content: {
        'application/json': {
          schema: EntityErrorResponseSchema,
        },
      },
    },
    404: {
      description: 'Entity not found',
      content: {
        'application/json': {
          schema: EntityErrorResponseSchema,
        },
      },
    },
  },
});

// Apply optionalAuth middleware for the get entity outbound route
entities.use('/:id/outbound', async (c, next) => {
  // Only apply to GET requests
  if (c.req.method === 'GET') {
    return optionalAuth()(c, next);
  }
  return next();
});

/**
 * GET /api/entities/:id/outbound
 * Get all outbound links from an entity
 *
 * Permission checking:
 * - Authenticated users must have read permission on the source entity
 * - Entities with NULL acl_id are accessible to all authenticated users
 * - Unauthenticated requests can only access entities with NULL acl_id (public)
 * - Returned links and target entities are filtered by ACL permissions
 */
entities.openapi(getEntityOutboundRoute, async c => {
  const { id } = c.req.valid('param');
  const { type_id: typeId, include_deleted } = c.req.valid('query');
  const includeDeleted = include_deleted === 'true';
  const db = c.env.DB;
  const kv = c.env.KV;
  const user = c.get('user');

  try {
    // First, verify the entity exists
    const entity = await findLatestVersion(db, id);

    if (!entity) {
      return c.json(
        {
          success: false as const,
          error: 'Entity not found',
          code: 'NOT_FOUND',
          timestamp: new Date().toISOString(),
        },
        404
      );
    }

    // Check permission on the source entity
    const entityAclId = entity.acl_id as number | null;
    if (user) {
      // Authenticated user: check if they have read permission on the source entity
      const canRead = await hasPermissionByAclId(db, kv, user.user_id, entityAclId, 'read');
      if (!canRead) {
        return c.json(
          {
            success: false as const,
            error: 'You do not have permission to view this entity',
            code: 'FORBIDDEN',
            timestamp: new Date().toISOString(),
          },
          403
        );
      }
    } else {
      // Unauthenticated: only allow access to public entities (NULL acl_id)
      if (entityAclId !== null) {
        return c.json(
          {
            success: false as const,
            error: 'Authentication required to view this entity',
            code: 'FORBIDDEN',
            timestamp: new Date().toISOString(),
          },
          403
        );
      }
    }

    // Build ACL filter for links and target entities
    let linkAclFilter: Awaited<ReturnType<typeof buildAclFilterClause>> | null = null;
    let targetEntityAclFilter: Awaited<ReturnType<typeof buildAclFilterClause>> | null = null;

    if (user) {
      // Build ACL filters for authenticated users
      linkAclFilter = await buildAclFilterClause(db, kv, user.user_id, 'read', 'l.acl_id');
      targetEntityAclFilter = await buildAclFilterClause(db, kv, user.user_id, 'read', 'e.acl_id');
    }

    // Build query to find all outbound links
    let sql = `
      SELECT l.*, e.type_id as target_type_id, e.properties as target_properties, e.acl_id as target_acl_id
      FROM links l
      INNER JOIN entities e ON l.target_entity_id = e.id
      WHERE l.source_entity_id = ?
      AND l.is_latest = 1
      AND e.is_latest = 1
    `;
    const bindings: unknown[] = [entity.id];

    // Apply ACL filtering based on authentication status
    if (user) {
      // Apply link ACL filter
      if (linkAclFilter && linkAclFilter.useFilter) {
        sql += ` AND ${linkAclFilter.whereClause}`;
        bindings.push(...linkAclFilter.bindings);
      }

      // Apply target entity ACL filter
      if (targetEntityAclFilter && targetEntityAclFilter.useFilter) {
        sql += ` AND ${targetEntityAclFilter.whereClause}`;
        bindings.push(...targetEntityAclFilter.bindings);
      }
    } else {
      // Unauthenticated: only show public links and target entities
      sql += ' AND l.acl_id IS NULL AND e.acl_id IS NULL';
    }

    // Filter out deleted links and entities by default
    if (!includeDeleted) {
      sql += ' AND l.is_deleted = 0 AND e.is_deleted = 0';
    }

    // Filter by link type if provided
    if (typeId) {
      sql += ' AND l.type_id = ?';
      bindings.push(typeId);
    }

    sql += ' ORDER BY l.created_at DESC';

    const { results } = await db
      .prepare(sql)
      .bind(...bindings)
      .all();

    // Apply per-row ACL filtering if needed (when user has too many accessible ACLs)
    let filteredResults = results;
    if (user) {
      if (linkAclFilter && !linkAclFilter.useFilter) {
        filteredResults = filterByAclPermission(
          filteredResults as Array<{ acl_id?: number | null }>,
          linkAclFilter.accessibleAclIds
        );
      }
      if (targetEntityAclFilter && !targetEntityAclFilter.useFilter) {
        filteredResults = filteredResults.filter(item => {
          const targetAclId = (item as Record<string, unknown>).target_acl_id as
            | number
            | null
            | undefined;
          if (targetAclId === null || targetAclId === undefined) {
            return true;
          }
          return targetEntityAclFilter!.accessibleAclIds.has(targetAclId);
        });
      }
    }

    // Parse properties for each link and target entity
    const linksData = filteredResults.map(link => ({
      id: link.id as string,
      type_id: link.type_id as string,
      source_entity_id: link.source_entity_id as string,
      target_entity_id: link.target_entity_id as string,
      properties: (link.properties ? JSON.parse(link.properties as string) : {}) as Record<
        string,
        unknown
      >,
      version: link.version as number,
      previous_version_id: link.previous_version_id as string | null,
      created_at: link.created_at as number,
      created_by: link.created_by as string,
      is_deleted: link.is_deleted === 1,
      is_latest: link.is_latest === 1,
      target_entity: {
        id: link.target_entity_id as string,
        type_id: (link as Record<string, unknown>).target_type_id as string,
        properties: ((link as Record<string, unknown>).target_properties
          ? JSON.parse((link as Record<string, unknown>).target_properties as string)
          : {}) as Record<string, unknown>,
      },
    }));

    return c.json(
      {
        success: true as const,
        data: linksData,
        timestamp: new Date().toISOString(),
      },
      200
    );
  } catch (error) {
    getLogger(c)
      .child({ module: 'entities' })
      .error('Error fetching outbound links', error instanceof Error ? error : undefined);
    throw error;
  }
});

// Schema for embedded source entity in inbound link response
const InboundLinkSourceEntitySchema = z
  .object({
    id: z.string().uuid().openapi({ example: '550e8400-e29b-41d4-a716-446655440002' }),
    type_id: z.string().openapi({ example: 'Person' }),
    properties: z.record(z.string(), z.unknown()).openapi({ example: { name: 'Jane Doe' } }),
  })
  .openapi('InboundLinkSourceEntity');

// Schema for inbound link with embedded source entity
const InboundLinkSchema = z
  .object({
    id: z.string().uuid().openapi({ example: '550e8400-e29b-41d4-a716-446655440003' }),
    type_id: z.string().openapi({ example: 'knows' }),
    source_entity_id: z
      .string()
      .uuid()
      .openapi({ example: '550e8400-e29b-41d4-a716-446655440002' }),
    target_entity_id: z
      .string()
      .uuid()
      .openapi({ example: '550e8400-e29b-41d4-a716-446655440000' }),
    properties: z.record(z.string(), z.unknown()).openapi({ example: { since: '2020-01-01' } }),
    version: z.number().int().positive().openapi({ example: 1 }),
    previous_version_id: z.string().uuid().nullable().openapi({ example: null }),
    created_at: z.number().int().positive().openapi({ example: 1704067200 }),
    created_by: z.string().uuid().openapi({ example: '550e8400-e29b-41d4-a716-446655440001' }),
    is_deleted: z.boolean().openapi({ example: false }),
    is_latest: z.boolean().openapi({ example: true }),
    source_entity: InboundLinkSourceEntitySchema,
  })
  .openapi('InboundLink');

// Response schema for inbound links list
const InboundLinksResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.array(InboundLinkSchema),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('InboundLinksResponse');

// Query schema for inbound links (reuse outbound schema since it's identical)
const InboundLinksQuerySchema = z.object({
  type_id: z
    .string()
    .optional()
    .openapi({
      param: { name: 'type_id', in: 'query' },
      example: 'knows',
      description: 'Filter by link type ID',
    }),
  include_deleted: z
    .string()
    .optional()
    .openapi({
      param: { name: 'include_deleted', in: 'query' },
      example: 'false',
      description: 'Include soft-deleted links and entities',
    }),
});

/**
 * GET /api/entities/:id/inbound route definition
 */
const getEntityInboundRoute = createRoute({
  method: 'get',
  path: '/{id}/inbound',
  tags: ['Entities'],
  summary: 'Get inbound links',
  description:
    'Get all links where this entity is the target. Permission checking: Authenticated users must have read permission on the target entity. Entities with NULL acl_id are accessible to all authenticated users. Unauthenticated requests can only access entities with NULL acl_id (public). Returned links and source entities are filtered by ACL permissions.',
  operationId: 'getEntityInboundLinks',
  request: {
    params: EntityIdParamsSchema,
    query: InboundLinksQuerySchema,
  },
  responses: {
    200: {
      description: 'Inbound links',
      content: {
        'application/json': {
          schema: InboundLinksResponseSchema,
        },
      },
    },
    403: {
      description: 'Forbidden - no permission to view this entity',
      content: {
        'application/json': {
          schema: EntityErrorResponseSchema,
        },
      },
    },
    404: {
      description: 'Entity not found',
      content: {
        'application/json': {
          schema: EntityErrorResponseSchema,
        },
      },
    },
  },
});

// Apply optionalAuth middleware for the get entity inbound route
entities.use('/:id/inbound', async (c, next) => {
  // Only apply to GET requests
  if (c.req.method === 'GET') {
    return optionalAuth()(c, next);
  }
  return next();
});

/**
 * GET /api/entities/:id/inbound
 * Get all inbound links to an entity
 *
 * Permission checking:
 * - Authenticated users must have read permission on the target entity
 * - Entities with NULL acl_id are accessible to all authenticated users
 * - Unauthenticated requests can only access entities with NULL acl_id (public)
 * - Returned links and source entities are filtered by ACL permissions
 */
entities.openapi(getEntityInboundRoute, async c => {
  const { id } = c.req.valid('param');
  const { type_id: typeId, include_deleted } = c.req.valid('query');
  const includeDeleted = include_deleted === 'true';
  const db = c.env.DB;
  const kv = c.env.KV;
  const user = c.get('user');

  try {
    // First, verify the entity exists
    const entity = await findLatestVersion(db, id);

    if (!entity) {
      return c.json(
        {
          success: false as const,
          error: 'Entity not found',
          code: 'NOT_FOUND',
          timestamp: new Date().toISOString(),
        },
        404
      );
    }

    // Check permission on the target entity
    const entityAclId = entity.acl_id as number | null;
    if (user) {
      // Authenticated user: check if they have read permission on the target entity
      const canRead = await hasPermissionByAclId(db, kv, user.user_id, entityAclId, 'read');
      if (!canRead) {
        return c.json(
          {
            success: false as const,
            error: 'You do not have permission to view this entity',
            code: 'FORBIDDEN',
            timestamp: new Date().toISOString(),
          },
          403
        );
      }
    } else {
      // Unauthenticated: only allow access to public entities (NULL acl_id)
      if (entityAclId !== null) {
        return c.json(
          {
            success: false as const,
            error: 'Authentication required to view this entity',
            code: 'FORBIDDEN',
            timestamp: new Date().toISOString(),
          },
          403
        );
      }
    }

    // Build ACL filter for links and source entities
    let linkAclFilter: Awaited<ReturnType<typeof buildAclFilterClause>> | null = null;
    let sourceEntityAclFilter: Awaited<ReturnType<typeof buildAclFilterClause>> | null = null;

    if (user) {
      // Build ACL filters for authenticated users
      linkAclFilter = await buildAclFilterClause(db, kv, user.user_id, 'read', 'l.acl_id');
      sourceEntityAclFilter = await buildAclFilterClause(db, kv, user.user_id, 'read', 'e.acl_id');
    }

    // Build query to find all inbound links
    let sql = `
      SELECT l.*, e.type_id as source_type_id, e.properties as source_properties, e.acl_id as source_acl_id
      FROM links l
      INNER JOIN entities e ON l.source_entity_id = e.id
      WHERE l.target_entity_id = ?
      AND l.is_latest = 1
      AND e.is_latest = 1
    `;
    const bindings: unknown[] = [entity.id];

    // Apply ACL filtering based on authentication status
    if (user) {
      // Apply link ACL filter
      if (linkAclFilter && linkAclFilter.useFilter) {
        sql += ` AND ${linkAclFilter.whereClause}`;
        bindings.push(...linkAclFilter.bindings);
      }

      // Apply source entity ACL filter
      if (sourceEntityAclFilter && sourceEntityAclFilter.useFilter) {
        sql += ` AND ${sourceEntityAclFilter.whereClause}`;
        bindings.push(...sourceEntityAclFilter.bindings);
      }
    } else {
      // Unauthenticated: only show public links and source entities
      sql += ' AND l.acl_id IS NULL AND e.acl_id IS NULL';
    }

    // Filter out deleted links and entities by default
    if (!includeDeleted) {
      sql += ' AND l.is_deleted = 0 AND e.is_deleted = 0';
    }

    // Filter by link type if provided
    if (typeId) {
      sql += ' AND l.type_id = ?';
      bindings.push(typeId);
    }

    sql += ' ORDER BY l.created_at DESC';

    const { results } = await db
      .prepare(sql)
      .bind(...bindings)
      .all();

    // Apply per-row ACL filtering if needed (when user has too many accessible ACLs)
    let filteredResults = results;
    if (user) {
      if (linkAclFilter && !linkAclFilter.useFilter) {
        filteredResults = filterByAclPermission(
          filteredResults as Array<{ acl_id?: number | null }>,
          linkAclFilter.accessibleAclIds
        );
      }
      if (sourceEntityAclFilter && !sourceEntityAclFilter.useFilter) {
        filteredResults = filteredResults.filter(item => {
          const sourceAclId = (item as Record<string, unknown>).source_acl_id as
            | number
            | null
            | undefined;
          if (sourceAclId === null || sourceAclId === undefined) {
            return true;
          }
          return sourceEntityAclFilter!.accessibleAclIds.has(sourceAclId);
        });
      }
    }

    // Parse properties for each link and source entity
    const linksData = filteredResults.map(link => ({
      id: link.id as string,
      type_id: link.type_id as string,
      source_entity_id: link.source_entity_id as string,
      target_entity_id: link.target_entity_id as string,
      properties: (link.properties ? JSON.parse(link.properties as string) : {}) as Record<
        string,
        unknown
      >,
      version: link.version as number,
      previous_version_id: link.previous_version_id as string | null,
      created_at: link.created_at as number,
      created_by: link.created_by as string,
      is_deleted: link.is_deleted === 1,
      is_latest: link.is_latest === 1,
      source_entity: {
        id: link.source_entity_id as string,
        type_id: (link as Record<string, unknown>).source_type_id as string,
        properties: ((link as Record<string, unknown>).source_properties
          ? JSON.parse((link as Record<string, unknown>).source_properties as string)
          : {}) as Record<string, unknown>,
      },
    }));

    return c.json(
      {
        success: true as const,
        data: linksData,
        timestamp: new Date().toISOString(),
      },
      200
    );
  } catch (error) {
    getLogger(c)
      .child({ module: 'entities' })
      .error('Error fetching inbound links', error instanceof Error ? error : undefined);
    throw error;
  }
});

// Schema for a connection to a neighbor entity
const NeighborConnectionSchema = z
  .object({
    link_id: z.string().uuid().openapi({ example: '550e8400-e29b-41d4-a716-446655440003' }),
    link_type_id: z.string().openapi({ example: 'knows' }),
    link_properties: z
      .record(z.string(), z.unknown())
      .openapi({ example: { since: '2020-01-01' } }),
    direction: z.enum(['inbound', 'outbound']).openapi({ example: 'outbound' }),
  })
  .openapi('NeighborConnection');

// Schema for a neighbor entity with its connections
const NeighborEntitySchema = z
  .object({
    id: z.string().uuid().openapi({ example: '550e8400-e29b-41d4-a716-446655440002' }),
    type_id: z.string().openapi({ example: 'Person' }),
    properties: z.record(z.string(), z.unknown()).openapi({ example: { name: 'Jane Doe' } }),
    version: z.number().int().positive().openapi({ example: 1 }),
    created_at: z.number().int().positive().openapi({ example: 1704067200 }),
    created_by: z.string().uuid().openapi({ example: '550e8400-e29b-41d4-a716-446655440001' }),
    is_deleted: z.boolean().openapi({ example: false }),
    is_latest: z.boolean().openapi({ example: true }),
    connections: z.array(NeighborConnectionSchema),
  })
  .openapi('NeighborEntity');

// Response schema for neighbors list
const NeighborsResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.array(NeighborEntitySchema),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('NeighborsResponse');

// Query schema for neighbors
const NeighborsQuerySchema = z.object({
  type_id: z
    .string()
    .optional()
    .openapi({
      param: { name: 'type_id', in: 'query' },
      example: 'knows',
      description: 'Filter by link type ID',
    }),
  entity_type_id: z
    .string()
    .optional()
    .openapi({
      param: { name: 'entity_type_id', in: 'query' },
      example: 'Person',
      description: 'Filter by neighbor entity type ID',
    }),
  include_deleted: z
    .string()
    .optional()
    .openapi({
      param: { name: 'include_deleted', in: 'query' },
      example: 'false',
      description: 'Include soft-deleted links and entities',
    }),
  direction: z
    .enum(['inbound', 'outbound'])
    .optional()
    .openapi({
      param: { name: 'direction', in: 'query' },
      example: 'outbound',
      description: 'Filter by direction (inbound, outbound, or both if not specified)',
    }),
});

/**
 * GET /api/entities/:id/neighbors route definition
 */
const getEntityNeighborsRoute = createRoute({
  method: 'get',
  path: '/{id}/neighbors',
  tags: ['Entities'],
  summary: 'Get all connected entities',
  description:
    'Get all connected entities (both inbound and outbound). Permission checking: Authenticated users must have read permission on the center entity. Entities with NULL acl_id are accessible to all authenticated users. Unauthenticated requests can only access entities with NULL acl_id (public). Returned links and neighbor entities are filtered by ACL permissions.',
  operationId: 'getEntityNeighbors',
  request: {
    params: EntityIdParamsSchema,
    query: NeighborsQuerySchema,
  },
  responses: {
    200: {
      description: 'Connected entities',
      content: {
        'application/json': {
          schema: NeighborsResponseSchema,
        },
      },
    },
    403: {
      description: 'Forbidden - no permission to view this entity',
      content: {
        'application/json': {
          schema: EntityErrorResponseSchema,
        },
      },
    },
    404: {
      description: 'Entity not found',
      content: {
        'application/json': {
          schema: EntityErrorResponseSchema,
        },
      },
    },
  },
});

// Apply optionalAuth middleware for the get entity neighbors route
entities.use('/:id/neighbors', async (c, next) => {
  // Only apply to GET requests
  if (c.req.method === 'GET') {
    return optionalAuth()(c, next);
  }
  return next();
});

/**
 * GET /api/entities/:id/neighbors
 * Get all connected entities (both inbound and outbound)
 *
 * Permission checking:
 * - Authenticated users must have read permission on the center entity
 * - Entities with NULL acl_id are accessible to all authenticated users
 * - Unauthenticated requests can only access entities with NULL acl_id (public)
 * - Returned links and neighbor entities are filtered by ACL permissions
 */
entities.openapi(getEntityNeighborsRoute, async c => {
  const { id } = c.req.valid('param');
  const {
    type_id: typeId,
    entity_type_id: entityTypeId,
    include_deleted,
    direction,
  } = c.req.valid('query');
  const includeDeleted = include_deleted === 'true';
  const db = c.env.DB;
  const kv = c.env.KV;
  const user = c.get('user');

  try {
    // First, verify the entity exists
    const entity = await findLatestVersion(db, id);

    if (!entity) {
      return c.json(
        {
          success: false as const,
          error: 'Entity not found',
          code: 'NOT_FOUND',
          timestamp: new Date().toISOString(),
        },
        404
      );
    }

    // Check permission on the center entity
    const entityAclId = entity.acl_id as number | null;
    if (user) {
      // Authenticated user: check if they have read permission on the center entity
      const canRead = await hasPermissionByAclId(db, kv, user.user_id, entityAclId, 'read');
      if (!canRead) {
        return c.json(
          {
            success: false as const,
            error: 'You do not have permission to view this entity',
            code: 'FORBIDDEN',
            timestamp: new Date().toISOString(),
          },
          403
        );
      }
    } else {
      // Unauthenticated: only allow access to public entities (NULL acl_id)
      if (entityAclId !== null) {
        return c.json(
          {
            success: false as const,
            error: 'Authentication required to view this entity',
            code: 'FORBIDDEN',
            timestamp: new Date().toISOString(),
          },
          403
        );
      }
    }

    // Build ACL filters for links and neighbor entities
    let linkAclFilter: Awaited<ReturnType<typeof buildAclFilterClause>> | null = null;
    let neighborEntityAclFilter: Awaited<ReturnType<typeof buildAclFilterClause>> | null = null;

    if (user) {
      // Build ACL filters for authenticated users
      linkAclFilter = await buildAclFilterClause(db, kv, user.user_id, 'read', 'l.acl_id');
      neighborEntityAclFilter = await buildAclFilterClause(
        db,
        kv,
        user.user_id,
        'read',
        'e.acl_id'
      );
    }

    const neighbors: Record<string, unknown>[] = [];

    // Fetch outbound neighbors (entities this entity links to)
    if (!direction || direction === 'outbound') {
      let outboundSql = `
        SELECT DISTINCT
          e.id,
          e.type_id,
          e.properties,
          e.version,
          e.created_at,
          e.created_by,
          e.is_deleted,
          e.is_latest,
          e.acl_id as entity_acl_id,
          l.id as link_id,
          l.type_id as link_type_id,
          l.properties as link_properties,
          l.acl_id as link_acl_id,
          'outbound' as direction
        FROM links l
        INNER JOIN entities e ON l.target_entity_id = e.id
        WHERE l.source_entity_id = ?
        AND l.is_latest = 1
        AND e.is_latest = 1
      `;
      const outboundBindings: unknown[] = [entity.id];

      // Apply ACL filtering based on authentication status
      if (user) {
        // Apply link ACL filter
        if (linkAclFilter && linkAclFilter.useFilter) {
          outboundSql += ` AND ${linkAclFilter.whereClause}`;
          outboundBindings.push(...linkAclFilter.bindings);
        }

        // Apply neighbor entity ACL filter
        if (neighborEntityAclFilter && neighborEntityAclFilter.useFilter) {
          outboundSql += ` AND ${neighborEntityAclFilter.whereClause}`;
          outboundBindings.push(...neighborEntityAclFilter.bindings);
        }
      } else {
        // Unauthenticated: only show public links and entities
        outboundSql += ' AND l.acl_id IS NULL AND e.acl_id IS NULL';
      }

      if (!includeDeleted) {
        outboundSql += ' AND l.is_deleted = 0 AND e.is_deleted = 0';
      }

      if (typeId) {
        outboundSql += ' AND l.type_id = ?';
        outboundBindings.push(typeId);
      }

      if (entityTypeId) {
        outboundSql += ' AND e.type_id = ?';
        outboundBindings.push(entityTypeId);
      }

      const { results: outboundResults } = await db
        .prepare(outboundSql)
        .bind(...outboundBindings)
        .all();

      // Apply per-row ACL filtering if needed (when user has too many accessible ACLs)
      let filteredOutbound = outboundResults;
      if (user) {
        if (linkAclFilter && !linkAclFilter.useFilter) {
          filteredOutbound = filteredOutbound.filter(item => {
            const aclId = (item as Record<string, unknown>).link_acl_id as
              | number
              | null
              | undefined;
            if (aclId === null || aclId === undefined) {
              return true;
            }
            return linkAclFilter!.accessibleAclIds.has(aclId);
          });
        }
        if (neighborEntityAclFilter && !neighborEntityAclFilter.useFilter) {
          filteredOutbound = filteredOutbound.filter(item => {
            const aclId = (item as Record<string, unknown>).entity_acl_id as
              | number
              | null
              | undefined;
            if (aclId === null || aclId === undefined) {
              return true;
            }
            return neighborEntityAclFilter!.accessibleAclIds.has(aclId);
          });
        }
      }

      neighbors.push(...filteredOutbound);
    }

    // Fetch inbound neighbors (entities that link to this entity)
    if (!direction || direction === 'inbound') {
      let inboundSql = `
        SELECT DISTINCT
          e.id,
          e.type_id,
          e.properties,
          e.version,
          e.created_at,
          e.created_by,
          e.is_deleted,
          e.is_latest,
          e.acl_id as entity_acl_id,
          l.id as link_id,
          l.type_id as link_type_id,
          l.properties as link_properties,
          l.acl_id as link_acl_id,
          'inbound' as direction
        FROM links l
        INNER JOIN entities e ON l.source_entity_id = e.id
        WHERE l.target_entity_id = ?
        AND l.is_latest = 1
        AND e.is_latest = 1
      `;
      const inboundBindings: unknown[] = [entity.id];

      // Apply ACL filtering based on authentication status
      if (user) {
        // Apply link ACL filter
        if (linkAclFilter && linkAclFilter.useFilter) {
          inboundSql += ` AND ${linkAclFilter.whereClause}`;
          inboundBindings.push(...linkAclFilter.bindings);
        }

        // Apply neighbor entity ACL filter
        if (neighborEntityAclFilter && neighborEntityAclFilter.useFilter) {
          inboundSql += ` AND ${neighborEntityAclFilter.whereClause}`;
          inboundBindings.push(...neighborEntityAclFilter.bindings);
        }
      } else {
        // Unauthenticated: only show public links and entities
        inboundSql += ' AND l.acl_id IS NULL AND e.acl_id IS NULL';
      }

      if (!includeDeleted) {
        inboundSql += ' AND l.is_deleted = 0 AND e.is_deleted = 0';
      }

      if (typeId) {
        inboundSql += ' AND l.type_id = ?';
        inboundBindings.push(typeId);
      }

      if (entityTypeId) {
        inboundSql += ' AND e.type_id = ?';
        inboundBindings.push(entityTypeId);
      }

      const { results: inboundResults } = await db
        .prepare(inboundSql)
        .bind(...inboundBindings)
        .all();

      // Apply per-row ACL filtering if needed (when user has too many accessible ACLs)
      let filteredInbound = inboundResults;
      if (user) {
        if (linkAclFilter && !linkAclFilter.useFilter) {
          filteredInbound = filteredInbound.filter(item => {
            const aclId = (item as Record<string, unknown>).link_acl_id as
              | number
              | null
              | undefined;
            if (aclId === null || aclId === undefined) {
              return true;
            }
            return linkAclFilter!.accessibleAclIds.has(aclId);
          });
        }
        if (neighborEntityAclFilter && !neighborEntityAclFilter.useFilter) {
          filteredInbound = filteredInbound.filter(item => {
            const aclId = (item as Record<string, unknown>).entity_acl_id as
              | number
              | null
              | undefined;
            if (aclId === null || aclId === undefined) {
              return true;
            }
            return neighborEntityAclFilter!.accessibleAclIds.has(aclId);
          });
        }
      }

      neighbors.push(...filteredInbound);
    }

    // Deduplicate neighbors (an entity might be connected both ways)
    const uniqueNeighborsMap = new Map();

    for (const neighbor of neighbors) {
      const neighborId = neighbor.id as string;

      if (!uniqueNeighborsMap.has(neighborId)) {
        uniqueNeighborsMap.set(neighborId, {
          id: neighbor.id,
          type_id: neighbor.type_id,
          properties: neighbor.properties ? JSON.parse(neighbor.properties as string) : {},
          version: neighbor.version,
          created_at: neighbor.created_at,
          created_by: neighbor.created_by,
          is_deleted: neighbor.is_deleted === 1,
          is_latest: neighbor.is_latest === 1,
          connections: [],
        });
      }

      // Add the link information
      uniqueNeighborsMap.get(neighborId).connections.push({
        link_id: neighbor.link_id,
        link_type_id: neighbor.link_type_id,
        link_properties: neighbor.link_properties
          ? JSON.parse(neighbor.link_properties as string)
          : {},
        direction: neighbor.direction,
      });
    }

    const neighborsData = Array.from(uniqueNeighborsMap.values());

    return c.json(
      {
        success: true as const,
        data: neighborsData,
        timestamp: new Date().toISOString(),
      },
      200
    );
  } catch (error) {
    getLogger(c)
      .child({ module: 'entities' })
      .error('Error fetching neighbors', error instanceof Error ? error : undefined);
    throw error;
  }
});

/**
 * GET /api/entities/:id/acl
 * Get the current ACL (access control list) for an entity
 *
 * Returns the list of principals (users and groups) that have read or write
 * permission on this entity. If the entity has no ACL (null acl_id), it means
 * the entity is public and accessible to all authenticated users.
 *
 * Requires authentication and read permission on the entity.
 */
entities.get('/:id/acl', requireAuth(), async c => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const kv = c.env.KV;
  const user = c.get('user');
  const userId = user.user_id;

  try {
    // First, verify the entity exists
    const entity = await findLatestVersion(db, id);

    if (!entity) {
      return c.json(response.notFound('Entity'), 404);
    }

    // Check read permission
    const aclId = entity.acl_id as number | null;
    const canRead = await hasPermissionByAclId(db, kv, userId, aclId, 'read');
    if (!canRead) {
      return c.json(response.forbidden('You do not have permission to view this entity'), 403);
    }

    // If no ACL, return empty entries (public)
    if (aclId === null) {
      return c.json(
        response.success({
          entries: [],
          acl_id: null,
        })
      );
    }

    // Get enriched ACL entries
    const entries = await getEnrichedAclEntries(db, aclId);

    return c.json(
      response.success({
        entries,
        acl_id: aclId,
      })
    );
  } catch (error) {
    getLogger(c)
      .child({ module: 'entities' })
      .error('Error fetching entity ACL', error instanceof Error ? error : undefined);
    throw error;
  }
});

/**
 * PUT /api/entities/:id/acl
 * Set the ACL (access control list) for an entity
 *
 * This endpoint allows setting permissions for users and groups on an entity.
 * - Empty entries array removes the ACL (makes entity public)
 * - Setting entries creates/reuses a deduplicated ACL
 * - Creates a new version of the entity with the updated ACL
 *
 * Requires authentication and write permission on the entity.
 *
 * ACL request format:
 * {
 *   "entries": [
 *     { "principal_type": "user", "principal_id": "uuid", "permission": "write" },
 *     { "principal_type": "group", "principal_id": "uuid", "permission": "read" }
 *   ]
 * }
 */
entities.put('/:id/acl', requireAuth(), validateJson(setAclRequestSchema), async c => {
  const id = c.req.param('id');
  const data = c.get('validated_json') as SetAclRequest;
  const db = c.env.DB;
  const kv = c.env.KV;
  const user = c.get('user');
  const userId = user.user_id;

  try {
    // First, verify the entity exists
    const entity = await findLatestVersion(db, id);

    if (!entity) {
      return c.json(response.notFound('Entity'), 404);
    }

    // Check write permission
    const currentAclId = entity.acl_id as number | null;
    const canWrite = await hasPermissionByAclId(db, kv, userId, currentAclId, 'write');
    if (!canWrite) {
      return c.json(response.forbidden('You do not have permission to modify this entity'), 403);
    }

    // Check if entity is soft-deleted
    if (entity.is_deleted === 1) {
      return c.json(
        response.error(
          'Cannot set ACL on deleted entity. Use restore endpoint first.',
          'ENTITY_DELETED'
        ),
        409
      );
    }

    // Validate that all principals exist
    if (data.entries.length > 0) {
      const validation = await validateAclPrincipals(db, data.entries);
      if (!validation.valid) {
        return c.json(
          response.error('Invalid principals in ACL', 'INVALID_PRINCIPALS', {
            errors: validation.errors,
          }),
          400
        );
      }
    }

    // Get or create the ACL
    const aclId = await getOrCreateAcl(db, data.entries);

    // Set the ACL on the entity (creates new version)
    const newVersionId = await setEntityAcl(db, entity.id as string, aclId, userId);

    // Get the updated ACL for response
    let responseEntries: unknown[] = [];
    if (aclId !== null) {
      responseEntries = await getEnrichedAclEntries(db, aclId);
    }

    // Invalidate cache
    try {
      await invalidateEntityCache(kv, id);
      await invalidateEntityCache(kv, entity.id as string);
      if (newVersionId) {
        await invalidateEntityCache(kv, newVersionId);
      }
    } catch (cacheError) {
      getLogger(c)
        .child({ module: 'entities' })
        .warn('Failed to invalidate cache', { error: cacheError });
    }

    return c.json(
      response.success(
        {
          entries: responseEntries,
          acl_id: aclId,
          new_version_id: newVersionId,
        },
        'ACL updated successfully'
      )
    );
  } catch (error) {
    getLogger(c)
      .child({ module: 'entities' })
      .error('Error setting entity ACL', error instanceof Error ? error : undefined);
    throw error;
  }
});

export default entities;
