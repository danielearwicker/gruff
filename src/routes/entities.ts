import { Hono } from 'hono';
import { validateJson, validateQuery } from '../middleware/validation.js';
import { createEntitySchema, updateEntitySchema, entityQuerySchema } from '../schemas/index.js';
import * as response from '../utils/response.js';

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
async function findLatestVersion(db: D1Database, entityId: string): Promise<any> {
  // First, try direct match with is_latest
  let entity = await db.prepare('SELECT * FROM entities WHERE id = ? AND is_latest = 1')
    .bind(entityId)
    .first();

  if (entity) {
    return entity;
  }

  // If not found, this ID might be an old version. Find all entities that reference this ID
  // in their version chain and get the one with is_latest = 1
  const result = await db.prepare(`
    WITH RECURSIVE version_chain AS (
      -- Start with the given ID
      SELECT * FROM entities WHERE id = ?
      UNION ALL
      -- Find all entities that have this entity as previous_version
      SELECT e.* FROM entities e
      INNER JOIN version_chain vc ON e.previous_version_id = vc.id
    )
    SELECT * FROM version_chain WHERE is_latest = 1 LIMIT 1
  `).bind(entityId).first();

  return result || null;
}

/**
 * POST /api/entities
 * Create a new entity
 */
entities.post('/', validateJson(createEntitySchema), async (c) => {
  const data = c.get('validated_json') as any;
  const db = c.env.DB;

  const id = generateUUID();
  const now = getCurrentTimestamp();

  // For now, we'll use the test user ID from seed data. In the future, this will come from auth middleware
  const systemUserId = 'test-user-001';

  try {
    // Check if type_id exists
    const typeExists = await db.prepare('SELECT id FROM types WHERE id = ?')
      .bind(data.type_id)
      .first();

    if (!typeExists) {
      return c.json(response.error('Type not found', 'TYPE_NOT_FOUND'), 404);
    }

    // Convert properties to string
    const propertiesString = JSON.stringify(data.properties);

    // Insert the new entity (version 1)
    await db.prepare(`
      INSERT INTO entities (id, type_id, properties, version, previous_version_id, created_at, created_by, is_deleted, is_latest)
      VALUES (?, ?, ?, 1, NULL, ?, ?, 0, 1)
    `).bind(
      id,
      data.type_id,
      propertiesString,
      now,
      systemUserId
    ).run();

    // Fetch the created entity
    const created = await db.prepare('SELECT * FROM entities WHERE id = ?')
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
    console.error('[Entities] Error creating entity:', error);
    throw error;
  }
});

/**
 * GET /api/entities
 * List entities with optional filtering
 */
entities.get('/', validateQuery(entityQuerySchema), async (c) => {
  const query = c.get('validated_query') as any;
  const db = c.env.DB;

  try {
    let sql = 'SELECT * FROM entities WHERE is_latest = 1';
    const bindings: any[] = [];

    // Apply filters
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

    sql += ' ORDER BY created_at DESC';

    const { results } = await db.prepare(sql).bind(...bindings).all();

    // Parse properties for each entity
    const entitiesData = results.map(entity => ({
      ...entity,
      properties: entity.properties ? JSON.parse(entity.properties as string) : {},
      is_deleted: entity.is_deleted === 1,
      is_latest: entity.is_latest === 1,
    }));

    return c.json(response.success(entitiesData));
  } catch (error) {
    console.error('[Entities] Error listing entities:', error);
    throw error;
  }
});

/**
 * GET /api/entities/:id
 * Get the latest version of a specific entity
 */
entities.get('/:id', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;

  try {
    const entity = await findLatestVersion(db, id);

    if (!entity) {
      return c.json(response.notFound('Entity'), 404);
    }

    // Parse properties back to object
    const result = {
      ...entity,
      properties: entity.properties ? JSON.parse(entity.properties as string) : {},
      is_deleted: entity.is_deleted === 1,
      is_latest: entity.is_latest === 1,
    };

    return c.json(response.success(result));
  } catch (error) {
    console.error('[Entities] Error fetching entity:', error);
    throw error;
  }
});

/**
 * PUT /api/entities/:id
 * Update entity (creates new version)
 */
entities.put('/:id', validateJson(updateEntitySchema), async (c) => {
  const id = c.req.param('id');
  const data = c.get('validated_json') as any;
  const db = c.env.DB;
  const now = getCurrentTimestamp();
  const systemUserId = 'test-user-001';

  try {
    // Get the current latest version
    const currentVersion = await findLatestVersion(db, id);

    if (!currentVersion) {
      return c.json(response.notFound('Entity'), 404);
    }

    // Check if entity is soft-deleted
    if (currentVersion.is_deleted === 1) {
      return c.json(
        response.error('Cannot update deleted entity. Use restore endpoint first.', 'ENTITY_DELETED'),
        409
      );
    }

    const newVersion = (currentVersion.version as number) + 1;
    const propertiesString = JSON.stringify(data.properties);
    const newId = generateUUID(); // Generate NEW id for the new version

    // Start a transaction-like operation by updating in order
    // First, set current version's is_latest to false
    await db.prepare('UPDATE entities SET is_latest = 0 WHERE id = ?')
      .bind(currentVersion.id)
      .run();

    // Then insert new version with new ID
    await db.prepare(`
      INSERT INTO entities (id, type_id, properties, version, previous_version_id, created_at, created_by, is_deleted, is_latest)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1)
    `).bind(
      newId,
      currentVersion.type_id,
      propertiesString,
      newVersion,
      currentVersion.id, // previous_version_id references the previous row's id
      now,
      systemUserId
    ).run();

    // Fetch the new version
    const updated = await db.prepare('SELECT * FROM entities WHERE id = ?')
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
    console.error('[Entities] Error updating entity:', error);
    throw error;
  }
});

