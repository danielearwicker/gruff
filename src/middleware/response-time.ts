/**
 * Response Time Middleware
 *
 * Hono middleware that tracks response times for all API requests
 * and writes metrics to Cloudflare Workers Analytics Engine.
 *
 * The middleware measures request duration from when the request
 * is received until the response is sent, and records metrics
 * for performance analysis.
 */

import type { Context, Next } from 'hono';
import type { AnalyticsEngineDataset } from '../utils/error-tracking.js';
import {
  createResponseTimeTracker,
  ResponseTimeTracker,
  ResponseTimeTrackerConfig,
} from '../utils/response-time-tracking.js';
import { getRequestId } from './request-context.js';

/**
 * Middleware configuration options
 */
export interface ResponseTimeMiddlewareConfig extends ResponseTimeTrackerConfig {
  /**
   * Custom function to determine if a request should be skipped
   */
  skip?: (c: Context) => boolean;

  /**
   * Custom header name for exposing response time (set to null to disable)
   * Default: 'X-Response-Time'
   */
  headerName?: string | null;
}

/**
 * Environment bindings type (subset for middleware)
 */
interface Bindings {
  ANALYTICS?: AnalyticsEngineDataset;
  ENVIRONMENT?: string;
}

/**
 * Response time middleware factory
 *
 * Creates a Hono middleware that tracks response times and writes
 * metrics to Cloudflare Workers Analytics Engine.
 *
 * @param config - Middleware configuration
 * @returns Hono middleware function
 *
 * @example
 * ```typescript
 * import { responseTime } from './middleware/response-time.js';
 *
 * // Basic usage - track all requests
 * app.use('*', responseTime());
 *
 * // With configuration
 * app.use('*', responseTime({
 *   minDurationMs: 10,  // Only track requests > 10ms
 *   skipPaths: ['/health'],  // Skip health checks
 *   headerName: 'X-Response-Time',  // Add response time header
 * }));
 * ```
 */
export function responseTime(config: ResponseTimeMiddlewareConfig = {}) {
  const headerName = config.headerName === null ? null : (config.headerName ?? 'X-Response-Time');

  return async (c: Context<{ Bindings: Bindings }>, next: Next) => {
    // Check if request should be skipped
    if (config.skip?.(c)) {
      await next();
      return;
    }

    // Start timing
    const startTime = performance.now();

    // Process request
    await next();

    // Calculate duration
    const endTime = performance.now();
    const durationMs = Math.round(endTime - startTime);

    // Add response time header if configured
    if (headerName) {
      c.header(headerName, `${durationMs}ms`);
    }

    // Track response time in Analytics Engine
    const tracker = createResponseTimeTracker(c.env?.ANALYTICS, {
      enableAnalytics: config.enableAnalytics,
      environment: config.environment ?? c.env?.ENVIRONMENT ?? 'development',
      minDurationMs: config.minDurationMs,
      skipPaths: config.skipPaths,
    });

    // Extract request details for tracking
    const requestId = getRequestId(c);
    const cfData = (c.req.raw as any).cf;

    tracker.track({
      requestId: requestId ?? undefined,
      userId: c.get('user')?.id,
      path: c.req.path,
      method: c.req.method,
      statusCode: c.res.status,
      durationMs,
      contentLength: parseInt(c.res.headers.get('content-length') || '0', 10) || undefined,
      userAgent: c.req.header('user-agent'),
      ipAddress: c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for'),
      colo: cfData?.colo,
      country: cfData?.country,
    });
  };
}
