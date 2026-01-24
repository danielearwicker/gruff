import { Hono } from 'hono';
import { validateJson, validateQuery } from '../middleware/validation.js';
import { createTypeSchema, updateTypeSchema, typeQuerySchema } from '../schemas/index.js';
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

const types = new Hono<{ Bindings: Bindings }>();

// Helper function to generate UUID
function generateUUID(): string {
  return crypto.randomUUID();
}

// Helper function to get current timestamp
function getCurrentTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * POST /api/types
 * Create a new type
 */
types.post('/', validateJson(createTypeSchema), async (c) => {
  const data = c.get('validated_json') as any;
  const db = c.env.DB;

  const id = generateUUID();
  const now = getCurrentTimestamp();

  // For now, we'll use the test user ID from seed data. In the future, this will come from auth middleware
  const systemUserId = 'test-user-001';

  try {
    // Check if type name already exists
    const existing = await db.prepare('SELECT id FROM types WHERE name = ?')
      .bind(data.name)
      .first();

    if (existing) {
      return c.json(response.error('Type name already exists', 'DUPLICATE_NAME'), 409);
    }

    // Convert json_schema to string if provided
    const jsonSchemaString = data.json_schema ? JSON.stringify(data.json_schema) : null;

    // Insert the new type
    await db.prepare(`
      INSERT INTO types (id, name, category, description, json_schema, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      data.name,
      data.category,
      data.description || null,
      jsonSchemaString,
      now,
      systemUserId
    ).run();

    // Fetch the created type
    const created = await db.prepare('SELECT * FROM types WHERE id = ?')
      .bind(id)
      .first();

    // Parse json_schema back to object if it exists
    const result = {
      ...created,
      json_schema: created?.json_schema ? JSON.parse(created.json_schema as string) : null,
    };

    // Invalidate types list cache after creating a new type
    try {
      await invalidateTypeCache(c.env.KV, id);
    } catch (cacheError) {
      // Log but don't fail the request if cache invalidation fails
      const logger = getLogger(c).child({ module: 'types' });
      logger.warn('Failed to invalidate cache', { error: cacheError });
    }

    return c.json(response.created(result), 201);
  } catch (error) {
    const logger = getLogger(c).child({ module: 'types' });
    logger.error('Error creating type', error instanceof Error ? error : undefined, { typeName: data.name });
    throw error;
  }
});

/**
 * GET /api/types
 * List all types with optional filtering and cursor-based pagination
 *
 * Caching: Results are cached when no cursor is provided (first page only)
 * to avoid stale pagination issues while still benefiting from caching
 * for the most common case.
 */
types.get('/', validateQuery(typeQuerySchema), async (c) => {
  const query = c.get('validated_query') as any;
  const db = c.env.DB;
  const kv = c.env.KV;

  try {
    // Only cache first page (no cursor) to avoid stale pagination issues
    const canCache = !query.cursor;
    let cacheKey: string | null = null;

    if (canCache) {
      // Get versioned cache key (includes list version for invalidation)
      cacheKey = await getVersionedTypesListCacheKey(kv, query.category, query.name);
      const cached = await getCache<any>(kv, cacheKey);
      if (cached) {
        return c.json(cached);
      }
    }

    let sql = 'SELECT * FROM types WHERE 1=1';
    const bindings: any[] = [];

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
      } catch (e) {
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

    const { results } = await db.prepare(sql).bind(...bindings).all();

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
        response.error(
          `Invalid fields requested: ${fieldSelection.invalidFields.join(', ')}`,
          'INVALID_FIELDS',
          { allowed_fields: Array.from(TYPE_ALLOWED_FIELDS) }
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

    const responseData = response.cursorPaginated(fieldSelection.data, nextCursor, hasMore);

    // Cache the response (first page only, with full data - field selection not cached)
    // We only cache the full response to avoid caching different field combinations
    if (canCache && cacheKey && !query.fields) {
      setCache(kv, cacheKey, responseData, CACHE_TTL.TYPES_LIST).catch(() => {
        // Silently ignore cache write errors
      });
    }

    return c.json(responseData);
  } catch (error) {
    const logger = getLogger(c).child({ module: 'types' });
    logger.error('Error listing types', error instanceof Error ? error : undefined);
    throw error;
  }
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
types.get('/:id', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const kv = c.env.KV;
  const fieldsParam = c.req.query('fields');

  try {
    // Try to get from cache first
    const cacheKey = getTypeCacheKey(id);
    const cached = await getCache<any>(kv, cacheKey);
    if (cached) {
      // Apply field selection to cached response
      if (fieldsParam && cached.data) {
        const fieldSelection = applyFieldSelection(
          cached.data as Record<string, unknown>,
          fieldsParam,
          TYPE_ALLOWED_FIELDS
        );
        if (!fieldSelection.success) {
          return c.json(
            response.error(
              `Invalid fields requested: ${fieldSelection.invalidFields.join(', ')}`,
              'INVALID_FIELDS',
              { allowed_fields: Array.from(TYPE_ALLOWED_FIELDS) }
            ),
            400
          );
        }
        return c.json(response.success(fieldSelection.data));
      }
      return c.json(cached);
    }

    const type = await db.prepare('SELECT * FROM types WHERE id = ?')
      .bind(id)
      .first();

    if (!type) {
      return c.json(response.notFound('Type'), 404);
    }

    // Parse json_schema back to object if it exists
    const result = {
      ...type,
      json_schema: type.json_schema ? JSON.parse(type.json_schema as string) : null,
    };

    const responseData = response.success(result);

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
          response.error(
            `Invalid fields requested: ${fieldSelection.invalidFields.join(', ')}`,
            'INVALID_FIELDS',
            { allowed_fields: Array.from(TYPE_ALLOWED_FIELDS) }
          ),
          400
        );
      }
      return c.json(response.success(fieldSelection.data));
    }

    return c.json(responseData);
  } catch (error) {
    const logger = getLogger(c).child({ module: 'types' });
    logger.error('Error fetching type', error instanceof Error ? error : undefined, { typeId: c.req.param('id') });
    throw error;
  }
});

/**
 * PUT /api/types/:id
 * Update a type's metadata
 */
types.put('/:id', validateJson(updateTypeSchema), async (c) => {
  const id = c.req.param('id');
  const data = c.get('validated_json') as any;
  const db = c.env.DB;

  try {
    // Check if type exists
    const existing = await db.prepare('SELECT * FROM types WHERE id = ?')
      .bind(id)
      .first();

    if (!existing) {
      return c.json(response.notFound('Type'), 404);
    }

    // Build update query dynamically based on provided fields
    const updates: string[] = [];
    const bindings: any[] = [];

    if (data.name !== undefined) {
      // Check if new name already exists (for different type)
      const nameCheck = await db.prepare('SELECT id FROM types WHERE name = ? AND id != ?')
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
    await db.prepare(`UPDATE types SET ${updates.join(', ')} WHERE id = ?`)
      .bind(...bindings)
      .run();

    // Fetch updated type
    const updated = await db.prepare('SELECT * FROM types WHERE id = ?')
      .bind(id)
      .first();

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
    logger.error('Error updating type', error instanceof Error ? error : undefined, { typeId: c.req.param('id') });
    throw error;
  }
});

/**
 * DELETE /api/types/:id
 * Delete a type (only if not in use)
 */
types.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;

  try {
    // Check if type exists
    const existing = await db.prepare('SELECT * FROM types WHERE id = ?')
      .bind(id)
      .first();

    if (!existing) {
      return c.json(response.notFound('Type'), 404);
    }

    // Check if type is in use by entities
    const entityCount = await db.prepare('SELECT COUNT(*) as count FROM entities WHERE type_id = ?')
      .bind(id)
      .first();

    if (entityCount && (entityCount.count as number) > 0) {
      return c.json(
        response.error('Cannot delete type that is in use by entities', 'TYPE_IN_USE'),
        409
      );
    }

    // Check if type is in use by links
    const linkCount = await db.prepare('SELECT COUNT(*) as count FROM links WHERE type_id = ?')
      .bind(id)
      .first();

    if (linkCount && (linkCount.count as number) > 0) {
      return c.json(
        response.error('Cannot delete type that is in use by links', 'TYPE_IN_USE'),
        409
      );
    }

    // Delete the type
    await db.prepare('DELETE FROM types WHERE id = ?')
      .bind(id)
      .run();

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
    logger.error('Error deleting type', error instanceof Error ? error : undefined, { typeId: c.req.param('id') });
    throw error;
  }
});

export default types;
