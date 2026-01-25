/**
 * Response Formatting Utilities
 *
 * Provides consistent response formatting across all API endpoints
 */

/**
 * Standard API response structure
 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  message?: string;
  metadata?: ResponseMetadata;
  timestamp: string;
}

/**
 * Metadata for responses (pagination, counts, etc.)
 */
export interface ResponseMetadata {
  page?: number;
  pageSize?: number;
  total?: number;
  hasMore?: boolean;
  cursor?: string;
  [key: string]: unknown;
}

/**
 * Pagination parameters
 */
export interface PaginationParams {
  cursor?: string;
  limit?: number;
  offset?: number;
}

/**
 * Success response with data
 */
export function success<T>(data: T, message?: string, metadata?: ResponseMetadata): ApiResponse<T> {
  const response: ApiResponse<T> = {
    success: true,
    data,
    timestamp: new Date().toISOString(),
  };

  if (message) {
    response.message = message;
  }

  if (metadata) {
    response.metadata = metadata;
  }

  return response;
}

/**
 * Error response
 */
export function error(message: string, code: string = 'ERROR', details?: unknown): ApiResponse {
  const response: ApiResponse = {
    success: false,
    error: message,
    code,
    timestamp: new Date().toISOString(),
  };

  if (details) {
    response.data = details;
  }

  return response;
}

/**
 * Paginated response helper
 */
export function paginated<T>(
  items: T[],
  total: number,
  page: number,
  pageSize: number,
  hasMore: boolean = false
): ApiResponse<T[]> {
  return success(items, undefined, {
    page,
    pageSize,
    total,
    hasMore,
  });
}

/**
 * Cursor-based paginated response helper
 */
export function cursorPaginated<T>(
  items: T[],
  cursor: string | null,
  hasMore: boolean,
  total?: number
): ApiResponse<T[]> {
  const metadata: ResponseMetadata = {
    hasMore,
  };

  if (cursor) {
    metadata.cursor = cursor;
  }

  if (total !== undefined) {
    metadata.total = total;
  }

  return success(items, undefined, metadata);
}

/**
 * Created response (201)
 */
export function created<T>(
  data: T,
  message: string = 'Resource created successfully'
): ApiResponse<T> {
  return success(data, message);
}

/**
 * Updated response (200)
 */
export function updated<T>(
  data: T,
  message: string = 'Resource updated successfully'
): ApiResponse<T> {
  return success(data, message);
}

/**
 * Deleted response (200)
 */
export function deleted(message: string = 'Resource deleted successfully'): ApiResponse {
  return {
    success: true,
    message,
    timestamp: new Date().toISOString(),
  };
}

/**
 * No content response (204)
 */
export function noContent(): ApiResponse {
  return {
    success: true,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Not found error (404)
 */
export function notFound(resource: string = 'Resource'): ApiResponse {
  return error(`${resource} not found`, 'NOT_FOUND');
}

/**
 * Validation error (400)
 */
export function validationError(details: unknown): ApiResponse {
  return error('Validation failed', 'VALIDATION_ERROR', details);
}

/**
 * Unauthorized error (401)
 */
export function unauthorized(message: string = 'Unauthorized'): ApiResponse {
  return error(message, 'UNAUTHORIZED');
}

/**
 * Forbidden error (403)
 */
export function forbidden(message: string = 'Forbidden'): ApiResponse {
  return error(message, 'FORBIDDEN');
}

/**
 * Conflict error (409)
 */
export function conflict(message: string): ApiResponse {
  return error(message, 'CONFLICT');
}

/**
 * Internal server error (500)
 */
export function internalError(message: string = 'Internal server error'): ApiResponse {
  return error(message, 'INTERNAL_SERVER_ERROR');
}

/**
 * Bad request error (400)
 */
export function badRequest(message: string): ApiResponse {
  return error(message, 'BAD_REQUEST');
}
