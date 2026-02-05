import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { validateQuery } from '../middleware/validation.js';
import { optionalAuth } from '../middleware/auth.js';
import * as response from '../utils/response.js';
import { getLogger } from '../middleware/request-context.js';
import { buildAclFilterClause, hasPermissionByAclId } from '../utils/acl.js';
import { traverseSchema, shortestPathSchema, graphViewSchema } from '../schemas/graph.js';

type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  ENVIRONMENT: string;
};

const graph = new OpenAPIHono<{ Bindings: Bindings }>();

// Response schema for shortest path
const ShortestPathResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({
      path: z.array(
        z.object({
          entity: z.object({
            id: z.string().uuid().openapi({ example: '550e8400-e29b-41d4-a716-446655440000' }),
            type_id: z.string().uuid().openapi({ example: '550e8400-e29b-41d4-a716-446655440100' }),
            properties: z.record(z.string(), z.unknown()).openapi({ example: { name: 'Example' } }),
          }),
          link: z
            .object({
              id: z.string().uuid().openapi({ example: '660e8400-e29b-41d4-a716-446655440000' }),
              type_id: z
                .string()
                .uuid()
                .openapi({ example: '660e8400-e29b-41d4-a716-446655440100' }),
              source_entity_id: z
                .string()
                .uuid()
                .openapi({ example: '550e8400-e29b-41d4-a716-446655440000' }),
              target_entity_id: z
                .string()
                .uuid()
                .openapi({ example: '550e8400-e29b-41d4-a716-446655440001' }),
              properties: z.record(z.string(), z.unknown()).openapi({ example: { weight: 1 } }),
            })
            .nullable()
            .openapi({ description: 'Link used to reach this entity (null for starting entity)' }),
        })
      ),
      length: z
        .number()
        .int()
        .openapi({ example: 2, description: 'Number of hops (edges) in the path' }),
      from: z.string().uuid().openapi({
        example: '550e8400-e29b-41d4-a716-446655440000',
        description: 'Source entity ID',
      }),
      to: z.string().uuid().openapi({
        example: '550e8400-e29b-41d4-a716-446655440001',
        description: 'Target entity ID',
      }),
    }),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('ShortestPathResponse');

// Response schema for graph traversal
const GraphTraverseResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({
      entities: z.array(z.record(z.string(), z.unknown())).openapi({
        description: 'Traversed entities (with optional paths if return_paths is true)',
      }),
      count: z.number().int().openapi({ example: 5, description: 'Number of entities found' }),
      start_entity_id: z.string().uuid().openapi({
        example: '550e8400-e29b-41d4-a716-446655440000',
        description: 'Starting entity ID',
      }),
      max_depth: z.number().int().openapi({ example: 3, description: 'Maximum traversal depth' }),
      direction: z.enum(['outbound', 'inbound', 'both']).openapi({
        example: 'outbound',
        description: 'Direction of traversal',
      }),
    }),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('GraphTraverseResponse');

