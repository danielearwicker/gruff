/**
 * Query Performance Tracking Utility
 *
 * Integrates with Cloudflare Workers Analytics Engine for database query
 * performance monitoring. Tracks query execution times, categorizes by
 * operation type, and enables performance trend analysis.
 *
 * Workers Analytics Engine allows writing up to 25 blobs and 20 doubles
 * per data point, with high throughput and low latency.
 */

import type { AnalyticsEngineDataset, AnalyticsEngineEvent } from './error-tracking.js';

/**
 * Query operation category for performance grouping
 */
export enum QueryCategory {
  READ = 'read', // SELECT queries
  WRITE = 'write', // INSERT, UPDATE, DELETE queries
  SEARCH = 'search', // Search/filtering queries
  GRAPH = 'graph', // Graph traversal queries (recursive CTEs, joins)
  SCHEMA = 'schema', // Schema-related queries (types, metadata)
  AUTH = 'auth', // Authentication queries
  AUDIT = 'audit', // Audit log queries
  OTHER = 'other', // Unclassified queries
}

/**
 * Table name for categorization
 */
export enum TableName {
  ENTITIES = 'entities',
  LINKS = 'links',
  TYPES = 'types',
  USERS = 'users',
  AUDIT_LOG = 'audit_log',
  MULTIPLE = 'multiple', // For queries spanning multiple tables
  OTHER = 'other',
}

/**
 * Query performance context
 */
export interface QueryPerformanceContext {
  requestId?: string;
  userId?: string;
  durationMs: number;
  tableName: TableName;
  category: QueryCategory;
  operationType: 'first' | 'all' | 'run' | 'batch';
  rowCount?: number;
  isSlow?: boolean;
}

/**
 * Query performance tracking configuration
 */
export interface QueryPerformanceTrackerConfig {
  /** Enable/disable analytics engine writes (useful for testing) */
  enableAnalytics?: boolean;
  /** Environment name for partitioning */
  environment?: string;
  /** Threshold in ms for marking a query as slow (default: 100ms) */
  slowQueryThreshold?: number;
  /** Minimum query time (ms) to track (filter out very fast queries) */
  minDurationMs?: number;
}

/**
 * Detect table name from SQL query
 */
export function detectTableName(sql: string): TableName {
  const lowerSql = sql.toLowerCase();

  // Check for multiple table operations (JOINs, subqueries with different tables)
  const tableMatches = lowerSql.match(/(?:from|into|update|join)\s+(\w+)/g);
  if (tableMatches && tableMatches.length > 1) {
    // Extract unique table names
    const tables = new Set(
      tableMatches.map(match => {
        const parts = match.split(/\s+/);
        return parts[parts.length - 1];
      })
    );
    if (tables.size > 1) {
      return TableName.MULTIPLE;
    }
  }

  // Single table detection
  if (lowerSql.includes('entities')) {
    return TableName.ENTITIES;
  }
  if (lowerSql.includes('links')) {
    return TableName.LINKS;
  }
  if (lowerSql.includes('types')) {
    return TableName.TYPES;
  }
  if (lowerSql.includes('users')) {
    return TableName.USERS;
  }
  if (lowerSql.includes('audit_log')) {
    return TableName.AUDIT_LOG;
  }

  return TableName.OTHER;
}

/**
 * Detect query category from SQL query
 */
export function detectQueryCategory(
  sql: string,
  context?: { isSearch?: boolean; isGraph?: boolean }
): QueryCategory {
  const lowerSql = sql.toLowerCase().trim();

  // Use explicit context if provided
  if (context?.isSearch) {
    return QueryCategory.SEARCH;
  }
  if (context?.isGraph) {
    return QueryCategory.GRAPH;
  }

  // Detect graph traversal queries (recursive CTEs, multiple JOINs)
  if (lowerSql.includes('with recursive') || lowerSql.includes('recursive')) {
    return QueryCategory.GRAPH;
  }

  // Detect auth-related queries
  if (
    lowerSql.includes('password') ||
    lowerSql.includes('token') ||
    lowerSql.includes('session') ||
    (lowerSql.includes('users') && (lowerSql.includes('email') || lowerSql.includes('provider')))
  ) {
    return QueryCategory.AUTH;
  }

  // Detect audit log queries
  if (lowerSql.includes('audit_log')) {
    return QueryCategory.AUDIT;
  }

  // Detect schema queries
  if (lowerSql.includes('types') && !lowerSql.includes('type_id')) {
    return QueryCategory.SCHEMA;
  }

  // Detect search queries (complex WHERE clauses, json_extract, LIKE)
  if (
    lowerSql.includes('json_extract') ||
    lowerSql.includes('like') ||
    lowerSql.includes('filter')
  ) {
    return QueryCategory.SEARCH;
  }

  // Basic operation type detection
  if (lowerSql.startsWith('select')) {
    return QueryCategory.READ;
  }
  if (
    lowerSql.startsWith('insert') ||
    lowerSql.startsWith('update') ||
    lowerSql.startsWith('delete')
  ) {
    return QueryCategory.WRITE;
  }

  return QueryCategory.OTHER;
}

