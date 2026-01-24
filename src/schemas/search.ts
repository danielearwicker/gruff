import { z } from 'zod';
import { uuidSchema, jsonPropertiesSchema, paginationQuerySchema } from './common.js';

// Entity search request schema
export const searchEntitiesSchema = z.object({
  // Type filter
  type_id: uuidSchema.optional(),

  // Property filters - key-value pairs for equality matching
  properties: z.record(z.string(), z.any()).optional(),

  // Date range filters (Unix timestamps)
  created_after: z.number().int().positive().optional(),
  created_before: z.number().int().positive().optional(),

  // Creator filter
  created_by: uuidSchema.optional(),

  // Include deleted entities
  include_deleted: z.boolean().optional().default(false),

  // Pagination
  limit: z.number().int().positive().max(100).optional().default(20),
  cursor: z.string().optional(),
});

// Link search request schema
export const searchLinksSchema = z.object({
  // Type filter
  type_id: uuidSchema.optional(),

  // Entity filters
  source_entity_id: uuidSchema.optional(),
  target_entity_id: uuidSchema.optional(),

  // Property filters - key-value pairs for equality matching
  properties: z.record(z.string(), z.any()).optional(),

  // Date range filters (Unix timestamps)
  created_after: z.number().int().positive().optional(),
  created_before: z.number().int().positive().optional(),

  // Creator filter
  created_by: uuidSchema.optional(),

  // Include deleted links
  include_deleted: z.boolean().optional().default(false),

  // Pagination
  limit: z.number().int().positive().max(100).optional().default(20),
  cursor: z.string().optional(),
});

// Type-ahead suggestions schema (for query parameters)
export const suggestionsSchema = z.object({
  // Query string for partial matching
  query: z.string().min(1).max(100),

  // Property path to search (e.g., "name", "title", "properties.label")
  property_path: z.string().optional().default('name'),

  // Entity type filter
  type_id: uuidSchema.optional(),

  // Maximum number of suggestions to return (comes as string from query params)
  limit: z.string().optional().transform((val) => val ? parseInt(val, 10) : 10).pipe(z.number().int().positive().max(50)),
});

// Types derived from schemas
export type SearchEntities = z.infer<typeof searchEntitiesSchema>;
export type SearchLinks = z.infer<typeof searchLinksSchema>;
export type Suggestions = z.infer<typeof suggestionsSchema>;
