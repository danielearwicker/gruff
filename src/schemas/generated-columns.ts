import { z } from 'zod';

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
  id: z.string(),
  table_name: tableNameSchema,
  column_name: z.string(),
  json_path: z.string(),
  data_type: dataTypeSchema,
  is_indexed: z.union([z.literal(0), z.literal(1)]),
  created_at: z.number().int(),
  created_by: z.string().nullable(),
  description: z.string().nullable(),
});

export type GeneratedColumn = z.infer<typeof generatedColumnSchema>;

/**
 * Schema for listing generated columns query parameters
 */
export const listGeneratedColumnsQuerySchema = z.object({
  table_name: tableNameSchema.optional(),
  is_indexed: z
    .string()
    .optional()
    .transform((val) => val === 'true' ? 1 : val === 'false' ? 0 : undefined)
    .pipe(z.union([z.literal(0), z.literal(1)]).optional()),
});

export type ListGeneratedColumnsQuery = z.infer<typeof listGeneratedColumnsQuerySchema>;

/**
 * Schema for the query optimization info endpoint
 * Returns information about which JSON paths have generated columns
 */
export const queryOptimizationInfoSchema = z.object({
  entities: z.array(z.object({
    column_name: z.string(),
    json_path: z.string(),
    data_type: dataTypeSchema,
    is_indexed: z.boolean(),
    description: z.string().nullable(),
  })),
  links: z.array(z.object({
    column_name: z.string(),
    json_path: z.string(),
    data_type: dataTypeSchema,
    is_indexed: z.boolean(),
    description: z.string().nullable(),
  })),
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
 * Schema for query plan analysis request body
 */
export const analyzeQueryPlanSchema = z.object({
  // Either provide a template or a custom SQL query
  template: queryTemplateSchema.optional(),
  // Parameters for the template (type_id, entity_id, property_path, etc.)
  parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  // Or provide a custom SQL query for analysis (restricted to SELECT statements)
  sql: z.string().optional(),
}).refine(
  (data) => data.template || data.sql,
  { message: 'Either template or sql must be provided' }
).refine(
  (data) => !(data.template && data.sql),
  { message: 'Cannot provide both template and sql' }
);

export type AnalyzeQueryPlanRequest = z.infer<typeof analyzeQueryPlanSchema>;

/**
 * Schema for query plan step from EXPLAIN QUERY PLAN
 */
export const queryPlanStepSchema = z.object({
  id: z.number(),
  parent: z.number(),
  notUsed: z.number().optional(),
  detail: z.string(),
});

export type QueryPlanStep = z.infer<typeof queryPlanStepSchema>;

/**
 * Schema for query plan analysis response
 */
export const queryPlanResponseSchema = z.object({
  sql: z.string(),
  template: queryTemplateSchema.optional(),
  plan: z.array(queryPlanStepSchema),
  analysis: z.object({
    uses_index: z.boolean(),
    indexes_used: z.array(z.string()),
    estimated_rows_scanned: z.string().optional(),
    has_table_scan: z.boolean(),
    tables_accessed: z.array(z.string()),
  }),
  recommendations: z.array(z.string()),
});

export type QueryPlanResponse = z.infer<typeof queryPlanResponseSchema>;
