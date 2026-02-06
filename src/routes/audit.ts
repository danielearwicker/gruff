/**
 * Audit log routes
 *
 * Provides endpoints for querying audit logs
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { requireAuth, requireAdmin, requireAdminOrSelf } from '../middleware/auth.js';
import {
  auditLogQuerySchema,
  auditLogResponseSchema,
  auditResourceTypeSchema,
  type AuditLogResponse,
  type AuditResourceType,
} from '../schemas/index.js';
import { ErrorResponseSchema } from '../schemas/openapi-common.js';
import { getLogger } from '../middleware/request-context.js';
import { hasPermission } from '../utils/acl.js';

type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  JWT_SECRET: string;
  ENVIRONMENT: string;
};

interface AuditLogRow {
  id: string;
  operation: string;
  resource_type: string;
  resource_id: string;
  user_id: string | null;
  timestamp: number;
  details: string | null;
  ip_address: string | null;
  user_agent: string | null;
}

const auditRouter = new OpenAPIHono<{ Bindings: Bindings }>();

// ============================================================================
// Response schemas
// ============================================================================

const AuditLogListResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.array(auditLogResponseSchema).openapi({
      description: 'Array of audit log entries',
    }),
    metadata: z
      .object({
        hasMore: z
          .boolean()
          .openapi({ example: false, description: 'Whether more results are available' }),
        cursor: z
          .string()
          .optional()
          .openapi({ example: '1704067200', description: 'Cursor for next page' }),
      })
      .optional(),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('AuditLogListResponse');

const ResourceAuditHistoryResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({
      resource_type: auditResourceTypeSchema.openapi({ example: 'entity' }),
      resource_id: z.string().uuid().openapi({ example: '550e8400-e29b-41d4-a716-446655440001' }),
      audit_history: z.array(auditLogResponseSchema).openapi({
        description: 'Array of audit log entries for this resource',
      }),
      count: z.number().int().openapi({ example: 5, description: 'Number of audit entries' }),
    }),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('ResourceAuditHistoryResponse');

const UserAuditLogsResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({
      user_id: z.string().uuid().openapi({ example: '550e8400-e29b-41d4-a716-446655440002' }),
      audit_logs: z.array(auditLogResponseSchema).openapi({
        description: 'Array of audit log entries for this user',
      }),
      count: z.number().int().openapi({ example: 10, description: 'Number of audit entries' }),
    }),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('UserAuditLogsResponse');

// ============================================================================
// Path param schemas
// ============================================================================

const ResourceAuditParamsSchema = z.object({
  resource_type: z.string().openapi({
    param: { name: 'resource_type', in: 'path' },
    example: 'entity',
    description: 'Resource type (entity, link, type, user)',
  }),
  resource_id: z.string().openapi({
    param: { name: 'resource_id', in: 'path' },
    example: '550e8400-e29b-41d4-a716-446655440001',
    description: 'Resource ID (UUID)',
  }),
});

const UserAuditParamsSchema = z.object({
  user_id: z.string().openapi({
    param: { name: 'user_id', in: 'path' },
    example: '550e8400-e29b-41d4-a716-446655440002',
    description: 'User ID (UUID)',
  }),
});

// Query schema for user audit endpoint (just limit)
const userAuditQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .openapi({
      param: { name: 'limit', in: 'query' },
      example: '50',
      description: 'Maximum number of audit entries to return (1-100, default: 50)',
    })
    .transform(val => (val ? Math.min(Math.max(parseInt(val, 10) || 50, 1), 100) : 50)),
});

// ============================================================================
// Route definitions
// ============================================================================

/**
 * GET /api/audit route definition
 */
const listAuditLogsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Audit'],
  summary: 'Query audit logs',
  description: 'Get audit logs with optional filters. Requires admin role.',
  operationId: 'getAuditLogs',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth(), requireAdmin()] as const,
  request: {
    query: auditLogQuerySchema,
  },
  responses: {
    200: {
      description: 'Audit logs',
      content: {
        'application/json': {
          schema: AuditLogListResponseSchema,
        },
      },
    },
    401: {
      description: 'Authentication required',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    403: {
      description: 'Admin access required',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    500: {
      description: 'Failed to query audit logs',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

/**
 * GET /api/audit/resource/{resource_type}/{resource_id} route definition
 */
const getResourceAuditRoute = createRoute({
  method: 'get',
  path: '/resource/{resource_type}/{resource_id}',
  tags: ['Audit'],
  summary: 'Get resource audit history',
  description:
    'Get audit history for a specific resource. Requires read permission on the resource (for entities/links) or admin role (for types/users).',
  operationId: 'getResourceAuditHistory',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth()] as const,
  request: {
    params: ResourceAuditParamsSchema,
  },
  responses: {
    200: {
      description: 'Resource audit history',
      content: {
        'application/json': {
          schema: ResourceAuditHistoryResponseSchema,
        },
      },
    },
    400: {
      description: 'Invalid resource type or ID',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    401: {
      description: 'Authentication required',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    403: {
      description: 'Insufficient permissions',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    500: {
      description: 'Failed to query resource audit history',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

/**
 * GET /api/audit/user/{user_id} route definition
 */
const getUserAuditRoute = createRoute({
  method: 'get',
  path: '/user/{user_id}',
  tags: ['Audit'],
  summary: 'Get user audit history',
  description:
    'Get all actions performed by a user. Requires admin role or requesting own audit logs.',
  operationId: 'getUserAuditHistory',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth(), requireAdminOrSelf('user_id')] as const,
  request: {
    params: UserAuditParamsSchema,
    query: userAuditQuerySchema,
  },
  responses: {
    200: {
      description: 'User audit history',
      content: {
        'application/json': {
          schema: UserAuditLogsResponseSchema,
        },
      },
    },
    400: {
      description: 'Invalid user ID format',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    401: {
      description: 'Authentication required',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    403: {
      description: 'Admin access required or must be own user',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    404: {
      description: 'User not found',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    500: {
      description: 'Failed to query user audit logs',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

// ============================================================================
// Route handlers
// ============================================================================

/**
 * GET /api/audit
 *
 * Query audit logs with filtering and pagination
 * Requires admin role
 */
auditRouter.openapi(listAuditLogsRoute, async c => {
  const logger = getLogger(c);
  const validated = c.req.valid('query');

  const { user_id, resource_type, resource_id, operation, start_date, end_date, limit, cursor } =
    validated;

  try {
    // Build the query dynamically
    let query = 'SELECT * FROM audit_logs WHERE 1=1';
    const params: (string | number)[] = [];

    if (user_id) {
      query += ' AND user_id = ?';
      params.push(user_id);
    }

    if (resource_type) {
      query += ' AND resource_type = ?';
      params.push(resource_type);
    }

    if (resource_id) {
      query += ' AND resource_id = ?';
      params.push(resource_id);
    }

    if (operation) {
      query += ' AND operation = ?';
      params.push(operation);
    }

    if (start_date) {
      query += ' AND timestamp >= ?';
      params.push(start_date);
    }

    if (end_date) {
      query += ' AND timestamp <= ?';
      params.push(end_date);
    }

    // Handle cursor-based pagination (cursor is the timestamp of the last item)
    if (cursor) {
      query += ' AND timestamp < ?';
      params.push(parseInt(cursor, 10));
    }

    // Order by timestamp descending (most recent first)
    query += ' ORDER BY timestamp DESC';

    // Fetch one extra to determine if there are more results
    query += ' LIMIT ?';
    params.push(limit + 1);

    const stmt = c.env.DB.prepare(query);
    const results = await stmt.bind(...params).all();

    // Determine if there are more results
    const logs = (results.results || []) as unknown as AuditLogRow[];
    const hasMore = logs.length > limit;
    const items = hasMore ? logs.slice(0, limit) : logs;

    // Get the cursor for the next page (timestamp of last item)
    const nextCursor =
      hasMore && items.length > 0 ? String(items[items.length - 1].timestamp) : null;

    // Format the audit logs (parse JSON details)
    const formattedLogs = items.map(
      log =>
        ({
          id: log.id,
          operation: log.operation,
          resource_type: log.resource_type,
          resource_id: log.resource_id,
          user_id: log.user_id,
          timestamp: log.timestamp,
          details: log.details ? JSON.parse(log.details) : null,
          ip_address: log.ip_address,
          user_agent: log.user_agent,
        }) as AuditLogResponse
    );

    logger.info('Audit logs queried', {
      count: formattedLogs.length,
      filters: { user_id, resource_type, resource_id, operation, start_date, end_date },
    });

    return c.json(
      {
        success: true as const,
        data: formattedLogs,
        metadata: {
          hasMore,
          ...(nextCursor && { cursor: nextCursor }),
        },
        timestamp: new Date().toISOString(),
      },
      200
    );
  } catch (err) {
    logger.error('Error querying audit logs', err as Error);
    return c.json(
      {
        success: false as const,
        error: 'Failed to query audit logs',
        code: 'AUDIT_QUERY_FAILED',
        timestamp: new Date().toISOString(),
      },
      500
    );
  }
});

/**
 * GET /api/audit/resource/{resource_type}/{resource_id}
 *
 * Get audit history for a specific resource
 * Requires authentication and read permission on the resource (for entities/links)
 * For type and user resources, requires admin role
 */
auditRouter.openapi(getResourceAuditRoute, async c => {
  const logger = getLogger(c);
  const db = c.env.DB;
  const kv = c.env.KV;
  const user = c.get('user');
  const { resource_type: resourceType, resource_id: resourceId } = c.req.valid('param');

  // Validate resource type
  const validResourceTypes = ['entity', 'link', 'type', 'user'];
  if (!validResourceTypes.includes(resourceType)) {
    return c.json(
      {
        success: false as const,
        error: `Invalid resource type. Must be one of: ${validResourceTypes.join(', ')}`,
        code: 'INVALID_RESOURCE_TYPE',
        timestamp: new Date().toISOString(),
      },
      400
    );
  }

  // Validate resource ID (should be a UUID)
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(resourceId)) {
    return c.json(
      {
        success: false as const,
        error: 'Invalid resource ID format',
        code: 'INVALID_RESOURCE_ID',
        timestamp: new Date().toISOString(),
      },
      400
    );
  }

  try {
    // Check authorization based on resource type
    if (resourceType === 'entity' || resourceType === 'link') {
      // Check if user has read permission on the entity or link
      const canRead = await hasPermission(
        db,
        kv,
        user.user_id,
        resourceType as 'entity' | 'link',
        resourceId,
        'read'
      );
      if (!canRead) {
        return c.json(
          {
            success: false as const,
            error: 'You do not have permission to view audit history for this resource',
            code: 'FORBIDDEN',
            timestamp: new Date().toISOString(),
          },
          403
        );
      }
    } else {
      // For type and user audit history, require admin role
      if (!user.is_admin) {
        return c.json(
          {
            success: false as const,
            error: 'Admin access required to view audit history for this resource type',
            code: 'FORBIDDEN',
            timestamp: new Date().toISOString(),
          },
          403
        );
      }
    }

    const results = await db
      .prepare(
        `SELECT * FROM audit_logs
       WHERE resource_type = ? AND resource_id = ?
       ORDER BY timestamp DESC
       LIMIT 100`
      )
      .bind(resourceType, resourceId)
      .all();

    const logs = ((results.results || []) as unknown as AuditLogRow[]).map(
      log =>
        ({
          id: log.id,
          operation: log.operation,
          resource_type: log.resource_type,
          resource_id: log.resource_id,
          user_id: log.user_id,
          timestamp: log.timestamp,
          details: log.details ? JSON.parse(log.details) : null,
          ip_address: log.ip_address,
          user_agent: log.user_agent,
        }) as AuditLogResponse
    );

    logger.info('Resource audit history queried', {
      resourceType,
      resourceId,
      count: logs.length,
    });

    return c.json(
      {
        success: true as const,
        data: {
          resource_type: resourceType as AuditResourceType,
          resource_id: resourceId,
          audit_history: logs,
          count: logs.length,
        },
        timestamp: new Date().toISOString(),
      },
      200
    );
  } catch (err) {
    logger.error('Error querying resource audit history', err as Error, {
      resourceType,
      resourceId,
    });
    return c.json(
      {
        success: false as const,
        error: 'Failed to query resource audit history',
        code: 'AUDIT_HISTORY_FAILED',
        timestamp: new Date().toISOString(),
      },
      500
    );
  }
});

/**
 * GET /api/audit/user/{user_id}
 *
 * Get audit logs for actions performed by a specific user
 * Requires admin role or the user requesting their own audit logs
 */
auditRouter.openapi(getUserAuditRoute, async c => {
  const logger = getLogger(c);
  const { user_id: userId } = c.req.valid('param');
  const { limit } = c.req.valid('query');

  // Validate user ID (should be a UUID)
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(userId)) {
    return c.json(
      {
        success: false as const,
        error: 'Invalid user ID format',
        code: 'INVALID_USER_ID',
        timestamp: new Date().toISOString(),
      },
      400
    );
  }

  try {
    // Verify user exists
    const user = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();

    if (!user) {
      return c.json(
        {
          success: false as const,
          error: 'User not found',
          code: 'NOT_FOUND',
          timestamp: new Date().toISOString(),
        },
        404
      );
    }

    const results = await c.env.DB.prepare(
      `SELECT * FROM audit_logs
       WHERE user_id = ?
       ORDER BY timestamp DESC
       LIMIT ?`
    )
      .bind(userId, limit)
      .all();

    const logs = ((results.results || []) as unknown as AuditLogRow[]).map(
      log =>
        ({
          id: log.id,
          operation: log.operation,
          resource_type: log.resource_type,
          resource_id: log.resource_id,
          user_id: log.user_id,
          timestamp: log.timestamp,
          details: log.details ? JSON.parse(log.details) : null,
          ip_address: log.ip_address,
          user_agent: log.user_agent,
        }) as AuditLogResponse
    );

    logger.info('User audit logs queried', { userId, count: logs.length });

    return c.json(
      {
        success: true as const,
        data: {
          user_id: userId,
          audit_logs: logs,
          count: logs.length,
        },
        timestamp: new Date().toISOString(),
      },
      200
    );
  } catch (err) {
    logger.error('Error querying user audit logs', err as Error, { userId });
    return c.json(
      {
        success: false as const,
        error: 'Failed to query user audit logs',
        code: 'USER_AUDIT_FAILED',
        timestamp: new Date().toISOString(),
      },
      500
    );
  }
});

export default auditRouter;
