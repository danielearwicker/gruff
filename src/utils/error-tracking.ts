/**
 * Error Tracking Utility
 *
 * Integrates with Cloudflare Workers Analytics Engine for error tracking
 * and monitoring. Provides structured error logging with stack traces,
 * error categorization, and rate monitoring capabilities.
 *
 * Workers Analytics Engine allows writing up to 25 blobs and 20 doubles
 * per data point, with high throughput and low latency.
 */

import { Logger, createLogger, LogLevel } from './logger.js';
import { redactSensitiveData } from './sensitive-data.js';

/**
 * Analytics Engine dataset binding type
 * This binding is provided by Cloudflare Workers when configured in wrangler.toml
 */
export interface AnalyticsEngineDataset {
  writeDataPoint(event: AnalyticsEngineEvent): void;
}

/**
 * Analytics Engine event structure
 * - blobs: Array of strings (up to 25), for categorical data
 * - doubles: Array of numbers (up to 20), for numerical data
 * - indexes: Array of strings (up to 1), for partitioning data
 */
export interface AnalyticsEngineEvent {
  blobs?: string[];
  doubles?: number[];
  indexes?: string[];
}

/**
 * Error severity levels for categorization
 */
export enum ErrorSeverity {
  LOW = 'low', // Minor errors that don't affect functionality
  MEDIUM = 'medium', // Errors that may affect some users
  HIGH = 'high', // Errors that affect core functionality
  CRITICAL = 'critical', // System-wide failures
}

/**
 * Error category for classification
 */
export enum ErrorCategory {
  VALIDATION = 'validation', // Input validation errors
  AUTHENTICATION = 'authentication', // Auth failures
  AUTHORIZATION = 'authorization', // Permission errors
  DATABASE = 'database', // D1 database errors
  RATE_LIMIT = 'rate_limit', // Rate limiting errors
  NOT_FOUND = 'not_found', // Resource not found
  INTERNAL = 'internal', // Internal server errors
  EXTERNAL = 'external', // External service errors
  UNKNOWN = 'unknown', // Unclassified errors
}

/**
 * Error context for tracking
 */
export interface ErrorContext {
  requestId?: string;
  userId?: string;
  path?: string;
  method?: string;
  statusCode?: number;
  userAgent?: string;
  ipAddress?: string;
  correlationId?: string;
  [key: string]: unknown;
}

/**
 * Tracked error structure
 */
export interface TrackedError {
  name: string;
  message: string;
  stack?: string;
  category: ErrorCategory;
  severity: ErrorSeverity;
  code?: string;
  context: ErrorContext;
  timestamp: string;
}

/**
 * Error tracking configuration
 */
export interface ErrorTrackerConfig {
  /** Enable/disable analytics engine writes (useful for testing) */
  enableAnalytics?: boolean;
  /** Environment name for partitioning */
  environment?: string;
  /** Minimum severity to track (lower severities are logged but not tracked) */
  minSeverity?: ErrorSeverity;
  /** Custom error categorizer function */
  categorizer?: (
    error: Error,
    statusCode?: number
  ) => { category: ErrorCategory; severity: ErrorSeverity };
}

/**
 * Default error categorization based on error type and status code
 */
