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

// Entity database model schema
export const entitySchema = z
  .object({
    id: uuidSchema.openapi({ example: '550e8400-e29b-41d4-a716-446655440000' }),
    type_id: typeIdSchema.openapi({ example: 'Person' }),
    properties: z.string().openapi({ description: 'JSON stored as string' }),
    version: z.number().int().positive().openapi({ example: 1 }),
    previous_version_id: uuidSchema.nullable().openapi({ example: null }),
    created_at: timestampSchema.openapi({ example: 1704067200 }),
    created_by: uuidSchema.openapi({ example: '550e8400-e29b-41d4-a716-446655440001' }),
    is_deleted: sqliteBooleanSchema.openapi({ example: 0 }),
    is_latest: sqliteBooleanSchema.openapi({ example: 1 }),
  })
  .openapi('EntityDb');

// Entity creation schema (with sanitization for XSS prevention)
export const createEntitySchema = z
  .object({
    type_id: typeIdSchema.openapi({ example: 'Person' }),
    properties: sanitizedJsonPropertiesSchema
      .optional()
      .default({})
      .openapi({ example: { name: 'John Doe', age: 30 } }),
    // Optional ACL to set at creation time
    // If not provided, creator will get write permission by default
    // If empty array is provided, resource will be public (no ACL)
    acl: z
      .array(aclEntrySchema)
      .max(100, 'Maximum 100 ACL entries allowed')
      .optional()
      .openapi({ description: 'Optional ACL entries. If omitted, creator gets write permission.' }),
  })
  .openapi('CreateEntity');

// Entity update schema (with sanitization for XSS prevention)
export const updateEntitySchema = z
  .object({
    properties: sanitizedJsonPropertiesSchema.openapi({ example: { name: 'Jane Doe', age: 31 } }),
  })
  .openapi('UpdateEntity');

// Entity response schema (with parsed JSON properties)
export const entityResponseSchema = z
  .object({
    id: uuidSchema.openapi({ example: '550e8400-e29b-41d4-a716-446655440000' }),
    type_id: typeIdSchema.openapi({ example: 'Person' }),
    properties: jsonPropertiesSchema.openapi({ example: { name: 'John Doe', age: 30 } }),
    version: z.number().int().positive().openapi({ example: 1 }),
    previous_version_id: uuidSchema.nullable().openapi({ example: null }),
    created_at: timestampSchema.openapi({ example: 1704067200 }),
    created_by: uuidSchema.openapi({ example: '550e8400-e29b-41d4-a716-446655440001' }),
    is_deleted: z.boolean().openapi({ example: false }),
    is_latest: z.boolean().openapi({ example: true }),
  })
  .openapi('Entity');

// Entity query filters (for query parameters - handles string coercion)
export const entityQuerySchema = paginationQuerySchema.extend({
  type_id: z
    .string()
    .optional()
    .openapi({
      param: { name: 'type_id', in: 'query' },
      example: 'Person',
    }),
  created_by: z
    .string()
    .uuid()
    .optional()
    .openapi({
      param: { name: 'created_by', in: 'query' },
      example: '550e8400-e29b-41d4-a716-446655440001',
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

// Entity restore schema
export const restoreEntitySchema = z
  .object({
    id: uuidSchema.openapi({ example: '550e8400-e29b-41d4-a716-446655440000' }),
  })
  .openapi('RestoreEntity');

// Types derived from schemas
export type Entity = z.infer<typeof entitySchema>;
export type CreateEntity = z.infer<typeof createEntitySchema>;
export type UpdateEntity = z.infer<typeof updateEntitySchema>;
export type EntityResponse = z.infer<typeof entityResponseSchema>;
export type EntityQuery = z.infer<typeof entityQuerySchema>;
