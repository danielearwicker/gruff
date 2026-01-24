/**
 * Generated Columns Utility
 *
 * This module provides utilities for working with generated columns in SQLite.
 * Generated columns are virtual or stored columns computed from JSON properties,
 * allowing efficient indexing and querying of JSON data.
 *
 * Key features:
 * - Query which JSON paths have optimized columns
 * - Get the actual column name for a JSON path (for query optimization)
 * - Check if a query can benefit from generated column indexes
 */

import type { GeneratedColumn, QueryOptimizationInfo } from '../schemas/generated-columns.js';

/**
 * Known generated columns with their JSON path mappings.
 * This is a compile-time constant for optimal performance.
 * Updated via migration when new generated columns are added.
 */
export const GENERATED_COLUMNS = {
  entities: {
    'name': { columnName: 'prop_name', dataType: 'TEXT' as const },
    'status': { columnName: 'prop_status', dataType: 'TEXT' as const },
    'email': { columnName: 'prop_email', dataType: 'TEXT' as const },
  },
  links: {
    'role': { columnName: 'prop_role', dataType: 'TEXT' as const },
    'weight': { columnName: 'prop_weight', dataType: 'REAL' as const },
  },
} as const;

type TableName = 'entities' | 'links';

/**
 * Check if a JSON path has a corresponding generated column
 *
 * @param tableName - The table to check ('entities' or 'links')
 * @param jsonPath - The JSON path to check (e.g., 'name', 'status', 'email')
 * @returns True if the path has a generated column
 */
export function hasGeneratedColumn(tableName: TableName, jsonPath: string): boolean {
  const tableColumns = GENERATED_COLUMNS[tableName];
  if (!tableColumns) return false;

  // Remove leading '$.' if present
  const normalizedPath = jsonPath.startsWith('$.') ? jsonPath.slice(2) : jsonPath;

  // Only top-level properties are supported for now
  // Check if the path is a simple property name (no dots or brackets)
  if (normalizedPath.includes('.') || normalizedPath.includes('[')) {
    return false;
  }

  return normalizedPath in tableColumns;
}

/**
 * Get the generated column name for a JSON path
 *
 * @param tableName - The table to check ('entities' or 'links')
 * @param jsonPath - The JSON path (e.g., 'name', 'status')
 * @returns The column name if it exists, or null if no generated column exists
 */
export function getGeneratedColumnName(tableName: TableName, jsonPath: string): string | null {
  const tableColumns = GENERATED_COLUMNS[tableName];
  if (!tableColumns) return null;

  // Remove leading '$.' if present
  const normalizedPath = jsonPath.startsWith('$.') ? jsonPath.slice(2) : jsonPath;

  // Only top-level properties are supported
  if (normalizedPath.includes('.') || normalizedPath.includes('[')) {
    return null;
  }

  const mapping = tableColumns[normalizedPath as keyof typeof tableColumns];
  return mapping ? mapping.columnName : null;
}

/**
 * Get the data type of a generated column
 *
 * @param tableName - The table to check
 * @param jsonPath - The JSON path
 * @returns The SQLite data type or null if no generated column exists
 */
export function getGeneratedColumnDataType(tableName: TableName, jsonPath: string): string | null {
  const tableColumns = GENERATED_COLUMNS[tableName];
  if (!tableColumns) return null;

  // Remove leading '$.' if present
  const normalizedPath = jsonPath.startsWith('$.') ? jsonPath.slice(2) : jsonPath;

  if (normalizedPath.includes('.') || normalizedPath.includes('[')) {
    return null;
  }

  const mapping = tableColumns[normalizedPath as keyof typeof tableColumns];
  return mapping ? mapping.dataType : null;
}

/**
 * Build an optimized SQL condition using generated columns when available
 *
 * If the JSON path has a generated column, returns a condition using that column.
 * Otherwise, returns a condition using json_extract.
 *
 * @param tableName - The table name
 * @param tableAlias - The table alias in the query (e.g., 'e' for entities)
 * @param jsonPath - The JSON path to query
 * @param operator - SQL operator (=, !=, >, <, LIKE, etc.)
 * @param valuePlaceholder - The placeholder for the value (default '?')
 * @returns SQL condition string
 */
