import { Hono } from 'hono';
import { validateJson } from '../middleware/validation.js';
import {
  bulkCreateEntitiesSchema,
  bulkCreateLinksSchema,
  bulkUpdateEntitiesSchema,
  bulkUpdateLinksSchema,
  type BulkCreateResultItem,
  type BulkUpdateResultItem,
} from '../schemas/index.js';
import * as response from '../utils/response.js';
import { getLogger } from '../middleware/request-context.js';

type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  ENVIRONMENT: string;
};

const bulk = new Hono<{ Bindings: Bindings }>();

// Helper function to generate UUID
function generateUUID(): string {
  return crypto.randomUUID();
}

// Helper function to get current timestamp
function getCurrentTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}

// Helper function to find the latest version of an entity by any ID in its version chain
async function findLatestEntityVersion(db: D1Database, entityId: string): Promise<any> {
  let entity = await db.prepare('SELECT * FROM entities WHERE id = ? AND is_latest = 1')
    .bind(entityId)
    .first();

  if (entity) {
    return entity;
  }

  const result = await db.prepare(`
    WITH RECURSIVE version_chain AS (
      SELECT * FROM entities WHERE id = ?
      UNION ALL
      SELECT e.* FROM entities e
      INNER JOIN version_chain vc ON e.previous_version_id = vc.id
    )
    SELECT * FROM version_chain WHERE is_latest = 1 LIMIT 1
  `).bind(entityId).first();

  return result || null;
}

// Helper function to find the latest version of a link by any ID in its version chain
async function findLatestLinkVersion(db: D1Database, linkId: string): Promise<any> {
  let link = await db.prepare('SELECT * FROM links WHERE id = ? AND is_latest = 1')
    .bind(linkId)
    .first();

  if (link) {
    return link;
  }

  const result = await db.prepare(`
    WITH RECURSIVE version_chain AS (
      SELECT * FROM links WHERE id = ?
      UNION ALL
      SELECT l.* FROM links l
      INNER JOIN version_chain vc ON l.previous_version_id = vc.id
    )
    SELECT * FROM version_chain WHERE is_latest = 1 LIMIT 1
  `).bind(linkId).first();

  return result || null;
}

/**
 * POST /api/bulk/entities
 * Batch create multiple entities in a single request
 * Uses D1 batch operations for consistency
 */
bulk.post('/entities', validateJson(bulkCreateEntitiesSchema), async (c) => {
  const data = c.get('validated_json') as { entities: Array<{ type_id: string; properties: Record<string, unknown>; client_id?: string }> };
  const db = c.env.DB;
  const logger = getLogger(c).child({ module: 'bulk' });
  const now = getCurrentTimestamp();
  const systemUserId = 'test-user-001';

  const results: BulkCreateResultItem[] = [];
  const statements: D1PreparedStatement[] = [];
  const entityData: Array<{ id: string; index: number; client_id?: string }> = [];

  try {
    // First, validate all type_ids exist
    const typeIds = [...new Set(data.entities.map(e => e.type_id))];
    const typeCheckPlaceholders = typeIds.map(() => '?').join(',');
    const { results: existingTypes } = await db.prepare(
      `SELECT id FROM types WHERE id IN (${typeCheckPlaceholders}) AND category = 'entity'`
    ).bind(...typeIds).all();
    const validTypeIds = new Set(existingTypes.map((t: any) => t.id));

    // Process each entity
    for (let i = 0; i < data.entities.length; i++) {
      const entity = data.entities[i];

      // Check if type exists
      if (!validTypeIds.has(entity.type_id)) {
        results.push({
          index: i,
          success: false,
          client_id: entity.client_id,
          error: 'Type not found',
          code: 'TYPE_NOT_FOUND',
        });
        continue;
      }

      const id = generateUUID();
      const propertiesString = JSON.stringify(entity.properties);

      statements.push(
        db.prepare(`
          INSERT INTO entities (id, type_id, properties, version, previous_version_id, created_at, created_by, is_deleted, is_latest)
          VALUES (?, ?, ?, 1, NULL, ?, ?, 0, 1)
        `).bind(id, entity.type_id, propertiesString, now, systemUserId)
      );

      entityData.push({ id, index: i, client_id: entity.client_id });
    }

    // Execute batch if we have any valid entities
    if (statements.length > 0) {
      const batchResults = await db.batch(statements);

      // Process batch results
      for (let j = 0; j < batchResults.length; j++) {
        const batchResult = batchResults[j];
        const entityInfo = entityData[j];

        if (batchResult.success) {
          results.push({
            index: entityInfo.index,
            success: true,
            id: entityInfo.id,
            client_id: entityInfo.client_id,
          });
        } else {
          results.push({
            index: entityInfo.index,
            success: false,
            client_id: entityInfo.client_id,
            error: 'Failed to create entity',
            code: 'CREATE_FAILED',
          });
        }
      }
    }

    // Sort results by index
    results.sort((a, b) => a.index - b.index);

    const successCount = results.filter(r => r.success).length;
    const failureCount = results.filter(r => !r.success).length;

    logger.info('Bulk create entities completed', { successCount, failureCount, total: data.entities.length });

    return c.json(response.success({
      results,
      summary: {
        total: data.entities.length,
        successful: successCount,
        failed: failureCount,
      },
    }, 'Bulk entity creation completed'), 201);
  } catch (error) {
    logger.error('Error in bulk create entities', error instanceof Error ? error : undefined);
    throw error;
  }
});

