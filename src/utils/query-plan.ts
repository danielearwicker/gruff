/**
 * Query Plan Analysis Utility
 *
 * This module provides utilities for analyzing SQL query execution plans
 * using D1's EXPLAIN QUERY PLAN feature. It helps identify performance
 * issues and provides recommendations for optimization.
 */

import type { QueryTemplate, QueryPlanStep } from '../schemas/generated-columns.js';

/**
 * Predefined SQL query templates for common operations.
 * These templates represent typical query patterns in the application.
 */
export const QUERY_TEMPLATES: Record<
  QueryTemplate,
  {
    sql: string;
    description: string;
    parameters: string[];
  }
> = {
  entity_by_id: {
    sql: `SELECT e.*, t.name as type_name
          FROM entities e
          LEFT JOIN types t ON e.type_id = t.id
          WHERE e.id = ? AND e.is_latest = 1`,
    description: 'Fetch a single entity by its ID',
    parameters: ['entity_id'],
  },
  entity_by_type: {
    sql: `SELECT e.*, t.name as type_name
          FROM entities e
          LEFT JOIN types t ON e.type_id = t.id
          WHERE e.type_id = ? AND e.is_latest = 1 AND e.is_deleted = 0
          ORDER BY e.created_at DESC
          LIMIT 20`,
    description: 'List entities of a specific type',
    parameters: ['type_id'],
  },
  entity_by_property: {
    sql: `SELECT e.*, t.name as type_name
          FROM entities e
          LEFT JOIN types t ON e.type_id = t.id
          WHERE json_extract(e.properties, '$.name') = ?
            AND e.is_latest = 1 AND e.is_deleted = 0
          LIMIT 20`,
    description: 'Search entities by a JSON property value',
    parameters: ['property_value'],
  },
  links_by_source: {
    sql: `SELECT l.*, t.name as type_name,
            se.id as source_id, json_extract(se.properties, '$.name') as source_name,
            te.id as target_id, json_extract(te.properties, '$.name') as target_name
          FROM links l
          LEFT JOIN types t ON l.type_id = t.id
          LEFT JOIN entities se ON l.source_entity_id = se.id AND se.is_latest = 1
          LEFT JOIN entities te ON l.target_entity_id = te.id AND te.is_latest = 1
          WHERE l.source_entity_id = ? AND l.is_latest = 1 AND l.is_deleted = 0
          ORDER BY l.created_at DESC
          LIMIT 20`,
    description: 'Get all outbound links from an entity',
    parameters: ['source_entity_id'],
  },
  links_by_target: {
    sql: `SELECT l.*, t.name as type_name,
            se.id as source_id, json_extract(se.properties, '$.name') as source_name,
            te.id as target_id, json_extract(te.properties, '$.name') as target_name
          FROM links l
          LEFT JOIN types t ON l.type_id = t.id
          LEFT JOIN entities se ON l.source_entity_id = se.id AND se.is_latest = 1
          LEFT JOIN entities te ON l.target_entity_id = te.id AND te.is_latest = 1
          WHERE l.target_entity_id = ? AND l.is_latest = 1 AND l.is_deleted = 0
          ORDER BY l.created_at DESC
          LIMIT 20`,
    description: 'Get all inbound links to an entity',
    parameters: ['target_entity_id'],
  },
  links_by_type: {
    sql: `SELECT l.*, t.name as type_name
          FROM links l
          LEFT JOIN types t ON l.type_id = t.id
          WHERE l.type_id = ? AND l.is_latest = 1 AND l.is_deleted = 0
          ORDER BY l.created_at DESC
          LIMIT 20`,
    description: 'List links of a specific type',
    parameters: ['type_id'],
  },
  neighbors_outbound: {
    sql: `SELECT DISTINCT e.*, t.name as type_name
          FROM entities e
          JOIN links l ON l.target_entity_id = e.id
          LEFT JOIN types t ON e.type_id = t.id
          WHERE l.source_entity_id = ?
            AND l.is_latest = 1 AND l.is_deleted = 0
            AND e.is_latest = 1 AND e.is_deleted = 0
          LIMIT 50`,
    description: 'Get outbound neighbor entities',
    parameters: ['entity_id'],
  },
  neighbors_inbound: {
    sql: `SELECT DISTINCT e.*, t.name as type_name
          FROM entities e
          JOIN links l ON l.source_entity_id = e.id
          LEFT JOIN types t ON e.type_id = t.id
          WHERE l.target_entity_id = ?
            AND l.is_latest = 1 AND l.is_deleted = 0
            AND e.is_latest = 1 AND e.is_deleted = 0
          LIMIT 50`,
    description: 'Get inbound neighbor entities',
    parameters: ['entity_id'],
  },
  search_entities: {
    sql: `SELECT e.*, t.name as type_name
          FROM entities e
          LEFT JOIN types t ON e.type_id = t.id
          WHERE e.is_latest = 1 AND e.is_deleted = 0
          ORDER BY e.created_at DESC
          LIMIT 20`,
    description: 'Basic entity search with default filters',
    parameters: [],
  },
  search_links: {
    sql: `SELECT l.*, t.name as type_name
          FROM links l
          LEFT JOIN types t ON l.type_id = t.id
          WHERE l.is_latest = 1 AND l.is_deleted = 0
          ORDER BY l.created_at DESC
          LIMIT 20`,
    description: 'Basic link search with default filters',
    parameters: [],
  },
};