export function categorizeError(
  error: Error | unknown,
  statusCode?: number
): { category: ErrorCategory; severity: ErrorSeverity } {
  const errorMessage =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const errorName = error instanceof Error ? error.name : 'Error';

  // Validation errors (400)
  if (
    statusCode === 400 ||
    errorName === 'ZodError' ||
    errorName === 'ValidationError' ||
    errorName === 'BadRequestError' ||
    errorMessage.includes('validation')
  ) {
    return { category: ErrorCategory.VALIDATION, severity: ErrorSeverity.LOW };
  }

  // Authentication errors (401)
  if (
    statusCode === 401 ||
    errorName === 'UnauthorizedError' ||
    errorMessage.includes('unauthorized') ||
    errorMessage.includes('authentication') ||
    errorMessage.includes('invalid token')
  ) {
    return { category: ErrorCategory.AUTHENTICATION, severity: ErrorSeverity.MEDIUM };
  }

  // Authorization errors (403)
  if (
    statusCode === 403 ||
    errorName === 'ForbiddenError' ||
    errorMessage.includes('forbidden') ||
    errorMessage.includes('permission')
  ) {
    return { category: ErrorCategory.AUTHORIZATION, severity: ErrorSeverity.MEDIUM };
  }

  // Not found errors (404)
  if (statusCode === 404 || errorName === 'NotFoundError' || errorMessage.includes('not found')) {
    return { category: ErrorCategory.NOT_FOUND, severity: ErrorSeverity.LOW };
  }

  // Rate limiting (429)
  if (
    statusCode === 429 ||
    errorMessage.includes('rate limit') ||
    errorMessage.includes('too many requests')
  ) {
    return { category: ErrorCategory.RATE_LIMIT, severity: ErrorSeverity.LOW };
  }

  // Database errors
  if (
    errorMessage.includes('d1_') ||
    errorMessage.includes('database') ||
    errorMessage.includes('sqlite') ||
    errorMessage.includes('sql error')
  ) {
    return { category: ErrorCategory.DATABASE, severity: ErrorSeverity.HIGH };
  }

  // External service errors
  if (
    errorMessage.includes('fetch') ||
    errorMessage.includes('network') ||
    errorMessage.includes('timeout') ||
    errorMessage.includes('external')
  ) {
    return { category: ErrorCategory.EXTERNAL, severity: ErrorSeverity.MEDIUM };
  }

  // Internal server errors (500+)
  if (statusCode && statusCode >= 500) {
    return { category: ErrorCategory.INTERNAL, severity: ErrorSeverity.HIGH };
  }

  // Unknown errors
  return { category: ErrorCategory.UNKNOWN, severity: ErrorSeverity.MEDIUM };
}

/**
 * Get severity level as numeric value for comparison
 */
function getSeverityLevel(severity: ErrorSeverity): number {
  const levels: Record<ErrorSeverity, number> = {
    [ErrorSeverity.LOW]: 0,
    [ErrorSeverity.MEDIUM]: 1,
    [ErrorSeverity.HIGH]: 2,
    [ErrorSeverity.CRITICAL]: 3,
  };
  return levels[severity];
}

/**
 * Error Tracker class for tracking and monitoring errors
 */
export class ErrorTracker {
  private analytics?: AnalyticsEngineDataset;
  private config: Required<ErrorTrackerConfig>;
  private logger: Logger;

  constructor(analytics?: AnalyticsEngineDataset, config: ErrorTrackerConfig = {}) {
    this.analytics = analytics;
    this.config = {
      enableAnalytics: config.enableAnalytics ?? true,
      environment: config.environment ?? 'development',
      minSeverity: config.minSeverity ?? ErrorSeverity.LOW,
      categorizer: config.categorizer ?? categorizeError,
    };
    this.logger = createLogger({ component: 'error-tracker' }, LogLevel.DEBUG);
  }

  /**
   * Track an error with full context
   * Logs the error and writes to Analytics Engine if available
   */
  track(error: Error | unknown, context: ErrorContext = {}, statusCode?: number): TrackedError {
    const errorObj = error instanceof Error ? error : new Error(String(error));
    const { category, severity } = this.config.categorizer(errorObj, statusCode);

    // Redact sensitive data from error message
    const errorMessage =
      error instanceof Error
        ? redactSensitiveData(error.message)
        : redactSensitiveData(String(error));

    const trackedError: TrackedError = {
      name: error instanceof Error ? error.name : 'Error',
      message: errorMessage,
      stack: error instanceof Error ? this.sanitizeStack(error.stack) : undefined,
      category,
      severity,
      code: (error as Error & { code?: string })?.code,
      context: {
        ...context,
        statusCode: statusCode ?? context.statusCode,
      },
      timestamp: new Date().toISOString(),
    };

    // Log the error with full details
    this.logError(trackedError);

    // Write to Analytics Engine if severity meets threshold
    if (this.shouldTrack(severity)) {
      this.writeToAnalytics(trackedError);
    }

    return trackedError;
  }

  /**
   * Track a validation error (convenience method)
   */
  trackValidation(error: Error | unknown, context: ErrorContext = {}): TrackedError {
    return this.track(error, context, 400);
  }

  /**
   * Track an authentication error (convenience method)
   */
  trackAuth(error: Error | unknown, context: ErrorContext = {}): TrackedError {
    return this.track(error, context, 401);
  }

