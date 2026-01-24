import { z } from 'zod';
import { uuidSchema, jsonPropertiesSchema, paginationQuerySchema } from './common.js';

/**
 * Property filter schema with comparison operators
 *
 * Supported path formats:
 * - Simple properties: "name", "age"
 * - Nested properties (dot notation): "address.city", "user.profile.name"
 * - Array indices (bracket notation): "tags[0]", "items[2]"
 * - Array indices (dot notation): "tags.0", "items.2"
 * - Mixed paths: "users[0].address.city", "data.items[1].value", "orders.0.items.1.name"
 *
 * Examples:
 * - Equality: { path: "name", operator: "eq", value: "John" }
 * - Greater than: { path: "age", operator: "gt", value: 18 }
 * - Nested property: { path: "address.city", operator: "eq", value: "New York" }
 * - Array element: { path: "tags[0]", operator: "eq", value: "featured" }
 * - Array element (dot): { path: "tags.0", operator: "eq", value: "featured" }
 * - Deep nested: { path: "users[0].profile.name", operator: "contains", value: "John" }
 * - Pattern match: { path: "email", operator: "like", value: "%@example.com" }
 * - In set: { path: "status", operator: "in", value: ["active", "pending"] }
 * - Exists: { path: "metadata.tags", operator: "exists" }
 */
export const propertyFilterSchema = z.object({
  // JSON path to the property
  // Supports: simple ("name"), nested ("address.city"), array indices ("tags[0]" or "tags.0")
  path: z.string().min(1),

  // Comparison operator
  operator: z.enum([
    'eq',           // equals
    'ne',           // not equals
    'gt',           // greater than
    'lt',           // less than
    'gte',          // greater than or equal
    'lte',          // less than or equal
    'like',         // SQL LIKE pattern matching (case-sensitive)
    'ilike',        // case-insensitive LIKE
    'starts_with',  // string starts with value
    'ends_with',    // string ends with value
    'contains',     // string contains value (case-insensitive)
    'in',           // value in array
    'not_in',       // value not in array
    'exists',       // property exists (value is ignored)
    'not_exists',   // property doesn't exist (value is ignored)
  ]),

  // Value to compare against (optional for exists/not_exists operators)
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(z.union([z.string(), z.number(), z.boolean()])),
  ]).optional(),
});

export type PropertyFilter = z.infer<typeof propertyFilterSchema>;

// Entity search request schema
export const searchEntitiesSchema = z.object({
  // Type filter
  type_id: uuidSchema.optional(),

  // Property filters - DEPRECATED: Use property_filters instead
  // Kept for backward compatibility with simple equality matching
  properties: z.record(z.string(), z.any()).optional(),

  // Advanced property filters with comparison operators
  property_filters: z.array(propertyFilterSchema).optional(),

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

  // Property filters - DEPRECATED: Use property_filters instead
  // Kept for backward compatibility with simple equality matching
  properties: z.record(z.string(), z.any()).optional(),

  // Advanced property filters with comparison operators
  property_filters: z.array(propertyFilterSchema).optional(),

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
