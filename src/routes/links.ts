import { Hono } from 'hono';
import { validateJson, validateQuery } from '../middleware/validation.js';
import { createLinkSchema, updateLinkSchema, linkQuerySchema } from '../schemas/index.js';
import * as response from '../utils/response.js';

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
async function findLatestVersion(db: D1Database, linkId: string): Promise<any> {
  // First, try direct match with is_latest
  let link = await db.prepare('SELECT * FROM links WHERE id = ? AND is_latest = 1')
    .bind(linkId)
    .first();

  if (link) {
    return link;
  }

  // If not found, this ID might be an old version. Find all links that reference this ID
  // in their version chain and get the one with is_latest = 1
  const result = await db.prepare(`
    WITH RECURSIVE version_chain AS (
      -- Start with the given ID
      SELECT * FROM links WHERE id = ?
      UNION ALL
      -- Find all links that have this link as previous_version
      SELECT l.* FROM links l
      INNER JOIN version_chain vc ON l.previous_version_id = vc.id
    )
    SELECT * FROM version_chain WHERE is_latest = 1 LIMIT 1
  `).bind(linkId).first();

  return result || null;
}

/**
 * POST /api/links
 * Create a new link
 */
links.post('/', validateJson(createLinkSchema), async (c) => {
  const data = c.get('validated_json') as any;
  const db = c.env.DB;

  const id = generateUUID();
  const now = getCurrentTimestamp();

  // For now, we'll use the test user ID from seed data. In the future, this will come from auth middleware
  const systemUserId = 'test-user-001';

  try {
    // Check if type_id exists
    const typeExists = await db.prepare('SELECT id FROM types WHERE id = ? AND category = ?')
      .bind(data.type_id, 'link')
      .first();

    if (!typeExists) {
      return c.json(response.error('Link type not found', 'TYPE_NOT_FOUND'), 404);
    }

    // Check if source entity exists and is not deleted
    const sourceEntity = await db.prepare('SELECT id FROM entities WHERE id = ? AND is_latest = 1 AND is_deleted = 0')
      .bind(data.source_entity_id)
      .first();

    if (!sourceEntity) {
      return c.json(response.error('Source entity not found or is deleted', 'SOURCE_ENTITY_NOT_FOUND'), 404);
    }

    // Check if target entity exists and is not deleted
    const targetEntity = await db.prepare('SELECT id FROM entities WHERE id = ? AND is_latest = 1 AND is_deleted = 0')
      .bind(data.target_entity_id)
      .first();

    if (!targetEntity) {
      return c.json(response.error('Target entity not found or is deleted', 'TARGET_ENTITY_NOT_FOUND'), 404);
    }

    // Convert properties to string
    const propertiesString = JSON.stringify(data.properties);

    // Insert the new link (version 1)
    await db.prepare(`
      INSERT INTO links (id, type_id, source_entity_id, target_entity_id, properties, version, previous_version_id, created_at, created_by, is_deleted, is_latest)
      VALUES (?, ?, ?, ?, ?, 1, NULL, ?, ?, 0, 1)
    `).bind(
      id,
      data.type_id,
      data.source_entity_id,
      data.target_entity_id,
      propertiesString,
      now,
      systemUserId
    ).run();

    // Fetch the created link
    const created = await db.prepare('SELECT * FROM links WHERE id = ?')
      .bind(id)
      .first();

    // Parse properties back to object
    const result = {
      ...created,
      properties: created?.properties ? JSON.parse(created.properties as string) : {},
      is_deleted: created?.is_deleted === 1,
      is_latest: created?.is_latest === 1,
    };

    return c.json(response.created(result), 201);
  } catch (error) {
    console.error('[Links] Error creating link:', error);
    throw error;
  }
});

/**
 * GET /api/links
 * List links with optional filtering and cursor-based pagination
 */
