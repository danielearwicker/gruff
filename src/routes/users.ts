/**
 * User management routes
 *
 * Handles listing users, getting user details, updating user profiles, and viewing user activity
 */

import { OpenAPIHono, z } from '@hono/zod-openapi';
import { validateJson, validateQuery } from '../middleware/validation.js';
import { requireAuth, requireAdmin, requireAdminOrSelf } from '../middleware/auth.js';
import { updateUserSchema, adminRoleChangeSchema } from '../schemas/index.js';
import * as response from '../utils/response.js';
import { getLogger } from '../middleware/request-context.js';
import {
  applyFieldSelection,
  applyFieldSelectionToArray,
  USER_ALLOWED_FIELDS,
} from '../utils/field-selection.js';
import {
  getCache,
  setCache,
  getVersionedEffectiveGroupsCacheKey,
  CACHE_TTL,
} from '../utils/cache.js';
import { buildAclFilterClause, filterByAclPermission } from '../utils/acl.js';
import { logUserOperation } from '../utils/audit.js';

type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  JWT_SECRET: string;
  ENVIRONMENT: string;
};

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  provider: string;
  created_at: number;
  updated_at: number;
  is_active: number;
  is_admin: number;
}

const usersRouter = new OpenAPIHono<{ Bindings: Bindings }>();

// Query schema for listing users
const listUsersQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform(val => (val ? parseInt(val, 10) : 20)),
  offset: z
    .string()
    .optional()
    .transform(val => (val ? parseInt(val, 10) : 0)),
  is_active: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform(val => {
      if (!val) return undefined;
      return val === 'true' || val === '1';
    }),
  provider: z.enum(['google', 'github', 'local', 'microsoft', 'apple']).optional(),
  // Field selection: comma-separated list of fields to include in response
  fields: z.string().optional(),
});

/**
 * GET /api/users
 *
 * List all users (admin only)
 * This endpoint is restricted to admin users for security
 */
usersRouter.get(
  '/',
  requireAuth(),
  requireAdmin(),
  validateQuery(listUsersQuerySchema),
  async c => {
    const logger = getLogger(c);
    const validated = c.get('validated_query') as {
      limit: number;
      offset: number;
      is_active?: boolean;
      provider?: string;
      fields?: string;
    };

    const { limit, offset, is_active, provider } = validated;

    try {
      // Build the query dynamically based on filters
      let query =
        'SELECT id, email, display_name, provider, created_at, updated_at, is_active, is_admin FROM users WHERE 1=1';
      const params: unknown[] = [];

      if (is_active !== undefined) {
        query += ' AND is_active = ?';
        params.push(is_active ? 1 : 0);
      }

      if (provider) {
        query += ' AND provider = ?';
        params.push(provider);
      }

      // Add ordering and pagination
      query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);

      // Execute the query
      const stmt = c.env.DB.prepare(query);
      const results = await stmt.bind(...params).all();

      // Get total count for pagination
      let countQuery = 'SELECT COUNT(*) as total FROM users WHERE 1=1';
      const countParams: unknown[] = [];

      if (is_active !== undefined) {
        countQuery += ' AND is_active = ?';
        countParams.push(is_active ? 1 : 0);
      }

      if (provider) {
        countQuery += ' AND provider = ?';
        countParams.push(provider);
      }

      const countStmt = c.env.DB.prepare(countQuery);
      const countResult = await countStmt.bind(...countParams).first<{ total: number }>();
      const total = countResult?.total || 0;

      logger.info('Users listed', { count: results.results?.length || 0, total });

      // Format the users (exclude sensitive data)
      const users = ((results.results || []) as unknown as UserRow[]).map(user => ({
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        provider: user.provider,
        created_at: user.created_at,
        updated_at: user.updated_at,
        is_active: !!user.is_active,
        is_admin: !!user.is_admin,
      }));

      // Apply field selection if requested
      const fieldSelection = applyFieldSelectionToArray(
        users as Record<string, unknown>[],
        validated.fields,
        USER_ALLOWED_FIELDS
      );

      if (!fieldSelection.success) {
        return c.json(
          response.error(
            `Invalid fields requested: ${fieldSelection.invalidFields.join(', ')}`,
            'INVALID_FIELDS',
            { allowed_fields: Array.from(USER_ALLOWED_FIELDS) }
          ),
          400
        );
      }

      // Calculate pagination metadata
      const page = Math.floor(offset / limit) + 1;
      const hasMore = offset + limit < total;

      return c.json(response.paginated(fieldSelection.data, limit, page, total, hasMore));
    } catch (error) {
      logger.error('Error listing users', error as Error);
      return c.json(response.error('Failed to list users', 'USER_LIST_FAILED'), 500);
    }
  }
);

