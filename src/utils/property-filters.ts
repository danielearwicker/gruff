/**
 * Property filter utilities
 *
 * This module provides functions to convert property filter objects into SQL WHERE clauses
 * for querying JSON properties in SQLite using the JSON1 extension.
 *
 * Supports:
 * - Simple property filters with comparison operators
 * - Logical operators (AND/OR) for combining filters
 * - Nested filter groups for complex query expressions
 */

import type { PropertyFilter, FilterExpressionType } from '../schemas/search.js';
import { isAndGroup, isOrGroup, isPropertyFilter } from '../schemas/search.js';

/**
 * Result of building a property filter SQL clause
 */
export interface PropertyFilterResult {
  /** The SQL WHERE clause fragment */
  sql: string;
  /** The bindings for the SQL clause */
  bindings: any[];
}

/**
 * Result of parsing a JSON path
 */
export interface ParsedJsonPath {
  /** Whether the path is valid */
  isValid: boolean;
  /** The SQLite-compatible JSON path (e.g., "$.address.city" or "$.tags[0].name") */
  sqlPath: string;
  /** Array of path components */
  components: JsonPathComponent[];
  /** Error message if invalid */
  error?: string;
}

/**
 * A single component of a JSON path
 */
export interface JsonPathComponent {
  /** Type of component: 'property' for object properties, 'index' for array indices */
  type: 'property' | 'index';
  /** The property name (for property) or array index (for index) */
  value: string | number;
}

/**
 * Maximum allowed nesting depth for JSON paths
 */
const MAX_PATH_DEPTH = 10;

/**
 * Parse and validate a JSON path expression
 *
 * Supports:
 * - Simple properties: "name", "age"
 * - Nested properties with dot notation: "address.city", "user.profile.name"
 * - Array indices with bracket notation: "tags[0]", "items[2]"
 * - Array indices with dot notation: "tags.0", "items.2"
 * - Mixed notation: "users[0].address.city", "data.items[1].value"
 *
 * @param path The JSON path expression to parse
 * @returns Parsed path information including validity, SQLite path, and components
 */
