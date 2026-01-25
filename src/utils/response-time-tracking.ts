/**
 * Response Time Tracking Utility
 *
 * Integrates with Cloudflare Workers Analytics Engine for response time
 * monitoring and performance metrics. Tracks request durations, categorizes
 * by endpoint type, and enables performance trend analysis.
 *
 * Workers Analytics Engine allows writing up to 25 blobs and 20 doubles
 * per data point, with high throughput and low latency.
 */

import type { AnalyticsEngineDataset, AnalyticsEngineEvent } from './error-tracking.js';

/**
 * Endpoint category for performance grouping
 */
export enum EndpointCategory {
  READ = 'read', // GET operations for reading data
  WRITE = 'write', // POST, PUT, PATCH, DELETE for modifying data
  SEARCH = 'search', // Search operations
  GRAPH = 'graph', // Graph traversal operations
  AUTH = 'auth', // Authentication operations
  BULK = 'bulk', // Bulk operations
  EXPORT = 'export', // Export/import operations
  HEALTH = 'health', // Health checks and system endpoints
  DOCS = 'docs', // Documentation endpoints
  OTHER = 'other', // Unclassified endpoints
}

/**
 * HTTP status category for grouping response codes
 */
export enum StatusCategory {
  SUCCESS = '2xx', // Successful responses
  REDIRECT = '3xx', // Redirects
  CLIENT_ERROR = '4xx', // Client errors
  SERVER_ERROR = '5xx', // Server errors
}

/**
 * Response time metrics context
 */
export interface ResponseTimeContext {
  requestId?: string;
  userId?: string;
  path: string;
  method: string;
  statusCode: number;
  durationMs: number;
  contentLength?: number;
  userAgent?: string;
  ipAddress?: string;
  colo?: string; // Cloudflare data center
  country?: string; // Request origin country
}

/**
 * Response time tracking configuration
 */
export interface ResponseTimeTrackerConfig {
  /** Enable/disable analytics engine writes (useful for testing) */
  enableAnalytics?: boolean;
  /** Environment name for partitioning */
  environment?: string;
  /** Minimum response time (ms) to track (filter out very fast responses) */
  minDurationMs?: number;
  /** Skip tracking for these paths (e.g., health checks) */
  skipPaths?: string[];
}

/**
 * Categorize an endpoint based on path and method
 */
export function categorizeEndpoint(path: string, method: string): EndpointCategory {
  const lowerPath = path.toLowerCase();
  const upperMethod = method.toUpperCase();

  // Health and system endpoints
  if (lowerPath === '/health' || lowerPath === '/api/version' || lowerPath === '/') {
    return EndpointCategory.HEALTH;
  }

  // Documentation endpoints
  if (lowerPath.startsWith('/docs')) {
    return EndpointCategory.DOCS;
  }

  // Authentication endpoints
  if (lowerPath.startsWith('/api/auth')) {
    return EndpointCategory.AUTH;
  }

  // Search endpoints
  if (lowerPath.startsWith('/api/search')) {
    return EndpointCategory.SEARCH;
  }

  // Graph traversal endpoints
  if (
    lowerPath.startsWith('/api/graph') ||
    lowerPath.includes('/neighbors') ||
    lowerPath.includes('/inbound') ||
    lowerPath.includes('/outbound')
  ) {
    return EndpointCategory.GRAPH;
  }

  // Bulk operations
  if (lowerPath.startsWith('/api/bulk')) {
    return EndpointCategory.BULK;
  }

  // Export/import operations
  if (lowerPath.startsWith('/api/export')) {
    return EndpointCategory.EXPORT;
  }

  // Read operations
  if (upperMethod === 'GET' || upperMethod === 'HEAD' || upperMethod === 'OPTIONS') {
    return EndpointCategory.READ;
  }

  // Write operations
  if (
    upperMethod === 'POST' ||
    upperMethod === 'PUT' ||
    upperMethod === 'PATCH' ||
    upperMethod === 'DELETE'
  ) {
    return EndpointCategory.WRITE;
  }

  return EndpointCategory.OTHER;
}

/**
 * Get status code category
 */
export function getStatusCategory(statusCode: number): StatusCategory {
  if (statusCode >= 200 && statusCode < 300) {
    return StatusCategory.SUCCESS;
  }
  if (statusCode >= 300 && statusCode < 400) {
    return StatusCategory.REDIRECT;
  }
  if (statusCode >= 400 && statusCode < 500) {
    return StatusCategory.CLIENT_ERROR;
  }
  return StatusCategory.SERVER_ERROR;
}