/**
 * GET /api/users/search
 *
 * Search for users by email or display name (authenticated users only)
 * Returns limited user info for ACL management purposes.
 *
 * Query parameters:
 * - q: Search query (required, min 2 characters)
 * - limit: Max results to return (default 10, max 50)
 */
usersRouter.get('/search', requireAuth(), async c => {
  const logger = getLogger(c);
  const query = c.req.query('q') || '';
  const limitParam = c.req.query('limit');
  const limit = Math.min(Math.max(parseInt(limitParam || '10', 10) || 10, 1), 50);

  if (query.length < 2) {
    return c.json(
      response.error('Search query must be at least 2 characters', 'INVALID_QUERY'),
      400
    );
  }

  try {
    const searchPattern = `%${query}%`;

    const { results } = await c.env.DB.prepare(
      `SELECT id, email, display_name
       FROM users
       WHERE is_active = 1
         AND (email LIKE ? OR display_name LIKE ?)
       ORDER BY
         CASE WHEN email LIKE ? THEN 0 ELSE 1 END,
         CASE WHEN display_name LIKE ? THEN 0 ELSE 1 END,
         email
       LIMIT ?`
    )
      .bind(searchPattern, searchPattern, query + '%', query + '%', limit)
      .all();

    const users = results.map(user => ({
      id: user.id,
      email: user.email,
      display_name: user.display_name,
    }));

    logger.debug('User search completed', { query, resultCount: users.length });

    return c.json(response.success(users));
  } catch (error) {
    logger.error('Error searching users', error as Error);
    return c.json(response.error('Failed to search users', 'USER_SEARCH_FAILED'), 500);
  }
});

/**
 * GET /api/users/{id}
 *
 * Get details for a specific user
 * Supports field selection via the `fields` query parameter.
 * Example: GET /api/users/123?fields=id,email,display_name
 *
 * Users can view their own profile, or any authenticated user can view others
 * (in production, you might want to restrict this)
 */
usersRouter.get('/:id', requireAuth(), async c => {
  const logger = getLogger(c);
  const userId = c.req.param('id');
  const fieldsParam = c.req.query('fields');

  try {
    // Fetch the user from the database
    const user = await c.env.DB.prepare(
      'SELECT id, email, display_name, provider, created_at, updated_at, is_active, is_admin FROM users WHERE id = ?'
    )
      .bind(userId)
      .first();

    if (!user) {
      logger.warn('User not found', { userId });
      return c.json(response.notFound('User'), 404);
    }

    logger.info('User details retrieved', { userId });

    // Format user details (excluding sensitive data)
    const userData = {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      provider: user.provider,
      created_at: user.created_at,
      updated_at: user.updated_at,
      is_active: !!user.is_active,
      is_admin: !!user.is_admin,
    };

    // Apply field selection if requested
    if (fieldsParam) {
      const fieldSelection = applyFieldSelection(
        userData as Record<string, unknown>,
        fieldsParam,
        USER_ALLOWED_FIELDS
      );
      if (!fieldSelection.success) {
        return c.json(
          response.error(
            `Invalid fields requested: ${fieldSelection.invalidFields.join(', ')}`,
            'INVALID_FIELDS',
            { allowed_fields: Array.from(USER_ALLOWED_FIELDS) }
          ),
          400
        );
      }
      return c.json(response.success(fieldSelection.data));
    }

    // Return user details
    return c.json(response.success(userData));
  } catch (error) {
    logger.error('Error retrieving user details', error as Error, { userId });
    return c.json(response.error('Failed to retrieve user details', 'USER_RETRIEVAL_FAILED'), 500);
  }
});