/**
 * POST /api/bulk/links
 * Batch create multiple links in a single request
 * Uses D1 batch operations for consistency
 */
bulk.post('/links', validateJson(bulkCreateLinksSchema), async (c) => {
  const data = c.get('validated_json') as { links: Array<{ type_id: string; source_entity_id: string; target_entity_id: string; properties: Record<string, unknown>; client_id?: string }> };
  const db = c.env.DB;
  const logger = getLogger(c).child({ module: 'bulk' });
  const now = getCurrentTimestamp();
  const systemUserId = 'test-user-001';

  const results: BulkCreateResultItem[] = [];
  const statements: D1PreparedStatement[] = [];
  const linkData: Array<{ id: string; index: number; client_id?: string }> = [];

  try {
    // Validate all type_ids exist
    const typeIds = [...new Set(data.links.map(l => l.type_id))];
    const typeCheckPlaceholders = typeIds.map(() => '?').join(',');
    const { results: existingTypes } = await db.prepare(
      `SELECT id FROM types WHERE id IN (${typeCheckPlaceholders}) AND category = 'link'`
    ).bind(...typeIds).all();
    const validTypeIds = new Set(existingTypes.map((t: any) => t.id));

    // Validate all source and target entities exist
    const allEntityIds = [...new Set([
      ...data.links.map(l => l.source_entity_id),
      ...data.links.map(l => l.target_entity_id),
    ])];
    const entityCheckPlaceholders = allEntityIds.map(() => '?').join(',');
    const { results: existingEntities } = await db.prepare(
      `SELECT id FROM entities WHERE id IN (${entityCheckPlaceholders}) AND is_latest = 1 AND is_deleted = 0`
    ).bind(...allEntityIds).all();
    const validEntityIds = new Set(existingEntities.map((e: any) => e.id));

    // Process each link
    for (let i = 0; i < data.links.length; i++) {
      const link = data.links[i];

      // Check if type exists
      if (!validTypeIds.has(link.type_id)) {
        results.push({
          index: i,
          success: false,
          client_id: link.client_id,
          error: 'Link type not found',
          code: 'TYPE_NOT_FOUND',
        });
        continue;
      }

      // Check if source entity exists
      if (!validEntityIds.has(link.source_entity_id)) {
        results.push({
          index: i,
          success: false,
          client_id: link.client_id,
          error: 'Source entity not found or is deleted',
          code: 'SOURCE_ENTITY_NOT_FOUND',
        });
        continue;
      }

      // Check if target entity exists
      if (!validEntityIds.has(link.target_entity_id)) {
        results.push({
          index: i,
          success: false,
          client_id: link.client_id,
          error: 'Target entity not found or is deleted',
          code: 'TARGET_ENTITY_NOT_FOUND',
        });
        continue;
      }

      const id = generateUUID();
      const propertiesString = JSON.stringify(link.properties);

      statements.push(
        db.prepare(`
          INSERT INTO links (id, type_id, source_entity_id, target_entity_id, properties, version, previous_version_id, created_at, created_by, is_deleted, is_latest)
          VALUES (?, ?, ?, ?, ?, 1, NULL, ?, ?, 0, 1)
        `).bind(id, link.type_id, link.source_entity_id, link.target_entity_id, propertiesString, now, systemUserId)
      );

      linkData.push({ id, index: i, client_id: link.client_id });
    }

    // Execute batch if we have any valid links
    if (statements.length > 0) {
      const batchResults = await db.batch(statements);

      // Process batch results
      for (let j = 0; j < batchResults.length; j++) {
        const batchResult = batchResults[j];
        const linkInfo = linkData[j];

        if (batchResult.success) {
          results.push({
            index: linkInfo.index,
            success: true,
            id: linkInfo.id,
            client_id: linkInfo.client_id,
          });
        } else {
          results.push({
            index: linkInfo.index,
            success: false,
            client_id: linkInfo.client_id,
            error: 'Failed to create link',
            code: 'CREATE_FAILED',
          });
        }
      }
    }

    // Sort results by index
    results.sort((a, b) => a.index - b.index);

    const successCount = results.filter(r => r.success).length;
    const failureCount = results.filter(r => !r.success).length;

    logger.info('Bulk create links completed', { successCount, failureCount, total: data.links.length });

    return c.json(response.success({
      results,
      summary: {
        total: data.links.length,
        successful: successCount,
        failed: failureCount,
      },
    }, 'Bulk link creation completed'), 201);
  } catch (error) {
    logger.error('Error in bulk create links', error instanceof Error ? error : undefined);
    throw error;
  }
});

