import { Hono } from 'hono';
import { validateJson, validateQuery } from '../middleware/validation.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import {
  createLinkSchema,
  updateLinkSchema,
  linkQuerySchema,
  CreateLink,
  UpdateLink,
  LinkQuery,
} from '../schemas/index.js';
import { setAclRequestSchema, SetAclRequest } from '../schemas/acl.js';
import * as response from '../utils/response.js';
import { getLogger } from '../middleware/request-context.js';
import { validatePropertiesAgainstSchema, formatValidationErrors } from '../utils/json-schema.js';
import { logLinkOperation } from '../utils/audit.js';
import {
  getCache,
  setCache,
  getLinkCacheKey,
  invalidateLinkCache,
  CACHE_TTL,
} from '../utils/cache.js';
import {
  applyFieldSelection,
  applyFieldSelectionToArray,
  LINK_ALLOWED_FIELDS,
} from '../utils/field-selection.js';
import {
  getEnrichedAclEntries,
  getOrCreateAcl,
  setLinkAcl,
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

const links = new Hono<{ Bindings: Bindings }>();

// Helper function to generate UUID
function generateUUID(): string {
  return crypto.randomUUID();
}

// Helper function to get current timestamp
function getCurrentTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}

// Helper function to find the latest version of a link by any ID in its version chain
async function findLatestVersion(
  db: D1Database,
  linkId: string
): Promise<Record<string, unknown> | null> {
  // First, try direct match with is_latest
  const link = await db
    .prepare('SELECT * FROM links WHERE id = ? AND is_latest = 1')
    .bind(linkId)
    .first();

  if (link) {
    return link;
  }

  // If not found, this ID might be an old version. Find all links that reference this ID
  // in their version chain and get the one with is_latest = 1
  const result = await db
    .prepare(
      `
    WITH RECURSIVE version_chain AS (
      -- Start with the given ID
      SELECT * FROM links WHERE id = ?
      UNION ALL
      -- Find all links that have this link as previous_version
      SELECT l.* FROM links l
      INNER JOIN version_chain vc ON l.previous_version_id = vc.id
    )
    SELECT * FROM version_chain WHERE is_latest = 1 LIMIT 1
  `
    )
    .bind(linkId)
    .first();

  return result || null;
}

/**
 * POST /api/links
 * Create a new link
 *
 * Authentication required. The creator is automatically granted write permission.
 *
 * Permission inheritance:
 * - If `acl` is not provided: creator gets write permission (private to creator)
 * - If `acl` is an empty array: link is public (no ACL restrictions)
 * - If `acl` is provided with entries: uses those entries, ensuring creator has write permission
 */