/**
 * PUT /api/users/{id}
 *
 * Update a user's profile
 * Users can update their own profile, admins can update any profile
 */
usersRouter.put(
  '/:id',
  requireAuth(),
  requireAdminOrSelf('id'),
  validateJson(updateUserSchema),
  async c => {
    const logger = getLogger(c);
    const userId = c.req.param('id');
    const currentUser = c.get('user');
    const validated = c.get('validated_json') as {
      display_name?: string;
      email?: string;
      is_active?: number;
    };

    try {
      // Check if non-admin user is trying to modify is_active (admin-only field)
      if (validated.is_active !== undefined && !currentUser.is_admin) {
        logger.warn('Non-admin user attempted to modify is_active field', {
          userId: currentUser.user_id,
          targetUserId: userId,
        });
        return c.json(
          response.error('Only administrators can modify the is_active field', 'ADMIN_REQUIRED'),
          403
        );
      }

      // Check if user exists
      const existingUser = await c.env.DB.prepare('SELECT id, email FROM users WHERE id = ?')
        .bind(userId)
        .first();

      if (!existingUser) {
        logger.warn('User not found for update', { userId });
        return c.json(response.notFound('User'), 404);
      }

      // If email is being updated, check if it's already taken
      if (validated.email && validated.email !== existingUser.email) {
        const emailExists = await c.env.DB.prepare(
          'SELECT id FROM users WHERE email = ? AND id != ?'
        )
          .bind(validated.email, userId)
          .first();

        if (emailExists) {
          logger.warn('Email already in use', { email: validated.email });
          return c.json(response.error('Email is already in use', 'EMAIL_EXISTS'), 409);
        }
      }

      // Build update query dynamically
      const updates: string[] = [];
      const params: unknown[] = [];

      if (validated.display_name !== undefined) {
        updates.push('display_name = ?');
        params.push(validated.display_name);
      }

      if (validated.email !== undefined) {
        updates.push('email = ?');
        params.push(validated.email);
      }

      if (validated.is_active !== undefined) {
        // Only admins can reach this point (checked above)
        updates.push('is_active = ?');
        params.push(validated.is_active ? 1 : 0);
      }

      // Always update updated_at
      updates.push('updated_at = ?');
      params.push(Math.floor(Date.now() / 1000));

      // Add user ID as the final parameter
      params.push(userId);

      // Execute update
      const updateQuery = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;
      await c.env.DB.prepare(updateQuery)
        .bind(...params)
        .run();

      // Fetch and return updated user
      const updatedUser = await c.env.DB.prepare(
        'SELECT id, email, display_name, provider, created_at, updated_at, is_active, is_admin FROM users WHERE id = ?'
      )
        .bind(userId)
        .first();

      logger.info('User profile updated', {
        userId,
        updatedBy: currentUser.user_id,
        isAdmin: currentUser.is_admin ?? false,
      });

      return c.json(
        response.updated({
          id: updatedUser!.id,
          email: updatedUser!.email,
          display_name: updatedUser!.display_name,
          provider: updatedUser!.provider,
          created_at: updatedUser!.created_at,
          updated_at: updatedUser!.updated_at,
          is_active: !!updatedUser!.is_active,
          is_admin: !!updatedUser!.is_admin,
        })
      );
    } catch (error) {
      logger.error('Error updating user profile', error as Error, { userId });
      return c.json(response.error('Failed to update user profile', 'USER_UPDATE_FAILED'), 500);
    }
  }
);

/**
 * GET /api/users/{id}/activity
 *
 * Get a user's creation and edit history (entities and links they've created/modified)
 * Only returns entities and links that the requesting user has read access to.
 */
