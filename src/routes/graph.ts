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
  max_depth: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(10)).optional().default('10'),
});

// Helper function to find the latest version of an entity by any ID in its version chain
async function findLatestVersion(db: D1Database, entityId: string): Promise<any> {
  // First, try direct match with is_latest
  let entity = await db.prepare('SELECT * FROM entities WHERE id = ? AND is_latest = 1')
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
      { entityId: fromEntity.id, path: [{ entityId: fromEntity.id, linkId: null }] }
    ];
    const visited = new Set<string>();
    visited.add(fromEntity.id);

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
      const bindings: any[] = [current.entityId];

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
            fullPath.map(async (step, index) => {
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
