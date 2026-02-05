import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { validateQuery } from '../middleware/validation.js';
import { optionalAuth } from '../middleware/auth.js';
import { ErrorResponseSchema } from '../schemas/openapi-common.js';
import { searchEntitiesSchema, searchLinksSchema, suggestionsSchema } from '../schemas/index.js';
import * as response from '../utils/response.js';
import { getLogger } from '../middleware/request-context.js';
import { buildPropertyFilters, buildFilterExpression } from '../utils/property-filters.js';
import { buildAclFilterClause, filterByAclPermission } from '../utils/acl.js';

type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  ENVIRONMENT: string;
};

const search = new OpenAPIHono<{ Bindings: Bindings }>();

// Response schema for cursor-paginated entity search results
const SearchEntitiesResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.array(z.record(z.string(), z.unknown())).openapi({
      description: 'Array of matching entities',
    }),
    metadata: z.object({
      hasMore: z.boolean().openapi({ example: false, description: 'Whether more results exist' }),
      cursor: z.string().optional().openapi({ description: 'Cursor for next page of results' }),
      total: z
        .number()
        .int()
        .optional()
        .openapi({ description: 'Total number of matching entities' }),
    }),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('SearchEntitiesResponse');

// Response schema for cursor-paginated link search results
const SearchLinksResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.array(z.record(z.string(), z.unknown())).openapi({
      description: 'Array of matching links',
    }),
    metadata: z.object({
      hasMore: z.boolean().openapi({ example: false, description: 'Whether more results exist' }),
      cursor: z.string().optional().openapi({ description: 'Cursor for next page of results' }),
      total: z.number().int().optional().openapi({ description: 'Total number of matching links' }),
    }),
    timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  })
  .openapi('SearchLinksResponse');

/**
 * POST /api/search/entities route definition
 */