// Error response schema for graph operations
const GraphErrorResponseSchema = z
  .object({
    success: z.literal(false),
    error: z.string().openapi({ example: 'Starting entity not found' }),
    code: z.string().openapi({ example: 'NOT_FOUND' }),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('GraphErrorResponse');

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

  // If not found, this ID might be an old version
  const result = await db
    .prepare(
      `
    WITH RECURSIVE version_chain AS (
      SELECT * FROM entities WHERE id = ?
      UNION ALL
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
 * POST /api/graph/traverse route definition
 */
const traverseRoute = createRoute({
  method: 'post',
  path: '/traverse',
  tags: ['Graph'],
  summary: 'Traverse graph',
  description:
    'Perform multi-hop graph traversal from a starting entity. ACL filtering is applied: authenticated users can only traverse entities and links they have read permission on, unauthenticated users can only traverse public entities and links.',
  operationId: 'traverseGraph',
  security: [{ bearerAuth: [] }],
  middleware: [optionalAuth()] as const,
  request: {
    body: {
      content: {
        'application/json': {
          schema: traverseSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Traversal results',
      content: {
        'application/json': {
          schema: GraphTraverseResponseSchema,
        },
      },
    },
    400: {
      description: 'Validation error',
      content: {
        'application/json': {
          schema: GraphErrorResponseSchema,
        },
      },
    },
    403: {
      description: 'Forbidden - insufficient permissions',
      content: {
        'application/json': {
          schema: GraphErrorResponseSchema,
        },
      },
    },
    404: {
      description: 'Starting entity not found',
      content: {
        'application/json': {
          schema: GraphErrorResponseSchema,
        },
      },
    },
  },
});

/**
 * POST /api/graph/traverse
 * Advanced multi-hop graph traversal with configurable depth and filtering
 */
graph.openapi(traverseRoute, async c => {
  const db = c.env.DB;
  const kv = c.env.KV;
  const user = c.get('user');
  const logger = getLogger(c).child({ module: 'graph' });

  try {
    const params = c.req.valid('json');

    // Validate that starting entity exists
    const startEntity = await findLatestVersion(db, params.start_entity_id);
    if (!startEntity) {
      return c.json(
        {
          success: false as const,
          error: 'Starting entity not found',
          code: 'NOT_FOUND',
          timestamp: new Date().toISOString(),
        },
        404
      );
    }

    // Check permission on starting entity
    const startAclId = startEntity.acl_id as number | null;
    if (user) {
      const canRead = await hasPermissionByAclId(db, kv, user.user_id, startAclId, 'read');
      if (!canRead) {
        return c.json(
          {
            success: false as const,
            error: 'You do not have permission to access this entity',
            code: 'FORBIDDEN',
            timestamp: new Date().toISOString(),
          },
          403
        );
      }
    } else {
      // Unauthenticated: only allow access to public entities
      if (startAclId !== null) {
        return c.json(
          {
            success: false as const,
            error: 'Authentication required to access this entity',
            code: 'FORBIDDEN',
            timestamp: new Date().toISOString(),
          },
          403
        );
      }
    }

    // Build ACL filter for entities and links
    let entityAclFilter: Awaited<ReturnType<typeof buildAclFilterClause>> | null = null;
    let linkAclFilter: Awaited<ReturnType<typeof buildAclFilterClause>> | null = null;

    if (user) {
      entityAclFilter = await buildAclFilterClause(db, kv, user.user_id, 'read', 'e.acl_id');
      linkAclFilter = await buildAclFilterClause(db, kv, user.user_id, 'read', 'l.acl_id');
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
      {
        entityId: startEntity.id as string,
        depth: 0,
        path: [{ entityId: startEntity.id as string, linkId: null }],
      },
    ];

    const visited = new Set<string>();
    visited.add(startEntity.id as string);

    // Store entities with their paths (if requested)
    const foundEntities = new Map<
      string,
      { entity: Record<string, unknown>; paths: PathNode[][] }
    >();

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
            l.acl_id as link_acl_id,
            e.id as entity_id,
            e.type_id as entity_type_id,
            e.properties as entity_properties,
            e.version as entity_version,
            e.created_at as entity_created_at,
            e.is_deleted as entity_is_deleted,
            e.acl_id as entity_acl_id
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

        // Apply ACL filtering for both entities and links
        if (user) {
          if (entityAclFilter && entityAclFilter.useFilter) {
            sql += ` AND ${entityAclFilter.whereClause}`;
            bindings.push(...(entityAclFilter.bindings as (string | number)[]));
          }
          if (linkAclFilter && linkAclFilter.useFilter) {
            sql += ` AND ${linkAclFilter.whereClause}`;
            bindings.push(...(linkAclFilter.bindings as (string | number)[]));
          }
        } else {
          // Unauthenticated: only show public entities and links
          sql += ' AND e.acl_id IS NULL AND l.acl_id IS NULL';
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
            l.acl_id as link_acl_id,
            e.id as entity_id,
            e.type_id as entity_type_id,
            e.properties as entity_properties,
            e.version as entity_version,
            e.created_at as entity_created_at,
            e.is_deleted as entity_is_deleted,
            e.acl_id as entity_acl_id
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

        // Apply ACL filtering for both entities and links
        if (user) {
          if (entityAclFilter && entityAclFilter.useFilter) {
            sql += ` AND ${entityAclFilter.whereClause}`;
            bindings.push(...(entityAclFilter.bindings as (string | number)[]));
          }
          if (linkAclFilter && linkAclFilter.useFilter) {
            sql += ` AND ${linkAclFilter.whereClause}`;
            bindings.push(...(linkAclFilter.bindings as (string | number)[]));
          }
        } else {
          // Unauthenticated: only show public entities and links
          sql += ' AND e.acl_id IS NULL AND l.acl_id IS NULL';
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
        const { results } = await db
          .prepare(query.sql)
          .bind(...query.bindings)
          .all();

        // Apply per-row ACL filtering if needed (when useFilter is false)
        let filteredResults = results;
        if (user && entityAclFilter && !entityAclFilter.useFilter) {
          filteredResults = filteredResults.filter(r => {
            const entityAclId = r.entity_acl_id as number | null;
            if (entityAclId === null) return true;
            return entityAclFilter.accessibleAclIds.has(entityAclId);
          });
        }
        if (user && linkAclFilter && !linkAclFilter.useFilter) {
          filteredResults = filteredResults.filter(r => {
            const linkAclId = r.link_acl_id as number | null;
            if (linkAclId === null) return true;
            return linkAclFilter.accessibleAclIds.has(linkAclId);
          });
        }

        for (const neighbor of filteredResults) {
          const neighborId = neighbor.entity_id as string;
          const newPath = [
            ...current.path,
            { entityId: neighborId, linkId: neighbor.link_id as string },
          ];

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
              properties: neighbor.entity_properties
                ? JSON.parse(neighbor.entity_properties as string)
                : {},
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

    return c.json(
      {
        success: true as const,
        data: {
          entities: result,
          count: result.length,
          start_entity_id: params.start_entity_id,
          max_depth: params.max_depth,
          direction: params.direction,
        },
        timestamp: new Date().toISOString(),
      },
      200
    );
  } catch (error) {
    logger.error('Error during graph traversal', error instanceof Error ? error : undefined);
    throw error;
  }
});

/**
 * GET /api/graph/path route definition
 */
const shortestPathRoute = createRoute({
  method: 'get',
  path: '/path',
  tags: ['Graph'],
  summary: 'Find shortest path',
  description:
    'Find the shortest path between two entities using BFS. ACL filtering is applied: authenticated users can only traverse entities and links they have read permission on, unauthenticated users can only traverse public entities and links.',
  operationId: 'findShortestPath',
  security: [{ bearerAuth: [] }],
  middleware: [optionalAuth()] as const,
  request: {
    query: shortestPathSchema,
  },
  responses: {
    200: {
      description: 'Shortest path found',
      content: {
        'application/json': {
          schema: ShortestPathResponseSchema,
        },
      },
    },
    403: {
      description: 'Forbidden - insufficient permissions',
      content: {
        'application/json': {
          schema: GraphErrorResponseSchema,
        },
      },
    },
    404: {
      description: 'Entity not found or no path exists',
      content: {
        'application/json': {
          schema: GraphErrorResponseSchema,
        },
      },
    },
  },
});

/**
 * GET /api/graph/path
 * Find the shortest path between two entities using BFS
 */
graph.openapi(shortestPathRoute, async c => {
  const query = c.req.valid('query');
  const db = c.env.DB;
  const kv = c.env.KV;
  const user = c.get('user');
  const logger = getLogger(c).child({ module: 'graph' });

  try {
    // Validate that both entities exist
    const fromEntity = await findLatestVersion(db, query.from);
    const toEntity = await findLatestVersion(db, query.to);

    if (!fromEntity) {
      return c.json(
        {
          success: false as const,
          error: 'Source entity not found',
          code: 'NOT_FOUND',
          timestamp: new Date().toISOString(),
        },
        404
      );
    }

    if (!toEntity) {
      return c.json(
        {
          success: false as const,
          error: 'Target entity not found',
          code: 'NOT_FOUND',
          timestamp: new Date().toISOString(),
        },
        404
      );
    }

    // Check permission on source and target entities
    const fromAclId = fromEntity.acl_id as number | null;
    const toAclId = toEntity.acl_id as number | null;

    if (user) {
      const canReadFrom = await hasPermissionByAclId(db, kv, user.user_id, fromAclId, 'read');
      if (!canReadFrom) {
        return c.json(
          {
            success: false as const,
            error: 'You do not have permission to access the source entity',
            code: 'FORBIDDEN',
            timestamp: new Date().toISOString(),
          },
          403
        );
      }
      const canReadTo = await hasPermissionByAclId(db, kv, user.user_id, toAclId, 'read');
      if (!canReadTo) {
        return c.json(
          {
            success: false as const,
            error: 'You do not have permission to access the target entity',
            code: 'FORBIDDEN',
            timestamp: new Date().toISOString(),
          },
          403
        );
      }
    } else {
      // Unauthenticated: only allow access to public entities
      if (fromAclId !== null) {
        return c.json(
          {
            success: false as const,
            error: 'Authentication required to access the source entity',
            code: 'FORBIDDEN',
            timestamp: new Date().toISOString(),
          },
          403
        );
      }
      if (toAclId !== null) {
        return c.json(
          {
            success: false as const,
            error: 'Authentication required to access the target entity',
            code: 'FORBIDDEN',
            timestamp: new Date().toISOString(),
          },
          403
        );
      }
    }

    // Build ACL filter for entities and links during traversal
    let entityAclFilter: Awaited<ReturnType<typeof buildAclFilterClause>> | null = null;
    let linkAclFilter: Awaited<ReturnType<typeof buildAclFilterClause>> | null = null;

    if (user) {
      entityAclFilter = await buildAclFilterClause(db, kv, user.user_id, 'read', 'e.acl_id');
      linkAclFilter = await buildAclFilterClause(db, kv, user.user_id, 'read', 'l.acl_id');
    }

    // If source and target are the same, return empty path
    if (fromEntity.id === toEntity.id) {
      return c.json(
        {
          success: true as const,
          data: {
            path: [
              {
                entity: {
                  id: fromEntity.id as string,
                  type_id: fromEntity.type_id as string,
                  properties: fromEntity.properties
                    ? JSON.parse(fromEntity.properties as string)
                    : {},
                },
                link: null,
              },
            ],
            length: 0,
            from: query.from,
            to: query.to,
          },
          timestamp: new Date().toISOString(),
        },
        200
      );
    }

    const includeDeleted = query.include_deleted === 'true';
    const maxDepth = query.max_depth;

    // BFS to find shortest path
    const queue: Array<{
      entityId: string;
      path: Array<{ entityId: string; linkId: string | null }>;
    }> = [
      {
        entityId: fromEntity.id as string,
        path: [{ entityId: fromEntity.id as string, linkId: null }],
      },
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
          l.acl_id as link_acl_id,
          e.id as entity_id,
          e.type_id as entity_type_id,
          e.properties as entity_properties,
          e.acl_id as entity_acl_id
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

      // Apply ACL filtering for both entities and links
      if (user) {
        if (entityAclFilter && entityAclFilter.useFilter) {
          sql += ` AND ${entityAclFilter.whereClause}`;
          bindings.push(...(entityAclFilter.bindings as (string | number)[]));
        }
        if (linkAclFilter && linkAclFilter.useFilter) {
          sql += ` AND ${linkAclFilter.whereClause}`;
          bindings.push(...(linkAclFilter.bindings as (string | number)[]));
        }
      } else {
        // Unauthenticated: only traverse through public entities and links
        sql += ' AND e.acl_id IS NULL AND l.acl_id IS NULL';
      }

      if (query.type_id) {
        sql += ' AND l.type_id = ?';
        bindings.push(query.type_id);
      }

      const { results } = await db
        .prepare(sql)
        .bind(...bindings)
        .all();

      // Apply per-row ACL filtering if needed (when useFilter is false)
      let filteredResults = results;
      if (user && entityAclFilter && !entityAclFilter.useFilter) {
        filteredResults = filteredResults.filter(r => {
          const entityAclId = r.entity_acl_id as number | null;
          if (entityAclId === null) return true;
          return entityAclFilter.accessibleAclIds.has(entityAclId);
        });
      }
      if (user && linkAclFilter && !linkAclFilter.useFilter) {
        filteredResults = filteredResults.filter(r => {
          const linkAclId = r.link_acl_id as number | null;
          if (linkAclId === null) return true;
          return linkAclFilter.accessibleAclIds.has(linkAclId);
        });
      }

      for (const neighbor of filteredResults) {
        const neighborId = neighbor.entity_id as string;

        // Check if we've reached the target
        if (neighborId === toEntity.id) {
          // Construct the full path
          const fullPath = [
            ...current.path,
            { entityId: neighborId, linkId: neighbor.link_id as string },
          ];

          // Fetch full entity and link details for the path
          const pathWithDetails = await Promise.all(
            fullPath.map(async step => {
              const entity = await db
                .prepare('SELECT * FROM entities WHERE id = ? AND is_latest = 1')
                .bind(step.entityId)
                .first();

              let link: {
                id: string;
                type_id: string;
                source_entity_id: string;
                target_entity_id: string;
                properties: Record<string, unknown>;
              } | null = null;
              if (step.linkId) {
                const linkData = await db
                  .prepare('SELECT * FROM links WHERE id = ? AND is_latest = 1')
                  .bind(step.linkId)
                  .first();

                if (linkData) {
                  link = {
                    id: linkData.id as string,
                    type_id: linkData.type_id as string,
                    source_entity_id: linkData.source_entity_id as string,
                    target_entity_id: linkData.target_entity_id as string,
                    properties: linkData.properties
                      ? JSON.parse(linkData.properties as string)
                      : {},
                  };
                }
              }

              if (!entity) {
                throw new Error('Entity not found in path');
              }
              return {
                entity: {
                  id: entity.id as string,
                  type_id: entity.type_id as string,
                  properties: entity.properties
                    ? (JSON.parse(entity.properties as string) as Record<string, unknown>)
                    : {},
                },
                link,
              };
            })
          );

          logger.info('Shortest path found', {
            from: query.from,
            to: query.to,
            length: fullPath.length - 1,
          });

          return c.json(
            {
              success: true as const,
              data: {
                path: pathWithDetails,
                length: fullPath.length - 1, // Number of hops (edges)
                from: query.from,
                to: query.to,
              },
              timestamp: new Date().toISOString(),
            },
            200
          );
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
      {
        success: false as const,
        error: 'No path found between the specified entities',
        code: 'NO_PATH_FOUND',
        timestamp: new Date().toISOString(),
      },
      404
    );
  } catch (error) {
    logger.error('Error finding shortest path', error instanceof Error ? error : undefined);
    throw error;
  }
});

/**
 * GET /api/entities/:id/graph-view
 * Get graph data optimized for visualization showing N generations of connected entities
 *
 * This endpoint is specifically designed for the UI graph visualization feature.
 * It returns:
 * - The center entity
 * - First and second generation connections with link details
 * - Suggested distinguishing properties for each entity type
 *
 * ACL filtering is applied:
 * - Authenticated users can only see entities and links they have read permission on
 * - Unauthenticated users can only see public entities and links (NULL acl_id)
 */
graph.get('/entities/:id/graph-view', optionalAuth(), validateQuery(graphViewSchema), async c => {
  const entityId = c.req.param('id');
  const query = c.get('validated_query') as z.infer<typeof graphViewSchema>;
  const db = c.env.DB;
  const kv = c.env.KV;
  const user = c.get('user');
  const logger = getLogger(c).child({ module: 'graph-view' });

  try {
    // Validate that starting entity exists
    const centerEntity = await findLatestVersion(db, entityId);
    if (!centerEntity) {
      return c.json(response.notFound('Entity'), 404);
    }

    // Check permission on center entity
    const centerAclId = centerEntity.acl_id as number | null;
    if (user) {
      const canRead = await hasPermissionByAclId(db, kv, user.user_id, centerAclId, 'read');
      if (!canRead) {
        return c.json(response.forbidden('You do not have permission to access this entity'), 403);
      }
    } else {
      // Unauthenticated: only allow access to public entities
      if (centerAclId !== null) {
        return c.json(response.forbidden('Authentication required to access this entity'), 403);
      }
    }

    // Build ACL filter for entities and links
    let entityAclFilter: Awaited<ReturnType<typeof buildAclFilterClause>> | null = null;
    let linkAclFilter: Awaited<ReturnType<typeof buildAclFilterClause>> | null = null;

    if (user) {
      entityAclFilter = await buildAclFilterClause(db, kv, user.user_id, 'read', 'e.acl_id');
      linkAclFilter = await buildAclFilterClause(db, kv, user.user_id, 'read', 'l.acl_id');
    }

    const includeDeleted = query.include_deleted === 'true';
    const maxDepth = query.depth;

    // Data structures to store results
    interface GraphEntity {
      id: string;
      type_id: string;
      type_name: string;
      properties: Record<string, unknown>;
      version: number;
      created_at: number;
      is_deleted: boolean;
      generation: number; // 0 = center, 1 = first generation, 2 = second generation, etc.
    }

    interface GraphLink {
      id: string;
      type_id: string;
      type_name: string;
      source_entity_id: string;
      target_entity_id: string;
      properties: Record<string, unknown>;
      is_deleted: boolean;
    }

    const entities = new Map<string, GraphEntity>();
    const links: GraphLink[] = [];
    const entityTypeIds = new Set<string>();

    // Add center entity (generation 0)
    const centerType = await db
      .prepare('SELECT name FROM types WHERE id = ?')
      .bind(centerEntity.type_id as string)
      .first<{ name: string }>();

    entities.set(centerEntity.id as string, {
      id: centerEntity.id as string,
      type_id: centerEntity.type_id as string,
      type_name: centerType?.name || 'Unknown',
      properties: centerEntity.properties ? JSON.parse(centerEntity.properties as string) : {},
      version: centerEntity.version as number,
      created_at: centerEntity.created_at as number,
      is_deleted: centerEntity.is_deleted === 1,
      generation: 0,
    });
    entityTypeIds.add(centerEntity.type_id as string);

    // BFS to fetch entities up to maxDepth
    interface QueueItem {
      entityId: string;
      generation: number;
    }

    const queue: QueueItem[] = [{ entityId: centerEntity.id as string, generation: 0 }];
    const processed = new Set<string>();
    processed.add(centerEntity.id as string);

    while (queue.length > 0) {
      const current = queue.shift()!;

      // Stop if we've reached the depth limit
      if (current.generation >= maxDepth) {
        continue;
      }

      // Build query for both outbound and inbound links
      const directions = [
        { sourceCol: 'source_entity_id', targetCol: 'target_entity_id' },
        { sourceCol: 'target_entity_id', targetCol: 'source_entity_id' },
      ];

      for (const { sourceCol, targetCol } of directions) {
        let sql = `
          SELECT
            l.id as link_id,
            l.type_id as link_type_id,
            l.source_entity_id,
            l.target_entity_id,
            l.properties as link_properties,
            l.is_deleted as link_is_deleted,
            l.acl_id as link_acl_id,
            lt.name as link_type_name,
            e.id as entity_id,
            e.type_id as entity_type_id,
            e.properties as entity_properties,
            e.version as entity_version,
            e.created_at as entity_created_at,
            e.is_deleted as entity_is_deleted,
            e.acl_id as entity_acl_id,
            et.name as entity_type_name
          FROM links l
          INNER JOIN entities e ON l.${targetCol} = e.id
          LEFT JOIN types lt ON l.type_id = lt.id
          LEFT JOIN types et ON e.type_id = et.id
          WHERE l.${sourceCol} = ?
          AND l.is_latest = 1
          AND e.is_latest = 1
        `;
        const bindings: (string | number)[] = [current.entityId];

        if (!includeDeleted) {
          sql += ' AND l.is_deleted = 0 AND e.is_deleted = 0';
        }

        // Apply ACL filtering
        if (user) {
          if (entityAclFilter && entityAclFilter.useFilter) {
            sql += ` AND ${entityAclFilter.whereClause}`;
            bindings.push(...(entityAclFilter.bindings as (string | number)[]));
          }
          if (linkAclFilter && linkAclFilter.useFilter) {
            sql += ` AND ${linkAclFilter.whereClause}`;
            bindings.push(...(linkAclFilter.bindings as (string | number)[]));
          }
        } else {
          // Unauthenticated: only show public entities and links
          sql += ' AND e.acl_id IS NULL AND l.acl_id IS NULL';
        }

        const { results } = await db
          .prepare(sql)
          .bind(...bindings)
          .all();

        // Apply per-row ACL filtering if needed
        let filteredResults = results;
        if (user && entityAclFilter && !entityAclFilter.useFilter) {
          filteredResults = filteredResults.filter(r => {
            const entityAclId = r.entity_acl_id as number | null;
            if (entityAclId === null) return true;
            return entityAclFilter.accessibleAclIds.has(entityAclId);
          });
        }
        if (user && linkAclFilter && !linkAclFilter.useFilter) {
          filteredResults = filteredResults.filter(r => {
            const linkAclId = r.link_acl_id as number | null;
            if (linkAclId === null) return true;
            return linkAclFilter.accessibleAclIds.has(linkAclId);
          });
        }

        for (const row of filteredResults) {
          const neighborId = row.entity_id as string;

          // Add the link
          links.push({
            id: row.link_id as string,
            type_id: row.link_type_id as string,
            type_name: (row.link_type_name as string) || 'Unknown',
            source_entity_id: row.source_entity_id as string,
            target_entity_id: row.target_entity_id as string,
            properties: row.link_properties ? JSON.parse(row.link_properties as string) : {},
            is_deleted: row.link_is_deleted === 1,
          });

          // Add the entity if we haven't seen it yet
          if (!entities.has(neighborId)) {
            entities.set(neighborId, {
              id: neighborId,
              type_id: row.entity_type_id as string,
              type_name: (row.entity_type_name as string) || 'Unknown',
              properties: row.entity_properties ? JSON.parse(row.entity_properties as string) : {},
              version: row.entity_version as number,
              created_at: row.entity_created_at as number,
              is_deleted: row.entity_is_deleted === 1,
              generation: current.generation + 1,
            });
            entityTypeIds.add(row.entity_type_id as string);

            // Add to queue for next iteration if not at max depth
            if (!processed.has(neighborId) && current.generation + 1 < maxDepth) {
              processed.add(neighborId);
              queue.push({ entityId: neighborId, generation: current.generation + 1 });
            }
          }
        }
      }
    }

    // Determine distinguishing properties for each entity type
    // Group entities by type
    const entitiesByType = new Map<string, GraphEntity[]>();
    for (const entity of entities.values()) {
      if (!entitiesByType.has(entity.type_id)) {
        entitiesByType.set(entity.type_id, []);
      }
      entitiesByType.get(entity.type_id)!.push(entity);
    }

    // For each type, find properties that help distinguish entities
    const distinguishingProperties = new Map<string, string[]>();
    const commonPropertyNames = ['name', 'title', 'label', 'email', 'username', 'status', 'code'];

    for (const [typeId, entitiesOfType] of entitiesByType) {
      const props: string[] = [];

      // Try common property names first
      for (const propName of commonPropertyNames) {
        // Check if this property exists in any entity of this type
        const hasProperty = entitiesOfType.some(e => e.properties[propName] !== undefined);
        if (hasProperty) {
          // Check if it has distinct values (helps distinguish entities)
          const values = new Set(
            entitiesOfType
              .map(e => JSON.stringify(e.properties[propName]))
              .filter(v => v !== 'undefined')
          );
          if (values.size > 1 || (values.size === 1 && entitiesOfType.length === 1)) {
            props.push(propName);
            if (props.length >= 2) break; // Limit to 2 properties
          }
        }
      }

      // If we didn't find any common properties, use the first property that exists
      if (props.length === 0 && entitiesOfType.length > 0) {
        const firstEntity = entitiesOfType[0];
        const availableProps = Object.keys(firstEntity.properties);
        if (availableProps.length > 0) {
          props.push(availableProps[0]);
        }
      }

      distinguishingProperties.set(typeId, props);
    }

    logger.info('Graph view data fetched', {
      entity_id: entityId,
      depth: maxDepth,
      entities_count: entities.size,
      links_count: links.length,
    });

    return c.json(
      response.success({
        center_entity: entities.get(centerEntity.id as string),
        entities: Array.from(entities.values()),
        links,
        distinguishing_properties: Object.fromEntries(distinguishingProperties),
        depth: maxDepth,
      })
    );
  } catch (error) {
    logger.error('Error fetching graph view data', error instanceof Error ? error : undefined);
    throw error;
  }
});

export default graph;