usersRouter.get('/:id/activity', requireAuth(), async c => {
  const logger = getLogger(c);
  const userId = c.req.param('id');
  const currentUser = c.get('user');

  // Get limit from query params (default 50, max 100)
  const limitParam = c.req.query('limit');
  const limit = limitParam ? Math.min(parseInt(limitParam, 10), 100) : 50;

  try {
    // Check if user exists
    const user = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();

    if (!user) {
      logger.warn('User not found for activity query', { userId });
      return c.json(response.notFound('User'), 404);
    }

    // Build ACL filter for the requesting user (not the target user)
    const aclFilter = await buildAclFilterClause(
      c.env.DB,
      c.env.KV,
      currentUser.user_id,
      'read',
      'acl_id'
    );

    let entityActivities: Array<{
      type: string;
      id: unknown;
      type_id: unknown;
      version: unknown;
      created_at: unknown;
      is_deleted: boolean;
      is_latest: boolean;
    }> = [];
    let linkActivities: Array<{
      type: string;
      id: unknown;
      type_id: unknown;
      source_entity_id: unknown;
      target_entity_id: unknown;
      version: unknown;
      created_at: unknown;
      is_deleted: boolean;
      is_latest: boolean;
    }> = [];

    if (aclFilter.useFilter) {
      // Use SQL-based ACL filtering
      const entityQuery = aclFilter.whereClause
        ? `SELECT id, type_id, version, created_at, is_deleted, is_latest, acl_id
           FROM entities
           WHERE created_by = ? AND is_latest = 1 AND (${aclFilter.whereClause})
           ORDER BY created_at DESC
           LIMIT ?`
        : `SELECT id, type_id, version, created_at, is_deleted, is_latest, acl_id
           FROM entities
           WHERE created_by = ? AND is_latest = 1
           ORDER BY created_at DESC
           LIMIT ?`;

      const entityBindings = aclFilter.whereClause
        ? [userId, ...aclFilter.bindings, Math.floor(limit / 2)]
        : [userId, Math.floor(limit / 2)];

      const entities = await c.env.DB.prepare(entityQuery)
        .bind(...entityBindings)
        .all();

      const linkQuery = aclFilter.whereClause
        ? `SELECT id, type_id, source_entity_id, target_entity_id, version, created_at, is_deleted, is_latest, acl_id
           FROM links
           WHERE created_by = ? AND is_latest = 1 AND (${aclFilter.whereClause})
           ORDER BY created_at DESC
           LIMIT ?`
        : `SELECT id, type_id, source_entity_id, target_entity_id, version, created_at, is_deleted, is_latest, acl_id
           FROM links
           WHERE created_by = ? AND is_latest = 1
           ORDER BY created_at DESC
           LIMIT ?`;

      const linkBindings = aclFilter.whereClause
        ? [userId, ...aclFilter.bindings, Math.floor(limit / 2)]
        : [userId, Math.floor(limit / 2)];

      const links = await c.env.DB.prepare(linkQuery)
        .bind(...linkBindings)
        .all();

      entityActivities = (
        (entities.results || []) as unknown as Array<Record<string, unknown>>
      ).map(e => ({
        type: 'entity',
        id: e.id,
        type_id: e.type_id,
        version: e.version,
        created_at: e.created_at,
        is_deleted: !!e.is_deleted,
        is_latest: !!e.is_latest,
      }));

      linkActivities = ((links.results || []) as unknown as Array<Record<string, unknown>>).map(
        l => ({
          type: 'link',
          id: l.id,
          type_id: l.type_id,
          source_entity_id: l.source_entity_id,
          target_entity_id: l.target_entity_id,
          version: l.version,
          created_at: l.created_at,
          is_deleted: !!l.is_deleted,
          is_latest: !!l.is_latest,
        })
      );
    } else {
      // Fall back to per-row ACL filtering (user has access to too many ACLs)
      const entities = await c.env.DB.prepare(
        `SELECT id, type_id, version, created_at, is_deleted, is_latest, acl_id
         FROM entities
         WHERE created_by = ? AND is_latest = 1
         ORDER BY created_at DESC
         LIMIT ?`
      )
        .bind(userId, limit)
        .all();

      const links = await c.env.DB.prepare(
        `SELECT id, type_id, source_entity_id, target_entity_id, version, created_at, is_deleted, is_latest, acl_id
         FROM links
         WHERE created_by = ? AND is_latest = 1
         ORDER BY created_at DESC
         LIMIT ?`
      )
        .bind(userId, limit)
        .all();

      // Filter by ACL permission
      const filteredEntities = filterByAclPermission(
        (entities.results || []) as Array<{ acl_id?: number | null } & Record<string, unknown>>,
        aclFilter.accessibleAclIds
      );

      const filteredLinks = filterByAclPermission(
        (links.results || []) as Array<{ acl_id?: number | null } & Record<string, unknown>>,
        aclFilter.accessibleAclIds
      );

      entityActivities = filteredEntities.map(e => ({
        type: 'entity',
        id: e.id,
        type_id: e.type_id,
        version: e.version,
        created_at: e.created_at,
        is_deleted: !!e.is_deleted,
        is_latest: !!e.is_latest,
      }));

      linkActivities = filteredLinks.map(l => ({
        type: 'link',
        id: l.id,
        type_id: l.type_id,
        source_entity_id: l.source_entity_id,
        target_entity_id: l.target_entity_id,
        version: l.version,
        created_at: l.created_at,
        is_deleted: !!l.is_deleted,
        is_latest: !!l.is_latest,
      }));
    }

    const allActivities = [...entityActivities, ...linkActivities]
      .sort((a, b) => (b.created_at as number) - (a.created_at as number))
      .slice(0, limit);

    logger.info('User activity retrieved', { userId, activityCount: allActivities.length });

    return c.json(
      response.success({
        user_id: userId,
        activity: allActivities,
        count: allActivities.length,
      })
    );
  } catch (error) {
    logger.error('Error retrieving user activity', error as Error, { userId });
    return c.json(response.error('Failed to retrieve user activity', 'USER_ACTIVITY_FAILED'), 500);
  }
});

