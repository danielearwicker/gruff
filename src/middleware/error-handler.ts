import { Context, MiddlewareHandler } from 'hono';
import { ZodError } from 'zod';
import { createLogger } from '../utils/logger.js';

/**
 * Custom error classes for better error handling
 */

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
    public details?: unknown
  ) {
    super(message);
    this.name = this.constructor.name;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, message, 'BAD_REQUEST', details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = 'Unauthorized', details?: unknown) {
    super(401, message, 'UNAUTHORIZED', details);
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = 'Forbidden', details?: unknown) {
    super(403, message, 'FORBIDDEN', details);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = 'Resource not found', details?: unknown) {
    super(404, message, 'NOT_FOUND', details);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(409, message, 'CONFLICT', details);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(422, message, 'VALIDATION_ERROR', details);
  }
}

export class InternalServerError extends AppError {
  constructor(message: string = 'Internal server error', details?: unknown) {
    super(500, message, 'INTERNAL_SERVER_ERROR', details);
  }
}

/**
 * Error response format
 */
interface ErrorResponse {
  error: string;
  code?: string;
  details?: unknown;
  timestamp: string;
  path?: string;
  requestId?: string;
}

/**
 * Global error handler middleware for Hono
 * Catches all errors and formats them into consistent JSON responses
 */
export const errorHandler: MiddlewareHandler = async (c: Context, next) => {
  try {
    await next();
  } catch (error) {
    // Get request ID and logger from context (set by request context middleware)
    // Fallback to generating new ones if not available (shouldn't happen in normal flow)
    const requestId = (c.get('requestId') as string) || crypto.randomUUID();
    const logger = (c.get('logger') as ReturnType<typeof createLogger>) || createLogger({
      requestId,
      path: c.req.path,
      method: c.req.method,
    });

    // Default error response
    let statusCode = 500;
    let errorResponse: ErrorResponse = {
      error: 'Internal server error',
      code: 'INTERNAL_SERVER_ERROR',
      timestamp: new Date().toISOString(),
      path: c.req.path,
      requestId,
    };

    // Handle Zod validation errors
    if (error instanceof ZodError || (error as any)?.name === 'ZodError') {
      const zodError = error as ZodError;
      statusCode = 400;
      errorResponse = {
        error: 'Validation failed',
        code: 'VALIDATION_ERROR',
        details: zodError.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
          code: issue.code,
        })),
        timestamp: new Date().toISOString(),
        path: c.req.path,
        requestId,
      };
    }
    // Handle custom application errors
    else if (error instanceof AppError) {
      statusCode = error.statusCode;
      errorResponse = {
        error: error.message,
        code: error.code,
        details: error.details,
        timestamp: new Date().toISOString(),
        path: c.req.path,
        requestId,
      };
    }
    // Handle JSON parse errors
    else if (error instanceof SyntaxError && error.message.includes('JSON')) {
      statusCode = 400;
      errorResponse = {
        error: 'Invalid JSON in request body',
        code: 'INVALID_JSON',
        details: error.message,
        timestamp: new Date().toISOString(),
        path: c.req.path,
        requestId,
      };
    }
    // Handle D1 database errors
    else if (error instanceof Error && error.message.includes('D1_')) {
      statusCode = 500;
      errorResponse = {
        error: 'Database error',
        code: 'DATABASE_ERROR',
        // Don't leak detailed database errors in production
        details: c.env?.ENVIRONMENT === 'production' ? undefined : error.message,
        timestamp: new Date().toISOString(),
        path: c.req.path,
        requestId,
      };
    }
    // Handle generic errors
    else if (error instanceof Error) {
      // In production, don't leak error details
      const isDevelopment = c.env?.ENVIRONMENT !== 'production';
      errorResponse = {
        error: isDevelopment ? error.message : 'Internal server error',
        code: 'INTERNAL_SERVER_ERROR',
        details: isDevelopment ? { stack: error.stack } : undefined,
        timestamp: new Date().toISOString(),
        path: c.req.path,
        requestId,
      };
    }

    // Log error details for monitoring
    logger.error(
      'Request error',
      error instanceof Error ? error : new Error(String(error)),
      {
        statusCode,
        errorCode: errorResponse.code,
      }
    );

    return c.json(errorResponse, statusCode as any);
  }
};

/**
 * 404 Not Found handler
 * Should be added as the last route in the application
 */
export const notFoundHandler = async (c: Context) => {
  return c.json(
    {
      error: 'Not Found',
      code: 'NOT_FOUND',
      message: `Route ${c.req.method} ${c.req.path} not found`,
      timestamp: new Date().toISOString(),
      path: c.req.path,
    },
    404
  );
};