/**
 * PUT /api/bulk/entities
 * Batch update multiple entities in a single request
 * Creates new versions for each updated entity using D1 batch operations
 */
bulk.put('/entities', validateJson(bulkUpdateEntitiesSchema), async (c) => {
  const data = c.get('validated_json') as { entities: Array<{ id: string; properties: Record<string, unknown> }> };
  const db = c.env.DB;
  const logger = getLogger(c).child({ module: 'bulk' });
  const now = getCurrentTimestamp();
  const systemUserId = 'test-user-001';

  const results: BulkUpdateResultItem[] = [];
  const statements: D1PreparedStatement[] = [];
  const updateData: Array<{ originalId: string; newId: string; newVersion: number; index: number }> = [];

  try {
    // First, fetch all current versions
    const currentVersions: Map<string, any> = new Map();
    for (let i = 0; i < data.entities.length; i++) {
      const entity = data.entities[i];
      const currentVersion = await findLatestEntityVersion(db, entity.id);

      if (!currentVersion) {
        results.push({
          index: i,
          success: false,
          id: entity.id,
          error: 'Entity not found',
          code: 'NOT_FOUND',
        });
        continue;
      }

      if (currentVersion.is_deleted === 1) {
        results.push({
          index: i,
          success: false,
          id: entity.id,
          error: 'Cannot update deleted entity. Use restore endpoint first.',
          code: 'ENTITY_DELETED',
        });
        continue;
      }

      currentVersions.set(entity.id, { currentVersion, index: i });
    }

    // Create update statements for valid entities
    for (const [entityId, { currentVersion, index }] of currentVersions) {
      const entity = data.entities.find(e => e.id === entityId)!;
      const newVersion = (currentVersion.version as number) + 1;
      const propertiesString = JSON.stringify(entity.properties);
      const newId = generateUUID();

      // Two operations per entity: set old as not latest, insert new version
      statements.push(
        db.prepare('UPDATE entities SET is_latest = 0 WHERE id = ?').bind(currentVersion.id)
      );
      statements.push(
        db.prepare(`
          INSERT INTO entities (id, type_id, properties, version, previous_version_id, created_at, created_by, is_deleted, is_latest)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1)
        `).bind(newId, currentVersion.type_id, propertiesString, newVersion, currentVersion.id, now, systemUserId)
      );

      updateData.push({ originalId: entityId, newId, newVersion, index });
    }

    // Execute batch if we have any valid updates
    if (statements.length > 0) {
      const batchResults = await db.batch(statements);

      // Process batch results (every 2 statements = 1 entity update)
      for (let j = 0; j < updateData.length; j++) {
        const updateInfo = updateData[j];
        const updateIndex = j * 2;
        const insertIndex = j * 2 + 1;

        const updateResult = batchResults[updateIndex];
        const insertResult = batchResults[insertIndex];

        if (updateResult.success && insertResult.success) {
          results.push({
            index: updateInfo.index,
            success: true,
            id: updateInfo.newId,
            version: updateInfo.newVersion,
          });
        } else {
          results.push({
            index: updateInfo.index,
            success: false,
            id: updateInfo.originalId,
            error: 'Failed to update entity',
            code: 'UPDATE_FAILED',
          });
        }
      }
    }

    // Sort results by index
    results.sort((a, b) => a.index - b.index);

    const successCount = results.filter(r => r.success).length;
    const failureCount = results.filter(r => !r.success).length;

    logger.info('Bulk update entities completed', { successCount, failureCount, total: data.entities.length });

    return c.json(response.success({
      results,
      summary: {
        total: data.entities.length,
        successful: successCount,
        failed: failureCount,
      },
    }, 'Bulk entity update completed'));
  } catch (error) {
    logger.error('Error in bulk update entities', error instanceof Error ? error : undefined);
    throw error;
  }
});

