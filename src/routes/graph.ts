import { Hono } from 'hono';
import { validateQuery } from '../middleware/validation.js';
import * as response from '../utils/response.js';
import { getLogger } from '../middleware/request-context.js';
import { z } from 'zod';

type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  ENVIRONMENT: string;
};

const graph = new Hono<{ Bindings: Bindings }>();

// Schema for shortest path query parameters
const shortestPathSchema = z.object({
  from: z.string().uuid('Source entity ID must be a valid UUID'),
  to: z.string().uuid('Target entity ID must be a valid UUID'),
  type_id: z.string().uuid('Link type ID must be a valid UUID').optional(),
  include_deleted: z.enum(['true', 'false']).optional().default('false'),
  max_depth: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(10)).optional().default(10),
});

// Schema for multi-hop traversal request body
const traverseSchema = z.object({
  start_entity_id: z.string().uuid('Starting entity ID must be a valid UUID'),
  max_depth: z.number().int().min(1).max(10).default(3),
  direction: z.enum(['outbound', 'inbound', 'both']).default('outbound'),
  link_type_ids: z.array(z.string().uuid('Link type ID must be a valid UUID')).optional(),
  entity_type_ids: z.array(z.string().uuid('Entity type ID must be a valid UUID')).optional(),
  include_deleted: z.boolean().default(false),
  return_paths: z.boolean().default(false), // Whether to return the paths that led to each entity
});

