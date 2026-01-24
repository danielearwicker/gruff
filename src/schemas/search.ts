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

// Types derived from schemas
export type SearchEntities = z.infer<typeof searchEntitiesSchema>;
export type SearchLinks = z.infer<typeof searchLinksSchema>;