/**
 * PUT /api/bulk/links
 * Batch update multiple links in a single request
 * Creates new versions for each updated link using D1 batch operations
 */
bulk.put('/links', validateJson(bulkUpdateLinksSchema), async (c) => {
  const data = c.get('validated_json') as { links: Array<{ id: string; properties: Record<string, unknown> }> };
  const db = c.env.DB;
  const logger = getLogger(c).child({ module: 'bulk' });
  const now = getCurrentTimestamp();
  const systemUserId = 'test-user-001';

  const results: BulkUpdateResultItem[] = [];
  const statements: D1PreparedStatement[] = [];
  const updateData: Array<{ originalId: string; newId: string; newVersion: number; index: number }> = [];

  try {
    // First, fetch all current versions
    const currentVersions: Map<string, any> = new Map();
    for (let i = 0; i < data.links.length; i++) {
      const link = data.links[i];
      const currentVersion = await findLatestLinkVersion(db, link.id);

      if (!currentVersion) {
        results.push({
          index: i,
          success: false,
          id: link.id,
          error: 'Link not found',
          code: 'NOT_FOUND',
        });
        continue;
      }

      if (currentVersion.is_deleted === 1) {
        results.push({
          index: i,
          success: false,
          id: link.id,
          error: 'Cannot update deleted link. Use restore endpoint first.',
          code: 'LINK_DELETED',
        });
        continue;
      }

      currentVersions.set(link.id, { currentVersion, index: i });
    }

    // Create update statements for valid links
    for (const [linkId, { currentVersion, index }] of currentVersions) {
      const link = data.links.find(l => l.id === linkId)!;
      const newVersion = (currentVersion.version as number) + 1;
      const propertiesString = JSON.stringify(link.properties);
      const newId = generateUUID();

      // Two operations per link: set old as not latest, insert new version
      statements.push(
        db.prepare('UPDATE links SET is_latest = 0 WHERE id = ?').bind(currentVersion.id)
      );
      statements.push(
        db.prepare(`
          INSERT INTO links (id, type_id, source_entity_id, target_entity_id, properties, version, previous_version_id, created_at, created_by, is_deleted, is_latest)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1)
        `).bind(newId, currentVersion.type_id, currentVersion.source_entity_id, currentVersion.target_entity_id, propertiesString, newVersion, currentVersion.id, now, systemUserId)
      );

      updateData.push({ originalId: linkId, newId, newVersion, index });
    }

    // Execute batch if we have any valid updates
    if (statements.length > 0) {
      const batchResults = await db.batch(statements);

      // Process batch results (every 2 statements = 1 link update)
      for (let j = 0; j < updateData.length; j++) {
        const updateInfo = updateData[j];
        const updateIndex = j * 2;
        const insertIndex = j * 2 + 1;

        const updateResult = batchResults[updateIndex];
        const insertResult = batchResults[insertIndex];

        if (updateResult.success && insertResult.success) {
          results.push({
            index: updateInfo.index,
            success: true,
            id: updateInfo.newId,
            version: updateInfo.newVersion,
          });
        } else {
          results.push({
            index: updateInfo.index,
            success: false,
            id: updateInfo.originalId,
            error: 'Failed to update link',
            code: 'UPDATE_FAILED',
          });
        }
      }
    }

    // Sort results by index
    results.sort((a, b) => a.index - b.index);

    const successCount = results.filter(r => r.success).length;
    const failureCount = results.filter(r => !r.success).length;

    logger.info('Bulk update links completed', { successCount, failureCount, total: data.links.length });

    return c.json(response.success({
      results,
      summary: {
        total: data.links.length,
        successful: successCount,
        failed: failureCount,
      },
    }, 'Bulk link update completed'));
  } catch (error) {
    logger.error('Error in bulk update links', error instanceof Error ? error : undefined);
    throw error;
  }
});

export default bulk;
