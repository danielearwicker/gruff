/**
 * User management routes
 *
 * Handles listing users, getting user details, updating user profiles, and viewing user activity
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { validateJson } from '../middleware/validation.js';
import { requireAuth, requireAdmin, requireAdminOrSelf } from '../middleware/auth.js';
import { updateUserSchema, adminRoleChangeSchema } from '../schemas/index.js';
import { ErrorResponseSchema } from '../schemas/openapi-common.js';
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

// Query schema for listing users (OpenAPI-annotated)
const listUsersQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .openapi({
      param: { name: 'limit', in: 'query' },
      example: '20',
      description: 'Maximum number of users to return (default: 20)',
    })
    .transform(val => (val ? parseInt(val, 10) : 20)),
  offset: z
    .string()
    .optional()
    .openapi({
      param: { name: 'offset', in: 'query' },
      example: '0',
      description: 'Number of users to skip (default: 0)',
    })
    .transform(val => (val ? parseInt(val, 10) : 0)),
  is_active: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .openapi({
      param: { name: 'is_active', in: 'query' },
      example: 'true',
      description: 'Filter by active status',
    })
    .transform(val => {
      if (!val) return undefined;
      return val === 'true' || val === '1';
    }),
  provider: z
    .enum(['google', 'github', 'local', 'microsoft', 'apple'])
    .optional()
    .openapi({
      param: { name: 'provider', in: 'query' },
      example: 'local',
      description: 'Filter by authentication provider',
    }),
  // Field selection: comma-separated list of fields to include in response
  fields: z
    .string()
    .optional()
    .openapi({
      param: { name: 'fields', in: 'query' },
      example: 'id,email,display_name',
      description: 'Comma-separated list of fields to include in response',
    }),
});

// Paginated list response schema for user listing
const UserListResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.array(z.record(z.string(), z.unknown())).openapi({
      description: 'Array of user objects (fields vary based on field selection)',
    }),
    metadata: z
      .object({
        page: z.number().int().openapi({ example: 1, description: 'Current page number' }),
        pageSize: z
          .number()
          .int()
          .openapi({ example: 20, description: 'Number of items per page' }),
        total: z
          .number()
          .int()
          .openapi({ example: 100, description: 'Total number of matching users' }),
        hasMore: z
          .boolean()
          .openapi({ example: true, description: 'Whether more results are available' }),
      })
      .optional(),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('UserListResponse');

/**
 * GET /api/users route definition
 */
const listUsersRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Users'],
  summary: 'List users',
  description: 'List all users with optional filtering by active status and provider (admin only)',
  operationId: 'listUsers',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth(), requireAdmin()] as const,
  request: {
    query: listUsersQuerySchema,
  },
  responses: {
    200: {
      description: 'Paginated list of users',
      content: {
        'application/json': {
          schema: UserListResponseSchema,
        },
      },
    },
    400: {
      description: 'Invalid fields requested',
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
      description: 'Admin access required',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    500: {
      description: 'Failed to list users',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

/**
 * GET /api/users
 *
 * List all users (admin only)
 * This endpoint is restricted to admin users for security
 */
usersRouter.openapi(listUsersRoute, async c => {
  const logger = getLogger(c);
  const validated = c.req.valid('query');

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
        {
          success: false as const,
          error: `Invalid fields requested: ${fieldSelection.invalidFields.join(', ')}`,
          code: 'INVALID_FIELDS',
          timestamp: new Date().toISOString(),
        },
        400
      );
    }

    // Calculate pagination metadata
    const page = Math.floor(offset / limit) + 1;
    const hasMore = offset + limit < total;

    return c.json(
      {
        success: true as const,
        data: fieldSelection.data,
        metadata: {
          page,
          pageSize: limit,
          total,
          hasMore,
        },
        timestamp: new Date().toISOString(),
      },
      200
    );
  } catch (error) {
    logger.error('Error listing users', error as Error);
    return c.json(
      {
        success: false as const,
        error: 'Failed to list users',
        code: 'USER_LIST_FAILED',
        timestamp: new Date().toISOString(),
      },
      500
    );
  }
});

