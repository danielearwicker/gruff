/**
 * Group management routes
 *
 * Handles creating, listing, updating, and deleting groups, as well as managing group membership.
 * Groups can contain users and other groups (nested groups).
 * Maximum nesting depth of 10 levels to prevent performance issues.
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { validateJson, validateQuery } from '../middleware/validation.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import {
  createGroupSchema,
  updateGroupSchema,
  addGroupMemberSchema,
  groupSchema,
  listGroupsQuerySchema,
  listGroupMembersQuerySchema,
} from '../schemas/index.js';
import * as response from '../utils/response.js';
import { getLogger } from '../middleware/request-context.js';
import { applyFieldSelection, applyFieldSelectionToArray } from '../utils/field-selection.js';
import { invalidateAllEffectiveGroupsCache } from '../utils/cache.js';

type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  JWT_SECRET: string;
  ENVIRONMENT: string;
};

// Allowed fields for group responses
const GROUP_ALLOWED_FIELDS = new Set([
  'id',
  'name',
  'description',
  'created_at',
  'created_by',
  'member_count',
]);

// Maximum nesting depth for group hierarchy
const MAX_NESTING_DEPTH = 10;

interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  created_at: number;
  created_by: string | null;
}

// Response schema for group operations
const GroupResponseSchema = z
  .object({
    success: z.literal(true),
    data: groupSchema,
    message: z.string().optional().openapi({ example: 'Resource created successfully' }),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('GroupResponse');

// Error response schema for group operations
const GroupErrorResponseSchema = z
  .object({
    success: z.literal(false),
    error: z.string().openapi({ example: 'Group name already exists' }),
    code: z.string().openapi({ example: 'GROUP_NAME_EXISTS' }),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('GroupErrorResponse');

// Paginated list response schema for group operations
const GroupListResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.array(z.record(z.string(), z.unknown())).openapi({
      description: 'Array of group objects (fields vary based on field selection)',
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
          .openapi({ example: 100, description: 'Total number of matching groups' }),
        hasMore: z
          .boolean()
          .openapi({ example: true, description: 'Whether more results are available' }),
      })
      .optional(),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('GroupListResponse');

const groupsRouter = new OpenAPIHono<{ Bindings: Bindings }>();

/**
 * POST /api/groups route definition
 */
const createGroupRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Groups'],
  summary: 'Create group',
  description: 'Create a new group (admin only)',
  operationId: 'createGroup',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth(), requireAdmin()] as const,
  request: {
    body: {
      content: {
        'application/json': {
          schema: createGroupSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    201: {
      description: 'Group created',
      content: {
        'application/json': {
          schema: GroupResponseSchema,
        },
      },
    },
    400: {
      description: 'Validation error',
      content: {
        'application/json': {
          schema: GroupErrorResponseSchema,
        },
      },
    },
    401: {
      description: 'Unauthorized - authentication required',
      content: {
        'application/json': {
          schema: GroupErrorResponseSchema,
        },
      },
    },
    403: {
      description: 'Forbidden - admin role required',
      content: {
        'application/json': {
          schema: GroupErrorResponseSchema,
        },
      },
    },
    409: {
      description: 'Conflict - group name already exists',
      content: {
        'application/json': {
          schema: GroupErrorResponseSchema,
        },
      },
    },
  },
});

/**
 * POST /api/groups
 * Create a new group (admin only)
 */
groupsRouter.openapi(createGroupRoute, async c => {
  const logger = getLogger(c);
  const currentUser = c.get('user');
  const validated = c.req.valid('json');

  try {
    // Check if group name already exists
    const existingGroup = await c.env.DB.prepare('SELECT id FROM groups WHERE name = ?')
      .bind(validated.name)
      .first();

    if (existingGroup) {
      logger.warn('Group name already exists', { name: validated.name });
      return c.json(
        {
          success: false as const,
          error: 'Group name already exists',
          code: 'GROUP_NAME_EXISTS',
          timestamp: new Date().toISOString(),
        },
        409
      );
    }

    // Generate UUID for the new group
    const groupId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);

    // Insert the new group
    await c.env.DB.prepare(
      'INSERT INTO groups (id, name, description, created_at, created_by) VALUES (?, ?, ?, ?, ?)'
    )
      .bind(groupId, validated.name, validated.description || null, now, currentUser.user_id)
      .run();

    logger.info('Group created', { groupId, name: validated.name });

    return c.json(
      {
        success: true as const,
        data: {
          id: groupId,
          name: validated.name,
          description: validated.description || null,
          created_at: now,
          created_by: currentUser.user_id,
        },
        message: 'Resource created successfully',
        timestamp: new Date().toISOString(),
      },
      201
    );
  } catch (error) {
    logger.error('Error creating group', error as Error);
    throw error;
  }
});