/**
 * GET /api/users/{id}/groups
 *
 * List groups a user directly belongs to
 */
usersRouter.get('/:id/groups', requireAuth(), async c => {
  const logger = getLogger(c);
  const userId = c.req.param('id');

  try {
    // Check if user exists
    const user = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();

    if (!user) {
      logger.warn('User not found for groups query', { userId });
      return c.json(response.notFound('User'), 404);
    }

    // Get groups the user directly belongs to
    const groups = await c.env.DB.prepare(
      `SELECT g.id, g.name, g.description, g.created_at, gm.created_at as joined_at
       FROM groups g
       INNER JOIN group_members gm ON g.id = gm.group_id
       WHERE gm.member_type = 'user' AND gm.member_id = ?
       ORDER BY gm.created_at DESC`
    )
      .bind(userId)
      .all<{
        id: string;
        name: string;
        description: string | null;
        created_at: number;
        joined_at: number;
      }>();

    logger.info('User groups retrieved', { userId, count: groups.results?.length || 0 });

    return c.json(
      response.success({
        user_id: userId,
        groups: groups.results || [],
        count: groups.results?.length || 0,
      })
    );
  } catch (error) {
    logger.error('Error retrieving user groups', error as Error, { userId });
    return c.json(response.error('Failed to retrieve user groups', 'USER_GROUPS_FAILED'), 500);
  }
});

/**
 * Helper function to recursively get all groups a user belongs to
 * (directly or through nested group membership)
 */
async function getEffectiveGroups(
  db: D1Database,
  userId: string,
  visited: Set<string> = new Set()
): Promise<
  Array<{
    id: string;
    name: string;
    description: string | null;
    path: string[];
  }>
> {
  const result: Array<{
    id: string;
    name: string;
    description: string | null;
    path: string[];
  }> = [];

  // Get groups the user directly belongs to
  const directGroups = await db
    .prepare(
      `SELECT g.id, g.name, g.description
       FROM groups g
       INNER JOIN group_members gm ON g.id = gm.group_id
       WHERE gm.member_type = 'user' AND gm.member_id = ?`
    )
    .bind(userId)
    .all<{
      id: string;
      name: string;
      description: string | null;
    }>();

  for (const group of directGroups.results || []) {
    if (!visited.has(group.id)) {
      visited.add(group.id);
      result.push({
        ...group,
        path: [group.id],
      });

      // Recursively get parent groups of this group
      const parentGroups = await getParentGroups(db, group.id, new Set(visited));
      for (const parent of parentGroups) {
        if (!visited.has(parent.id)) {
          visited.add(parent.id);
          result.push({
            ...parent,
            path: [group.id, ...parent.path],
          });
        }
      }
    }
  }

  return result;
}

/**
 * Helper function to get all parent groups of a group
 */