links.get('/', validateQuery(linkQuerySchema), async (c) => {
  const query = c.get('validated_query') as any;
  const db = c.env.DB;

  try {
    let sql = 'SELECT * FROM links WHERE is_latest = 1';
    const bindings: any[] = [];

    // Apply filters
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
        console.warn('[Links] Invalid cursor format:', query.cursor);
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

    // Parse properties for each link
    const linksData = items.map(link => ({
      ...link,
      properties: link.properties ? JSON.parse(link.properties as string) : {},
      is_deleted: link.is_deleted === 1,
      is_latest: link.is_latest === 1,
    }));

    // Generate next cursor from the last item
    let nextCursor: string | null = null;
    if (hasMore && items.length > 0) {
      const lastItem = items[items.length - 1];
      nextCursor = `${lastItem.created_at}:${lastItem.id}`;
    }

    return c.json(response.cursorPaginated(linksData, nextCursor, hasMore));
  } catch (error) {
    console.error('[Links] Error listing links:', error);
    throw error;
  }
});

/**
 * GET /api/links/:id
 * Get the latest version of a specific link
 */
links.get('/:id', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;

  try {
    const link = await findLatestVersion(db, id);

    if (!link) {
      return c.json(response.notFound('Link'), 404);
    }

    // Parse properties back to object
    const result = {
      ...link,
      properties: link.properties ? JSON.parse(link.properties as string) : {},
      is_deleted: link.is_deleted === 1,
      is_latest: link.is_latest === 1,
    };

    return c.json(response.success(result));
  } catch (error) {
    console.error('[Links] Error fetching link:', error);
    throw error;
  }
});

/**
 * PUT /api/links/:id
 * Update link (creates new version)
 */
links.put('/:id', validateJson(updateLinkSchema), async (c) => {
  const id = c.req.param('id');
  const data = c.get('validated_json') as any;
  const db = c.env.DB;
  const now = getCurrentTimestamp();
  const systemUserId = 'test-user-001';

  try {
    // Get the current latest version
    const currentVersion = await findLatestVersion(db, id);

    if (!currentVersion) {
      return c.json(response.notFound('Link'), 404);
    }

    // Check if link is soft-deleted
    if (currentVersion.is_deleted === 1) {
      return c.json(
        response.error('Cannot update deleted link. Use restore endpoint first.', 'LINK_DELETED'),
        409
      );
    }

    const newVersion = (currentVersion.version as number) + 1;
    const propertiesString = JSON.stringify(data.properties);
    const newId = generateUUID(); // Generate NEW id for the new version

    // Start a transaction-like operation by updating in order
    // First, set current version's is_latest to false
    await db.prepare('UPDATE links SET is_latest = 0 WHERE id = ?')
      .bind(currentVersion.id)
      .run();

    // Then insert new version with new ID
    await db.prepare(`
      INSERT INTO links (id, type_id, source_entity_id, target_entity_id, properties, version, previous_version_id, created_at, created_by, is_deleted, is_latest)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1)
    `).bind(
      newId,
      currentVersion.type_id,
      currentVersion.source_entity_id,
      currentVersion.target_entity_id,
      propertiesString,
      newVersion,
      currentVersion.id, // previous_version_id references the previous row's id
      now,
      systemUserId
    ).run();

    // Fetch the new version
    const updated = await db.prepare('SELECT * FROM links WHERE id = ?')
      .bind(newId)
      .first();

    const result = {
      ...updated,
      properties: updated?.properties ? JSON.parse(updated.properties as string) : {},
      is_deleted: updated?.is_deleted === 1,
      is_latest: updated?.is_latest === 1,
    };

    return c.json(response.updated(result));
  } catch (error) {
    console.error('[Links] Error updating link:', error);
    throw error;
  }
});

/**
 * DELETE /api/links/:id
 * Soft delete link (creates new version with is_deleted = true)
 */
links.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const now = getCurrentTimestamp();
  const systemUserId = 'test-user-001';

  try {
    // Get the current latest version
    const currentVersion = await findLatestVersion(db, id);

    if (!currentVersion) {
      return c.json(response.notFound('Link'), 404);
    }

    // Check if already soft-deleted
    if (currentVersion.is_deleted === 1) {
      return c.json(
        response.error('Link is already deleted', 'ALREADY_DELETED'),
        409
      );
    }

    const newVersion = (currentVersion.version as number) + 1;
    const newId = generateUUID();

    // Set current version's is_latest to false
    await db.prepare('UPDATE links SET is_latest = 0 WHERE id = ?')
      .bind(currentVersion.id)
      .run();

    // Insert new version with is_deleted = 1 and new ID
    await db.prepare(`
      INSERT INTO links (id, type_id, source_entity_id, target_entity_id, properties, version, previous_version_id, created_at, created_by, is_deleted, is_latest)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)
    `).bind(
      newId,
      currentVersion.type_id,
      currentVersion.source_entity_id,
      currentVersion.target_entity_id,
      currentVersion.properties,
      newVersion,
      currentVersion.id,
      now,
      systemUserId
    ).run();

    return c.json(response.deleted());
  } catch (error) {
    console.error('[Links] Error deleting link:', error);
    throw error;
  }
});