/**
 * GET /api/groups route definition
 */
const listGroupsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Groups'],
  summary: 'List groups',
  description: 'List all groups with optional filtering and pagination',
  operationId: 'listGroups',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth()] as const,
  request: {
    query: listGroupsQuerySchema,
  },
  responses: {
    200: {
      description: 'Paginated list of groups',
      content: {
        'application/json': {
          schema: GroupListResponseSchema,
        },
      },
    },
    400: {
      description: 'Validation error (e.g., invalid fields requested)',
      content: {
        'application/json': {
          schema: GroupErrorResponseSchema,
        },
      },
    },
    401: {
      description: 'Unauthorized - authentication required',
      content: {
        'application/json': {
          schema: GroupErrorResponseSchema,
        },
      },
    },
    500: {
      description: 'Failed to list groups',
      content: {
        'application/json': {
          schema: GroupErrorResponseSchema,
        },
      },
    },
  },
});

/**
 * GET /api/groups
 * List all groups (paginated)
 */
groupsRouter.openapi(listGroupsRoute, async c => {
  const logger = getLogger(c);
  const validated = c.req.valid('query');

  const { limit, offset, name, fields } = validated;

  try {
    // Build the query dynamically based on filters
    let query = `
      SELECT g.id, g.name, g.description, g.created_at, g.created_by,
             (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count
      FROM groups g
      WHERE 1=1
    `;
    const params: unknown[] = [];

    if (name) {
      query += ' AND g.name LIKE ?';
      params.push(`%${name}%`);
    }

    // Add ordering and pagination
    query += ' ORDER BY g.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    // Execute the query
    const stmt = c.env.DB.prepare(query);
    const results = await stmt.bind(...params).all();

    // Get total count for pagination
    let countQuery = 'SELECT COUNT(*) as total FROM groups WHERE 1=1';
    const countParams: unknown[] = [];

    if (name) {
      countQuery += ' AND name LIKE ?';
      countParams.push(`%${name}%`);
    }

    const countStmt = c.env.DB.prepare(countQuery);
    const countResult = await countStmt.bind(...countParams).first<{ total: number }>();
    const total = countResult?.total || 0;

    logger.info('Groups listed', { count: results.results?.length || 0, total });

    // Format the groups
    const groups = (
      (results.results || []) as unknown as (GroupRow & { member_count: number })[]
    ).map(group => ({
      id: group.id,
      name: group.name,
      description: group.description,
      created_at: group.created_at,
      created_by: group.created_by,
      member_count: group.member_count,
    }));

    // Apply field selection if requested
    const fieldSelection = applyFieldSelectionToArray(
      groups as Record<string, unknown>[],
      fields,
      GROUP_ALLOWED_FIELDS
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
    logger.error('Error listing groups', error as Error);
    return c.json(
      {
        success: false as const,
        error: 'Failed to list groups',
        code: 'GROUP_LIST_FAILED',
        timestamp: new Date().toISOString(),
      },
      500
    );
  }
});

// Path parameters schema for group ID
const GroupIdParamsSchema = z.object({
  id: z
    .string()
    .min(1)
    .openapi({
      param: { name: 'id', in: 'path' },
      example: '550e8400-e29b-41d4-a716-446655440000',
      description: 'Group ID',
    }),
});

// Query schema for field selection
const GroupFieldSelectionQuerySchema = z.object({
  fields: z
    .string()
    .optional()
    .openapi({
      param: { name: 'fields', in: 'query' },
      example: 'id,name,description',
      description: 'Comma-separated list of fields to include in response',
    }),
});

/**
 * GET /api/groups/:id route definition
 */
const getGroupRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Groups'],
  summary: 'Get group by ID',
  description:
    'Retrieve a specific group by its ID. Supports field selection via the `fields` query parameter.',
  operationId: 'getGroupById',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth()] as const,
  request: {
    params: GroupIdParamsSchema,
    query: GroupFieldSelectionQuerySchema,
  },
  responses: {
    200: {
      description: 'Group found',
      content: {
        'application/json': {
          schema: GroupResponseSchema,
        },
      },
    },
    400: {
      description: 'Validation error (e.g., invalid fields requested)',
      content: {
        'application/json': {
          schema: GroupErrorResponseSchema,
        },
      },
    },
    401: {
      description: 'Unauthorized - authentication required',
      content: {
        'application/json': {
          schema: GroupErrorResponseSchema,
        },
      },
    },
    404: {
      description: 'Group not found',
      content: {
        'application/json': {
          schema: GroupErrorResponseSchema,
        },
      },
    },
    500: {
      description: 'Failed to retrieve group details',
      content: {
        'application/json': {
          schema: GroupErrorResponseSchema,
        },
      },
    },
  },
});