  /**
   * Track a database error (convenience method)
   */
  trackDatabase(error: Error | unknown, context: ErrorContext = {}): TrackedError {
    const trackedError = this.track(error, context, 500);
    // Force high severity for database errors
    trackedError.severity = ErrorSeverity.HIGH;
    trackedError.category = ErrorCategory.DATABASE;
    return trackedError;
  }

  /**
   * Check if error severity meets tracking threshold
   */
  private shouldTrack(severity: ErrorSeverity): boolean {
    return getSeverityLevel(severity) >= getSeverityLevel(this.config.minSeverity);
  }

  /**
   * Log error with structured format
   */
  private logError(trackedError: TrackedError): void {
    const logContext = {
      errorName: trackedError.name,
      errorCode: trackedError.code,
      category: trackedError.category,
      severity: trackedError.severity,
      ...trackedError.context,
    };

    // Use appropriate log level based on severity
    switch (trackedError.severity) {
      case ErrorSeverity.CRITICAL:
      case ErrorSeverity.HIGH:
        this.logger.error(trackedError.message, new Error(trackedError.message), logContext);
        break;
      case ErrorSeverity.MEDIUM:
        this.logger.warn(trackedError.message, logContext);
        break;
      case ErrorSeverity.LOW:
      default:
        this.logger.info(trackedError.message, logContext);
    }
  }

  /**
   * Write error data to Analytics Engine
   *
   * Data structure:
   * - blobs[0]: Error name
   * - blobs[1]: Error category
   * - blobs[2]: Error severity
   * - blobs[3]: Error code (or 'unknown')
   * - blobs[4]: Request method (or 'unknown')
   * - blobs[5]: Request path (first 256 chars)
   * - blobs[6]: User ID (or 'anonymous')
   * - blobs[7]: Error message (first 256 chars, redacted)
   * - blobs[8]: Environment
   * - doubles[0]: Status code
   * - doubles[1]: Timestamp (Unix ms)
   * - indexes[0]: Environment (for partitioning)
   */
  private writeToAnalytics(trackedError: TrackedError): void {
    if (!this.analytics || !this.config.enableAnalytics) {
      return;
    }

    try {
      this.analytics.writeDataPoint({
        blobs: [
          trackedError.name,
          trackedError.category,
          trackedError.severity,
          trackedError.code || 'unknown',
          trackedError.context.method || 'unknown',
          (trackedError.context.path || 'unknown').substring(0, 256),
          trackedError.context.userId || 'anonymous',
          trackedError.message.substring(0, 256),
          this.config.environment,
        ],
        doubles: [trackedError.context.statusCode || 0, Date.now()],
        indexes: [this.config.environment],
      });
    } catch (writeError) {
      // Don't let analytics failures affect the application
      this.logger.warn('Failed to write error to Analytics Engine', {
        writeError: writeError instanceof Error ? writeError.message : String(writeError),
      });
    }
  }

  /**
   * Sanitize stack trace to remove sensitive information
   */
  private sanitizeStack(stack?: string): string | undefined {
    if (!stack) return undefined;

    // First try to redact using the general sensitive data function
    let sanitized = redactSensitiveData(stack) as string;

    // Additionally redact patterns like "key=value" where key is sensitive
    const sensitivePatterns = [
      'password',
      'token',
      'secret',
      'api_key',
      'apiKey',
      'auth',
      'credential',
      'credentials',
    ];

    for (const pattern of sensitivePatterns) {
      // Match patterns like "word=value" where word is sensitive
      const regex = new RegExp(`${pattern}\\s*=\\s*\\S+`, 'gi');
      sanitized = sanitized.replace(regex, `${pattern}=[REDACTED]`);
    }

    return sanitized;
  }
}

/**
 * Create an error tracker instance
 *
 * @param analytics - Analytics Engine dataset binding (from env.ANALYTICS)
 * @param config - Error tracker configuration
 */
export function createErrorTracker(
  analytics?: AnalyticsEngineDataset,
  config?: ErrorTrackerConfig
): ErrorTracker {
  return new ErrorTracker(analytics, config);
}

/**
 * Default error tracker instance (without Analytics Engine)
 * Use createErrorTracker() with analytics binding for full functionality
 */
export const errorTracker = new ErrorTracker();