const searchEntitiesRoute = createRoute({
  method: 'post',
  path: '/entities',
  tags: ['Search'],
  summary: 'Search entities',
  description:
    'Search entities by JSON properties with advanced filtering. ACL filtering is applied: authenticated users see entities they have read permission on, resources with NULL acl_id are visible to all authenticated users, unauthenticated requests only see resources with NULL acl_id (public).',
  operationId: 'searchEntities',
  security: [{ bearerAuth: [] }],
  middleware: [optionalAuth()] as const,
  request: {
    body: {
      content: {
        'application/json': {
          schema: searchEntitiesSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Search results',
      content: {
        'application/json': {
          schema: SearchEntitiesResponseSchema,
        },
      },
    },
    400: {
      description: 'Invalid filter expression or property filter',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    500: {
      description: 'Search failed',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

/**
 * POST /api/search/entities
 * Search for entities based on criteria
 */
search.openapi(searchEntitiesRoute, async c => {
  const criteria = c.req.valid('json');
  const db = c.env.DB;
  const kv = c.env.KV;
  const user = c.get('user');
  const logger = getLogger(c);

  logger.info('Searching entities', { criteria });

  try {
    // Build the WHERE clause dynamically based on criteria
    const whereClauses: string[] = ['e.is_latest = 1'];
    const bindings: unknown[] = [];

    // Apply ACL filtering based on authentication status
    let aclFilter: Awaited<ReturnType<typeof buildAclFilterClause>> | null = null;

    if (user) {
      // Authenticated user: filter by accessible ACLs
      aclFilter = await buildAclFilterClause(db, kv, user.user_id, 'read', 'e.acl_id');

      if (aclFilter.useFilter) {
        whereClauses.push(aclFilter.whereClause);
        bindings.push(...aclFilter.bindings);
      }
    } else {
      // Unauthenticated: only show public resources (NULL acl_id)
      whereClauses.push('e.acl_id IS NULL');
    }

    // Type filter
    if (criteria.type_id) {
      whereClauses.push('e.type_id = ?');
      bindings.push(criteria.type_id);
    }

    // Creator filter
    if (criteria.created_by) {
      whereClauses.push('e.created_by = ?');
      bindings.push(criteria.created_by);
    }

    // Date range filters
    if (criteria.created_after) {
      whereClauses.push('e.created_at >= ?');
      bindings.push(criteria.created_after);
    }

    if (criteria.created_before) {
      whereClauses.push('e.created_at <= ?');
      bindings.push(criteria.created_before);
    }

    // Deleted filter
    if (!criteria.include_deleted) {
      whereClauses.push('e.is_deleted = 0');
    }

    // DEPRECATED: Legacy property filters (simple equality matching)
    // Kept for backward compatibility
    if (criteria.properties && Object.keys(criteria.properties).length > 0) {
      for (const [key, value] of Object.entries(criteria.properties)) {
        // Use SQLite's json_extract to filter by property values
        // Handle different value types
        if (typeof value === 'string') {
          whereClauses.push(`json_extract(e.properties, '$.${key}') = ?`);
          bindings.push(value);
        } else if (typeof value === 'number') {
          whereClauses.push(`CAST(json_extract(e.properties, '$.${key}') AS REAL) = ?`);
          bindings.push(value);
        } else if (typeof value === 'boolean') {
          whereClauses.push(`CAST(json_extract(e.properties, '$.${key}') AS INTEGER) = ?`);
          bindings.push(value ? 1 : 0);
        } else if (value === null) {
          whereClauses.push(`json_extract(e.properties, '$.${key}') IS NULL`);
        }
      }
    }

    // Filter expression with AND/OR logical operators (takes precedence)
    if (criteria.filter_expression) {
      try {
        const filterResult = buildFilterExpression(criteria.filter_expression, 'e');
        if (filterResult.sql) {
          whereClauses.push(filterResult.sql);
          bindings.push(...filterResult.bindings);
        }
      } catch (error) {
        logger.error('Invalid filter expression', error as Error);
        return c.json(
          {
            success: false as const,
            error: `Invalid filter expression: ${(error as Error).message}`,
            code: 'INVALID_FILTER',
            timestamp: new Date().toISOString(),
          },
          400
        );
      }
    }
    // Advanced property filters with comparison operators (combined with AND)
    // Only used if filter_expression is not provided
    else if (criteria.property_filters && criteria.property_filters.length > 0) {
      try {
        const filterResult = buildPropertyFilters(criteria.property_filters, 'e');
        if (filterResult.sql) {
          whereClauses.push(filterResult.sql);
          bindings.push(...filterResult.bindings);
        }
      } catch (error) {
        logger.error('Invalid property filter', error as Error);
        return c.json(
          {
            success: false as const,
            error: `Invalid property filter: ${(error as Error).message}`,
            code: 'INVALID_FILTER',
            timestamp: new Date().toISOString(),
          },
          400
        );
      }
    }

    // Build the base query
    const whereClause = whereClauses.join(' AND ');

    // For cursor-based pagination, we'll use created_at + id as cursor
    let cursorClause = '';
    if (criteria.cursor) {
      // Cursor format: "timestamp:id"
      const parts = criteria.cursor.split(':');
      if (parts.length >= 2) {
        const cursorTimestamp = parts[0];
        const cursorId = parts.slice(1).join(':'); // Handle UUIDs that might contain colons
        cursorClause = ` AND (e.created_at < ? OR (e.created_at = ? AND e.id < ?))`;
        bindings.push(parseInt(cursorTimestamp), parseInt(cursorTimestamp), cursorId);
      }
    }

    // Query for entities (limit + 1 to check if there are more results)
    // If using per-row ACL filtering, fetch more to account for filtered items
    const fetchLimit =
      aclFilter && !aclFilter.useFilter ? (criteria.limit + 1) * 3 : criteria.limit + 1;

    const query = `
      SELECT e.*, t.name as type_name, t.category as type_category
      FROM entities e
      LEFT JOIN types t ON e.type_id = t.id
      WHERE ${whereClause}${cursorClause}
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT ?
    `;

    bindings.push(fetchLimit);

    const results = await db
      .prepare(query)
      .bind(...bindings)
      .all();

    // Apply per-row ACL filtering if needed (when user has too many accessible ACLs)
    let filteredResults = results.results;
    if (aclFilter && !aclFilter.useFilter) {
      filteredResults = filterByAclPermission(
        results.results as Array<{ acl_id?: number | null }>,
        aclFilter.accessibleAclIds
      );
    }

    // Check if there are more results
    const hasMore = filteredResults.length > criteria.limit;
    const entities = hasMore ? filteredResults.slice(0, criteria.limit) : filteredResults;

    // Generate next cursor if there are more results
    let nextCursor = null;
    if (hasMore && entities.length > 0) {
      const lastEntity = entities[entities.length - 1];
      nextCursor = `${lastEntity.created_at}:${lastEntity.id}`;
    }

    // Parse properties for each entity
    const parsedEntities = entities.map((entity: Record<string, unknown>) => ({
      ...entity,
      properties: entity.properties ? JSON.parse(entity.properties as string) : {},
      is_deleted: Boolean(entity.is_deleted),
      is_latest: Boolean(entity.is_latest),
      type: {
        id: entity.type_id,
        name: entity.type_name,
        category: entity.type_category,
      },
    }));

    // Remove type fields from root level
    const cleanedEntities = parsedEntities.map((entity: Record<string, unknown>) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { type_name, type_category, ...rest } = entity;
      return rest;
    });

    logger.info('Entity search completed', {
      count: cleanedEntities.length,
      hasMore,
      cursor: nextCursor,
    });

    return c.json(
      {
        success: true as const,
        data: cleanedEntities,
        metadata: {
          hasMore,
          ...(nextCursor ? { cursor: nextCursor } : {}),
        },
        timestamp: new Date().toISOString(),
      },
      200
    );
  } catch (error) {
    logger.error('Entity search failed', error as Error);
    return c.json(
      {
        success: false as const,
        error: 'Entity search failed',
        code: 'SEARCH_ERROR',
        timestamp: new Date().toISOString(),
      },
      500
    );
  }
});

/**
 * POST /api/search/links route definition
 */
const searchLinksRoute = createRoute({
  method: 'post',
  path: '/links',
  tags: ['Search'],
  summary: 'Search links',
  description:
    'Search links by JSON properties with advanced filtering. ACL filtering is applied: authenticated users see links they have read permission on, resources with NULL acl_id are visible to all authenticated users, unauthenticated requests only see resources with NULL acl_id (public).',
  operationId: 'searchLinks',
  security: [{ bearerAuth: [] }],
  middleware: [optionalAuth()] as const,
  request: {
    body: {
      content: {
        'application/json': {
          schema: searchLinksSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Search results',
      content: {
        'application/json': {
          schema: SearchLinksResponseSchema,
        },
      },
    },
    400: {
      description: 'Invalid filter expression or property filter',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    500: {
      description: 'Search failed',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

/**
 * POST /api/search/links
 * Search for links based on criteria
 */
search.openapi(searchLinksRoute, async c => {
  const criteria = c.req.valid('json');
  const db = c.env.DB;
  const kv = c.env.KV;
  const user = c.get('user');
  const logger = getLogger(c);

  logger.info('Searching links', { criteria });

  try {
    // Build the WHERE clause dynamically based on criteria
    const whereClauses: string[] = ['l.is_latest = 1'];
    const bindings: unknown[] = [];

    // Apply ACL filtering based on authentication status
    let aclFilter: Awaited<ReturnType<typeof buildAclFilterClause>> | null = null;

    if (user) {
      // Authenticated user: filter by accessible ACLs
      aclFilter = await buildAclFilterClause(db, kv, user.user_id, 'read', 'l.acl_id');

      if (aclFilter.useFilter) {
        whereClauses.push(aclFilter.whereClause);
        bindings.push(...aclFilter.bindings);
      }
    } else {
      // Unauthenticated: only show public resources (NULL acl_id)
      whereClauses.push('l.acl_id IS NULL');
    }

    // Type filter
    if (criteria.type_id) {
      whereClauses.push('l.type_id = ?');
      bindings.push(criteria.type_id);
    }

    // Source entity filter
    if (criteria.source_entity_id) {
      whereClauses.push('l.source_entity_id = ?');
      bindings.push(criteria.source_entity_id);
    }

    // Target entity filter
    if (criteria.target_entity_id) {
      whereClauses.push('l.target_entity_id = ?');
      bindings.push(criteria.target_entity_id);
    }

    // Creator filter
    if (criteria.created_by) {
      whereClauses.push('l.created_by = ?');
      bindings.push(criteria.created_by);
    }

    // Date range filters
    if (criteria.created_after) {
      whereClauses.push('l.created_at >= ?');
      bindings.push(criteria.created_after);
    }

    if (criteria.created_before) {
      whereClauses.push('l.created_at <= ?');
      bindings.push(criteria.created_before);
    }

    // Deleted filter
    if (!criteria.include_deleted) {
      whereClauses.push('l.is_deleted = 0');
    }

    // DEPRECATED: Legacy property filters (simple equality matching)
    // Kept for backward compatibility
    if (criteria.properties && Object.keys(criteria.properties).length > 0) {
      for (const [key, value] of Object.entries(criteria.properties)) {
        // Use SQLite's json_extract to filter by property values
        if (typeof value === 'string') {
          whereClauses.push(`json_extract(l.properties, '$.${key}') = ?`);
          bindings.push(value);
        } else if (typeof value === 'number') {
          whereClauses.push(`CAST(json_extract(l.properties, '$.${key}') AS REAL) = ?`);
          bindings.push(value);
        } else if (typeof value === 'boolean') {
          whereClauses.push(`CAST(json_extract(l.properties, '$.${key}') AS INTEGER) = ?`);
          bindings.push(value ? 1 : 0);
        } else if (value === null) {
          whereClauses.push(`json_extract(l.properties, '$.${key}') IS NULL`);
        }
      }
    }

    // Filter expression with AND/OR logical operators (takes precedence)
    if (criteria.filter_expression) {
      try {
        const filterResult = buildFilterExpression(criteria.filter_expression, 'l');
        if (filterResult.sql) {
          whereClauses.push(filterResult.sql);
          bindings.push(...filterResult.bindings);
        }
      } catch (error) {
        logger.error('Invalid filter expression', error as Error);
        return c.json(
          {
            success: false as const,
            error: `Invalid filter expression: ${(error as Error).message}`,
            code: 'INVALID_FILTER',
            timestamp: new Date().toISOString(),
          },
          400
        );
      }
    }
    // Advanced property filters with comparison operators (combined with AND)
    // Only used if filter_expression is not provided
    else if (criteria.property_filters && criteria.property_filters.length > 0) {
      try {
        const filterResult = buildPropertyFilters(criteria.property_filters, 'l');
        if (filterResult.sql) {
          whereClauses.push(filterResult.sql);
          bindings.push(...filterResult.bindings);
        }
      } catch (error) {
        logger.error('Invalid property filter', error as Error);
        return c.json(
          {
            success: false as const,
            error: `Invalid property filter: ${(error as Error).message}`,
            code: 'INVALID_FILTER',
            timestamp: new Date().toISOString(),
          },
          400
        );
      }
    }

    // Build the base query
    const whereClause = whereClauses.join(' AND ');

    // For cursor-based pagination, we'll use created_at + id as cursor
    let cursorClause = '';
    if (criteria.cursor) {
      // Cursor format: "timestamp:id"
      const [cursorTimestamp, cursorId] = criteria.cursor.split(':');
      cursorClause = ` AND (l.created_at < ? OR (l.created_at = ? AND l.id < ?))`;
      bindings.push(parseInt(cursorTimestamp), parseInt(cursorTimestamp), cursorId);
    }

    // Query for links with type information and connected entities
    // If using per-row ACL filtering, fetch more to account for filtered items
    const fetchLimit =
      aclFilter && !aclFilter.useFilter ? (criteria.limit + 1) * 3 : criteria.limit + 1;

    const query = `
      SELECT
        l.*,
        t.name as type_name,
        t.category as type_category,
        se.id as source_id,
        se.type_id as source_type_id,
        se.properties as source_properties,
        st.name as source_type_name,
        te.id as target_id,
        te.type_id as target_type_id,
        te.properties as target_properties,
        tt.name as target_type_name
      FROM links l
      LEFT JOIN types t ON l.type_id = t.id
      LEFT JOIN entities se ON l.source_entity_id = se.id AND se.is_latest = 1
      LEFT JOIN types st ON se.type_id = st.id
      LEFT JOIN entities te ON l.target_entity_id = te.id AND te.is_latest = 1
      LEFT JOIN types tt ON te.type_id = tt.id
      WHERE ${whereClause}${cursorClause}
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT ?
    `;

    bindings.push(fetchLimit);

    const results = await db
      .prepare(query)
      .bind(...bindings)
      .all();

    // Apply per-row ACL filtering if needed (when user has too many accessible ACLs)
    let filteredResults = results.results;
    if (aclFilter && !aclFilter.useFilter) {
      filteredResults = filterByAclPermission(
        results.results as Array<{ acl_id?: number | null }>,
        aclFilter.accessibleAclIds
      );
    }

    // Check if there are more results
    const hasMore = filteredResults.length > criteria.limit;
    const links = hasMore ? filteredResults.slice(0, criteria.limit) : filteredResults;

    // Generate next cursor if there are more results
    let nextCursor = null;
    if (hasMore && links.length > 0) {
      const lastLink = links[links.length - 1];
      nextCursor = `${lastLink.created_at}:${lastLink.id}`;
    }

    // Parse properties for each link and format response
    const parsedLinks = links.map((link: Record<string, unknown>) => ({
      id: link.id,
      type_id: link.type_id,
      source_entity_id: link.source_entity_id,
      target_entity_id: link.target_entity_id,
      properties: link.properties ? JSON.parse(link.properties as string) : {},
      version: link.version,
      previous_version_id: link.previous_version_id,
      created_at: link.created_at,
      created_by: link.created_by,
      is_deleted: Boolean(link.is_deleted),
      is_latest: Boolean(link.is_latest),
      type: {
        id: link.type_id,
        name: link.type_name,
        category: link.type_category,
      },
      source_entity: link.source_id
        ? {
            id: link.source_id,
            type_id: link.source_type_id,
            type_name: link.source_type_name,
            properties: link.source_properties ? JSON.parse(link.source_properties as string) : {},
          }
        : null,
      target_entity: link.target_id
        ? {
            id: link.target_id,
            type_id: link.target_type_id,
            type_name: link.target_type_name,
            properties: link.target_properties ? JSON.parse(link.target_properties as string) : {},
          }
        : null,
    }));

    logger.info('Link search completed', {
      count: parsedLinks.length,
      hasMore,
      cursor: nextCursor,
    });

    return c.json(
      {
        success: true as const,
        data: parsedLinks,
        metadata: {
          hasMore,
          ...(nextCursor ? { cursor: nextCursor } : {}),
        },
        timestamp: new Date().toISOString(),
      },
      200
    );
  } catch (error) {
    logger.error('Link search failed', error as Error);
    return c.json(
      {
        success: false as const,
        error: 'Link search failed',
        code: 'SEARCH_ERROR',
        timestamp: new Date().toISOString(),
      },
      500
    );
  }
});

/**
 * GET /api/search/suggest
 * Type-ahead suggestions for entity properties
 *
 * ACL filtering is applied when authenticated:
 * - Authenticated users see entities they have read permission on
 * - Resources with NULL acl_id are visible to all authenticated users
 * - Unauthenticated requests only see resources with NULL acl_id (public)
 */
search.get('/suggest', optionalAuth(), validateQuery(suggestionsSchema), async c => {
  const params = c.get('validated_query') as z.infer<typeof suggestionsSchema>;
  const db = c.env.DB;
  const kv = c.env.KV;
  const user = c.get('user');
  const logger = getLogger(c);

  logger.info('Generating type-ahead suggestions', { params });

  try {
    // Build the WHERE clause dynamically
    const whereClauses: string[] = ['e.is_latest = 1', 'e.is_deleted = 0'];
    const bindings: unknown[] = [];

    // Apply ACL filtering based on authentication status
    let aclFilter: Awaited<ReturnType<typeof buildAclFilterClause>> | null = null;

    if (user) {
      // Authenticated user: filter by accessible ACLs
      aclFilter = await buildAclFilterClause(db, kv, user.user_id, 'read', 'e.acl_id');

      if (aclFilter.useFilter) {
        whereClauses.push(aclFilter.whereClause);
        bindings.push(...aclFilter.bindings);
      }
    } else {
      // Unauthenticated: only show public resources (NULL acl_id)
      whereClauses.push('e.acl_id IS NULL');
    }

    // Type filter
    if (params.type_id) {
      whereClauses.push('e.type_id = ?');
      bindings.push(params.type_id);
    }

    // Build the search clause based on property path
    // For simplicity, we'll use LIKE with % wildcards for partial matching
    // The property_path parameter determines which JSON property to search
    const propertyPath = params.property_path;
    const searchQuery = `%${params.query}%`;

    // Use json_extract to get the property value and match against it
    whereClauses.push(`json_extract(e.properties, '$.${propertyPath}') LIKE ?`);
    bindings.push(searchQuery);

    const whereClause = whereClauses.join(' AND ');

    // Query for matching entities
    // We select the entity ID, type info, and the matched property value
    // If using per-row ACL filtering, fetch more to account for filtered items
    const fetchLimit = aclFilter && !aclFilter.useFilter ? params.limit * 3 : params.limit;

    const query = `
      SELECT
        e.id,
        e.type_id,
        e.acl_id,
        t.name as type_name,
        json_extract(e.properties, '$.${propertyPath}') as matched_value,
        e.properties
      FROM entities e
      LEFT JOIN types t ON e.type_id = t.id
      WHERE ${whereClause}
      ORDER BY
        CASE
          WHEN json_extract(e.properties, '$.${propertyPath}') LIKE ? THEN 1
          ELSE 2
        END,
        json_extract(e.properties, '$.${propertyPath}')
      LIMIT ?
    `;

    // Add binding for prefix match (for better sorting - exact prefix matches first)
    bindings.push(`${params.query}%`, fetchLimit);

    const results = await db
      .prepare(query)
      .bind(...bindings)
      .all();

    // Apply per-row ACL filtering if needed (when user has too many accessible ACLs)
    let filteredResults = results.results;
    if (aclFilter && !aclFilter.useFilter) {
      filteredResults = filterByAclPermission(
        results.results as Array<{ acl_id?: number | null }>,
        aclFilter.accessibleAclIds
      );
      // Limit to requested number after filtering
      filteredResults = filteredResults.slice(0, params.limit);
    }

    // Format the suggestions
    const suggestions = filteredResults.map((row: Record<string, unknown>) => ({
      entity_id: row.id,
      type_id: row.type_id,
      type_name: row.type_name,
      matched_value: row.matched_value,
      property_path: propertyPath,
      // Optionally include full properties for additional context
      properties: row.properties ? JSON.parse(row.properties as string) : {},
    }));

    logger.info('Type-ahead suggestions generated', {
      query: params.query,
      count: suggestions.length,
    });

    return c.json(response.success(suggestions));
  } catch (error) {
    logger.error('Type-ahead suggestions failed', error as Error);
    return c.json(response.error('Type-ahead suggestions failed', 'SUGGEST_ERROR'), 500);
  }
});

export default search;