async function getParentGroups(
  db: D1Database,
  groupId: string,
  visited: Set<string> = new Set()
): Promise<
  Array<{
    id: string;
    name: string;
    description: string | null;
    path: string[];
  }>
> {
  const result: Array<{
    id: string;
    name: string;
    description: string | null;
    path: string[];
  }> = [];

  // Get groups that contain this group as a member
  const parentGroups = await db
    .prepare(
      `SELECT g.id, g.name, g.description
       FROM groups g
       INNER JOIN group_members gm ON g.id = gm.group_id
       WHERE gm.member_type = 'group' AND gm.member_id = ?`
    )
    .bind(groupId)
    .all<{
      id: string;
      name: string;
      description: string | null;
    }>();

  for (const parent of parentGroups.results || []) {
    if (!visited.has(parent.id)) {
      visited.add(parent.id);
      result.push({
        ...parent,
        path: [parent.id],
      });

      // Recursively get parents of this parent
      const grandparents = await getParentGroups(db, parent.id, new Set(visited));
      for (const grandparent of grandparents) {
        result.push({
          ...grandparent,
          path: [parent.id, ...grandparent.path],
        });
      }
    }
  }

  return result;
}

/**
 * Cached result type for effective groups
 */
interface CachedEffectiveGroupsResult {
  user_id: string;
  groups: Array<{
    id: string;
    name: string;
    description: string | null;
    paths: string[][];
  }>;
  count: number;
}

/**
 * GET /api/users/{id}/effective-groups
 *
 * List all groups a user belongs to (directly or through nested group membership)
 * Results are cached in KV with TTL of 5 minutes
 */
usersRouter.get('/:id/effective-groups', requireAuth(), async c => {
  const logger = getLogger(c);
  const userId = c.req.param('id');

  try {
    // Check if user exists
    const user = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();

    if (!user) {
      logger.warn('User not found for effective groups query', { userId });
      return c.json(response.notFound('User'), 404);
    }

    // Try to get from cache first using versioned key
    const cacheKey = await getVersionedEffectiveGroupsCacheKey(c.env.KV, userId);
    const cachedResult = await getCache<CachedEffectiveGroupsResult>(c.env.KV, cacheKey);

    if (cachedResult) {
      logger.info('User effective groups retrieved from cache', {
        userId,
        count: cachedResult.count,
      });
      return c.json(response.success(cachedResult));
    }

    // Cache miss: compute effective groups
    const groups = await getEffectiveGroups(c.env.DB, userId);

    // Deduplicate groups (might appear through multiple paths)
    const uniqueGroups = new Map<
      string,
      {
        id: string;
        name: string;
        description: string | null;
        paths: string[][];
      }
    >();

    for (const group of groups) {
      const existing = uniqueGroups.get(group.id);
      if (existing) {
        existing.paths.push(group.path);
      } else {
        uniqueGroups.set(group.id, {
          id: group.id,
          name: group.name,
          description: group.description,
          paths: [group.path],
        });
      }
    }

    const result: CachedEffectiveGroupsResult = {
      user_id: userId,
      groups: Array.from(uniqueGroups.values()),
      count: uniqueGroups.size,
    };

    // Cache the result (don't await to avoid blocking the response)
    setCache(c.env.KV, cacheKey, result, CACHE_TTL.EFFECTIVE_GROUPS).catch(err => {
      logger.warn('Failed to cache effective groups', { userId, error: String(err) });
    });

    logger.info('User effective groups retrieved and cached', { userId, count: result.count });

    return c.json(response.success(result));
  } catch (error) {
    logger.error('Error retrieving user effective groups', error as Error, { userId });
    return c.json(
      response.error('Failed to retrieve user effective groups', 'USER_EFFECTIVE_GROUPS_FAILED'),
      500
    );
  }
});

/**
 * PUT /api/users/{id}/admin
 *
 * Grant or revoke admin role for a user (admin only)
 *
 * Constraints:
 * - Only existing admins can grant or revoke admin status
 * - Admins cannot revoke their own admin status (prevents lockout)
 * - At least one admin must remain in the system
 *
 * Request body: { is_admin: boolean }
 */
