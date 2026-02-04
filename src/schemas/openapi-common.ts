import { z } from '@hono/zod-openapi';

export const ErrorResponseSchema = z
  .object({
    success: z.literal(false),
    error: z.string().openapi({ example: 'Resource not found' }),
    code: z.string().optional().openapi({ example: 'NOT_FOUND' }),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
    path: z.string().optional(),
    requestId: z.string().optional(),
  })
  .openapi('ErrorResponse');

export const ValidationErrorResponseSchema = z
  .object({
    success: z.literal(false),
    error: z.literal('Validation failed'),
    code: z.literal('VALIDATION_ERROR'),
    details: z.array(
      z.object({
        path: z.string().openapi({ example: 'type_id' }),
        message: z.string().openapi({ example: 'Invalid UUID format' }),
        code: z.string().openapi({ example: 'invalid_string' }),
      })
    ),
    timestamp: z.string(),
    path: z.string(),
    requestId: z.string().optional(),
  })
  .openapi('ValidationErrorResponse');

export const SuccessResponseSchema = z
  .object({
    success: z.literal(true),
    message: z.string().optional(),
    timestamp: z.string(),
  })
  .openapi('SuccessResponse');

export const PaginationQuerySchema = z.object({
  limit: z.string().optional().openapi({
    param: { name: 'limit', in: 'query' },
    example: '20',
    description: 'Maximum number of items to return (1-100, default: 20)',
  }),
  cursor: z.string().optional().openapi({
    param: { name: 'cursor', in: 'query' },
    example: 'eyJpZCI6IjEyMyJ9',
    description: 'Cursor for pagination (from previous response)',
  }),
  include_deleted: z.string().optional().openapi({
    param: { name: 'include_deleted', in: 'query' },
    example: 'false',
    description: 'Include soft-deleted items (default: false)',
  }),
});
