import { z } from '@hono/zod-openapi';
import {
  uuidSchema,
  typeIdSchema,
  timestampSchema,
  sqliteBooleanSchema,
  jsonPropertiesSchema,
  sanitizedJsonPropertiesSchema,
  paginationQuerySchema,
} from './common.js';
import { aclEntrySchema } from './acl.js';

// Link database model schema
export const linkSchema = z
  .object({
    id: uuidSchema.openapi({ example: '550e8400-e29b-41d4-a716-446655440100' }),
    type_id: typeIdSchema.openapi({ example: 'knows' }),
    source_entity_id: uuidSchema.openapi({ example: '550e8400-e29b-41d4-a716-446655440000' }),
    target_entity_id: uuidSchema.openapi({ example: '550e8400-e29b-41d4-a716-446655440001' }),
    properties: z.string().openapi({ description: 'JSON stored as string' }),
    version: z.number().int().positive().openapi({ example: 1 }),
    previous_version_id: uuidSchema.nullable().openapi({ example: null }),
    created_at: timestampSchema.openapi({ example: 1704067200 }),
    created_by: uuidSchema.openapi({ example: '550e8400-e29b-41d4-a716-446655440002' }),
    is_deleted: sqliteBooleanSchema.openapi({ example: 0 }),
    is_latest: sqliteBooleanSchema.openapi({ example: 1 }),
  })
  .openapi('LinkDb');

// Link creation schema (with sanitization for XSS prevention)
export const createLinkSchema = z
  .object({
    type_id: typeIdSchema.openapi({ example: 'knows' }),
    source_entity_id: uuidSchema.openapi({ example: '550e8400-e29b-41d4-a716-446655440000' }),
    target_entity_id: uuidSchema.openapi({ example: '550e8400-e29b-41d4-a716-446655440001' }),
    properties: sanitizedJsonPropertiesSchema
      .default({})
      .openapi({ example: { since: '2024-01-01', strength: 'strong' } }),
    // Optional ACL to set at creation time
    // If not provided, creator will get write permission by default
    // If empty array is provided, resource will be public (no ACL)
    acl: z
      .array(aclEntrySchema)
      .max(100, 'Maximum 100 ACL entries allowed')
      .optional()
      .openapi({ description: 'Optional ACL entries. If omitted, creator gets write permission.' }),
  })
  .openapi('CreateLink');

// Link update schema (with sanitization for XSS prevention)
export const updateLinkSchema = z
  .object({
    properties: sanitizedJsonPropertiesSchema.openapi({
      example: { since: '2024-01-01', strength: 'weak' },
    }),
  })
  .openapi('UpdateLink');

// Link response schema (with parsed JSON properties)
export const linkResponseSchema = z
  .object({
    id: uuidSchema.openapi({ example: '550e8400-e29b-41d4-a716-446655440100' }),
    type_id: typeIdSchema.openapi({ example: 'knows' }),
    source_entity_id: uuidSchema.openapi({ example: '550e8400-e29b-41d4-a716-446655440000' }),
    target_entity_id: uuidSchema.openapi({ example: '550e8400-e29b-41d4-a716-446655440001' }),
    properties: jsonPropertiesSchema.openapi({
      example: { since: '2024-01-01', strength: 'strong' },
    }),
    version: z.number().int().positive().openapi({ example: 1 }),
    previous_version_id: uuidSchema.nullable().openapi({ example: null }),
    created_at: timestampSchema.openapi({ example: 1704067200 }),
    created_by: uuidSchema.openapi({ example: '550e8400-e29b-41d4-a716-446655440002' }),
    is_deleted: z.boolean().openapi({ example: false }),
    is_latest: z.boolean().openapi({ example: true }),
  })
  .openapi('Link');

// Link query filters (for query parameters - handles string coercion)
export const linkQuerySchema = paginationQuerySchema.extend({
  type_id: z
    .string()
    .optional()
    .openapi({
      param: { name: 'type_id', in: 'query' },
      example: 'knows',
    }),
  source_entity_id: z
    .string()
    .uuid()
    .optional()
    .openapi({
      param: { name: 'source_entity_id', in: 'query' },
      example: '550e8400-e29b-41d4-a716-446655440000',
    }),
  target_entity_id: z
    .string()
    .uuid()
    .optional()
    .openapi({
      param: { name: 'target_entity_id', in: 'query' },
      example: '550e8400-e29b-41d4-a716-446655440001',
    }),
  created_by: z
    .string()
    .uuid()
    .optional()
    .openapi({
      param: { name: 'created_by', in: 'query' },
      example: '550e8400-e29b-41d4-a716-446655440002',
    }),
  created_after: z
    .string()
    .transform(val => parseInt(val, 10))
    .pipe(z.number().int().positive())
    .optional()
    .openapi({
      param: { name: 'created_after', in: 'query' },
      example: '1704067200',
    }),
  created_before: z
    .string()
    .transform(val => parseInt(val, 10))
    .pipe(z.number().int().positive())
    .optional()
    .openapi({
      param: { name: 'created_before', in: 'query' },
      example: '1704153600',
    }),
});

// Types derived from schemas
export type Link = z.infer<typeof linkSchema>;
export type CreateLink = z.infer<typeof createLinkSchema>;
export type UpdateLink = z.infer<typeof updateLinkSchema>;
export type LinkResponse = z.infer<typeof linkResponseSchema>;
export type LinkQuery = z.infer<typeof linkQuerySchema>;
