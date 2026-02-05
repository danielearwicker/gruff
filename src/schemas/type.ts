import { z } from '@hono/zod-openapi';
import {
  uuidSchema,
  typeIdSchema,
  timestampSchema,
  jsonPropertiesSchema,
  paginationQuerySchema,
} from './common.js';
import { escapeHtml } from '../utils/sanitize.js';

// Type category enum
export const typeCategorySchema = z.enum(['entity', 'link']);

// Sanitized string schema for user-provided text fields
const sanitizedStringSchema = (maxLength: number) =>
  z
    .string()
    .max(maxLength)
    .transform(val => escapeHtml(val));

// Type database model schema
export const typeSchema = z
  .object({
    id: typeIdSchema.openapi({ example: '550e8400-e29b-41d4-a716-446655440000' }),
    name: z.string().min(1).max(255).openapi({ example: 'Person' }),
    category: typeCategorySchema.openapi({ example: 'entity' }),
    description: z.string().nullable().openapi({ example: 'A person entity type' }),
    json_schema: z.string().nullable().openapi({ description: 'JSON Schema stored as string' }),
    created_at: timestampSchema.openapi({ example: 1704067200 }),
    created_by: uuidSchema.openapi({ example: '550e8400-e29b-41d4-a716-446655440001' }),
  })
  .openapi('Type');

// Type creation schema (with sanitization for XSS prevention)
export const createTypeSchema = z
  .object({
    name: z
      .string()
      .min(1, 'Name is required')
      .max(255, 'Name must be at most 255 characters')
      .transform(val => escapeHtml(val))
      .openapi({ example: 'Person' }),
    category: typeCategorySchema.openapi({ example: 'entity' }),
    description: sanitizedStringSchema(1000)
      .optional()
      .openapi({ example: 'A person entity type' }),
    json_schema: jsonPropertiesSchema
      .optional()
      .openapi({ description: 'JSON Schema for property validation' }),
  })
  .openapi('CreateType');

// Type update schema (with sanitization for XSS prevention)
export const updateTypeSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(255)
      .transform(val => escapeHtml(val))
      .optional()
      .openapi({ example: 'Person' }),
    description: sanitizedStringSchema(1000)
      .nullable()
      .optional()
      .openapi({ example: 'A person entity type' }),
    json_schema: jsonPropertiesSchema
      .nullable()
      .optional()
      .openapi({ description: 'JSON Schema for property validation' }),
  })
  .openapi('UpdateType');

// Type query filters (for query parameters - handles string coercion)
export const typeQuerySchema = paginationQuerySchema.extend({
  category: typeCategorySchema.optional().openapi({
    param: { name: 'category', in: 'query' },
    example: 'entity',
  }),
  name: z
    .string()
    .optional()
    .openapi({
      param: { name: 'name', in: 'query' },
      example: 'Person',
    }),
});

// Types derived from schemas
export type Type = z.infer<typeof typeSchema>;
export type CreateType = z.infer<typeof createTypeSchema>;
export type UpdateType = z.infer<typeof updateTypeSchema>;
export type TypeCategory = z.infer<typeof typeCategorySchema>;
export type TypeQuery = z.infer<typeof typeQuerySchema>;
