import { z } from '@hono/zod-openapi';
import { uuidSchema, typeIdSchema, sanitizedJsonPropertiesSchema } from './common.js';

// Maximum number of items in a single bulk operation (to prevent abuse and stay within D1 limits)
export const MAX_BULK_ITEMS = 100;

// Schema for a single entity in bulk create (with sanitization for XSS prevention)
export const bulkCreateEntityItemSchema = z
  .object({
    type_id: typeIdSchema.openapi({ example: 'Person' }),
    properties: sanitizedJsonPropertiesSchema
      .optional()
      .default({})
      .openapi({ example: { name: 'John Doe', age: 30 } }),
    client_id: z.string().optional().openapi({
      description: 'Optional client-provided ID for reference in response',
      example: 'client-1',
    }),
  })
  .openapi('BulkCreateEntityItem');

// Schema for bulk create entities request
export const bulkCreateEntitiesSchema = z
  .object({
    entities: z
      .array(bulkCreateEntityItemSchema)
      .min(1, 'At least one entity is required')
      .max(MAX_BULK_ITEMS, `Maximum ${MAX_BULK_ITEMS} entities per request`)
      .openapi({ description: 'Array of entities to create (1-100)' }),
  })
  .openapi('BulkCreateEntities');

// Schema for a single link in bulk create (with sanitization for XSS prevention)
export const bulkCreateLinkItemSchema = z
  .object({
    type_id: typeIdSchema.openapi({ example: 'knows' }),
    source_entity_id: uuidSchema.openapi({ example: '550e8400-e29b-41d4-a716-446655440000' }),
    target_entity_id: uuidSchema.openapi({ example: '550e8400-e29b-41d4-a716-446655440001' }),
    properties: sanitizedJsonPropertiesSchema
      .optional()
      .default({})
      .openapi({ example: { since: '2024-01-01' } }),
    client_id: z.string().optional().openapi({
      description: 'Optional client-provided ID for reference in response',
      example: 'client-1',
    }),
  })
  .openapi('BulkCreateLinkItem');

// Schema for bulk create links request
export const bulkCreateLinksSchema = z
  .object({
    links: z
      .array(bulkCreateLinkItemSchema)
      .min(1, 'At least one link is required')
      .max(MAX_BULK_ITEMS, `Maximum ${MAX_BULK_ITEMS} links per request`)
      .openapi({ description: 'Array of links to create (1-100)' }),
  })
  .openapi('BulkCreateLinks');

// Schema for a single entity update in bulk update (with sanitization for XSS prevention)
export const bulkUpdateEntityItemSchema = z
  .object({
    id: uuidSchema.openapi({ example: '550e8400-e29b-41d4-a716-446655440000' }),
    properties: sanitizedJsonPropertiesSchema.openapi({ example: { name: 'Jane Doe', age: 31 } }),
  })
  .openapi('BulkUpdateEntityItem');

// Schema for bulk update entities request
export const bulkUpdateEntitiesSchema = z
  .object({
    entities: z
      .array(bulkUpdateEntityItemSchema)
      .min(1, 'At least one entity is required')
      .max(MAX_BULK_ITEMS, `Maximum ${MAX_BULK_ITEMS} entities per request`)
      .openapi({ description: 'Array of entities to update (1-100)' }),
  })
  .openapi('BulkUpdateEntities');

// Schema for a single link update in bulk update (with sanitization for XSS prevention)
export const bulkUpdateLinkItemSchema = z
  .object({
    id: uuidSchema.openapi({ example: '550e8400-e29b-41d4-a716-446655440000' }),
    properties: sanitizedJsonPropertiesSchema.openapi({ example: { since: '2024-06-01' } }),
  })
  .openapi('BulkUpdateLinkItem');

// Schema for bulk update links request
export const bulkUpdateLinksSchema = z
  .object({
    links: z
      .array(bulkUpdateLinkItemSchema)
      .min(1, 'At least one link is required')
      .max(MAX_BULK_ITEMS, `Maximum ${MAX_BULK_ITEMS} links per request`)
      .openapi({ description: 'Array of links to update (1-100)' }),
  })
  .openapi('BulkUpdateLinks');

// Result item for bulk create operations
export const bulkCreateResultItemSchema = z
  .object({
    index: z.number().int().min(0).openapi({ example: 0 }),
    success: z.boolean().openapi({ example: true }),
    id: uuidSchema.optional().openapi({ example: '550e8400-e29b-41d4-a716-446655440000' }),
    client_id: z.string().optional().openapi({ example: 'client-1' }),
    error: z.string().optional().openapi({ example: 'Type not found' }),
    code: z.string().optional().openapi({ example: 'TYPE_NOT_FOUND' }),
  })
  .openapi('BulkCreateResultItem');

// Result item for bulk update operations
export const bulkUpdateResultItemSchema = z
  .object({
    index: z.number().int().min(0).openapi({ example: 0 }),
    success: z.boolean().openapi({ example: true }),
    id: uuidSchema.optional().openapi({ example: '550e8400-e29b-41d4-a716-446655440000' }),
    version: z.number().int().positive().optional().openapi({ example: 2 }),
    error: z.string().optional().openapi({ example: 'Entity not found' }),
    code: z.string().optional().openapi({ example: 'NOT_FOUND' }),
  })
  .openapi('BulkUpdateResultItem');

// Summary schema for bulk operation responses
export const bulkSummarySchema = z
  .object({
    total: z.number().int().min(0).openapi({ example: 5 }),
    successful: z.number().int().min(0).openapi({ example: 4 }),
    failed: z.number().int().min(0).openapi({ example: 1 }),
  })
  .openapi('BulkSummary');

// Response schemas for bulk operations
export const bulkCreateResponseSchema = z
  .object({
    results: z.array(bulkCreateResultItemSchema),
    summary: bulkSummarySchema,
  })
  .openapi('BulkCreateResponse');

export const bulkUpdateResponseSchema = z
  .object({
    results: z.array(bulkUpdateResultItemSchema),
    summary: bulkSummarySchema,
  })
  .openapi('BulkUpdateResponse');

// Types derived from schemas
export type BulkCreateEntityItem = z.infer<typeof bulkCreateEntityItemSchema>;
export type BulkCreateEntities = z.infer<typeof bulkCreateEntitiesSchema>;
export type BulkCreateLinkItem = z.infer<typeof bulkCreateLinkItemSchema>;
export type BulkCreateLinks = z.infer<typeof bulkCreateLinksSchema>;
export type BulkUpdateEntityItem = z.infer<typeof bulkUpdateEntityItemSchema>;
export type BulkUpdateEntities = z.infer<typeof bulkUpdateEntitiesSchema>;
export type BulkUpdateLinkItem = z.infer<typeof bulkUpdateLinkItemSchema>;
export type BulkUpdateLinks = z.infer<typeof bulkUpdateLinksSchema>;
export type BulkCreateResultItem = z.infer<typeof bulkCreateResultItemSchema>;
export type BulkUpdateResultItem = z.infer<typeof bulkUpdateResultItemSchema>;
export type BulkSummary = z.infer<typeof bulkSummarySchema>;
export type BulkCreateResponse = z.infer<typeof bulkCreateResponseSchema>;
export type BulkUpdateResponse = z.infer<typeof bulkUpdateResponseSchema>;