/**
 * POST /api/links/:id/restore
 * Restore a soft-deleted link (creates new version with is_deleted = false)
 */
links.post('/:id/restore', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const now = getCurrentTimestamp();
  const systemUserId = 'test-user-001';

  try {
    // Get the current latest version
    const currentVersion = await findLatestVersion(db, id);

    if (!currentVersion) {
      return c.json(response.notFound('Link'), 404);
    }

    // Check if link is not deleted
    if (currentVersion.is_deleted === 0) {
      return c.json(
        response.error('Link is not deleted', 'NOT_DELETED'),
        409
      );
    }

    const newVersion = (currentVersion.version as number) + 1;
    const newId = generateUUID();

    // Set current version's is_latest to false
    await db.prepare('UPDATE links SET is_latest = 0 WHERE id = ?')
      .bind(currentVersion.id)
      .run();

    // Insert new version with is_deleted = 0 and new ID
    await db.prepare(`
      INSERT INTO links (id, type_id, source_entity_id, target_entity_id, properties, version, previous_version_id, created_at, created_by, is_deleted, is_latest)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1)
    `).bind(
      newId,
      currentVersion.type_id,
      currentVersion.source_entity_id,
      currentVersion.target_entity_id,
      currentVersion.properties,
      newVersion,
      currentVersion.id,
      now,
      systemUserId
    ).run();

    // Fetch the restored version
    const restored = await db.prepare('SELECT * FROM links WHERE id = ?')
      .bind(newId)
      .first();

    const result = {
      ...restored,
      properties: restored?.properties ? JSON.parse(restored.properties as string) : {},
      is_deleted: restored?.is_deleted === 1,
      is_latest: restored?.is_latest === 1,
    };

    return c.json(response.success(result, 'Link restored successfully'));
  } catch (error) {
    console.error('[Links] Error restoring link:', error);
    throw error;
  }
});

/**
 * GET /api/links/:id/versions
 * Get all versions of a link
 */
links.get('/:id/versions', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;

  try {
    // First, find the latest version to ensure the link exists
    const latestVersion = await findLatestVersion(db, id);

    if (!latestVersion) {
      return c.json(response.notFound('Link'), 404);
    }

    // Now get all versions in the chain using recursive CTE
    const { results } = await db.prepare(`
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
    `).bind(id, id).all();

    // Parse properties for each version
    const versions = results.map(link => ({
      ...link,
      properties: link.properties ? JSON.parse(link.properties as string) : {},
      is_deleted: link.is_deleted === 1,
      is_latest: link.is_latest === 1,
    }));

    return c.json(response.success(versions));
  } catch (error) {
    console.error('[Links] Error fetching link versions:', error);
    throw error;
  }
});

/**
 * GET /api/links/:id/versions/:version
 * Get a specific version of a link
 */
links.get('/:id/versions/:version', async (c) => {
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
    const link = await db.prepare(`
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
    `).bind(id, id, versionNumber).first();

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
    console.error('[Links] Error fetching link version:', error);
    throw error;
  }
});

/**
 * GET /api/links/:id/history
 * Get version history with diffs showing what changed between versions
 */
links.get('/:id/history', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;

  try {
    // First, find the latest version to ensure the link exists
    const latestVersion = await findLatestVersion(db, id);

    if (!latestVersion) {
      return c.json(response.notFound('Link'), 404);
    }

    // Get all versions in order
    const { results } = await db.prepare(`
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
    `).bind(id, id).all();

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
    console.error('[Links] Error fetching link history:', error);
    throw error;
  }
});

/**
 * Helper function to calculate differences between two JSON objects
 */
function calculateDiff(oldObj: any, newObj: any): any {
  const diff: any = {
    added: {} as any,
    removed: {} as any,
    changed: {} as any,
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

export default links;
