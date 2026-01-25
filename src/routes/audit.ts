/**
 * Audit log routes
 *
 * Provides endpoints for querying audit logs
 */

import { Hono } from 'hono';
import { validateQuery } from '../middleware/validation.js';
import { requireAuth } from '../middleware/auth.js';
import { auditLogQuerySchema } from '../schemas/index.js';
import * as response from '../utils/response.js';
import { getLogger } from '../middleware/request-context.js';

type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  JWT_SECRET: string;
  ENVIRONMENT: string;
};

interface AuditLogRow {
  id: number;
  operation: string;
  resource_type: string;
  resource_id: string;
  user_id: string;
  timestamp: number;
  details: string | null;
  ip_address?: string;
  user_agent?: string;
}

const auditRouter = new Hono<{ Bindings: Bindings }>();

/**
 * GET /api/audit
 *
 * Query audit logs with filtering and pagination
 * Requires authentication
 *
 * Query parameters:
 * - user_id: Filter by user who performed the action
 * - resource_type: Filter by resource type (entity, link, type, user)
 * - resource_id: Filter by specific resource ID
 * - operation: Filter by operation type (create, update, delete, restore)
 * - start_date: Filter logs after this timestamp (inclusive)
 * - end_date: Filter logs before this timestamp (inclusive)
 * - limit: Number of results (default 20, max 100)
 * - cursor: Pagination cursor
 */
auditRouter.get('/', requireAuth(), validateQuery(auditLogQuerySchema), async c => {
  const logger = getLogger(c);
  const validated = c.get('validated_query') as {
    user_id?: string;
    resource_type?: string;
    resource_id?: string;
    operation?: string;
    start_date?: number;
    end_date?: number;
    limit: number;
    cursor?: string;
  };

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
    const formattedLogs = items.map(log => ({
      id: log.id,
      operation: log.operation,
      resource_type: log.resource_type,
      resource_id: log.resource_id,
      user_id: log.user_id,
      timestamp: log.timestamp,
      details: log.details ? JSON.parse(log.details) : null,
      ip_address: log.ip_address,
      user_agent: log.user_agent,
    }));

    logger.info('Audit logs queried', {
      count: formattedLogs.length,
      filters: { user_id, resource_type, resource_id, operation, start_date, end_date },
    });

    return c.json(response.cursorPaginated(formattedLogs, nextCursor, hasMore));
  } catch (error) {
    logger.error('Error querying audit logs', error as Error);
    return c.json(response.error('Failed to query audit logs', 'AUDIT_QUERY_FAILED'), 500);
  }
});

/**
 * GET /api/audit/resource/:resource_type/:resource_id
 *
 * Get audit history for a specific resource
 * Requires authentication
 */
auditRouter.get('/resource/:resource_type/:resource_id', requireAuth(), async c => {
  const logger = getLogger(c);
  const resourceType = c.req.param('resource_type');
  const resourceId = c.req.param('resource_id');

  // Validate resource type
  const validResourceTypes = ['entity', 'link', 'type', 'user'];
  if (!validResourceTypes.includes(resourceType)) {
    return c.json(
      response.error(
        `Invalid resource type. Must be one of: ${validResourceTypes.join(', ')}`,
        'INVALID_RESOURCE_TYPE'
      ),
      400
    );
  }

  // Validate resource ID (should be a UUID)
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(resourceId)) {
    return c.json(response.error('Invalid resource ID format', 'INVALID_RESOURCE_ID'), 400);
  }

  try {
    const results = await c.env.DB.prepare(
      `SELECT * FROM audit_logs
       WHERE resource_type = ? AND resource_id = ?
       ORDER BY timestamp DESC
       LIMIT 100`
    )
      .bind(resourceType, resourceId)
      .all();

    const logs = ((results.results || []) as unknown as AuditLogRow[]).map(log => ({
      id: log.id,
      operation: log.operation,
      resource_type: log.resource_type,
      resource_id: log.resource_id,
      user_id: log.user_id,
      timestamp: log.timestamp,
      details: log.details ? JSON.parse(log.details) : null,
      ip_address: log.ip_address,
      user_agent: log.user_agent,
    }));

    logger.info('Resource audit history queried', {
      resourceType,
      resourceId,
      count: logs.length,
    });

    return c.json(
      response.success({
        resource_type: resourceType,
        resource_id: resourceId,
        audit_history: logs,
        count: logs.length,
      })
    );
  } catch (error) {
    logger.error('Error querying resource audit history', error as Error, {
      resourceType,
      resourceId,
    });
    return c.json(
      response.error('Failed to query resource audit history', 'AUDIT_HISTORY_FAILED'),
      500
    );
  }
});

/**
 * GET /api/audit/user/:user_id
 *
 * Get audit logs for actions performed by a specific user
 * Requires authentication
 */
auditRouter.get('/user/:user_id', requireAuth(), async c => {
  const logger = getLogger(c);
  const userId = c.req.param('user_id');

  // Validate user ID (should be a UUID)
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(userId)) {
    return c.json(response.error('Invalid user ID format', 'INVALID_USER_ID'), 400);
  }

  // Get query params for additional filtering
  const limitParam = c.req.query('limit');
  const limit = limitParam ? Math.min(parseInt(limitParam, 10), 100) : 50;

  try {
    // Verify user exists
    const user = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();

    if (!user) {
      return c.json(response.notFound('User'), 404);
    }

    const results = await c.env.DB.prepare(
      `SELECT * FROM audit_logs
       WHERE user_id = ?
       ORDER BY timestamp DESC
       LIMIT ?`
    )
      .bind(userId, limit)
      .all();

    const logs = ((results.results || []) as unknown as AuditLogRow[]).map(log => ({
      id: log.id,
      operation: log.operation,
      resource_type: log.resource_type,
      resource_id: log.resource_id,
      user_id: log.user_id,
      timestamp: log.timestamp,
      details: log.details ? JSON.parse(log.details) : null,
      ip_address: log.ip_address,
      user_agent: log.user_agent,
    }));

    logger.info('User audit logs queried', { userId, count: logs.length });

    return c.json(
      response.success({
        user_id: userId,
        audit_logs: logs,
        count: logs.length,
      })
    );
  } catch (error) {
    logger.error('Error querying user audit logs', error as Error, { userId });
    return c.json(response.error('Failed to query user audit logs', 'USER_AUDIT_FAILED'), 500);
  }
});

export default auditRouter;