export function parseJsonPath(path: string): ParsedJsonPath {
  // Empty path is invalid
  if (!path || path.trim() === '') {
    return {
      isValid: false,
      sqlPath: '',
      components: [],
      error: 'JSON path cannot be empty',
    };
  }

  // Remove leading $. if present (we'll add it back)
  let normalizedPath = path;
  if (normalizedPath.startsWith('$.')) {
    normalizedPath = normalizedPath.slice(2);
  } else if (normalizedPath.startsWith('$')) {
    normalizedPath = normalizedPath.slice(1);
  }

  // Validate the path only contains safe characters
  // Allow: alphanumeric, underscores, dots, square brackets, and digits inside brackets
  if (!/^[a-zA-Z0-9_.[\]]+$/.test(normalizedPath)) {
    return {
      isValid: false,
      sqlPath: '',
      components: [],
      error: `Invalid characters in JSON path: ${path}. Only alphanumeric characters, underscores, dots, and square brackets are allowed.`,
    };
  }

  const components: JsonPathComponent[] = [];
  const sqlParts: string[] = [];

  // Split by dots first, then handle bracket notation within each segment
  // We need to be careful with segments like "items[0]" which should stay together
  let current = '';
  let inBracket = false;

  for (let i = 0; i < normalizedPath.length; i++) {
    const char = normalizedPath[i];

    if (char === '[') {
      if (inBracket) {
        return {
          isValid: false,
          sqlPath: '',
          components: [],
          error: `Invalid JSON path: nested brackets are not allowed at position ${i}`,
        };
      }
      inBracket = true;

      // If there's content before the bracket, it's a property name
      if (current) {
        if (!isValidPropertyName(current)) {
          return {
            isValid: false,
            sqlPath: '',
            components: [],
            error: `Invalid property name: ${current}. Property names must start with a letter or underscore.`,
          };
        }
        components.push({ type: 'property', value: current });
        sqlParts.push(current);
        current = '';
      }
    } else if (char === ']') {
      if (!inBracket) {
        return {
          isValid: false,
          sqlPath: '',
          components: [],
          error: `Invalid JSON path: unexpected closing bracket at position ${i}`,
        };
      }
      inBracket = false;

      // Content inside brackets should be an array index
      const indexValue = current.trim();
      if (!/^\d+$/.test(indexValue)) {
        return {
          isValid: false,
          sqlPath: '',
          components: [],
          error: `Invalid array index: ${current}. Array indices must be non-negative integers.`,
        };
      }
      const index = parseInt(indexValue, 10);
      components.push({ type: 'index', value: index });
      sqlParts.push(`[${index}]`);
      current = '';
    } else if (char === '.' && !inBracket) {
      // Dot separator for properties
      if (current) {
        // Check if current is a numeric index (dot notation for arrays)
        if (/^\d+$/.test(current)) {
          const index = parseInt(current, 10);
          components.push({ type: 'index', value: index });
          sqlParts.push(`[${index}]`);
        } else {
          if (!isValidPropertyName(current)) {
            return {
              isValid: false,
              sqlPath: '',
              components: [],
              error: `Invalid property name: ${current}. Property names must start with a letter or underscore.`,
            };
          }
          components.push({ type: 'property', value: current });
          sqlParts.push(current);
        }
        current = '';
      }
      // Ignore leading or consecutive dots (treat as empty)
    } else {
      current += char;
    }
  }

  // Handle any remaining content
  if (inBracket) {
    return {
      isValid: false,
      sqlPath: '',
      components: [],
      error: 'Invalid JSON path: unclosed bracket',
    };
  }

  if (current) {
    // Check if current is a numeric index (dot notation for arrays)
    if (/^\d+$/.test(current)) {
      const index = parseInt(current, 10);
      components.push({ type: 'index', value: index });
      sqlParts.push(`[${index}]`);
    } else {
      if (!isValidPropertyName(current)) {
        return {
          isValid: false,
          sqlPath: '',
          components: [],
          error: `Invalid property name: ${current}. Property names must start with a letter or underscore.`,
        };
      }
      components.push({ type: 'property', value: current });
      sqlParts.push(current);
    }
  }

  // Check for empty components array
  if (components.length === 0) {
    return {
      isValid: false,
      sqlPath: '',
      components: [],
      error: 'JSON path cannot be empty',
    };
  }

  // Check for maximum depth
  if (components.length > MAX_PATH_DEPTH) {
    return {
      isValid: false,
      sqlPath: '',
      components: [],
      error: `JSON path exceeds maximum depth of ${MAX_PATH_DEPTH}`,
    };
  }

  // Build the SQLite-compatible path
  // Format: $.property.name[0].nested
  let sqlPath = '$';
  for (const part of sqlParts) {
    if (part.startsWith('[')) {
      // Array index - append directly
      sqlPath += part;
    } else {
      // Property name - append with dot separator
      sqlPath += `.${part}`;
    }
  }

  return {
    isValid: true,
    sqlPath,
    components,
  };
}

/**
 * Check if a string is a valid JSON property name
 * Property names must start with a letter or underscore, followed by letters, digits, or underscores
 */
