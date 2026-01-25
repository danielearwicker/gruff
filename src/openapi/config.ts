import { z } from '@hono/zod-openapi';

// OpenAPI document info
export const openApiInfo = {
  title: 'Gruff API',
  version: '1.0.0',
  description: `
# Entity-Relationship Graph Database with Versioning

Gruff is a graph database system built on Cloudflare D1 (SQLite) that supports versioned entities and relationships, user management, and flexible schema through JSON properties.

## Core Concepts

### Entities
- Fundamental nodes in the graph
- Have a type, custom JSON properties, and versioning
- Support soft deletion
- Every modification creates a new version

### Links
- Directed relationships between entities
- Have a type, custom JSON properties, and versioning
- Connect a source entity to a target entity

### Versioning
- Immutable history: updates create new records
- Each version references its predecessor
- Track user and timestamp for every change

### Types
- Centralized type registry for both entities and links
- Enables type-based queries and validation
- Optional JSON schema validation for properties

## Authentication

Most endpoints require authentication via JWT tokens. Include the token in the Authorization header:

\`\`\`
Authorization: Bearer <your-access-token>
\`\`\`

Obtain tokens via the \`/api/auth/login\` or \`/api/auth/register\` endpoints.

## Rate Limiting

The API implements rate limiting per user/IP:
- **Auth endpoints**: 20 requests/minute
- **Read operations**: 100 requests/minute
- **Write operations**: 60 requests/minute
- **Bulk operations**: 20 requests/minute
- **Search endpoints**: 60 requests/minute
- **Graph traversal**: 40 requests/minute

Rate limit headers are included in all responses:
- \`X-RateLimit-Limit\`: Maximum requests allowed
- \`X-RateLimit-Remaining\`: Requests remaining
- \`X-RateLimit-Reset\`: Time when the limit resets (Unix timestamp)
`,
  contact: {
    name: 'Gruff API Support',
  },
  license: {
    name: 'ISC',
  },
};

// OpenAPI servers configuration
export const openApiServers = [
  {
    url: 'http://localhost:8787',
    description: 'Local development server',
  },
];

// Security schemes
export const securitySchemes = {
  bearerAuth: {
    type: 'http' as const,
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: 'JWT access token obtained from /api/auth/login or /api/auth/register',
  },
};

// Common response schemas
export const ErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.string().openapi({
    example: 'Resource not found',
    description: 'Error message describing what went wrong',
  }),
  code: z.string().optional().openapi({
    example: 'NOT_FOUND',
    description: 'Machine-readable error code',
  }),
  timestamp: z.string().openapi({
    example: '2024-01-15T10:30:00.000Z',
    description: 'ISO 8601 timestamp when the error occurred',
  }),
  path: z.string().optional().openapi({
    example: '/api/entities/123',
    description: 'Request path that caused the error',
  }),
  requestId: z.string().optional().openapi({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description: 'Unique request identifier for debugging',
  }),
}).openapi('ErrorResponse');

export const ValidationErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.literal('Validation failed'),
  code: z.literal('VALIDATION_ERROR'),
  details: z.array(z.object({
    path: z.string().openapi({
      example: 'type_id',
      description: 'Field path that failed validation',
    }),
    message: z.string().openapi({
      example: 'Invalid UUID format',
      description: 'Validation error message',
    }),
    code: z.string().openapi({
      example: 'invalid_string',
      description: 'Zod validation error code',
    }),
  })),
  timestamp: z.string(),
  path: z.string(),
  requestId: z.string().optional(),
}).openapi('ValidationErrorResponse');

export const SuccessResponseSchema = z.object({
  success: z.literal(true),
  message: z.string().optional(),
  timestamp: z.string(),
}).openapi('SuccessResponse');

// Common parameter schemas
export const UuidPathParamSchema = z.string().uuid().openapi({
  param: {
    name: 'id',
    in: 'path',
  },
  example: '550e8400-e29b-41d4-a716-446655440000',
  description: 'Unique identifier (UUID)',
});

export const PaginationQuerySchema = z.object({
  limit: z.string().optional().openapi({
    param: {
      name: 'limit',
      in: 'query',
    },
    example: '20',
    description: 'Maximum number of items to return (1-100, default: 20)',
  }),
  cursor: z.string().optional().openapi({
    param: {
      name: 'cursor',
      in: 'query',
    },
    example: 'eyJpZCI6IjEyMyJ9',
    description: 'Cursor for pagination (from previous response)',
  }),
  include_deleted: z.string().optional().openapi({
    param: {
      name: 'include_deleted',
      in: 'query',
    },
    example: 'false',
    description: 'Include soft-deleted items (default: false)',
  }),
});
