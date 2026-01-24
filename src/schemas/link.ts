import { z } from 'zod';
import { uuidSchema, timestampSchema, sqliteBooleanSchema, jsonPropertiesSchema, sanitizedJsonPropertiesSchema, paginationQuerySchema } from './common.js';

// Link database model schema
export const linkSchema = z.object({
  id: uuidSchema,
  type_id: uuidSchema,
  source_entity_id: uuidSchema,
  target_entity_id: uuidSchema,
  properties: z.string(), // JSON stored as string
  version: z.number().int().positive(),
  previous_version_id: uuidSchema.nullable(),
  created_at: timestampSchema,
  created_by: uuidSchema,
  is_deleted: sqliteBooleanSchema,
  is_latest: sqliteBooleanSchema,
});

// Link creation schema (with sanitization for XSS prevention)
export const createLinkSchema = z.object({
  type_id: uuidSchema,
  source_entity_id: uuidSchema,
  target_entity_id: uuidSchema,
  properties: sanitizedJsonPropertiesSchema.default({}),
});

// Link update schema (with sanitization for XSS prevention)
export const updateLinkSchema = z.object({
  properties: sanitizedJsonPropertiesSchema,
});

// Link response schema (with parsed JSON properties)
export const linkResponseSchema = z.object({
  id: uuidSchema,
  type_id: uuidSchema,
  source_entity_id: uuidSchema,
  target_entity_id: uuidSchema,
  properties: jsonPropertiesSchema,
  version: z.number().int().positive(),
  previous_version_id: uuidSchema.nullable(),
  created_at: timestampSchema,
  created_by: uuidSchema,
  is_deleted: z.boolean(),
  is_latest: z.boolean(),
});

// Link query filters (for query parameters - handles string coercion)
export const linkQuerySchema = paginationQuerySchema.extend({
  type_id: z.string().uuid().optional(),
  source_entity_id: z.string().uuid().optional(),
  target_entity_id: z.string().uuid().optional(),
  created_by: z.string().uuid().optional(),
  created_after: z
    .string()
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().positive())
    .optional(),
  created_before: z
    .string()
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().positive())
    .optional(),
});

// Types derived from schemas
export type Link = z.infer<typeof linkSchema>;
export type CreateLink = z.infer<typeof createLinkSchema>;
export type UpdateLink = z.infer<typeof updateLinkSchema>;
export type LinkResponse = z.infer<typeof linkResponseSchema>;
export type LinkQuery = z.infer<typeof linkQuerySchema>;
