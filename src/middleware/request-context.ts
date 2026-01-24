import { Context, MiddlewareHandler } from 'hono';
import { createLogger, Logger } from '../utils/logger.js';

/**
 * Request context that will be available throughout the request lifecycle
 */
export interface RequestContext {
  requestId: string;
  logger: Logger;
  startTime: number;
}

/**
 * Middleware to add request context to all requests
 * This includes:
 * - Request ID for tracing
 * - Logger with request context
 * - Request metadata (method, path, user, duration)
 */
export const requestContextMiddleware: MiddlewareHandler = async (c: Context, next) => {
  // Generate unique request ID for tracing
  const requestId = crypto.randomUUID();

  // Capture start time for duration calculation
  const startTime = Date.now();

  // Create logger with request context
  const logger = createLogger({
    requestId,
    method: c.req.method,
    path: c.req.path,
    // User ID will be added later by auth middleware if available
  });

  // Store context in Hono's context variable system
  c.set('requestId', requestId);
  c.set('logger', logger);
  c.set('startTime', startTime);

  // Log incoming request
  logger.info('Incoming request', {
    userAgent: c.req.header('user-agent'),
    referer: c.req.header('referer'),
  });

  try {
    await next();

    // Calculate request duration
    const duration = Date.now() - startTime;

    // Log successful request completion
    logger.info('Request completed', {
      status: c.res.status,
      duration,
    });
  } catch (error) {
    // Calculate request duration even on error
    const duration = Date.now() - startTime;

    // Log error (will be caught by error handler middleware)
    logger.error('Request failed', error, {
      duration,
    });

    // Re-throw to be handled by error handler
    throw error;
  }
};

/**
 * Helper function to get the request ID from context
 */
export function getRequestId(c: Context): string {
  return c.get('requestId') as string;
}

/**
 * Helper function to get the logger from context
 */
export function getLogger(c: Context): Logger {
  return c.get('logger') as Logger;
}

/**
 * Helper function to add user context to the logger
 * This should be called by auth middleware after user is identified
 */
export function addUserToLogger(c: Context, userId: string): void {
  const currentLogger = getLogger(c);
  const enhancedLogger = currentLogger.child({ userId });
  c.set('logger', enhancedLogger);
}