function isValidPropertyName(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

/**
 * Sanitize and convert a JSON path to SQLite JSON path format
 * This is the main entry point for path validation in filters
 *
 * @param path The JSON path to sanitize
 * @returns The SQLite-compatible JSON path
 * @throws Error if the path is invalid
 */
function sanitizeJsonPath(path: string): string {
  const parsed = parseJsonPath(path);

  if (!parsed.isValid) {
    throw new Error(parsed.error || `Invalid JSON path: ${path}`);
  }

  return parsed.sqlPath;
}

/**
 * Build a SQL WHERE clause for a single property filter
 *
 * @param filter The property filter specification
 * @param tableAlias The table alias to use in the SQL (e.g., 'e' for entities, 'l' for links)
 * @returns SQL clause and bindings
 */
export function buildPropertyFilter(filter: PropertyFilter, tableAlias: string = 'e'): PropertyFilterResult {
  const jsonPath = sanitizeJsonPath(filter.path);
  const { operator, value } = filter;

  switch (operator) {
    case 'eq': {
      // Equality: json_extract(properties, '$.path') = value
      // Handle different types
      if (typeof value === 'string') {
        return {
          sql: `json_extract(${tableAlias}.properties, ?) = ?`,
          bindings: [jsonPath, value],
        };
      } else if (typeof value === 'number') {
        return {
          sql: `CAST(json_extract(${tableAlias}.properties, ?) AS REAL) = ?`,
          bindings: [jsonPath, value],
        };
      } else if (typeof value === 'boolean') {
        return {
          sql: `CAST(json_extract(${tableAlias}.properties, ?) AS INTEGER) = ?`,
          bindings: [jsonPath, value ? 1 : 0],
        };
      } else if (value === null) {
        return {
          sql: `json_extract(${tableAlias}.properties, ?) IS NULL`,
          bindings: [jsonPath],
        };
      }
      throw new Error(`Unsupported value type for eq operator: ${typeof value}`);
    }

    case 'ne': {
      // Not equals: json_extract(properties, '$.path') != value
      if (typeof value === 'string') {
        return {
          sql: `json_extract(${tableAlias}.properties, ?) != ?`,
          bindings: [jsonPath, value],
        };
      } else if (typeof value === 'number') {
        return {
          sql: `CAST(json_extract(${tableAlias}.properties, ?) AS REAL) != ?`,
          bindings: [jsonPath, value],
        };
      } else if (typeof value === 'boolean') {
        return {
          sql: `CAST(json_extract(${tableAlias}.properties, ?) AS INTEGER) != ?`,
          bindings: [jsonPath, value ? 1 : 0],
        };
      } else if (value === null) {
        return {
          sql: `json_extract(${tableAlias}.properties, ?) IS NOT NULL`,
          bindings: [jsonPath],
        };
      }
      throw new Error(`Unsupported value type for ne operator: ${typeof value}`);
    }

    case 'gt': {
      // Greater than (numeric comparison)
      if (typeof value !== 'number') {
        throw new Error(`gt operator requires a numeric value, got ${typeof value}`);
      }
      return {
        sql: `CAST(json_extract(${tableAlias}.properties, ?) AS REAL) > ?`,
        bindings: [jsonPath, value],
      };
    }

    case 'lt': {
      // Less than (numeric comparison)
      if (typeof value !== 'number') {
        throw new Error(`lt operator requires a numeric value, got ${typeof value}`);
      }
      return {
        sql: `CAST(json_extract(${tableAlias}.properties, ?) AS REAL) < ?`,
        bindings: [jsonPath, value],
      };
    }

    case 'gte': {
      // Greater than or equal (numeric comparison)
      if (typeof value !== 'number') {
        throw new Error(`gte operator requires a numeric value, got ${typeof value}`);
      }
      return {
        sql: `CAST(json_extract(${tableAlias}.properties, ?) AS REAL) >= ?`,
        bindings: [jsonPath, value],
      };
    }

    case 'lte': {
      // Less than or equal (numeric comparison)
      if (typeof value !== 'number') {
        throw new Error(`lte operator requires a numeric value, got ${typeof value}`);
      }
      return {
        sql: `CAST(json_extract(${tableAlias}.properties, ?) AS REAL) <= ?`,
        bindings: [jsonPath, value],
      };
    }

    case 'like': {
      // SQL LIKE pattern matching (case-sensitive)
      if (typeof value !== 'string') {
        throw new Error(`like operator requires a string value, got ${typeof value}`);
      }
      return {
        sql: `json_extract(${tableAlias}.properties, ?) LIKE ?`,
        bindings: [jsonPath, value],
      };
    }

    case 'ilike': {
      // Case-insensitive LIKE (using UPPER/LOWER for SQLite)
      if (typeof value !== 'string') {
        throw new Error(`ilike operator requires a string value, got ${typeof value}`);
      }
      return {
        sql: `UPPER(json_extract(${tableAlias}.properties, ?)) LIKE UPPER(?)`,
        bindings: [jsonPath, value],
      };
    }

    case 'starts_with': {
      // String starts with value
      if (typeof value !== 'string') {
        throw new Error(`starts_with operator requires a string value, got ${typeof value}`);
      }
      return {
        sql: `json_extract(${tableAlias}.properties, ?) LIKE ?`,
        bindings: [jsonPath, `${value}%`],
      };
    }

    case 'ends_with': {
      // String ends with value
      if (typeof value !== 'string') {
        throw new Error(`ends_with operator requires a string value, got ${typeof value}`);
      }
      return {
        sql: `json_extract(${tableAlias}.properties, ?) LIKE ?`,
        bindings: [jsonPath, `%${value}`],
      };
    }

    case 'contains': {
      // String contains value (case-insensitive)
      if (typeof value !== 'string') {
        throw new Error(`contains operator requires a string value, got ${typeof value}`);
      }
      return {
        sql: `UPPER(json_extract(${tableAlias}.properties, ?)) LIKE UPPER(?)`,
        bindings: [jsonPath, `%${value}%`],
      };
    }

    case 'in': {
      // Value in array
      if (!Array.isArray(value) || value.length === 0) {
        throw new Error(`in operator requires a non-empty array value`);
      }

      // Build placeholders for IN clause
      const placeholders = value.map(() => '?').join(', ');

      // Determine type from first element
      if (typeof value[0] === 'string') {
        return {
          sql: `json_extract(${tableAlias}.properties, ?) IN (${placeholders})`,
          bindings: [jsonPath, ...value],
        };
      } else if (typeof value[0] === 'number') {
        return {
          sql: `CAST(json_extract(${tableAlias}.properties, ?) AS REAL) IN (${placeholders})`,
          bindings: [jsonPath, ...value],
        };
      } else if (typeof value[0] === 'boolean') {
        return {
          sql: `CAST(json_extract(${tableAlias}.properties, ?) AS INTEGER) IN (${placeholders})`,
          bindings: [jsonPath, ...value.map(v => v ? 1 : 0)],
        };
      }
      throw new Error(`Unsupported value type in array for in operator: ${typeof value[0]}`);
    }

    case 'not_in': {
      // Value not in array
      if (!Array.isArray(value) || value.length === 0) {
        throw new Error(`not_in operator requires a non-empty array value`);
      }

      // Build placeholders for NOT IN clause
      const placeholders = value.map(() => '?').join(', ');

      // Determine type from first element
      if (typeof value[0] === 'string') {
        return {
          sql: `json_extract(${tableAlias}.properties, ?) NOT IN (${placeholders})`,
          bindings: [jsonPath, ...value],
        };
      } else if (typeof value[0] === 'number') {
        return {
          sql: `CAST(json_extract(${tableAlias}.properties, ?) AS REAL) NOT IN (${placeholders})`,
          bindings: [jsonPath, ...value],
        };
      } else if (typeof value[0] === 'boolean') {
        return {
          sql: `CAST(json_extract(${tableAlias}.properties, ?) AS INTEGER) NOT IN (${placeholders})`,
          bindings: [jsonPath, ...value.map(v => v ? 1 : 0)],
        };
      }
      throw new Error(`Unsupported value type in array for not_in operator: ${typeof value[0]}`);
    }

    case 'exists': {
      // Property exists (not NULL)
      return {
        sql: `json_extract(${tableAlias}.properties, ?) IS NOT NULL`,
        bindings: [jsonPath],
      };
    }

    case 'not_exists': {
      // Property doesn't exist (is NULL)
      return {
        sql: `json_extract(${tableAlias}.properties, ?) IS NULL`,
        bindings: [jsonPath],
      };
    }

    default:
      throw new Error(`Unsupported operator: ${operator}`);
  }
}

/**
 * Build SQL WHERE clauses for multiple property filters (combined with AND)
 *
 * @param filters Array of property filters
 * @param tableAlias The table alias to use in the SQL
 * @returns Combined SQL clause and bindings
 */
export function buildPropertyFilters(filters: PropertyFilter[], tableAlias: string = 'e'): PropertyFilterResult {
  if (filters.length === 0) {
    return { sql: '', bindings: [] };
  }

  const results = filters.map(filter => buildPropertyFilter(filter, tableAlias));

  // Combine all SQL fragments with AND
  const sql = results.map(r => `(${r.sql})`).join(' AND ');

  // Flatten all bindings
  const bindings = results.flatMap(r => r.bindings);

  return { sql, bindings };
}

/**
 * Maximum nesting depth for filter expressions to prevent stack overflow
 */
const MAX_FILTER_EXPRESSION_DEPTH = 5;

/**
 * Build SQL WHERE clause for a filter expression with AND/OR logic
 *
 * Supports:
 * - Simple property filters: { path: "name", operator: "eq", value: "John" }
 * - AND groups: { and: [filter1, filter2, ...] }
 * - OR groups: { or: [filter1, filter2, ...] }
 * - Nested groups: { and: [filter1, { or: [filter2, filter3] }] }
 *
 * @param expression The filter expression (can be a simple filter, AND group, or OR group)
 * @param tableAlias The table alias to use in the SQL
 * @param depth Current nesting depth (for preventing infinite recursion)
 * @returns SQL clause and bindings
 * @throws Error if the expression is invalid or exceeds maximum depth
 */
export function buildFilterExpression(
  expression: FilterExpressionType,
  tableAlias: string = 'e',
  depth: number = 0
): PropertyFilterResult {
  // Check for maximum depth
  if (depth > MAX_FILTER_EXPRESSION_DEPTH) {
    throw new Error(`Filter expression exceeds maximum nesting depth of ${MAX_FILTER_EXPRESSION_DEPTH}`);
  }

  // Handle simple property filter
  if (isPropertyFilter(expression)) {
    return buildPropertyFilter(expression, tableAlias);
  }

  // Handle AND group
  if (isAndGroup(expression)) {
    if (expression.and.length === 0) {
      return { sql: '', bindings: [] };
    }

    if (expression.and.length === 1) {
      // Single item in AND, just return it directly
      return buildFilterExpression(expression.and[0], tableAlias, depth + 1);
    }

    const results = expression.and.map(expr =>
      buildFilterExpression(expr, tableAlias, depth + 1)
    );

    // Filter out empty results
    const nonEmptyResults = results.filter(r => r.sql !== '');

    if (nonEmptyResults.length === 0) {
      return { sql: '', bindings: [] };
    }

    if (nonEmptyResults.length === 1) {
      return nonEmptyResults[0];
    }

    // Combine with AND
    const sql = nonEmptyResults.map(r => `(${r.sql})`).join(' AND ');
    const bindings = nonEmptyResults.flatMap(r => r.bindings);

    return { sql, bindings };
  }

  // Handle OR group
  if (isOrGroup(expression)) {
    if (expression.or.length === 0) {
      return { sql: '', bindings: [] };
    }

    if (expression.or.length === 1) {
      // Single item in OR, just return it directly
      return buildFilterExpression(expression.or[0], tableAlias, depth + 1);
    }

    const results = expression.or.map(expr =>
      buildFilterExpression(expr, tableAlias, depth + 1)
    );

    // Filter out empty results
    const nonEmptyResults = results.filter(r => r.sql !== '');

    if (nonEmptyResults.length === 0) {
      return { sql: '', bindings: [] };
    }

    if (nonEmptyResults.length === 1) {
      return nonEmptyResults[0];
    }

    // Combine with OR
    const sql = nonEmptyResults.map(r => `(${r.sql})`).join(' OR ');
    const bindings = nonEmptyResults.flatMap(r => r.bindings);

    return { sql, bindings };
  }

  // If we get here, the expression is invalid
  throw new Error('Invalid filter expression: must be a property filter, AND group, or OR group');
}