/**
 * DELETE /api/entities/:id
 * Soft delete entity (creates new version with is_deleted = true)
 */
entities.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const now = getCurrentTimestamp();
  const systemUserId = 'test-user-001';

  try {
    // Get the current latest version
    const currentVersion = await findLatestVersion(db, id);

    if (!currentVersion) {
      return c.json(response.notFound('Entity'), 404);
    }

    // Check if already soft-deleted
    if (currentVersion.is_deleted === 1) {
      return c.json(
        response.error('Entity is already deleted', 'ALREADY_DELETED'),
        409
      );
    }

    const newVersion = (currentVersion.version as number) + 1;
    const newId = generateUUID();

    // Set current version's is_latest to false
    await db.prepare('UPDATE entities SET is_latest = 0 WHERE id = ?')
      .bind(currentVersion.id)
      .run();

    // Insert new version with is_deleted = 1 and new ID
    await db.prepare(`
      INSERT INTO entities (id, type_id, properties, version, previous_version_id, created_at, created_by, is_deleted, is_latest)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)
    `).bind(
      newId,
      currentVersion.type_id,
      currentVersion.properties,
      newVersion,
      currentVersion.id,
      now,
      systemUserId
    ).run();

    return c.json(response.deleted());
  } catch (error) {
    console.error('[Entities] Error deleting entity:', error);
    throw error;
  }
});

/**
 * POST /api/entities/:id/restore
 * Restore a soft-deleted entity (creates new version with is_deleted = false)
 */
entities.post('/:id/restore', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const now = getCurrentTimestamp();
  const systemUserId = 'test-user-001';

  try {
    // Get the current latest version
    const currentVersion = await findLatestVersion(db, id);

    if (!currentVersion) {
      return c.json(response.notFound('Entity'), 404);
    }

    // Check if entity is not deleted
    if (currentVersion.is_deleted === 0) {
      return c.json(
        response.error('Entity is not deleted', 'NOT_DELETED'),
        409
      );
    }

    const newVersion = (currentVersion.version as number) + 1;
    const newId = generateUUID();

    // Set current version's is_latest to false
    await db.prepare('UPDATE entities SET is_latest = 0 WHERE id = ?')
      .bind(currentVersion.id)
      .run();

    // Insert new version with is_deleted = 0 and new ID
    await db.prepare(`
      INSERT INTO entities (id, type_id, properties, version, previous_version_id, created_at, created_by, is_deleted, is_latest)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1)
    `).bind(
      newId,
      currentVersion.type_id,
      currentVersion.properties,
      newVersion,
      currentVersion.id,
      now,
      systemUserId
    ).run();

    // Fetch the restored version
    const restored = await db.prepare('SELECT * FROM entities WHERE id = ?')
      .bind(newId)
      .first();

    const result = {
      ...restored,
      properties: restored?.properties ? JSON.parse(restored.properties as string) : {},
      is_deleted: restored?.is_deleted === 1,
      is_latest: restored?.is_latest === 1,
    };

    return c.json(response.success(result, 'Entity restored successfully'));
  } catch (error) {
    console.error('[Entities] Error restoring entity:', error);
    throw error;
  }
});

/**
 * GET /api/entities/:id/versions
 * Get all versions of an entity
 */
entities.get('/:id/versions', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;

  try {
    // First, find the latest version to ensure the entity exists
    const latestVersion = await findLatestVersion(db, id);

    if (!latestVersion) {
      return c.json(response.notFound('Entity'), 404);
    }

    // Now get all versions in the chain using recursive CTE
    const { results } = await db.prepare(`
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
    `).bind(id, id).all();

    // Parse properties for each version
    const versions = results.map(entity => ({
      ...entity,
      properties: entity.properties ? JSON.parse(entity.properties as string) : {},
      is_deleted: entity.is_deleted === 1,
      is_latest: entity.is_latest === 1,
    }));

    return c.json(response.success(versions));
  } catch (error) {
    console.error('[Entities] Error fetching entity versions:', error);
    throw error;
  }
});

/**
 * GET /api/entities/:id/versions/:version
 * Get a specific version of an entity
 */
entities.get('/:id/versions/:version', async (c) => {
  const id = c.req.param('id');
  const versionParam = c.req.param('version');
  const db = c.env.DB;

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

    // Find the specific version in the chain
    const entity = await db.prepare(`
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
    `).bind(id, id, versionNumber).first();

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
    console.error('[Entities] Error fetching entity version:', error);
    throw error;
  }
});

/**
 * GET /api/entities/:id/history
 * Get version history with diffs showing what changed between versions
 */
entities.get('/:id/history', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;

  try {
    // First, find the latest version to ensure the entity exists
    const latestVersion = await findLatestVersion(db, id);

    if (!latestVersion) {
      return c.json(response.notFound('Entity'), 404);
    }

    // Get all versions in order
    const { results } = await db.prepare(`
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
    `).bind(id, id).all();

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
    console.error('[Entities] Error fetching entity history:', error);
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

export default entities;