export function buildOptimizedCondition(
  tableName: TableName,
  tableAlias: string,
  jsonPath: string,
  operator: string,
  valuePlaceholder: string = '?'
): { sql: string; usesGeneratedColumn: boolean } {
  const columnName = getGeneratedColumnName(tableName, jsonPath);

  if (columnName) {
    // Use the generated column for better performance
    return {
      sql: `${tableAlias}.${columnName} ${operator} ${valuePlaceholder}`,
      usesGeneratedColumn: true,
    };
  }

  // Fall back to json_extract
  // Normalize the path to SQLite JSON path format
  const normalizedPath = jsonPath.startsWith('$.') ? jsonPath : `$.${jsonPath}`;
  return {
    sql: `json_extract(${tableAlias}.properties, '${normalizedPath}') ${operator} ${valuePlaceholder}`,
    usesGeneratedColumn: false,
  };
}

/**
 * Get all generated columns from the database
 *
 * @param db - D1 database instance
 * @returns Array of generated column metadata
 */
export async function getGeneratedColumns(db: D1Database): Promise<GeneratedColumn[]> {
  const result = await db
    .prepare('SELECT * FROM generated_columns ORDER BY table_name, column_name')
    .all();

  return result.results as GeneratedColumn[];
}

/**
 * Get generated columns for a specific table
 *
 * @param db - D1 database instance
 * @param tableName - The table name to filter by
 * @returns Array of generated column metadata for the table
 */
export async function getGeneratedColumnsForTable(
  db: D1Database,
  tableName: TableName
): Promise<GeneratedColumn[]> {
  const result = await db
    .prepare('SELECT * FROM generated_columns WHERE table_name = ? ORDER BY column_name')
    .bind(tableName)
    .all();

  return result.results as GeneratedColumn[];
}

/**
 * Get query optimization information
 *
 * Returns a summary of which JSON paths have optimized generated columns
 * that can be used for efficient querying and indexing.
 *
 * @param db - D1 database instance
 * @returns Optimization info organized by table
 */
export async function getQueryOptimizationInfo(db: D1Database): Promise<QueryOptimizationInfo> {
  const columns = await getGeneratedColumns(db);

  const entities = columns
    .filter((c) => c.table_name === 'entities')
    .map((c) => ({
      column_name: c.column_name,
      json_path: c.json_path,
      data_type: c.data_type as 'TEXT' | 'INTEGER' | 'REAL' | 'BOOLEAN',
      is_indexed: c.is_indexed === 1,
      description: c.description,
    }));

  const links = columns
    .filter((c) => c.table_name === 'links')
    .map((c) => ({
      column_name: c.column_name,
      json_path: c.json_path,
      data_type: c.data_type as 'TEXT' | 'INTEGER' | 'REAL' | 'BOOLEAN',
      is_indexed: c.is_indexed === 1,
      description: c.description,
    }));

  return { entities, links };
}

/**
 * Check if a query path can benefit from index optimization
 *
 * This is useful for query planning to determine if a filter
 * will use an efficient index lookup or require a full table scan.
 *
 * @param tableName - The table being queried
 * @param jsonPath - The JSON path in the filter
 * @returns Object with optimization details
 */
export function analyzeQueryPath(
  tableName: TableName,
  jsonPath: string
): {
  hasGeneratedColumn: boolean;
  hasIndex: boolean;
  columnName: string | null;
  dataType: string | null;
  recommendation: string;
} {
  const columnName = getGeneratedColumnName(tableName, jsonPath);
  const dataType = getGeneratedColumnDataType(tableName, jsonPath);

  if (columnName) {
    return {
      hasGeneratedColumn: true,
      hasIndex: true, // All generated columns in our schema are indexed
      columnName,
      dataType,
      recommendation: `Query will use indexed column ${columnName} for efficient lookup`,
    };
  }

  return {
    hasGeneratedColumn: false,
    hasIndex: false,
    columnName: null,
    dataType: null,
    recommendation: `Query will use json_extract() which may require a full table scan. Consider adding a generated column for '${jsonPath}' if this is a frequently queried property.`,
  };
}

/**
 * Get SQL for analyzing query performance
 *
 * Returns EXPLAIN QUERY PLAN statement to analyze how SQLite will execute a query.
 * Useful for verifying that generated column indexes are being used.
 *
 * @param sql - The SQL query to analyze
 * @returns The EXPLAIN QUERY PLAN statement
 */
export function getQueryPlanSQL(sql: string): string {
  return `EXPLAIN QUERY PLAN ${sql}`;
}
