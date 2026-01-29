/**
 * ACL (Access Control List) utility functions
 *
 * This module provides functions for:
 * - Computing canonical ACL hashes for deduplication
 * - Getting or creating ACLs by hash
 * - Managing ACL entries
 * - Checking permissions
 * - Permission-based filtering for list operations
 */

import type { AclEntry, EnrichedAclEntry, Permission } from '../schemas/acl.js';
import { getCache, setCache, getVersionedEffectiveGroupsCacheKey, CACHE_TTL } from './cache.js';

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
 * Create an ACL for a new resource with creator having write permission.
 *
 * If explicit ACL entries are provided, ensures the creator has write permission
 * by adding it if not already present.
 *
 * If no ACL entries are provided (undefined), creates a default ACL with only
 * the creator having write permission.
 *
 * If an empty array is provided, returns null (public resource).
 *
 * @param db - D1 database
 * @param creatorId - User ID of the creator
 * @param explicitAcl - Optional explicit ACL entries (undefined = creator-only, [] = public)
 * @returns Promise<number | null> - ACL ID, or null for public resources
 */
export async function createResourceAcl(
  db: D1Database,
  creatorId: string,
  explicitAcl?: AclEntry[]
): Promise<number | null> {
  // If explicitly set to empty array, make resource public
  if (explicitAcl !== undefined && explicitAcl.length === 0) {
    return null;
  }

  // Start with creator write permission
  const creatorEntry: AclEntry = {
    principal_type: 'user',
    principal_id: creatorId,
    permission: 'write',
  };

  let entries: AclEntry[];

  if (explicitAcl === undefined) {
    // No explicit ACL: just creator with write permission
    entries = [creatorEntry];
  } else {
    // Explicit ACL provided: ensure creator has write permission
    const hasCreatorWrite = explicitAcl.some(
      e => e.principal_type === 'user' && e.principal_id === creatorId && e.permission === 'write'
    );

    if (hasCreatorWrite) {
      entries = explicitAcl;
    } else {
      // Add creator write permission to the explicit ACL
      entries = [creatorEntry, ...explicitAcl];
    }
  }

  return getOrCreateAcl(db, entries);
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

// ============================================================================
// Permission Checking Functions
// ============================================================================

/**
 * Maximum number of ACL IDs to use in an IN clause before falling back to per-row checking.
 * For users with access to many ACLs, SQL IN clause with thousands of values can be slow.
 */
const MAX_ACL_IDS_FOR_IN_CLAUSE = 1000;

/**
 * Get all groups a user belongs to (directly or through nested group membership)
 * with caching in KV.
 *
 * This is the core function for resolving a user's effective group membership.
 * Results are cached for 5 minutes and invalidated when group membership changes.
 *
 * @param db - D1 database
 * @param kv - KV namespace for caching
 * @param userId - User ID to resolve groups for
 * @returns Promise<Set<string>> - Set of group IDs the user belongs to
 */
export async function getEffectiveGroupsForUser(
  db: D1Database,
  kv: KVNamespace,
  userId: string
): Promise<Set<string>> {
  // Try to get from cache first
  const cacheKey = await getVersionedEffectiveGroupsCacheKey(kv, userId);
  const cached = await getCache<string[]>(kv, cacheKey);

  if (cached) {
    return new Set(cached);
  }

  // Cache miss: compute effective groups
  const groupIds = new Set<string>();
  const visited = new Set<string>();

  // Get groups the user directly belongs to
  const directGroups = await db
    .prepare(
      `SELECT group_id FROM group_members
       WHERE member_type = 'user' AND member_id = ?`
    )
    .bind(userId)
    .all<{ group_id: string }>();

  // Helper function to recursively get parent groups
  async function addParentGroups(groupId: string): Promise<void> {
    if (visited.has(groupId)) return;
    visited.add(groupId);
    groupIds.add(groupId);

    // Get groups that contain this group as a member
    const parentGroups = await db
      .prepare(
        `SELECT group_id FROM group_members
         WHERE member_type = 'group' AND member_id = ?`
      )
      .bind(groupId)
      .all<{ group_id: string }>();

    for (const parent of parentGroups.results || []) {
      await addParentGroups(parent.group_id);
    }
  }

  // Process all direct groups and their parents
  for (const group of directGroups.results || []) {
    await addParentGroups(group.group_id);
  }

  // Cache the result
  const groupIdArray = Array.from(groupIds);
  setCache(kv, cacheKey, groupIdArray, CACHE_TTL.EFFECTIVE_GROUPS).catch(() => {
    // Silently ignore cache write errors
  });

  return groupIds;
}

/**
 * Get all ACL IDs that grant a user a specific permission.
 *
 * This function considers:
 * - Direct user permissions in ACL entries
 * - Permissions granted through group membership
 * - Write permission implies read permission
 *
 * Results are not cached as they depend on ACL state which can change frequently.
 *
 * @param db - D1 database
 * @param kv - KV namespace for caching effective groups
 * @param userId - User ID to check permissions for
 * @param permission - Permission level to check ('read' or 'write')
 * @returns Promise<Set<number>> - Set of ACL IDs that grant the requested permission
 */
export async function getAccessibleAclIds(
  db: D1Database,
  kv: KVNamespace,
  userId: string,
  permission: Permission
): Promise<Set<number>> {
  // Get user's effective groups
  const effectiveGroups = await getEffectiveGroupsForUser(db, kv, userId);

  // Build list of principals to check (user + all effective groups)
  const userPrincipals: Array<{ type: 'user' | 'group'; id: string }> = [
    { type: 'user', id: userId },
  ];

  for (const groupId of effectiveGroups) {
    userPrincipals.push({ type: 'group', id: groupId });
  }

  // Query ACL entries for all principals
  // For 'read' permission, we need to check both 'read' and 'write' entries
  // because 'write' implies 'read'
  const permissionsToCheck = permission === 'read' ? ['read', 'write'] : ['write'];

  // Build the query with proper placeholders
  // We need to check: (principal_type, principal_id) IN ((type1, id1), (type2, id2), ...)
  // AND permission IN (perm1, perm2, ...)
  const principalConditions = userPrincipals
    .map(() => '(principal_type = ? AND principal_id = ?)')
    .join(' OR ');

  const permissionPlaceholders = permissionsToCheck.map(() => '?').join(', ');

  const sql = `
    SELECT DISTINCT acl_id
    FROM acl_entries
    WHERE (${principalConditions})
    AND permission IN (${permissionPlaceholders})
  `;

  // Build bindings: first all principal pairs, then permissions
  const bindings: unknown[] = [];
  for (const principal of userPrincipals) {
    bindings.push(principal.type, principal.id);
  }
  bindings.push(...permissionsToCheck);

  const results = await db
    .prepare(sql)
    .bind(...bindings)
    .all<{ acl_id: number }>();

  const aclIds = new Set<number>();
  for (const row of results.results || []) {
    aclIds.add(row.acl_id);
  }

  return aclIds;
}

/**
 * Check if a user has a specific permission on a resource (entity or link).
 *
 * Permission checking rules:
 * 1. Resources with NULL acl_id are accessible to all authenticated users
 * 2. Write permission implies read permission
 * 3. User must have the required permission directly or through a group
 *
 * @param db - D1 database
 * @param kv - KV namespace for caching
 * @param userId - User ID to check permissions for
 * @param resourceType - Type of resource ('entity' or 'link')
 * @param resourceId - ID of the resource
 * @param permission - Permission level required ('read' or 'write')
 * @returns Promise<boolean> - true if user has the required permission
 */
export async function hasPermission(
  db: D1Database,
  kv: KVNamespace,
  userId: string,
  resourceType: 'entity' | 'link',
  resourceId: string,
  permission: Permission
): Promise<boolean> {
  // Get the resource's ACL ID
  const aclId =
    resourceType === 'entity'
      ? await getEntityAclId(db, resourceId)
      : await getLinkAclId(db, resourceId);

  // NULL acl_id means public/unrestricted - accessible to all authenticated users
  if (aclId === null) {
    return true;
  }

  // Get all ACL IDs accessible to the user for the requested permission
  const accessibleAclIds = await getAccessibleAclIds(db, kv, userId, permission);

  return accessibleAclIds.has(aclId);
}

/**
 * Check if a user has permission on a resource based on its ACL ID.
 * This is a more efficient version when you already have the ACL ID.
 *
 * @param db - D1 database
 * @param kv - KV namespace for caching
 * @param userId - User ID to check permissions for
 * @param aclId - ACL ID of the resource (null means public)
 * @param permission - Permission level required ('read' or 'write')
 * @returns Promise<boolean> - true if user has the required permission
 */
export async function hasPermissionByAclId(
  db: D1Database,
  kv: KVNamespace,
  userId: string,
  aclId: number | null,
  permission: Permission
): Promise<boolean> {
  // NULL acl_id means public/unrestricted
  if (aclId === null) {
    return true;
  }

  const accessibleAclIds = await getAccessibleAclIds(db, kv, userId, permission);
  return accessibleAclIds.has(aclId);
}

/**
 * Result of building an ACL filter for list queries
 */
export interface AclFilterResult {
  /** Whether filtering should be used (false if user has access to too many ACLs) */
  useFilter: boolean;
  /** SQL WHERE clause fragment to add (empty string if useFilter is false) */
  whereClause: string;
  /** Bindings for the WHERE clause */
  bindings: unknown[];
  /** Set of accessible ACL IDs (for per-row checking if useFilter is false) */
  accessibleAclIds: Set<number>;
}

/**
 * Build an SQL WHERE clause to filter entities/links by ACL permissions.
 *
 * This function generates a filter for list queries that includes:
 * - Resources with NULL acl_id (public)
 * - Resources with acl_id in the user's accessible ACL IDs
 *
 * For users with access to many ACLs (>1000), returns useFilter=false
 * and the caller should fall back to per-row permission checking.
 *
 * @param db - D1 database
 * @param kv - KV namespace for caching
 * @param userId - User ID to build filter for
 * @param permission - Permission level required ('read' or 'write')
 * @param aclIdColumn - Column name for acl_id (default: 'acl_id')
 * @returns Promise<AclFilterResult> - Filter clause and bindings
 */
export async function buildAclFilterClause(
  db: D1Database,
  kv: KVNamespace,
  userId: string,
  permission: Permission,
  aclIdColumn: string = 'acl_id'
): Promise<AclFilterResult> {
  const accessibleAclIds = await getAccessibleAclIds(db, kv, userId, permission);

  // If user has access to too many ACLs, fallback to per-row checking
  if (accessibleAclIds.size > MAX_ACL_IDS_FOR_IN_CLAUSE) {
    return {
      useFilter: false,
      whereClause: '',
      bindings: [],
      accessibleAclIds,
    };
  }

  // If user has no accessible ACLs, only return public resources
  if (accessibleAclIds.size === 0) {
    return {
      useFilter: true,
      whereClause: `${aclIdColumn} IS NULL`,
      bindings: [],
      accessibleAclIds,
    };
  }

  // Build IN clause for accessible ACL IDs
  const aclIdArray = Array.from(accessibleAclIds);
  const placeholders = aclIdArray.map(() => '?').join(', ');

  return {
    useFilter: true,
    whereClause: `(${aclIdColumn} IS NULL OR ${aclIdColumn} IN (${placeholders}))`,
    bindings: aclIdArray,
    accessibleAclIds,
  };
}

/**
 * Filter an array of items by ACL permission (for per-row checking).
 * Use this when buildAclFilterClause returns useFilter=false.
 *
 * @param items - Array of items with acl_id property
 * @param accessibleAclIds - Set of ACL IDs the user can access
 * @returns Array of items the user can access
 */
export function filterByAclPermission<T extends { acl_id?: number | null }>(
  items: T[],
  accessibleAclIds: Set<number>
): T[] {
  return items.filter(item => {
    // NULL acl_id means public
    if (item.acl_id === null || item.acl_id === undefined) {
      return true;
    }
    return accessibleAclIds.has(item.acl_id);
  });
}
