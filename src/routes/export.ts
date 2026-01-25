import { Hono } from 'hono';
import { validateJson, validateQuery } from '../middleware/validation.js';
import {
  exportQuerySchema,
  importRequestSchema,
  type ExportQuery,
  type ImportRequest,
  type ImportResultItem,
} from '../schemas/index.js';
import * as response from '../utils/response.js';
import { getLogger } from '../middleware/request-context.js';
import { validatePropertiesAgainstSchema, formatValidationErrors } from '../utils/json-schema.js';

type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  ENVIRONMENT: string;
};

const exportRouter = new Hono<{ Bindings: Bindings }>();

// Helper function to generate UUID
function generateUUID(): string {
  return crypto.randomUUID();
}

// Helper function to get current timestamp
function getCurrentTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * GET /api/export
 * Export entities and links as JSON
 * Supports filtering by type, date range, and inclusion of deleted/versioned data
 */
exportRouter.get('/', validateQuery(exportQuerySchema), async (c) => {
  const query = c.get('validated_query') as ExportQuery;
  const db = c.env.DB;
  const logger = getLogger(c).child({ module: 'export' });

  try {
    logger.info('Starting export', {
      type_ids: query.type_ids,
      include_deleted: query.include_deleted,
      include_versions: query.include_versions,
      limit: query.limit,
    });

    // Build entity query
    let entitySql = 'SELECT e.*, t.name as type_name FROM entities e LEFT JOIN types t ON e.type_id = t.id WHERE 1=1';
    const entityBindings: (string | number)[] = [];

    // Only get latest versions unless include_versions is true
    if (!query.include_versions) {
      entitySql += ' AND e.is_latest = 1';
    }

    // Filter by deleted status
    if (!query.include_deleted) {
      entitySql += ' AND e.is_deleted = 0';
    }

    // Filter by type IDs
    if (query.type_ids && query.type_ids.length > 0) {
      const placeholders = query.type_ids.map(() => '?').join(',');
      entitySql += ` AND e.type_id IN (${placeholders})`;
      entityBindings.push(...query.type_ids);
    }

    // Filter by creation date
    if (query.created_after !== undefined) {
      entitySql += ' AND e.created_at >= ?';
      entityBindings.push(query.created_after);
    }
    if (query.created_before !== undefined) {
      entitySql += ' AND e.created_at <= ?';
      entityBindings.push(query.created_before);
    }

    // Apply limit
    entitySql += ' ORDER BY e.created_at DESC LIMIT ?';
    entityBindings.push(query.limit);

    // Execute entity query
    const { results: rawEntities } = await db.prepare(entitySql).bind(...entityBindings).all();
    const entities = rawEntities.map((e: Record<string, unknown>) => ({
      id: e.id,
      type_id: e.type_id,
      type_name: e.type_name || undefined,
      properties: JSON.parse(e.properties as string || '{}'),
      version: e.version,
      previous_version_id: e.previous_version_id,
      created_at: e.created_at,
      created_by: e.created_by,
      is_deleted: e.is_deleted,
      is_latest: e.is_latest,
    }));

    // Get all entity IDs for link filtering
    const entityIds = new Set(entities.map(e => e.id as string));

    // Build link query - only get links where both source and target are in the exported entities
    let linkSql = 'SELECT l.*, t.name as type_name FROM links l LEFT JOIN types t ON l.type_id = t.id WHERE 1=1';
    const linkBindings: (string | number)[] = [];

    // Only get latest versions unless include_versions is true
    if (!query.include_versions) {
      linkSql += ' AND l.is_latest = 1';
    }

    // Filter by deleted status
    if (!query.include_deleted) {
      linkSql += ' AND l.is_deleted = 0';
    }

    // Only include links where both entities are in the export
    if (entityIds.size > 0) {
      const entityIdPlaceholders = Array.from(entityIds).map(() => '?').join(',');
      linkSql += ` AND l.source_entity_id IN (${entityIdPlaceholders}) AND l.target_entity_id IN (${entityIdPlaceholders})`;
      linkBindings.push(...entityIds, ...entityIds);
    } else {
      // No entities, so no links to include
      linkSql += ' AND 1=0';
    }

    // Apply limit
    linkSql += ' ORDER BY l.created_at DESC LIMIT ?';
    linkBindings.push(query.limit);

    // Execute link query
    const { results: rawLinks } = await db.prepare(linkSql).bind(...linkBindings).all();
    const links = rawLinks.map((l: Record<string, unknown>) => ({
      id: l.id,
      type_id: l.type_id,
      type_name: l.type_name || undefined,
      source_entity_id: l.source_entity_id,
      target_entity_id: l.target_entity_id,
      properties: JSON.parse(l.properties as string || '{}'),
      version: l.version,
      previous_version_id: l.previous_version_id,
      created_at: l.created_at,
      created_by: l.created_by,
      is_deleted: l.is_deleted,
      is_latest: l.is_latest,
    }));

    // Get all used type IDs
    const usedTypeIds = new Set([
      ...entities.map(e => e.type_id as string),
      ...links.map(l => l.type_id as string),
    ]);

    // Fetch used types
    let types: Array<Record<string, unknown>> = [];
    if (usedTypeIds.size > 0) {
      const typePlaceholders = Array.from(usedTypeIds).map(() => '?').join(',');
      const { results: rawTypes } = await db.prepare(
        `SELECT * FROM types WHERE id IN (${typePlaceholders})`
      ).bind(...usedTypeIds).all();
      types = rawTypes.map((t: Record<string, unknown>) => ({
        id: t.id,
        name: t.name,
        category: t.category,
        description: t.description,
        json_schema: t.json_schema,
        created_at: t.created_at,
        created_by: t.created_by,
      }));
    }

    const exportData = {
      format_version: '1.0' as const,
      exported_at: new Date().toISOString(),
      types,
      entities,
      links,
      metadata: {
        entity_count: entities.length,
        link_count: links.length,
        type_count: types.length,
        include_deleted: query.include_deleted,
        include_versions: query.include_versions,
      },
    };

    logger.info('Export completed', {
      entity_count: entities.length,
      link_count: links.length,
      type_count: types.length,
    });

    return c.json(response.success(exportData, 'Export completed successfully'));
  } catch (error) {
    logger.error('Error in export', error instanceof Error ? error : undefined);
    throw error;
  }
});

