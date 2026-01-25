/**
 * Audit Logging Utilities
 *
 * Provides functions for creating and querying audit log entries
 */

import { Context } from 'hono';
import { AuditOperation, CreateAuditLog } from '../schemas/index.js';

/**
 * Create an audit log entry
 *
 * @param db - D1 database instance
 * @param entry - Audit log entry data
 * @returns The created audit log ID
 */
export async function createAuditLog(
  db: D1Database,
  entry: CreateAuditLog & { ip_address?: string | null; user_agent?: string | null }
): Promise<string> {
  const id = crypto.randomUUID();
  const timestamp = Date.now();

  await db
    .prepare(
      `INSERT INTO audit_logs (id, operation, resource_type, resource_id, user_id, timestamp, details, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      entry.operation,
      entry.resource_type,
      entry.resource_id,
      entry.user_id || null,
      timestamp,
      entry.details ? JSON.stringify(entry.details) : null,
      entry.ip_address || null,
      entry.user_agent || null
    )
    .run();

  return id;
}

/**
 * Extract request metadata for audit logging
 *
 * @param c - Hono context
 * @returns Object with IP address and user agent
 */
export function extractRequestMetadata(c: Context): {
  ip_address: string | null;
  user_agent: string | null;
} {
  // Try to get the real IP from common headers (Cloudflare, proxies)
  const ip_address =
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-real-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    null;

  const user_agent = c.req.header('user-agent') || null;

  return { ip_address, user_agent };
}

/**
 * Log an entity operation
 */
export async function logEntityOperation(
  db: D1Database,
  c: Context,
  operation: AuditOperation,
  entityId: string,
  userId: string | null,
  details?: Record<string, unknown>
): Promise<string> {
  const { ip_address, user_agent } = extractRequestMetadata(c);

  return createAuditLog(db, {
    operation,
    resource_type: 'entity',
    resource_id: entityId,
    user_id: userId,
    details,
    ip_address,
    user_agent,
  });
}

/**
 * Log a link operation
 */
export async function logLinkOperation(
  db: D1Database,
  c: Context,
  operation: AuditOperation,
  linkId: string,
  userId: string | null,
  details?: Record<string, unknown>
): Promise<string> {
  const { ip_address, user_agent } = extractRequestMetadata(c);

  return createAuditLog(db, {
    operation,
    resource_type: 'link',
    resource_id: linkId,
    user_id: userId,
    details,
    ip_address,
    user_agent,
  });
}

/**
 * Log a type operation
 */
export async function logTypeOperation(
  db: D1Database,
  c: Context,
  operation: AuditOperation,
  typeId: string,
  userId: string | null,
  details?: Record<string, unknown>
): Promise<string> {
  const { ip_address, user_agent } = extractRequestMetadata(c);

  return createAuditLog(db, {
    operation,
    resource_type: 'type',
    resource_id: typeId,
    user_id: userId,
    details,
    ip_address,
    user_agent,
  });
}

/**
 * Log a user operation
 */
export async function logUserOperation(
  db: D1Database,
  c: Context,
  operation: AuditOperation,
  targetUserId: string,
  actingUserId: string | null,
  details?: Record<string, unknown>
): Promise<string> {
  const { ip_address, user_agent } = extractRequestMetadata(c);

  return createAuditLog(db, {
    operation,
    resource_type: 'user',
    resource_id: targetUserId,
    user_id: actingUserId,
    details,
    ip_address,
    user_agent,
  });
}