links.post('/', requireAuth(), validateJson(createLinkSchema), async c => {
  const data = c.get('validated_json') as CreateLink;
  const db = c.env.DB;
  const user = c.get('user');

  const id = generateUUID();
  const now = getCurrentTimestamp();
  const userId = user.user_id;

  try {
    // Check if type_id exists and get its json_schema
    const typeRecord = await db
      .prepare('SELECT id, json_schema FROM types WHERE id = ? AND category = ?')
      .bind(data.type_id, 'link')
      .first();

    if (!typeRecord) {
      return c.json(response.error('Link type not found', 'TYPE_NOT_FOUND'), 404);
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

    // Check if source entity exists and is not deleted
    const sourceEntity = await db
      .prepare('SELECT id FROM entities WHERE id = ? AND is_latest = 1 AND is_deleted = 0')
      .bind(data.source_entity_id)
      .first();

    if (!sourceEntity) {
      return c.json(
        response.error('Source entity not found or is deleted', 'SOURCE_ENTITY_NOT_FOUND'),
        404
      );
    }

    // Check if target entity exists and is not deleted
    const targetEntity = await db
      .prepare('SELECT id FROM entities WHERE id = ? AND is_latest = 1 AND is_deleted = 0')
      .bind(data.target_entity_id)
      .first();

    if (!targetEntity) {
      return c.json(
        response.error('Target entity not found or is deleted', 'TARGET_ENTITY_NOT_FOUND'),
        404
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

    // Create ACL for the new link with permission inheritance
    // - undefined acl: creator gets write permission
    // - empty array: public (no ACL)
    // - explicit entries: uses entries + ensures creator has write
    const aclId = await createResourceAcl(db, userId, data.acl);

    // Convert properties to string
    const propertiesString = JSON.stringify(data.properties);

    // Insert the new link (version 1) with ACL
    await db
      .prepare(
        `
      INSERT INTO links (id, type_id, source_entity_id, target_entity_id, properties, version, previous_version_id, created_at, created_by, is_deleted, is_latest, acl_id)
      VALUES (?, ?, ?, ?, ?, 1, NULL, ?, ?, 0, 1, ?)
    `
      )
      .bind(
        id,
        data.type_id,
        data.source_entity_id,
        data.target_entity_id,
        propertiesString,
        now,
        userId,
        aclId
      )
      .run();

    // Fetch the created link
    const created = await db.prepare('SELECT * FROM links WHERE id = ?').bind(id).first();

    // Parse properties back to object
    const result = {
      ...created,
      properties: created?.properties ? JSON.parse(created.properties as string) : {},
      is_deleted: created?.is_deleted === 1,
      is_latest: created?.is_latest === 1,
    };

    // Log the create operation
    try {
      await logLinkOperation(db, c, 'create', id, userId, {
        type_id: data.type_id,
        source_entity_id: data.source_entity_id,
        target_entity_id: data.target_entity_id,
        properties: data.properties,
        acl_id: aclId,
      });
    } catch (auditError) {
      getLogger(c)
        .child({ module: 'links' })
        .warn('Failed to create audit log', { error: auditError });
    }

    return c.json(response.created(result), 201);
  } catch (error) {
    getLogger(c)
      .child({ module: 'links' })
      .error('Error creating link', error instanceof Error ? error : undefined);
    throw error;
  }
});

/**
 * GET /api/links
 * List links with optional filtering and cursor-based pagination
 *
 * ACL filtering is applied when authenticated:
 * - Authenticated users see links they have read permission on
 * - Resources with NULL acl_id are visible to all authenticated users
 * - Unauthenticated requests only see resources with NULL acl_id (public)
 */
links.get('/', optionalAuth(), validateQuery(linkQuerySchema), async c => {
  const query = c.get('validated_query') as LinkQuery;
  const db = c.env.DB;
  const kv = c.env.KV;
  const user = c.get('user');

  try {
    let sql = 'SELECT * FROM links WHERE is_latest = 1';
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

    if (query.source_entity_id) {
      sql += ' AND source_entity_id = ?';
      bindings.push(query.source_entity_id);
    }

    if (query.target_entity_id) {
      sql += ' AND target_entity_id = ?';
      bindings.push(query.target_entity_id);
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
          .child({ module: 'links' })
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

    // Parse properties for each link
    const linksData = items.map(link => ({
      ...link,
      properties: link.properties ? JSON.parse(link.properties as string) : {},
      is_deleted: link.is_deleted === 1,
      is_latest: link.is_latest === 1,
    }));

    // Apply field selection if requested
    const fieldSelection = applyFieldSelectionToArray(
      linksData as Record<string, unknown>[],
      query.fields,
      LINK_ALLOWED_FIELDS
    );

    if (!fieldSelection.success) {
      return c.json(
        response.error(
          `Invalid fields requested: ${fieldSelection.invalidFields.join(', ')}`,
          'INVALID_FIELDS',
          { allowed_fields: Array.from(LINK_ALLOWED_FIELDS) }
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
      .child({ module: 'links' })
      .error('Error listing links', error instanceof Error ? error : undefined);
    throw error;
  }
});

/**
 * GET /api/links/:id
 * Get the latest version of a specific link
 *
 * Supports field selection via the `fields` query parameter.
 * Example: GET /api/links/123?fields=id,type_id,source_entity_id,target_entity_id
 *
 * Caching: Individual link lookups are cached for fast repeated access.
 * Cache is invalidated when link is updated, deleted, or restored.
 * Note: Field selection is applied after cache retrieval for consistency.
 *
 * Permission checking:
 * - Authenticated users must have read permission on the link
 * - Links with NULL acl_id are accessible to all authenticated users
 * - Unauthenticated requests can only access links with NULL acl_id
 */
links.get('/:id', optionalAuth(), async c => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const kv = c.env.KV;
  const fieldsParam = c.req.query('fields');
  const user = c.get('user');

  try {
    const link = await findLatestVersion(db, id);

    if (!link) {
      return c.json(response.notFound('Link'), 404);
    }

    // Check permission
    const aclId = link.acl_id as number | null;
    if (user) {
      // Authenticated user: check if they have read permission
      const canRead = await hasPermissionByAclId(db, kv, user.user_id, aclId, 'read');
      if (!canRead) {
        return c.json(response.forbidden('You do not have permission to view this link'), 403);
      }
    } else {
      // Unauthenticated: only allow access to public links (NULL acl_id)
      if (aclId !== null) {
        return c.json(response.forbidden('Authentication required to view this link'), 403);
      }
    }

    // Try to get from cache (only for authenticated users with permission or public links)
    const cacheKey = getLinkCacheKey(id);
    const cached = await getCache<{ data?: Record<string, unknown> }>(kv, cacheKey);
    if (cached) {
      // Apply field selection to cached response
      if (fieldsParam && cached.data) {
        const fieldSelection = applyFieldSelection(cached.data, fieldsParam, LINK_ALLOWED_FIELDS);
        if (!fieldSelection.success) {
          return c.json(
            response.error(
              `Invalid fields requested: ${fieldSelection.invalidFields.join(', ')}`,
              'INVALID_FIELDS',
              { allowed_fields: Array.from(LINK_ALLOWED_FIELDS) }
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
      ...link,
      properties: link.properties ? JSON.parse(link.properties as string) : {},
      is_deleted: link.is_deleted === 1,
      is_latest: link.is_latest === 1,
    };

    const responseData = response.success(result);

    // Cache the successful response (full data, field selection applied on retrieval)
    setCache(kv, cacheKey, responseData, CACHE_TTL.LINK).catch(() => {
      // Silently ignore cache write errors
    });

    // Apply field selection if requested
    if (fieldsParam) {
      const fieldSelection = applyFieldSelection(
        result as Record<string, unknown>,
        fieldsParam,
        LINK_ALLOWED_FIELDS
      );
      if (!fieldSelection.success) {
        return c.json(
          response.error(
            `Invalid fields requested: ${fieldSelection.invalidFields.join(', ')}`,
            'INVALID_FIELDS',
            { allowed_fields: Array.from(LINK_ALLOWED_FIELDS) }
          ),
          400
        );
      }
      return c.json(response.success(fieldSelection.data));
    }

    return c.json(responseData);
  } catch (error) {
    getLogger(c)
      .child({ module: 'links' })
      .error('Error fetching link', error instanceof Error ? error : undefined);
    throw error;
  }
});

/**
 * PUT /api/links/:id
 * Update link (creates new version)
 *
 * Requires authentication and write permission on the link.
 */
links.put('/:id', requireAuth(), validateJson(updateLinkSchema), async c => {
  const id = c.req.param('id');
  const data = c.get('validated_json') as UpdateLink;
  const db = c.env.DB;
  const kv = c.env.KV;
  const now = getCurrentTimestamp();
  const user = c.get('user');
  const userId = user.user_id;

  try {
    // Get the current latest version
    const currentVersion = await findLatestVersion(db, id);

    if (!currentVersion) {
      return c.json(response.notFound('Link'), 404);
    }

    // Check write permission
    const aclId = currentVersion.acl_id as number | null;
    const canWrite = await hasPermissionByAclId(db, kv, userId, aclId, 'write');
    if (!canWrite) {
      return c.json(response.forbidden('You do not have permission to update this link'), 403);
    }

    // Check if link is soft-deleted
    if (currentVersion.is_deleted === 1) {
      return c.json(
        response.error('Cannot update deleted link. Use restore endpoint first.', 'LINK_DELETED'),
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
    await db.prepare('UPDATE links SET is_latest = 0 WHERE id = ?').bind(currentVersion.id).run();

    // Then insert new version with new ID, preserving acl_id
    await db
      .prepare(
        `
      INSERT INTO links (id, type_id, source_entity_id, target_entity_id, properties, version, previous_version_id, created_at, created_by, is_deleted, is_latest, acl_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?)
    `
      )
      .bind(
        newId,
        currentVersion.type_id,
        currentVersion.source_entity_id,
        currentVersion.target_entity_id,
        propertiesString,
        newVersion,
        currentVersion.id, // previous_version_id references the previous row's id
        now,
        userId,
        aclId
      )
      .run();

    // Fetch the new version
    const updated = await db.prepare('SELECT * FROM links WHERE id = ?').bind(newId).first();

    const result = {
      ...updated,
      properties: updated?.properties ? JSON.parse(updated.properties as string) : {},
      is_deleted: updated?.is_deleted === 1,
      is_latest: updated?.is_latest === 1,
    };

    // Log the update operation
    try {
      await logLinkOperation(db, c, 'update', newId, userId, {
        previous_version_id: currentVersion.id,
        old_properties: currentVersion.properties
          ? JSON.parse(currentVersion.properties as string)
          : {},
        new_properties: data.properties,
        version: newVersion,
      });
    } catch (auditError) {
      getLogger(c)
        .child({ module: 'links' })
        .warn('Failed to create audit log', { error: auditError });
    }

    // Invalidate cache for both the original ID and the old version ID
    try {
      await Promise.all([
        invalidateLinkCache(kv, id),
        invalidateLinkCache(kv, currentVersion.id as string),
      ]);
    } catch (cacheError) {
      getLogger(c)
        .child({ module: 'links' })
        .warn('Failed to invalidate cache', { error: cacheError });
    }

    return c.json(response.updated(result));
  } catch (error) {
    getLogger(c)
      .child({ module: 'links' })
      .error('Error updating link', error instanceof Error ? error : undefined);
    throw error;
  }
});

/**
 * DELETE /api/links/:id
 * Soft delete link (creates new version with is_deleted = true)
 *
 * Requires authentication and write permission on the link.
 */
links.delete('/:id', requireAuth(), async c => {
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
      return c.json(response.notFound('Link'), 404);
    }

    // Check write permission
    const aclId = currentVersion.acl_id as number | null;
    const canWrite = await hasPermissionByAclId(db, kv, userId, aclId, 'write');
    if (!canWrite) {
      return c.json(response.forbidden('You do not have permission to delete this link'), 403);
    }

    // Check if already soft-deleted
    if (currentVersion.is_deleted === 1) {
      return c.json(response.error('Link is already deleted', 'ALREADY_DELETED'), 409);
    }

    const newVersion = (currentVersion.version as number) + 1;
    const newId = generateUUID();

    // Set current version's is_latest to false
    await db.prepare('UPDATE links SET is_latest = 0 WHERE id = ?').bind(currentVersion.id).run();

    // Insert new version with is_deleted = 1 and new ID, preserving acl_id
    await db
      .prepare(
        `
      INSERT INTO links (id, type_id, source_entity_id, target_entity_id, properties, version, previous_version_id, created_at, created_by, is_deleted, is_latest, acl_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?)
    `
      )
      .bind(
        newId,
        currentVersion.type_id,
        currentVersion.source_entity_id,
        currentVersion.target_entity_id,
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
      await logLinkOperation(db, c, 'delete', newId, userId, {
        previous_version_id: currentVersion.id,
        type_id: currentVersion.type_id,
        source_entity_id: currentVersion.source_entity_id,
        target_entity_id: currentVersion.target_entity_id,
        version: newVersion,
      });
    } catch (auditError) {
      getLogger(c)
        .child({ module: 'links' })
        .warn('Failed to create audit log', { error: auditError });
    }

    // Invalidate cache for both the original ID and the old version ID
    try {
      await Promise.all([
        invalidateLinkCache(kv, id),
        invalidateLinkCache(kv, currentVersion.id as string),
      ]);
    } catch (cacheError) {
      getLogger(c)
        .child({ module: 'links' })
        .warn('Failed to invalidate cache', { error: cacheError });
    }

    return c.json(response.deleted());
  } catch (error) {
    getLogger(c)
      .child({ module: 'links' })
      .error('Error deleting link', error instanceof Error ? error : undefined);
    throw error;
  }
});

/**
 * POST /api/links/:id/restore
 * Restore a soft-deleted link (creates new version with is_deleted = false)
 *
 * Requires authentication and write permission on the link.
 */
links.post('/:id/restore', requireAuth(), async c => {
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
      return c.json(response.notFound('Link'), 404);
    }

    // Check write permission
    const aclId = currentVersion.acl_id as number | null;
    const canWrite = await hasPermissionByAclId(db, kv, userId, aclId, 'write');
    if (!canWrite) {
      return c.json(response.forbidden('You do not have permission to restore this link'), 403);
    }

    // Check if link is not deleted
    if (currentVersion.is_deleted === 0) {
      return c.json(response.error('Link is not deleted', 'NOT_DELETED'), 409);
    }

    const newVersion = (currentVersion.version as number) + 1;
    const newId = generateUUID();

    // Set current version's is_latest to false
    await db.prepare('UPDATE links SET is_latest = 0 WHERE id = ?').bind(currentVersion.id).run();

    // Insert new version with is_deleted = 0 and new ID, preserving acl_id
    await db
      .prepare(
        `
      INSERT INTO links (id, type_id, source_entity_id, target_entity_id, properties, version, previous_version_id, created_at, created_by, is_deleted, is_latest, acl_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?)
    `
      )
      .bind(
        newId,
        currentVersion.type_id,
        currentVersion.source_entity_id,
        currentVersion.target_entity_id,
        currentVersion.properties,
        newVersion,
        currentVersion.id,
        now,
        userId,
        aclId
      )
      .run();

    // Fetch the restored version
    const restored = await db.prepare('SELECT * FROM links WHERE id = ?').bind(newId).first();

    const result = {
      ...restored,
      properties: restored?.properties ? JSON.parse(restored.properties as string) : {},
      is_deleted: restored?.is_deleted === 1,
      is_latest: restored?.is_latest === 1,
    };

    // Log the restore operation
    try {
      await logLinkOperation(db, c, 'restore', newId, userId, {
        previous_version_id: currentVersion.id,
        type_id: currentVersion.type_id,
        source_entity_id: currentVersion.source_entity_id,
        target_entity_id: currentVersion.target_entity_id,
        version: newVersion,
      });
    } catch (auditError) {
      getLogger(c)
        .child({ module: 'links' })
        .warn('Failed to create audit log', { error: auditError });
    }

    // Invalidate cache for both the original ID and the old version ID
    try {
      await Promise.all([
        invalidateLinkCache(kv, id),
        invalidateLinkCache(kv, currentVersion.id as string),
      ]);
    } catch (cacheError) {
      getLogger(c)
        .child({ module: 'links' })
        .warn('Failed to invalidate cache', { error: cacheError });
    }

    return c.json(response.success(result, 'Link restored successfully'));
  } catch (error) {
    getLogger(c)
      .child({ module: 'links' })
      .error('Error restoring link', error instanceof Error ? error : undefined);
    throw error;
  }
});

/**
 * GET /api/links/:id/versions
 * Get all versions of a link
 */
links.get('/:id/versions', async c => {
  const id = c.req.param('id');
  const db = c.env.DB;

  try {
    // First, find the latest version to ensure the link exists
    const latestVersion = await findLatestVersion(db, id);

    if (!latestVersion) {
      return c.json(response.notFound('Link'), 404);
    }

    // Now get all versions in the chain using recursive CTE
    const { results } = await db
      .prepare(
        `
      WITH RECURSIVE version_chain AS (
        -- Start with version 1 (no previous_version_id)
        SELECT * FROM links
        WHERE id = (
          SELECT id FROM links WHERE id = ?
          UNION
          SELECT l1.id FROM links l1
          WHERE l1.previous_version_id IS NULL
          AND EXISTS (
            WITH RECURSIVE temp_chain AS (
              SELECT id, previous_version_id FROM links WHERE id = ?
              UNION ALL
              SELECT l2.id, l2.previous_version_id
              FROM links l2
              INNER JOIN temp_chain tc ON l2.id = tc.previous_version_id
            )
            SELECT 1 FROM temp_chain WHERE temp_chain.id = l1.id
          )
        )
        UNION ALL
        -- Follow the chain forward
        SELECT l.* FROM links l
        INNER JOIN version_chain vc ON l.previous_version_id = vc.id
      )
      SELECT * FROM version_chain ORDER BY version ASC
    `
      )
      .bind(id, id)
      .all();

    // Parse properties for each version
    const versions = results.map(link => ({
      ...link,
      properties: link.properties ? JSON.parse(link.properties as string) : {},
      is_deleted: link.is_deleted === 1,
      is_latest: link.is_latest === 1,
    }));

    return c.json(response.success(versions));
  } catch (error) {
    getLogger(c)
      .child({ module: 'links' })
      .error('Error fetching link versions', error instanceof Error ? error : undefined);
    throw error;
  }
});

/**
 * GET /api/links/:id/versions/:version
 * Get a specific version of a link
 */
links.get('/:id/versions/:version', async c => {
  const id = c.req.param('id');
  const versionParam = c.req.param('version');
  const db = c.env.DB;

  try {
    // Parse version number
    const versionNumber = parseInt(versionParam, 10);
    if (isNaN(versionNumber) || versionNumber < 1) {
      return c.json(response.error('Invalid version number', 'INVALID_VERSION'), 400);
    }

    // First, find the latest version to ensure the link exists
    const latestVersion = await findLatestVersion(db, id);

    if (!latestVersion) {
      return c.json(response.notFound('Link'), 404);
    }

    // Find the specific version in the chain
    const link = await db
      .prepare(
        `
      WITH RECURSIVE version_chain AS (
        -- Start with version 1
        SELECT * FROM links
        WHERE id = (
          SELECT id FROM links WHERE id = ?
          UNION
          SELECT l1.id FROM links l1
          WHERE l1.previous_version_id IS NULL
          AND EXISTS (
            WITH RECURSIVE temp_chain AS (
              SELECT id, previous_version_id FROM links WHERE id = ?
              UNION ALL
              SELECT l2.id, l2.previous_version_id
              FROM links l2
              INNER JOIN temp_chain tc ON l2.id = tc.previous_version_id
            )
            SELECT 1 FROM temp_chain WHERE temp_chain.id = l1.id
          )
        )
        UNION ALL
        -- Follow the chain forward
        SELECT l.* FROM links l
        INNER JOIN version_chain vc ON l.previous_version_id = vc.id
      )
      SELECT * FROM version_chain WHERE version = ? LIMIT 1
    `
      )
      .bind(id, id, versionNumber)
      .first();

    if (!link) {
      return c.json(response.notFound('Version'), 404);
    }

    const result = {
      ...link,
      properties: link.properties ? JSON.parse(link.properties as string) : {},
      is_deleted: link.is_deleted === 1,
      is_latest: link.is_latest === 1,
    };

    return c.json(response.success(result));
  } catch (error) {
    getLogger(c)
      .child({ module: 'links' })
      .error('Error fetching link version', error instanceof Error ? error : undefined);
    throw error;
  }
});

/**
 * GET /api/links/:id/history
 * Get version history with diffs showing what changed between versions
 */
links.get('/:id/history', async c => {
  const id = c.req.param('id');
  const db = c.env.DB;

  try {
    // First, find the latest version to ensure the link exists
    const latestVersion = await findLatestVersion(db, id);

    if (!latestVersion) {
      return c.json(response.notFound('Link'), 404);
    }

    // Get all versions in order
    const { results } = await db
      .prepare(
        `
      WITH RECURSIVE version_chain AS (
        -- Start with version 1
        SELECT * FROM links
        WHERE id = (
          SELECT id FROM links WHERE id = ?
          UNION
          SELECT l1.id FROM links l1
          WHERE l1.previous_version_id IS NULL
          AND EXISTS (
            WITH RECURSIVE temp_chain AS (
              SELECT id, previous_version_id FROM links WHERE id = ?
              UNION ALL
              SELECT l2.id, l2.previous_version_id
              FROM links l2
              INNER JOIN temp_chain tc ON l2.id = tc.previous_version_id
            )
            SELECT 1 FROM temp_chain WHERE temp_chain.id = l1.id
          )
        )
        UNION ALL
        -- Follow the chain forward
        SELECT l.* FROM links l
        INNER JOIN version_chain vc ON l.previous_version_id = vc.id
      )
      SELECT * FROM version_chain ORDER BY version ASC
    `
      )
      .bind(id, id)
      .all();

    // Calculate diffs between consecutive versions
    const history = results.map((link, index) => {
      const parsedProps = link.properties ? JSON.parse(link.properties as string) : {};

      let diff = null;
      if (index > 0) {
        const prevLink = results[index - 1];
        const prevProps = prevLink.properties ? JSON.parse(prevLink.properties as string) : {};

        diff = calculateDiff(prevProps, parsedProps);
      }

      return {
        id: link.id,
        version: link.version,
        type_id: link.type_id,
        source_entity_id: link.source_entity_id,
        target_entity_id: link.target_entity_id,
        properties: parsedProps,
        created_at: link.created_at,
        created_by: link.created_by,
        is_deleted: link.is_deleted === 1,
        is_latest: link.is_latest === 1,
        diff: diff,
      };
    });

    return c.json(response.success(history));
  } catch (error) {
    getLogger(c)
      .child({ module: 'links' })
      .error('Error fetching link history', error instanceof Error ? error : undefined);
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
 * GET /api/links/:id/acl
 * Get the current ACL (access control list) for a link
 *
 * Returns the list of principals (users and groups) that have read or write
 * permission on this link. If the link has no ACL (null acl_id), it means
 * the link is public and accessible to all authenticated users.
 *
 * Requires authentication and read permission on the link.
 */
links.get('/:id/acl', requireAuth(), async c => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const kv = c.env.KV;
  const user = c.get('user');
  const userId = user.user_id;

  try {
    // First, verify the link exists
    const link = await findLatestVersion(db, id);

    if (!link) {
      return c.json(response.notFound('Link'), 404);
    }

    // Check read permission
    const aclId = link.acl_id as number | null;
    const canRead = await hasPermissionByAclId(db, kv, userId, aclId, 'read');
    if (!canRead) {
      return c.json(response.forbidden('You do not have permission to view this link'), 403);
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
      .child({ module: 'links' })
      .error('Error fetching link ACL', error instanceof Error ? error : undefined);
    throw error;
  }
});

/**
 * PUT /api/links/:id/acl
 * Set the ACL (access control list) for a link
 *
 * This endpoint allows setting permissions for users and groups on a link.
 * - Empty entries array removes the ACL (makes link public)
 * - Setting entries creates/reuses a deduplicated ACL
 * - Creates a new version of the link with the updated ACL
 *
 * Requires authentication and write permission on the link.
 *
 * ACL request format:
 * {
 *   "entries": [
 *     { "principal_type": "user", "principal_id": "uuid", "permission": "write" },
 *     { "principal_type": "group", "principal_id": "uuid", "permission": "read" }
 *   ]
 * }
 */
links.put('/:id/acl', requireAuth(), validateJson(setAclRequestSchema), async c => {
  const id = c.req.param('id');
  const data = c.get('validated_json') as SetAclRequest;
  const db = c.env.DB;
  const kv = c.env.KV;
  const user = c.get('user');
  const userId = user.user_id;

  try {
    // First, verify the link exists
    const link = await findLatestVersion(db, id);

    if (!link) {
      return c.json(response.notFound('Link'), 404);
    }

    // Check write permission
    const currentAclId = link.acl_id as number | null;
    const canWrite = await hasPermissionByAclId(db, kv, userId, currentAclId, 'write');
    if (!canWrite) {
      return c.json(response.forbidden('You do not have permission to modify this link'), 403);
    }

    // Check if link is soft-deleted
    if (link.is_deleted === 1) {
      return c.json(
        response.error(
          'Cannot set ACL on deleted link. Use restore endpoint first.',
          'LINK_DELETED'
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

    // Set the ACL on the link (creates new version)
    await setLinkAcl(db, link.id as string, aclId, userId);

    // Get the updated ACL for response
    let responseEntries: unknown[] = [];
    if (aclId !== null) {
      responseEntries = await getEnrichedAclEntries(db, aclId);
    }

    // Invalidate cache
    try {
      await invalidateLinkCache(kv, id);
      await invalidateLinkCache(kv, link.id as string);
    } catch (cacheError) {
      getLogger(c)
        .child({ module: 'links' })
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
      .child({ module: 'links' })
      .error('Error setting link ACL', error instanceof Error ? error : undefined);
    throw error;
  }
});

export default links;
