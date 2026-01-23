import { z } from 'zod';
import { uuidSchema, timestampSchema, sqliteBooleanSchema, jsonPropertiesSchema } from './common.js';

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

// Link creation schema
export const createLinkSchema = z.object({
  type_id: uuidSchema,
  source_entity_id: uuidSchema,
  target_entity_id: uuidSchema,
  properties: jsonPropertiesSchema.default({}),
});

// Link update schema
export const updateLinkSchema = z.object({
  properties: jsonPropertiesSchema,
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

// Link query filters
export const linkQuerySchema = z.object({
  type_id: uuidSchema.optional(),
  source_entity_id: uuidSchema.optional(),
  target_entity_id: uuidSchema.optional(),
  created_by: uuidSchema.optional(),
  created_after: timestampSchema.optional(),
  created_before: timestampSchema.optional(),
  include_deleted: z.boolean().optional().default(false),
});

// Types derived from schemas
export type Link = z.infer<typeof linkSchema>;
export type CreateLink = z.infer<typeof createLinkSchema>;
export type UpdateLink = z.infer<typeof updateLinkSchema>;
export type LinkResponse = z.infer<typeof linkResponseSchema>;
export type LinkQuery = z.infer<typeof linkQuerySchema>;