// Helper function to find the latest version of an entity by any ID in its version chain
async function findLatestVersion(db: D1Database, entityId: string): Promise<Record<string, unknown> | null> {
  // First, try direct match with is_latest
  const entity = await db.prepare('SELECT * FROM entities WHERE id = ? AND is_latest = 1')
    .bind(entityId)
    .first();

  if (entity) {
    return entity;
  }

  // If not found, this ID might be an old version
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

/**
 * POST /api/graph/traverse
 * Advanced multi-hop graph traversal with configurable depth and filtering
 */
graph.post('/traverse', async (c) => {
  const db = c.env.DB;
  const logger = getLogger(c).child({ module: 'graph' });

  try {
    // Parse and validate request body
    const body = await c.req.json();
    const params = traverseSchema.parse(body);

    // Validate that starting entity exists
    const startEntity = await findLatestVersion(db, params.start_entity_id);
    if (!startEntity) {
      return c.json(response.notFound('Starting entity'), 404);
    }

    // BFS traversal with depth limits and filtering
    interface PathNode {
      entityId: string;
      linkId: string | null;
    }

    interface QueueItem {
      entityId: string;
      depth: number;
      path: PathNode[];
    }

    const queue: QueueItem[] = [
      { entityId: startEntity.id as string, depth: 0, path: [{ entityId: startEntity.id as string, linkId: null }] }
    ];

    const visited = new Set<string>();
    visited.add(startEntity.id as string);

    // Store entities with their paths (if requested)
    const foundEntities = new Map<string, { entity: Record<string, unknown>; paths: PathNode[][] }>();

    // Add the starting entity
    foundEntities.set(startEntity.id as string, {
      entity: {
        id: startEntity.id,
        type_id: startEntity.type_id,
        properties: startEntity.properties ? JSON.parse(startEntity.properties as string) : {},
        version: startEntity.version,
        created_at: startEntity.created_at,
        is_deleted: startEntity.is_deleted === 1,
      },
      paths: [[{ entityId: startEntity.id as string, linkId: null }]],
    });

    while (queue.length > 0) {
      const current = queue.shift()!;

      // Check depth limit - don't traverse beyond max_depth
      if (current.depth >= params.max_depth) {
        continue;
      }

      // Build queries based on direction
      const queries: Array<{ sql: string; bindings: (string | number)[] }> = [];

      // Outbound links (this entity -> others)
      if (params.direction === 'outbound' || params.direction === 'both') {
        let sql = `
          SELECT
            l.id as link_id,
            l.type_id as link_type_id,
            l.properties as link_properties,
            e.id as entity_id,
            e.type_id as entity_type_id,
            e.properties as entity_properties,
            e.version as entity_version,
            e.created_at as entity_created_at,
            e.is_deleted as entity_is_deleted
          FROM links l
          INNER JOIN entities e ON l.target_entity_id = e.id
          WHERE l.source_entity_id = ?
          AND l.is_latest = 1
          AND e.is_latest = 1
        `;
        const bindings: (string | number)[] = [current.entityId];

        if (!params.include_deleted) {
          sql += ' AND l.is_deleted = 0 AND e.is_deleted = 0';
        }

        if (params.link_type_ids && params.link_type_ids.length > 0) {
          sql += ` AND l.type_id IN (${params.link_type_ids.map(() => '?').join(',')})`;
          bindings.push(...params.link_type_ids);
        }

        if (params.entity_type_ids && params.entity_type_ids.length > 0) {
          sql += ` AND e.type_id IN (${params.entity_type_ids.map(() => '?').join(',')})`;
          bindings.push(...params.entity_type_ids);
        }

        queries.push({ sql, bindings });
      }

      // Inbound links (others -> this entity)
      if (params.direction === 'inbound' || params.direction === 'both') {
        let sql = `
          SELECT
            l.id as link_id,
            l.type_id as link_type_id,
            l.properties as link_properties,
            e.id as entity_id,
            e.type_id as entity_type_id,
            e.properties as entity_properties,
            e.version as entity_version,
            e.created_at as entity_created_at,
            e.is_deleted as entity_is_deleted
          FROM links l
          INNER JOIN entities e ON l.source_entity_id = e.id
          WHERE l.target_entity_id = ?
          AND l.is_latest = 1
          AND e.is_latest = 1
        `;
        const bindings: (string | number)[] = [current.entityId];

        if (!params.include_deleted) {
          sql += ' AND l.is_deleted = 0 AND e.is_deleted = 0';
        }

        if (params.link_type_ids && params.link_type_ids.length > 0) {
          sql += ` AND l.type_id IN (${params.link_type_ids.map(() => '?').join(',')})`;
          bindings.push(...params.link_type_ids);
        }

        if (params.entity_type_ids && params.entity_type_ids.length > 0) {
          sql += ` AND e.type_id IN (${params.entity_type_ids.map(() => '?').join(',')})`;
          bindings.push(...params.entity_type_ids);
        }

        queries.push({ sql, bindings });
      }

      // Execute all queries and collect neighbors
      for (const query of queries) {
        const { results } = await db.prepare(query.sql).bind(...query.bindings).all();

        for (const neighbor of results) {
          const neighborId = neighbor.entity_id as string;
          const newPath = [...current.path, { entityId: neighborId, linkId: neighbor.link_id as string }];

          // Track this entity if we haven't seen it before
          if (!visited.has(neighborId)) {
            visited.add(neighborId);
            queue.push({
              entityId: neighborId,
              depth: current.depth + 1,
              path: newPath,
            });

            // Store the entity with its path
            const entity = {
              id: neighbor.entity_id,
              type_id: neighbor.entity_type_id,
              properties: neighbor.entity_properties ? JSON.parse(neighbor.entity_properties as string) : {},
              version: neighbor.entity_version,
              created_at: neighbor.entity_created_at,
              is_deleted: neighbor.entity_is_deleted === 1,
            };

            foundEntities.set(neighborId, {
              entity,
              paths: [newPath],
            });
          } else if (params.return_paths) {
            // If we're tracking paths and we've seen this entity before via a different path,
            // add this new path to the list
            const existing = foundEntities.get(neighborId);
            if (existing) {
              existing.paths.push(newPath);
            }
          }
        }
      }
    }

    // Build the response
    const entitiesArray = Array.from(foundEntities.values());

    let result: Array<Record<string, unknown>>;
    if (params.return_paths) {
      // Return entities with all their paths
      result = entitiesArray.map(item => ({
        entity: item.entity,
        paths: item.paths.map(path =>
          path.map(node => ({
            entity_id: node.entityId,
            link_id: node.linkId,
          }))
        ),
      }));
    } else {
      // Return just the entities
      result = entitiesArray.map(item => item.entity);
    }

    logger.info('Graph traversal completed', {
      start_entity_id: params.start_entity_id,
      max_depth: params.max_depth,
      entities_found: result.length,
    });

    return c.json(response.success({
      entities: result,
      count: result.length,
      start_entity_id: params.start_entity_id,
      max_depth: params.max_depth,
      direction: params.direction,
    }));
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json(
        response.error('Validation error', 'VALIDATION_ERROR', error.issues),
        400
      );
    }
    logger.error('Error during graph traversal', error instanceof Error ? error : undefined);
    throw error;
  }
});

/**
 * GET /api/graph/path
 * Find the shortest path between two entities using BFS
 */
