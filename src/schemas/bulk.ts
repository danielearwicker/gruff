import { z } from 'zod';
import { uuidSchema, typeIdSchema, sanitizedJsonPropertiesSchema } from './common.js';

// Maximum number of items in a single bulk operation (to prevent abuse and stay within D1 limits)
export const MAX_BULK_ITEMS = 100;

// Schema for a single entity in bulk create (with sanitization for XSS prevention)
export const bulkCreateEntityItemSchema = z.object({
  type_id: typeIdSchema,
  properties: sanitizedJsonPropertiesSchema.optional().default({}),
  // Optional client-provided ID for reference in response
  client_id: z.string().optional(),
});

// Schema for bulk create entities request
export const bulkCreateEntitiesSchema = z.object({
  entities: z
    .array(bulkCreateEntityItemSchema)
    .min(1, 'At least one entity is required')
    .max(MAX_BULK_ITEMS, `Maximum ${MAX_BULK_ITEMS} entities per request`),
});

// Schema for a single link in bulk create (with sanitization for XSS prevention)
export const bulkCreateLinkItemSchema = z.object({
  type_id: typeIdSchema,
  source_entity_id: uuidSchema,
  target_entity_id: uuidSchema,
  properties: sanitizedJsonPropertiesSchema.optional().default({}),
  // Optional client-provided ID for reference in response
  client_id: z.string().optional(),
});

// Schema for bulk create links request
export const bulkCreateLinksSchema = z.object({
  links: z
    .array(bulkCreateLinkItemSchema)
    .min(1, 'At least one link is required')
    .max(MAX_BULK_ITEMS, `Maximum ${MAX_BULK_ITEMS} links per request`),
});

// Schema for a single entity update in bulk update (with sanitization for XSS prevention)
export const bulkUpdateEntityItemSchema = z.object({
  id: uuidSchema,
  properties: sanitizedJsonPropertiesSchema,
});

// Schema for bulk update entities request
export const bulkUpdateEntitiesSchema = z.object({
  entities: z
    .array(bulkUpdateEntityItemSchema)
    .min(1, 'At least one entity is required')
    .max(MAX_BULK_ITEMS, `Maximum ${MAX_BULK_ITEMS} entities per request`),
});

// Schema for a single link update in bulk update (with sanitization for XSS prevention)
export const bulkUpdateLinkItemSchema = z.object({
  id: uuidSchema,
  properties: sanitizedJsonPropertiesSchema,
});

// Schema for bulk update links request
export const bulkUpdateLinksSchema = z.object({
  links: z
    .array(bulkUpdateLinkItemSchema)
    .min(1, 'At least one link is required')
    .max(MAX_BULK_ITEMS, `Maximum ${MAX_BULK_ITEMS} links per request`),
});

// Result item for bulk create operations
export const bulkCreateResultItemSchema = z.object({
  index: z.number().int().min(0),
  success: z.boolean(),
  id: uuidSchema.optional(),
  client_id: z.string().optional(),
  error: z.string().optional(),
  code: z.string().optional(),
});

// Result item for bulk update operations
export const bulkUpdateResultItemSchema = z.object({
  index: z.number().int().min(0),
  success: z.boolean(),
  id: uuidSchema.optional(),
  version: z.number().int().positive().optional(),
  error: z.string().optional(),
  code: z.string().optional(),
});

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