/**
 * GET /api/groups/:id
 *
 * Get group details with members
 */
groupsRouter.openapi(getGroupRoute, async c => {
  const logger = getLogger(c);
  const { id: groupId } = c.req.valid('param');
  const { fields: fieldsParam } = c.req.valid('query');

  try {
    // Fetch the group from the database
    const group = await c.env.DB.prepare(
      `SELECT g.id, g.name, g.description, g.created_at, g.created_by,
              (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count
       FROM groups g WHERE g.id = ?`
    )
      .bind(groupId)
      .first<GroupRow & { member_count: number }>();

    if (!group) {
      logger.warn('Group not found', { groupId });
      return c.json(
        {
          success: false as const,
          error: 'Group not found',
          code: 'NOT_FOUND',
          timestamp: new Date().toISOString(),
        },
        404
      );
    }

    logger.info('Group details retrieved', { groupId });

    // Format group details
    const groupData = {
      id: group.id,
      name: group.name,
      description: group.description,
      created_at: group.created_at,
      created_by: group.created_by,
      member_count: group.member_count,
    };

    // Apply field selection if requested
    if (fieldsParam) {
      const fieldSelection = applyFieldSelection(
        groupData as Record<string, unknown>,
        fieldsParam,
        GROUP_ALLOWED_FIELDS
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
          data: fieldSelection.data as z.infer<typeof groupSchema>,
          timestamp: new Date().toISOString(),
        },
        200
      );
    }

    return c.json(
      {
        success: true as const,
        data: groupData,
        timestamp: new Date().toISOString(),
      },
      200
    );
  } catch (error) {
    logger.error('Error retrieving group details', error as Error, { groupId });
    return c.json(
      {
        success: false as const,
        error: 'Failed to retrieve group details',
        code: 'GROUP_RETRIEVAL_FAILED',
        timestamp: new Date().toISOString(),
      },
      500
    );
  }
});

/**
 * PUT /api/groups/:id route definition
 */
