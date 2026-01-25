import { z } from 'zod';
import {
  uuidSchema,
  timestampSchema,
  sqliteBooleanSchema,
  jsonPropertiesSchema,
  sanitizedJsonPropertiesSchema,
  paginationQuerySchema,
} from './common.js';

// Entity database model schema
export const entitySchema = z.object({
  id: uuidSchema,
  type_id: uuidSchema,
  properties: z.string(), // JSON stored as string
  version: z.number().int().positive(),
  previous_version_id: uuidSchema.nullable(),
  created_at: timestampSchema,
  created_by: uuidSchema,
  is_deleted: sqliteBooleanSchema,
  is_latest: sqliteBooleanSchema,
});

// Entity creation schema (with sanitization for XSS prevention)
export const createEntitySchema = z.object({
  type_id: uuidSchema,
  properties: sanitizedJsonPropertiesSchema.optional().default({}),
});

// Entity update schema (with sanitization for XSS prevention)
export const updateEntitySchema = z.object({
  properties: sanitizedJsonPropertiesSchema,
});

// Entity response schema (with parsed JSON properties)
export const entityResponseSchema = z.object({
  id: uuidSchema,
  type_id: uuidSchema,
  properties: jsonPropertiesSchema,
  version: z.number().int().positive(),
  previous_version_id: uuidSchema.nullable(),
  created_at: timestampSchema,
  created_by: uuidSchema,
  is_deleted: z.boolean(),
  is_latest: z.boolean(),
});

// Entity query filters (for query parameters - handles string coercion)
export const entityQuerySchema = paginationQuerySchema.extend({
  type_id: z.string().uuid().optional(),
  created_by: z.string().uuid().optional(),
  created_after: z
    .string()
    .transform(val => parseInt(val, 10))
    .pipe(z.number().int().positive())
    .optional(),
  created_before: z
    .string()
    .transform(val => parseInt(val, 10))
    .pipe(z.number().int().positive())
    .optional(),
});

// Entity restore schema
export const restoreEntitySchema = z.object({
  id: uuidSchema,
});

// Types derived from schemas
export type Entity = z.infer<typeof entitySchema>;
export type CreateEntity = z.infer<typeof createEntitySchema>;
export type UpdateEntity = z.infer<typeof updateEntitySchema>;
export type EntityResponse = z.infer<typeof entityResponseSchema>;
export type EntityQuery = z.infer<typeof entityQuerySchema>;
