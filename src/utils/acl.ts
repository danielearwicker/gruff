/**
 * ACL (Access Control List) utility functions
 *
 * This module provides functions for:
 * - Computing canonical ACL hashes for deduplication
 * - Getting or creating ACLs by hash
 * - Managing ACL entries
 * - Checking permissions
 */

import type { AclEntry, EnrichedAclEntry } from '../schemas/acl.js';

/**
 * Compute a canonical hash for an ACL
 *
 * ACLs are deduplicated: identical permission sets share the same ACL ID.
 * This function computes a SHA-256 hash of the canonical ACL representation.
 *
 * The canonical representation is:
 * - Entries sorted by principal_type, principal_id, permission
 * - JSON stringified with sorted keys
 *
 * @param entries - ACL entries to hash
 * @returns Promise<string> - SHA-256 hash as hex string (64 chars)
 */
export async function computeAclHash(entries: AclEntry[]): Promise<string> {
  // Sort entries for canonical representation
  const sortedEntries = [...entries].sort((a, b) => {
    // Sort by principal_type first
    if (a.principal_type !== b.principal_type) {
      return a.principal_type.localeCompare(b.principal_type);
    }
    // Then by principal_id
    if (a.principal_id !== b.principal_id) {
      return a.principal_id.localeCompare(b.principal_id);
    }
    // Finally by permission
    return a.permission.localeCompare(b.permission);
  });

  // Create canonical JSON representation
  const canonical = JSON.stringify(sortedEntries);

  // Compute SHA-256 hash
  const encoder = new TextEncoder();
  const data = encoder.encode(canonical);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);

  // Convert to hex string
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  return hashHex;
}

/**
 * Deduplicate ACL entries by removing exact duplicates
 *
 * @param entries - ACL entries (may contain duplicates)
 * @returns Deduplicated entries
 */