/**
 * Query Performance Tracker class for tracking database query performance
 */
export class QueryPerformanceTracker {
  private analytics?: AnalyticsEngineDataset;
  private config: Required<QueryPerformanceTrackerConfig>;

  constructor(analytics?: AnalyticsEngineDataset, config: QueryPerformanceTrackerConfig = {}) {
    this.analytics = analytics;
    this.config = {
      enableAnalytics: config.enableAnalytics ?? true,
      environment: config.environment ?? 'development',
      slowQueryThreshold: config.slowQueryThreshold ?? 100,
      minDurationMs: config.minDurationMs ?? 0,
    };
  }

  /**
   * Check if query duration meets tracking threshold
   */
  private shouldTrack(durationMs: number): boolean {
    return durationMs >= this.config.minDurationMs;
  }

  /**
   * Check if query is considered slow
   */
  isSlow(durationMs: number): boolean {
    return durationMs >= this.config.slowQueryThreshold;
  }

  /**
   * Track a database query's performance
   *
   * @param context - Query performance context with query details
   */
  track(context: QueryPerformanceContext): void {
    if (!this.analytics || !this.config.enableAnalytics) {
      return;
    }

    if (!this.shouldTrack(context.durationMs)) {
      return;
    }

    const isSlow = context.isSlow ?? this.isSlow(context.durationMs);

    try {
      /**
       * Data structure for Analytics Engine:
       * - blobs[0]: Environment (e.g., 'production', 'development')
       * - blobs[1]: Query category (e.g., 'read', 'write', 'search', 'graph')
       * - blobs[2]: Table name (e.g., 'entities', 'links', 'types')
       * - blobs[3]: Operation type (e.g., 'first', 'all', 'run', 'batch')
       * - blobs[4]: Is slow query ('true' or 'false')
       * - blobs[5]: User ID (or 'anonymous')
       * - blobs[6]: Request ID (or 'unknown')
       * - doubles[0]: Duration in milliseconds
       * - doubles[1]: Row count (0 if unknown)
       * - doubles[2]: Timestamp (Unix ms)
       * - doubles[3]: Slow query threshold used
       * - indexes[0]: Environment (for partitioning)
       */
      const event: AnalyticsEngineEvent = {
        blobs: [
          this.config.environment,
          context.category,
          context.tableName,
          context.operationType,
          isSlow ? 'true' : 'false',
          context.userId || 'anonymous',
          context.requestId || 'unknown',
        ],
        doubles: [
          context.durationMs,
          context.rowCount ?? 0,
          Date.now(),
          this.config.slowQueryThreshold,
        ],
        indexes: [this.config.environment],
      };

      this.analytics.writeDataPoint(event);
    } catch {
      // Don't let analytics failures affect the application
      // Silently fail - we don't want to log every analytics write failure
    }
  }

  /**
   * Create a timer for tracking query duration
   * Returns a function to call when the query completes
   */
  startTimer(): () => number {
    const startTime = performance.now();
    return () => {
      const endTime = performance.now();
      return Math.round(endTime - startTime);
    };
  }

  /**
   * Track a query with automatic SQL analysis
   *
   * @param sql - The SQL query string
   * @param durationMs - Query duration in milliseconds
   * @param operationType - D1 operation type (first, all, run, batch)
   * @param options - Additional context options
   */
  trackQuery(
    sql: string,
    durationMs: number,
    operationType: 'first' | 'all' | 'run' | 'batch',
    options?: {
      requestId?: string;
      userId?: string;
      rowCount?: number;
      isSearch?: boolean;
      isGraph?: boolean;
    }
  ): void {
    const tableName = detectTableName(sql);
    const category = detectQueryCategory(sql, {
      isSearch: options?.isSearch,
      isGraph: options?.isGraph,
    });

    this.track({
      durationMs,
      tableName,
      category,
      operationType,
      requestId: options?.requestId,
      userId: options?.userId,
      rowCount: options?.rowCount,
    });
  }
}