/**
 * Known indexes in the database schema.
 * Used to identify which indexes are being used in query plans.
 */
export const KNOWN_INDEXES = [
  // Primary key indexes (implicit)
  'entities.id',
  'links.id',
  'types.id',
  'users.id',
  // Entity indexes
  'idx_entities_type_latest_deleted',
  'idx_entities_created_by',
  'idx_entities_created_at',
  'idx_entities_prop_name',
  'idx_entities_prop_status',
  'idx_entities_prop_email',
  'idx_entities_type_name',
  'idx_entities_type_status',
  // Link indexes
  'idx_links_source_latest_deleted',
  'idx_links_target_latest_deleted',
  'idx_links_type',
  'idx_links_created_by',
  'idx_links_created_at',
  'idx_links_prop_role',
  'idx_links_prop_weight',
  'idx_links_type_role',
  // Type indexes
  'idx_types_name',
  'idx_types_category',
  // User indexes
  'idx_users_email',
  'idx_users_provider_id',
  // Audit log indexes
  'idx_audit_logs_user_id',
  'idx_audit_logs_resource',
  'idx_audit_logs_operation',
  'idx_audit_logs_timestamp',
];

/**
 * Validate that a custom SQL query is safe to analyze.
 * Only SELECT statements are allowed.
 *
 * @param sql - The SQL query to validate
 * @returns True if the query is safe to analyze
 */
export function isValidAnalysisQuery(sql: string): boolean {
  // Trim and normalize
  const normalized = sql.trim().toLowerCase();

  // Must start with SELECT or EXPLAIN
  if (!normalized.startsWith('select') && !normalized.startsWith('explain')) {
    return false;
  }

  // Disallow dangerous keywords
  const dangerousKeywords = [
    'insert',
    'update',
    'delete',
    'drop',
    'alter',
    'create',
    'truncate',
    'grant',
    'revoke',
    'attach',
    'detach',
  ];

  for (const keyword of dangerousKeywords) {
    // Check for keyword as a whole word (with word boundaries)
    const regex = new RegExp(`\\b${keyword}\\b`, 'i');
    if (regex.test(sql)) {
      return false;
    }
  }

  return true;
}

/**
 * Generate SQL from a template and parameters.
 *
 * @param template - The template name
 * @param parameters - Parameter values for the template
 * @returns The generated SQL with placeholders
 */
export function generateTemplateSQL(
  template: QueryTemplate,
  _parameters?: Record<string, string | number | boolean>
): string {
  const templateDef = QUERY_TEMPLATES[template];
  if (!templateDef) {
    throw new Error(`Unknown template: ${template}`);
  }

  // Return the SQL with placeholders (for EXPLAIN QUERY PLAN)
  // Actual parameter binding would happen at execution time
  return templateDef.sql;
}

/**
 * Execute EXPLAIN QUERY PLAN and return the results.
 *
 * @param db - D1 database instance
 * @param sql - The SQL query to analyze
 * @returns Array of query plan steps
 */
export async function executeQueryPlan(db: D1Database, sql: string): Promise<QueryPlanStep[]> {
  // Replace parameter placeholders with dummy values for EXPLAIN QUERY PLAN
  // SQLite cannot execute EXPLAIN with unbound parameters
  let analyzableSQL = sql;
  let paramCount = 0;
  analyzableSQL = analyzableSQL.replace(/\?/g, () => {
    paramCount++;
    // Use different dummy values to avoid any caching issues
    return `'dummy-param-${paramCount}'`;
  });

  // Ensure the query starts with EXPLAIN QUERY PLAN
  const explainSQL = analyzableSQL.trim().toLowerCase().startsWith('explain')
    ? analyzableSQL
    : `EXPLAIN QUERY PLAN ${analyzableSQL}`;

  const result = await db.prepare(explainSQL).all();

  return result.results.map((row: Record<string, unknown>) => ({
    id: (row.id as number) ?? 0,
    parent: (row.parent as number) ?? 0,
    notUsed: row.notused as number | undefined,
    detail: (row.detail as string) ?? '',
  }));
}

/**
 * Analyze query plan steps to extract meaningful information.
 *
 * @param steps - The query plan steps from EXPLAIN QUERY PLAN
 * @returns Analysis results
 */
