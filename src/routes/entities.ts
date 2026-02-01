import { Hono } from 'hono';
import { validateJson, validateQuery } from '../middleware/validation.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import {
  createEntitySchema,
  updateEntitySchema,
  entityQuerySchema,
  CreateEntity,
  UpdateEntity,
  EntityQuery,
} from '../schemas/index.js';
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
  ENVIRONMENT: string;
};

const entities = new Hono<{ Bindings: Bindings }>();

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
 * POST /api/entities
 * Create a new entity
 *
 * Authentication required. The creator is automatically granted write permission.
 *
 * Permission inheritance:
 * - If `acl` is not provided: creator gets write permission (private to creator)
 * - If `acl` is an empty array: entity is public (no ACL restrictions)
 * - If `acl` is provided with entries: uses those entries, ensuring creator has write permission
 */
entities.post('/', requireAuth(), validateJson(createEntitySchema), async c => {
  const data = c.get('validated_json') as CreateEntity;
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
      return c.json(response.error('Type not found', 'TYPE_NOT_FOUND'), 404);
    }

    // Validate properties against the type's JSON schema (if defined)
    const schemaValidation = validatePropertiesAgainstSchema(
      data.properties,
      typeRecord.json_schema as string | null
    );

    if (!schemaValidation.valid) {
      return c.json(
        response.error(
          `Property validation failed: ${formatValidationErrors(schemaValidation.errors)}`,
          'SCHEMA_VALIDATION_FAILED',
          { validation_errors: schemaValidation.errors }
        ),
        400
      );
    }

    // Validate explicit ACL principals if provided
    if (data.acl && data.acl.length > 0) {
      const validation = await validateAclPrincipals(db, data.acl);
      if (!validation.valid) {
        return c.json(
          response.error(`Invalid ACL entries: ${validation.errors.join(', ')}`, 'INVALID_ACL'),
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
    const result = {
      ...created,
      properties: created?.properties ? JSON.parse(created.properties as string) : {},
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

    return c.json(response.created(result), 201);
  } catch (error) {
    getLogger(c)
      .child({ module: 'entities' })
      .error('Error creating entity', error instanceof Error ? error : undefined);
    throw error;
  }
});

/**
 * GET /api/entities
 * List entities with optional filtering and cursor-based pagination
 *
 * ACL filtering is applied when authenticated:
 * - Authenticated users see entities they have read permission on
 * - Resources with NULL acl_id are visible to all authenticated users
 * - Unauthenticated requests only see resources with NULL acl_id (public)
 */
entities.get('/', optionalAuth(), validateQuery(entityQuerySchema), async c => {
  const query = c.get('validated_query') as EntityQuery;
  const db = c.env.DB;
  const kv = c.env.KV;
  const user = c.get('user');

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
    if (!query.include_deleted) {
      sql += ' AND is_deleted = 0';
    }

    if (query.type_id) {
      sql += ' AND type_id = ?';
      bindings.push(query.type_id);
    }

    if (query.created_by) {
      sql += ' AND created_by = ?';
      bindings.push(query.created_by);
    }

    if (query.created_after) {
      sql += ' AND created_at >= ?';
      bindings.push(query.created_after);
    }

    if (query.created_before) {
      sql += ' AND created_at <= ?';
      bindings.push(query.created_before);
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
        getLogger(c)
          .child({ module: 'entities' })
          .warn('Invalid cursor format', { cursor: query.cursor });
      }
    }

    sql += ' ORDER BY created_at DESC, id DESC';

    // Fetch limit + 1 to check if there are more results
    // If using per-row ACL filtering, fetch more to account for filtered items
    const limit = query.limit || 20;
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
      query.fields,
      ENTITY_ALLOWED_FIELDS
    );

    if (!fieldSelection.success) {
      return c.json(
        response.error(
          `Invalid fields requested: ${fieldSelection.invalidFields.join(', ')}`,
          'INVALID_FIELDS',
          { allowed_fields: Array.from(ENTITY_ALLOWED_FIELDS) }
        ),
        400
      );
    }

    // Generate next cursor from the last item
    let nextCursor: string | null = null;
    if (hasMore && items.length > 0) {
      const lastItem = items[items.length - 1];
      nextCursor = `${lastItem.created_at}:${lastItem.id}`;
    }

    return c.json(response.cursorPaginated(fieldSelection.data, nextCursor, hasMore));
  } catch (error) {
    getLogger(c)
      .child({ module: 'entities' })
      .error('Error listing entities', error instanceof Error ? error : undefined);
    throw error;
  }
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
entities.get('/:id', optionalAuth(), async c => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const kv = c.env.KV;
  const fieldsParam = c.req.query('fields');
  const user = c.get('user');

  try {
    const entity = await findLatestVersion(db, id);

    if (!entity) {
      return c.json(response.notFound('Entity'), 404);
    }

    // Check permission
    const aclId = entity.acl_id as number | null;
    if (user) {
      // Authenticated user: check if they have read permission
      const canRead = await hasPermissionByAclId(db, kv, user.user_id, aclId, 'read');
      if (!canRead) {
        return c.json(response.forbidden('You do not have permission to view this entity'), 403);
      }
    } else {
      // Unauthenticated: only allow access to public entities (NULL acl_id)
      if (aclId !== null) {
        return c.json(response.forbidden('Authentication required to view this entity'), 403);
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
            response.error(
              `Invalid fields requested: ${fieldSelection.invalidFields.join(', ')}`,
              'INVALID_FIELDS',
              { allowed_fields: Array.from(ENTITY_ALLOWED_FIELDS) }
            ),
            400
          );
        }
        return c.json(response.success(fieldSelection.data));
      }
      return c.json(cached);
    }

    // Parse properties back to object
    const result = {
      ...entity,
      properties: entity.properties ? JSON.parse(entity.properties as string) : {},
      is_deleted: entity.is_deleted === 1,
      is_latest: entity.is_latest === 1,
    };

    const responseData = response.success(result);

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
          response.error(
            `Invalid fields requested: ${fieldSelection.invalidFields.join(', ')}`,
            'INVALID_FIELDS',
            { allowed_fields: Array.from(ENTITY_ALLOWED_FIELDS) }
          ),
          400
        );
      }
      return c.json(response.success(fieldSelection.data));
    }

    return c.json(responseData);
  } catch (error) {
    getLogger(c)
      .child({ module: 'entities' })
      .error('Error fetching entity', error instanceof Error ? error : undefined);
    throw error;
  }
});