export function deduplicateAclEntries(entries: AclEntry[]): AclEntry[] {
  const seen = new Set<string>();
  const result: AclEntry[] = [];

  for (const entry of entries) {
    const key = `${entry.principal_type}:${entry.principal_id}:${entry.permission}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(entry);
    }
  }

  return result;
}

/**
 * Get or create an ACL by its entries
 *
 * If an ACL with the same entries (by hash) already exists, returns its ID.
 * Otherwise, creates a new ACL with the entries and returns the new ID.
 *
 * @param db - D1 database
 * @param entries - ACL entries
 * @returns Promise<number | null> - ACL ID, or null if entries is empty (public)
 */
export async function getOrCreateAcl(db: D1Database, entries: AclEntry[]): Promise<number | null> {
  // Empty entries means "public" (no ACL restriction)
  if (entries.length === 0) {
    return null;
  }

  // Deduplicate entries
  const deduped = deduplicateAclEntries(entries);

  // Compute hash
  const hash = await computeAclHash(deduped);

  // Try to find existing ACL with this hash
  const existing = await db
    .prepare('SELECT id FROM acls WHERE hash = ?')
    .bind(hash)
    .first<{ id: number }>();

  if (existing) {
    return existing.id;
  }

  // Create new ACL
  const now = Date.now();

  // Insert ACL record
  const aclResult = await db
    .prepare('INSERT INTO acls (hash, created_at) VALUES (?, ?) RETURNING id')
    .bind(hash, now)
    .first<{ id: number }>();

  if (!aclResult) {
    throw new Error('Failed to create ACL');
  }

  // Insert ACL entries
  const insertEntryStmt = db.prepare(
    'INSERT INTO acl_entries (acl_id, principal_type, principal_id, permission) VALUES (?, ?, ?, ?)'
  );

  const entryInserts = deduped.map(entry =>
    insertEntryStmt.bind(aclResult.id, entry.principal_type, entry.principal_id, entry.permission)
  );

  await db.batch(entryInserts);

  return aclResult.id;
}

/**
 * Get ACL entries for an ACL ID
 *
 * @param db - D1 database
 * @param aclId - ACL ID
 * @returns Promise<AclEntry[]> - ACL entries
 */
export async function getAclEntries(db: D1Database, aclId: number): Promise<AclEntry[]> {
  const results = await db
    .prepare(
      `SELECT principal_type, principal_id, permission
       FROM acl_entries
       WHERE acl_id = ?
       ORDER BY principal_type, principal_id, permission`
    )
    .bind(aclId)
    .all<AclEntry>();

  return results.results;
}

/**
 * Get ACL entries with enriched principal information
 *
 * @param db - D1 database
 * @param aclId - ACL ID
 * @returns Promise<EnrichedAclEntry[]> - ACL entries with principal details
 */
export async function getEnrichedAclEntries(
  db: D1Database,
  aclId: number
): Promise<EnrichedAclEntry[]> {
  // Get all entries
  const entries = await getAclEntries(db, aclId);

  if (entries.length === 0) {
    return [];
  }

  // Separate user and group IDs
  const userIds = entries.filter(e => e.principal_type === 'user').map(e => e.principal_id);
  const groupIds = entries.filter(e => e.principal_type === 'group').map(e => e.principal_id);

  // Fetch user details
  const userMap = new Map<string, { display_name: string | null; email: string }>();
  if (userIds.length > 0) {
    const placeholders = userIds.map(() => '?').join(', ');
    const users = await db
      .prepare(`SELECT id, display_name, email FROM users WHERE id IN (${placeholders})`)
      .bind(...userIds)
      .all<{ id: string; display_name: string | null; email: string }>();

    for (const user of users.results) {
      userMap.set(user.id, { display_name: user.display_name, email: user.email });
    }
  }

  // Fetch group details
  const groupMap = new Map<string, string>();
  if (groupIds.length > 0) {
    const placeholders = groupIds.map(() => '?').join(', ');
    const groups = await db
      .prepare(`SELECT id, name FROM groups WHERE id IN (${placeholders})`)
      .bind(...groupIds)
      .all<{ id: string; name: string }>();

    for (const group of groups.results) {
      groupMap.set(group.id, group.name);
    }
  }

  // Enrich entries
  return entries.map(entry => {
    const enriched: EnrichedAclEntry = { ...entry };

    if (entry.principal_type === 'user') {
      const user = userMap.get(entry.principal_id);
      if (user) {
        enriched.principal_name = user.display_name || user.email;
        enriched.principal_email = user.email;
      }
    } else {
      const groupName = groupMap.get(entry.principal_id);
      if (groupName) {
        enriched.principal_name = groupName;
      }
    }

    return enriched;
  });
}

/**
 * Get the ACL ID for an entity
 *
 * @param db - D1 database
 * @param entityId - Entity ID
 * @returns Promise<number | null> - ACL ID, or null if entity has no ACL (public)
 */
export async function getEntityAclId(db: D1Database, entityId: string): Promise<number | null> {
  const result = await db
    .prepare('SELECT acl_id FROM entities WHERE id = ? AND is_latest = 1')
    .bind(entityId)
    .first<{ acl_id: number | null }>();

  return result?.acl_id ?? null;
}

/**
 * Get the ACL ID for a link
 *
 * @param db - D1 database
 * @param linkId - Link ID
 * @returns Promise<number | null> - ACL ID, or null if link has no ACL (public)
 */
export async function getLinkAclId(db: D1Database, linkId: string): Promise<number | null> {
  const result = await db
    .prepare('SELECT acl_id FROM links WHERE id = ? AND is_latest = 1')
    .bind(linkId)
    .first<{ acl_id: number | null }>();

  return result?.acl_id ?? null;
}

/**
 * Set the ACL for an entity
 *
 * This creates a new version of the entity with the updated ACL.
 *
 * @param db - D1 database
 * @param entityId - Entity ID
 * @param aclId - ACL ID (or null for public)
 * @param userId - User making the change
 * @returns Promise<void>
 */
export async function setEntityAcl(
  db: D1Database,
  entityId: string,
  aclId: number | null,
  userId: string
): Promise<void> {
  const now = Date.now();

  // Get the current latest version
  const current = await db
    .prepare(
      `SELECT id, type_id, properties, version, acl_id
       FROM entities
       WHERE id = ? AND is_latest = 1`
    )
    .bind(entityId)
    .first<{
      id: string;
      type_id: string;
      properties: string | null;
      version: number;
      acl_id: number | null;
    }>();

  if (!current) {
    throw new Error('Entity not found');
  }

  // Check if ACL is actually changing
  if (current.acl_id === aclId) {
    return; // No change needed
  }

  // Generate new version ID (UUID v4)
  const newVersionId = crypto.randomUUID();
  const newVersion = current.version + 1;

  // Create new version with updated ACL
  await db.batch([
    // Mark current version as not latest
    db.prepare('UPDATE entities SET is_latest = 0 WHERE id = ?').bind(current.id),
    // Insert new version
    db
      .prepare(
        `INSERT INTO entities (id, type_id, properties, version, previous_version_id, created_at, created_by, is_deleted, is_latest, acl_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?)`
      )
      .bind(
        newVersionId,
        current.type_id,
        current.properties,
        newVersion,
        current.id,
        now,
        userId,
        aclId
      ),
  ]);
}

/**
 * Set the ACL for a link
 *
 * This creates a new version of the link with the updated ACL.
 *
 * @param db - D1 database
 * @param linkId - Link ID
 * @param aclId - ACL ID (or null for public)
 * @param userId - User making the change
 * @returns Promise<void>
 */
export async function setLinkAcl(
  db: D1Database,
  linkId: string,
  aclId: number | null,
  userId: string
): Promise<void> {
  const now = Date.now();

  // Get the current latest version
  const current = await db
    .prepare(
      `SELECT id, type_id, source_entity_id, target_entity_id, properties, version, acl_id
       FROM links
       WHERE id = ? AND is_latest = 1`
    )
    .bind(linkId)
    .first<{
      id: string;
      type_id: string;
      source_entity_id: string;
      target_entity_id: string;
      properties: string | null;
      version: number;
      acl_id: number | null;
    }>();

  if (!current) {
    throw new Error('Link not found');
  }

  // Check if ACL is actually changing
  if (current.acl_id === aclId) {
    return; // No change needed
  }

  // Generate new version ID (UUID v4)
  const newVersionId = crypto.randomUUID();
  const newVersion = current.version + 1;

  // Create new version with updated ACL
  await db.batch([
    // Mark current version as not latest
    db.prepare('UPDATE links SET is_latest = 0 WHERE id = ?').bind(current.id),
    // Insert new version
    db
      .prepare(
        `INSERT INTO links (id, type_id, source_entity_id, target_entity_id, properties, version, previous_version_id, created_at, created_by, is_deleted, is_latest, acl_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?)`
      )
      .bind(
        newVersionId,
        current.type_id,
        current.source_entity_id,
        current.target_entity_id,
        current.properties,
        newVersion,
        current.id,
        now,
        userId,
        aclId
      ),
  ]);
}

/**
 * Validate that all principals in ACL entries exist
 *
 * @param db - D1 database
 * @param entries - ACL entries to validate
 * @returns Promise<{ valid: boolean; errors: string[] }>
 */
export async function validateAclPrincipals(
  db: D1Database,
  entries: AclEntry[]
): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];

  // Separate user and group IDs
  const userIds = entries.filter(e => e.principal_type === 'user').map(e => e.principal_id);
  const groupIds = entries.filter(e => e.principal_type === 'group').map(e => e.principal_id);

  // Validate users exist
  if (userIds.length > 0) {
    const placeholders = userIds.map(() => '?').join(', ');
    const users = await db
      .prepare(`SELECT id FROM users WHERE id IN (${placeholders})`)
      .bind(...userIds)
      .all<{ id: string }>();

    const foundUserIds = new Set(users.results.map(u => u.id));
    for (const userId of userIds) {
      if (!foundUserIds.has(userId)) {
        errors.push(`User not found: ${userId}`);
      }
    }
  }

  // Validate groups exist
  if (groupIds.length > 0) {
    const placeholders = groupIds.map(() => '?').join(', ');
    const groups = await db
      .prepare(`SELECT id FROM groups WHERE id IN (${placeholders})`)
      .bind(...groupIds)
      .all<{ id: string }>();

    const foundGroupIds = new Set(groups.results.map(g => g.id));
    for (const groupId of groupIds) {
      if (!foundGroupIds.has(groupId)) {
        errors.push(`Group not found: ${groupId}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