/**
 * POST /api/import
 * Import entities and links from JSON
 * Creates new records with new IDs, maintaining referential integrity
 */
exportRouter.post('/', validateJson(importRequestSchema), async (c) => {
  const data = c.get('validated_json') as ImportRequest;
  const db = c.env.DB;
  const logger = getLogger(c).child({ module: 'import' });
  const now = getCurrentTimestamp();
  const systemUserId = 'test-user-001';

  const typeResults: ImportResultItem[] = [];
  const entityResults: ImportResultItem[] = [];
  const linkResults: ImportResultItem[] = [];

  // ID mappings: client_id/name -> new server ID
  const typeIdMap: Map<string, string> = new Map();
  const entityIdMap: Map<string, string> = new Map();
  const linkIdMap: Map<string, string> = new Map();

  try {
    logger.info('Starting import', {
      type_count: data.types.length,
      entity_count: data.entities.length,
      link_count: data.links.length,
    });

    // Phase 1: Import types (if any)
    if (data.types.length > 0) {
      const typeStatements: D1PreparedStatement[] = [];
      const typeData: Array<{ name: string; clientId?: string; id: string }> = [];

      // Check for existing types by name
      const typeNames = data.types.map(t => t.name);
      const existingTypes: Map<string, string> = new Map();
      if (typeNames.length > 0) {
        const namePlaceholders = typeNames.map(() => '?').join(',');
        const { results: existing } = await db.prepare(
          `SELECT id, name FROM types WHERE name IN (${namePlaceholders})`
        ).bind(...typeNames).all();
        for (const t of existing) {
          existingTypes.set(t.name as string, t.id as string);
        }
      }

      for (const typeItem of data.types) {
        // Check if type already exists
        if (existingTypes.has(typeItem.name)) {
          const existingId = existingTypes.get(typeItem.name)!;
          typeIdMap.set(typeItem.name, existingId);
          if (typeItem.client_id) {
            typeIdMap.set(typeItem.client_id, existingId);
          }
          typeResults.push({
            client_id: typeItem.client_id || typeItem.name,
            success: true,
            id: existingId,
          });
          continue;
        }

        const id = generateUUID();
        typeStatements.push(
          db.prepare(`
            INSERT INTO types (id, name, category, description, json_schema, created_at, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).bind(
            id,
            typeItem.name,
            typeItem.category,
            typeItem.description || null,
            typeItem.json_schema || null,
            now,
            systemUserId
          )
        );
        typeData.push({ name: typeItem.name, clientId: typeItem.client_id, id });
      }

      // Execute type inserts
      if (typeStatements.length > 0) {
        const batchResults = await db.batch(typeStatements);
        for (let j = 0; j < batchResults.length; j++) {
          const result = batchResults[j];
          const typeInfo = typeData[j];

          if (result.success) {
            typeIdMap.set(typeInfo.name, typeInfo.id);
            if (typeInfo.clientId) {
              typeIdMap.set(typeInfo.clientId, typeInfo.id);
            }
            typeResults.push({
              client_id: typeInfo.clientId || typeInfo.name,
              success: true,
              id: typeInfo.id,
            });
          } else {
            typeResults.push({
              client_id: typeInfo.clientId || typeInfo.name,
              success: false,
              error: 'Failed to create type',
              code: 'CREATE_FAILED',
            });
          }
        }
      }
    }

    // Phase 2: Resolve entity type IDs and validate (including JSON schema validation)
    const resolvedEntities: Array<{
      clientId: string;
      typeId: string;
      properties: Record<string, unknown>;
    }> = [];

    // Load existing entity types for validation (including json_schema)
    const { results: existingEntityTypes } = await db.prepare(
      "SELECT id, name, json_schema FROM types WHERE category = 'entity'"
    ).all();
    const entityTypeByName: Map<string, string> = new Map();
    const entityTypeById: Set<string> = new Set();
    const entityTypeSchemas: Map<string, string | null> = new Map();
    for (const t of existingEntityTypes) {
      entityTypeByName.set(t.name as string, t.id as string);
      entityTypeById.add(t.id as string);
      entityTypeSchemas.set(t.id as string, t.json_schema as string | null);
    }
    // Also include newly created types (with their schemas from the import data)
    for (const [key, id] of typeIdMap) {
      entityTypeById.add(id);
      // Find the schema from the imported types
      const importedType = data.types.find(t => t.name === key || t.client_id === key);
      if (importedType) {
        entityTypeSchemas.set(id, importedType.json_schema || null);
      }
    }

    for (const entity of data.entities) {
      let typeId: string | undefined;

      // Resolve type ID
      if (entity.type_id) {
        typeId = entity.type_id;
      } else if (entity.type_name) {
        // Check newly created types first
        typeId = typeIdMap.get(entity.type_name) || entityTypeByName.get(entity.type_name);
      }

      if (!typeId || !entityTypeById.has(typeId)) {
        entityResults.push({
          client_id: entity.client_id,
          success: false,
          error: `Entity type not found: ${entity.type_name || entity.type_id}`,
          code: 'TYPE_NOT_FOUND',
        });
        continue;
      }

      // Validate properties against the type's JSON schema
      const schemaValidation = validatePropertiesAgainstSchema(
        entity.properties,
        entityTypeSchemas.get(typeId)
      );

      if (!schemaValidation.valid) {
        entityResults.push({
          client_id: entity.client_id,
          success: false,
          error: `Property validation failed: ${formatValidationErrors(schemaValidation.errors)}`,
          code: 'SCHEMA_VALIDATION_FAILED',
        });
        continue;
      }

      resolvedEntities.push({
        clientId: entity.client_id,
        typeId,
        properties: entity.properties,
      });
    }

    // Phase 3: Import entities
    if (resolvedEntities.length > 0) {
      const entityStatements: D1PreparedStatement[] = [];
      const entityData: Array<{ clientId: string; id: string }> = [];

      for (const entity of resolvedEntities) {
        const id = generateUUID();
        const propertiesString = JSON.stringify(entity.properties);

        entityStatements.push(
          db.prepare(`
            INSERT INTO entities (id, type_id, properties, version, previous_version_id, created_at, created_by, is_deleted, is_latest)
            VALUES (?, ?, ?, 1, NULL, ?, ?, 0, 1)
          `).bind(id, entity.typeId, propertiesString, now, systemUserId)
        );
        entityData.push({ clientId: entity.clientId, id });
      }

      const batchResults = await db.batch(entityStatements);
      for (let j = 0; j < batchResults.length; j++) {
        const result = batchResults[j];
        const entityInfo = entityData[j];

        if (result.success) {
          entityIdMap.set(entityInfo.clientId, entityInfo.id);
          entityResults.push({
            client_id: entityInfo.clientId,
            success: true,
            id: entityInfo.id,
          });
        } else {
          entityResults.push({
            client_id: entityInfo.clientId,
            success: false,
            error: 'Failed to create entity',
            code: 'CREATE_FAILED',
          });
        }
      }
    }

    // Phase 4: Resolve link types and entity references, then import links (including JSON schema validation)
    const resolvedLinks: Array<{
      clientId?: string;
      typeId: string;
      sourceEntityId: string;
      targetEntityId: string;
      properties: Record<string, unknown>;
    }> = [];

    // Load existing link types for validation (including json_schema)
    const { results: existingLinkTypes } = await db.prepare(
      "SELECT id, name, json_schema FROM types WHERE category = 'link'"
    ).all();
    const linkTypeByName: Map<string, string> = new Map();
    const linkTypeById: Set<string> = new Set();
    const linkTypeSchemas: Map<string, string | null> = new Map();
    for (const t of existingLinkTypes) {
      linkTypeByName.set(t.name as string, t.id as string);
      linkTypeById.add(t.id as string);
      linkTypeSchemas.set(t.id as string, t.json_schema as string | null);
    }
    // Also include newly created types (with their schemas from the import data)
    for (const [key, id] of typeIdMap) {
      linkTypeById.add(id);
      // Find the schema from the imported types
      const importedType = data.types.find(t => t.name === key || t.client_id === key);
      if (importedType) {
        linkTypeSchemas.set(id, importedType.json_schema || null);
      }
    }

    // Load existing entities for reference resolution
    const { results: existingEntities } = await db.prepare(
      'SELECT id FROM entities WHERE is_latest = 1 AND is_deleted = 0'
    ).all();
    const existingEntityIds: Set<string> = new Set();
    for (const e of existingEntities) {
      existingEntityIds.add(e.id as string);
    }
    // Also include newly created entities
    for (const [, id] of entityIdMap) {
      existingEntityIds.add(id);
    }

    for (const link of data.links) {
      let typeId: string | undefined;
      let sourceEntityId: string | undefined;
      let targetEntityId: string | undefined;

      // Resolve type ID
      if (link.type_id) {
        typeId = link.type_id;
      } else if (link.type_name) {
        typeId = typeIdMap.get(link.type_name) || linkTypeByName.get(link.type_name);
      }

      if (!typeId || !linkTypeById.has(typeId)) {
        linkResults.push({
          client_id: link.client_id,
          success: false,
          error: `Link type not found: ${link.type_name || link.type_id}`,
          code: 'TYPE_NOT_FOUND',
        });
        continue;
      }

      // Validate properties against the type's JSON schema
      const schemaValidation = validatePropertiesAgainstSchema(
        link.properties,
        linkTypeSchemas.get(typeId)
      );

      if (!schemaValidation.valid) {
        linkResults.push({
          client_id: link.client_id,
          success: false,
          error: `Property validation failed: ${formatValidationErrors(schemaValidation.errors)}`,
          code: 'SCHEMA_VALIDATION_FAILED',
        });
        continue;
      }

      // Resolve source entity
      if (link.source_entity_id) {
        sourceEntityId = link.source_entity_id;
      } else if (link.source_entity_client_id) {
        sourceEntityId = entityIdMap.get(link.source_entity_client_id);
      }

      if (!sourceEntityId || !existingEntityIds.has(sourceEntityId)) {
        linkResults.push({
          client_id: link.client_id,
          success: false,
          error: `Source entity not found: ${link.source_entity_client_id || link.source_entity_id}`,
          code: 'SOURCE_ENTITY_NOT_FOUND',
        });
        continue;
      }

      // Resolve target entity
      if (link.target_entity_id) {
        targetEntityId = link.target_entity_id;
      } else if (link.target_entity_client_id) {
        targetEntityId = entityIdMap.get(link.target_entity_client_id);
      }

      if (!targetEntityId || !existingEntityIds.has(targetEntityId)) {
        linkResults.push({
          client_id: link.client_id,
          success: false,
          error: `Target entity not found: ${link.target_entity_client_id || link.target_entity_id}`,
          code: 'TARGET_ENTITY_NOT_FOUND',
        });
        continue;
      }

      resolvedLinks.push({
        clientId: link.client_id,
        typeId,
        sourceEntityId,
        targetEntityId,
        properties: link.properties,
      });
    }

    // Import links
    if (resolvedLinks.length > 0) {
      const linkStatements: D1PreparedStatement[] = [];
      const linkData: Array<{ clientId?: string; id: string }> = [];

      for (const link of resolvedLinks) {
        const id = generateUUID();
        const propertiesString = JSON.stringify(link.properties);

        linkStatements.push(
          db.prepare(`
            INSERT INTO links (id, type_id, source_entity_id, target_entity_id, properties, version, previous_version_id, created_at, created_by, is_deleted, is_latest)
            VALUES (?, ?, ?, ?, ?, 1, NULL, ?, ?, 0, 1)
          `).bind(id, link.typeId, link.sourceEntityId, link.targetEntityId, propertiesString, now, systemUserId)
        );
        linkData.push({ clientId: link.clientId, id });
      }

      const batchResults = await db.batch(linkStatements);
      for (let j = 0; j < batchResults.length; j++) {
        const result = batchResults[j];
        const linkInfo = linkData[j];

        if (result.success) {
          if (linkInfo.clientId) {
            linkIdMap.set(linkInfo.clientId, linkInfo.id);
          }
          linkResults.push({
            client_id: linkInfo.clientId,
            success: true,
            id: linkInfo.id,
          });
        } else {
          linkResults.push({
            client_id: linkInfo.clientId,
            success: false,
            error: 'Failed to create link',
            code: 'CREATE_FAILED',
          });
        }
      }
    }

    // Build response
    const typesSuccessCount = typeResults.filter(r => r.success).length;
    const typesFailureCount = typeResults.filter(r => !r.success).length;
    const entitiesSuccessCount = entityResults.filter(r => r.success).length;
    const entitiesFailureCount = entityResults.filter(r => !r.success).length;
    const linksSuccessCount = linkResults.filter(r => r.success).length;
    const linksFailureCount = linkResults.filter(r => !r.success).length;

    logger.info('Import completed', {
      types: { successful: typesSuccessCount, failed: typesFailureCount },
      entities: { successful: entitiesSuccessCount, failed: entitiesFailureCount },
      links: { successful: linksSuccessCount, failed: linksFailureCount },
    });

    const importResponse = {
      type_results: typeResults,
      entity_results: entityResults,
      link_results: linkResults,
      id_mapping: {
        types: Object.fromEntries(typeIdMap),
        entities: Object.fromEntries(entityIdMap),
        links: Object.fromEntries(linkIdMap),
      },
      summary: {
        types: {
          total: data.types.length,
          successful: typesSuccessCount,
          failed: typesFailureCount,
        },
        entities: {
          total: data.entities.length,
          successful: entitiesSuccessCount,
          failed: entitiesFailureCount,
        },
        links: {
          total: data.links.length,
          successful: linksSuccessCount,
          failed: linksFailureCount,
        },
      },
    };

    return c.json(response.success(importResponse, 'Import completed'), 201);
  } catch (error) {
    logger.error('Error in import', error instanceof Error ? error : undefined);
    throw error;
  }
});

export default exportRouter;