// Query schema for searching users (OpenAPI-annotated)
const searchUsersQuerySchema = z.object({
  q: z
    .string()
    .min(2)
    .openapi({
      param: { name: 'q', in: 'query' },
      example: 'john',
      description: 'Search query (min 2 characters). Searches email and display name.',
    }),
  limit: z
    .string()
    .optional()
    .openapi({
      param: { name: 'limit', in: 'query' },
      example: '10',
      description: 'Maximum number of results to return (1-50, default: 10)',
    })
    .transform(val => Math.min(Math.max(parseInt(val || '10', 10) || 10, 1), 50)),
});

// Response schema for user search results
const UserSearchResultSchema = z.object({
  id: z.string().openapi({ example: '550e8400-e29b-41d4-a716-446655440000' }),
  email: z.string().openapi({ example: 'john@example.com' }),
  display_name: z.string().nullable().openapi({ example: 'John Doe' }),
});

const UserSearchResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.array(UserSearchResultSchema).openapi({
      description: 'Array of matching users with limited profile info',
    }),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('UserSearchResponse');

/**
 * GET /api/users/search route definition
 */
const searchUsersRoute = createRoute({
  method: 'get',
  path: '/search',
  tags: ['Users'],
  summary: 'Search users',
  description:
    'Search for users by email or display name. Returns limited user info for ACL management purposes.',
  operationId: 'searchUsers',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth()] as const,
  request: {
    query: searchUsersQuerySchema,
  },
  responses: {
    200: {
      description: 'List of matching users',
      content: {
        'application/json': {
          schema: UserSearchResponseSchema,
        },
      },
    },
    400: {
      description: 'Invalid search query',
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
    500: {
      description: 'Failed to search users',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

/**
 * GET /api/users/search
 *
 * Search for users by email or display name (authenticated users only)
 * Returns limited user info for ACL management purposes.
 */
usersRouter.openapi(searchUsersRoute, async c => {
  const logger = getLogger(c);
  const validated = c.req.valid('query');
  const query = validated.q;
  const limit = validated.limit;

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
      id: user.id as string,
      email: user.email as string,
      display_name: user.display_name as string | null,
    }));

    logger.debug('User search completed', { query, resultCount: users.length });

    return c.json(
      {
        success: true as const,
        data: users,
        timestamp: new Date().toISOString(),
      },
      200
    );
  } catch (error) {
    logger.error('Error searching users', error as Error);
    return c.json(
      {
        success: false as const,
        error: 'Failed to search users',
        code: 'USER_SEARCH_FAILED',
        timestamp: new Date().toISOString(),
      },
      500
    );
  }
});

// Path params schema for user ID endpoints
const UserIdParamsSchema = z.object({
  id: z.string().openapi({
    param: { name: 'id', in: 'path' },
    example: '550e8400-e29b-41d4-a716-446655440000',
    description: 'User ID (UUID)',
  }),
});

// Query schema for field selection on single user
const UserFieldSelectionQuerySchema = z.object({
  fields: z
    .string()
    .optional()
    .openapi({
      param: { name: 'fields', in: 'query' },
      example: 'id,email,display_name',
      description: 'Comma-separated list of fields to include in response',
    }),
});

// Response schema for single user details
const UserDetailResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.record(z.string(), z.unknown()).openapi({
      description: 'User object (fields vary based on field selection)',
    }),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('UserDetailResponse');

/**
 * GET /api/users/{id} route definition
 */
const getUserRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Users'],
  summary: 'Get user by ID',
  description:
    'Get details of a specific user. Supports field selection via the `fields` query parameter.',
  operationId: 'getUser',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth()] as const,
  request: {
    params: UserIdParamsSchema,
    query: UserFieldSelectionQuerySchema,
  },
  responses: {
    200: {
      description: 'User details',
      content: {
        'application/json': {
          schema: UserDetailResponseSchema,
        },
      },
    },
    400: {
      description: 'Invalid fields requested',
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
    404: {
      description: 'User not found',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    500: {
      description: 'Failed to retrieve user details',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
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
usersRouter.openapi(getUserRoute, async c => {
  const logger = getLogger(c);
  const { id: userId } = c.req.valid('param');
  const { fields: fieldsParam } = c.req.valid('query');

  try {
    // Fetch the user from the database
    const user = await c.env.DB.prepare(
      'SELECT id, email, display_name, provider, created_at, updated_at, is_active, is_admin FROM users WHERE id = ?'
    )
      .bind(userId)
      .first();

    if (!user) {
      logger.warn('User not found', { userId });
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
          {
            success: false as const,
            error: `Invalid fields requested: ${fieldSelection.invalidFields.join(', ')}`,
            code: 'INVALID_FIELDS',
            timestamp: new Date().toISOString(),
          },
          400
        );
      }
      return c.json(
        {
          success: true as const,
          data: fieldSelection.data,
          timestamp: new Date().toISOString(),
        },
        200
      );
    }

    // Return user details
    return c.json(
      {
        success: true as const,
        data: userData,
        timestamp: new Date().toISOString(),
      },
      200
    );
  } catch (error) {
    logger.error('Error retrieving user details', error as Error, { userId });
    return c.json(
      {
        success: false as const,
        error: 'Failed to retrieve user details',
        code: 'USER_RETRIEVAL_FAILED',
        timestamp: new Date().toISOString(),
      },
      500
    );
  }
});

// Response schema for user update
const UserUpdateResponseSchema = z
  .object({
    success: z.literal(true),
    data: z
      .object({
        id: z.string().openapi({ example: '550e8400-e29b-41d4-a716-446655440000' }),
        email: z.string().openapi({ example: 'jane@example.com' }),
        display_name: z.unknown().openapi({ example: 'Jane Doe' }),
        provider: z.string().openapi({ example: 'local' }),
        created_at: z.unknown().openapi({ example: 1704067200 }),
        updated_at: z.unknown().openapi({ example: 1704067200 }),
        is_active: z.boolean().openapi({ example: true }),
        is_admin: z.boolean().openapi({ example: false }),
      })
      .openapi({ description: 'Updated user object' }),
    message: z.string().optional().openapi({ example: 'Resource updated successfully' }),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('UserUpdateResponse');

/**
 * PUT /api/users/{id} route definition
 */
const updateUserRoute = createRoute({
  method: 'put',
  path: '/{id}',
  tags: ['Users'],
  summary: 'Update user',
  description:
    'Update a user profile. Users can update their own profile, admins can update any profile.',
  operationId: 'updateUser',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth(), requireAdminOrSelf('id')] as const,
  request: {
    params: UserIdParamsSchema,
    body: {
      content: {
        'application/json': {
          schema: updateUserSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'User updated',
      content: {
        'application/json': {
          schema: UserUpdateResponseSchema,
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
      description: 'Forbidden - not admin or self, or non-admin tried to modify is_active',
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
    409: {
      description: 'Email already in use',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    500: {
      description: 'Failed to update user profile',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

/**
 * PUT /api/users/{id}
 *
 * Update a user's profile
 * Users can update their own profile, admins can update any profile
 */
usersRouter.openapi(updateUserRoute, async c => {
  const logger = getLogger(c);
  const { id: userId } = c.req.valid('param');
  const currentUser = c.get('user');
  const validated = c.req.valid('json');

  try {
    // Check if non-admin user is trying to modify is_active (admin-only field)
    if (validated.is_active !== undefined && !currentUser.is_admin) {
      logger.warn('Non-admin user attempted to modify is_active field', {
        userId: currentUser.user_id,
        targetUserId: userId,
      });
      return c.json(
        {
          success: false as const,
          error: 'Only administrators can modify the is_active field',
          code: 'ADMIN_REQUIRED',
          timestamp: new Date().toISOString(),
        },
        403
      );
    }

    // Check if user exists
    const existingUser = await c.env.DB.prepare('SELECT id, email FROM users WHERE id = ?')
      .bind(userId)
      .first();

    if (!existingUser) {
      logger.warn('User not found for update', { userId });
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

    // If email is being updated, check if it's already taken
    if (validated.email && validated.email !== existingUser.email) {
      const emailExists = await c.env.DB.prepare('SELECT id FROM users WHERE email = ? AND id != ?')
        .bind(validated.email, userId)
        .first();

      if (emailExists) {
        logger.warn('Email already in use', { email: validated.email });
        return c.json(
          {
            success: false as const,
            error: 'Email is already in use',
            code: 'EMAIL_EXISTS',
            timestamp: new Date().toISOString(),
          },
          409
        );
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
      {
        success: true as const,
        data: {
          id: updatedUser!.id as string,
          email: updatedUser!.email as string,
          display_name: updatedUser!.display_name,
          provider: updatedUser!.provider as string,
          created_at: updatedUser!.created_at,
          updated_at: updatedUser!.updated_at,
          is_active: !!updatedUser!.is_active,
          is_admin: !!updatedUser!.is_admin,
        },
        message: 'Resource updated successfully',
        timestamp: new Date().toISOString(),
      },
      200
    );
  } catch (error) {
    logger.error('Error updating user profile', error as Error, { userId });
    return c.json(
      {
        success: false as const,
        error: 'Failed to update user profile',
        code: 'USER_UPDATE_FAILED',
        timestamp: new Date().toISOString(),
      },
      500
    );
  }
});

// Query schema for user activity endpoint
const activityQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .openapi({
      param: { name: 'limit', in: 'query' },
      example: '50',
      description: 'Maximum number of activity items to return (1-100, default: 50)',
    })
    .transform(val => (val ? Math.min(Math.max(parseInt(val, 10) || 50, 1), 100) : 50)),
});

// Activity item schemas for response
const EntityActivitySchema = z.object({
  type: z.literal('entity').openapi({ example: 'entity' }),
  id: z.unknown().openapi({ example: '550e8400-e29b-41d4-a716-446655440000' }),
  type_id: z.unknown().openapi({ example: '550e8400-e29b-41d4-a716-446655440001' }),
  version: z.unknown().openapi({ example: 1 }),
  created_at: z.unknown().openapi({ example: 1704067200 }),
  is_deleted: z.boolean().openapi({ example: false }),
  is_latest: z.boolean().openapi({ example: true }),
});

const LinkActivitySchema = z.object({
  type: z.literal('link').openapi({ example: 'link' }),
  id: z.unknown().openapi({ example: '550e8400-e29b-41d4-a716-446655440002' }),
  type_id: z.unknown().openapi({ example: '550e8400-e29b-41d4-a716-446655440003' }),
  source_entity_id: z.unknown().openapi({ example: '550e8400-e29b-41d4-a716-446655440000' }),
  target_entity_id: z.unknown().openapi({ example: '550e8400-e29b-41d4-a716-446655440001' }),
  version: z.unknown().openapi({ example: 1 }),
  created_at: z.unknown().openapi({ example: 1704067200 }),
  is_deleted: z.boolean().openapi({ example: false }),
  is_latest: z.boolean().openapi({ example: true }),
});

const UserActivityResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({
      user_id: z.string().openapi({ example: '550e8400-e29b-41d4-a716-446655440000' }),
      activity: z.array(z.union([EntityActivitySchema, LinkActivitySchema])).openapi({
        description: 'Array of entity and link activity items, sorted by creation date descending',
      }),
      count: z
        .number()
        .int()
        .openapi({ example: 10, description: 'Number of activity items returned' }),
    }),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('UserActivityResponse');

/**
 * GET /api/users/{id}/activity route definition
 */
const getUserActivityRoute = createRoute({
  method: 'get',
  path: '/{id}/activity',
  tags: ['Users'],
  summary: 'Get user activity',
  description:
    "Get a user's creation and edit history (entities and links they've created/modified). Only returns items the requesting user has read access to.",
  operationId: 'getUserActivity',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth()] as const,
  request: {
    params: UserIdParamsSchema,
    query: activityQuerySchema,
  },
  responses: {
    200: {
      description: 'User activity',
      content: {
        'application/json': {
          schema: UserActivityResponseSchema,
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
    404: {
      description: 'User not found',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    500: {
      description: 'Failed to retrieve user activity',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

/**
 * GET /api/users/{id}/activity
 *
 * Get a user's creation and edit history (entities and links they've created/modified)
 * Only returns entities and links that the requesting user has read access to.
 */
usersRouter.openapi(getUserActivityRoute, async c => {
  const logger = getLogger(c);
  const { id: userId } = c.req.valid('param');
  const currentUser = c.get('user');
  const { limit } = c.req.valid('query');

  try {
    // Check if user exists
    const user = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();

    if (!user) {
      logger.warn('User not found for activity query', { userId });
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

    // Build ACL filter for the requesting user (not the target user)
    const aclFilter = await buildAclFilterClause(
      c.env.DB,
      c.env.KV,
      currentUser.user_id,
      'read',
      'acl_id'
    );

    let entityActivities: Array<{
      type: 'entity';
      id: unknown;
      type_id: unknown;
      version: unknown;
      created_at: unknown;
      is_deleted: boolean;
      is_latest: boolean;
    }> = [];
    let linkActivities: Array<{
      type: 'link';
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
        type: 'entity' as const,
        id: e.id,
        type_id: e.type_id,
        version: e.version,
        created_at: e.created_at,
        is_deleted: !!e.is_deleted,
        is_latest: !!e.is_latest,
      }));

      linkActivities = ((links.results || []) as unknown as Array<Record<string, unknown>>).map(
        l => ({
          type: 'link' as const,
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
        type: 'entity' as const,
        id: e.id,
        type_id: e.type_id,
        version: e.version,
        created_at: e.created_at,
        is_deleted: !!e.is_deleted,
        is_latest: !!e.is_latest,
      }));

      linkActivities = filteredLinks.map(l => ({
        type: 'link' as const,
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
      {
        success: true as const,
        data: {
          user_id: userId,
          activity: allActivities,
          count: allActivities.length,
        },
        timestamp: new Date().toISOString(),
      },
      200
    );
  } catch (error) {
    logger.error('Error retrieving user activity', error as Error, { userId });
    return c.json(
      {
        success: false as const,
        error: 'Failed to retrieve user activity',
        code: 'USER_ACTIVITY_FAILED',
        timestamp: new Date().toISOString(),
      },
      500
    );
  }
});

// Response schema for user group membership
const UserGroupSchema = z.object({
  id: z.string().openapi({ example: '550e8400-e29b-41d4-a716-446655440000' }),
  name: z.string().openapi({ example: 'Engineering' }),
  description: z.string().nullable().openapi({ example: 'Engineering team group' }),
  created_at: z.number().openapi({ example: 1704067200 }),
  joined_at: z.number().openapi({ example: 1704067200 }),
});

const UserGroupsResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({
      user_id: z.string().openapi({ example: '550e8400-e29b-41d4-a716-446655440000' }),
      groups: z.array(UserGroupSchema).openapi({
        description: 'Array of groups the user directly belongs to',
      }),
      count: z
        .number()
        .int()
        .openapi({ example: 2, description: 'Number of direct group memberships' }),
    }),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('UserGroupsResponse');

/**
 * GET /api/users/{id}/groups route definition
 */
const getUserGroupsRoute = createRoute({
  method: 'get',
  path: '/{id}/groups',
  tags: ['Users'],
  summary: 'Get user groups',
  description: 'List groups a user directly belongs to (does not include nested group memberships)',
  operationId: 'getUserGroups',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth()] as const,
  request: {
    params: UserIdParamsSchema,
  },
  responses: {
    200: {
      description: 'List of groups the user belongs to',
      content: {
        'application/json': {
          schema: UserGroupsResponseSchema,
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
    404: {
      description: 'User not found',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    500: {
      description: 'Failed to retrieve user groups',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

/**
 * GET /api/users/{id}/groups
 *
 * List groups a user directly belongs to
 */
usersRouter.openapi(getUserGroupsRoute, async c => {
  const logger = getLogger(c);
  const { id: userId } = c.req.valid('param');

  try {
    // Check if user exists
    const user = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();

    if (!user) {
      logger.warn('User not found for groups query', { userId });
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
      {
        success: true as const,
        data: {
          user_id: userId,
          groups: groups.results || [],
          count: groups.results?.length || 0,
        },
        timestamp: new Date().toISOString(),
      },
      200
    );
  } catch (error) {
    logger.error('Error retrieving user groups', error as Error, { userId });
    return c.json(
      {
        success: false as const,
        error: 'Failed to retrieve user groups',
        code: 'USER_GROUPS_FAILED',
        timestamp: new Date().toISOString(),
      },
      500
    );
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

// Response schema for effective group membership
const EffectiveGroupSchema = z.object({
  id: z.string().openapi({ example: '550e8400-e29b-41d4-a716-446655440000' }),
  name: z.string().openapi({ example: 'Engineering' }),
  description: z.string().nullable().openapi({ example: 'Engineering team group' }),
  paths: z.array(z.array(z.string())).openapi({
    description: 'Membership paths showing how the user belongs to this group',
    example: [['group-1', 'group-2']],
  }),
});

const UserEffectiveGroupsResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({
      user_id: z.string().openapi({ example: '550e8400-e29b-41d4-a716-446655440000' }),
      groups: z.array(EffectiveGroupSchema).openapi({
        description:
          'Array of all groups the user belongs to (directly or through nested membership)',
      }),
      count: z
        .number()
        .int()
        .openapi({ example: 3, description: 'Total number of effective group memberships' }),
    }),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('UserEffectiveGroupsResponse');

/**
 * GET /api/users/{id}/effective-groups route definition
 */
const getUserEffectiveGroupsRoute = createRoute({
  method: 'get',
  path: '/{id}/effective-groups',
  tags: ['Users'],
  summary: 'Get effective groups',
  description:
    'List all groups a user belongs to, including nested group memberships. Results are cached for performance.',
  operationId: 'getUserEffectiveGroups',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth()] as const,
  request: {
    params: UserIdParamsSchema,
  },
  responses: {
    200: {
      description: 'List of all effective groups the user belongs to',
      content: {
        'application/json': {
          schema: UserEffectiveGroupsResponseSchema,
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
    404: {
      description: 'User not found',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    500: {
      description: 'Failed to retrieve user effective groups',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

/**
 * GET /api/users/{id}/effective-groups
 *
 * List all groups a user belongs to (directly or through nested group membership)
 * Results are cached in KV with TTL of 5 minutes
 */
usersRouter.openapi(getUserEffectiveGroupsRoute, async c => {
  const logger = getLogger(c);
  const { id: userId } = c.req.valid('param');

  try {
    // Check if user exists
    const user = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();

    if (!user) {
      logger.warn('User not found for effective groups query', { userId });
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

    // Try to get from cache first using versioned key
    const cacheKey = await getVersionedEffectiveGroupsCacheKey(c.env.KV, userId);
    const cachedResult = await getCache<CachedEffectiveGroupsResult>(c.env.KV, cacheKey);

    if (cachedResult) {
      logger.info('User effective groups retrieved from cache', {
        userId,
        count: cachedResult.count,
      });
      return c.json(
        {
          success: true as const,
          data: cachedResult,
          timestamp: new Date().toISOString(),
        },
        200
      );
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

    return c.json(
      {
        success: true as const,
        data: result,
        timestamp: new Date().toISOString(),
      },
      200
    );
  } catch (error) {
    logger.error('Error retrieving user effective groups', error as Error, { userId });
    return c.json(
      {
        success: false as const,
        error: 'Failed to retrieve user effective groups',
        code: 'USER_EFFECTIVE_GROUPS_FAILED',
        timestamp: new Date().toISOString(),
      },
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
