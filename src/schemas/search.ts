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
export const propertyFilterSchema = z
  .object({
    // JSON path to the property
    // Supports: simple ("name"), nested ("address.city"), array indices ("tags[0]" or "tags.0")
    path: z.string().min(1).openapi({
      example: 'name',
      description: 'JSON path to the property (e.g., "name", "address.city", "tags[0]", "tags.0")',
    }),

    // Comparison operator
    operator: z
      .enum([
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
      ])
      .openapi({ example: 'eq', description: 'Comparison operator' }),

    // Value to compare against (optional for exists/not_exists operators)
    value: z
      .union([
        z.string(),
        z.number(),
        z.boolean(),
        z.null(),
        z.array(z.union([z.string(), z.number(), z.boolean()])),
      ])
      .optional()
      .openapi({ description: 'Value to compare against (optional for exists/not_exists)' }),
  })
  .openapi('PropertyFilter');

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
// The .openapi('FilterExpression') registration is required to break infinite recursion
// during OpenAPI spec generation - it tells the generator to use a $ref instead of inlining
const baseFilterExpressionSchema: z.ZodType<FilterExpression> = z
  .lazy(() =>
    z.union([
      propertyFilterSchema,
      z.object({
        and: z.array(baseFilterExpressionSchema).min(1).max(50),
      }),
      z.object({
        or: z.array(baseFilterExpressionSchema).min(1).max(50),
      }),
    ])
  )
  .openapi('FilterExpression');

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
export const searchEntitiesSchema = z
  .object({
    // Type filter
    type_id: typeIdSchema.optional().openapi({ example: 'Person', description: 'Filter by type' }),

    // Property filters - DEPRECATED: Use property_filters or filter_expression instead
    // Kept for backward compatibility with simple equality matching
    properties: z
      .record(z.string(), z.any())
      .optional()
      .openapi({ description: 'Simple equality filters (deprecated, use filter_expression)' }),

    // Advanced property filters with comparison operators (combined with AND)
    // DEPRECATED: Use filter_expression for complex logic with AND/OR
    property_filters: z
      .array(propertyFilterSchema)
      .optional()
      .openapi({ description: 'Advanced property filters (deprecated, use filter_expression)' }),

    // Filter expression with AND/OR logical operators
    // Allows complex filter combinations: { and: [...] }, { or: [...] }, or nested expressions
    // Takes precedence over property_filters if both are provided
    filter_expression: filterExpressionSchema
      .optional()
      .openapi({ description: 'Complex AND/OR filter expression' }),

    // Date range filters (Unix timestamps)
    created_after: z.number().int().positive().optional().openapi({
      example: 1704067200,
      description: 'Filter entities created after this timestamp',
    }),
    created_before: z.number().int().positive().optional().openapi({
      example: 1704153600,
      description: 'Filter entities created before this timestamp',
    }),

    // Creator filter
    created_by: uuidSchema.optional().openapi({
      example: '550e8400-e29b-41d4-a716-446655440001',
      description: 'Filter by creator user ID',
    }),

    // Include deleted entities
    include_deleted: z
      .boolean()
      .optional()
      .default(false)
      .openapi({ example: false, description: 'Include soft-deleted entities' }),

    // Pagination
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .default(20)
      .openapi({ example: 20, description: 'Maximum results to return (max 100)' }),
    cursor: z
      .string()
      .optional()
      .openapi({ description: 'Pagination cursor from previous response' }),
  })
  .openapi('SearchEntities');

// Link search request schema
export const searchLinksSchema = z
  .object({
    // Type filter
    type_id: typeIdSchema
      .optional()
      .openapi({ example: 'knows', description: 'Filter by link type' }),

    // Entity filters
    source_entity_id: uuidSchema.optional().openapi({
      example: '550e8400-e29b-41d4-a716-446655440000',
      description: 'Filter by source entity ID',
    }),
    target_entity_id: uuidSchema.optional().openapi({
      example: '550e8400-e29b-41d4-a716-446655440001',
      description: 'Filter by target entity ID',
    }),

    // Property filters - DEPRECATED: Use property_filters or filter_expression instead
    // Kept for backward compatibility with simple equality matching
    properties: z
      .record(z.string(), z.any())
      .optional()
      .openapi({ description: 'Simple equality filters (deprecated, use filter_expression)' }),

    // Advanced property filters with comparison operators (combined with AND)
    // DEPRECATED: Use filter_expression for complex logic with AND/OR
    property_filters: z
      .array(propertyFilterSchema)
      .optional()
      .openapi({ description: 'Advanced property filters (deprecated, use filter_expression)' }),

    // Filter expression with AND/OR logical operators
    // Allows complex filter combinations: { and: [...] }, { or: [...] }, or nested expressions
    // Takes precedence over property_filters if both are provided
    filter_expression: filterExpressionSchema
      .optional()
      .openapi({ description: 'Complex AND/OR filter expression' }),

    // Date range filters (Unix timestamps)
    created_after: z
      .number()
      .int()
      .positive()
      .optional()
      .openapi({ example: 1704067200, description: 'Filter links created after this timestamp' }),
    created_before: z
      .number()
      .int()
      .positive()
      .optional()
      .openapi({ example: 1704153600, description: 'Filter links created before this timestamp' }),

    // Creator filter
    created_by: uuidSchema.optional().openapi({
      example: '550e8400-e29b-41d4-a716-446655440001',
      description: 'Filter by creator user ID',
    }),

    // Include deleted links
    include_deleted: z
      .boolean()
      .optional()
      .default(false)
      .openapi({ example: false, description: 'Include soft-deleted links' }),

    // Pagination
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .default(20)
      .openapi({ example: 20, description: 'Maximum results to return (max 100)' }),
    cursor: z
      .string()
      .optional()
      .openapi({ description: 'Pagination cursor from previous response' }),
  })
  .openapi('SearchLinks');

// Type-ahead suggestions schema (for query parameters)
export const suggestionsSchema = z.object({
  // Query string for partial matching
  query: z
    .string()
    .min(1)
    .max(100)
    .openapi({
      param: { name: 'query', in: 'query' },
      example: 'John',
      description: 'Search query for partial matching',
    }),

  // Property path to search (e.g., "name", "title", "properties.label")
  property_path: z
    .string()
    .optional()
    .default('name')
    .openapi({
      param: { name: 'property_path', in: 'query' },
      example: 'name',
      description: 'Property path to search (default: "name")',
    }),

  // Entity type filter
  type_id: typeIdSchema.optional().openapi({
    param: { name: 'type_id', in: 'query' },
    example: 'Person',
    description: 'Filter by entity type',
  }),

  // Maximum number of suggestions to return (comes as string from query params)
  limit: z
    .string()
    .optional()
    .transform(val => (val ? parseInt(val, 10) : 10))
    .pipe(z.number().int().positive().max(50))
    .openapi({
      param: { name: 'limit', in: 'query' },
      example: '10',
      description: 'Maximum suggestions to return (default: 10, max: 50)',
    }),
});

// Types derived from schemas
export type SearchEntities = z.infer<typeof searchEntitiesSchema>;
export type SearchLinks = z.infer<typeof searchLinksSchema>;
export type Suggestions = z.infer<typeof suggestionsSchema>;
