/**
 * Property filter utilities
 *
 * This module provides functions to convert property filter objects into SQL WHERE clauses
 * for querying JSON properties in SQLite using the JSON1 extension.
 */

import type { PropertyFilter } from '../schemas/search.js';

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
 * Sanitize a JSON path to prevent SQL injection
 * - Only allow alphanumeric characters, dots, underscores, and array indices
 * - Convert to SQLite JSON path format ($.path.to.property)
 */
function sanitizeJsonPath(path: string): string {
  // Validate path contains only safe characters
  if (!/^[a-zA-Z0-9._\[\]]+$/.test(path)) {
    throw new Error(`Invalid JSON path: ${path}. Only alphanumeric characters, dots, underscores, and array indices are allowed.`);
  }

  // Ensure path starts with $. for SQLite JSON functions
  if (!path.startsWith('$.')) {
    return `$.${path}`;
  }

  return path;
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