const updateGroupRoute = createRoute({
  method: 'put',
  path: '/{id}',
  tags: ['Groups'],
  summary: 'Update group',
  description: 'Update group name and/or description (admin only)',
  operationId: 'updateGroup',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth(), requireAdmin()] as const,
  request: {
    params: GroupIdParamsSchema,
    body: {
      content: {
        'application/json': {
          schema: updateGroupSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Group updated',
      content: {
        'application/json': {
          schema: GroupResponseSchema,
        },
      },
    },
    400: {
      description: 'Validation error or no fields to update',
      content: {
        'application/json': {
          schema: GroupErrorResponseSchema,
        },
      },
    },
    401: {
      description: 'Unauthorized - authentication required',
      content: {
        'application/json': {
          schema: GroupErrorResponseSchema,
        },
      },
    },
    403: {
      description: 'Forbidden - admin role required',
      content: {
        'application/json': {
          schema: GroupErrorResponseSchema,
        },
      },
    },
    404: {
      description: 'Group not found',
      content: {
        'application/json': {
          schema: GroupErrorResponseSchema,
        },
      },
    },
    409: {
      description: 'Conflict - group name already exists',
      content: {
        'application/json': {
          schema: GroupErrorResponseSchema,
        },
      },
    },
    500: {
      description: 'Failed to update group',
      content: {
        'application/json': {
          schema: GroupErrorResponseSchema,
        },
      },
    },
  },
});

/**
 * PUT /api/groups/:id
 *
 * Update group name/description (admin only)
 */
groupsRouter.openapi(updateGroupRoute, async c => {
  const logger = getLogger(c);
  const { id: groupId } = c.req.valid('param');
  const validated = c.req.valid('json');

  try {
    // Check if group exists
    const existingGroup = await c.env.DB.prepare('SELECT id, name FROM groups WHERE id = ?')
      .bind(groupId)
      .first<GroupRow>();

    if (!existingGroup) {
      logger.warn('Group not found for update', { groupId });
      return c.json(
        {
          success: false as const,
          error: 'Group not found',
          code: 'NOT_FOUND',
          timestamp: new Date().toISOString(),
        },
        404
      );
    }

    // If name is being updated, check if it's already taken
    if (validated.name && validated.name !== existingGroup.name) {
      const nameExists = await c.env.DB.prepare('SELECT id FROM groups WHERE name = ? AND id != ?')
        .bind(validated.name, groupId)
        .first();

      if (nameExists) {
        logger.warn('Group name already in use', { name: validated.name });
        return c.json(
          {
            success: false as const,
            error: 'Group name already exists',
            code: 'GROUP_NAME_EXISTS',
            timestamp: new Date().toISOString(),
          },
          409
        );
      }
    }

    // Build update query dynamically
    const updates: string[] = [];
    const params: unknown[] = [];

    if (validated.name !== undefined) {
      updates.push('name = ?');
      params.push(validated.name);
    }

    if (validated.description !== undefined) {
      updates.push('description = ?');
      params.push(validated.description);
    }

    if (updates.length === 0) {
      return c.json(
        {
          success: false as const,
          error: 'No fields to update',
          code: 'NO_UPDATE_FIELDS',
          timestamp: new Date().toISOString(),
        },
        400
      );
    }

    // Add group ID as the final parameter
    params.push(groupId);

    // Execute update
    const updateQuery = `UPDATE groups SET ${updates.join(', ')} WHERE id = ?`;
    await c.env.DB.prepare(updateQuery)
      .bind(...params)
      .run();

    // Fetch and return updated group
    const updatedGroup = await c.env.DB.prepare(
      `SELECT g.id, g.name, g.description, g.created_at, g.created_by,
              (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count
       FROM groups g WHERE g.id = ?`
    )
      .bind(groupId)
      .first<GroupRow & { member_count: number }>();

    logger.info('Group updated', { groupId });

    return c.json(
      {
        success: true as const,
        data: {
          id: updatedGroup!.id,
          name: updatedGroup!.name,
          description: updatedGroup!.description,
          created_at: updatedGroup!.created_at,
          created_by: updatedGroup!.created_by,
          member_count: updatedGroup!.member_count,
        },
        message: 'Resource updated successfully',
        timestamp: new Date().toISOString(),
      },
      200
    );
  } catch (error) {
    logger.error('Error updating group', error as Error, { groupId });
    return c.json(
      {
        success: false as const,
        error: 'Failed to update group',
        code: 'GROUP_UPDATE_FAILED',
        timestamp: new Date().toISOString(),
      },
      500
    );
  }
});

/**
 * DELETE /api/groups/:id
 *
 * Delete group (fails if has members) (admin only)
 */
groupsRouter.delete('/:id', requireAuth(), requireAdmin(), async c => {
  const logger = getLogger(c);
  const groupId = c.req.param('id');

  try {
    // Check if group exists
    const existingGroup = await c.env.DB.prepare('SELECT id FROM groups WHERE id = ?')
      .bind(groupId)
      .first();

    if (!existingGroup) {
      logger.warn('Group not found for deletion', { groupId });
      return c.json(response.notFound('Group'), 404);
    }

    // Check if group has members
    const memberCount = await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM group_members WHERE group_id = ?'
    )
      .bind(groupId)
      .first<{ count: number }>();

    if (memberCount && memberCount.count > 0) {
      logger.warn('Cannot delete group with members', { groupId, memberCount: memberCount.count });
      return c.json(
        response.error(
          'Cannot delete group that has members. Remove all members first.',
          'GROUP_HAS_MEMBERS'
        ),
        409
      );
    }

    // Check if group is a member of other groups
    const parentMemberships = await c.env.DB.prepare(
      "SELECT COUNT(*) as count FROM group_members WHERE member_type = 'group' AND member_id = ?"
    )
      .bind(groupId)
      .first<{ count: number }>();

    if (parentMemberships && parentMemberships.count > 0) {
      logger.warn('Cannot delete group that is member of other groups', {
        groupId,
        parentCount: parentMemberships.count,
      });
      return c.json(
        response.error(
          'Cannot delete group that is a member of other groups. Remove it from parent groups first.',
          'GROUP_IS_MEMBER'
        ),
        409
      );
    }

    // Check if group is referenced in any ACL entries
    const aclReferences = await c.env.DB.prepare(
      "SELECT COUNT(*) as count FROM acl_entries WHERE principal_type = 'group' AND principal_id = ?"
    )
      .bind(groupId)
      .first<{ count: number }>();

    if (aclReferences && aclReferences.count > 0) {
      logger.warn('Cannot delete group that is referenced in ACL entries', {
        groupId,
        aclReferenceCount: aclReferences.count,
      });
      return c.json(
        response.error(
          'Cannot delete group that is referenced in access control lists. Remove the group from entity/link ACLs first.',
          'GROUP_IN_ACL'
        ),
        409
      );
    }

    // Delete the group
    await c.env.DB.prepare('DELETE FROM groups WHERE id = ?').bind(groupId).run();

    logger.info('Group deleted', { groupId });

    return c.json(response.deleted());
  } catch (error) {
    logger.error('Error deleting group', error as Error, { groupId });
    return c.json(response.error('Failed to delete group', 'GROUP_DELETE_FAILED'), 500);
  }
});