/**
 * Create a query performance tracker instance
 *
 * @param analytics - Analytics Engine dataset binding (from env.ANALYTICS)
 * @param config - Query performance tracker configuration
 */
export function createQueryPerformanceTracker(
  analytics?: AnalyticsEngineDataset,
  config?: QueryPerformanceTrackerConfig
): QueryPerformanceTracker {
  return new QueryPerformanceTracker(analytics, config);
}

/**
 * Wrapper type for tracked D1 prepared statement
 */
export interface TrackedD1PreparedStatement {
  first<T = unknown>(colName?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<D1Result<unknown>>;
  bind(...values: unknown[]): TrackedD1PreparedStatement;
}

/**
 * Create a tracked D1 database wrapper
 * Wraps D1Database to automatically track query performance
 *
 * @param db - The D1Database instance
 * @param tracker - Query performance tracker instance
 * @param options - Additional options for tracking
 */
export function createTrackedD1(
  db: D1Database,
  tracker: QueryPerformanceTracker,
  options?: {
    requestId?: string;
    userId?: string;
    isSearch?: boolean;
    isGraph?: boolean;
  }
): {
  prepare(sql: string): TrackedD1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(sql: string): Promise<D1ExecResult>;
} {
  return {
    prepare(sql: string): TrackedD1PreparedStatement {
      const stmt = db.prepare(sql);
      let boundStmt = stmt;

      const createTrackedStatement = (
        currentStmt: D1PreparedStatement
      ): TrackedD1PreparedStatement => ({
        bind(...values: unknown[]): TrackedD1PreparedStatement {
          boundStmt = currentStmt.bind(...values);
          return createTrackedStatement(boundStmt);
        },

        async first<T = unknown>(colName?: string): Promise<T | null> {
          const stopTimer = tracker.startTimer();
          try {
            const result = colName ? await boundStmt.first<T>(colName) : await boundStmt.first<T>();
            const durationMs = stopTimer();
            tracker.trackQuery(sql, durationMs, 'first', {
              ...options,
              rowCount: result ? 1 : 0,
            });
            return result;
          } catch (error) {
            const durationMs = stopTimer();
            tracker.trackQuery(sql, durationMs, 'first', {
              ...options,
              rowCount: 0,
            });
            throw error;
          }
        },

        async all<T = unknown>(): Promise<D1Result<T>> {
          const stopTimer = tracker.startTimer();
          try {
            const result = await boundStmt.all<T>();
            const durationMs = stopTimer();
            tracker.trackQuery(sql, durationMs, 'all', {
              ...options,
              rowCount: result.results?.length ?? 0,
            });
            return result;
          } catch (error) {
            const durationMs = stopTimer();
            tracker.trackQuery(sql, durationMs, 'all', {
              ...options,
              rowCount: 0,
            });
            throw error;
          }
        },

        async run(): Promise<D1Result<unknown>> {
          const stopTimer = tracker.startTimer();
          try {
            const result = await boundStmt.run();
            const durationMs = stopTimer();
            tracker.trackQuery(sql, durationMs, 'run', {
              ...options,
              rowCount: result.meta?.changes ?? 0,
            });
            return result;
          } catch (error) {
            const durationMs = stopTimer();
            tracker.trackQuery(sql, durationMs, 'run', {
              ...options,
              rowCount: 0,
            });
            throw error;
          }
        },
      });

      return createTrackedStatement(stmt);
    },

    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const stopTimer = tracker.startTimer();
      try {
        const results = await db.batch<T>(statements);
        const durationMs = stopTimer();
        // Track as a single batch operation
        tracker.track({
          durationMs,
          tableName: TableName.MULTIPLE,
          category: QueryCategory.WRITE,
          operationType: 'batch',
          requestId: options?.requestId,
          userId: options?.userId,
          rowCount: statements.length,
        });
        return results;
      } catch (error) {
        const durationMs = stopTimer();
        tracker.track({
          durationMs,
          tableName: TableName.MULTIPLE,
          category: QueryCategory.WRITE,
          operationType: 'batch',
          requestId: options?.requestId,
          userId: options?.userId,
          rowCount: 0,
        });
        throw error;
      }
    },

    async exec(sql: string): Promise<D1ExecResult> {
      const stopTimer = tracker.startTimer();
      try {
        const result = await db.exec(sql);
        const durationMs = stopTimer();
        tracker.trackQuery(sql, durationMs, 'run', options);
        return result;
      } catch (error) {
        const durationMs = stopTimer();
        tracker.trackQuery(sql, durationMs, 'run', options);
        throw error;
      }
    },
  };
}
