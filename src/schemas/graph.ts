import { z } from '@hono/zod-openapi';
import { uuidSchema } from './common.js';

// Schema for multi-hop traversal request body
export const traverseSchema = z
  .object({
    start_entity_id: uuidSchema.openapi({
      example: '550e8400-e29b-41d4-a716-446655440000',
      description: 'Starting entity ID for traversal',
    }),
    max_depth: z.number().int().min(1).max(10).default(3).openapi({
      example: 3,
      description: 'Maximum traversal depth (1-10)',
    }),
    direction: z.enum(['outbound', 'inbound', 'both']).default('outbound').openapi({
      example: 'outbound',
      description: 'Direction of traversal',
    }),
    link_type_ids: z
      .array(z.string().uuid('Link type ID must be a valid UUID'))
      .optional()
      .openapi({
        description: 'Filter by link type IDs',
      }),
    entity_type_ids: z
      .array(z.string().uuid('Entity type ID must be a valid UUID'))
      .optional()
      .openapi({
        description: 'Filter by entity type IDs',
      }),
    include_deleted: z.boolean().default(false).openapi({
      example: false,
      description: 'Include soft-deleted entities and links',
    }),
    return_paths: z.boolean().default(false).openapi({
      example: false,
      description: 'Whether to return the paths that led to each entity',
    }),
  })
  .openapi('TraversalRequest');

// Schema for shortest path query parameters
export const shortestPathSchema = z.object({
  from: z
    .string()
    .uuid('Source entity ID must be a valid UUID')
    .openapi({
      param: { name: 'from', in: 'query' },
      example: '550e8400-e29b-41d4-a716-446655440000',
      description: 'Source entity ID',
    }),
  to: z
    .string()
    .uuid('Target entity ID must be a valid UUID')
    .openapi({
      param: { name: 'to', in: 'query' },
      example: '550e8400-e29b-41d4-a716-446655440001',
      description: 'Target entity ID',
    }),
  type_id: z
    .string()
    .uuid('Link type ID must be a valid UUID')
    .optional()
    .openapi({
      param: { name: 'type_id', in: 'query' },
      example: '550e8400-e29b-41d4-a716-446655440100',
      description: 'Filter by link type ID',
    }),
  include_deleted: z
    .enum(['true', 'false'])
    .optional()
    .default('false')
    .openapi({
      param: { name: 'include_deleted', in: 'query' },
      example: 'false',
      description: 'Include soft-deleted entities and links',
    }),
  max_depth: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(10))
    .optional()
    .default(10)
    .openapi({
      param: { name: 'max_depth', in: 'query' },
      example: '10',
      description: 'Maximum path length (1-10, default: 10)',
    }),
});

// Schema for graph-view query parameters
export const graphViewSchema = z.object({
  depth: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(5))
    .optional()
    .default(2)
    .openapi({
      param: { name: 'depth', in: 'query' },
      example: '2',
      description: 'Number of generations to fetch (1-5, default: 2)',
    }),
  include_deleted: z
    .enum(['true', 'false'])
    .optional()
    .default('false')
    .openapi({
      param: { name: 'include_deleted', in: 'query' },
      example: 'false',
      description: 'Include soft-deleted entities and links',
    }),
});

// Types derived from schemas
export type TraversalRequest = z.infer<typeof traverseSchema>;
export type ShortestPathQuery = z.infer<typeof shortestPathSchema>;
export type GraphViewQuery = z.infer<typeof graphViewSchema>;