/**
 * Helper function to check for cycles in group membership
 * Returns true if adding the member would create a cycle
 */
async function wouldCreateCycle(
  db: D1Database,
  groupId: string,
  memberId: string,
  depth: number = 0
): Promise<boolean> {
  // Prevent infinite recursion
  if (depth >= MAX_NESTING_DEPTH) {
    return true; // Consider exceeding max depth as a cycle
  }

  // If the member is the same as the group, it's a direct cycle
  if (groupId === memberId) {
    return true;
  }

  // Get all groups that the potential parent group belongs to
  const parentGroups = await db
    .prepare("SELECT group_id FROM group_members WHERE member_type = 'group' AND member_id = ?")
    .bind(groupId)
    .all<{ group_id: string }>();

  // Check if any parent group would create a cycle
  for (const parent of parentGroups.results || []) {
    if (parent.group_id === memberId) {
      return true; // Found a cycle
    }
    // Recursively check parent groups
    if (await wouldCreateCycle(db, parent.group_id, memberId, depth + 1)) {
      return true;
    }
  }

  return false;
}

/**
 * Helper function to get the current nesting depth of a group
 */
async function getGroupNestingDepth(
  db: D1Database,
  groupId: string,
  visited: Set<string> = new Set()
): Promise<number> {
  if (visited.has(groupId)) {
    return 0; // Prevent infinite loop in case of existing cycles
  }
  visited.add(groupId);

  // Get all child groups
  const childGroups = await db
    .prepare("SELECT member_id FROM group_members WHERE group_id = ? AND member_type = 'group'")
    .bind(groupId)
    .all<{ member_id: string }>();

  if (!childGroups.results || childGroups.results.length === 0) {
    return 0;
  }

  let maxChildDepth = 0;
  for (const child of childGroups.results) {
    const childDepth = await getGroupNestingDepth(db, child.member_id, new Set(visited));
    maxChildDepth = Math.max(maxChildDepth, childDepth);
  }

  return maxChildDepth + 1;
}

/**
 * POST /api/groups/:id/members
 *
 * Add member (user or group) to group (admin only)
 */