/**
 * Extract route pattern from path (anonymize IDs for grouping)
 * e.g., /api/entities/abc123 -> /api/entities/:id
 */
export function extractRoutePattern(path: string): string {
  // Replace version numbers in paths like /versions/123 (before generic numeric replacement)
  let pattern = path.replace(/\/versions\/\d+/g, '/versions/:version');

  // Replace UUIDs (various formats)
  pattern = pattern.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    ':id'
  );

  // Replace numeric IDs
  pattern = pattern.replace(/\/\d+/g, '/:id');

  return pattern;
}

/**
 * Response Time Tracker class for tracking request performance
 */
export class ResponseTimeTracker {
  private analytics?: AnalyticsEngineDataset;
  private config: Required<ResponseTimeTrackerConfig>;

  constructor(analytics?: AnalyticsEngineDataset, config: ResponseTimeTrackerConfig = {}) {
    this.analytics = analytics;
    this.config = {
      enableAnalytics: config.enableAnalytics ?? true,
      environment: config.environment ?? 'development',
      minDurationMs: config.minDurationMs ?? 0,
      skipPaths: config.skipPaths ?? [],
    };
  }

  /**
   * Check if path should be tracked
   */
  private shouldTrack(path: string, durationMs: number): boolean {
    // Check minimum duration
    if (durationMs < this.config.minDurationMs) {
      return false;
    }

    // Check skip paths
    const lowerPath = path.toLowerCase();
    for (const skipPath of this.config.skipPaths) {
      if (lowerPath.startsWith(skipPath.toLowerCase())) {
        return false;
      }
    }

    return true;
  }

  /**
   * Track a request's response time
   *
   * @param context - Response time context with request details
   */
  track(context: ResponseTimeContext): void {
    if (!this.analytics || !this.config.enableAnalytics) {
      return;
    }

    if (!this.shouldTrack(context.path, context.durationMs)) {
      return;
    }

    const category = categorizeEndpoint(context.path, context.method);
    const statusCategory = getStatusCategory(context.statusCode);
    const routePattern = extractRoutePattern(context.path);

    try {
      /**
       * Data structure for Analytics Engine:
       * - blobs[0]: Environment (e.g., 'production', 'development')
       * - blobs[1]: Endpoint category (e.g., 'read', 'write', 'search')
       * - blobs[2]: HTTP method (e.g., 'GET', 'POST')
       * - blobs[3]: Route pattern (e.g., '/api/entities/:id')
       * - blobs[4]: Status category (e.g., '2xx', '4xx', '5xx')
       * - blobs[5]: User ID (or 'anonymous')
       * - blobs[6]: Cloudflare colo (data center)
       * - blobs[7]: Country code
       * - blobs[8]: Request ID
       * - doubles[0]: Duration in milliseconds
       * - doubles[1]: Status code
       * - doubles[2]: Content length (bytes)
       * - doubles[3]: Timestamp (Unix ms)
       * - indexes[0]: Environment (for partitioning)
       */
      const event: AnalyticsEngineEvent = {
        blobs: [
          this.config.environment,
          category,
          context.method.toUpperCase(),
          routePattern.substring(0, 256),
          statusCategory,
          context.userId || 'anonymous',
          context.colo || 'unknown',
          context.country || 'unknown',
          context.requestId || 'unknown',
        ],
        doubles: [context.durationMs, context.statusCode, context.contentLength || 0, Date.now()],
        indexes: [this.config.environment],
      };

      this.analytics.writeDataPoint(event);
    } catch {
      // Don't let analytics failures affect the application
      // Silently fail - we don't want to log every analytics write failure
    }
  }

  /**
   * Create a timer for tracking request duration
   * Returns a function to call when the request completes
   */
  startTimer(): () => number {
    const startTime = performance.now();
    return () => {
      const endTime = performance.now();
      return Math.round(endTime - startTime);
    };
  }
}

/**
 * Create a response time tracker instance
 *
 * @param analytics - Analytics Engine dataset binding (from env.ANALYTICS)
 * @param config - Response time tracker configuration
 */
export function createResponseTimeTracker(
  analytics?: AnalyticsEngineDataset,
  config?: ResponseTimeTrackerConfig
): ResponseTimeTracker {
  return new ResponseTimeTracker(analytics, config);
}