export function analyzeQueryPlanSteps(steps: QueryPlanStep[]): {
  uses_index: boolean;
  indexes_used: string[];
  estimated_rows_scanned: string | undefined;
  has_table_scan: boolean;
  tables_accessed: string[];
} {
  const indexes_used: string[] = [];
  const tables_accessed: string[] = [];
  let has_table_scan = false;

  for (const step of steps) {
    const detail = step.detail.toLowerCase();

    // Identify index usage
    const indexMatch = detail.match(/using (?:covering )?index ([\w_]+)/i);
    if (indexMatch) {
      indexes_used.push(indexMatch[1]);
    }

    // Identify primary key lookups (implicit index)
    if (detail.includes('using integer primary key') || detail.includes('search using')) {
      if (detail.includes('search') && !indexMatch) {
        // PK lookup
        const tableMatch = detail.match(/scan (\w+)|search (\w+)/i);
        if (tableMatch) {
          const tableName = tableMatch[1] || tableMatch[2];
          indexes_used.push(`${tableName}.id (PRIMARY KEY)`);
        }
      }
    }

    // Identify table scans
    if (detail.includes('scan') && !detail.includes('using index') && !detail.includes('search')) {
      has_table_scan = true;
    }

    // Extract table names
    const tableMatch = detail.match(/(?:scan|search) (?:table )?(\w+)/i);
    if (tableMatch && !tables_accessed.includes(tableMatch[1])) {
      tables_accessed.push(tableMatch[1]);
    }

    // Handle subqueries and CTEs
    if (detail.includes('co-routine') || detail.includes('subquery')) {
      // These often involve additional table access
    }
  }

  return {
    uses_index: indexes_used.length > 0,
    indexes_used: [...new Set(indexes_used)],
    estimated_rows_scanned: undefined, // SQLite EXPLAIN QUERY PLAN doesn't provide row estimates
    has_table_scan,
    tables_accessed: [...new Set(tables_accessed)],
  };
}

/**
 * Generate optimization recommendations based on query plan analysis.
 *
 * @param analysis - The query plan analysis
 * @param sql - The original SQL query
 * @returns Array of recommendations
 */
export function generateRecommendations(
  analysis: {
    uses_index: boolean;
    indexes_used: string[];
    has_table_scan: boolean;
    tables_accessed: string[];
  },
  sql: string
): string[] {
  const recommendations: string[] = [];
  const normalizedSQL = sql.toLowerCase();

  // Check for full table scans
  if (analysis.has_table_scan) {
    recommendations.push(
      'Query involves a full table scan. Consider adding an index on the filtered columns.'
    );

    // Check if it's scanning entities and using json_extract
    if (analysis.tables_accessed.includes('entities') && normalizedSQL.includes('json_extract')) {
      recommendations.push(
        'JSON property filter on entities table may cause full table scan. ' +
          'Consider using a generated column if this property is frequently queried.'
      );
    }

    // Check if it's scanning links and using json_extract
    if (analysis.tables_accessed.includes('links') && normalizedSQL.includes('json_extract')) {
      recommendations.push(
        'JSON property filter on links table may cause full table scan. ' +
          'Consider using a generated column if this property is frequently queried.'
      );
    }
  }

  // Check for missing is_latest filter
  if (
    (analysis.tables_accessed.includes('entities') || analysis.tables_accessed.includes('links')) &&
    !normalizedSQL.includes('is_latest')
  ) {
    recommendations.push(
      'Query does not filter by is_latest. This may return historical versions. ' +
        'Add "is_latest = 1" filter to query only current versions.'
    );
  }

  // Check for missing is_deleted filter
  if (
    (analysis.tables_accessed.includes('entities') || analysis.tables_accessed.includes('links')) &&
    !normalizedSQL.includes('is_deleted')
  ) {
    recommendations.push(
      'Query does not filter by is_deleted. This may include soft-deleted items. ' +
        'Add "is_deleted = 0" filter to exclude deleted items.'
    );
  }

  // Positive feedback if indexes are being used
  if (analysis.uses_index && !analysis.has_table_scan) {
    recommendations.push(
      `Query is well-optimized, using index(es): ${analysis.indexes_used.join(', ')}`
    );
  }

  // Check for ORDER BY without index
  if (normalizedSQL.includes('order by') && analysis.has_table_scan) {
    recommendations.push(
      'ORDER BY clause combined with table scan may require sorting all rows. ' +
        'Consider adding an index that covers the ORDER BY columns.'
    );
  }

  // Check for LIMIT without ORDER BY
  if (normalizedSQL.includes('limit') && !normalizedSQL.includes('order by')) {
    recommendations.push(
      'LIMIT without ORDER BY returns arbitrary rows. Consider adding ORDER BY for consistent results.'
    );
  }

  return recommendations;
}

/**
 * Get information about a query template.
 *
 * @param template - The template name
 * @returns Template information or null if not found
 */
export function getTemplateInfo(template: QueryTemplate): {
  sql: string;
  description: string;
  parameters: string[];
} | null {
  return QUERY_TEMPLATES[template] || null;
}

/**
 * Get all available query templates.
 *
 * @returns List of template names with descriptions
 */
export function listTemplates(): Array<{
  name: QueryTemplate;
  description: string;
  parameters: string[];
}> {
  return Object.entries(QUERY_TEMPLATES).map(([name, info]) => ({
    name: name as QueryTemplate,
    description: info.description,
    parameters: info.parameters,
  }));
}