groupsRouter.post(
  '/:id/members',
  requireAuth(),
  requireAdmin(),
  validateJson(addGroupMemberSchema),
  async c => {
    const logger = getLogger(c);
    const groupId = c.req.param('id');
    const currentUser = c.get('user');
    const validated = c.get('validated_json') as {
      member_type: 'user' | 'group';
      member_id: string;
    };

    try {
      // Check if group exists
      const existingGroup = await c.env.DB.prepare('SELECT id FROM groups WHERE id = ?')
        .bind(groupId)
        .first();

      if (!existingGroup) {
        logger.warn('Group not found for adding member', { groupId });
        return c.json(response.notFound('Group'), 404);
      }

      // Check if member exists (user or group)
      if (validated.member_type === 'user') {
        const user = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?')
          .bind(validated.member_id)
          .first();
        if (!user) {
          logger.warn('User not found for membership', { userId: validated.member_id });
          return c.json(response.notFound('User'), 404);
        }
      } else {
        const memberGroup = await c.env.DB.prepare('SELECT id FROM groups WHERE id = ?')
          .bind(validated.member_id)
          .first();
        if (!memberGroup) {
          logger.warn('Member group not found', { memberId: validated.member_id });
          return c.json(response.notFound('Member group'), 404);
        }

        // Check for cycles when adding a group as a member
        const createsCycle = await wouldCreateCycle(c.env.DB, groupId, validated.member_id);
        if (createsCycle) {
          logger.warn('Adding member would create cycle', {
            groupId,
            memberId: validated.member_id,
          });
          return c.json(
            response.error(
              'Cannot add group as member: would create a circular membership',
              'CIRCULAR_MEMBERSHIP'
            ),
            409
          );
        }

        // Check nesting depth
        const memberDepth = await getGroupNestingDepth(c.env.DB, validated.member_id);
        const parentDepth = await getGroupNestingDepth(c.env.DB, groupId);

        // The new nesting depth would be the parent's position + 1 + member's depth
        // We need to check from the top-level parent to avoid exceeding MAX_NESTING_DEPTH
        if (memberDepth + 1 > MAX_NESTING_DEPTH) {
          logger.warn('Adding member would exceed max nesting depth', {
            groupId,
            memberId: validated.member_id,
            memberDepth,
            parentDepth,
          });
          return c.json(
            response.error(
              `Cannot add group as member: would exceed maximum nesting depth of ${MAX_NESTING_DEPTH}`,
              'MAX_NESTING_DEPTH_EXCEEDED'
            ),
            409
          );
        }
      }

      // Check if member is already in the group
      const existingMember = await c.env.DB.prepare(
        'SELECT group_id FROM group_members WHERE group_id = ? AND member_type = ? AND member_id = ?'
      )
        .bind(groupId, validated.member_type, validated.member_id)
        .first();

      if (existingMember) {
        logger.warn('Member already in group', {
          groupId,
          memberType: validated.member_type,
          memberId: validated.member_id,
        });
        return c.json(
          response.error('Member already exists in group', 'MEMBER_ALREADY_EXISTS'),
          409
        );
      }

      // Add the member
      const now = Math.floor(Date.now() / 1000);
      await c.env.DB.prepare(
        'INSERT INTO group_members (group_id, member_type, member_id, created_at, created_by) VALUES (?, ?, ?, ?, ?)'
      )
        .bind(groupId, validated.member_type, validated.member_id, now, currentUser.user_id)
        .run();

      // Invalidate effective groups cache since membership changed
      await invalidateAllEffectiveGroupsCache(c.env.KV);

      logger.info('Member added to group', {
        groupId,
        memberType: validated.member_type,
        memberId: validated.member_id,
      });

      return c.json(
        response.created({
          group_id: groupId,
          member_type: validated.member_type,
          member_id: validated.member_id,
          created_at: now,
          created_by: currentUser.user_id,
        }),
        201
      );
    } catch (error) {
      logger.error('Error adding member to group', error as Error, { groupId });
      return c.json(response.error('Failed to add member to group', 'ADD_MEMBER_FAILED'), 500);
    }
  }
);

/**
 * DELETE /api/groups/:id/members/:memberType/:memberId
 *
 * Remove member from group (admin only)
 */