usersRouter.put(
  '/:id/admin',
  requireAuth(),
  requireAdmin(),
  validateJson(adminRoleChangeSchema),
  async c => {
    const logger = getLogger(c);
    const targetUserId = c.req.param('id');
    const currentUser = c.get('user');
    const validated = c.get('validated_json') as { is_admin: boolean };

    try {
      // Constraint: Admins cannot revoke their own admin status
      if (currentUser.user_id === targetUserId && !validated.is_admin) {
        logger.warn('Admin attempted to revoke own admin status', {
          userId: currentUser.user_id,
        });
        return c.json(
          response.error(
            'Cannot revoke your own admin status. Another admin must do this.',
            'SELF_ADMIN_REVOKE'
          ),
          400
        );
      }

      // Check if target user exists
      const targetUser = await c.env.DB.prepare(
        'SELECT id, email, display_name, provider, created_at, updated_at, is_active, is_admin FROM users WHERE id = ?'
      )
        .bind(targetUserId)
        .first<{
          id: string;
          email: string;
          display_name: string | null;
          provider: string;
          created_at: number;
          updated_at: number;
          is_active: number;
          is_admin: number;
        }>();

      if (!targetUser) {
        logger.warn('User not found for admin role change', { targetUserId });
        return c.json(response.notFound('User'), 404);
      }

      // If revoking admin status, ensure at least one admin remains
      if (!validated.is_admin && targetUser.is_admin) {
        const adminCountResult = await c.env.DB.prepare(
          'SELECT COUNT(*) as count FROM users WHERE is_admin = 1'
        ).first<{ count: number }>();

        if (adminCountResult && adminCountResult.count <= 1) {
          logger.warn('Attempted to revoke last admin', {
            targetUserId,
            adminCount: adminCountResult.count,
          });
          return c.json(
            response.error(
              'Cannot revoke admin status. At least one admin must remain in the system.',
              'LAST_ADMIN'
            ),
            400
          );
        }
      }

      // Check if status is actually changing
      const currentIsAdmin = !!targetUser.is_admin;
      if (currentIsAdmin === validated.is_admin) {
        logger.info('Admin status unchanged', {
          targetUserId,
          is_admin: validated.is_admin,
        });
        // Return success but with the current unchanged user data
        return c.json(
          response.updated({
            id: targetUser.id,
            email: targetUser.email,
            display_name: targetUser.display_name,
            provider: targetUser.provider,
            created_at: targetUser.created_at,
            updated_at: targetUser.updated_at,
            is_active: !!targetUser.is_active,
            is_admin: currentIsAdmin,
          })
        );
      }

      // Update admin status
      const now = Math.floor(Date.now() / 1000);
      await c.env.DB.prepare('UPDATE users SET is_admin = ?, updated_at = ? WHERE id = ?')
        .bind(validated.is_admin ? 1 : 0, now, targetUserId)
        .run();

      // Log the admin role change to audit log
      await logUserOperation(c.env.DB, c, 'admin_role_change', targetUserId, currentUser.user_id, {
        previous_is_admin: currentIsAdmin,
        new_is_admin: validated.is_admin,
        changed_by: currentUser.user_id,
      });

      logger.info('Admin status changed', {
        targetUserId,
        changedBy: currentUser.user_id,
        previous_is_admin: currentIsAdmin,
        new_is_admin: validated.is_admin,
      });

      // Fetch and return updated user
      const updatedUser = await c.env.DB.prepare(
        'SELECT id, email, display_name, provider, created_at, updated_at, is_active, is_admin FROM users WHERE id = ?'
      )
        .bind(targetUserId)
        .first();

      return c.json(
        response.updated({
          id: updatedUser!.id,
          email: updatedUser!.email,
          display_name: updatedUser!.display_name,
          provider: updatedUser!.provider,
          created_at: updatedUser!.created_at,
          updated_at: updatedUser!.updated_at,
          is_active: !!updatedUser!.is_active,
          is_admin: !!updatedUser!.is_admin,
        })
      );
    } catch (error) {
      logger.error('Error changing admin status', error as Error, { targetUserId });
      return c.json(response.error('Failed to change admin status', 'ADMIN_CHANGE_FAILED'), 500);
    }
  }
);

export default usersRouter;
