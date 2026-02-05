import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { validateJson } from '../middleware/validation.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import {
  createTypeSchema,
  updateTypeSchema,
  typeQuerySchema,
  typeSchema,
  UpdateType,
} from '../schemas/index.js';
import * as response from '../utils/response.js';
import { getLogger } from '../middleware/request-context.js';
import {
  getCache,
  setCache,
  getTypeCacheKey,
  getVersionedTypesListCacheKey,
  invalidateTypeCache,
  CACHE_TTL,
} from '../utils/cache.js';
import {
  applyFieldSelection,
  applyFieldSelectionToArray,
  TYPE_ALLOWED_FIELDS,
} from '../utils/field-selection.js';

type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  ENVIRONMENT: string;
};

const types = new OpenAPIHono<{ Bindings: Bindings }>();

// Helper function to generate UUID
function generateUUID(): string {
  return crypto.randomUUID();
}

// Helper function to get current timestamp
function getCurrentTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}

// Response schema for type operations
const TypeResponseSchema = z
  .object({
    success: z.literal(true),
    data: typeSchema,
    message: z.string().optional().openapi({ example: 'Resource created successfully' }),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('TypeResponse');

// Error response schema for type operations
const TypeErrorResponseSchema = z
  .object({
    success: z.literal(false),
    error: z.string().openapi({ example: 'Type name already exists' }),
    code: z.string().openapi({ example: 'DUPLICATE_NAME' }),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('TypeErrorResponse');

// Paginated list response schema for type operations
const TypeListResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.array(typeSchema).openapi({ description: 'Array of types' }),
    metadata: z
      .object({
        hasMore: z.boolean().openapi({ example: true }),
        cursor: z
          .string()
          .optional()
          .openapi({ example: '1704067200:550e8400-e29b-41d4-a716-446655440000' }),
        total: z.number().int().optional().openapi({ example: 42 }),
      })
      .optional(),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('TypeListResponse');

// Type for cached list response
type TypeListResponse = z.infer<typeof TypeListResponseSchema>;

// Path parameters schema for type ID
const TypeIdParamsSchema = z.object({
  id: z
    .string()
    .min(1)
    .openapi({
      param: { name: 'id', in: 'path' },
      example: '550e8400-e29b-41d4-a716-446655440000',
      description: 'Type ID',
    }),
});

// Query schema for field selection
const FieldSelectionQuerySchema = z.object({
  fields: z
    .string()
    .optional()
    .openapi({
      param: { name: 'fields', in: 'query' },
      example: 'id,name,category',
      description: 'Comma-separated list of fields to include in response',
    }),
});

/**
 * POST /api/types route definition
 */
const createTypeRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Types'],
  summary: 'Create type',
  description: 'Create a new entity or link type (admin only)',
  operationId: 'createType',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth(), requireAdmin()] as const,
  request: {
    body: {
      content: {
        'application/json': {
          schema: createTypeSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    201: {
      description: 'Type created',
      content: {
        'application/json': {
          schema: TypeResponseSchema,
        },
      },
    },
    400: {
      description: 'Validation error',
      content: {
        'application/json': {
          schema: TypeErrorResponseSchema,
        },
      },
    },
    401: {
      description: 'Unauthorized - authentication required',
      content: {
        'application/json': {
          schema: TypeErrorResponseSchema,
        },
      },
    },
    403: {
      description: 'Forbidden - admin role required',
      content: {
        'application/json': {
          schema: TypeErrorResponseSchema,
        },
      },
    },
    409: {
      description: 'Conflict - type name already exists',
      content: {
        'application/json': {
          schema: TypeErrorResponseSchema,
        },
      },
    },
  },
});

/**
 * POST /api/types
 * Create a new type (admin only)
 */
types.openapi(createTypeRoute, async c => {
  const data = c.req.valid('json');
  const db = c.env.DB;
  const user = c.get('user');

  const id = generateUUID();
  const now = getCurrentTimestamp();

  // Use the authenticated user's ID
  const createdBy = user.user_id;

  try {
    // Check if type name already exists
    const existing = await db
      .prepare('SELECT id FROM types WHERE name = ?')
      .bind(data.name)
      .first();

    if (existing) {
      return c.json(
        {
          success: false as const,
          error: 'Type name already exists',
          code: 'DUPLICATE_NAME',
          timestamp: new Date().toISOString(),
        },
        409
      );
    }

    // Convert json_schema to string if provided
    const jsonSchemaString = data.json_schema ? JSON.stringify(data.json_schema) : null;

    // Insert the new type
    await db
      .prepare(
        `
      INSERT INTO types (id, name, category, description, json_schema, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
      )
      .bind(
        id,
        data.name,
        data.category,
        data.description || null,
        jsonSchemaString,
        now,
        createdBy
      )
      .run();

    // Fetch the created type
    const created = await db.prepare('SELECT * FROM types WHERE id = ?').bind(id).first();

    // Parse json_schema back to object if it exists
    const typeData = {
      id: created?.id as string,
      name: created?.name as string,
      category: created?.category as 'entity' | 'link',
      description: (created?.description as string) || null,
      json_schema: created?.json_schema ? JSON.parse(created.json_schema as string) : null,
      created_at: created?.created_at as number,
      created_by: created?.created_by as string,
    };

    // Invalidate types list cache after creating a new type
    try {
      await invalidateTypeCache(c.env.KV, id);
    } catch (cacheError) {
      // Log but don't fail the request if cache invalidation fails
      const logger = getLogger(c).child({ module: 'types' });
      logger.warn('Failed to invalidate cache', { error: cacheError });
    }

    return c.json(
      {
        success: true as const,
        data: typeData,
        message: 'Resource created successfully',
        timestamp: new Date().toISOString(),
      },
      201
    );
  } catch (error) {
    const logger = getLogger(c).child({ module: 'types' });
    logger.error('Error creating type', error instanceof Error ? error : undefined, {
      typeName: data.name,
    });
    throw error;
  }
});

/**
 * GET /api/types route definition
 */
const listTypesRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Types'],
  summary: 'List types',
  description: 'Get a paginated list of types with optional filtering',
  operationId: 'listTypes',
  request: {
    query: typeQuerySchema,
  },
  responses: {
    200: {
      description: 'List of types',
      content: {
        'application/json': {
          schema: TypeListResponseSchema,
        },
      },
    },
    400: {
      description: 'Validation error (e.g., invalid fields requested)',
      content: {
        'application/json': {
          schema: TypeErrorResponseSchema,
        },
      },
    },
  },
});

/**
 * GET /api/types
 * List all types with optional filtering and cursor-based pagination
 *
 * Caching: Results are cached when no cursor is provided (first page only)
 * to avoid stale pagination issues while still benefiting from caching
 * for the most common case.
 */
types.openapi(listTypesRoute, async c => {
  const query = c.req.valid('query');
  const db = c.env.DB;
  const kv = c.env.KV;

  try {
    // Only cache first page (no cursor) to avoid stale pagination issues
    // Also don't use cache when field selection is requested (cached data is full)
    const canCache = !query.cursor && !query.fields;
    let cacheKey: string | null = null;

    if (canCache) {
      // Get versioned cache key (includes list version for invalidation)
      cacheKey = await getVersionedTypesListCacheKey(kv, query.category, query.name);
      const cached = await getCache<TypeListResponse>(kv, cacheKey);
      if (cached) {
        return c.json(cached, 200);
      }
    }

    let sql = 'SELECT * FROM types WHERE 1=1';
    const bindings: unknown[] = [];

    // Apply filters
    if (query.category) {
      sql += ' AND category = ?';
      bindings.push(query.category);
    }

    if (query.name) {
      sql += ' AND name LIKE ?';
      bindings.push(`%${query.name}%`);
    }

    // Cursor-based pagination: cursor is "created_at:id" for stable ordering
    if (query.cursor) {
      try {
        const [cursorTimestamp, cursorId] = query.cursor.split(':');
        const timestamp = parseInt(cursorTimestamp, 10);
        if (!isNaN(timestamp) && cursorId) {
          // Get records where created_at < cursor OR (created_at = cursor AND id < cursorId)
          sql += ' AND (created_at < ? OR (created_at = ? AND id < ?))';
          bindings.push(timestamp, timestamp, cursorId);
        }
      } catch {
        // Invalid cursor format, ignore and continue without cursor
        const logger = getLogger(c).child({ module: 'types' });
        logger.warn('Invalid cursor format', { cursor: query.cursor });
      }
    }

    sql += ' ORDER BY created_at DESC, id DESC';

    // Fetch limit + 1 to check if there are more results
    const limit = query.limit || 20;
    sql += ' LIMIT ?';
    bindings.push(limit + 1);

    const { results } = await db
      .prepare(sql)
      .bind(...bindings)
      .all();

    // Check if there are more results
    const hasMore = results.length > limit;
    const items = hasMore ? results.slice(0, limit) : results;

    // Parse json_schema for each type
    const typesData = items.map(type => ({
      ...type,
      json_schema: type.json_schema ? JSON.parse(type.json_schema as string) : null,
    }));

    // Apply field selection if requested
    const fieldSelection = applyFieldSelectionToArray(
      typesData as Record<string, unknown>[],
      query.fields,
      TYPE_ALLOWED_FIELDS
    );

    if (!fieldSelection.success) {
      return c.json(
        {
          success: false as const,
          error: `Invalid fields requested: ${fieldSelection.invalidFields.join(', ')}`,
          code: 'INVALID_FIELDS',
          timestamp: new Date().toISOString(),
        },
        400
      );
    }

    // Generate next cursor from the last item
    let nextCursor: string | null = null;
    if (hasMore && items.length > 0) {
      const lastItem = items[items.length - 1];
      nextCursor = `${lastItem.created_at}:${lastItem.id}`;
    }

    // Build response with explicit literal type for success
    // Note: field selection may return partial objects, but TypeScript types match schema
    const responseData = {
      success: true as const,
      data: fieldSelection.data as z.infer<typeof typeSchema>[],
      metadata: {
        hasMore,
        ...(nextCursor && { cursor: nextCursor }),
      },
      timestamp: new Date().toISOString(),
    };

    // Cache the response (first page only, with full data - field selection not cached)
    // We only cache the full response to avoid caching different field combinations
    if (canCache && cacheKey && !query.fields) {
      setCache(kv, cacheKey, responseData, CACHE_TTL.TYPES_LIST).catch(() => {
        // Silently ignore cache write errors
      });
    }

    return c.json(responseData, 200);
  } catch (error) {
    const logger = getLogger(c).child({ module: 'types' });
    logger.error('Error listing types', error instanceof Error ? error : undefined);
    throw error;
  }
});

/**
 * GET /api/types/:id route definition
 */
const getTypeRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Types'],
  summary: 'Get type by ID',
  description:
    'Retrieve a specific type by its ID. Supports field selection via the `fields` query parameter.',
  operationId: 'getTypeById',
  request: {
    params: TypeIdParamsSchema,
    query: FieldSelectionQuerySchema,
  },
  responses: {
    200: {
      description: 'Type found',
      content: {
        'application/json': {
          schema: TypeResponseSchema,
        },
      },
    },
    400: {
      description: 'Validation error (e.g., invalid fields requested)',
      content: {
        'application/json': {
          schema: TypeErrorResponseSchema,
        },
      },
    },
    404: {
      description: 'Type not found',
      content: {
        'application/json': {
          schema: TypeErrorResponseSchema,
        },
      },
    },
  },
});

/**
 * GET /api/types/:id
 * Get a specific type by ID
 *
 * Supports field selection via the `fields` query parameter.
 * Example: GET /api/types/123?fields=id,name,category
 *
 * Caching: Individual type lookups are cached for fast repeated access.
 * Note: Field selection is applied after cache retrieval for consistency.
 */
types.openapi(getTypeRoute, async c => {
  const { id } = c.req.valid('param');
  const { fields: fieldsParam } = c.req.valid('query');
  const db = c.env.DB;
  const kv = c.env.KV;

  try {
    // Try to get from cache first
    const cacheKey = getTypeCacheKey(id);
    const cached = await getCache<{ data?: Record<string, unknown> }>(kv, cacheKey);
    if (cached) {
      // Apply field selection to cached response
      if (fieldsParam && cached.data) {
        const fieldSelection = applyFieldSelection(cached.data, fieldsParam, TYPE_ALLOWED_FIELDS);
        if (!fieldSelection.success) {
          return c.json(
            {
              success: false as const,
              error: `Invalid fields requested: ${fieldSelection.invalidFields.join(', ')}`,
              code: 'INVALID_FIELDS',
              timestamp: new Date().toISOString(),
            },
            400
          );
        }
        return c.json(
          {
            success: true as const,
            data: fieldSelection.data as z.infer<typeof typeSchema>,
            timestamp: new Date().toISOString(),
          },
          200
        );
      }
      return c.json(cached as z.infer<typeof TypeResponseSchema>, 200);
    }

    const type = await db.prepare('SELECT * FROM types WHERE id = ?').bind(id).first();

    if (!type) {
      return c.json(
        {
          success: false as const,
          error: 'Type not found',
          code: 'NOT_FOUND',
          timestamp: new Date().toISOString(),
        },
        404
      );
    }

    // Parse json_schema back to object if it exists
    const result = {
      ...type,
      json_schema: type.json_schema ? JSON.parse(type.json_schema as string) : null,
    };

    const responseData = {
      success: true as const,
      data: result as z.infer<typeof typeSchema>,
      timestamp: new Date().toISOString(),
    };

    // Cache the successful response (full data, field selection applied on retrieval)
    setCache(kv, cacheKey, responseData, CACHE_TTL.TYPES).catch(() => {
      // Silently ignore cache write errors
    });

    // Apply field selection if requested
    if (fieldsParam) {
      const fieldSelection = applyFieldSelection(
        result as Record<string, unknown>,
        fieldsParam,
        TYPE_ALLOWED_FIELDS
      );
      if (!fieldSelection.success) {
        return c.json(
          {
            success: false as const,
            error: `Invalid fields requested: ${fieldSelection.invalidFields.join(', ')}`,
            code: 'INVALID_FIELDS',
            timestamp: new Date().toISOString(),
          },
          400
        );
      }
      return c.json(
        {
          success: true as const,
          data: fieldSelection.data as z.infer<typeof typeSchema>,
          timestamp: new Date().toISOString(),
        },
        200
      );
    }

    return c.json(responseData, 200);
  } catch (error) {
    const logger = getLogger(c).child({ module: 'types' });
    logger.error('Error fetching type', error instanceof Error ? error : undefined, {
      typeId: id,
    });
    throw error;
  }
});

/**
 * PUT /api/types/:id
 * Update a type's metadata (admin only)
 */
types.put('/:id', requireAuth(), requireAdmin(), validateJson(updateTypeSchema), async c => {
  const id = c.req.param('id');
  const data = c.get('validated_json') as UpdateType;
  const db = c.env.DB;

  try {
    // Check if type exists
    const existing = await db.prepare('SELECT * FROM types WHERE id = ?').bind(id).first();

    if (!existing) {
      return c.json(response.notFound('Type'), 404);
    }

    // Build update query dynamically based on provided fields
    const updates: string[] = [];
    const bindings: unknown[] = [];

    if (data.name !== undefined) {
      // Check if new name already exists (for different type)
      const nameCheck = await db
        .prepare('SELECT id FROM types WHERE name = ? AND id != ?')
        .bind(data.name, id)
        .first();

      if (nameCheck) {
        return c.json(response.error('Type name already exists', 'DUPLICATE_NAME'), 409);
      }

      updates.push('name = ?');
      bindings.push(data.name);
    }

    if (data.description !== undefined) {
      updates.push('description = ?');
      bindings.push(data.description);
    }

    if (data.json_schema !== undefined) {
      const jsonSchemaString = data.json_schema ? JSON.stringify(data.json_schema) : null;
      updates.push('json_schema = ?');
      bindings.push(jsonSchemaString);
    }

    if (updates.length === 0) {
      // No updates provided, return current state
      const result = {
        ...existing,
        json_schema: existing.json_schema ? JSON.parse(existing.json_schema as string) : null,
      };
      return c.json(response.success(result));
    }

    // Execute update
    bindings.push(id);
    await db
      .prepare(`UPDATE types SET ${updates.join(', ')} WHERE id = ?`)
      .bind(...bindings)
      .run();

    // Fetch updated type
    const updated = await db.prepare('SELECT * FROM types WHERE id = ?').bind(id).first();

    const result = {
      ...updated,
      json_schema: updated?.json_schema ? JSON.parse(updated.json_schema as string) : null,
    };

    // Invalidate cache after update
    try {
      await invalidateTypeCache(c.env.KV, id);
    } catch (cacheError) {
      const logger = getLogger(c).child({ module: 'types' });
      logger.warn('Failed to invalidate cache', { error: cacheError });
    }

    return c.json(response.updated(result));
  } catch (error) {
    const logger = getLogger(c).child({ module: 'types' });
    logger.error('Error updating type', error instanceof Error ? error : undefined, {
      typeId: c.req.param('id'),
    });
    throw error;
  }
});

/**
 * DELETE /api/types/:id
 * Delete a type (only if not in use) (admin only)
 */
types.delete('/:id', requireAuth(), requireAdmin(), async c => {
  const id = c.req.param('id');
  const db = c.env.DB;

  try {
    // Check if type exists
    const existing = await db.prepare('SELECT * FROM types WHERE id = ?').bind(id).first();

    if (!existing) {
      return c.json(response.notFound('Type'), 404);
    }

    // Check if type is in use by entities
    const entityCount = await db
      .prepare('SELECT COUNT(*) as count FROM entities WHERE type_id = ?')
      .bind(id)
      .first();

    if (entityCount && (entityCount.count as number) > 0) {
      return c.json(
        response.error('Cannot delete type that is in use by entities', 'TYPE_IN_USE'),
        409
      );
    }

    // Check if type is in use by links
    const linkCount = await db
      .prepare('SELECT COUNT(*) as count FROM links WHERE type_id = ?')
      .bind(id)
      .first();

    if (linkCount && (linkCount.count as number) > 0) {
      return c.json(
        response.error('Cannot delete type that is in use by links', 'TYPE_IN_USE'),
        409
      );
    }

    // Delete the type
    await db.prepare('DELETE FROM types WHERE id = ?').bind(id).run();

    // Invalidate cache after delete
    try {
      await invalidateTypeCache(c.env.KV, id);
    } catch (cacheError) {
      const logger = getLogger(c).child({ module: 'types' });
      logger.warn('Failed to invalidate cache', { error: cacheError });
    }

    return c.json(response.deleted());
  } catch (error) {
    const logger = getLogger(c).child({ module: 'types' });
    logger.error('Error deleting type', error instanceof Error ? error : undefined, {
      typeId: c.req.param('id'),
    });
    throw error;
  }
});

export default types;