groupsRouter.delete(
  '/:id/members/:memberType/:memberId',
  requireAuth(),
  requireAdmin(),
  async c => {
    const logger = getLogger(c);
    const groupId = c.req.param('id');
    const memberType = c.req.param('memberType');
    const memberId = c.req.param('memberId');

    // Validate member type
    if (memberType !== 'user' && memberType !== 'group') {
      return c.json(
        response.error('Invalid member type. Must be "user" or "group"', 'INVALID_MEMBER_TYPE'),
        400
      );
    }

    try {
      // Check if group exists
      const existingGroup = await c.env.DB.prepare('SELECT id FROM groups WHERE id = ?')
        .bind(groupId)
        .first();

      if (!existingGroup) {
        logger.warn('Group not found for removing member', { groupId });
        return c.json(response.notFound('Group'), 404);
      }

      // Check if member exists in group
      const existingMember = await c.env.DB.prepare(
        'SELECT group_id FROM group_members WHERE group_id = ? AND member_type = ? AND member_id = ?'
      )
        .bind(groupId, memberType, memberId)
        .first();

      if (!existingMember) {
        logger.warn('Member not found in group', { groupId, memberType, memberId });
        return c.json(response.notFound('Member in group'), 404);
      }

      // Remove the member
      await c.env.DB.prepare(
        'DELETE FROM group_members WHERE group_id = ? AND member_type = ? AND member_id = ?'
      )
        .bind(groupId, memberType, memberId)
        .run();

      // Invalidate effective groups cache since membership changed
      await invalidateAllEffectiveGroupsCache(c.env.KV);

      logger.info('Member removed from group', { groupId, memberType, memberId });

      return c.json(response.deleted());
    } catch (error) {
      logger.error('Error removing member from group', error as Error, { groupId });
      return c.json(
        response.error('Failed to remove member from group', 'REMOVE_MEMBER_FAILED'),
        500
      );
    }
  }
);

/**
 * GET /api/groups/:id/members
 *
 * List direct members of a group
 */
groupsRouter.get(
  '/:id/members',
  requireAuth(),
  validateQuery(listGroupMembersQuerySchema),
  async c => {
    const logger = getLogger(c);
    const groupId = c.req.param('id');
    const validated = c.get('validated_query') as {
      limit: number;
      offset: number;
      member_type?: 'user' | 'group';
    };

    const { limit, offset, member_type } = validated;

    try {
      // Check if group exists
      const existingGroup = await c.env.DB.prepare('SELECT id FROM groups WHERE id = ?')
        .bind(groupId)
        .first();

      if (!existingGroup) {
        logger.warn('Group not found for listing members', { groupId });
        return c.json(response.notFound('Group'), 404);
      }

      // Build query to get members with their details
      let query = `
        SELECT
          gm.member_type,
          gm.member_id,
          gm.created_at,
          CASE
            WHEN gm.member_type = 'user' THEN u.display_name
            WHEN gm.member_type = 'group' THEN g.name
          END as name,
          CASE
            WHEN gm.member_type = 'user' THEN u.email
            ELSE NULL
          END as email
        FROM group_members gm
        LEFT JOIN users u ON gm.member_type = 'user' AND gm.member_id = u.id
        LEFT JOIN groups g ON gm.member_type = 'group' AND gm.member_id = g.id
        WHERE gm.group_id = ?
      `;
      const params: unknown[] = [groupId];

      if (member_type) {
        query += ' AND gm.member_type = ?';
        params.push(member_type);
      }

      query += ' ORDER BY gm.created_at DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);

      const results = await c.env.DB.prepare(query)
        .bind(...params)
        .all<{
          member_type: 'user' | 'group';
          member_id: string;
          created_at: number;
          name: string | null;
          email: string | null;
        }>();

      // Get total count
      let countQuery = 'SELECT COUNT(*) as total FROM group_members WHERE group_id = ?';
      const countParams: unknown[] = [groupId];

      if (member_type) {
        countQuery += ' AND member_type = ?';
        countParams.push(member_type);
      }

      const countResult = await c.env.DB.prepare(countQuery)
        .bind(...countParams)
        .first<{ total: number }>();
      const total = countResult?.total || 0;

      logger.info('Group members listed', { groupId, count: results.results?.length || 0 });

      // Format members
      const members = (results.results || []).map(member => ({
        member_type: member.member_type,
        member_id: member.member_id,
        created_at: member.created_at,
        name: member.name,
        email: member.email,
      }));

      const page = Math.floor(offset / limit) + 1;
      const hasMore = offset + limit < total;

      return c.json(response.paginated(members, total, page, limit, hasMore));
    } catch (error) {
      logger.error('Error listing group members', error as Error, { groupId });
      return c.json(response.error('Failed to list group members', 'LIST_MEMBERS_FAILED'), 500);
    }
  }
);