/**
 * PUT /api/entities/:id
 * Update entity (creates new version)
 *
 * Requires authentication and write permission on the entity.
 */
entities.put('/:id', requireAuth(), validateJson(updateEntitySchema), async c => {
  const id = c.req.param('id');
  const data = c.get('validated_json') as UpdateEntity;
  const db = c.env.DB;
  const kv = c.env.KV;
  const now = getCurrentTimestamp();
  const user = c.get('user');
  const userId = user.user_id;

  try {
    // Get the current latest version
    const currentVersion = await findLatestVersion(db, id);

    if (!currentVersion) {
      return c.json(response.notFound('Entity'), 404);
    }

    // Check write permission
    const aclId = currentVersion.acl_id as number | null;
    const canWrite = await hasPermissionByAclId(db, kv, userId, aclId, 'write');
    if (!canWrite) {
      return c.json(response.forbidden('You do not have permission to update this entity'), 403);
    }

    // Check if entity is soft-deleted
    if (currentVersion.is_deleted === 1) {
      return c.json(
        response.error(
          'Cannot update deleted entity. Use restore endpoint first.',
          'ENTITY_DELETED'
        ),
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
        response.error(
          `Property validation failed: ${formatValidationErrors(schemaValidation.errors)}`,
          'SCHEMA_VALIDATION_FAILED',
          { validation_errors: schemaValidation.errors }
        ),
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

    const result = {
      ...updated,
      properties: updated?.properties ? JSON.parse(updated.properties as string) : {},
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

    return c.json(response.updated(result));
  } catch (error) {
    getLogger(c)
      .child({ module: 'entities' })
      .error('Error updating entity', error instanceof Error ? error : undefined);
    throw error;
  }
});

/**
 * DELETE /api/entities/:id
 * Soft delete entity (creates new version with is_deleted = true)
 *
 * Requires authentication and write permission on the entity.
 */
entities.delete('/:id', requireAuth(), async c => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const kv = c.env.KV;
  const now = getCurrentTimestamp();
  const user = c.get('user');
  const userId = user.user_id;

  try {
    // Get the current latest version
    const currentVersion = await findLatestVersion(db, id);

    if (!currentVersion) {
      return c.json(response.notFound('Entity'), 404);
    }

    // Check write permission
    const aclId = currentVersion.acl_id as number | null;
    const canWrite = await hasPermissionByAclId(db, kv, userId, aclId, 'write');
    if (!canWrite) {
      return c.json(response.forbidden('You do not have permission to delete this entity'), 403);
    }

    // Check if already soft-deleted
    if (currentVersion.is_deleted === 1) {
      return c.json(response.error('Entity is already deleted', 'ALREADY_DELETED'), 409);
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

    return c.json(response.deleted());
  } catch (error) {
    getLogger(c)
      .child({ module: 'entities' })
      .error('Error deleting entity', error instanceof Error ? error : undefined);
    throw error;
  }
});

/**
 * POST /api/entities/:id/restore
 * Restore a soft-deleted entity (creates new version with is_deleted = false)
 *
 * Requires authentication and write permission on the entity.
 */
entities.post('/:id/restore', requireAuth(), async c => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const kv = c.env.KV;
  const now = getCurrentTimestamp();
  const user = c.get('user');
  const userId = user.user_id;

  try {
    // Get the current latest version
    const currentVersion = await findLatestVersion(db, id);

    if (!currentVersion) {
      return c.json(response.notFound('Entity'), 404);
    }

    // Check write permission
    const aclId = currentVersion.acl_id as number | null;
    const canWrite = await hasPermissionByAclId(db, kv, userId, aclId, 'write');
    if (!canWrite) {
      return c.json(response.forbidden('You do not have permission to restore this entity'), 403);
    }

    // Check if entity is not deleted
    if (currentVersion.is_deleted === 0) {
      return c.json(response.error('Entity is not deleted', 'NOT_DELETED'), 409);
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

    const result = {
      ...restored,
      properties: restored?.properties ? JSON.parse(restored.properties as string) : {},
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

    return c.json(response.success(result, 'Entity restored successfully'));
  } catch (error) {
    getLogger(c)
      .child({ module: 'entities' })
      .error('Error restoring entity', error instanceof Error ? error : undefined);
    throw error;
  }
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
entities.get('/:id/versions', optionalAuth(), async c => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const kv = c.env.KV;
  const user = c.get('user');

  try {
    // First, find the latest version to ensure the entity exists
    const latestVersion = await findLatestVersion(db, id);

    if (!latestVersion) {
      return c.json(response.notFound('Entity'), 404);
    }

    // Check permission
    const aclId = latestVersion.acl_id as number | null;
    if (user) {
      // Authenticated user: check if they have read permission
      const canRead = await hasPermissionByAclId(db, kv, user.user_id, aclId, 'read');
      if (!canRead) {
        return c.json(response.forbidden('You do not have permission to view this entity'), 403);
      }
    } else {
      // Unauthenticated: only allow access to public entities (NULL acl_id)
      if (aclId !== null) {
        return c.json(response.forbidden('Authentication required to view this entity'), 403);
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
      ...entity,
      properties: entity.properties ? JSON.parse(entity.properties as string) : {},
      is_deleted: entity.is_deleted === 1,
      is_latest: entity.is_latest === 1,
    }));

    return c.json(response.success(versions));
  } catch (error) {
    getLogger(c)
      .child({ module: 'entities' })
      .error('Error fetching entity versions', error instanceof Error ? error : undefined);
    throw error;
  }
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
entities.get('/:id/versions/:version', optionalAuth(), async c => {
  const id = c.req.param('id');
  const versionParam = c.req.param('version');
  const db = c.env.DB;
  const kv = c.env.KV;
  const user = c.get('user');

  try {
    // Parse version number
    const versionNumber = parseInt(versionParam, 10);
    if (isNaN(versionNumber) || versionNumber < 1) {
      return c.json(response.error('Invalid version number', 'INVALID_VERSION'), 400);
    }

    // First, find the latest version to ensure the entity exists
    const latestVersion = await findLatestVersion(db, id);

    if (!latestVersion) {
      return c.json(response.notFound('Entity'), 404);
    }

    // Check permission
    const aclId = latestVersion.acl_id as number | null;
    if (user) {
      // Authenticated user: check if they have read permission
      const canRead = await hasPermissionByAclId(db, kv, user.user_id, aclId, 'read');
      if (!canRead) {
        return c.json(response.forbidden('You do not have permission to view this entity'), 403);
      }
    } else {
      // Unauthenticated: only allow access to public entities (NULL acl_id)
      if (aclId !== null) {
        return c.json(response.forbidden('Authentication required to view this entity'), 403);
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
      return c.json(response.notFound('Version'), 404);
    }

    const result = {
      ...entity,
      properties: entity.properties ? JSON.parse(entity.properties as string) : {},
      is_deleted: entity.is_deleted === 1,
      is_latest: entity.is_latest === 1,
    };

    return c.json(response.success(result));
  } catch (error) {
    getLogger(c)
      .child({ module: 'entities' })
      .error('Error fetching entity version', error instanceof Error ? error : undefined);
    throw error;
  }
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
entities.get('/:id/history', optionalAuth(), async c => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const kv = c.env.KV;
  const user = c.get('user');

  try {
    // First, find the latest version to ensure the entity exists
    const latestVersion = await findLatestVersion(db, id);

    if (!latestVersion) {
      return c.json(response.notFound('Entity'), 404);
    }

    // Check permission
    const aclId = latestVersion.acl_id as number | null;
    if (user) {
      // Authenticated user: check if they have read permission
      const canRead = await hasPermissionByAclId(db, kv, user.user_id, aclId, 'read');
      if (!canRead) {
        return c.json(response.forbidden('You do not have permission to view this entity'), 403);
      }
    } else {
      // Unauthenticated: only allow access to public entities (NULL acl_id)
      if (aclId !== null) {
        return c.json(response.forbidden('Authentication required to view this entity'), 403);
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
        id: entity.id,
        version: entity.version,
        type_id: entity.type_id,
        properties: parsedProps,
        created_at: entity.created_at,
        created_by: entity.created_by,
        is_deleted: entity.is_deleted === 1,
        is_latest: entity.is_latest === 1,
        diff: diff,
      };
    });

    return c.json(response.success(history));
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
entities.get('/:id/outbound', optionalAuth(), async c => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const kv = c.env.KV;
  const user = c.get('user');

  // Optional query parameters for filtering
  const typeId = c.req.query('type_id'); // Filter by link type
  const includeDeleted = c.req.query('include_deleted') === 'true';

  try {
    // First, verify the entity exists
    const entity = await findLatestVersion(db, id);

    if (!entity) {
      return c.json(response.notFound('Entity'), 404);
    }

    // Check permission on the source entity
    const entityAclId = entity.acl_id as number | null;
    if (user) {
      // Authenticated user: check if they have read permission on the source entity
      const canRead = await hasPermissionByAclId(db, kv, user.user_id, entityAclId, 'read');
      if (!canRead) {
        return c.json(response.forbidden('You do not have permission to view this entity'), 403);
      }
    } else {
      // Unauthenticated: only allow access to public entities (NULL acl_id)
      if (entityAclId !== null) {
        return c.json(response.forbidden('Authentication required to view this entity'), 403);
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
          const targetAclId = (item as Record<string, unknown>).target_acl_id as number | null | undefined;
          if (targetAclId === null || targetAclId === undefined) {
            return true;
          }
          return targetEntityAclFilter!.accessibleAclIds.has(targetAclId);
        });
      }
    }

    // Parse properties for each link and target entity
    const linksData = filteredResults.map(link => ({
      id: link.id,
      type_id: link.type_id,
      source_entity_id: link.source_entity_id,
      target_entity_id: link.target_entity_id,
      properties: link.properties ? JSON.parse(link.properties as string) : {},
      version: link.version,
      previous_version_id: link.previous_version_id,
      created_at: link.created_at,
      created_by: link.created_by,
      is_deleted: link.is_deleted === 1,
      is_latest: link.is_latest === 1,
      target_entity: {
        id: link.target_entity_id,
        type_id: link.target_type_id,
        properties: link.target_properties ? JSON.parse(link.target_properties as string) : {},
      },
    }));

    return c.json(response.success(linksData));
  } catch (error) {
    getLogger(c)
      .child({ module: 'entities' })
      .error('Error fetching outbound links', error instanceof Error ? error : undefined);
    throw error;
  }
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
entities.get('/:id/inbound', optionalAuth(), async c => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const kv = c.env.KV;
  const user = c.get('user');

  // Optional query parameters for filtering
  const typeId = c.req.query('type_id'); // Filter by link type
  const includeDeleted = c.req.query('include_deleted') === 'true';

  try {
    // First, verify the entity exists
    const entity = await findLatestVersion(db, id);

    if (!entity) {
      return c.json(response.notFound('Entity'), 404);
    }

    // Check permission on the target entity
    const entityAclId = entity.acl_id as number | null;
    if (user) {
      // Authenticated user: check if they have read permission on the target entity
      const canRead = await hasPermissionByAclId(db, kv, user.user_id, entityAclId, 'read');
      if (!canRead) {
        return c.json(response.forbidden('You do not have permission to view this entity'), 403);
      }
    } else {
      // Unauthenticated: only allow access to public entities (NULL acl_id)
      if (entityAclId !== null) {
        return c.json(response.forbidden('Authentication required to view this entity'), 403);
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
          const sourceAclId = (item as Record<string, unknown>).source_acl_id as number | null | undefined;
          if (sourceAclId === null || sourceAclId === undefined) {
            return true;
          }
          return sourceEntityAclFilter!.accessibleAclIds.has(sourceAclId);
        });
      }
    }

    // Parse properties for each link and source entity
    const linksData = filteredResults.map(link => ({
      id: link.id,
      type_id: link.type_id,
      source_entity_id: link.source_entity_id,
      target_entity_id: link.target_entity_id,
      properties: link.properties ? JSON.parse(link.properties as string) : {},
      version: link.version,
      previous_version_id: link.previous_version_id,
      created_at: link.created_at,
      created_by: link.created_by,
      is_deleted: link.is_deleted === 1,
      is_latest: link.is_latest === 1,
      source_entity: {
        id: link.source_entity_id,
        type_id: link.source_type_id,
        properties: link.source_properties ? JSON.parse(link.source_properties as string) : {},
      },
    }));

    return c.json(response.success(linksData));
  } catch (error) {
    getLogger(c)
      .child({ module: 'entities' })
      .error('Error fetching inbound links', error instanceof Error ? error : undefined);
    throw error;
  }
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
entities.get('/:id/neighbors', optionalAuth(), async c => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const kv = c.env.KV;
  const user = c.get('user');

  // Optional query parameters for filtering
  const typeId = c.req.query('type_id'); // Filter by link type
  const entityTypeId = c.req.query('entity_type_id'); // Filter by entity type
  const includeDeleted = c.req.query('include_deleted') === 'true';
  const direction = c.req.query('direction'); // 'inbound', 'outbound', or both (default)

  try {
    // First, verify the entity exists
    const entity = await findLatestVersion(db, id);

    if (!entity) {
      return c.json(response.notFound('Entity'), 404);
    }

    // Check permission on the center entity
    const entityAclId = entity.acl_id as number | null;
    if (user) {
      // Authenticated user: check if they have read permission on the center entity
      const canRead = await hasPermissionByAclId(db, kv, user.user_id, entityAclId, 'read');
      if (!canRead) {
        return c.json(response.forbidden('You do not have permission to view this entity'), 403);
      }
    } else {
      // Unauthenticated: only allow access to public entities (NULL acl_id)
      if (entityAclId !== null) {
        return c.json(response.forbidden('Authentication required to view this entity'), 403);
      }
    }

    // Build ACL filters for links and neighbor entities
    let linkAclFilter: Awaited<ReturnType<typeof buildAclFilterClause>> | null = null;
    let neighborEntityAclFilter: Awaited<ReturnType<typeof buildAclFilterClause>> | null = null;

    if (user) {
      // Build ACL filters for authenticated users
      linkAclFilter = await buildAclFilterClause(db, kv, user.user_id, 'read', 'l.acl_id');
      neighborEntityAclFilter = await buildAclFilterClause(db, kv, user.user_id, 'read', 'e.acl_id');
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
            const aclId = (item as Record<string, unknown>).link_acl_id as number | null | undefined;
            if (aclId === null || aclId === undefined) {
              return true;
            }
            return linkAclFilter!.accessibleAclIds.has(aclId);
          });
        }
        if (neighborEntityAclFilter && !neighborEntityAclFilter.useFilter) {
          filteredOutbound = filteredOutbound.filter(item => {
            const aclId = (item as Record<string, unknown>).entity_acl_id as number | null | undefined;
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
            const aclId = (item as Record<string, unknown>).link_acl_id as number | null | undefined;
            if (aclId === null || aclId === undefined) {
              return true;
            }
            return linkAclFilter!.accessibleAclIds.has(aclId);
          });
        }
        if (neighborEntityAclFilter && !neighborEntityAclFilter.useFilter) {
          filteredInbound = filteredInbound.filter(item => {
            const aclId = (item as Record<string, unknown>).entity_acl_id as number | null | undefined;
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

    return c.json(response.success(neighborsData));
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
    await setEntityAcl(db, entity.id as string, aclId, userId);

    // Get the updated ACL for response
    let responseEntries: unknown[] = [];
    if (aclId !== null) {
      responseEntries = await getEnrichedAclEntries(db, aclId);
    }

    // Invalidate cache
    try {
      await invalidateEntityCache(kv, id);
      await invalidateEntityCache(kv, entity.id as string);
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
