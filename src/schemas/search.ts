import { z } from '@hono/zod-openapi';
import { uuidSchema, typeIdSchema } from './common.js';

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
    'eq', // equals
    'ne', // not equals
    'gt', // greater than
    'lt', // less than
    'gte', // greater than or equal
    'lte', // less than or equal
    'like', // SQL LIKE pattern matching (case-sensitive)
    'ilike', // case-insensitive LIKE
    'starts_with', // string starts with value
    'ends_with', // string ends with value
    'contains', // string contains value (case-insensitive)
    'in', // value in array
    'not_in', // value not in array
    'exists', // property exists (value is ignored)
    'not_exists', // property doesn't exist (value is ignored)
  ]),

  // Value to compare against (optional for exists/not_exists operators)
  value: z
    .union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(z.union([z.string(), z.number(), z.boolean()])),
    ])
    .optional(),
});

export type PropertyFilter = z.infer<typeof propertyFilterSchema>;

/**
 * Filter expression schema with logical operators (AND/OR)
 *
 * Supports:
 * - Simple filter: A single PropertyFilter object
 * - AND groups: { and: [filter1, filter2, ...] }
 * - OR groups: { or: [filter1, filter2, ...] }
 * - Nested groups: { or: [{ and: [filter1, filter2] }, filter3] }
 *
 * Maximum nesting depth: 5 levels
 *
 * Examples:
 * - Simple AND (array): [{ path: "status", operator: "eq", value: "active" }, { path: "age", operator: "gt", value: 18 }]
 * - Explicit AND: { and: [{ path: "status", operator: "eq", value: "active" }, { path: "age", operator: "gt", value: 18 }] }
 * - OR group: { or: [{ path: "role", operator: "eq", value: "admin" }, { path: "role", operator: "eq", value: "moderator" }] }
 * - Mixed: { and: [{ path: "status", operator: "eq", value: "active" }, { or: [{ path: "role", operator: "eq", value: "admin" }, { path: "role", operator: "eq", value: "mod" }] }] }
 */

// Forward declaration for recursive schema
type FilterExpression =
  | z.infer<typeof propertyFilterSchema>
  | { and: FilterExpression[] }
  | { or: FilterExpression[] };

// Create the recursive filter expression schema with Zod lazy
// We need to build this carefully to allow PropertyFilter objects, and/or groups, and nested groups
const baseFilterExpressionSchema: z.ZodType<FilterExpression> = z.lazy(() =>
  z.union([
    propertyFilterSchema,
    z.object({
      and: z.array(baseFilterExpressionSchema).min(1).max(50),
    }),
    z.object({
      or: z.array(baseFilterExpressionSchema).min(1).max(50),
    }),
  ])
);

export const filterExpressionSchema = baseFilterExpressionSchema;

export type FilterExpressionType = FilterExpression;

/**
 * Type guard to check if an expression is an AND group
 */
export function isAndGroup(expr: FilterExpression): expr is { and: FilterExpression[] } {
  return typeof expr === 'object' && expr !== null && 'and' in expr;
}

/**
 * Type guard to check if an expression is an OR group
 */
export function isOrGroup(expr: FilterExpression): expr is { or: FilterExpression[] } {
  return typeof expr === 'object' && expr !== null && 'or' in expr;
}

/**
 * Type guard to check if an expression is a simple PropertyFilter
 */
export function isPropertyFilter(expr: FilterExpression): expr is PropertyFilter {
  return typeof expr === 'object' && expr !== null && 'path' in expr && 'operator' in expr;
}

// Entity search request schema
export const searchEntitiesSchema = z.object({
  // Type filter
  type_id: typeIdSchema.optional(),

  // Property filters - DEPRECATED: Use property_filters or filter_expression instead
  // Kept for backward compatibility with simple equality matching
  properties: z.record(z.string(), z.any()).optional(),

  // Advanced property filters with comparison operators (combined with AND)
  // DEPRECATED: Use filter_expression for complex logic with AND/OR
  property_filters: z.array(propertyFilterSchema).optional(),

  // Filter expression with AND/OR logical operators
  // Allows complex filter combinations: { and: [...] }, { or: [...] }, or nested expressions
  // Takes precedence over property_filters if both are provided
  filter_expression: filterExpressionSchema.optional(),

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
  type_id: typeIdSchema.optional(),

  // Entity filters
  source_entity_id: uuidSchema.optional(),
  target_entity_id: uuidSchema.optional(),

  // Property filters - DEPRECATED: Use property_filters or filter_expression instead
  // Kept for backward compatibility with simple equality matching
  properties: z.record(z.string(), z.any()).optional(),

  // Advanced property filters with comparison operators (combined with AND)
  // DEPRECATED: Use filter_expression for complex logic with AND/OR
  property_filters: z.array(propertyFilterSchema).optional(),

  // Filter expression with AND/OR logical operators
  // Allows complex filter combinations: { and: [...] }, { or: [...] }, or nested expressions
  // Takes precedence over property_filters if both are provided
  filter_expression: filterExpressionSchema.optional(),

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
  type_id: typeIdSchema.optional(),

  // Maximum number of suggestions to return (comes as string from query params)
  limit: z
    .string()
    .optional()
    .transform(val => (val ? parseInt(val, 10) : 10))
    .pipe(z.number().int().positive().max(50)),
});

// Types derived from schemas
export type SearchEntities = z.infer<typeof searchEntitiesSchema>;
export type SearchLinks = z.infer<typeof searchLinksSchema>;
export type Suggestions = z.infer<typeof suggestionsSchema>;