/**
 * Helper function to recursively get all effective members of a group
 */
async function getEffectiveMembers(
  db: D1Database,
  groupId: string,
  visited: Set<string> = new Set()
): Promise<
  Array<{
    member_type: 'user' | 'group';
    member_id: string;
    name: string | null;
    email: string | null;
    path: string[];
  }>
> {
  if (visited.has(groupId)) {
    return []; // Prevent infinite loop in case of cycles
  }
  visited.add(groupId);

  const members: Array<{
    member_type: 'user' | 'group';
    member_id: string;
    name: string | null;
    email: string | null;
    path: string[];
  }> = [];

  // Get direct members
  const directMembers = await db
    .prepare(
      `SELECT
        gm.member_type,
        gm.member_id,
        CASE
          WHEN gm.member_type = 'user' THEN u.display_name
          WHEN gm.member_type = 'group' THEN g.name
        END as name,
        CASE
          WHEN gm.member_type = 'user' THEN u.email
          ELSE NULL
        END as email
      FROM group_members gm
      LEFT JOIN users u ON gm.member_type = 'user' AND gm.member_id = u.id
      LEFT JOIN groups g ON gm.member_type = 'group' AND gm.member_id = g.id
      WHERE gm.group_id = ?`
    )
    .bind(groupId)
    .all<{
      member_type: 'user' | 'group';
      member_id: string;
      name: string | null;
      email: string | null;
    }>();

  for (const member of directMembers.results || []) {
    if (member.member_type === 'user') {
      members.push({
        ...member,
        path: [groupId],
      });
    } else {
      // For group members, add the group itself and recursively get its members
      members.push({
        ...member,
        path: [groupId],
      });

      // Recursively get members of the nested group
      const nestedMembers = await getEffectiveMembers(db, member.member_id, new Set(visited));
      for (const nested of nestedMembers) {
        // Add current group to the path
        members.push({
          ...nested,
          path: [groupId, ...nested.path],
        });
      }
    }
  }

  return members;
}

/**
 * GET /api/groups/:id/effective-members
 *
 * List all members of a group (recursive, including nested group members)
 */
groupsRouter.get('/:id/effective-members', requireAuth(), async c => {
  const logger = getLogger(c);
  const groupId = c.req.param('id');

  try {
    // Check if group exists
    const existingGroup = await c.env.DB.prepare('SELECT id FROM groups WHERE id = ?')
      .bind(groupId)
      .first();

    if (!existingGroup) {
      logger.warn('Group not found for listing effective members', { groupId });
      return c.json(response.notFound('Group'), 404);
    }

    const allMembers = await getEffectiveMembers(c.env.DB, groupId);

    // Deduplicate users (a user might appear through multiple paths)
    const uniqueUsers = new Map<
      string,
      {
        member_id: string;
        name: string | null;
        email: string | null;
        paths: string[][];
      }
    >();

    const groups: Array<{
      member_id: string;
      name: string | null;
      path: string[];
    }> = [];

    for (const member of allMembers) {
      if (member.member_type === 'user') {
        const existing = uniqueUsers.get(member.member_id);
        if (existing) {
          existing.paths.push(member.path);
        } else {
          uniqueUsers.set(member.member_id, {
            member_id: member.member_id,
            name: member.name,
            email: member.email,
            paths: [member.path],
          });
        }
      } else {
        groups.push({
          member_id: member.member_id,
          name: member.name,
          path: member.path,
        });
      }
    }

    logger.info('Effective members retrieved', {
      groupId,
      userCount: uniqueUsers.size,
      groupCount: groups.length,
    });

    return c.json(
      response.success({
        users: Array.from(uniqueUsers.values()),
        groups,
        total_users: uniqueUsers.size,
        total_groups: groups.length,
      })
    );
  } catch (error) {
    logger.error('Error listing effective members', error as Error, { groupId });
    return c.json(
      response.error('Failed to list effective members', 'EFFECTIVE_MEMBERS_FAILED'),
      500
    );
  }
});

export default groupsRouter;
