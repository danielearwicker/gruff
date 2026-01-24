import { Hono } from 'hono';
import { validateJson, validateQuery } from '../middleware/validation.js';
import { createEntitySchema, updateEntitySchema, entityQuerySchema } from '../schemas/index.js';
import * as response from '../utils/response.js';
import { getLogger } from '../middleware/request-context.js';
import { validatePropertiesAgainstSchema, formatValidationErrors } from '../utils/json-schema.js';

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
    // Check if type_id exists and get its json_schema
    const typeRecord = await db.prepare('SELECT id, json_schema FROM types WHERE id = ?')
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
    getLogger(c).child({ module: 'entities' }).error('Error creating entity', error instanceof Error ? error : undefined);
    throw error;
  }
});

/**
 * GET /api/entities
 * List entities with optional filtering and cursor-based pagination
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
        sql += ' AND json_extract(properties, ?) = ?';
        bindings.push(`$.${propertyKey}`, JSON.stringify(filterValue));
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
      } catch (e) {
        // Invalid cursor format, ignore and continue without cursor
        getLogger(c).child({ module: 'entities' }).warn('Invalid cursor format', { cursor: query.cursor });
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

    // Parse properties for each entity
    const entitiesData = items.map(entity => ({
      ...entity,
      properties: entity.properties ? JSON.parse(entity.properties as string) : {},
      is_deleted: entity.is_deleted === 1,
      is_latest: entity.is_latest === 1,
    }));

    // Generate next cursor from the last item
    let nextCursor: string | null = null;
    if (hasMore && items.length > 0) {
      const lastItem = items[items.length - 1];
      nextCursor = `${lastItem.created_at}:${lastItem.id}`;
    }

    return c.json(response.cursorPaginated(entitiesData, nextCursor, hasMore));
  } catch (error) {
    getLogger(c).child({ module: 'entities' }).error('Error listing entities', error instanceof Error ? error : undefined);
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
    getLogger(c).child({ module: 'entities' }).error('Error fetching entity', error instanceof Error ? error : undefined);
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

    // Fetch the type's JSON schema for validation
    const typeRecord = await db.prepare('SELECT json_schema FROM types WHERE id = ?')
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
    getLogger(c).child({ module: 'entities' }).error('Error updating entity', error instanceof Error ? error : undefined);
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
    getLogger(c).child({ module: 'entities' }).error('Error deleting entity', error instanceof Error ? error : undefined);
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
    getLogger(c).child({ module: 'entities' }).error('Error restoring entity', error instanceof Error ? error : undefined);
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
    getLogger(c).child({ module: 'entities' }).error('Error fetching entity versions', error instanceof Error ? error : undefined);
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
    getLogger(c).child({ module: 'entities' }).error('Error fetching entity version', error instanceof Error ? error : undefined);
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
    getLogger(c).child({ module: 'entities' }).error('Error fetching entity history', error instanceof Error ? error : undefined);
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

/**
 * GET /api/entities/:id/outbound
 * Get all outbound links from an entity
 */
entities.get('/:id/outbound', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;

  // Optional query parameters for filtering
  const typeId = c.req.query('type_id'); // Filter by link type
  const includeDeleted = c.req.query('include_deleted') === 'true';

  try {
    // First, verify the entity exists
    const entity = await findLatestVersion(db, id);

    if (!entity) {
      return c.json(response.notFound('Entity'), 404);
    }

    // Build query to find all outbound links
    let sql = `
      SELECT l.*, e.type_id as target_type_id, e.properties as target_properties
      FROM links l
      INNER JOIN entities e ON l.target_entity_id = e.id
      WHERE l.source_entity_id = ?
      AND l.is_latest = 1
      AND e.is_latest = 1
    `;
    const bindings: any[] = [entity.id];

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

    const { results } = await db.prepare(sql).bind(...bindings).all();

    // Parse properties for each link and target entity
    const linksData = results.map(link => ({
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
      }
    }));

    return c.json(response.success(linksData));
  } catch (error) {
    getLogger(c).child({ module: 'entities' }).error('Error fetching outbound links', error instanceof Error ? error : undefined);
    throw error;
  }
});

/**
 * GET /api/entities/:id/inbound
 * Get all inbound links to an entity
 */
entities.get('/:id/inbound', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;

  // Optional query parameters for filtering
  const typeId = c.req.query('type_id'); // Filter by link type
  const includeDeleted = c.req.query('include_deleted') === 'true';

  try {
    // First, verify the entity exists
    const entity = await findLatestVersion(db, id);

    if (!entity) {
      return c.json(response.notFound('Entity'), 404);
    }

    // Build query to find all inbound links
    let sql = `
      SELECT l.*, e.type_id as source_type_id, e.properties as source_properties
      FROM links l
      INNER JOIN entities e ON l.source_entity_id = e.id
      WHERE l.target_entity_id = ?
      AND l.is_latest = 1
      AND e.is_latest = 1
    `;
    const bindings: any[] = [entity.id];

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

    const { results } = await db.prepare(sql).bind(...bindings).all();

    // Parse properties for each link and source entity
    const linksData = results.map(link => ({
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
      }
    }));

    return c.json(response.success(linksData));
  } catch (error) {
    getLogger(c).child({ module: 'entities' }).error('Error fetching inbound links', error instanceof Error ? error : undefined);
    throw error;
  }
});

/**
 * GET /api/entities/:id/neighbors
 * Get all connected entities (both inbound and outbound)
 */
entities.get('/:id/neighbors', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;

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

    const neighbors: any[] = [];

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
          l.id as link_id,
          l.type_id as link_type_id,
          l.properties as link_properties,
          'outbound' as direction
        FROM links l
        INNER JOIN entities e ON l.target_entity_id = e.id
        WHERE l.source_entity_id = ?
        AND l.is_latest = 1
        AND e.is_latest = 1
      `;
      const outboundBindings: any[] = [entity.id];

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

      const { results: outboundResults } = await db.prepare(outboundSql)
        .bind(...outboundBindings)
        .all();

      neighbors.push(...outboundResults);
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
          l.id as link_id,
          l.type_id as link_type_id,
          l.properties as link_properties,
          'inbound' as direction
        FROM links l
        INNER JOIN entities e ON l.source_entity_id = e.id
        WHERE l.target_entity_id = ?
        AND l.is_latest = 1
        AND e.is_latest = 1
      `;
      const inboundBindings: any[] = [entity.id];

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

      const { results: inboundResults } = await db.prepare(inboundSql)
        .bind(...inboundBindings)
        .all();

      neighbors.push(...inboundResults);
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
          connections: []
        });
      }

      // Add the link information
      uniqueNeighborsMap.get(neighborId).connections.push({
        link_id: neighbor.link_id,
        link_type_id: neighbor.link_type_id,
        link_properties: neighbor.link_properties ? JSON.parse(neighbor.link_properties as string) : {},
        direction: neighbor.direction
      });
    }

    const neighborsData = Array.from(uniqueNeighborsMap.values());

    return c.json(response.success(neighborsData));
  } catch (error) {
    getLogger(c).child({ module: 'entities' }).error('Error fetching neighbors', error instanceof Error ? error : undefined);
    throw error;
  }
});

export default entities;
