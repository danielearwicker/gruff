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
