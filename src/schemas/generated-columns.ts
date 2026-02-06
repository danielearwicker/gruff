import { z } from '@hono/zod-openapi';

/**
 * Valid table names that can have generated columns
 */
export const tableNameSchema = z.enum(['entities', 'links']);

/**
 * Valid data types for generated columns
 */
export const dataTypeSchema = z.enum(['TEXT', 'INTEGER', 'REAL', 'BOOLEAN']);

/**
 * Schema for a generated column record
 */
export const generatedColumnSchema = z.object({
  id: z.string().openapi({ example: 'gc_001' }),
  table_name: tableNameSchema.openapi({ example: 'entities' }),
  column_name: z.string().openapi({ example: 'prop_name' }),
  json_path: z.string().openapi({ example: '$.name' }),
  data_type: dataTypeSchema.openapi({ example: 'TEXT' }),
  is_indexed: z.union([z.literal(0), z.literal(1)]).openapi({ example: 1 }),
  created_at: z.number().int().openapi({ example: 1704067200 }),
  created_by: z.string().nullable().openapi({ example: null }),
  description: z.string().nullable().openapi({ example: 'Name property column' }),
});

export type GeneratedColumn = z.infer<typeof generatedColumnSchema>;

/**
 * Schema for listing generated columns query parameters
 */
export const listGeneratedColumnsQuerySchema = z.object({
  table_name: tableNameSchema.optional().openapi({
    param: { name: 'table_name', in: 'query' },
    example: 'entities',
    description: 'Filter by table name',
  }),
  is_indexed: z
    .string()
    .optional()
    .openapi({
      param: { name: 'is_indexed', in: 'query' },
      example: 'true',
      description: 'Filter by indexed status (true or false)',
    })
    .transform(val => (val === 'true' ? 1 : val === 'false' ? 0 : undefined))
    .pipe(z.union([z.literal(0), z.literal(1)]).optional()),
});

export type ListGeneratedColumnsQuery = z.infer<typeof listGeneratedColumnsQuerySchema>;

/**
 * Schema for the query optimization info endpoint
 * Returns information about which JSON paths have generated columns
 */
export const queryOptimizationInfoSchema = z.object({
  entities: z.array(
    z.object({
      column_name: z.string().openapi({ example: 'prop_name' }),
      json_path: z.string().openapi({ example: '$.name' }),
      data_type: dataTypeSchema.openapi({ example: 'TEXT' }),
      is_indexed: z.boolean().openapi({ example: true }),
      description: z.string().nullable().openapi({ example: 'Name property column' }),
    })
  ),
  links: z.array(
    z.object({
      column_name: z.string().openapi({ example: 'prop_role' }),
      json_path: z.string().openapi({ example: '$.role' }),
      data_type: dataTypeSchema.openapi({ example: 'TEXT' }),
      is_indexed: z.boolean().openapi({ example: true }),
      description: z.string().nullable().openapi({ example: 'Role property column' }),
    })
  ),
});

export type QueryOptimizationInfo = z.infer<typeof queryOptimizationInfoSchema>;

/**
 * Predefined query templates for common operations
 */
export const queryTemplateSchema = z.enum([
  'entity_by_id',
  'entity_by_type',
  'entity_by_property',
  'links_by_source',
  'links_by_target',
  'links_by_type',
  'neighbors_outbound',
  'neighbors_inbound',
  'search_entities',
  'search_links',
]);

export type QueryTemplate = z.infer<typeof queryTemplateSchema>;

/**
 * Schema for query plan analysis request body (base object, without refinements, for OpenAPI)
 */
export const analyzeQueryPlanBodySchema = z.object({
  template: queryTemplateSchema.optional().openapi({
    description: 'Name of a predefined query template (e.g., entity_by_type)',
    example: 'entity_by_type',
  }),
  parameters: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .openapi({
      description: 'Parameters for the template (type_id, entity_id, property_path, etc.)',
      example: { type_id: 'your-type-uuid' },
    }),
  sql: z.string().optional().openapi({
    description: 'Custom SQL query to analyze (SELECT statements only)',
    example: 'SELECT * FROM entities WHERE is_latest = 1 LIMIT 10',
  }),
});

/**
 * Schema for query plan analysis request body (with refinements, for runtime validation)
 */
export const analyzeQueryPlanSchema = analyzeQueryPlanBodySchema
  .refine(data => data.template || data.sql, { message: 'Either template or sql must be provided' })
  .refine(data => !(data.template && data.sql), {
    message: 'Cannot provide both template and sql',
  });

export type AnalyzeQueryPlanRequest = z.infer<typeof analyzeQueryPlanSchema>;

/**
 * Schema for query plan step from EXPLAIN QUERY PLAN
 */
export const queryPlanStepSchema = z.object({
  id: z.number().openapi({ example: 0 }),
  parent: z.number().openapi({ example: 0 }),
  notUsed: z.number().optional(),
  detail: z
    .string()
    .openapi({ example: 'SEARCH entities USING INDEX idx_entities_type_latest_deleted' }),
});

export type QueryPlanStep = z.infer<typeof queryPlanStepSchema>;

/**
 * Schema for query plan analysis response
 */
export const queryPlanResponseSchema = z.object({
  sql: z
    .string()
    .openapi({ example: 'SELECT e.* FROM entities e WHERE e.type_id = ? AND e.is_latest = 1' }),
  template: queryTemplateSchema.optional().openapi({ example: 'entity_by_type' }),
  plan: z.array(queryPlanStepSchema),
  analysis: z.object({
    uses_index: z.boolean().openapi({ example: true }),
    indexes_used: z.array(z.string()).openapi({ example: ['idx_entities_type_latest_deleted'] }),
    estimated_rows_scanned: z.string().optional(),
    has_table_scan: z.boolean().openapi({ example: false }),
    tables_accessed: z.array(z.string()).openapi({ example: ['entities'] }),
  }),
  recommendations: z.array(z.string()).openapi({
    example: ['Query is well-optimized, using index(es): idx_entities_type_latest_deleted'],
  }),
});

export type QueryPlanResponse = z.infer<typeof queryPlanResponseSchema>;
