/**
 * Query Performance Tracking Middleware
 *
 * Hono middleware that provides a tracked D1 database wrapper,
 * automatically measuring query execution times and writing
 * metrics to Cloudflare Workers Analytics Engine.
 *
 * The middleware creates a tracked database instance that wraps
 * all D1 operations with performance measurement.
 */

import type { Context, Next, MiddlewareHandler } from 'hono';
import type { AnalyticsEngineDataset } from '../utils/error-tracking.js';
import {
  createQueryPerformanceTracker,
  createTrackedD1,
  QueryPerformanceTracker,
  QueryPerformanceTrackerConfig,
} from '../utils/query-performance-tracking.js';
import { getRequestId } from './request-context.js';

/**
 * Middleware configuration options
 */
export interface QueryTrackingMiddlewareConfig extends QueryPerformanceTrackerConfig {
  /**
   * Custom function to determine if query tracking should be skipped for a request
   */
  skip?: (c: Context) => boolean;
}

/**
 * Environment bindings type (subset for middleware)
 */
interface Bindings {
  DB: D1Database;
  ANALYTICS?: AnalyticsEngineDataset;
  ENVIRONMENT?: string;
}

/**
 * Context variables set by the middleware
 */
interface Variables {
  trackedDb: ReturnType<typeof createTrackedD1>;
  queryTracker: QueryPerformanceTracker;
}

// Store for tracker instances per request (used for manual tracking)
const QUERY_TRACKER_KEY = 'queryTracker';
const TRACKED_DB_KEY = 'trackedDb';

/**
 * Get the query performance tracker from context
 *
 * @param c - Hono context
 * @returns QueryPerformanceTracker instance or undefined if not available
 */
export function getQueryTracker(c: Context): QueryPerformanceTracker | undefined {
  return c.get(QUERY_TRACKER_KEY) as QueryPerformanceTracker | undefined;
}

/**
 * Get the tracked D1 database from context
 *
 * @param c - Hono context
 * @returns Tracked D1 database wrapper or undefined if not available
 */
export function getTrackedDb(c: Context): ReturnType<typeof createTrackedD1> | undefined {
  return c.get(TRACKED_DB_KEY) as ReturnType<typeof createTrackedD1> | undefined;
}

/**
 * Query tracking middleware factory
 *
 * Creates a Hono middleware that provides a tracked D1 database
 * wrapper and query performance tracker via context.
 *
 * @param config - Middleware configuration
 * @returns Hono middleware function
 *
 * @example
 * ```typescript
 * import { queryTracking, getTrackedDb } from './middleware/query-tracking.js';
 *
 * // Apply middleware to all API routes
 * app.use('/api/*', queryTracking({
 *   slowQueryThreshold: 100,  // Mark queries > 100ms as slow
 * }));
 *
 * // In route handlers, use getTrackedDb for automatic tracking:
 * app.get('/api/entities', async (c) => {
 *   const trackedDb = getTrackedDb(c);
 *   if (trackedDb) {
 *     const result = await trackedDb.prepare('SELECT * FROM entities').all();
 *     // Query performance is automatically tracked
 *   }
 * });
 *
 * // Or use the tracker directly for manual tracking:
 * app.get('/api/custom', async (c) => {
 *   const tracker = getQueryTracker(c);
 *   const timer = tracker?.startTimer();
 *   // ... execute query ...
 *   const duration = timer?.() ?? 0;
 *   tracker?.trackQuery(sql, duration, 'all', { rowCount: results.length });
 * });
 * ```
 */
export function queryTracking(config: QueryTrackingMiddlewareConfig = {}): MiddlewareHandler {
  return async (c: Context<{ Bindings: Bindings; Variables: Variables }>, next: Next) => {
    // Check if tracking should be skipped
    if (config.skip?.(c)) {
      await next();
      return;
    }

    // Create tracker instance
    const tracker = createQueryPerformanceTracker(c.env?.ANALYTICS, {
      enableAnalytics: config.enableAnalytics,
      environment: config.environment ?? c.env?.ENVIRONMENT ?? 'development',
      slowQueryThreshold: config.slowQueryThreshold,
      minDurationMs: config.minDurationMs,
    });

    // Get request context for tracking
    const requestId = getRequestId(c) ?? undefined;
    const userId = c.get('user')?.user_id;

    // Create tracked database wrapper
    const trackedDb = createTrackedD1(c.env.DB, tracker, {
      requestId,
      userId,
    });

    // Set tracker and tracked DB in context
    c.set(QUERY_TRACKER_KEY, tracker);
    c.set(TRACKED_DB_KEY, trackedDb);

    await next();
  };
}

/**
 * Helper to create a tracked DB for a specific query context
 * Useful when you need to specify additional context like isSearch or isGraph
 *
 * @param c - Hono context
 * @param options - Additional tracking options
 * @returns Tracked D1 database wrapper or the original DB if tracking not available
 */
export function createContextTrackedDb(
  c: Context<{ Bindings: Bindings }>,
  options?: {
    isSearch?: boolean;
    isGraph?: boolean;
  }
): ReturnType<typeof createTrackedD1> | D1Database {
  const tracker = getQueryTracker(c);
  if (!tracker) {
    return c.env.DB;
  }

  const requestId = getRequestId(c) ?? undefined;
  const userId = c.get('user')?.user_id;

  return createTrackedD1(c.env.DB, tracker, {
    requestId,
    userId,
    ...options,
  });
}
