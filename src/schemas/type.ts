import { z } from 'zod';
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
export const typeSchema = z.object({
  id: typeIdSchema,
  name: z.string().min(1).max(255),
  category: typeCategorySchema,
  description: z.string().nullable(),
  json_schema: z.string().nullable(), // JSON stored as string
  created_at: timestampSchema,
  created_by: uuidSchema,
});

// Type creation schema (with sanitization for XSS prevention)
export const createTypeSchema = z.object({
  name: z
    .string()
    .min(1, 'Name is required')
    .max(255, 'Name must be at most 255 characters')
    .transform(val => escapeHtml(val)),
  category: typeCategorySchema,
  description: sanitizedStringSchema(1000).optional(),
  json_schema: jsonPropertiesSchema.optional(), // Will be stringified before storing
});

// Type update schema (with sanitization for XSS prevention)
export const updateTypeSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(255)
    .transform(val => escapeHtml(val))
    .optional(),
  description: sanitizedStringSchema(1000).nullable().optional(),
  json_schema: jsonPropertiesSchema.nullable().optional(),
});

// Type query filters (for query parameters - handles string coercion)
export const typeQuerySchema = paginationQuerySchema.extend({
  category: typeCategorySchema.optional(),
  name: z.string().optional(),
});

// Types derived from schemas
export type Type = z.infer<typeof typeSchema>;
export type CreateType = z.infer<typeof createTypeSchema>;
export type UpdateType = z.infer<typeof updateTypeSchema>;
export type TypeCategory = z.infer<typeof typeCategorySchema>;
export type TypeQuery = z.infer<typeof typeQuerySchema>;