graph.get('/path', validateQuery(shortestPathSchema), async (c) => {
  const query = c.get('validated_query') as z.infer<typeof shortestPathSchema>;
  const db = c.env.DB;
  const logger = getLogger(c).child({ module: 'graph' });

  try {
    // Validate that both entities exist
    const fromEntity = await findLatestVersion(db, query.from);
    const toEntity = await findLatestVersion(db, query.to);

    if (!fromEntity) {
      return c.json(response.notFound('Source entity'), 404);
    }

    if (!toEntity) {
      return c.json(response.notFound('Target entity'), 404);
    }

    // If source and target are the same, return empty path
    if (fromEntity.id === toEntity.id) {
      return c.json(response.success({
        path: [{
          entity: {
            id: fromEntity.id,
            type_id: fromEntity.type_id,
            properties: fromEntity.properties ? JSON.parse(fromEntity.properties as string) : {},
          },
          link: null,
        }],
        length: 0,
        from: query.from,
        to: query.to,
      }));
    }

    const includeDeleted = query.include_deleted === 'true';
    const maxDepth = query.max_depth;

    // BFS to find shortest path
    const queue: Array<{ entityId: string, path: Array<{ entityId: string, linkId: string | null }> }> = [
      { entityId: fromEntity.id as string, path: [{ entityId: fromEntity.id as string, linkId: null }] }
    ];
    const visited = new Set<string>();
    visited.add(fromEntity.id as string);

    while (queue.length > 0) {
      const current = queue.shift()!;

      // Check depth limit
      if (current.path.length > maxDepth) {
        continue;
      }

      // Build query to find outbound neighbors
      let sql = `
        SELECT
          l.id as link_id,
          l.type_id as link_type_id,
          l.properties as link_properties,
          e.id as entity_id,
          e.type_id as entity_type_id,
          e.properties as entity_properties
        FROM links l
        INNER JOIN entities e ON l.target_entity_id = e.id
        WHERE l.source_entity_id = ?
        AND l.is_latest = 1
        AND e.is_latest = 1
      `;
      const bindings: (string | number)[] = [current.entityId];

      if (!includeDeleted) {
        sql += ' AND l.is_deleted = 0 AND e.is_deleted = 0';
      }

      if (query.type_id) {
        sql += ' AND l.type_id = ?';
        bindings.push(query.type_id);
      }

      const { results } = await db.prepare(sql).bind(...bindings).all();

      for (const neighbor of results) {
        const neighborId = neighbor.entity_id as string;

        // Check if we've reached the target
        if (neighborId === toEntity.id) {
          // Construct the full path
          const fullPath = [...current.path, { entityId: neighborId, linkId: neighbor.link_id as string }];

          // Fetch full entity and link details for the path
          const pathWithDetails = await Promise.all(
            fullPath.map(async (step) => {
              const entity = await db.prepare('SELECT * FROM entities WHERE id = ? AND is_latest = 1')
                .bind(step.entityId)
                .first();

              let link = null;
              if (step.linkId) {
                const linkData = await db.prepare('SELECT * FROM links WHERE id = ? AND is_latest = 1')
                  .bind(step.linkId)
                  .first();

                if (linkData) {
                  link = {
                    id: linkData.id,
                    type_id: linkData.type_id,
                    source_entity_id: linkData.source_entity_id,
                    target_entity_id: linkData.target_entity_id,
                    properties: linkData.properties ? JSON.parse(linkData.properties as string) : {},
                  };
                }
              }

              if (!entity) {
                throw new Error('Entity not found in path');
              }
              return {
                entity: {
                  id: entity.id,
                  type_id: entity.type_id,
                  properties: entity.properties ? JSON.parse(entity.properties as string) : {},
                },
                link,
              };
            })
          );

          logger.info('Shortest path found', {
            from: query.from,
            to: query.to,
            length: fullPath.length - 1
          });

          return c.json(response.success({
            path: pathWithDetails,
            length: fullPath.length - 1, // Number of hops (edges)
            from: query.from,
            to: query.to,
          }));
        }

        // Add unvisited neighbors to the queue
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          queue.push({
            entityId: neighborId,
            path: [...current.path, { entityId: neighborId, linkId: neighbor.link_id as string }],
          });
        }
      }
    }

    // No path found
    logger.info('No path found', { from: query.from, to: query.to });

    return c.json(
      response.error('No path found between the specified entities', 'NO_PATH_FOUND'),
      404
    );
  } catch (error) {
    logger.error('Error finding shortest path', error instanceof Error ? error : undefined);
    throw error;
  }
});

export default graph;
