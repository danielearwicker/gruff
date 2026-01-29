/**
 * User management routes
 *
 * Handles listing users, getting user details, updating user profiles, and viewing user activity
 */

import { Hono } from 'hono';
import { validateJson, validateQuery } from '../middleware/validation.js';
import { requireAuth } from '../middleware/auth.js';
import { updateUserSchema } from '../schemas/index.js';
import * as response from '../utils/response.js';
import { getLogger } from '../middleware/request-context.js';
import { z } from 'zod';
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
}

const usersRouter = new Hono<{ Bindings: Bindings }>();

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
 * List all users (admin functionality - for now, any authenticated user can access)
 * In a production system, this should be restricted to admin users only
 */
usersRouter.get('/', requireAuth(), validateQuery(listUsersQuerySchema), async c => {
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
      'SELECT id, email, display_name, provider, created_at, updated_at, is_active FROM users WHERE 1=1';
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
      'SELECT id, email, display_name, provider, created_at, updated_at, is_active FROM users WHERE id = ?'
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
 * Users can only update their own profile (enforced by checking JWT user_id)
 * Admins could update any profile (not implemented yet)
 */
usersRouter.put('/:id', requireAuth(), validateJson(updateUserSchema), async c => {
  const logger = getLogger(c);
  const userId = c.req.param('id');
  const currentUser = c.get('user');
  const validated = c.get('validated_json') as {
    display_name?: string;
    email?: string;
    is_active?: number;
  };

  try {
    // Check if user is updating their own profile
    if (currentUser.user_id !== userId) {
      logger.warn('User attempted to update another user profile', {
        currentUserId: currentUser.user_id,
        targetUserId: userId,
      });
      return c.json(response.forbidden('You can only update your own profile'), 403);
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
      const emailExists = await c.env.DB.prepare('SELECT id FROM users WHERE email = ? AND id != ?')
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
      'SELECT id, email, display_name, provider, created_at, updated_at, is_active FROM users WHERE id = ?'
    )
      .bind(userId)
      .first();

    logger.info('User profile updated', { userId });

    return c.json(
      response.updated({
        id: updatedUser!.id,
        email: updatedUser!.email,
        display_name: updatedUser!.display_name,
        provider: updatedUser!.provider,
        created_at: updatedUser!.created_at,
        updated_at: updatedUser!.updated_at,
        is_active: !!updatedUser!.is_active,
      })
    );
  } catch (error) {
    logger.error('Error updating user profile', error as Error, { userId });
    return c.json(response.error('Failed to update user profile', 'USER_UPDATE_FAILED'), 500);
  }
});

/**
 * GET /api/users/{id}/activity
 *
 * Get a user's creation and edit history (entities and links they've created/modified)
 */
usersRouter.get('/:id/activity', requireAuth(), async c => {
  const logger = getLogger(c);
  const userId = c.req.param('id');

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

    // Get entities created by user
    const entities = await c.env.DB.prepare(
      `SELECT id, type_id, version, created_at, is_deleted, is_latest
       FROM entities
       WHERE created_by = ? AND is_latest = 1
       ORDER BY created_at DESC
       LIMIT ?`
    )
      .bind(userId, Math.floor(limit / 2))
      .all();

    // Get links created by user
    const links = await c.env.DB.prepare(
      `SELECT id, type_id, source_entity_id, target_entity_id, version, created_at, is_deleted, is_latest
       FROM links
       WHERE created_by = ? AND is_latest = 1
       ORDER BY created_at DESC
       LIMIT ?`
    )
      .bind(userId, Math.floor(limit / 2))
      .all();

    // Combine and sort by created_at
    const entityActivities = (
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

    const linkActivities = ((links.results || []) as unknown as Array<Record<string, unknown>>).map(
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
  if (visited.has(groupId)) {
    return [];
  }

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

export default usersRouter;
