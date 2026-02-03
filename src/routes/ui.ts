/**
 * UI Routes - Server-side rendered HTML interface
 * Provides a built-in web interface for browsing and managing the graph database
 */

import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { renderPage, escapeHtml, formatTimestamp } from '../utils/html.js';
import { verifyAccessToken, createTokenPair, createAccessToken } from '../utils/jwt.js';
import {
  storeRefreshToken,
  validateRefreshToken as validateStoredRefreshToken,
  invalidateSession,
} from '../utils/session.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import {
  getEntityAclId,
  getLinkAclId,
  getEnrichedAclEntries,
  buildAclFilterClause,
  filterByAclPermission,
  hasPermissionByAclId,
} from '../utils/acl.js';
import type { EnrichedAclEntry } from '../schemas/acl.js';

type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  JWT_SECRET: string;
  ENVIRONMENT: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_REDIRECT_URI?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_REDIRECT_URI?: string;
};

const ui = new Hono<{ Bindings: Bindings }>();

// Cookie names for UI session management
const ACCESS_TOKEN_COOKIE = 'gruff_access_token';
const REFRESH_TOKEN_COOKIE = 'gruff_refresh_token';

// Cookie options
const getCookieOptions = (c: { env: Bindings }, maxAge: number) => ({
  path: '/',
  httpOnly: true,
  secure: c.env.ENVIRONMENT === 'production',
  sameSite: 'Lax' as const,
  maxAge,
});

/**
 * Cookie-based authentication middleware for UI routes
 * Extracts JWT from cookies and validates it
 */
ui.use('*', async (c, next) => {
  const accessToken = getCookie(c, ACCESS_TOKEN_COOKIE);
  const refreshToken = getCookie(c, REFRESH_TOKEN_COOKIE);

  if (!accessToken && !refreshToken) {
    // No tokens - continue without authentication
    await next();
    return;
  }

  const jwtSecret = c.env.JWT_SECRET;
  if (!jwtSecret) {
    await next();
    return;
  }

  // Try to validate the access token
  if (accessToken) {
    const payload = await verifyAccessToken(accessToken, jwtSecret);
    if (payload) {
      c.set('user', payload);
      await next();
      return;
    }
  }

  // Access token invalid/expired - try to refresh using refresh token
  if (refreshToken) {
    const { verifyRefreshToken } = await import('../utils/jwt.js');
    const refreshPayload = await verifyRefreshToken(refreshToken, jwtSecret);

    if (refreshPayload) {
      // Validate refresh token is still valid in KV
      const isValid = await validateStoredRefreshToken(
        c.env.KV,
        refreshPayload.user_id,
        refreshToken
      );

      if (isValid) {
        // Generate new access token
        const newAccessToken = await createAccessToken(
          refreshPayload.user_id,
          refreshPayload.email,
          jwtSecret
        );

        // Set the new access token cookie
        setCookie(c, ACCESS_TOKEN_COOKIE, newAccessToken, getCookieOptions(c, 15 * 60)); // 15 minutes

        // Set user context
        c.set('user', refreshPayload);
        await next();
        return;
      }
    }

    // Refresh token is invalid - clear cookies
    deleteCookie(c, ACCESS_TOKEN_COOKIE, { path: '/' });
    deleteCookie(c, REFRESH_TOKEN_COOKIE, { path: '/' });
  }

  await next();
});

// Override CSP for UI routes to allow inline styles and scripts needed for the UI
ui.use('*', async (c, next) => {
  await next();
  // Set a permissive CSP for the UI that allows inline styles and scripts
  c.header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'self'"
  );
});

/**
 * Home page / Dashboard
 * GET /ui or GET /ui/
 */
ui.get('/', async c => {
  const user = c.get('user');

  // Get filter parameters
  const filterUserId = c.req.query('user_id') || '';
  const filterTypeId = c.req.query('type_id') || '';
  const filterTimeRange = c.req.query('time_range') || 'all';
  const filterStartDate = c.req.query('start_date') || '';
  const filterEndDate = c.req.query('end_date') || '';

  // Calculate timestamp for time range filters
  let timeRangeFilter = '';
  const now = Date.now();
  if (filterTimeRange !== 'all' && filterTimeRange !== 'custom') {
    let since = now;
    switch (filterTimeRange) {
      case 'hour':
        since = now - 60 * 60 * 1000;
        break;
      case 'day':
        since = now - 24 * 60 * 60 * 1000;
        break;
      case 'week':
        since = now - 7 * 24 * 60 * 60 * 1000;
        break;
      case 'month':
        since = now - 30 * 24 * 60 * 60 * 1000;
        break;
    }
    timeRangeFilter = `AND e.created_at >= ${since}`;
  } else if (filterTimeRange === 'custom' && filterStartDate) {
    const startTimestamp = new Date(filterStartDate).getTime();
    if (!isNaN(startTimestamp)) {
      timeRangeFilter = `AND e.created_at >= ${startTimestamp}`;
    }
    if (filterEndDate) {
      const endTimestamp = new Date(filterEndDate).getTime() + 24 * 60 * 60 * 1000 - 1; // End of day
      if (!isNaN(endTimestamp)) {
        timeRangeFilter += ` AND e.created_at <= ${endTimestamp}`;
      }
    }
  }

  // Build WHERE clause for filters
  const userFilter = filterUserId ? `AND e.created_by = ?` : '';
  const typeFilter = filterTypeId ? `AND e.type_id = ?` : '';

  // Build ACL filter based on authentication status
  type AclFilterResult = Awaited<ReturnType<typeof buildAclFilterClause>>;
  let aclFilter: AclFilterResult | null = null;
  let aclFilterClause = '';
  const aclFilterParams: unknown[] = [];

  if (user) {
    // Authenticated user: filter by accessible ACLs
    aclFilter = await buildAclFilterClause(c.env.DB, c.env.KV, user.user_id, 'read', 'e.acl_id');
    if (aclFilter.useFilter) {
      aclFilterClause = `AND ${aclFilter.whereClause}`;
      aclFilterParams.push(...aclFilter.bindings);
    }
  } else {
    // Unauthenticated: only show public resources (NULL acl_id)
    aclFilterClause = 'AND e.acl_id IS NULL';
  }

  // Fetch quick stats
  const statsPromises = [
    c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM entities WHERE is_latest = 1 AND is_deleted = 0'
    )
      .first<{ count: number }>()
      .then(r => r?.count || 0),
    c.env.DB.prepare('SELECT COUNT(*) as count FROM links WHERE is_latest = 1 AND is_deleted = 0')
      .first<{ count: number }>()
      .then(r => r?.count || 0),
    c.env.DB.prepare('SELECT COUNT(*) as count FROM types')
      .first<{ count: number }>()
      .then(r => r?.count || 0),
    c.env.DB.prepare('SELECT COUNT(*) as count FROM users')
      .first<{ count: number }>()
      .then(r => r?.count || 0),
  ];

  const [entityCount, linkCount, typeCount, userCount] = await Promise.all(statsPromises);

  // Fetch users for filter dropdown
  const allUsers = await c.env.DB.prepare(
    'SELECT id, email, display_name FROM users ORDER BY email'
  ).all<{ id: string; email: string; display_name?: string }>();

  // Fetch types for filter dropdown (entity types only)
  const allTypes = await c.env.DB.prepare(
    "SELECT id, name FROM types WHERE category = 'entity' ORDER BY name"
  ).all<{ id: string; name: string }>();

  // Build query for recently created entities with filters
  // Fetch more rows if using per-row filtering to account for filtered items
  const fetchLimit = aclFilter && !aclFilter.useFilter ? 60 : 20;
  const createdQuery = `
    SELECT
      e.id, e.type_id, e.properties, e.version, e.created_at, e.created_by, e.acl_id,
      t.name as type_name,
      u.display_name, u.email
    FROM entities e
    JOIN types t ON e.type_id = t.id
    LEFT JOIN users u ON e.created_by = u.id
    WHERE e.is_latest = 1 AND e.is_deleted = 0 ${aclFilterClause} ${timeRangeFilter} ${userFilter} ${typeFilter}
    ORDER BY e.created_at DESC
    LIMIT ${fetchLimit}
  `;

  const createdParams: unknown[] = [...aclFilterParams];
  if (filterUserId) createdParams.push(filterUserId);
  if (filterTypeId) createdParams.push(filterTypeId);

  const recentEntitiesResult = await c.env.DB.prepare(createdQuery)
    .bind(...createdParams)
    .all<{
      id: string;
      type_id: string;
      properties: string;
      version: number;
      created_at: number;
      created_by: string;
      type_name: string;
      display_name?: string;
      email: string;
      acl_id?: number | null;
    }>();

  // Apply per-row filtering if needed
  let recentEntities = recentEntitiesResult.results;
  if (aclFilter && !aclFilter.useFilter) {
    recentEntities = filterByAclPermission(recentEntities, aclFilter.accessibleAclIds).slice(0, 20);
  }

  // Build query for recently updated entities (version > 1) with filters
  const updatedQuery = `
    SELECT
      e.id, e.type_id, e.properties, e.version, e.created_at, e.created_by, e.acl_id,
      t.name as type_name,
      u.display_name, u.email
    FROM entities e
    JOIN types t ON e.type_id = t.id
    LEFT JOIN users u ON e.created_by = u.id
    WHERE e.is_latest = 1 AND e.is_deleted = 0 AND e.version > 1 ${aclFilterClause} ${timeRangeFilter.replace('created_at', 'created_at')} ${userFilter} ${typeFilter}
    ORDER BY e.created_at DESC
    LIMIT ${fetchLimit}
  `;

  const updatedParams: unknown[] = [...aclFilterParams];
  if (filterUserId) updatedParams.push(filterUserId);
  if (filterTypeId) updatedParams.push(filterTypeId);

  const recentUpdatesResult = await c.env.DB.prepare(updatedQuery)
    .bind(...updatedParams)
    .all<{
      id: string;
      type_id: string;
      properties: string;
      version: number;
      created_at: number;
      created_by: string;
      type_name: string;
      display_name?: string;
      email: string;
      acl_id?: number | null;
    }>();

  // Apply per-row filtering if needed
  let recentUpdates = recentUpdatesResult.results;
  if (aclFilter && !aclFilter.useFilter) {
    recentUpdates = filterByAclPermission(recentUpdates, aclFilter.accessibleAclIds).slice(0, 20);
  }

  // Render filter form
  const filterForm = `
    <div class="card">
      <form method="GET" action="/ui" class="filter-form">
        <div class="form-row">
          <div class="form-group">
            <label for="user_id">User:</label>
            <select id="user_id" name="user_id">
              <option value="">All users</option>
              ${allUsers.results
                .map(
                  u => `
                <option value="${u.id}" ${filterUserId === u.id ? 'selected' : ''}>
                  ${escapeHtml(u.display_name || u.email)}
                </option>
              `
                )
                .join('')}
            </select>
          </div>

          <div class="form-group">
            <label for="type_id">Entity Type:</label>
            <select id="type_id" name="type_id">
              <option value="">All types</option>
              ${allTypes.results
                .map(
                  t => `
                <option value="${t.id}" ${filterTypeId === t.id ? 'selected' : ''}>
                  ${escapeHtml(t.name)}
                </option>
              `
                )
                .join('')}
            </select>
          </div>

          <div class="form-group">
            <label for="time_range">Time Range:</label>
            <select id="time_range" name="time_range" onchange="toggleCustomDates()">
              <option value="all" ${filterTimeRange === 'all' ? 'selected' : ''}>All time</option>
              <option value="hour" ${filterTimeRange === 'hour' ? 'selected' : ''}>Last hour</option>
              <option value="day" ${filterTimeRange === 'day' ? 'selected' : ''}>Last day</option>
              <option value="week" ${filterTimeRange === 'week' ? 'selected' : ''}>Last week</option>
              <option value="month" ${filterTimeRange === 'month' ? 'selected' : ''}>Last month</option>
              <option value="custom" ${filterTimeRange === 'custom' ? 'selected' : ''}>Custom range</option>
            </select>
          </div>
        </div>

        <div class="form-row" id="custom-dates" style="display: ${filterTimeRange === 'custom' ? 'flex' : 'none'}">
          <div class="form-group">
            <label for="start_date">Start Date:</label>
            <input type="date" id="start_date" name="start_date" value="${escapeHtml(filterStartDate)}">
          </div>

          <div class="form-group">
            <label for="end_date">End Date:</label>
            <input type="date" id="end_date" name="end_date" value="${escapeHtml(filterEndDate)}">
          </div>
        </div>

        <div class="button-group">
          <button type="submit" class="button">Apply Filters</button>
          <a href="/ui" class="button secondary">Clear Filters</a>
        </div>
      </form>
    </div>

    <script>
      function toggleCustomDates() {
        const timeRange = document.getElementById('time_range').value;
        const customDates = document.getElementById('custom-dates');
        customDates.style.display = timeRange === 'custom' ? 'flex' : 'none';
      }
    </script>
  `;

  const content = `
    <h2>Dashboard</h2>
    <p>Welcome to Gruff, a graph database with versioning built on Cloudflare Workers and D1.</p>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="value">${entityCount}</div>
        <div class="label">Entities</div>
      </div>
      <div class="stat-card">
        <div class="value">${linkCount}</div>
        <div class="label">Links</div>
      </div>
      <div class="stat-card">
        <div class="value">${typeCount}</div>
        <div class="label">Types</div>
      </div>
      <div class="stat-card">
        <div class="value">${userCount}</div>
        <div class="label">Users</div>
      </div>
    </div>

    <h3>Filters</h3>
    ${filterForm}

    <h3>Recently Created Entities</h3>
    ${
      recentEntities.length > 0
        ? `
      <ul class="entity-list">
        ${recentEntities
          .map(entity => {
            const props = JSON.parse(entity.properties);
            const displayName =
              props.name || props.title || props.label || entity.id.substring(0, 8);

            return `
          <li>
            <div class="entity-title">
              <a href="/ui/entities/${entity.id}">${escapeHtml(displayName)}</a>
              <span class="badge muted">${escapeHtml(entity.type_name)}</span>
            </div>
            <div class="entity-meta">
              Version ${entity.version} |
              Created ${formatTimestamp(entity.created_at)} by ${escapeHtml(entity.display_name || entity.email)}
            </div>
          </li>
        `;
          })
          .join('')}
      </ul>
    `
        : '<p>No entities found matching the filters.</p>'
    }

    <h3>Recently Updated Entities</h3>
    ${
      recentUpdates.length > 0
        ? `
      <ul class="entity-list">
        ${recentUpdates
          .map(entity => {
            const props = JSON.parse(entity.properties);
            const displayName =
              props.name || props.title || props.label || entity.id.substring(0, 8);

            return `
          <li>
            <div class="entity-title">
              <a href="/ui/entities/${entity.id}">${escapeHtml(displayName)}</a>
              <span class="badge muted">${escapeHtml(entity.type_name)}</span>
            </div>
            <div class="entity-meta">
              Version ${entity.version} |
              Updated ${formatTimestamp(entity.created_at)} by ${escapeHtml(entity.display_name || entity.email)}
            </div>
          </li>
        `;
          })
          .join('')}
      </ul>
    `
        : '<p>No recently updated entities found.</p>'
    }

    <div class="button-group">
      <a href="/ui/entities" class="button">Browse All Entities</a>
      <a href="/ui/entities/new" class="button secondary">Create Entity</a>
      <a href="/ui/links/new" class="button secondary">Create Link</a>
      <a href="/ui/types" class="button secondary">Browse Types</a>
    </div>
  `;

  const html = renderPage(
    {
      title: 'Dashboard',
      user,
      activePath: '/ui',
    },
    content
  );

  return c.html(html);
});

/**
 * Entity list view
 * GET /ui/entities
 */
ui.get('/entities', async c => {
  const user = c.get('user');

  // Require authentication for entities browser
  if (!user) {
    return c.redirect('/ui/auth/login?return_to=' + encodeURIComponent('/ui/entities'));
  }

  // Get filter parameters
  const filterUserId = c.req.query('user_id') || '';
  const filterTypeId = c.req.query('type_id') || '';
  const filterTimeRange = c.req.query('time_range') || 'all';
  const filterStartDate = c.req.query('start_date') || '';
  const filterEndDate = c.req.query('end_date') || '';
  const showDeleted = c.req.query('show_deleted') === 'true';
  const showAllVersions = c.req.query('show_all_versions') === 'true';
  const sortBy = c.req.query('sort_by') || 'created_at';
  const sortOrder = c.req.query('sort_order') || 'desc';

  // Get pagination parameters
  const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 100);
  const cursor = c.req.query('cursor') || '';

  // Calculate timestamp for time range filters
  let timeRangeFilter = '';
  const now = Date.now();
  if (filterTimeRange !== 'all' && filterTimeRange !== 'custom') {
    let since = now;
    switch (filterTimeRange) {
      case 'hour':
        since = now - 60 * 60 * 1000;
        break;
      case 'day':
        since = now - 24 * 60 * 60 * 1000;
        break;
      case 'week':
        since = now - 7 * 24 * 60 * 60 * 1000;
        break;
      case 'month':
        since = now - 30 * 24 * 60 * 60 * 1000;
        break;
    }
    timeRangeFilter = `AND e.created_at >= ${since}`;
  } else if (filterTimeRange === 'custom' && filterStartDate) {
    const startTimestamp = new Date(filterStartDate).getTime();
    if (!isNaN(startTimestamp)) {
      timeRangeFilter = `AND e.created_at >= ${startTimestamp}`;
    }
    if (filterEndDate) {
      const endTimestamp = new Date(filterEndDate).getTime() + 24 * 60 * 60 * 1000 - 1; // End of day
      if (!isNaN(endTimestamp)) {
        timeRangeFilter += ` AND e.created_at <= ${endTimestamp}`;
      }
    }
  }

  // Build WHERE clause for filters
  const userFilter = filterUserId ? `AND e.created_by = ?` : '';
  const typeFilter = filterTypeId ? `AND e.type_id = ?` : '';
  const deletedFilter = showDeleted ? '' : 'AND e.is_deleted = 0';
  const versionFilter = showAllVersions ? '' : 'AND e.is_latest = 1';
  const cursorFilter = cursor ? `AND e.created_at < ?` : '';

  // Build ACL filter for authenticated user
  type AclFilterResult = Awaited<ReturnType<typeof buildAclFilterClause>>;
  const aclFilter: AclFilterResult = await buildAclFilterClause(
    c.env.DB,
    c.env.KV,
    user.user_id,
    'read',
    'e.acl_id'
  );
  let aclFilterClause = '';
  const aclFilterParams: unknown[] = [];
  if (aclFilter.useFilter) {
    aclFilterClause = `AND ${aclFilter.whereClause}`;
    aclFilterParams.push(...aclFilter.bindings);
  }

  // Validate sort column to prevent SQL injection
  const allowedSortColumns = ['created_at', 'type_name', 'version'];
  const sortColumn = allowedSortColumns.includes(sortBy) ? sortBy : 'created_at';
  const sortDirection = sortOrder === 'asc' ? 'ASC' : 'DESC';

  // Fetch users for filter dropdown
  const allUsers = await c.env.DB.prepare(
    'SELECT id, email, display_name FROM users ORDER BY email'
  ).all<{ id: string; email: string; display_name?: string }>();

  // Fetch types for filter dropdown (entity types only)
  const allTypes = await c.env.DB.prepare(
    "SELECT id, name FROM types WHERE category = 'entity' ORDER BY name"
  ).all<{ id: string; name: string }>();

  // Build query for entities with filters
  const entitiesQuery = `
    SELECT
      e.id, e.type_id, e.properties, e.version, e.created_at, e.created_by,
      e.is_latest, e.is_deleted, e.previous_version_id, e.acl_id,
      t.name as type_name,
      u.display_name, u.email
    FROM entities e
    JOIN types t ON e.type_id = t.id
    LEFT JOIN users u ON e.created_by = u.id
    WHERE 1=1 ${timeRangeFilter} ${userFilter} ${typeFilter} ${deletedFilter} ${versionFilter} ${cursorFilter} ${aclFilterClause}
    ORDER BY ${sortColumn === 'type_name' ? 't.name' : 'e.' + sortColumn} ${sortDirection}
    LIMIT ?
  `;

  const queryParams: unknown[] = [];
  if (filterUserId) queryParams.push(filterUserId);
  if (filterTypeId) queryParams.push(filterTypeId);
  if (cursor) {
    // Cursor is a timestamp
    queryParams.push(parseInt(cursor, 10));
  }
  queryParams.push(...aclFilterParams);
  queryParams.push(limit + 1); // Fetch one extra to determine if there are more results

  const entitiesResult = await c.env.DB.prepare(entitiesQuery)
    .bind(...queryParams)
    .all<{
      id: string;
      type_id: string;
      properties: string;
      version: number;
      created_at: number;
      created_by: string;
      is_latest: number;
      is_deleted: number;
      previous_version_id: string | null;
      acl_id: number | null;
      type_name: string;
      display_name?: string;
      email: string;
    }>();

  // Apply per-row filtering if ACL filter couldn't be applied in SQL
  let filteredResults = entitiesResult.results;
  if (!aclFilter.useFilter) {
    filteredResults = filterByAclPermission(filteredResults, aclFilter.accessibleAclIds);
  }

  // Determine if there are more results
  const hasMore = filteredResults.length > limit;
  const entities = hasMore ? filteredResults.slice(0, limit) : filteredResults;

  // Calculate next cursor
  let nextCursor = '';
  if (hasMore && entities.length > 0) {
    nextCursor = entities[entities.length - 1].created_at.toString();
  }

  // Build pagination links
  const buildPaginationUrl = (newCursor: string) => {
    const params = new URLSearchParams();
    if (filterUserId) params.set('user_id', filterUserId);
    if (filterTypeId) params.set('type_id', filterTypeId);
    if (filterTimeRange !== 'all') params.set('time_range', filterTimeRange);
    if (filterStartDate) params.set('start_date', filterStartDate);
    if (filterEndDate) params.set('end_date', filterEndDate);
    if (showDeleted) params.set('show_deleted', 'true');
    if (showAllVersions) params.set('show_all_versions', 'true');
    if (sortBy !== 'created_at') params.set('sort_by', sortBy);
    if (sortOrder !== 'desc') params.set('sort_order', sortOrder);
    if (limit !== 20) params.set('limit', limit.toString());
    if (newCursor) params.set('cursor', newCursor);
    return `/ui/entities?${params.toString()}`;
  };

  // Render filter form
  const filterForm = `
    <div class="card">
      <form method="GET" action="/ui/entities" class="filter-form">
        <div class="form-row">
          <div class="form-group">
            <label for="user_id">User:</label>
            <select id="user_id" name="user_id">
              <option value="">All users</option>
              ${allUsers.results
                .map(
                  u => `
                <option value="${u.id}" ${filterUserId === u.id ? 'selected' : ''}>
                  ${escapeHtml(u.display_name || u.email)}
                </option>
              `
                )
                .join('')}
            </select>
          </div>

          <div class="form-group">
            <label for="type_id">Entity Type:</label>
            <select id="type_id" name="type_id">
              <option value="">All types</option>
              ${allTypes.results
                .map(
                  t => `
                <option value="${t.id}" ${filterTypeId === t.id ? 'selected' : ''}>
                  ${escapeHtml(t.name)}
                </option>
              `
                )
                .join('')}
            </select>
          </div>

          <div class="form-group">
            <label for="time_range">Time Range:</label>
            <select id="time_range" name="time_range" onchange="toggleCustomDates()">
              <option value="all" ${filterTimeRange === 'all' ? 'selected' : ''}>All time</option>
              <option value="hour" ${filterTimeRange === 'hour' ? 'selected' : ''}>Last hour</option>
              <option value="day" ${filterTimeRange === 'day' ? 'selected' : ''}>Last day</option>
              <option value="week" ${filterTimeRange === 'week' ? 'selected' : ''}>Last week</option>
              <option value="month" ${filterTimeRange === 'month' ? 'selected' : ''}>Last month</option>
              <option value="custom" ${filterTimeRange === 'custom' ? 'selected' : ''}>Custom range</option>
            </select>
          </div>

          <div class="form-group">
            <label for="sort_by">Sort By:</label>
            <select id="sort_by" name="sort_by">
              <option value="created_at" ${sortBy === 'created_at' ? 'selected' : ''}>Date</option>
              <option value="type_name" ${sortBy === 'type_name' ? 'selected' : ''}>Type</option>
              <option value="version" ${sortBy === 'version' ? 'selected' : ''}>Version</option>
            </select>
          </div>

          <div class="form-group">
            <label for="sort_order">Order:</label>
            <select id="sort_order" name="sort_order">
              <option value="desc" ${sortOrder === 'desc' ? 'selected' : ''}>Newest First</option>
              <option value="asc" ${sortOrder === 'asc' ? 'selected' : ''}>Oldest First</option>
            </select>
          </div>
        </div>

        <div class="form-row" id="custom-dates" style="display: ${filterTimeRange === 'custom' ? 'flex' : 'none'}">
          <div class="form-group">
            <label for="start_date">Start Date:</label>
            <input type="date" id="start_date" name="start_date" value="${escapeHtml(filterStartDate)}">
          </div>

          <div class="form-group">
            <label for="end_date">End Date:</label>
            <input type="date" id="end_date" name="end_date" value="${escapeHtml(filterEndDate)}">
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>
              <input type="checkbox" name="show_deleted" value="true" ${showDeleted ? 'checked' : ''}>
              Show deleted entities
            </label>
          </div>

          <div class="form-group">
            <label>
              <input type="checkbox" name="show_all_versions" value="true" ${showAllVersions ? 'checked' : ''}>
              Show all versions
            </label>
          </div>
        </div>

        <div class="button-group">
          <button type="submit" class="button">Apply Filters</button>
          <a href="/ui/entities" class="button secondary">Clear Filters</a>
        </div>
      </form>
    </div>

    <script>
      function toggleCustomDates() {
        const timeRange = document.getElementById('time_range').value;
        const customDates = document.getElementById('custom-dates');
        customDates.style.display = timeRange === 'custom' ? 'flex' : 'none';
      }
    </script>
  `;

  // Render entities table
  const entitiesTable = `
    <table class="data-table">
      <thead>
        <tr>
          <th>ID</th>
          <th>Type</th>
          <th>Properties</th>
          <th>Version</th>
          <th>Created By</th>
          <th>Created At</th>
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${entities
          .map(entity => {
            const props = JSON.parse(entity.properties);
            const displayName =
              props.name || props.title || props.label || entity.id.substring(0, 8);
            const propsPreview = JSON.stringify(props, null, 2);
            const truncatedPreview =
              propsPreview.length > 100 ? propsPreview.substring(0, 100) + '...' : propsPreview;

            return `
          <tr>
            <td>
              <a href="/ui/entities/${entity.id}">${escapeHtml(displayName)}</a>
              <div class="muted small">${entity.id.substring(0, 8)}...</div>
            </td>
            <td>
              <a href="/ui/entities?type_id=${entity.type_id}" class="badge">${escapeHtml(entity.type_name)}</a>
            </td>
            <td>
              <code class="small">${escapeHtml(truncatedPreview)}</code>
            </td>
            <td>${entity.version}</td>
            <td>
              ${escapeHtml(entity.display_name || entity.email)}
            </td>
            <td>
              ${formatTimestamp(entity.created_at)}
            </td>
            <td>
              ${entity.is_latest ? '<span class="badge success">Latest</span>' : '<span class="badge muted">Old</span>'}
              ${entity.is_deleted ? '<span class="badge danger">Deleted</span>' : ''}
            </td>
            <td>
              <div class="button-group compact">
                <a href="/ui/entities/${entity.id}" class="button small">View</a>
                ${!entity.is_deleted && entity.is_latest ? `<a href="/ui/entities/${entity.id}/edit" class="button small secondary">Edit</a>` : ''}
              </div>
            </td>
          </tr>
        `;
          })
          .join('')}
      </tbody>
    </table>
  `;

  const content = `
    <h2>Entities</h2>
    <p>Browse and filter all entities in the database.</p>

    <h3>Filters</h3>
    ${filterForm}

    <h3>Results</h3>
    <p>Showing ${entities.length} ${entities.length === 1 ? 'entity' : 'entities'}${hasMore ? ' (more available)' : ''}.</p>

    ${entities.length > 0 ? entitiesTable : '<p class="muted">No entities found matching the filters.</p>'}

    ${
      hasMore || cursor
        ? `
      <div class="pagination">
        ${cursor ? `<a href="${buildPaginationUrl('')}" class="button secondary">First Page</a>` : ''}
        ${hasMore ? `<a href="${buildPaginationUrl(nextCursor)}" class="button">Next Page</a>` : ''}
      </div>
    `
        : ''
    }

    <div class="button-group">
      <a href="/ui" class="button secondary">Back to Dashboard</a>
      <a href="/ui/entities/new" class="button">Create Entity</a>
    </div>
  `;

  const html = renderPage(
    {
      title: 'Entities',
      user,
      activePath: '/ui/entities',
      breadcrumbs: [{ label: 'Home', href: '/ui' }, { label: 'Entities' }],
    },
    content
  );

  return c.html(html);
});

/**
 * Create entity form
 * GET /ui/entities/new
 * IMPORTANT: This route must be defined BEFORE /entities/:id to avoid matching "new" as an ID
 */
ui.get('/entities/new', async c => {
  const user = c.get('user');

  // Get optional pre-selected type from query parameter
  const preselectedTypeId = c.req.query('type_id') || '';

  // Fetch all entity types for the dropdown
  const allTypes = await c.env.DB.prepare(
    "SELECT id, name, description, json_schema FROM types WHERE category = 'entity' ORDER BY name"
  ).all<{ id: string; name: string; description: string | null; json_schema: string | null }>();

  // Get any error message and preserved form data from query params (for validation errors)
  const errorMessage = c.req.query('error') || '';
  const preservedTypeId = c.req.query('preserved_type_id') || preselectedTypeId;
  const preservedProperties = c.req.query('preserved_properties') || '{}';

  // Format the preserved properties nicely for display
  let formattedProperties = '{}';
  try {
    const parsed = JSON.parse(preservedProperties);
    formattedProperties = JSON.stringify(parsed, null, 2);
  } catch {
    formattedProperties = preservedProperties;
  }

  // Build the form
  const formHtml = `
    <h2>Create New Entity</h2>

    ${
      errorMessage
        ? `
      <div class="error-message">
        <strong>Error:</strong> ${escapeHtml(decodeURIComponent(errorMessage))}
      </div>
    `
        : ''
    }

    <div class="card">
      <form id="create-entity-form" class="entity-form">
        <div class="form-group">
          <label for="type_id">Entity Type <span class="required">*</span></label>
          <select id="type_id" name="type_id" required onchange="updateSchemaHint()">
            <option value="">Select a type...</option>
            ${allTypes.results
              .map(
                t => `
              <option value="${t.id}"
                      ${preservedTypeId === t.id ? 'selected' : ''}
                      data-schema="${t.json_schema ? escapeHtml(t.json_schema) : ''}"
                      data-description="${t.description ? escapeHtml(t.description) : ''}">
                ${escapeHtml(t.name)}
              </option>
            `
              )
              .join('')}
          </select>
          <div id="type-description" class="form-hint"></div>
        </div>

        <div id="schema-hint" class="schema-hint" style="display: none;">
          <h4>Property Schema</h4>
          <pre><code id="schema-content"></code></pre>
        </div>

        <div class="form-group">
          <label for="properties">Properties (JSON) <span class="required">*</span></label>
          <textarea id="properties" name="properties" rows="15" required
                    placeholder='{"name": "Example", "description": "Enter properties as JSON"}'>${escapeHtml(formattedProperties)}</textarea>
          <div class="form-hint">Enter valid JSON object with the entity properties.</div>
        </div>

        <div id="json-error" class="error-message" style="display: none;"></div>

        <div class="button-group">
          <button type="submit" class="button" id="submit-btn">Create Entity</button>
          <a href="/ui/entities" class="button secondary">Cancel</a>
        </div>
      </form>
    </div>

    <script>
      // Update schema hint when type is selected
      function updateSchemaHint() {
        const select = document.getElementById('type_id');
        const selectedOption = select.options[select.selectedIndex];
        const schema = selectedOption.getAttribute('data-schema');
        const description = selectedOption.getAttribute('data-description');
        const schemaHint = document.getElementById('schema-hint');
        const schemaContent = document.getElementById('schema-content');
        const typeDescription = document.getElementById('type-description');

        if (description) {
          typeDescription.textContent = description;
        } else {
          typeDescription.textContent = '';
        }

        if (schema) {
          try {
            const parsed = JSON.parse(schema);
            schemaContent.textContent = JSON.stringify(parsed, null, 2);
            schemaHint.style.display = 'block';
          } catch {
            schemaHint.style.display = 'none';
          }
        } else {
          schemaHint.style.display = 'none';
        }
      }

      // Validate JSON on input
      document.getElementById('properties').addEventListener('input', function() {
        const errorDiv = document.getElementById('json-error');
        try {
          JSON.parse(this.value);
          errorDiv.style.display = 'none';
          this.style.borderColor = '';
        } catch (e) {
          errorDiv.textContent = 'Invalid JSON: ' + e.message;
          errorDiv.style.display = 'block';
          this.style.borderColor = 'var(--color-error)';
        }
      });

      // Handle form submission
      document.getElementById('create-entity-form').addEventListener('submit', async function(e) {
        e.preventDefault();

        const typeId = document.getElementById('type_id').value.trim();
        const propertiesText = document.getElementById('properties').value;
        const submitBtn = document.getElementById('submit-btn');
        const errorDiv = document.getElementById('json-error');

        // Validate type selection
        if (!typeId) {
          errorDiv.textContent = 'Please select an entity type.';
          errorDiv.style.display = 'block';
          return;
        }

        // Validate JSON
        let properties;
        try {
          properties = JSON.parse(propertiesText);
        } catch (e) {
          errorDiv.textContent = 'Invalid JSON: ' + e.message;
          errorDiv.style.display = 'block';
          return;
        }

        // Disable submit button while processing
        submitBtn.disabled = true;
        submitBtn.textContent = 'Creating...';
        errorDiv.style.display = 'none';

        try {
          const response = await fetch('/api/entities', {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              type_id: typeId,
              properties: properties
            })
          });

          const data = await response.json();

          if (response.ok && data.data && data.data.id) {
            // Success - redirect to the new entity
            window.location.href = '/ui/entities/' + data.data.id;
          } else {
            // Error - show message with details if available
            let errorMessage = data.error || data.message || 'Failed to create entity';
            if (data.details && Array.isArray(data.details)) {
              errorMessage += ': ' + data.details.map(d => d.message || d.path).join(', ');
            }
            errorDiv.textContent = errorMessage;
            errorDiv.style.display = 'block';
            submitBtn.disabled = false;
            submitBtn.textContent = 'Create Entity';
          }
        } catch (err) {
          errorDiv.textContent = 'Network error: ' + err.message;
          errorDiv.style.display = 'block';
          submitBtn.disabled = false;
          submitBtn.textContent = 'Create Entity';
        }
      });

      // Initialize schema hint on page load
      updateSchemaHint();
    </script>

    <style>
      .entity-form .form-group {
        margin-bottom: 1.5rem;
      }

      .entity-form textarea {
        font-family: var(--font-mono);
        font-size: 0.875rem;
      }

      .required {
        color: var(--color-error);
      }

      .form-hint {
        font-size: 0.875rem;
        color: var(--color-secondary);
        margin-top: 0.25rem;
      }

      .schema-hint {
        background-color: var(--color-muted);
        border: 1px solid var(--color-border);
        border-radius: 0.5rem;
        padding: 1rem;
        margin-bottom: 1.5rem;
      }

      .schema-hint h4 {
        margin-top: 0;
        margin-bottom: 0.5rem;
        font-size: 0.875rem;
        color: var(--color-secondary);
      }

      .schema-hint pre {
        margin: 0;
        max-height: 200px;
        overflow-y: auto;
      }
    </style>
  `;

  const html = renderPage(
    {
      title: 'Create Entity',
      user,
      activePath: '/ui/entities',
      breadcrumbs: [
        { label: 'Home', href: '/ui' },
        { label: 'Entities', href: '/ui/entities' },
        { label: 'Create' },
      ],
    },
    formHtml
  );

  return c.html(html);
});

/**
 * Edit entity form
 * GET /ui/entities/:id/edit
 * IMPORTANT: This route must be defined BEFORE /entities/:id to avoid partial matching issues
 */
ui.get('/entities/:id/edit', async c => {
  const user = c.get('user');
  const entityId = c.req.param('id');

  try {
    // Fetch the entity with type information
    const entity = await c.env.DB.prepare(
      `
      SELECT
        e.id, e.type_id, e.properties, e.version, e.created_at, e.created_by,
        e.is_latest, e.is_deleted, e.previous_version_id,
        t.name as type_name, t.description as type_description, t.json_schema as type_json_schema
      FROM entities e
      JOIN types t ON e.type_id = t.id
      WHERE e.id = ? AND e.is_latest = 1
    `
    )
      .bind(entityId)
      .first<{
        id: string;
        type_id: string;
        properties: string;
        version: number;
        created_at: number;
        created_by: string;
        is_latest: number;
        is_deleted: number;
        previous_version_id: string | null;
        type_name: string;
        type_description: string | null;
        type_json_schema: string | null;
      }>();

    if (!entity) {
      const content = `
        <div class="error-message">
          <h2>Entity Not Found</h2>
          <p>The entity with ID "${escapeHtml(entityId)}" could not be found or is not the latest version.</p>
        </div>
        <div class="button-group">
          <a href="/ui/entities" class="button secondary">Back to Entities</a>
        </div>
      `;

      return c.html(
        renderPage(
          {
            title: 'Entity Not Found',
            user,
            activePath: '/ui/entities',
            breadcrumbs: [
              { label: 'Home', href: '/ui' },
              { label: 'Entities', href: '/ui/entities' },
              { label: 'Not Found' },
            ],
          },
          content
        ),
        404
      );
    }

    // Check if entity is deleted
    if (entity.is_deleted) {
      const content = `
        <div class="error-message">
          <h2>Entity Deleted</h2>
          <p>This entity has been deleted. You must restore it before editing.</p>
        </div>
        <div class="button-group">
          <a href="/ui/entities/${escapeHtml(entityId)}" class="button secondary">Back to Entity</a>
        </div>
      `;

      return c.html(
        renderPage(
          {
            title: 'Entity Deleted',
            user,
            activePath: '/ui/entities',
            breadcrumbs: [
              { label: 'Home', href: '/ui' },
              { label: 'Entities', href: '/ui/entities' },
              { label: 'Deleted' },
            ],
          },
          content
        ),
        409
      );
    }

    // Parse the properties
    const props = JSON.parse(entity.properties);
    const displayName = props.name || props.title || props.label || entity.id.substring(0, 8);
    const formattedProperties = JSON.stringify(props, null, 2);

    // Get any error message from query params (for validation errors)
    const errorMessage = c.req.query('error') || '';
    const preservedProperties = c.req.query('preserved_properties') || '';

    // Use preserved properties if available, otherwise use current entity properties
    let displayProperties = formattedProperties;
    if (preservedProperties) {
      try {
        const parsed = JSON.parse(preservedProperties);
        displayProperties = JSON.stringify(parsed, null, 2);
      } catch {
        displayProperties = preservedProperties;
      }
    }

    // Build the form
    const formHtml = `
      <h2>Edit Entity: ${escapeHtml(displayName)}</h2>

      ${
        errorMessage
          ? `
        <div class="error-message">
          <strong>Error:</strong> ${escapeHtml(decodeURIComponent(errorMessage))}
        </div>
      `
          : ''
      }

      <div class="card detail-card">
        <h3>Entity Information</h3>
        <dl class="detail-list">
          <dt>ID</dt>
          <dd><code>${escapeHtml(entity.id)}</code></dd>

          <dt>Type</dt>
          <dd>
            <span class="badge">${escapeHtml(entity.type_name)}</span>
            ${entity.type_description ? `<span class="muted small">${escapeHtml(entity.type_description)}</span>` : ''}
          </dd>

          <dt>Current Version</dt>
          <dd>${entity.version}</dd>
        </dl>
      </div>

      ${
        entity.type_json_schema
          ? `
        <div class="schema-hint">
          <h4>Property Schema</h4>
          <pre><code>${escapeHtml(JSON.stringify(JSON.parse(entity.type_json_schema), null, 2))}</code></pre>
        </div>
      `
          : ''
      }

      <div class="card">
        <form id="edit-entity-form" class="entity-form">
          <div class="form-group">
            <label for="properties">Properties (JSON) <span class="required">*</span></label>
            <textarea id="properties" name="properties" rows="15" required>${escapeHtml(displayProperties)}</textarea>
            <div class="form-hint">Enter valid JSON object with the entity properties. A new version will be created.</div>
          </div>

          <div id="json-error" class="error-message" style="display: none;"></div>

          <div class="button-group">
            <button type="submit" class="button" id="submit-btn">Save Changes (Create Version ${entity.version + 1})</button>
            <a href="/ui/entities/${escapeHtml(entity.id)}" class="button secondary">Cancel</a>
          </div>
        </form>
      </div>

      <script>
        // Validate JSON on input
        document.getElementById('properties').addEventListener('input', function() {
          const errorDiv = document.getElementById('json-error');
          try {
            JSON.parse(this.value);
            errorDiv.style.display = 'none';
            this.style.borderColor = '';
          } catch (e) {
            errorDiv.textContent = 'Invalid JSON: ' + e.message;
            errorDiv.style.display = 'block';
            this.style.borderColor = 'var(--color-error)';
          }
        });

        // Handle form submission
        document.getElementById('edit-entity-form').addEventListener('submit', async function(e) {
          e.preventDefault();

          const propertiesText = document.getElementById('properties').value;
          const submitBtn = document.getElementById('submit-btn');
          const errorDiv = document.getElementById('json-error');

          // Validate JSON
          let properties;
          try {
            properties = JSON.parse(propertiesText);
          } catch (e) {
            errorDiv.textContent = 'Invalid JSON: ' + e.message;
            errorDiv.style.display = 'block';
            return;
          }

          // Disable submit button while processing
          submitBtn.disabled = true;
          submitBtn.textContent = 'Saving...';
          errorDiv.style.display = 'none';

          try {
            const response = await fetch('/api/entities/${escapeHtml(entity.id)}', {
              method: 'PUT',
              credentials: 'include',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                properties: properties
              })
            });

            const data = await response.json();

            if (response.ok && data.data && data.data.id) {
              // Success - redirect to the new version
              window.location.href = '/ui/entities/' + data.data.id;
            } else {
              // Error - show message with details if available
              let errorMessage = data.error || data.message || 'Failed to update entity';
              if (data.details && Array.isArray(data.details)) {
                errorMessage += ': ' + data.details.map(d => d.message || d.path).join(', ');
              }
              errorDiv.textContent = errorMessage;
              errorDiv.style.display = 'block';
              submitBtn.disabled = false;
              submitBtn.textContent = 'Save Changes (Create Version ${entity.version + 1})';
            }
          } catch (err) {
            errorDiv.textContent = 'Network error: ' + err.message;
            errorDiv.style.display = 'block';
            submitBtn.disabled = false;
            submitBtn.textContent = 'Save Changes (Create Version ${entity.version + 1})';
          }
        });
      </script>

      <style>
        .entity-form .form-group {
          margin-bottom: 1.5rem;
        }

        .entity-form textarea {
          font-family: var(--font-mono);
          font-size: 0.875rem;
        }

        .required {
          color: var(--color-error);
        }

        .form-hint {
          font-size: 0.875rem;
          color: var(--color-secondary);
          margin-top: 0.25rem;
        }

        .schema-hint {
          background-color: var(--color-muted);
          border: 1px solid var(--color-border);
          border-radius: 0.5rem;
          padding: 1rem;
          margin-bottom: 1.5rem;
        }

        .schema-hint h4 {
          margin-top: 0;
          margin-bottom: 0.5rem;
          font-size: 0.875rem;
          color: var(--color-secondary);
        }

        .schema-hint pre {
          margin: 0;
          max-height: 200px;
          overflow-y: auto;
        }
      </style>
    `;

    const html = renderPage(
      {
        title: `Edit ${displayName}`,
        user,
        activePath: '/ui/entities',
        breadcrumbs: [
          { label: 'Home', href: '/ui' },
          { label: 'Entities', href: '/ui/entities' },
          { label: displayName, href: `/ui/entities/${entity.id}` },
          { label: 'Edit' },
        ],
      },
      formHtml
    );

    return c.html(html);
  } catch (error) {
    console.error('Error fetching entity for edit:', error);
    const content = `
      <div class="error-message">
        <h2>Error</h2>
        <p>An error occurred while fetching the entity. Please try again later.</p>
      </div>
      <div class="button-group">
        <a href="/ui/entities" class="button secondary">Back to Entities</a>
      </div>
    `;

    return c.html(
      renderPage(
        {
          title: 'Error',
          user,
          activePath: '/ui/entities',
          breadcrumbs: [
            { label: 'Home', href: '/ui' },
            { label: 'Entities', href: '/ui/entities' },
            { label: 'Error' },
          ],
        },
        content
      ),
      500
    );
  }
});

/**
 * Entity detail view
 * GET /ui/entities/:id
 */
ui.get('/entities/:id', async c => {
  const user = c.get('user');
  const entityId = c.req.param('id');

  try {
    // Fetch the entity with type information
    const entity = await c.env.DB.prepare(
      `
      SELECT
        e.id, e.type_id, e.properties, e.version, e.created_at, e.created_by,
        e.is_latest, e.is_deleted, e.previous_version_id, e.acl_id,
        t.name as type_name, t.description as type_description, t.json_schema as type_json_schema,
        u.display_name as created_by_name, u.email as created_by_email
      FROM entities e
      JOIN types t ON e.type_id = t.id
      LEFT JOIN users u ON e.created_by = u.id
      WHERE e.id = ?
    `
    )
      .bind(entityId)
      .first<{
        id: string;
        type_id: string;
        properties: string;
        version: number;
        created_at: number;
        created_by: string;
        is_latest: number;
        is_deleted: number;
        previous_version_id: string | null;
        acl_id: number | null;
        type_name: string;
        type_description: string | null;
        type_json_schema: string | null;
        created_by_name: string | null;
        created_by_email: string;
      }>();

    if (!entity) {
      const content = `
        <div class="error-message">
          <h2>Entity Not Found</h2>
          <p>The entity with ID "${escapeHtml(entityId)}" could not be found.</p>
        </div>
        <div class="button-group">
          <a href="/ui/entities" class="button secondary">Back to Entities</a>
        </div>
      `;

      return c.html(
        renderPage(
          {
            title: 'Entity Not Found',
            user,
            activePath: '/ui/entities',
            breadcrumbs: [
              { label: 'Home', href: '/ui' },
              { label: 'Entities', href: '/ui/entities' },
              { label: 'Not Found' },
            ],
          },
          content
        ),
        404
      );
    }

    // Check ACL permission
    // Authenticated users must have read permission
    // Unauthenticated users can only access public entities (NULL acl_id)
    if (user) {
      const canRead = await hasPermissionByAclId(
        c.env.DB,
        c.env.KV,
        user.user_id,
        entity.acl_id,
        'read'
      );
      if (!canRead) {
        const content = `
          <div class="error-message">
            <h2>Access Denied</h2>
            <p>You do not have permission to view this entity.</p>
          </div>
          <div class="button-group">
            <a href="/ui/entities" class="button secondary">Back to Entities</a>
          </div>
        `;

        return c.html(
          renderPage(
            {
              title: 'Access Denied',
              user,
              activePath: '/ui/entities',
              breadcrumbs: [
                { label: 'Home', href: '/ui' },
                { label: 'Entities', href: '/ui/entities' },
                { label: 'Access Denied' },
              ],
            },
            content
          ),
          403
        );
      }
    } else {
      // Unauthenticated: only allow access to public entities (NULL acl_id)
      if (entity.acl_id !== null) {
        const content = `
          <div class="error-message">
            <h2>Authentication Required</h2>
            <p>Please log in to view this entity.</p>
          </div>
          <div class="button-group">
            <a href="/ui/auth/login?returnUrl=${encodeURIComponent(`/ui/entities/${entityId}`)}" class="button">Log In</a>
            <a href="/ui/entities" class="button secondary">Back to Entities</a>
          </div>
        `;

        return c.html(
          renderPage(
            {
              title: 'Authentication Required',
              user,
              activePath: '/ui/entities',
              breadcrumbs: [
                { label: 'Home', href: '/ui' },
                { label: 'Entities', href: '/ui/entities' },
                { label: 'Authentication Required' },
              ],
            },
            content
          ),
          403
        );
      }
    }

    // Parse the properties
    const props = JSON.parse(entity.properties);
    const displayName = props.name || props.title || props.label || entity.id.substring(0, 8);

    // Check if viewing an old version and find latest version ID if so
    let latestVersionId: string | null = null;
    if (!entity.is_latest) {
      const latest = await c.env.DB.prepare(
        `
        WITH RECURSIVE version_chain AS (
          SELECT id, is_latest FROM entities WHERE id = ?
          UNION ALL
          SELECT e.id, e.is_latest FROM entities e
          INNER JOIN version_chain vc ON e.previous_version_id = vc.id
        )
        SELECT id FROM version_chain WHERE is_latest = 1 LIMIT 1
      `
      )
        .bind(entityId)
        .first<{ id: string }>();
      latestVersionId = latest?.id || null;
    }

    // Build ACL filters for links and related entities
    type AclFilterResult = Awaited<ReturnType<typeof buildAclFilterClause>>;
    let linkAclFilter: AclFilterResult | null = null;
    let targetEntityAclFilter: AclFilterResult | null = null;
    let sourceEntityAclFilter: AclFilterResult | null = null;

    if (user) {
      // Build ACL filters for authenticated users
      linkAclFilter = await buildAclFilterClause(
        c.env.DB,
        c.env.KV,
        user.user_id,
        'read',
        'l.acl_id'
      );
      targetEntityAclFilter = await buildAclFilterClause(
        c.env.DB,
        c.env.KV,
        user.user_id,
        'read',
        'e.acl_id'
      );
      sourceEntityAclFilter = await buildAclFilterClause(
        c.env.DB,
        c.env.KV,
        user.user_id,
        'read',
        'e.acl_id'
      );
    }

    // Fetch outbound links (where this entity is the source) with ACL filtering
    let outboundSql = `
      SELECT
        l.id, l.type_id, l.target_entity_id, l.properties, l.version, l.created_at,
        l.is_deleted, l.acl_id,
        t.name as link_type_name,
        e.properties as target_properties, e.acl_id as target_acl_id,
        et.name as target_type_name
      FROM links l
      JOIN types t ON l.type_id = t.id
      JOIN entities e ON l.target_entity_id = e.id
      JOIN types et ON e.type_id = et.id
      WHERE l.source_entity_id = ?
        AND l.is_latest = 1 AND l.is_deleted = 0
        AND e.is_latest = 1 AND e.is_deleted = 0
    `;
    const outboundBindings: unknown[] = [entityId];

    // Apply ACL filtering based on authentication status
    if (user) {
      if (linkAclFilter && linkAclFilter.useFilter) {
        outboundSql += ` AND ${linkAclFilter.whereClause}`;
        outboundBindings.push(...linkAclFilter.bindings);
      }
      if (targetEntityAclFilter && targetEntityAclFilter.useFilter) {
        outboundSql += ` AND ${targetEntityAclFilter.whereClause}`;
        outboundBindings.push(...targetEntityAclFilter.bindings);
      }
    } else {
      // Unauthenticated: only show public links and target entities
      outboundSql += ' AND l.acl_id IS NULL AND e.acl_id IS NULL';
    }

    outboundSql += ' ORDER BY l.created_at DESC';

    const outboundLinksResult = await c.env.DB.prepare(outboundSql)
      .bind(...outboundBindings)
      .all<{
        id: string;
        type_id: string;
        target_entity_id: string;
        properties: string;
        version: number;
        created_at: number;
        is_deleted: number;
        acl_id: number | null;
        link_type_name: string;
        target_properties: string;
        target_acl_id: number | null;
        target_type_name: string;
      }>();

    // Apply per-row ACL filtering if needed
    let outboundLinks = outboundLinksResult.results;
    if (user) {
      if (linkAclFilter && !linkAclFilter.useFilter) {
        outboundLinks = filterByAclPermission(outboundLinks, linkAclFilter.accessibleAclIds);
      }
      if (targetEntityAclFilter && !targetEntityAclFilter.useFilter) {
        outboundLinks = outboundLinks.filter(item => {
          if (item.target_acl_id === null || item.target_acl_id === undefined) {
            return true;
          }
          return targetEntityAclFilter!.accessibleAclIds.has(item.target_acl_id);
        });
      }
    }

    // Fetch inbound links (where this entity is the target) with ACL filtering
    let inboundSql = `
      SELECT
        l.id, l.type_id, l.source_entity_id, l.properties, l.version, l.created_at,
        l.is_deleted, l.acl_id,
        t.name as link_type_name,
        e.properties as source_properties, e.acl_id as source_acl_id,
        et.name as source_type_name
      FROM links l
      JOIN types t ON l.type_id = t.id
      JOIN entities e ON l.source_entity_id = e.id
      JOIN types et ON e.type_id = et.id
      WHERE l.target_entity_id = ?
        AND l.is_latest = 1 AND l.is_deleted = 0
        AND e.is_latest = 1 AND e.is_deleted = 0
    `;
    const inboundBindings: unknown[] = [entityId];

    // Apply ACL filtering based on authentication status
    if (user) {
      if (linkAclFilter && linkAclFilter.useFilter) {
        inboundSql += ` AND ${linkAclFilter.whereClause}`;
        inboundBindings.push(...linkAclFilter.bindings);
      }
      if (sourceEntityAclFilter && sourceEntityAclFilter.useFilter) {
        inboundSql += ` AND ${sourceEntityAclFilter.whereClause}`;
        inboundBindings.push(...sourceEntityAclFilter.bindings);
      }
    } else {
      // Unauthenticated: only show public links and source entities
      inboundSql += ' AND l.acl_id IS NULL AND e.acl_id IS NULL';
    }

    inboundSql += ' ORDER BY l.created_at DESC';

    const inboundLinksResult = await c.env.DB.prepare(inboundSql)
      .bind(...inboundBindings)
      .all<{
        id: string;
        type_id: string;
        source_entity_id: string;
        properties: string;
        version: number;
        created_at: number;
        is_deleted: number;
        acl_id: number | null;
        link_type_name: string;
        source_properties: string;
        source_acl_id: number | null;
        source_type_name: string;
      }>();

    // Apply per-row ACL filtering if needed
    let inboundLinks = inboundLinksResult.results;
    if (user) {
      if (linkAclFilter && !linkAclFilter.useFilter) {
        inboundLinks = filterByAclPermission(inboundLinks, linkAclFilter.accessibleAclIds);
      }
      if (sourceEntityAclFilter && !sourceEntityAclFilter.useFilter) {
        inboundLinks = inboundLinks.filter(item => {
          if (item.source_acl_id === null || item.source_acl_id === undefined) {
            return true;
          }
          return sourceEntityAclFilter!.accessibleAclIds.has(item.source_acl_id);
        });
      }
    }

    // Fetch version history (all versions of this entity chain)
    const versionHistory = await c.env.DB.prepare(
      `
      WITH RECURSIVE version_chain_back AS (
        SELECT id, type_id, properties, version, created_at, created_by, is_latest, is_deleted, previous_version_id
        FROM entities WHERE id = ?
        UNION ALL
        SELECT e.id, e.type_id, e.properties, e.version, e.created_at, e.created_by, e.is_latest, e.is_deleted, e.previous_version_id
        FROM entities e
        INNER JOIN version_chain_back vc ON e.id = vc.previous_version_id
      ),
      version_chain_forward AS (
        SELECT id, type_id, properties, version, created_at, created_by, is_latest, is_deleted, previous_version_id
        FROM entities WHERE id = ?
        UNION ALL
        SELECT e.id, e.type_id, e.properties, e.version, e.created_at, e.created_by, e.is_latest, e.is_deleted, e.previous_version_id
        FROM entities e
        INNER JOIN version_chain_forward vc ON e.previous_version_id = vc.id
      )
      SELECT DISTINCT v.*, u.display_name as created_by_name, u.email as created_by_email
      FROM (
        SELECT * FROM version_chain_back
        UNION
        SELECT * FROM version_chain_forward
      ) v
      LEFT JOIN users u ON v.created_by = u.id
      ORDER BY v.version DESC
    `
    )
      .bind(entityId, entityId)
      .all<{
        id: string;
        type_id: string;
        properties: string;
        version: number;
        created_at: number;
        created_by: string;
        is_latest: number;
        is_deleted: number;
        previous_version_id: string | null;
        created_by_name: string | null;
        created_by_email: string;
      }>();

    // Fetch ACL data for the entity (only for latest version)
    let aclEntries: EnrichedAclEntry[] = [];
    let aclId: number | null = null;
    if (entity.is_latest) {
      aclId = await getEntityAclId(c.env.DB, entity.id);
      if (aclId !== null) {
        aclEntries = await getEnrichedAclEntries(c.env.DB, aclId);
      }
    }

    // Build entity info section
    const entityInfoSection = `
      <div class="card detail-card">
        <h3>Entity Information</h3>
        <dl class="detail-list">
          <dt>ID</dt>
          <dd><code>${escapeHtml(entity.id)}</code></dd>

          <dt>Type</dt>
          <dd>
            <a href="/ui/entities?type_id=${entity.type_id}" class="badge">${escapeHtml(entity.type_name)}</a>
            ${entity.type_description ? `<span class="muted small">${escapeHtml(entity.type_description)}</span>` : ''}
          </dd>

          <dt>Version</dt>
          <dd>${entity.version}${entity.previous_version_id ? ` <span class="muted">(previous: <a href="/ui/entities/${entity.previous_version_id}">${entity.previous_version_id.substring(0, 8)}...</a>)</span>` : ''}</dd>

          <dt>Created By</dt>
          <dd>${escapeHtml(entity.created_by_name || entity.created_by_email)}</dd>

          <dt>Created At</dt>
          <dd>${formatTimestamp(entity.created_at)}</dd>

          <dt>Status</dt>
          <dd>
            ${entity.is_latest ? '<span class="badge success">Latest</span>' : '<span class="badge muted">Old Version</span>'}
            ${entity.is_deleted ? '<span class="badge danger">Deleted</span>' : ''}
          </dd>
        </dl>
      </div>
    `;

    // Build properties section
    const propertiesSection = `
      <div class="card">
        <h3>Properties</h3>
        ${entity.type_json_schema ? '<p class="muted small">This type has JSON schema validation. <a href="/ui/types">View type details</a></p>' : ''}
        <pre><code>${escapeHtml(JSON.stringify(props, null, 2))}</code></pre>
      </div>
    `;

    // Build ACL section (only for latest version)
    const aclSection = entity.is_latest
      ? `
      <div class="card" id="acl-section">
        <h3>Access Control</h3>
        ${
          aclId === null
            ? `
          <p class="muted">This entity is <strong>public</strong> - accessible to all authenticated users.</p>
        `
            : `
          <table class="data-table">
            <thead>
              <tr>
                <th>Principal</th>
                <th>Type</th>
                <th>Permission</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${aclEntries
                .map(
                  entry => `
                <tr data-principal-type="${escapeHtml(entry.principal_type)}" data-principal-id="${escapeHtml(entry.principal_id)}" data-permission="${escapeHtml(entry.permission)}">
                  <td>
                    ${entry.principal_type === 'user' ? `<span>${escapeHtml(entry.principal_name || entry.principal_id)}</span>${entry.principal_email ? ` <span class="muted small">(${escapeHtml(entry.principal_email)})</span>` : ''}` : `<span>${escapeHtml(entry.principal_name || entry.principal_id)}</span> <span class="muted small">(group)</span>`}
                  </td>
                  <td><span class="badge ${entry.principal_type === 'user' ? '' : 'muted'}">${escapeHtml(entry.principal_type)}</span></td>
                  <td><span class="badge ${entry.permission === 'write' ? 'success' : ''}">${escapeHtml(entry.permission)}</span></td>
                  <td>
                    <button class="button small danger" onclick="removeAclEntry('${escapeHtml(entry.principal_type)}', '${escapeHtml(entry.principal_id)}', '${escapeHtml(entry.permission)}')">Remove</button>
                  </td>
                </tr>
              `
                )
                .join('')}
            </tbody>
          </table>
        `
        }

        <div class="acl-form" style="margin-top: 1rem;">
          <h4>Add Permission</h4>
          <form id="add-acl-form" onsubmit="addAclEntry(event)" style="display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: end;">
            <div style="flex: 0 0 auto;">
              <label for="principal-type" class="small">Type</label>
              <select id="principal-type" name="principal_type" required onchange="updatePrincipalSearch()">
                <option value="user">User</option>
                <option value="group">Group</option>
              </select>
            </div>
            <div style="flex: 1 1 200px; position: relative;">
              <label for="principal-search" class="small">Principal</label>
              <input type="text" id="principal-search" placeholder="Search users or groups..." autocomplete="off" required />
              <input type="hidden" id="principal-id" name="principal_id" required />
              <div id="principal-suggestions" class="autocomplete-dropdown" style="display: none;"></div>
            </div>
            <div style="flex: 0 0 auto;">
              <label for="permission" class="small">Permission</label>
              <select id="permission" name="permission" required>
                <option value="read">Read</option>
                <option value="write">Write</option>
              </select>
            </div>
            <div style="flex: 0 0 auto;">
              <button type="submit" class="button">Add</button>
            </div>
          </form>
        </div>

        <div class="button-group" style="margin-top: 1rem;">
          ${aclId !== null ? '<button class="button secondary" onclick="makePublic()">Make Public</button>' : ''}
          ${aclId === null ? '<button class="button secondary" onclick="makePrivate()">Make Private (Owner Only)</button>' : ''}
        </div>

        <style>
          .acl-form label {
            display: block;
            margin-bottom: 0.25rem;
            color: var(--color-secondary);
          }
          .acl-form select, .acl-form input[type="text"] {
            padding: 0.5rem;
            border: 1px solid var(--color-border);
            border-radius: 0.25rem;
            background-color: var(--color-bg);
            color: var(--color-fg);
          }
          .autocomplete-dropdown {
            position: absolute;
            top: 100%;
            left: 0;
            right: 0;
            background-color: var(--color-bg);
            border: 1px solid var(--color-border);
            border-radius: 0.25rem;
            max-height: 200px;
            overflow-y: auto;
            z-index: 100;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
          }
          .autocomplete-item {
            padding: 0.5rem;
            cursor: pointer;
          }
          .autocomplete-item:hover {
            background-color: var(--color-muted);
          }
          .autocomplete-item .principal-name {
            font-weight: 500;
          }
          .autocomplete-item .principal-email {
            color: var(--color-secondary);
            font-size: 0.875rem;
          }
        </style>

        <script>
          const entityId = '${escapeHtml(entity.id)}';
          let currentAclEntries = ${JSON.stringify(aclEntries.map(e => ({ principal_type: e.principal_type, principal_id: e.principal_id, permission: e.permission })))};
          let searchTimeout = null;

          function updatePrincipalSearch() {
            document.getElementById('principal-search').value = '';
            document.getElementById('principal-id').value = '';
            document.getElementById('principal-suggestions').style.display = 'none';
          }

          document.getElementById('principal-search').addEventListener('input', function(e) {
            const query = e.target.value;
            const principalType = document.getElementById('principal-type').value;

            if (query.length < 2) {
              document.getElementById('principal-suggestions').style.display = 'none';
              return;
            }

            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => searchPrincipals(query, principalType), 300);
          });

          async function searchPrincipals(query, type) {
            const suggestionsDiv = document.getElementById('principal-suggestions');
            try {
              const endpoint = type === 'user'
                ? '/api/users/search?q=' + encodeURIComponent(query)
                : '/api/groups?q=' + encodeURIComponent(query);
              const response = await fetch(endpoint, { credentials: 'include' });
              const result = await response.json();

              if (!result.data) {
                suggestionsDiv.style.display = 'none';
                return;
              }

              const items = type === 'user' ? result.data : result.data.groups || result.data;
              // For users, the search is already done server-side. For groups, filter client-side.
              const filtered = type === 'user' ? items.slice(0, 10) : items.filter(item => {
                const searchLower = query.toLowerCase();
                return item.name && item.name.toLowerCase().includes(searchLower);
              }).slice(0, 10);

              if (filtered.length === 0) {
                suggestionsDiv.innerHTML = '<div class="autocomplete-item muted">No results found</div>';
                suggestionsDiv.style.display = 'block';
                return;
              }

              suggestionsDiv.innerHTML = filtered.map(item => {
                if (type === 'user') {
                  return \`<div class="autocomplete-item" onclick="selectPrincipal('\${item.id}', '\${escapeHtmlJs(item.display_name || item.email)}')">
                    <div class="principal-name">\${escapeHtmlJs(item.display_name || item.email)}</div>
                    \${item.display_name ? \`<div class="principal-email">\${escapeHtmlJs(item.email)}</div>\` : ''}
                  </div>\`;
                } else {
                  return \`<div class="autocomplete-item" onclick="selectPrincipal('\${item.id}', '\${escapeHtmlJs(item.name)}')">
                    <div class="principal-name">\${escapeHtmlJs(item.name)}</div>
                    \${item.description ? \`<div class="principal-email">\${escapeHtmlJs(item.description)}</div>\` : ''}
                  </div>\`;
                }
              }).join('');
              suggestionsDiv.style.display = 'block';
            } catch (err) {
              console.error('Error searching principals:', err);
              suggestionsDiv.style.display = 'none';
            }
          }

          function escapeHtmlJs(str) {
            if (!str) return '';
            return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
          }

          function selectPrincipal(id, name) {
            document.getElementById('principal-id').value = id;
            document.getElementById('principal-search').value = name;
            document.getElementById('principal-suggestions').style.display = 'none';
          }

          // Close suggestions when clicking outside
          document.addEventListener('click', function(e) {
            if (!e.target.closest('#add-acl-form')) {
              document.getElementById('principal-suggestions').style.display = 'none';
            }
          });

          async function addAclEntry(event) {
            event.preventDefault();
            const principalType = document.getElementById('principal-type').value;
            const principalId = document.getElementById('principal-id').value;
            const permission = document.getElementById('permission').value;

            if (!principalId) {
              alert('Please select a principal from the search results.');
              return;
            }

            // Check if entry already exists
            const exists = currentAclEntries.some(e =>
              e.principal_type === principalType &&
              e.principal_id === principalId &&
              e.permission === permission
            );

            if (exists) {
              alert('This permission already exists.');
              return;
            }

            // Add new entry to current entries
            const newEntries = [...currentAclEntries, { principal_type: principalType, principal_id: principalId, permission: permission }];

            try {
              const response = await fetch('/api/entities/' + entityId + '/acl', {
                method: 'PUT',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entries: newEntries })
              });

              if (response.ok) {
                const result = await response.json();
                if (result.data && result.data.new_version_id) {
                  window.location.href = '/ui/entities/' + result.data.new_version_id;
                } else {
                  window.location.reload();
                }
              } else {
                const result = await response.json();
                alert('Error: ' + (result.error || 'Failed to add permission'));
              }
            } catch (err) {
              alert('Error: ' + err.message);
            }
          }

          async function removeAclEntry(principalType, principalId, permission) {
            if (!confirm('Are you sure you want to remove this permission?')) return;

            const newEntries = currentAclEntries.filter(e =>
              !(e.principal_type === principalType && e.principal_id === principalId && e.permission === permission)
            );

            try {
              const response = await fetch('/api/entities/' + entityId + '/acl', {
                method: 'PUT',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entries: newEntries })
              });

              if (response.ok) {
                const result = await response.json();
                if (result.data && result.data.new_version_id) {
                  window.location.href = '/ui/entities/' + result.data.new_version_id;
                } else {
                  window.location.reload();
                }
              } else {
                const result = await response.json();
                alert('Error: ' + (result.error || 'Failed to remove permission'));
              }
            } catch (err) {
              alert('Error: ' + err.message);
            }
          }

          async function makePublic() {
            if (!confirm('Are you sure you want to make this entity public? All authenticated users will be able to access it.')) return;

            try {
              const response = await fetch('/api/entities/' + entityId + '/acl', {
                method: 'PUT',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entries: [] })
              });

              if (response.ok) {
                const result = await response.json();
                if (result.data && result.data.new_version_id) {
                  window.location.href = '/ui/entities/' + result.data.new_version_id;
                } else {
                  window.location.reload();
                }
              } else {
                const result = await response.json();
                alert('Error: ' + (result.error || 'Failed to make entity public'));
              }
            } catch (err) {
              alert('Error: ' + err.message);
            }
          }

          async function makePrivate() {
            // Get the current user's ID from the page context or fetch it
            try {
              const meResponse = await fetch('/api/auth/me', { credentials: 'include' });
              if (!meResponse.ok) {
                alert('Please log in to set permissions.');
                return;
              }
              const meResult = await meResponse.json();
              const userId = meResult.data?.id;

              if (!userId) {
                alert('Could not determine current user.');
                return;
              }

              if (!confirm('Are you sure you want to make this entity private? Only you will have access.')) return;

              const response = await fetch('/api/entities/' + entityId + '/acl', {
                method: 'PUT',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  entries: [{ principal_type: 'user', principal_id: userId, permission: 'write' }]
                })
              });

              if (response.ok) {
                const result = await response.json();
                if (result.data && result.data.new_version_id) {
                  window.location.href = '/ui/entities/' + result.data.new_version_id;
                } else {
                  window.location.reload();
                }
              } else {
                const result = await response.json();
                alert('Error: ' + (result.error || 'Failed to make entity private'));
              }
            } catch (err) {
              alert('Error: ' + err.message);
            }
          }
        </script>
      </div>
    `
      : '';

    // Build outbound links section
    const outboundLinksSection = `
      <div class="card">
        <h3>Outgoing Links (${outboundLinks.length})</h3>
        ${
          outboundLinks.length > 0
            ? `
          <table class="data-table">
            <thead>
              <tr>
                <th>Link ID</th>
                <th>Link Type</th>
                <th>Target Entity</th>
                <th>Properties</th>
                <th>Created At</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${outboundLinks
                .map(link => {
                  const targetProps = JSON.parse(link.target_properties);
                  const targetDisplayName =
                    targetProps.name ||
                    targetProps.title ||
                    targetProps.label ||
                    link.target_entity_id.substring(0, 8);
                  const linkProps = JSON.parse(link.properties);
                  const linkPropsPreview = JSON.stringify(linkProps);
                  const truncatedLinkProps =
                    linkPropsPreview.length > 50
                      ? linkPropsPreview.substring(0, 50) + '...'
                      : linkPropsPreview;

                  return `
                  <tr>
                    <td><a href="/ui/links/${link.id}">${link.id.substring(0, 8)}...</a></td>
                    <td><span class="badge muted">${escapeHtml(link.link_type_name)}</span></td>
                    <td>
                      <a href="/ui/entities/${link.target_entity_id}">${escapeHtml(targetDisplayName)}</a>
                      <span class="muted small">(${escapeHtml(link.target_type_name)})</span>
                    </td>
                    <td><code class="small">${escapeHtml(truncatedLinkProps)}</code></td>
                    <td>${formatTimestamp(link.created_at)}</td>
                    <td>
                      <div class="button-group compact">
                        <a href="/ui/links/${link.id}" class="button small">View</a>
                        <a href="/ui/links/${link.id}/edit" class="button small secondary">Edit</a>
                      </div>
                    </td>
                  </tr>
                `;
                })
                .join('')}
            </tbody>
          </table>
        `
            : '<p class="muted">No outgoing links from this entity.</p>'
        }
        <div class="button-group">
          <a href="/ui/links/new?source=${entity.id}" class="button secondary">Create Link from This Entity</a>
        </div>
      </div>
    `;

    // Build inbound links section
    const inboundLinksSection = `
      <div class="card">
        <h3>Incoming Links (${inboundLinks.length})</h3>
        ${
          inboundLinks.length > 0
            ? `
          <table class="data-table">
            <thead>
              <tr>
                <th>Link ID</th>
                <th>Link Type</th>
                <th>Source Entity</th>
                <th>Properties</th>
                <th>Created At</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${inboundLinks
                .map(link => {
                  const sourceProps = JSON.parse(link.source_properties);
                  const sourceDisplayName =
                    sourceProps.name ||
                    sourceProps.title ||
                    sourceProps.label ||
                    link.source_entity_id.substring(0, 8);
                  const linkProps = JSON.parse(link.properties);
                  const linkPropsPreview = JSON.stringify(linkProps);
                  const truncatedLinkProps =
                    linkPropsPreview.length > 50
                      ? linkPropsPreview.substring(0, 50) + '...'
                      : linkPropsPreview;

                  return `
                  <tr>
                    <td><a href="/ui/links/${link.id}">${link.id.substring(0, 8)}...</a></td>
                    <td><span class="badge muted">${escapeHtml(link.link_type_name)}</span></td>
                    <td>
                      <a href="/ui/entities/${link.source_entity_id}">${escapeHtml(sourceDisplayName)}</a>
                      <span class="muted small">(${escapeHtml(link.source_type_name)})</span>
                    </td>
                    <td><code class="small">${escapeHtml(truncatedLinkProps)}</code></td>
                    <td>${formatTimestamp(link.created_at)}</td>
                    <td>
                      <div class="button-group compact">
                        <a href="/ui/links/${link.id}" class="button small">View</a>
                        <a href="/ui/links/${link.id}/edit" class="button small secondary">Edit</a>
                      </div>
                    </td>
                  </tr>
                `;
                })
                .join('')}
            </tbody>
          </table>
        `
            : '<p class="muted">No incoming links to this entity.</p>'
        }
      </div>
    `;

    // Build version history section with compare links
    const latestVer = versionHistory.results.find(v => v.is_latest === 1);
    const latestVersionNum = latestVer?.version || versionHistory.results[0]?.version || 1;
    const versionHistorySection = `
      <div class="card">
        <h3>Version History (${versionHistory.results.length} versions)</h3>
        <div class="version-timeline">
          ${versionHistory.results
            .map((version, index) => {
              const isCurrentView = version.id === entityId;
              const changePreview = getChangePreview(version, versionHistory.results);
              // Show compare link if there's a previous version
              const prevVersion = versionHistory.results[index + 1];
              const compareLink =
                prevVersion && versionHistory.results.length > 1
                  ? `<a href="/ui/entities/${entityId}/versions/${prevVersion.version}/compare/${version.version}" class="button small secondary" style="margin-left: 0.5rem;">Compare with v${prevVersion.version}</a>`
                  : '';

              return `
              <div class="version-item ${isCurrentView ? 'current' : ''}">
                <div class="version-header">
                  <span class="version-number">
                    ${isCurrentView ? `<strong>Version ${version.version}</strong> (viewing)` : `<a href="/ui/entities/${version.id}">Version ${version.version}</a>`}
                  </span>
                  ${version.is_latest ? '<span class="badge success small">Latest</span>' : ''}
                  ${version.is_deleted ? '<span class="badge danger small">Deleted</span>' : ''}
                  ${compareLink}
                </div>
                <div class="version-meta">
                  Modified by ${escapeHtml(version.created_by_name || version.created_by_email)} on ${formatTimestamp(version.created_at)}
                </div>
                ${changePreview ? `<div class="version-changes">${changePreview}</div>` : ''}
              </div>
            `;
            })
            .join('')}
        </div>
        <div class="button-group">
          <a href="/ui/entities/${entityId}/versions" class="button secondary">View Full History</a>
          ${versionHistory.results.length >= 2 ? `<a href="/ui/entities/${entityId}/versions/1/compare/${latestVersionNum}" class="button secondary">Compare First to Latest</a>` : ''}
        </div>
      </div>
    `;

    // Build actions section
    const actionsSection = `
      <div class="card">
        <h3>Actions</h3>
        <div class="button-group">
          ${!entity.is_deleted && entity.is_latest ? `<a href="/ui/entities/${entity.id}/edit" class="button">Edit Entity</a>` : ''}
          ${!entity.is_deleted && entity.is_latest ? `<button class="button danger" onclick="confirmDelete('${entity.id}')">Delete Entity</button>` : ''}
          ${entity.is_deleted && entity.is_latest ? `<button class="button" onclick="confirmRestore('${entity.id}')">Restore Entity</button>` : ''}
          <a href="/ui/links/new?source=${entity.id}" class="button secondary">Create Link from This Entity</a>
          <a href="/api/entities/${entity.id}" class="button secondary" target="_blank">Export as JSON</a>
        </div>
      </div>

      <script>
        function confirmDelete(entityId) {
          if (confirm('Are you sure you want to delete this entity? This action creates a new deleted version.')) {
            fetch('/api/entities/' + entityId, { method: 'DELETE', credentials: 'include' })
              .then(res => {
                if (res.ok) {
                  window.location.reload();
                } else {
                  return res.json().then(data => {
                    alert('Error: ' + (data.error || 'Failed to delete entity'));
                  });
                }
              })
              .catch(err => {
                alert('Error: ' + err.message);
              });
          }
        }

        function confirmRestore(entityId) {
          if (confirm('Are you sure you want to restore this entity?')) {
            fetch('/api/entities/' + entityId + '/restore', { method: 'POST', credentials: 'include' })
              .then(res => {
                if (res.ok) {
                  window.location.reload();
                } else {
                  return res.json().then(data => {
                    alert('Error: ' + (data.error || 'Failed to restore entity'));
                  });
                }
              })
              .catch(err => {
                alert('Error: ' + err.message);
              });
          }
        }
      </script>
    `;

    // Build the banner for old versions
    const oldVersionBanner = !entity.is_latest
      ? `
      <div class="warning-message">
        <strong>Viewing old version</strong> - You are viewing version ${entity.version} of this entity.
        ${latestVersionId ? `<a href="/ui/entities/${latestVersionId}">View latest version</a>` : ''}
      </div>
    `
      : '';

    const content = `
      <h2>${escapeHtml(displayName)}</h2>
      ${oldVersionBanner}
      ${entityInfoSection}
      ${propertiesSection}
      ${aclSection}
      ${outboundLinksSection}
      ${inboundLinksSection}
      ${versionHistorySection}
      ${actionsSection}

      <div class="button-group">
        <a href="/ui/entities" class="button secondary">Back to Entities</a>
      </div>
    `;

    const html = renderPage(
      {
        title: `${displayName} - Entity`,
        user,
        activePath: '/ui/entities',
        breadcrumbs: [
          { label: 'Home', href: '/ui' },
          { label: 'Entities', href: '/ui/entities' },
          { label: displayName },
        ],
      },
      content
    );

    return c.html(html);
  } catch (error) {
    console.error('Error fetching entity:', error);
    const content = `
      <div class="error-message">
        <h2>Error</h2>
        <p>An error occurred while fetching the entity. Please try again later.</p>
      </div>
      <div class="button-group">
        <a href="/ui/entities" class="button secondary">Back to Entities</a>
      </div>
    `;

    return c.html(
      renderPage(
        {
          title: 'Error',
          user,
          activePath: '/ui/entities',
          breadcrumbs: [
            { label: 'Home', href: '/ui' },
            { label: 'Entities', href: '/ui/entities' },
            { label: 'Error' },
          ],
        },
        content
      ),
      500
    );
  }
});

/**
 * Entity Version History List
 * GET /ui/entities/:id/versions
 * Lists all versions of an entity
 */
ui.get('/entities/:id/versions', async c => {
  const user = c.get('user');
  const entityId = c.req.param('id');

  try {
    // Fetch all versions of this entity chain
    const versionHistory = await c.env.DB.prepare(
      `
      WITH RECURSIVE version_chain_back AS (
        SELECT id, type_id, properties, version, created_at, created_by, is_latest, is_deleted, previous_version_id
        FROM entities WHERE id = ?
        UNION ALL
        SELECT e.id, e.type_id, e.properties, e.version, e.created_at, e.created_by, e.is_latest, e.is_deleted, e.previous_version_id
        FROM entities e
        INNER JOIN version_chain_back vc ON e.id = vc.previous_version_id
      ),
      version_chain_forward AS (
        SELECT id, type_id, properties, version, created_at, created_by, is_latest, is_deleted, previous_version_id
        FROM entities WHERE id = ?
        UNION ALL
        SELECT e.id, e.type_id, e.properties, e.version, e.created_at, e.created_by, e.is_latest, e.is_deleted, e.previous_version_id
        FROM entities e
        INNER JOIN version_chain_forward vc ON e.previous_version_id = vc.id
      )
      SELECT DISTINCT v.*,
        u.display_name as created_by_name, u.email as created_by_email,
        t.name as type_name
      FROM (
        SELECT * FROM version_chain_back
        UNION
        SELECT * FROM version_chain_forward
      ) v
      LEFT JOIN users u ON v.created_by = u.id
      LEFT JOIN types t ON v.type_id = t.id
      ORDER BY v.version DESC
    `
    )
      .bind(entityId, entityId)
      .all<{
        id: string;
        type_id: string;
        properties: string;
        version: number;
        created_at: number;
        created_by: string;
        is_latest: number;
        is_deleted: number;
        previous_version_id: string | null;
        created_by_name: string | null;
        created_by_email: string;
        type_name: string;
      }>();

    if (versionHistory.results.length === 0) {
      const content = `
        <div class="error-message">
          <h2>Entity Not Found</h2>
          <p>The entity with ID "${escapeHtml(entityId)}" could not be found.</p>
        </div>
        <div class="button-group">
          <a href="/ui/entities" class="button secondary">Back to Entities</a>
        </div>
      `;

      return c.html(
        renderPage(
          {
            title: 'Entity Not Found',
            user,
            activePath: '/ui/entities',
            breadcrumbs: [
              { label: 'Home', href: '/ui' },
              { label: 'Entities', href: '/ui/entities' },
              { label: 'Not Found' },
            ],
          },
          content
        ),
        404
      );
    }

    // Get the latest version for display name
    const latestVersion =
      versionHistory.results.find(v => v.is_latest === 1) || versionHistory.results[0];
    const props = JSON.parse(latestVersion.properties);
    const displayName = props.name || props.title || props.label || entityId.substring(0, 8);

    // Build version history table
    const versionTable = `
      <table class="data-table">
        <thead>
          <tr>
            <th>Version</th>
            <th>Status</th>
            <th>Modified By</th>
            <th>Modified At</th>
            <th>Properties Preview</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${versionHistory.results
            .map((version, index) => {
              const versionProps = JSON.parse(version.properties);
              const propsPreview = JSON.stringify(versionProps);
              const truncatedProps =
                propsPreview.length > 80 ? propsPreview.substring(0, 80) + '...' : propsPreview;
              const prevVersion = versionHistory.results[index + 1];

              return `
              <tr>
                <td>
                  <a href="/ui/entities/${version.id}/versions/${version.version}">
                    <strong>Version ${version.version}</strong>
                  </a>
                </td>
                <td>
                  ${version.is_latest ? '<span class="badge success">Latest</span>' : '<span class="badge muted">Old</span>'}
                  ${version.is_deleted ? '<span class="badge danger">Deleted</span>' : ''}
                </td>
                <td>${escapeHtml(version.created_by_name || version.created_by_email)}</td>
                <td>${formatTimestamp(version.created_at)}</td>
                <td><code class="small">${escapeHtml(truncatedProps)}</code></td>
                <td>
                  <div class="button-group compact">
                    <a href="/ui/entities/${version.id}" class="button small">View</a>
                    ${prevVersion ? `<a href="/ui/entities/${entityId}/versions/${prevVersion.version}/compare/${version.version}" class="button small secondary">Compare</a>` : ''}
                  </div>
                </td>
              </tr>
            `;
            })
            .join('')}
        </tbody>
      </table>
    `;

    const content = `
      <h2>Version History: ${escapeHtml(displayName)}</h2>
      <p class="muted">Entity type: <span class="badge">${escapeHtml(latestVersion.type_name)}</span></p>
      <p>This entity has ${versionHistory.results.length} version${versionHistory.results.length !== 1 ? 's' : ''}.</p>

      ${versionTable}

      <div class="button-group">
        <a href="/ui/entities/${latestVersion.id}" class="button">View Latest Version</a>
        ${versionHistory.results.length >= 2 ? `<a href="/ui/entities/${entityId}/versions/1/compare/${latestVersion.version}" class="button secondary">Compare First to Latest</a>` : ''}
        <a href="/ui/entities" class="button secondary">Back to Entities</a>
      </div>
    `;

    const html = renderPage(
      {
        title: `Version History - ${displayName}`,
        user,
        activePath: '/ui/entities',
        breadcrumbs: [
          { label: 'Home', href: '/ui' },
          { label: 'Entities', href: '/ui/entities' },
          { label: displayName, href: `/ui/entities/${latestVersion.id}` },
          { label: 'Versions' },
        ],
      },
      content
    );

    return c.html(html);
  } catch (error) {
    console.error('Error fetching entity version history:', error);
    const content = `
      <div class="error-message">
        <h2>Error</h2>
        <p>An error occurred while fetching the version history. Please try again later.</p>
      </div>
      <div class="button-group">
        <a href="/ui/entities" class="button secondary">Back to Entities</a>
      </div>
    `;

    return c.html(
      renderPage(
        {
          title: 'Error',
          user,
          activePath: '/ui/entities',
          breadcrumbs: [
            { label: 'Home', href: '/ui' },
            { label: 'Entities', href: '/ui/entities' },
            { label: 'Error' },
          ],
        },
        content
      ),
      500
    );
  }
});

/**
 * Entity Specific Version Detail
 * GET /ui/entities/:id/versions/:version
 * Shows a specific version of an entity
 */
ui.get('/entities/:id/versions/:version', async c => {
  const user = c.get('user');
  const entityId = c.req.param('id');
  const versionParam = c.req.param('version');
  const versionNum = parseInt(versionParam, 10);

  if (isNaN(versionNum) || versionNum < 1) {
    const content = `
      <div class="error-message">
        <h2>Invalid Version Number</h2>
        <p>Version number must be a positive integer.</p>
      </div>
      <div class="button-group">
        <a href="/ui/entities/${escapeHtml(entityId)}" class="button secondary">Back to Entity</a>
      </div>
    `;

    return c.html(
      renderPage(
        {
          title: 'Invalid Version',
          user,
          activePath: '/ui/entities',
          breadcrumbs: [
            { label: 'Home', href: '/ui' },
            { label: 'Entities', href: '/ui/entities' },
            { label: 'Invalid Version' },
          ],
        },
        content
      ),
      400
    );
  }

  try {
    // Fetch all versions of this entity chain to find the requested version
    const versionHistory = await c.env.DB.prepare(
      `
      WITH RECURSIVE version_chain_back AS (
        SELECT id, type_id, properties, version, created_at, created_by, is_latest, is_deleted, previous_version_id
        FROM entities WHERE id = ?
        UNION ALL
        SELECT e.id, e.type_id, e.properties, e.version, e.created_at, e.created_by, e.is_latest, e.is_deleted, e.previous_version_id
        FROM entities e
        INNER JOIN version_chain_back vc ON e.id = vc.previous_version_id
      ),
      version_chain_forward AS (
        SELECT id, type_id, properties, version, created_at, created_by, is_latest, is_deleted, previous_version_id
        FROM entities WHERE id = ?
        UNION ALL
        SELECT e.id, e.type_id, e.properties, e.version, e.created_at, e.created_by, e.is_latest, e.is_deleted, e.previous_version_id
        FROM entities e
        INNER JOIN version_chain_forward vc ON e.previous_version_id = vc.id
      )
      SELECT DISTINCT v.*,
        u.display_name as created_by_name, u.email as created_by_email,
        t.name as type_name, t.description as type_description
      FROM (
        SELECT * FROM version_chain_back
        UNION
        SELECT * FROM version_chain_forward
      ) v
      LEFT JOIN users u ON v.created_by = u.id
      LEFT JOIN types t ON v.type_id = t.id
      ORDER BY v.version DESC
    `
    )
      .bind(entityId, entityId)
      .all<{
        id: string;
        type_id: string;
        properties: string;
        version: number;
        created_at: number;
        created_by: string;
        is_latest: number;
        is_deleted: number;
        previous_version_id: string | null;
        created_by_name: string | null;
        created_by_email: string;
        type_name: string;
        type_description: string | null;
      }>();

    // Find the requested version
    const entity = versionHistory.results.find(v => v.version === versionNum);

    if (!entity) {
      const content = `
        <div class="error-message">
          <h2>Version Not Found</h2>
          <p>Version ${versionNum} of this entity could not be found.</p>
        </div>
        <div class="button-group">
          <a href="/ui/entities/${escapeHtml(entityId)}/versions" class="button secondary">View All Versions</a>
          <a href="/ui/entities" class="button secondary">Back to Entities</a>
        </div>
      `;

      return c.html(
        renderPage(
          {
            title: 'Version Not Found',
            user,
            activePath: '/ui/entities',
            breadcrumbs: [
              { label: 'Home', href: '/ui' },
              { label: 'Entities', href: '/ui/entities' },
              { label: 'Version Not Found' },
            ],
          },
          content
        ),
        404
      );
    }

    const latestVersion =
      versionHistory.results.find(v => v.is_latest === 1) || versionHistory.results[0];
    const props = JSON.parse(entity.properties);
    const displayName = props.name || props.title || props.label || entityId.substring(0, 8);

    // Find previous and next versions for navigation
    const currentIndex = versionHistory.results.findIndex(v => v.version === versionNum);
    const prevVersion = versionHistory.results[currentIndex + 1];
    const nextVersion = versionHistory.results[currentIndex - 1];

    // Build version navigation
    const versionNav = `
      <div class="card">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div>
            ${prevVersion ? `<a href="/ui/entities/${entityId}/versions/${prevVersion.version}" class="button secondary small">&larr; Version ${prevVersion.version}</a>` : '<span class="muted small">First version</span>'}
          </div>
          <div>
            <strong>Version ${entity.version}</strong> of ${versionHistory.results.length}
          </div>
          <div>
            ${nextVersion ? `<a href="/ui/entities/${entityId}/versions/${nextVersion.version}" class="button secondary small">Version ${nextVersion.version} &rarr;</a>` : '<span class="muted small">Latest version</span>'}
          </div>
        </div>
      </div>
    `;

    // Build entity info section
    const entityInfoSection = `
      <div class="card detail-card">
        <h3>Entity Information</h3>
        <dl class="detail-list">
          <dt>ID</dt>
          <dd><code>${escapeHtml(entity.id)}</code></dd>

          <dt>Type</dt>
          <dd>
            <a href="/ui/entities?type_id=${entity.type_id}" class="badge">${escapeHtml(entity.type_name)}</a>
            ${entity.type_description ? `<span class="muted small">${escapeHtml(entity.type_description)}</span>` : ''}
          </dd>

          <dt>Version</dt>
          <dd>${entity.version}${entity.previous_version_id ? ` <span class="muted">(previous: <a href="/ui/entities/${entity.previous_version_id}">${entity.previous_version_id.substring(0, 8)}...</a>)</span>` : ''}</dd>

          <dt>Created By</dt>
          <dd>${escapeHtml(entity.created_by_name || entity.created_by_email)}</dd>

          <dt>Created At</dt>
          <dd>${formatTimestamp(entity.created_at)}</dd>

          <dt>Status</dt>
          <dd>
            ${entity.is_latest ? '<span class="badge success">Latest</span>' : '<span class="badge muted">Old Version</span>'}
            ${entity.is_deleted ? '<span class="badge danger">Deleted</span>' : ''}
          </dd>
        </dl>
      </div>
    `;

    // Build properties section
    const propertiesSection = `
      <div class="card">
        <h3>Properties</h3>
        <pre><code>${escapeHtml(JSON.stringify(props, null, 2))}</code></pre>
      </div>
    `;

    // Build comparison links
    const comparisonLinks = `
      <div class="card">
        <h3>Compare Versions</h3>
        ${prevVersion ? `<a href="/ui/entities/${entityId}/versions/${prevVersion.version}/compare/${entity.version}" class="button secondary">Compare with Previous (v${prevVersion.version})</a>` : '<span class="muted">No previous version to compare</span>'}
        ${entity.version !== latestVersion.version ? ` <a href="/ui/entities/${entityId}/versions/${entity.version}/compare/${latestVersion.version}" class="button secondary">Compare with Latest (v${latestVersion.version})</a>` : ''}
      </div>
    `;

    // Build the banner for old versions
    const oldVersionBanner = !entity.is_latest
      ? `
      <div class="warning-message">
        <strong>Viewing old version</strong> - You are viewing version ${entity.version} of this entity.
        <a href="/ui/entities/${latestVersion.id}">View latest version</a>
      </div>
    `
      : '';

    const content = `
      <h2>${escapeHtml(displayName)} - Version ${entity.version}</h2>
      ${oldVersionBanner}
      ${versionNav}
      ${entityInfoSection}
      ${propertiesSection}
      ${comparisonLinks}

      <div class="button-group">
        <a href="/ui/entities/${latestVersion.id}" class="button">View Latest Version</a>
        <a href="/ui/entities/${entityId}/versions" class="button secondary">View All Versions</a>
        <a href="/ui/entities" class="button secondary">Back to Entities</a>
      </div>
    `;

    const html = renderPage(
      {
        title: `${displayName} - Version ${entity.version}`,
        user,
        activePath: '/ui/entities',
        breadcrumbs: [
          { label: 'Home', href: '/ui' },
          { label: 'Entities', href: '/ui/entities' },
          { label: displayName, href: `/ui/entities/${latestVersion.id}` },
          { label: 'Versions', href: `/ui/entities/${entityId}/versions` },
          { label: `Version ${entity.version}` },
        ],
      },
      content
    );

    return c.html(html);
  } catch (error) {
    console.error('Error fetching entity version:', error);
    const content = `
      <div class="error-message">
        <h2>Error</h2>
        <p>An error occurred while fetching the version. Please try again later.</p>
      </div>
      <div class="button-group">
        <a href="/ui/entities" class="button secondary">Back to Entities</a>
      </div>
    `;

    return c.html(
      renderPage(
        {
          title: 'Error',
          user,
          activePath: '/ui/entities',
          breadcrumbs: [
            { label: 'Home', href: '/ui' },
            { label: 'Entities', href: '/ui/entities' },
            { label: 'Error' },
          ],
        },
        content
      ),
      500
    );
  }
});

/**
 * Version Comparison View
 * GET /ui/entities/:id/versions/:v1/compare/:v2
 * Shows a side-by-side comparison of two versions of an entity
 */
ui.get('/entities/:id/versions/:v1/compare/:v2', async c => {
  const user = c.get('user');
  const entityId = c.req.param('id');
  const v1Param = c.req.param('v1');
  const v2Param = c.req.param('v2');

  // Parse version numbers
  const v1 = parseInt(v1Param, 10);
  const v2 = parseInt(v2Param, 10);

  if (isNaN(v1) || isNaN(v2)) {
    const content = `
      <div class="error-message">
        <h2>Invalid Version Numbers</h2>
        <p>Version numbers must be positive integers.</p>
      </div>
      <div class="button-group">
        <a href="/ui/entities/${escapeHtml(entityId)}" class="button secondary">Back to Entity</a>
      </div>
    `;

    return c.html(
      renderPage(
        {
          title: 'Invalid Versions',
          user,
          activePath: '/ui/entities',
          breadcrumbs: [
            { label: 'Home', href: '/ui' },
            { label: 'Entities', href: '/ui/entities' },
            { label: 'Invalid Versions' },
          ],
        },
        content
      ),
      400
    );
  }

  try {
    // First, fetch all versions of this entity chain to find the correct records
    // We need to find the version chain that contains the entity with the given ID
    const versionHistory = await c.env.DB.prepare(
      `
      WITH RECURSIVE version_chain_back AS (
        SELECT id, type_id, properties, version, created_at, created_by, is_latest, is_deleted, previous_version_id
        FROM entities WHERE id = ?
        UNION ALL
        SELECT e.id, e.type_id, e.properties, e.version, e.created_at, e.created_by, e.is_latest, e.is_deleted, e.previous_version_id
        FROM entities e
        INNER JOIN version_chain_back vc ON e.id = vc.previous_version_id
      ),
      version_chain_forward AS (
        SELECT id, type_id, properties, version, created_at, created_by, is_latest, is_deleted, previous_version_id
        FROM entities WHERE id = ?
        UNION ALL
        SELECT e.id, e.type_id, e.properties, e.version, e.created_at, e.created_by, e.is_latest, e.is_deleted, e.previous_version_id
        FROM entities e
        INNER JOIN version_chain_forward vc ON e.previous_version_id = vc.id
      )
      SELECT DISTINCT v.*,
        u.display_name as created_by_name, u.email as created_by_email,
        t.name as type_name
      FROM (
        SELECT * FROM version_chain_back
        UNION
        SELECT * FROM version_chain_forward
      ) v
      LEFT JOIN users u ON v.created_by = u.id
      LEFT JOIN types t ON v.type_id = t.id
      ORDER BY v.version DESC
    `
    )
      .bind(entityId, entityId)
      .all<{
        id: string;
        type_id: string;
        properties: string;
        version: number;
        created_at: number;
        created_by: string;
        is_latest: number;
        is_deleted: number;
        previous_version_id: string | null;
        created_by_name: string | null;
        created_by_email: string;
        type_name: string;
      }>();

    if (versionHistory.results.length === 0) {
      const content = `
        <div class="error-message">
          <h2>Entity Not Found</h2>
          <p>The entity with ID "${escapeHtml(entityId)}" could not be found.</p>
        </div>
        <div class="button-group">
          <a href="/ui/entities" class="button secondary">Back to Entities</a>
        </div>
      `;

      return c.html(
        renderPage(
          {
            title: 'Entity Not Found',
            user,
            activePath: '/ui/entities',
            breadcrumbs: [
              { label: 'Home', href: '/ui' },
              { label: 'Entities', href: '/ui/entities' },
              { label: 'Not Found' },
            ],
          },
          content
        ),
        404
      );
    }

    // Find the specific versions
    const version1 = versionHistory.results.find(v => v.version === v1);
    const version2 = versionHistory.results.find(v => v.version === v2);

    if (!version1 || !version2) {
      const availableVersions = versionHistory.results.map(v => v.version).join(', ');
      const content = `
        <div class="error-message">
          <h2>Version Not Found</h2>
          <p>One or both versions (${v1}, ${v2}) could not be found.</p>
          <p>Available versions: ${availableVersions}</p>
        </div>
        <div class="button-group">
          <a href="/ui/entities/${escapeHtml(entityId)}" class="button secondary">Back to Entity</a>
        </div>
      `;

      return c.html(
        renderPage(
          {
            title: 'Version Not Found',
            user,
            activePath: '/ui/entities',
            breadcrumbs: [
              { label: 'Home', href: '/ui' },
              { label: 'Entities', href: '/ui/entities' },
              { label: 'Version Not Found' },
            ],
          },
          content
        ),
        404
      );
    }

    // Parse properties for both versions
    const props1 = JSON.parse(version1.properties);
    const props2 = JSON.parse(version2.properties);

    // Determine which version is "before" and which is "after"
    const [older, newer] =
      version1.version < version2.version ? [version1, version2] : [version2, version1];
    const [olderProps, newerProps] =
      version1.version < version2.version ? [props1, props2] : [props2, props1];

    // Calculate differences
    const allKeys = new Set([...Object.keys(olderProps), ...Object.keys(newerProps)]);
    const added: Array<{ key: string; value: unknown }> = [];
    const removed: Array<{ key: string; value: unknown }> = [];
    const changed: Array<{ key: string; oldValue: unknown; newValue: unknown }> = [];
    const unchanged: Array<{ key: string; value: unknown }> = [];

    for (const key of allKeys) {
      const inOlder = key in olderProps;
      const inNewer = key in newerProps;

      if (!inOlder && inNewer) {
        added.push({ key, value: newerProps[key] });
      } else if (inOlder && !inNewer) {
        removed.push({ key, value: olderProps[key] });
      } else if (JSON.stringify(olderProps[key]) !== JSON.stringify(newerProps[key])) {
        changed.push({ key, oldValue: olderProps[key], newValue: newerProps[key] });
      } else {
        unchanged.push({ key, value: olderProps[key] });
      }
    }

    // Check for status changes
    const statusChanged =
      older.is_deleted !== newer.is_deleted ? (older.is_deleted ? 'Restored' : 'Deleted') : null;

    // Get display name from the latest version properties
    const latestVersion = versionHistory.results.find(v => v.is_latest === 1);
    const latestProps = latestVersion ? JSON.parse(latestVersion.properties) : newerProps;
    const displayName =
      latestProps.name || latestProps.title || latestProps.label || entityId.substring(0, 8);

    // Helper to format a value for display
    const formatValue = (value: unknown): string => {
      if (value === null) return '<span class="muted">null</span>';
      if (value === undefined) return '<span class="muted">undefined</span>';
      if (typeof value === 'string') return escapeHtml(JSON.stringify(value));
      if (typeof value === 'object') return escapeHtml(JSON.stringify(value, null, 2));
      return escapeHtml(String(value));
    };

    // Build diff summary
    const diffSummary = `
      <div class="diff-summary">
        <div class="diff-summary-item">
          <span class="diff-summary-count" style="color: var(--color-success);">${added.length}</span>
          <span class="diff-summary-label">Added</span>
        </div>
        <div class="diff-summary-item">
          <span class="diff-summary-count" style="color: var(--color-error);">${removed.length}</span>
          <span class="diff-summary-label">Removed</span>
        </div>
        <div class="diff-summary-item">
          <span class="diff-summary-count" style="color: var(--color-warning);">${changed.length}</span>
          <span class="diff-summary-label">Changed</span>
        </div>
        <div class="diff-summary-item">
          <span class="diff-summary-count">${unchanged.length}</span>
          <span class="diff-summary-label">Unchanged</span>
        </div>
        ${statusChanged ? `<div class="diff-summary-item"><span class="badge ${statusChanged === 'Deleted' ? 'danger' : 'success'}">${statusChanged}</span></div>` : ''}
      </div>
    `;

    // Build changes section
    let changesHtml = '';

    if (added.length > 0) {
      changesHtml += `
        <div class="diff-section">
          <h5>Added Properties</h5>
          ${added
            .map(
              item => `
            <div class="diff-added">
              <span class="diff-key">${escapeHtml(item.key)}:</span>
              <span class="diff-value">${formatValue(item.value)}</span>
            </div>
          `
            )
            .join('')}
        </div>
      `;
    }

    if (removed.length > 0) {
      changesHtml += `
        <div class="diff-section">
          <h5>Removed Properties</h5>
          ${removed
            .map(
              item => `
            <div class="diff-removed">
              <span class="diff-key">${escapeHtml(item.key)}:</span>
              <span class="diff-value">${formatValue(item.value)}</span>
            </div>
          `
            )
            .join('')}
        </div>
      `;
    }

    if (changed.length > 0) {
      changesHtml += `
        <div class="diff-section">
          <h5>Changed Properties</h5>
          ${changed
            .map(
              item => `
            <div class="diff-changed">
              <div><span class="diff-key">${escapeHtml(item.key)}:</span></div>
              <div style="margin-left: 1rem;">
                <div style="text-decoration: line-through; opacity: 0.7;">${formatValue(item.oldValue)}</div>
                <div class="diff-arrow">&darr;</div>
                <div>${formatValue(item.newValue)}</div>
              </div>
            </div>
          `
            )
            .join('')}
        </div>
      `;
    }

    if (unchanged.length > 0) {
      changesHtml += `
        <div class="diff-section">
          <h5>Unchanged Properties</h5>
          ${unchanged
            .map(
              item => `
            <div class="diff-unchanged">
              <span class="diff-key">${escapeHtml(item.key)}:</span>
              <span class="diff-value">${formatValue(item.value)}</span>
            </div>
          `
            )
            .join('')}
        </div>
      `;
    }

    // Build comparison columns
    const comparisonHtml = `
      <div class="comparison-container">
        <div class="comparison-column">
          <div class="comparison-header">
            <h4>Version ${older.version}</h4>
            <div class="muted small">
              ${older.is_latest ? '<span class="badge success small">Latest</span>' : '<span class="badge muted small">Older</span>'}
              ${older.is_deleted ? '<span class="badge danger small">Deleted</span>' : ''}
            </div>
            <div class="muted small">
              By ${escapeHtml(older.created_by_name || older.created_by_email)} on ${formatTimestamp(older.created_at)}
            </div>
          </div>
          <div class="comparison-body">
            <pre><code>${escapeHtml(JSON.stringify(olderProps, null, 2))}</code></pre>
          </div>
        </div>
        <div class="comparison-column">
          <div class="comparison-header">
            <h4>Version ${newer.version}</h4>
            <div class="muted small">
              ${newer.is_latest ? '<span class="badge success small">Latest</span>' : '<span class="badge muted small">Newer</span>'}
              ${newer.is_deleted ? '<span class="badge danger small">Deleted</span>' : ''}
            </div>
            <div class="muted small">
              By ${escapeHtml(newer.created_by_name || newer.created_by_email)} on ${formatTimestamp(newer.created_at)}
            </div>
          </div>
          <div class="comparison-body">
            <pre><code>${escapeHtml(JSON.stringify(newerProps, null, 2))}</code></pre>
          </div>
        </div>
      </div>
    `;

    // Build version selector form for comparing different versions
    const versionSelectorHtml = `
      <div class="card">
        <h3>Compare Different Versions</h3>
        <form class="version-selector" method="GET" action="">
          <label for="v1-select">Version 1:</label>
          <select id="v1-select" name="v1" onchange="updateCompareUrl()">
            ${versionHistory.results
              .map(
                v => `
              <option value="${v.version}" ${v.version === older.version ? 'selected' : ''}>
                Version ${v.version} ${v.is_latest ? '(Latest)' : ''} ${v.is_deleted ? '(Deleted)' : ''} - ${formatTimestamp(v.created_at)}
              </option>
            `
              )
              .join('')}
          </select>
          <label for="v2-select">Version 2:</label>
          <select id="v2-select" name="v2" onchange="updateCompareUrl()">
            ${versionHistory.results
              .map(
                v => `
              <option value="${v.version}" ${v.version === newer.version ? 'selected' : ''}>
                Version ${v.version} ${v.is_latest ? '(Latest)' : ''} ${v.is_deleted ? '(Deleted)' : ''} - ${formatTimestamp(v.created_at)}
              </option>
            `
              )
              .join('')}
          </select>
          <button type="submit" class="button">Compare</button>
        </form>
        <script>
          function updateCompareUrl() {
            const form = document.querySelector('.version-selector');
            const v1 = form.querySelector('#v1-select').value;
            const v2 = form.querySelector('#v2-select').value;
            const entityId = '${entityId}';
            form.action = '/ui/entities/' + entityId + '/versions/' + v1 + '/compare/' + v2;
          }
          // Initialize form action on page load
          updateCompareUrl();
        </script>
      </div>
    `;

    const content = `
      <h2>Comparing Versions: ${escapeHtml(displayName)}</h2>
      <p class="muted">Comparing version ${older.version} with version ${newer.version}</p>

      ${diffSummary}

      <div class="card">
        <h3>Property Differences</h3>
        ${changesHtml || '<p class="muted">No differences between these versions.</p>'}
      </div>

      <div class="card">
        <h3>Full Comparison</h3>
        ${comparisonHtml}
      </div>

      <div class="card">
        <h3>Metadata Comparison</h3>
        <table class="data-table">
          <thead>
            <tr>
              <th>Field</th>
              <th>Version ${older.version}</th>
              <th>Version ${newer.version}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>ID</strong></td>
              <td><code>${older.id}</code></td>
              <td><code>${newer.id}</code></td>
            </tr>
            <tr>
              <td><strong>Type</strong></td>
              <td>${escapeHtml(older.type_name)}</td>
              <td>${escapeHtml(newer.type_name)}</td>
            </tr>
            <tr>
              <td><strong>Status</strong></td>
              <td>${older.is_deleted ? '<span class="badge danger">Deleted</span>' : '<span class="badge success">Active</span>'}</td>
              <td>${newer.is_deleted ? '<span class="badge danger">Deleted</span>' : '<span class="badge success">Active</span>'}</td>
            </tr>
            <tr>
              <td><strong>Created By</strong></td>
              <td>${escapeHtml(older.created_by_name || older.created_by_email)}</td>
              <td>${escapeHtml(newer.created_by_name || newer.created_by_email)}</td>
            </tr>
            <tr>
              <td><strong>Created At</strong></td>
              <td>${formatTimestamp(older.created_at)}</td>
              <td>${formatTimestamp(newer.created_at)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      ${versionSelectorHtml}

      <div class="button-group">
        <a href="/ui/entities/${entityId}" class="button secondary">Back to Entity</a>
        <a href="/ui/entities/${older.id}" class="button small secondary">View Version ${older.version}</a>
        <a href="/ui/entities/${newer.id}" class="button small secondary">View Version ${newer.version}</a>
      </div>
    `;

    const html = renderPage(
      {
        title: `Compare Versions - ${displayName}`,
        user,
        activePath: '/ui/entities',
        breadcrumbs: [
          { label: 'Home', href: '/ui' },
          { label: 'Entities', href: '/ui/entities' },
          { label: displayName, href: `/ui/entities/${entityId}` },
          { label: `Compare v${older.version} vs v${newer.version}` },
        ],
      },
      content
    );

    return c.html(html);
  } catch (error) {
    console.error('Error comparing versions:', error);
    const content = `
      <div class="error-message">
        <h2>Error</h2>
        <p>An error occurred while comparing versions. Please try again later.</p>
      </div>
      <div class="button-group">
        <a href="/ui/entities/${escapeHtml(entityId)}" class="button secondary">Back to Entity</a>
      </div>
    `;

    return c.html(
      renderPage(
        {
          title: 'Error',
          user,
          activePath: '/ui/entities',
          breadcrumbs: [
            { label: 'Home', href: '/ui' },
            { label: 'Entities', href: '/ui/entities' },
            { label: 'Error' },
          ],
        },
        content
      ),
      500
    );
  }
});

/**
 * Helper function to get a change preview for version history
 */
function getChangePreview(
  version: {
    version: number;
    properties: string;
    is_deleted: number;
    previous_version_id: string | null;
  },
  allVersions: Array<{
    id: string;
    version: number;
    properties: string;
    is_deleted: number;
    previous_version_id: string | null;
  }>
): string {
  if (version.version === 1) {
    return '<span class="muted">Initial version</span>';
  }

  // Find the previous version
  const prevVersion = allVersions.find(v => v.version === version.version - 1);
  if (!prevVersion) {
    return '';
  }

  const prevProps = JSON.parse(prevVersion.properties);
  const currProps = JSON.parse(version.properties);

  const changes: string[] = [];

  // Check for status change
  if (version.is_deleted && !prevVersion.is_deleted) {
    changes.push('Deleted');
  } else if (!version.is_deleted && prevVersion.is_deleted) {
    changes.push('Restored');
  }

  // Check for property changes
  const allKeys = new Set([...Object.keys(prevProps), ...Object.keys(currProps)]);
  for (const key of allKeys) {
    if (!(key in prevProps)) {
      changes.push(`Added "${key}"`);
    } else if (!(key in currProps)) {
      changes.push(`Removed "${key}"`);
    } else if (JSON.stringify(prevProps[key]) !== JSON.stringify(currProps[key])) {
      changes.push(`Changed "${key}"`);
    }
  }

  if (changes.length === 0) {
    return '<span class="muted">No property changes</span>';
  }

  return (
    '<span class="muted">' +
    changes.slice(0, 3).join(', ') +
    (changes.length > 3 ? '...' : '') +
    '</span>'
  );
}

/**
 * Link list view (placeholder)
 * GET /ui/links
 */
ui.get('/links', async c => {
  const user = c.get('user');

  // Require authentication for links browser
  if (!user) {
    return c.redirect('/ui/auth/login?return_to=' + encodeURIComponent('/ui/links'));
  }

  // Get filter parameters
  const filterUserId = c.req.query('user_id') || '';
  const filterTypeId = c.req.query('type_id') || '';
  const filterSourceId = c.req.query('source_id') || '';
  const filterTargetId = c.req.query('target_id') || '';
  const filterTimeRange = c.req.query('time_range') || 'all';
  const filterStartDate = c.req.query('start_date') || '';
  const filterEndDate = c.req.query('end_date') || '';
  const showDeleted = c.req.query('show_deleted') === 'true';
  const showAllVersions = c.req.query('show_all_versions') === 'true';
  const sortBy = c.req.query('sort_by') || 'created_at';
  const sortOrder = c.req.query('sort_order') || 'desc';

  // Get pagination parameters
  const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 100);
  const cursor = c.req.query('cursor') || '';

  // Calculate timestamp for time range filters
  let timeRangeFilter = '';
  const now = Date.now();
  if (filterTimeRange !== 'all' && filterTimeRange !== 'custom') {
    let since = now;
    switch (filterTimeRange) {
      case 'hour':
        since = now - 60 * 60 * 1000;
        break;
      case 'day':
        since = now - 24 * 60 * 60 * 1000;
        break;
      case 'week':
        since = now - 7 * 24 * 60 * 60 * 1000;
        break;
      case 'month':
        since = now - 30 * 24 * 60 * 60 * 1000;
        break;
    }
    timeRangeFilter = `AND l.created_at >= ${since}`;
  } else if (filterTimeRange === 'custom' && filterStartDate) {
    const startTimestamp = new Date(filterStartDate).getTime();
    if (!isNaN(startTimestamp)) {
      timeRangeFilter = `AND l.created_at >= ${startTimestamp}`;
    }
    if (filterEndDate) {
      const endTimestamp = new Date(filterEndDate).getTime() + 24 * 60 * 60 * 1000 - 1; // End of day
      if (!isNaN(endTimestamp)) {
        timeRangeFilter += ` AND l.created_at <= ${endTimestamp}`;
      }
    }
  }

  // Build WHERE clause for filters
  const userFilter = filterUserId ? `AND l.created_by = ?` : '';
  const typeFilter = filterTypeId ? `AND l.type_id = ?` : '';
  const sourceFilter = filterSourceId ? `AND l.source_entity_id = ?` : '';
  const targetFilter = filterTargetId ? `AND l.target_entity_id = ?` : '';
  const deletedFilter = showDeleted ? '' : 'AND l.is_deleted = 0';
  const versionFilter = showAllVersions ? '' : 'AND l.is_latest = 1';
  const cursorFilter = cursor ? `AND l.created_at < ?` : '';

  // Build ACL filter for authenticated user
  type AclFilterResult = Awaited<ReturnType<typeof buildAclFilterClause>>;
  const aclFilter: AclFilterResult = await buildAclFilterClause(
    c.env.DB,
    c.env.KV,
    user.user_id,
    'read',
    'l.acl_id'
  );
  let aclFilterClause = '';
  const aclFilterParams: unknown[] = [];
  if (aclFilter.useFilter) {
    aclFilterClause = `AND ${aclFilter.whereClause}`;
    aclFilterParams.push(...aclFilter.bindings);
  }

  // Validate sort column to prevent SQL injection
  const allowedSortColumns = ['created_at', 'type_name', 'version'];
  const sortColumn = allowedSortColumns.includes(sortBy) ? sortBy : 'created_at';
  const sortDirection = sortOrder === 'asc' ? 'ASC' : 'DESC';

  // Fetch users for filter dropdown
  const allUsers = await c.env.DB.prepare(
    'SELECT id, email, display_name FROM users ORDER BY email'
  ).all<{ id: string; email: string; display_name?: string }>();

  // Fetch types for filter dropdown (link types only)
  const allTypes = await c.env.DB.prepare(
    "SELECT id, name FROM types WHERE category = 'link' ORDER BY name"
  ).all<{ id: string; name: string }>();

  // Build query for links with filters
  const linksQuery = `
    SELECT
      l.id, l.type_id, l.source_entity_id, l.target_entity_id, l.properties, l.version,
      l.created_at, l.created_by, l.is_latest, l.is_deleted, l.previous_version_id, l.acl_id,
      t.name as type_name,
      u.display_name, u.email,
      se.properties as source_properties, st.name as source_type_name,
      te.properties as target_properties, tt.name as target_type_name
    FROM links l
    JOIN types t ON l.type_id = t.id
    LEFT JOIN users u ON l.created_by = u.id
    LEFT JOIN entities se ON l.source_entity_id = se.id AND se.is_latest = 1
    LEFT JOIN types st ON se.type_id = st.id
    LEFT JOIN entities te ON l.target_entity_id = te.id AND te.is_latest = 1
    LEFT JOIN types tt ON te.type_id = tt.id
    WHERE 1=1 ${timeRangeFilter} ${userFilter} ${typeFilter} ${sourceFilter} ${targetFilter} ${deletedFilter} ${versionFilter} ${cursorFilter} ${aclFilterClause}
    ORDER BY ${sortColumn === 'type_name' ? 't.name' : 'l.' + sortColumn} ${sortDirection}
    LIMIT ?
  `;

  const queryParams: unknown[] = [];
  if (filterUserId) queryParams.push(filterUserId);
  if (filterTypeId) queryParams.push(filterTypeId);
  if (filterSourceId) queryParams.push(filterSourceId);
  if (filterTargetId) queryParams.push(filterTargetId);
  if (cursor) {
    // Cursor is a timestamp
    queryParams.push(parseInt(cursor, 10));
  }
  queryParams.push(...aclFilterParams);
  queryParams.push(limit + 1); // Fetch one extra to determine if there are more results

  const linksResult = await c.env.DB.prepare(linksQuery)
    .bind(...queryParams)
    .all<{
      id: string;
      type_id: string;
      source_entity_id: string;
      target_entity_id: string;
      properties: string;
      version: number;
      created_at: number;
      created_by: string;
      is_latest: number;
      is_deleted: number;
      previous_version_id: string | null;
      acl_id: number | null;
      type_name: string;
      display_name?: string;
      email: string;
      source_properties: string | null;
      source_type_name: string | null;
      target_properties: string | null;
      target_type_name: string | null;
    }>();

  // Apply per-row filtering if ACL filter couldn't be applied in SQL
  let filteredResults = linksResult.results;
  if (!aclFilter.useFilter) {
    filteredResults = filterByAclPermission(filteredResults, aclFilter.accessibleAclIds);
  }

  // Determine if there are more results
  const hasMore = filteredResults.length > limit;
  const links = hasMore ? filteredResults.slice(0, limit) : filteredResults;

  // Calculate next cursor
  let nextCursor = '';
  if (hasMore && links.length > 0) {
    nextCursor = links[links.length - 1].created_at.toString();
  }

  // Build pagination links
  const buildPaginationUrl = (newCursor: string) => {
    const params = new URLSearchParams();
    if (filterUserId) params.set('user_id', filterUserId);
    if (filterTypeId) params.set('type_id', filterTypeId);
    if (filterSourceId) params.set('source_id', filterSourceId);
    if (filterTargetId) params.set('target_id', filterTargetId);
    if (filterTimeRange !== 'all') params.set('time_range', filterTimeRange);
    if (filterStartDate) params.set('start_date', filterStartDate);
    if (filterEndDate) params.set('end_date', filterEndDate);
    if (showDeleted) params.set('show_deleted', 'true');
    if (showAllVersions) params.set('show_all_versions', 'true');
    if (sortBy !== 'created_at') params.set('sort_by', sortBy);
    if (sortOrder !== 'desc') params.set('sort_order', sortOrder);
    if (limit !== 20) params.set('limit', limit.toString());
    if (newCursor) params.set('cursor', newCursor);
    return `/ui/links?${params.toString()}`;
  };

  // Helper function to get display name from entity properties
  const getEntityDisplayName = (properties: string | null, entityId: string) => {
    if (!properties) return entityId.substring(0, 8) + '...';
    try {
      const parsed = JSON.parse(properties);
      return parsed.name || parsed.title || parsed.label || entityId.substring(0, 8) + '...';
    } catch {
      return entityId.substring(0, 8) + '...';
    }
  };

  // Render filter form
  const filterForm = `
    <div class="card">
      <form method="GET" action="/ui/links" class="filter-form">
        <div class="form-row">
          <div class="form-group">
            <label for="user_id">User:</label>
            <select id="user_id" name="user_id">
              <option value="">All users</option>
              ${allUsers.results
                .map(
                  u => `
                <option value="${u.id}" ${filterUserId === u.id ? 'selected' : ''}>
                  ${escapeHtml(u.display_name || u.email)}
                </option>
              `
                )
                .join('')}
            </select>
          </div>

          <div class="form-group">
            <label for="type_id">Link Type:</label>
            <select id="type_id" name="type_id">
              <option value="">All types</option>
              ${allTypes.results
                .map(
                  t => `
                <option value="${t.id}" ${filterTypeId === t.id ? 'selected' : ''}>
                  ${escapeHtml(t.name)}
                </option>
              `
                )
                .join('')}
            </select>
          </div>

          <div class="form-group">
            <label for="source_id">Source Entity:</label>
            <input type="text" id="source_id" name="source_id" value="${escapeHtml(filterSourceId)}" placeholder="Entity ID">
          </div>

          <div class="form-group">
            <label for="target_id">Target Entity:</label>
            <input type="text" id="target_id" name="target_id" value="${escapeHtml(filterTargetId)}" placeholder="Entity ID">
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label for="time_range">Time Range:</label>
            <select id="time_range" name="time_range" onchange="toggleCustomDates()">
              <option value="all" ${filterTimeRange === 'all' ? 'selected' : ''}>All time</option>
              <option value="hour" ${filterTimeRange === 'hour' ? 'selected' : ''}>Last hour</option>
              <option value="day" ${filterTimeRange === 'day' ? 'selected' : ''}>Last day</option>
              <option value="week" ${filterTimeRange === 'week' ? 'selected' : ''}>Last week</option>
              <option value="month" ${filterTimeRange === 'month' ? 'selected' : ''}>Last month</option>
              <option value="custom" ${filterTimeRange === 'custom' ? 'selected' : ''}>Custom range</option>
            </select>
          </div>

          <div class="form-group">
            <label for="sort_by">Sort By:</label>
            <select id="sort_by" name="sort_by">
              <option value="created_at" ${sortBy === 'created_at' ? 'selected' : ''}>Date</option>
              <option value="type_name" ${sortBy === 'type_name' ? 'selected' : ''}>Type</option>
              <option value="version" ${sortBy === 'version' ? 'selected' : ''}>Version</option>
            </select>
          </div>

          <div class="form-group">
            <label for="sort_order">Order:</label>
            <select id="sort_order" name="sort_order">
              <option value="desc" ${sortOrder === 'desc' ? 'selected' : ''}>Newest First</option>
              <option value="asc" ${sortOrder === 'asc' ? 'selected' : ''}>Oldest First</option>
            </select>
          </div>
        </div>

        <div class="form-row" id="custom-dates" style="display: ${filterTimeRange === 'custom' ? 'flex' : 'none'}">
          <div class="form-group">
            <label for="start_date">Start Date:</label>
            <input type="date" id="start_date" name="start_date" value="${escapeHtml(filterStartDate)}">
          </div>

          <div class="form-group">
            <label for="end_date">End Date:</label>
            <input type="date" id="end_date" name="end_date" value="${escapeHtml(filterEndDate)}">
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>
              <input type="checkbox" name="show_deleted" value="true" ${showDeleted ? 'checked' : ''}>
              Show deleted links
            </label>
          </div>

          <div class="form-group">
            <label>
              <input type="checkbox" name="show_all_versions" value="true" ${showAllVersions ? 'checked' : ''}>
              Show all versions
            </label>
          </div>
        </div>

        <div class="button-group">
          <button type="submit" class="button">Apply Filters</button>
          <a href="/ui/links" class="button secondary">Clear Filters</a>
        </div>
      </form>
    </div>

    <script>
      function toggleCustomDates() {
        const timeRange = document.getElementById('time_range').value;
        const customDates = document.getElementById('custom-dates');
        customDates.style.display = timeRange === 'custom' ? 'flex' : 'none';
      }
    </script>
  `;

  // Render links table
  const linksTable = `
    <table class="data-table">
      <thead>
        <tr>
          <th>ID</th>
          <th>Type</th>
          <th>Source Entity</th>
          <th>Target Entity</th>
          <th>Properties</th>
          <th>Version</th>
          <th>Created By</th>
          <th>Created At</th>
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${links
          .map(link => {
            const props = JSON.parse(link.properties);
            const propsPreview = JSON.stringify(props, null, 2);
            const truncatedPreview =
              propsPreview.length > 100 ? propsPreview.substring(0, 100) + '...' : propsPreview;

            const sourceDisplayName = getEntityDisplayName(
              link.source_properties,
              link.source_entity_id
            );
            const targetDisplayName = getEntityDisplayName(
              link.target_properties,
              link.target_entity_id
            );

            return `
          <tr>
            <td>
              <a href="/ui/links/${link.id}">${link.id.substring(0, 8)}...</a>
            </td>
            <td>
              <a href="/ui/links?type_id=${link.type_id}" class="badge">${escapeHtml(link.type_name)}</a>
            </td>
            <td>
              <a href="/ui/entities/${link.source_entity_id}">${escapeHtml(sourceDisplayName)}</a>
              <div class="muted small">${escapeHtml(link.source_type_name || 'Unknown')}</div>
            </td>
            <td>
              <a href="/ui/entities/${link.target_entity_id}">${escapeHtml(targetDisplayName)}</a>
              <div class="muted small">${escapeHtml(link.target_type_name || 'Unknown')}</div>
            </td>
            <td>
              <code class="small">${escapeHtml(truncatedPreview)}</code>
            </td>
            <td>${link.version}</td>
            <td>
              ${escapeHtml(link.display_name || link.email)}
            </td>
            <td>
              ${formatTimestamp(link.created_at)}
            </td>
            <td>
              ${link.is_latest ? '<span class="badge success">Latest</span>' : '<span class="badge muted">Old</span>'}
              ${link.is_deleted ? '<span class="badge danger">Deleted</span>' : ''}
            </td>
            <td>
              <div class="button-group compact">
                <a href="/ui/links/${link.id}" class="button small">View</a>
                ${!link.is_deleted && link.is_latest ? `<a href="/ui/links/${link.id}/edit" class="button small secondary">Edit</a>` : ''}
              </div>
            </td>
          </tr>
        `;
          })
          .join('')}
      </tbody>
    </table>
  `;

  const content = `
    <h2>Links</h2>
    <p>Browse and filter all links in the database.</p>

    <h3>Filters</h3>
    ${filterForm}

    <h3>Results</h3>
    <p>Showing ${links.length} ${links.length === 1 ? 'link' : 'links'}${hasMore ? ' (more available)' : ''}.</p>

    ${links.length > 0 ? linksTable : '<p class="muted">No links found matching the filters.</p>'}

    ${
      hasMore || cursor
        ? `
      <div class="pagination">
        ${cursor ? `<a href="${buildPaginationUrl('')}" class="button secondary">First Page</a>` : ''}
        ${hasMore ? `<a href="${buildPaginationUrl(nextCursor)}" class="button">Next Page</a>` : ''}
      </div>
    `
        : ''
    }

    <div class="button-group">
      <a href="/ui" class="button secondary">Back to Dashboard</a>
      <a href="/ui/links/new" class="button">Create Link</a>
    </div>
  `;

  const html = renderPage(
    {
      title: 'Links',
      user,
      activePath: '/ui/links',
      breadcrumbs: [{ label: 'Home', href: '/ui' }, { label: 'Links' }],
    },
    content
  );

  return c.html(html);
});

/**
 * Create link form
 * GET /ui/links/new
 * IMPORTANT: This route must be defined BEFORE /links/:id to avoid matching "new" as an ID
 */
ui.get('/links/new', async c => {
  const user = c.get('user');

  // Get optional pre-selected source entity from query parameter
  const preselectedSourceId = c.req.query('source') || '';

  // Fetch all link types for the dropdown
  const allTypes = await c.env.DB.prepare(
    "SELECT id, name, description, json_schema FROM types WHERE category = 'link' ORDER BY name"
  ).all<{ id: string; name: string; description: string | null; json_schema: string | null }>();

  // Fetch preselected source entity if provided
  let preselectedSource: { id: string; properties: string; type_name: string } | null = null;
  if (preselectedSourceId) {
    preselectedSource = await c.env.DB.prepare(
      `
      SELECT e.id, e.properties, t.name as type_name
      FROM entities e
      JOIN types t ON e.type_id = t.id
      WHERE e.id = ? AND e.is_latest = 1 AND e.is_deleted = 0
    `
    )
      .bind(preselectedSourceId)
      .first<{ id: string; properties: string; type_name: string }>();
  }

  // Helper function to get display name from properties
  const getDisplayName = (properties: string | undefined, id: string) => {
    if (!properties) return id.substring(0, 8) + '...';
    try {
      const parsed = JSON.parse(properties);
      return parsed.name || parsed.title || parsed.label || id.substring(0, 8) + '...';
    } catch {
      return id.substring(0, 8) + '...';
    }
  };

  // Get any error message and preserved form data from query params (for validation errors)
  const errorMessage = c.req.query('error') || '';
  const preservedTypeId = c.req.query('preserved_type_id') || '';
  const preservedSourceId = c.req.query('preserved_source_id') || preselectedSourceId;
  const preservedTargetId = c.req.query('preserved_target_id') || '';
  const preservedProperties = c.req.query('preserved_properties') || '{}';

  // Format the preserved properties nicely for display
  let formattedProperties = '{}';
  try {
    const parsed = JSON.parse(preservedProperties);
    formattedProperties = JSON.stringify(parsed, null, 2);
  } catch {
    formattedProperties = preservedProperties;
  }

  // Build the form
  const formHtml = `
    <h2>Create New Link</h2>

    ${
      errorMessage
        ? `
      <div class="error-message">
        <strong>Error:</strong> ${escapeHtml(decodeURIComponent(errorMessage))}
      </div>
    `
        : ''
    }

    <div class="card">
      <form id="create-link-form" class="link-form">
        <div class="form-group">
          <label for="type_id">Link Type <span class="required">*</span></label>
          <select id="type_id" name="type_id" required onchange="updateSchemaHint()">
            <option value="">Select a link type...</option>
            ${allTypes.results
              .map(
                t => `
              <option value="${t.id}"
                      ${preservedTypeId === t.id ? 'selected' : ''}
                      data-schema="${t.json_schema ? escapeHtml(t.json_schema) : ''}"
                      data-description="${t.description ? escapeHtml(t.description) : ''}">
                ${escapeHtml(t.name)}
              </option>
            `
              )
              .join('')}
          </select>
          <div id="type-description" class="form-hint"></div>
        </div>

        <div id="schema-hint" class="schema-hint" style="display: none;">
          <h4>Property Schema</h4>
          <pre><code id="schema-content"></code></pre>
        </div>

        <div class="form-group">
          <label for="source_entity_id">Source Entity <span class="required">*</span></label>
          <div class="entity-picker">
            <input type="text" id="source_entity_search" placeholder="Search entities by name..."
                   autocomplete="off" onkeyup="searchEntities('source')">
            <input type="hidden" id="source_entity_id" name="source_entity_id" value="${escapeHtml(preservedSourceId)}" required>
            <div id="source_entity_results" class="entity-results" style="display: none;"></div>
            <div id="source_entity_selected" class="entity-selected ${preservedSourceId || preselectedSource ? '' : 'hidden'}">
              ${
                preselectedSource
                  ? `
                <span class="selected-entity">
                  <a href="/ui/entities/${preselectedSource.id}">${escapeHtml(getDisplayName(preselectedSource.properties, preselectedSource.id))}</a>
                  <span class="muted">(${escapeHtml(preselectedSource.type_name)})</span>
                </span>
                <button type="button" class="button small secondary" onclick="clearEntitySelection('source')">Clear</button>
              `
                  : preservedSourceId
                    ? `
                <span class="selected-entity">
                  <span class="muted">ID: ${escapeHtml(preservedSourceId.substring(0, 8))}...</span>
                </span>
                <button type="button" class="button small secondary" onclick="clearEntitySelection('source')">Clear</button>
              `
                    : ''
              }
            </div>
          </div>
          <div class="form-hint">Search for an entity to use as the source (from).</div>
        </div>

        <div class="link-direction">
          <div class="direction-arrow">→</div>
        </div>

        <div class="form-group">
          <label for="target_entity_id">Target Entity <span class="required">*</span></label>
          <div class="entity-picker">
            <input type="text" id="target_entity_search" placeholder="Search entities by name..."
                   autocomplete="off" onkeyup="searchEntities('target')">
            <input type="hidden" id="target_entity_id" name="target_entity_id" value="${escapeHtml(preservedTargetId)}" required>
            <div id="target_entity_results" class="entity-results" style="display: none;"></div>
            <div id="target_entity_selected" class="entity-selected ${preservedTargetId ? '' : 'hidden'}">
              ${
                preservedTargetId
                  ? `
                <span class="selected-entity">
                  <span class="muted">ID: ${escapeHtml(preservedTargetId.substring(0, 8))}...</span>
                </span>
                <button type="button" class="button small secondary" onclick="clearEntitySelection('target')">Clear</button>
              `
                  : ''
              }
            </div>
          </div>
          <div class="form-hint">Search for an entity to use as the target (to).</div>
        </div>

        <div class="form-group">
          <label for="properties">Properties (JSON)</label>
          <textarea id="properties" name="properties" rows="10"
                    placeholder='{"role": "example", "weight": 1.0}'>${escapeHtml(formattedProperties)}</textarea>
          <div class="form-hint">Optional: Enter valid JSON object with the link properties.</div>
        </div>

        <div id="json-error" class="error-message" style="display: none;"></div>

        <div class="button-group">
          <button type="submit" class="button" id="submit-btn">Create Link</button>
          <a href="/ui/links" class="button secondary">Cancel</a>
        </div>
      </form>
    </div>

    <script>
      let searchTimeout;

      // Update schema hint when type is selected
      function updateSchemaHint() {
        const select = document.getElementById('type_id');
        const selectedOption = select.options[select.selectedIndex];
        const schema = selectedOption.getAttribute('data-schema');
        const description = selectedOption.getAttribute('data-description');
        const schemaHint = document.getElementById('schema-hint');
        const schemaContent = document.getElementById('schema-content');
        const typeDescription = document.getElementById('type-description');

        if (description) {
          typeDescription.textContent = description;
        } else {
          typeDescription.textContent = '';
        }

        if (schema) {
          try {
            const parsed = JSON.parse(schema);
            schemaContent.textContent = JSON.stringify(parsed, null, 2);
            schemaHint.style.display = 'block';
          } catch {
            schemaHint.style.display = 'none';
          }
        } else {
          schemaHint.style.display = 'none';
        }
      }

      // Validate JSON on input
      document.getElementById('properties').addEventListener('input', function() {
        const errorDiv = document.getElementById('json-error');
        if (!this.value || this.value.trim() === '') {
          errorDiv.style.display = 'none';
          this.style.borderColor = '';
          return;
        }
        try {
          JSON.parse(this.value);
          errorDiv.style.display = 'none';
          this.style.borderColor = '';
        } catch (e) {
          errorDiv.textContent = 'Invalid JSON: ' + e.message;
          errorDiv.style.display = 'block';
          this.style.borderColor = 'var(--color-error)';
        }
      });

      // Search entities with debounce
      function searchEntities(direction) {
        clearTimeout(searchTimeout);
        const searchInput = document.getElementById(direction + '_entity_search');
        const query = searchInput.value.trim();
        const resultsDiv = document.getElementById(direction + '_entity_results');

        if (query.length < 2) {
          resultsDiv.style.display = 'none';
          return;
        }

        searchTimeout = setTimeout(async () => {
          try {
            const response = await fetch('/api/search/suggest?q=' + encodeURIComponent(query) + '&limit=10', { credentials: 'include' });
            const data = await response.json();

            if (data.data && data.data.length > 0) {
              resultsDiv.innerHTML = data.data.map(entity => {
                const displayName = entity.name || entity.title || entity.label || entity.id.substring(0, 8);
                return '<div class="entity-result" onclick="selectEntity(\\'' + direction + '\\', \\'' + entity.id + '\\', \\'' + escapeForJs(displayName) + '\\', \\'' + escapeForJs(entity.type_name) + '\\')">' +
                       '<span class="entity-name">' + escapeHtmlJs(displayName) + '</span> ' +
                       '<span class="muted">(' + escapeHtmlJs(entity.type_name) + ')</span>' +
                       '</div>';
              }).join('');
              resultsDiv.style.display = 'block';
            } else {
              resultsDiv.innerHTML = '<div class="entity-result muted">No entities found</div>';
              resultsDiv.style.display = 'block';
            }
          } catch (error) {
            console.error('Search error:', error);
            resultsDiv.innerHTML = '<div class="entity-result muted">Error searching entities</div>';
            resultsDiv.style.display = 'block';
          }
        }, 300);
      }

      function escapeForJs(str) {
        return str.replace(/'/g, "\\\\'").replace(/"/g, '\\\\"');
      }

      function escapeHtmlJs(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      }

      // Select an entity from search results
      function selectEntity(direction, id, displayName, typeName) {
        const hiddenInput = document.getElementById(direction + '_entity_id');
        const resultsDiv = document.getElementById(direction + '_entity_results');
        const selectedDiv = document.getElementById(direction + '_entity_selected');
        const searchInput = document.getElementById(direction + '_entity_search');

        hiddenInput.value = id;
        resultsDiv.style.display = 'none';
        searchInput.value = '';

        selectedDiv.innerHTML = '<span class="selected-entity"><a href="/ui/entities/' + id + '">' +
                                escapeHtmlJs(displayName) + '</a> ' +
                                '<span class="muted">(' + escapeHtmlJs(typeName) + ')</span></span>' +
                                '<button type="button" class="button small secondary" onclick="clearEntitySelection(\\'' + direction + '\\')">Clear</button>';
        selectedDiv.classList.remove('hidden');
      }

      // Clear entity selection
      function clearEntitySelection(direction) {
        const hiddenInput = document.getElementById(direction + '_entity_id');
        const selectedDiv = document.getElementById(direction + '_entity_selected');

        hiddenInput.value = '';
        selectedDiv.innerHTML = '';
        selectedDiv.classList.add('hidden');
      }

      // Close search results when clicking outside
      document.addEventListener('click', function(e) {
        if (!e.target.closest('.entity-picker')) {
          document.querySelectorAll('.entity-results').forEach(el => el.style.display = 'none');
        }
      });

      // Handle form submission
      document.getElementById('create-link-form').addEventListener('submit', async function(e) {
        e.preventDefault();

        const typeId = document.getElementById('type_id').value.trim();
        const sourceEntityId = document.getElementById('source_entity_id').value.trim();
        const targetEntityId = document.getElementById('target_entity_id').value.trim();
        const propertiesText = document.getElementById('properties').value;
        const submitBtn = document.getElementById('submit-btn');
        const errorDiv = document.getElementById('json-error');

        // Validate type selection
        if (!typeId) {
          errorDiv.textContent = 'Please select a link type.';
          errorDiv.style.display = 'block';
          return;
        }

        // Validate source entity
        if (!sourceEntityId) {
          errorDiv.textContent = 'Please select a source entity.';
          errorDiv.style.display = 'block';
          return;
        }

        // Validate target entity
        if (!targetEntityId) {
          errorDiv.textContent = 'Please select a target entity.';
          errorDiv.style.display = 'block';
          return;
        }

        // Validate JSON if provided
        let properties = {};
        if (propertiesText && propertiesText.trim()) {
          try {
            properties = JSON.parse(propertiesText);
          } catch (e) {
            errorDiv.textContent = 'Invalid JSON: ' + e.message;
            errorDiv.style.display = 'block';
            return;
          }
        }

        // Disable submit button while processing
        submitBtn.disabled = true;
        submitBtn.textContent = 'Creating...';
        errorDiv.style.display = 'none';

        try {
          const response = await fetch('/api/links', {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              type_id: typeId,
              source_entity_id: sourceEntityId,
              target_entity_id: targetEntityId,
              properties: properties
            })
          });

          const data = await response.json();

          if (response.ok && data.data && data.data.id) {
            // Success - redirect to the new link
            window.location.href = '/ui/links/' + data.data.id;
          } else {
            // Error - show message with details if available
            let errorMessage = data.error || data.message || 'Failed to create link';
            if (data.details && Array.isArray(data.details)) {
              errorMessage += ': ' + data.details.map(d => d.message || d.path).join(', ');
            }
            errorDiv.textContent = errorMessage;
            errorDiv.style.display = 'block';
            submitBtn.disabled = false;
            submitBtn.textContent = 'Create Link';
          }
        } catch (err) {
          errorDiv.textContent = 'Network error: ' + err.message;
          errorDiv.style.display = 'block';
          submitBtn.disabled = false;
          submitBtn.textContent = 'Create Link';
        }
      });

      // Initialize schema hint on page load
      updateSchemaHint();
    </script>

    <style>
      .link-form .form-group {
        margin-bottom: 1.5rem;
      }

      .link-form textarea {
        font-family: var(--font-mono);
        font-size: 0.875rem;
      }

      .required {
        color: var(--color-error);
      }

      .form-hint {
        font-size: 0.875rem;
        color: var(--color-secondary);
        margin-top: 0.25rem;
      }

      .schema-hint {
        background-color: var(--color-muted);
        border: 1px solid var(--color-border);
        border-radius: 0.5rem;
        padding: 1rem;
        margin-bottom: 1.5rem;
      }

      .schema-hint h4 {
        margin-top: 0;
        margin-bottom: 0.5rem;
        font-size: 0.875rem;
        color: var(--color-secondary);
      }

      .schema-hint pre {
        margin: 0;
        max-height: 200px;
        overflow-y: auto;
      }

      .entity-picker {
        position: relative;
      }

      .entity-results {
        position: absolute;
        top: 100%;
        left: 0;
        right: 0;
        background-color: var(--color-bg);
        border: 1px solid var(--color-border);
        border-radius: 0.375rem;
        max-height: 200px;
        overflow-y: auto;
        z-index: 1000;
        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      }

      .entity-result {
        padding: 0.5rem;
        cursor: pointer;
        border-bottom: 1px solid var(--color-border);
      }

      .entity-result:last-child {
        border-bottom: none;
      }

      .entity-result:hover {
        background-color: var(--color-muted);
      }

      .entity-name {
        font-weight: 600;
      }

      .entity-selected {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin-top: 0.5rem;
        padding: 0.5rem;
        background-color: var(--color-muted);
        border-radius: 0.375rem;
      }

      .entity-selected.hidden {
        display: none;
      }

      .selected-entity {
        flex: 1;
      }

      .selected-entity a {
        color: var(--color-primary);
        text-decoration: none;
        font-weight: 600;
      }

      .selected-entity a:hover {
        text-decoration: underline;
      }

      .link-direction {
        display: flex;
        justify-content: center;
        margin: -0.5rem 0;
      }

      .direction-arrow {
        font-size: 1.5rem;
        color: var(--color-secondary);
        font-weight: bold;
      }
    </style>
  `;

  const html = renderPage(
    {
      title: 'Create Link',
      user,
      activePath: '/ui/links',
      breadcrumbs: [
        { label: 'Home', href: '/ui' },
        { label: 'Links', href: '/ui/links' },
        { label: 'Create' },
      ],
    },
    formHtml
  );

  return c.html(html);
});

/**
 * Edit link form
 * GET /ui/links/:id/edit
 * IMPORTANT: This route must be defined BEFORE /links/:id to avoid partial matching issues
 */
ui.get('/links/:id/edit', async c => {
  const user = c.get('user');
  const linkId = c.req.param('id');

  try {
    // Fetch the link with type information
    const link = await c.env.DB.prepare(
      `
      SELECT
        l.id, l.type_id, l.source_entity_id, l.target_entity_id,
        l.properties, l.version, l.created_at, l.created_by,
        l.is_latest, l.is_deleted, l.previous_version_id,
        t.name as type_name, t.description as type_description, t.json_schema as type_json_schema
      FROM links l
      JOIN types t ON l.type_id = t.id
      WHERE l.id = ? AND l.is_latest = 1
    `
    )
      .bind(linkId)
      .first<{
        id: string;
        type_id: string;
        source_entity_id: string;
        target_entity_id: string;
        properties: string;
        version: number;
        created_at: number;
        created_by: string;
        is_latest: number;
        is_deleted: number;
        previous_version_id: string | null;
        type_name: string;
        type_description: string | null;
        type_json_schema: string | null;
      }>();

    if (!link) {
      const content = `
        <div class="error-message">
          <h2>Link Not Found</h2>
          <p>The link with ID "${escapeHtml(linkId)}" could not be found or is not the latest version.</p>
        </div>
        <div class="button-group">
          <a href="/ui/links" class="button secondary">Back to Links</a>
        </div>
      `;

      return c.html(
        renderPage(
          {
            title: 'Link Not Found',
            user,
            activePath: '/ui/links',
            breadcrumbs: [
              { label: 'Home', href: '/ui' },
              { label: 'Links', href: '/ui/links' },
              { label: 'Not Found' },
            ],
          },
          content
        ),
        404
      );
    }

    // Check if link is deleted
    if (link.is_deleted) {
      const content = `
        <div class="error-message">
          <h2>Link Deleted</h2>
          <p>This link has been deleted. You must restore it before editing.</p>
        </div>
        <div class="button-group">
          <a href="/ui/links/${escapeHtml(linkId)}" class="button secondary">Back to Link</a>
        </div>
      `;

      return c.html(
        renderPage(
          {
            title: 'Link Deleted',
            user,
            activePath: '/ui/links',
            breadcrumbs: [
              { label: 'Home', href: '/ui' },
              { label: 'Links', href: '/ui/links' },
              { label: 'Deleted' },
            ],
          },
          content
        ),
        409
      );
    }

    // Fetch source and target entities
    const sourceEntity = await c.env.DB.prepare(
      `
      SELECT e.id, e.properties, t.name as type_name
      FROM entities e
      JOIN types t ON e.type_id = t.id
      WHERE e.id = ? AND e.is_latest = 1
    `
    )
      .bind(link.source_entity_id)
      .first<{ id: string; properties: string; type_name: string }>();

    const targetEntity = await c.env.DB.prepare(
      `
      SELECT e.id, e.properties, t.name as type_name
      FROM entities e
      JOIN types t ON e.type_id = t.id
      WHERE e.id = ? AND e.is_latest = 1
    `
    )
      .bind(link.target_entity_id)
      .first<{ id: string; properties: string; type_name: string }>();

    // Helper function to get display name from properties
    const getDisplayName = (properties: string | undefined, id: string) => {
      if (!properties) return id.substring(0, 8) + '...';
      try {
        const parsed = JSON.parse(properties);
        return parsed.name || parsed.title || parsed.label || id.substring(0, 8) + '...';
      } catch {
        return id.substring(0, 8) + '...';
      }
    };

    const sourceDisplayName = getDisplayName(sourceEntity?.properties, link.source_entity_id);
    const targetDisplayName = getDisplayName(targetEntity?.properties, link.target_entity_id);

    // Parse the properties
    const props = JSON.parse(link.properties);
    const formattedProperties = JSON.stringify(props, null, 2);

    // Get any error message from query params (for validation errors)
    const errorMessage = c.req.query('error') || '';
    const preservedProperties = c.req.query('preserved_properties') || '';

    // Use preserved properties if available, otherwise use current link properties
    let displayProperties = formattedProperties;
    if (preservedProperties) {
      try {
        const parsed = JSON.parse(preservedProperties);
        displayProperties = JSON.stringify(parsed, null, 2);
      } catch {
        displayProperties = preservedProperties;
      }
    }

    // Build the form
    const formHtml = `
      <h2>Edit Link</h2>

      ${
        errorMessage
          ? `
        <div class="error-message">
          <strong>Error:</strong> ${escapeHtml(decodeURIComponent(errorMessage))}
        </div>
      `
          : ''
      }

      <div class="card detail-card">
        <h3>Link Information</h3>
        <dl class="detail-list">
          <dt>ID</dt>
          <dd><code>${escapeHtml(link.id)}</code></dd>

          <dt>Type</dt>
          <dd>
            <span class="badge">${escapeHtml(link.type_name)}</span>
            ${link.type_description ? `<span class="muted small">${escapeHtml(link.type_description)}</span>` : ''}
          </dd>

          <dt>Source Entity</dt>
          <dd>
            <a href="/ui/entities/${link.source_entity_id}">${escapeHtml(sourceDisplayName)}</a>
            <span class="muted small">(${escapeHtml(sourceEntity?.type_name || 'Unknown')})</span>
          </dd>

          <dt>Target Entity</dt>
          <dd>
            <a href="/ui/entities/${link.target_entity_id}">${escapeHtml(targetDisplayName)}</a>
            <span class="muted small">(${escapeHtml(targetEntity?.type_name || 'Unknown')})</span>
          </dd>

          <dt>Current Version</dt>
          <dd>${link.version}</dd>
        </dl>
      </div>

      <div class="link-diagram-preview">
        <div class="link-node-preview">
          <a href="/ui/entities/${link.source_entity_id}">${escapeHtml(sourceDisplayName)}</a>
        </div>
        <div class="link-arrow-preview">→ ${escapeHtml(link.type_name)} →</div>
        <div class="link-node-preview">
          <a href="/ui/entities/${link.target_entity_id}">${escapeHtml(targetDisplayName)}</a>
        </div>
      </div>

      ${
        link.type_json_schema
          ? `
        <div class="schema-hint">
          <h4>Property Schema</h4>
          <pre><code>${escapeHtml(JSON.stringify(JSON.parse(link.type_json_schema), null, 2))}</code></pre>
        </div>
      `
          : ''
      }

      <div class="card">
        <form id="edit-link-form" class="link-form">
          <div class="form-group">
            <label for="properties">Properties (JSON)</label>
            <textarea id="properties" name="properties" rows="15">${escapeHtml(displayProperties)}</textarea>
            <div class="form-hint">Enter valid JSON object with the link properties. A new version will be created.</div>
          </div>

          <div id="json-error" class="error-message" style="display: none;"></div>

          <div class="button-group">
            <button type="submit" class="button" id="submit-btn">Save Changes (Create Version ${link.version + 1})</button>
            <a href="/ui/links/${escapeHtml(link.id)}" class="button secondary">Cancel</a>
          </div>
        </form>
      </div>

      <script>
        // Validate JSON on input
        document.getElementById('properties').addEventListener('input', function() {
          const errorDiv = document.getElementById('json-error');
          if (!this.value || this.value.trim() === '') {
            errorDiv.style.display = 'none';
            this.style.borderColor = '';
            return;
          }
          try {
            JSON.parse(this.value);
            errorDiv.style.display = 'none';
            this.style.borderColor = '';
          } catch (e) {
            errorDiv.textContent = 'Invalid JSON: ' + e.message;
            errorDiv.style.display = 'block';
            this.style.borderColor = 'var(--color-error)';
          }
        });

        // Handle form submission
        document.getElementById('edit-link-form').addEventListener('submit', async function(e) {
          e.preventDefault();

          const propertiesText = document.getElementById('properties').value;
          const submitBtn = document.getElementById('submit-btn');
          const errorDiv = document.getElementById('json-error');

          // Validate JSON
          let properties = {};
          if (propertiesText && propertiesText.trim()) {
            try {
              properties = JSON.parse(propertiesText);
            } catch (e) {
              errorDiv.textContent = 'Invalid JSON: ' + e.message;
              errorDiv.style.display = 'block';
              return;
            }
          }

          // Disable submit button while processing
          submitBtn.disabled = true;
          submitBtn.textContent = 'Saving...';
          errorDiv.style.display = 'none';

          try {
            const response = await fetch('/api/links/${escapeHtml(link.id)}', {
              method: 'PUT',
              credentials: 'include',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                properties: properties
              })
            });

            const data = await response.json();

            if (response.ok && data.data && data.data.id) {
              // Success - redirect to the new version
              window.location.href = '/ui/links/' + data.data.id;
            } else {
              // Error - show message with details if available
              let errorMessage = data.error || data.message || 'Failed to update link';
              if (data.details && Array.isArray(data.details)) {
                errorMessage += ': ' + data.details.map(d => d.message || d.path).join(', ');
              }
              errorDiv.textContent = errorMessage;
              errorDiv.style.display = 'block';
              submitBtn.disabled = false;
              submitBtn.textContent = 'Save Changes (Create Version ${link.version + 1})';
            }
          } catch (err) {
            errorDiv.textContent = 'Network error: ' + err.message;
            errorDiv.style.display = 'block';
            submitBtn.disabled = false;
            submitBtn.textContent = 'Save Changes (Create Version ${link.version + 1})';
          }
        });
      </script>

      <style>
        .link-form .form-group {
          margin-bottom: 1.5rem;
        }

        .link-form textarea {
          font-family: var(--font-mono);
          font-size: 0.875rem;
        }

        .schema-hint {
          background-color: var(--color-muted);
          border: 1px solid var(--color-border);
          border-radius: 0.5rem;
          padding: 1rem;
          margin-bottom: 1.5rem;
        }

        .schema-hint h4 {
          margin-top: 0;
          margin-bottom: 0.5rem;
          font-size: 0.875rem;
          color: var(--color-secondary);
        }

        .schema-hint pre {
          margin: 0;
          max-height: 200px;
          overflow-y: auto;
        }

        .link-diagram-preview {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 1rem;
          padding: 1rem;
          background-color: var(--color-muted);
          border-radius: 0.5rem;
          margin: 1rem 0;
        }

        .link-node-preview {
          padding: 0.5rem 1rem;
          background-color: var(--color-bg);
          border: 1px solid var(--color-border);
          border-radius: 0.375rem;
        }

        .link-node-preview a {
          color: var(--color-primary);
          text-decoration: none;
          font-weight: 600;
        }

        .link-node-preview a:hover {
          text-decoration: underline;
        }

        .link-arrow-preview {
          color: var(--color-secondary);
          font-weight: 600;
        }

        @media (max-width: 768px) {
          .link-diagram-preview {
            flex-direction: column;
            gap: 0.5rem;
          }

          .link-arrow-preview {
            transform: rotate(90deg);
          }
        }
      </style>
    `;

    const html = renderPage(
      {
        title: `Edit Link`,
        user,
        activePath: '/ui/links',
        breadcrumbs: [
          { label: 'Home', href: '/ui' },
          { label: 'Links', href: '/ui/links' },
          { label: link.id.substring(0, 8) + '...', href: `/ui/links/${link.id}` },
          { label: 'Edit' },
        ],
      },
      formHtml
    );

    return c.html(html);
  } catch (error) {
    console.error('Error fetching link for edit:', error);
    const content = `
      <div class="error-message">
        <h2>Error</h2>
        <p>An error occurred while fetching the link. Please try again later.</p>
      </div>
      <div class="button-group">
        <a href="/ui/links" class="button secondary">Back to Links</a>
      </div>
    `;

    return c.html(
      renderPage(
        {
          title: 'Error',
          user,
          activePath: '/ui/links',
          breadcrumbs: [
            { label: 'Home', href: '/ui' },
            { label: 'Links', href: '/ui/links' },
            { label: 'Error' },
          ],
        },
        content
      ),
      500
    );
  }
});

/**
 * Link detail view
 * GET /ui/links/:id
 */
ui.get('/links/:id', async c => {
  const user = c.get('user');
  const linkId = c.req.param('id');

  try {
    // Fetch the link with type and entity information
    const link = await c.env.DB.prepare(
      `
      SELECT
        l.id, l.type_id, l.source_entity_id, l.target_entity_id,
        l.properties, l.version, l.created_at, l.created_by,
        l.is_latest, l.is_deleted, l.previous_version_id,
        t.name as type_name, t.description as type_description, t.json_schema as type_json_schema,
        u.display_name as created_by_name, u.email as created_by_email
      FROM links l
      JOIN types t ON l.type_id = t.id
      LEFT JOIN users u ON l.created_by = u.id
      WHERE l.id = ?
    `
    )
      .bind(linkId)
      .first<{
        id: string;
        type_id: string;
        source_entity_id: string;
        target_entity_id: string;
        properties: string;
        version: number;
        created_at: number;
        created_by: string;
        is_latest: number;
        is_deleted: number;
        previous_version_id: string | null;
        type_name: string;
        type_description: string | null;
        type_json_schema: string | null;
        created_by_name: string | null;
        created_by_email: string;
      }>();

    if (!link) {
      const content = `
        <div class="error-message">
          <h2>Link Not Found</h2>
          <p>The link with ID "${escapeHtml(linkId)}" could not be found.</p>
        </div>
        <div class="button-group">
          <a href="/ui/links" class="button secondary">Back to Links</a>
        </div>
      `;

      return c.html(
        renderPage(
          {
            title: 'Link Not Found',
            user,
            activePath: '/ui/links',
            breadcrumbs: [
              { label: 'Home', href: '/ui' },
              { label: 'Links', href: '/ui/links' },
              { label: 'Not Found' },
            ],
          },
          content
        ),
        404
      );
    }

    // Fetch source entity
    const sourceEntity = await c.env.DB.prepare(
      `
      SELECT e.id, e.properties, e.is_deleted, t.name as type_name
      FROM entities e
      JOIN types t ON e.type_id = t.id
      WHERE e.id = ? AND e.is_latest = 1
    `
    )
      .bind(link.source_entity_id)
      .first<{
        id: string;
        properties: string;
        is_deleted: number;
        type_name: string;
      }>();

    // Fetch target entity
    const targetEntity = await c.env.DB.prepare(
      `
      SELECT e.id, e.properties, e.is_deleted, t.name as type_name
      FROM entities e
      JOIN types t ON e.type_id = t.id
      WHERE e.id = ? AND e.is_latest = 1
    `
    )
      .bind(link.target_entity_id)
      .first<{
        id: string;
        properties: string;
        is_deleted: number;
        type_name: string;
      }>();

    // Parse properties
    const props = JSON.parse(link.properties);

    // Check if viewing an old version and find latest version ID if so
    let latestVersionId: string | null = null;
    if (!link.is_latest) {
      const latest = await c.env.DB.prepare(
        `
        WITH RECURSIVE version_chain AS (
          SELECT id, is_latest FROM links WHERE id = ?
          UNION ALL
          SELECT l.id, l.is_latest FROM links l
          INNER JOIN version_chain vc ON l.previous_version_id = vc.id
        )
        SELECT id FROM version_chain WHERE is_latest = 1 LIMIT 1
      `
      )
        .bind(linkId)
        .first<{ id: string }>();
      latestVersionId = latest?.id || null;
    }

    // Fetch version history (all versions of this link chain)
    const versionHistory = await c.env.DB.prepare(
      `
      WITH RECURSIVE version_chain_back AS (
        SELECT id, type_id, source_entity_id, target_entity_id, properties, version, created_at, created_by, is_latest, is_deleted, previous_version_id
        FROM links WHERE id = ?
        UNION ALL
        SELECT l.id, l.type_id, l.source_entity_id, l.target_entity_id, l.properties, l.version, l.created_at, l.created_by, l.is_latest, l.is_deleted, l.previous_version_id
        FROM links l
        INNER JOIN version_chain_back vc ON l.id = vc.previous_version_id
      ),
      version_chain_forward AS (
        SELECT id, type_id, source_entity_id, target_entity_id, properties, version, created_at, created_by, is_latest, is_deleted, previous_version_id
        FROM links WHERE id = ?
        UNION ALL
        SELECT l.id, l.type_id, l.source_entity_id, l.target_entity_id, l.properties, l.version, l.created_at, l.created_by, l.is_latest, l.is_deleted, l.previous_version_id
        FROM links l
        INNER JOIN version_chain_forward vc ON l.previous_version_id = vc.id
      )
      SELECT DISTINCT v.*, u.display_name as created_by_name, u.email as created_by_email
      FROM (
        SELECT * FROM version_chain_back
        UNION
        SELECT * FROM version_chain_forward
      ) v
      LEFT JOIN users u ON v.created_by = u.id
      ORDER BY v.version DESC
    `
    )
      .bind(linkId, linkId)
      .all<{
        id: string;
        type_id: string;
        source_entity_id: string;
        target_entity_id: string;
        properties: string;
        version: number;
        created_at: number;
        created_by: string;
        is_latest: number;
        is_deleted: number;
        previous_version_id: string | null;
        created_by_name: string | null;
        created_by_email: string;
      }>();

    // Fetch ACL data for the link (only for latest version)
    let linkAclEntries: EnrichedAclEntry[] = [];
    let linkAclId: number | null = null;
    if (link.is_latest) {
      linkAclId = await getLinkAclId(c.env.DB, link.id);
      if (linkAclId !== null) {
        linkAclEntries = await getEnrichedAclEntries(c.env.DB, linkAclId);
      }
    }

    // Helper to get entity display name
    const getEntityDisplayName = (entityProps: string | undefined, entityId: string) => {
      if (!entityProps) return entityId.substring(0, 8) + '...';
      try {
        const parsed = JSON.parse(entityProps);
        return parsed.name || parsed.title || parsed.label || entityId.substring(0, 8) + '...';
      } catch {
        return entityId.substring(0, 8) + '...';
      }
    };

    const sourceDisplayName = getEntityDisplayName(sourceEntity?.properties, link.source_entity_id);
    const targetDisplayName = getEntityDisplayName(targetEntity?.properties, link.target_entity_id);

    // Build visual representation
    const visualRepresentation = `
      <div class="link-diagram">
        <div class="link-node source ${sourceEntity?.is_deleted ? 'deleted' : ''}">
          <a href="/ui/entities/${link.source_entity_id}">${escapeHtml(sourceDisplayName)}</a>
          <div class="node-type">${escapeHtml(sourceEntity?.type_name || 'Unknown')}</div>
        </div>
        <div class="link-arrow">
          <div class="arrow-line"></div>
          <div class="arrow-label">${escapeHtml(link.type_name)}</div>
          <div class="arrow-head"></div>
        </div>
        <div class="link-node target ${targetEntity?.is_deleted ? 'deleted' : ''}">
          <a href="/ui/entities/${link.target_entity_id}">${escapeHtml(targetDisplayName)}</a>
          <div class="node-type">${escapeHtml(targetEntity?.type_name || 'Unknown')}</div>
        </div>
      </div>
      <style>
        .link-diagram {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 0;
          padding: 2rem;
          background-color: var(--color-muted);
          border-radius: 0.5rem;
          margin: 1rem 0;
          overflow-x: auto;
        }

        .link-node {
          background-color: var(--color-bg);
          border: 2px solid var(--color-primary);
          border-radius: 0.5rem;
          padding: 1rem 1.5rem;
          text-align: center;
          min-width: 120px;
        }

        .link-node.deleted {
          border-color: var(--color-error);
          opacity: 0.7;
        }

        .link-node a {
          color: var(--color-fg);
          text-decoration: none;
          font-weight: 600;
          font-size: 1rem;
        }

        .link-node a:hover {
          color: var(--color-primary);
        }

        .node-type {
          font-size: 0.75rem;
          color: var(--color-secondary);
          margin-top: 0.25rem;
        }

        .link-arrow {
          display: flex;
          align-items: center;
          position: relative;
          min-width: 120px;
        }

        .arrow-line {
          flex: 1;
          height: 2px;
          background-color: var(--color-secondary);
        }

        .arrow-label {
          position: absolute;
          top: -1.5rem;
          left: 50%;
          transform: translateX(-50%);
          background-color: var(--color-muted);
          padding: 0.25rem 0.5rem;
          font-size: 0.75rem;
          color: var(--color-secondary);
          white-space: nowrap;
        }

        .arrow-head {
          width: 0;
          height: 0;
          border-left: 8px solid var(--color-secondary);
          border-top: 6px solid transparent;
          border-bottom: 6px solid transparent;
        }

        @media (max-width: 768px) {
          .link-diagram {
            flex-direction: column;
            gap: 0.5rem;
          }

          .link-arrow {
            transform: rotate(90deg);
            min-width: 60px;
          }

          .arrow-label {
            transform: translateX(-50%) rotate(-90deg);
            top: auto;
            left: -2rem;
          }
        }
      </style>
    `;

    // Build link info section
    const linkInfoSection = `
      <div class="card detail-card">
        <h3>Link Information</h3>
        <dl class="detail-list">
          <dt>ID</dt>
          <dd><code>${escapeHtml(link.id)}</code></dd>

          <dt>Type</dt>
          <dd>
            <span class="badge">${escapeHtml(link.type_name)}</span>
            ${link.type_description ? `<span class="muted small">${escapeHtml(link.type_description)}</span>` : ''}
          </dd>

          <dt>Source Entity</dt>
          <dd>
            <a href="/ui/entities/${link.source_entity_id}">${escapeHtml(sourceDisplayName)}</a>
            <span class="muted small">(${escapeHtml(sourceEntity?.type_name || 'Unknown')})</span>
            ${sourceEntity?.is_deleted ? '<span class="badge danger small">Deleted</span>' : ''}
          </dd>

          <dt>Target Entity</dt>
          <dd>
            <a href="/ui/entities/${link.target_entity_id}">${escapeHtml(targetDisplayName)}</a>
            <span class="muted small">(${escapeHtml(targetEntity?.type_name || 'Unknown')})</span>
            ${targetEntity?.is_deleted ? '<span class="badge danger small">Deleted</span>' : ''}
          </dd>

          <dt>Version</dt>
          <dd>${link.version}${link.previous_version_id ? ` <span class="muted">(previous: <a href="/ui/links/${link.previous_version_id}">${link.previous_version_id.substring(0, 8)}...</a>)</span>` : ''}</dd>

          <dt>Created By</dt>
          <dd>${escapeHtml(link.created_by_name || link.created_by_email)}</dd>

          <dt>Created At</dt>
          <dd>${formatTimestamp(link.created_at)}</dd>

          <dt>Status</dt>
          <dd>
            ${link.is_latest ? '<span class="badge success">Latest</span>' : '<span class="badge muted">Old Version</span>'}
            ${link.is_deleted ? '<span class="badge danger">Deleted</span>' : ''}
          </dd>
        </dl>
      </div>
    `;

    // Build properties section
    const propertiesSection = `
      <div class="card">
        <h3>Properties</h3>
        ${link.type_json_schema ? '<p class="muted small">This type has JSON schema validation. <a href="/ui/types">View type details</a></p>' : ''}
        <pre><code>${escapeHtml(JSON.stringify(props, null, 2))}</code></pre>
      </div>
    `;

    // Build ACL section (only for latest version)
    const linkAclSection = link.is_latest
      ? `
      <div class="card" id="link-acl-section">
        <h3>Access Control</h3>
        ${
          linkAclId === null
            ? `
          <p class="muted">This link is <strong>public</strong> - accessible to all authenticated users.</p>
        `
            : `
          <table class="data-table">
            <thead>
              <tr>
                <th>Principal</th>
                <th>Type</th>
                <th>Permission</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${linkAclEntries
                .map(
                  entry => `
                <tr data-principal-type="${escapeHtml(entry.principal_type)}" data-principal-id="${escapeHtml(entry.principal_id)}" data-permission="${escapeHtml(entry.permission)}">
                  <td>
                    ${entry.principal_type === 'user' ? `<span>${escapeHtml(entry.principal_name || entry.principal_id)}</span>${entry.principal_email ? ` <span class="muted small">(${escapeHtml(entry.principal_email)})</span>` : ''}` : `<span>${escapeHtml(entry.principal_name || entry.principal_id)}</span> <span class="muted small">(group)</span>`}
                  </td>
                  <td><span class="badge ${entry.principal_type === 'user' ? '' : 'muted'}">${escapeHtml(entry.principal_type)}</span></td>
                  <td><span class="badge ${entry.permission === 'write' ? 'success' : ''}">${escapeHtml(entry.permission)}</span></td>
                  <td>
                    <button class="button small danger" onclick="removeLinkAclEntry('${escapeHtml(entry.principal_type)}', '${escapeHtml(entry.principal_id)}', '${escapeHtml(entry.permission)}')">Remove</button>
                  </td>
                </tr>
              `
                )
                .join('')}
            </tbody>
          </table>
        `
        }

        <div class="acl-form" style="margin-top: 1rem;">
          <h4>Add Permission</h4>
          <form id="add-link-acl-form" onsubmit="addLinkAclEntry(event)" style="display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: end;">
            <div style="flex: 0 0 auto;">
              <label for="link-principal-type" class="small">Type</label>
              <select id="link-principal-type" name="principal_type" required onchange="updateLinkPrincipalSearch()">
                <option value="user">User</option>
                <option value="group">Group</option>
              </select>
            </div>
            <div style="flex: 1 1 200px; position: relative;">
              <label for="link-principal-search" class="small">Principal</label>
              <input type="text" id="link-principal-search" placeholder="Search users or groups..." autocomplete="off" required />
              <input type="hidden" id="link-principal-id" name="principal_id" required />
              <div id="link-principal-suggestions" class="autocomplete-dropdown" style="display: none;"></div>
            </div>
            <div style="flex: 0 0 auto;">
              <label for="link-permission" class="small">Permission</label>
              <select id="link-permission" name="permission" required>
                <option value="read">Read</option>
                <option value="write">Write</option>
              </select>
            </div>
            <div style="flex: 0 0 auto;">
              <button type="submit" class="button">Add</button>
            </div>
          </form>
        </div>

        <div class="button-group" style="margin-top: 1rem;">
          ${linkAclId !== null ? '<button class="button secondary" onclick="makeLinkPublic()">Make Public</button>' : ''}
          ${linkAclId === null ? '<button class="button secondary" onclick="makeLinkPrivate()">Make Private (Owner Only)</button>' : ''}
        </div>

        <style>
          .acl-form label {
            display: block;
            margin-bottom: 0.25rem;
            color: var(--color-secondary);
          }
          .acl-form select, .acl-form input[type="text"] {
            padding: 0.5rem;
            border: 1px solid var(--color-border);
            border-radius: 0.25rem;
            background-color: var(--color-bg);
            color: var(--color-fg);
          }
          .autocomplete-dropdown {
            position: absolute;
            top: 100%;
            left: 0;
            right: 0;
            background-color: var(--color-bg);
            border: 1px solid var(--color-border);
            border-radius: 0.25rem;
            max-height: 200px;
            overflow-y: auto;
            z-index: 100;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
          }
          .autocomplete-item {
            padding: 0.5rem;
            cursor: pointer;
          }
          .autocomplete-item:hover {
            background-color: var(--color-muted);
          }
          .autocomplete-item .principal-name {
            font-weight: 500;
          }
          .autocomplete-item .principal-email {
            color: var(--color-secondary);
            font-size: 0.875rem;
          }
        </style>

        <script>
          const linkId = '${escapeHtml(link.id)}';
          let currentLinkAclEntries = ${JSON.stringify(linkAclEntries.map(e => ({ principal_type: e.principal_type, principal_id: e.principal_id, permission: e.permission })))};
          let linkSearchTimeout = null;

          function updateLinkPrincipalSearch() {
            document.getElementById('link-principal-search').value = '';
            document.getElementById('link-principal-id').value = '';
            document.getElementById('link-principal-suggestions').style.display = 'none';
          }

          document.getElementById('link-principal-search').addEventListener('input', function(e) {
            const query = e.target.value;
            const principalType = document.getElementById('link-principal-type').value;

            if (query.length < 2) {
              document.getElementById('link-principal-suggestions').style.display = 'none';
              return;
            }

            clearTimeout(linkSearchTimeout);
            linkSearchTimeout = setTimeout(() => searchLinkPrincipals(query, principalType), 300);
          });

          async function searchLinkPrincipals(query, type) {
            const suggestionsDiv = document.getElementById('link-principal-suggestions');
            try {
              const endpoint = type === 'user'
                ? '/api/users/search?q=' + encodeURIComponent(query)
                : '/api/groups?q=' + encodeURIComponent(query);
              const response = await fetch(endpoint, { credentials: 'include' });
              const result = await response.json();

              if (!result.data) {
                suggestionsDiv.style.display = 'none';
                return;
              }

              const items = type === 'user' ? result.data : result.data.groups || result.data;
              // For users, the search is already done server-side. For groups, filter client-side.
              const filtered = type === 'user' ? items.slice(0, 10) : items.filter(item => {
                const searchLower = query.toLowerCase();
                return item.name && item.name.toLowerCase().includes(searchLower);
              }).slice(0, 10);

              if (filtered.length === 0) {
                suggestionsDiv.innerHTML = '<div class="autocomplete-item muted">No results found</div>';
                suggestionsDiv.style.display = 'block';
                return;
              }

              suggestionsDiv.innerHTML = filtered.map(item => {
                if (type === 'user') {
                  return \`<div class="autocomplete-item" onclick="selectLinkPrincipal('\${item.id}', '\${escapeHtmlJsLink(item.display_name || item.email)}')">
                    <div class="principal-name">\${escapeHtmlJsLink(item.display_name || item.email)}</div>
                    \${item.display_name ? \`<div class="principal-email">\${escapeHtmlJsLink(item.email)}</div>\` : ''}
                  </div>\`;
                } else {
                  return \`<div class="autocomplete-item" onclick="selectLinkPrincipal('\${item.id}', '\${escapeHtmlJsLink(item.name)}')">
                    <div class="principal-name">\${escapeHtmlJsLink(item.name)}</div>
                    \${item.description ? \`<div class="principal-email">\${escapeHtmlJsLink(item.description)}</div>\` : ''}
                  </div>\`;
                }
              }).join('');
              suggestionsDiv.style.display = 'block';
            } catch (err) {
              console.error('Error searching principals:', err);
              suggestionsDiv.style.display = 'none';
            }
          }

          function escapeHtmlJsLink(str) {
            if (!str) return '';
            return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
          }

          function selectLinkPrincipal(id, name) {
            document.getElementById('link-principal-id').value = id;
            document.getElementById('link-principal-search').value = name;
            document.getElementById('link-principal-suggestions').style.display = 'none';
          }

          // Close suggestions when clicking outside
          document.addEventListener('click', function(e) {
            if (!e.target.closest('#add-link-acl-form')) {
              document.getElementById('link-principal-suggestions').style.display = 'none';
            }
          });

          async function addLinkAclEntry(event) {
            event.preventDefault();
            const principalType = document.getElementById('link-principal-type').value;
            const principalId = document.getElementById('link-principal-id').value;
            const permission = document.getElementById('link-permission').value;

            if (!principalId) {
              alert('Please select a principal from the search results.');
              return;
            }

            // Check if entry already exists
            const exists = currentLinkAclEntries.some(e =>
              e.principal_type === principalType &&
              e.principal_id === principalId &&
              e.permission === permission
            );

            if (exists) {
              alert('This permission already exists.');
              return;
            }

            // Add new entry to current entries
            const newEntries = [...currentLinkAclEntries, { principal_type: principalType, principal_id: principalId, permission: permission }];

            try {
              const response = await fetch('/api/links/' + linkId + '/acl', {
                method: 'PUT',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entries: newEntries })
              });

              if (response.ok) {
                const result = await response.json();
                if (result.data && result.data.new_version_id) {
                  window.location.href = '/ui/links/' + result.data.new_version_id;
                } else {
                  window.location.reload();
                }
              } else {
                const result = await response.json();
                alert('Error: ' + (result.error || 'Failed to add permission'));
              }
            } catch (err) {
              alert('Error: ' + err.message);
            }
          }

          async function removeLinkAclEntry(principalType, principalId, permission) {
            if (!confirm('Are you sure you want to remove this permission?')) return;

            const newEntries = currentLinkAclEntries.filter(e =>
              !(e.principal_type === principalType && e.principal_id === principalId && e.permission === permission)
            );

            try {
              const response = await fetch('/api/links/' + linkId + '/acl', {
                method: 'PUT',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entries: newEntries })
              });

              if (response.ok) {
                const result = await response.json();
                if (result.data && result.data.new_version_id) {
                  window.location.href = '/ui/links/' + result.data.new_version_id;
                } else {
                  window.location.reload();
                }
              } else {
                const result = await response.json();
                alert('Error: ' + (result.error || 'Failed to remove permission'));
              }
            } catch (err) {
              alert('Error: ' + err.message);
            }
          }

          async function makeLinkPublic() {
            if (!confirm('Are you sure you want to make this link public? All authenticated users will be able to access it.')) return;

            try {
              const response = await fetch('/api/links/' + linkId + '/acl', {
                method: 'PUT',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entries: [] })
              });

              if (response.ok) {
                const result = await response.json();
                if (result.data && result.data.new_version_id) {
                  window.location.href = '/ui/links/' + result.data.new_version_id;
                } else {
                  window.location.reload();
                }
              } else {
                const result = await response.json();
                alert('Error: ' + (result.error || 'Failed to make link public'));
              }
            } catch (err) {
              alert('Error: ' + err.message);
            }
          }

          async function makeLinkPrivate() {
            // Get the current user's ID from the page context or fetch it
            try {
              const meResponse = await fetch('/api/auth/me', { credentials: 'include' });
              if (!meResponse.ok) {
                alert('Please log in to set permissions.');
                return;
              }
              const meResult = await meResponse.json();
              const userId = meResult.data?.id;

              if (!userId) {
                alert('Could not determine current user.');
                return;
              }

              if (!confirm('Are you sure you want to make this link private? Only you will have access.')) return;

              const response = await fetch('/api/links/' + linkId + '/acl', {
                method: 'PUT',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  entries: [{ principal_type: 'user', principal_id: userId, permission: 'write' }]
                })
              });

              if (response.ok) {
                const result = await response.json();
                if (result.data && result.data.new_version_id) {
                  window.location.href = '/ui/links/' + result.data.new_version_id;
                } else {
                  window.location.reload();
                }
              } else {
                const result = await response.json();
                alert('Error: ' + (result.error || 'Failed to make link private'));
              }
            } catch (err) {
              alert('Error: ' + err.message);
            }
          }
        </script>
      </div>
    `
      : '';

    // Build version history section
    const versionHistorySection = `
      <div class="card">
        <h3>Version History (${versionHistory.results.length} versions)</h3>
        <div class="version-timeline">
          ${versionHistory.results
            .map(version => {
              const isCurrentView = version.id === linkId;
              const changePreview = getLinkChangePreview(version, versionHistory.results);

              return `
              <div class="version-item ${isCurrentView ? 'current' : ''}">
                <div class="version-header">
                  <span class="version-number">
                    ${isCurrentView ? `<strong>Version ${version.version}</strong> (viewing)` : `<a href="/ui/links/${version.id}">Version ${version.version}</a>`}
                  </span>
                  ${version.is_latest ? '<span class="badge success small">Latest</span>' : ''}
                  ${version.is_deleted ? '<span class="badge danger small">Deleted</span>' : ''}
                </div>
                <div class="version-meta">
                  Modified by ${escapeHtml(version.created_by_name || version.created_by_email)} on ${formatTimestamp(version.created_at)}
                </div>
                ${changePreview ? `<div class="version-changes">${changePreview}</div>` : ''}
              </div>
            `;
            })
            .join('')}
        </div>
      </div>
    `;

    // Build actions section
    const actionsSection = `
      <div class="card">
        <h3>Actions</h3>
        <div class="button-group">
          ${!link.is_deleted && link.is_latest ? `<a href="/ui/links/${link.id}/edit" class="button">Edit Link</a>` : ''}
          ${!link.is_deleted && link.is_latest ? `<button class="button danger" onclick="confirmDeleteLink('${link.id}')">Delete Link</button>` : ''}
          ${link.is_deleted && link.is_latest ? `<button class="button" onclick="confirmRestoreLink('${link.id}')">Restore Link</button>` : ''}
          <a href="/api/links/${link.id}" class="button secondary" target="_blank">Export as JSON</a>
        </div>
      </div>

      <script>
        function confirmDeleteLink(linkId) {
          if (confirm('Are you sure you want to delete this link? This action creates a new deleted version.')) {
            fetch('/api/links/' + linkId, { method: 'DELETE' })
              .then(res => {
                if (res.ok) {
                  window.location.reload();
                } else {
                  return res.json().then(data => {
                    alert('Error: ' + (data.error || 'Failed to delete link'));
                  });
                }
              })
              .catch(err => {
                alert('Error: ' + err.message);
              });
          }
        }

        function confirmRestoreLink(linkId) {
          if (confirm('Are you sure you want to restore this link?')) {
            fetch('/api/links/' + linkId + '/restore', { method: 'POST' })
              .then(res => {
                if (res.ok) {
                  window.location.reload();
                } else {
                  return res.json().then(data => {
                    alert('Error: ' + (data.error || 'Failed to restore link'));
                  });
                }
              })
              .catch(err => {
                alert('Error: ' + err.message);
              });
          }
        }
      </script>
    `;

    // Build the banner for old versions
    const oldVersionBanner = !link.is_latest
      ? `
      <div class="warning-message">
        <strong>Viewing old version</strong> - You are viewing version ${link.version} of this link.
        ${latestVersionId ? `<a href="/ui/links/${latestVersionId}">View latest version</a>` : ''}
      </div>
    `
      : '';

    const content = `
      <h2>Link: ${escapeHtml(link.type_name)}</h2>
      ${oldVersionBanner}
      ${visualRepresentation}
      ${linkInfoSection}
      ${propertiesSection}
      ${linkAclSection}
      ${versionHistorySection}
      ${actionsSection}

      <div class="button-group">
        <a href="/ui/links" class="button secondary">Back to Links</a>
        <a href="/ui/entities/${link.source_entity_id}" class="button secondary">View Source Entity</a>
        <a href="/ui/entities/${link.target_entity_id}" class="button secondary">View Target Entity</a>
      </div>
    `;

    const html = renderPage(
      {
        title: `${link.type_name} Link - Detail`,
        user,
        activePath: '/ui/links',
        breadcrumbs: [
          { label: 'Home', href: '/ui' },
          { label: 'Links', href: '/ui/links' },
          { label: link.id.substring(0, 8) + '...' },
        ],
      },
      content
    );

    return c.html(html);
  } catch (error) {
    console.error('Error fetching link:', error);
    const content = `
      <div class="error-message">
        <h2>Error</h2>
        <p>An error occurred while fetching the link. Please try again later.</p>
      </div>
      <div class="button-group">
        <a href="/ui/links" class="button secondary">Back to Links</a>
      </div>
    `;

    return c.html(
      renderPage(
        {
          title: 'Error',
          user,
          activePath: '/ui/links',
          breadcrumbs: [
            { label: 'Home', href: '/ui' },
            { label: 'Links', href: '/ui/links' },
            { label: 'Error' },
          ],
        },
        content
      ),
      500
    );
  }
});

/**
 * Helper function to get a change preview for link version history
 */
function getLinkChangePreview(
  version: {
    version: number;
    properties: string;
    is_deleted: number;
    previous_version_id: string | null;
  },
  allVersions: Array<{
    id: string;
    version: number;
    properties: string;
    is_deleted: number;
    previous_version_id: string | null;
  }>
): string {
  if (version.version === 1) {
    return '<span class="muted">Initial version</span>';
  }

  // Find the previous version
  const prevVersion = allVersions.find(v => v.version === version.version - 1);
  if (!prevVersion) {
    return '';
  }

  const prevProps = JSON.parse(prevVersion.properties);
  const currProps = JSON.parse(version.properties);

  const changes: string[] = [];

  // Check for status change
  if (version.is_deleted && !prevVersion.is_deleted) {
    changes.push('Deleted');
  } else if (!version.is_deleted && prevVersion.is_deleted) {
    changes.push('Restored');
  }

  // Check for property changes
  const allKeys = new Set([...Object.keys(prevProps), ...Object.keys(currProps)]);
  for (const key of allKeys) {
    if (!(key in prevProps)) {
      changes.push(`Added "${key}"`);
    } else if (!(key in currProps)) {
      changes.push(`Removed "${key}"`);
    } else if (JSON.stringify(prevProps[key]) !== JSON.stringify(currProps[key])) {
      changes.push(`Changed "${key}"`);
    }
  }

  if (changes.length === 0) {
    return '<span class="muted">No property changes</span>';
  }

  return (
    '<span class="muted">' +
    changes.slice(0, 3).join(', ') +
    (changes.length > 3 ? '...' : '') +
    '</span>'
  );
}

/**
 * Link Version History List
 * GET /ui/links/:id/versions
 * Lists all versions of a link
 */
ui.get('/links/:id/versions', async c => {
  const user = c.get('user');
  const linkId = c.req.param('id');

  try {
    // Fetch all versions of this link chain
    const versionHistory = await c.env.DB.prepare(
      `
      WITH RECURSIVE version_chain_back AS (
        SELECT id, type_id, source_entity_id, target_entity_id, properties, version, created_at, created_by, is_latest, is_deleted, previous_version_id
        FROM links WHERE id = ?
        UNION ALL
        SELECT l.id, l.type_id, l.source_entity_id, l.target_entity_id, l.properties, l.version, l.created_at, l.created_by, l.is_latest, l.is_deleted, l.previous_version_id
        FROM links l
        INNER JOIN version_chain_back vc ON l.id = vc.previous_version_id
      ),
      version_chain_forward AS (
        SELECT id, type_id, source_entity_id, target_entity_id, properties, version, created_at, created_by, is_latest, is_deleted, previous_version_id
        FROM links WHERE id = ?
        UNION ALL
        SELECT l.id, l.type_id, l.source_entity_id, l.target_entity_id, l.properties, l.version, l.created_at, l.created_by, l.is_latest, l.is_deleted, l.previous_version_id
        FROM links l
        INNER JOIN version_chain_forward vc ON l.previous_version_id = vc.id
      )
      SELECT DISTINCT v.*,
        u.display_name as created_by_name, u.email as created_by_email,
        t.name as type_name
      FROM (
        SELECT * FROM version_chain_back
        UNION
        SELECT * FROM version_chain_forward
      ) v
      LEFT JOIN users u ON v.created_by = u.id
      LEFT JOIN types t ON v.type_id = t.id
      ORDER BY v.version DESC
    `
    )
      .bind(linkId, linkId)
      .all<{
        id: string;
        type_id: string;
        source_entity_id: string;
        target_entity_id: string;
        properties: string;
        version: number;
        created_at: number;
        created_by: string;
        is_latest: number;
        is_deleted: number;
        previous_version_id: string | null;
        created_by_name: string | null;
        created_by_email: string;
        type_name: string;
      }>();

    if (versionHistory.results.length === 0) {
      const content = `
        <div class="error-message">
          <h2>Link Not Found</h2>
          <p>The link with ID "${escapeHtml(linkId)}" could not be found.</p>
        </div>
        <div class="button-group">
          <a href="/ui/links" class="button secondary">Back to Links</a>
        </div>
      `;

      return c.html(
        renderPage(
          {
            title: 'Link Not Found',
            user,
            activePath: '/ui/links',
            breadcrumbs: [
              { label: 'Home', href: '/ui' },
              { label: 'Links', href: '/ui/links' },
              { label: 'Not Found' },
            ],
          },
          content
        ),
        404
      );
    }

    // Get the latest version for display
    const latestVersion =
      versionHistory.results.find(v => v.is_latest === 1) || versionHistory.results[0];

    // Fetch source and target entity names for display
    const sourceEntity = await c.env.DB.prepare(
      'SELECT properties FROM entities WHERE id = ? AND is_latest = 1'
    )
      .bind(latestVersion.source_entity_id)
      .first<{ properties: string }>();

    const targetEntity = await c.env.DB.prepare(
      'SELECT properties FROM entities WHERE id = ? AND is_latest = 1'
    )
      .bind(latestVersion.target_entity_id)
      .first<{ properties: string }>();

    const getEntityDisplayName = (props: string | undefined, entityId: string) => {
      if (!props) return entityId.substring(0, 8) + '...';
      try {
        const parsed = JSON.parse(props);
        return parsed.name || parsed.title || parsed.label || entityId.substring(0, 8) + '...';
      } catch {
        return entityId.substring(0, 8) + '...';
      }
    };

    const sourceDisplayName = getEntityDisplayName(
      sourceEntity?.properties,
      latestVersion.source_entity_id
    );
    const targetDisplayName = getEntityDisplayName(
      targetEntity?.properties,
      latestVersion.target_entity_id
    );

    // Build version history table
    const versionTable = `
      <table class="data-table">
        <thead>
          <tr>
            <th>Version</th>
            <th>Status</th>
            <th>Modified By</th>
            <th>Modified At</th>
            <th>Properties Preview</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${versionHistory.results
            .map(version => {
              const versionProps = JSON.parse(version.properties);
              const propsPreview = JSON.stringify(versionProps);
              const truncatedProps =
                propsPreview.length > 80 ? propsPreview.substring(0, 80) + '...' : propsPreview;
              const changePreview = getLinkChangePreview(version, versionHistory.results);

              return `
              <tr>
                <td>
                  <a href="/ui/links/${version.id}">
                    <strong>Version ${version.version}</strong>
                  </a>
                </td>
                <td>
                  ${version.is_latest ? '<span class="badge success">Latest</span>' : '<span class="badge muted">Old</span>'}
                  ${version.is_deleted ? '<span class="badge danger">Deleted</span>' : ''}
                </td>
                <td>${escapeHtml(version.created_by_name || version.created_by_email)}</td>
                <td>${formatTimestamp(version.created_at)}</td>
                <td>
                  <code class="small">${escapeHtml(truncatedProps)}</code>
                  <div class="small">${changePreview}</div>
                </td>
                <td>
                  <div class="button-group compact">
                    <a href="/ui/links/${version.id}" class="button small">View</a>
                  </div>
                </td>
              </tr>
            `;
            })
            .join('')}
        </tbody>
      </table>
    `;

    const content = `
      <h2>Version History: ${escapeHtml(latestVersion.type_name)} Link</h2>
      <p class="muted">
        <a href="/ui/entities/${latestVersion.source_entity_id}">${escapeHtml(sourceDisplayName)}</a>
        &rarr;
        <a href="/ui/entities/${latestVersion.target_entity_id}">${escapeHtml(targetDisplayName)}</a>
      </p>
      <p>This link has ${versionHistory.results.length} version${versionHistory.results.length !== 1 ? 's' : ''}.</p>

      ${versionTable}

      <div class="button-group">
        <a href="/ui/links/${latestVersion.id}" class="button">View Latest Version</a>
        <a href="/ui/links" class="button secondary">Back to Links</a>
      </div>
    `;

    const html = renderPage(
      {
        title: `Version History - ${latestVersion.type_name} Link`,
        user,
        activePath: '/ui/links',
        breadcrumbs: [
          { label: 'Home', href: '/ui' },
          { label: 'Links', href: '/ui/links' },
          {
            label: latestVersion.id.substring(0, 8) + '...',
            href: `/ui/links/${latestVersion.id}`,
          },
          { label: 'Versions' },
        ],
      },
      content
    );

    return c.html(html);
  } catch (error) {
    console.error('Error fetching link version history:', error);
    const content = `
      <div class="error-message">
        <h2>Error</h2>
        <p>An error occurred while fetching the version history. Please try again later.</p>
      </div>
      <div class="button-group">
        <a href="/ui/links" class="button secondary">Back to Links</a>
      </div>
    `;

    return c.html(
      renderPage(
        {
          title: 'Error',
          user,
          activePath: '/ui/links',
          breadcrumbs: [
            { label: 'Home', href: '/ui' },
            { label: 'Links', href: '/ui/links' },
            { label: 'Error' },
          ],
        },
        content
      ),
      500
    );
  }
});

/**
 * Type browser
 * GET /ui/types
 */
ui.get('/types', async c => {
  const user = c.get('user');

  // Require authentication for types browser
  if (!user) {
    return c.redirect('/ui/auth/login?return_to=' + encodeURIComponent('/ui/types'));
  }

  // Get filter parameters
  const filterCategory = c.req.query('category') || '';

  // Fetch all types with usage counts
  const typesQuery = `
    SELECT
      t.id, t.name, t.category, t.description, t.json_schema,
      t.created_at, t.created_by,
      u.display_name as created_by_name, u.email as created_by_email,
      CASE t.category
        WHEN 'entity' THEN (SELECT COUNT(*) FROM entities e WHERE e.type_id = t.id AND e.is_latest = 1 AND e.is_deleted = 0)
        WHEN 'link' THEN (SELECT COUNT(*) FROM links l WHERE l.type_id = t.id AND l.is_latest = 1 AND l.is_deleted = 0)
        ELSE 0
      END as usage_count
    FROM types t
    LEFT JOIN users u ON t.created_by = u.id
    WHERE 1=1 ${filterCategory ? 'AND t.category = ?' : ''}
    ORDER BY t.name ASC
  `;

  const typesResult = filterCategory
    ? await c.env.DB.prepare(typesQuery).bind(filterCategory).all<{
        id: string;
        name: string;
        category: string;
        description: string | null;
        json_schema: string | null;
        created_at: number;
        created_by: string | null;
        created_by_name: string | null;
        created_by_email: string | null;
        usage_count: number;
      }>()
    : await c.env.DB.prepare(typesQuery).all<{
        id: string;
        name: string;
        category: string;
        description: string | null;
        json_schema: string | null;
        created_at: number;
        created_by: string | null;
        created_by_name: string | null;
        created_by_email: string | null;
        usage_count: number;
      }>();

  // Render filter form
  const filterForm = `
    <div class="card">
      <form method="GET" action="/ui/types" class="filter-form">
        <div class="form-row">
          <div class="form-group">
            <label for="category">Category:</label>
            <select id="category" name="category">
              <option value="">All categories</option>
              <option value="entity" ${filterCategory === 'entity' ? 'selected' : ''}>Entity types</option>
              <option value="link" ${filterCategory === 'link' ? 'selected' : ''}>Link types</option>
            </select>
          </div>
        </div>

        <div class="button-group">
          <button type="submit" class="button">Apply Filter</button>
          <a href="/ui/types" class="button secondary">Clear Filter</a>
        </div>
      </form>
    </div>
  `;

  // Render types table
  const typesTable = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Category</th>
          <th>Description</th>
          <th>Schema</th>
          <th>Usage</th>
          <th>Created By</th>
          <th>Created At</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${typesResult.results
          .map(type => {
            const hasSchema = type.json_schema !== null;
            const createdByDisplay = type.created_by_name || type.created_by_email || 'System';

            return `
          <tr>
            <td>
              <a href="/ui/types/${type.id}"><strong>${escapeHtml(type.name)}</strong></a>
            </td>
            <td>
              <span class="badge ${type.category === 'entity' ? 'success' : 'muted'}">${escapeHtml(type.category)}</span>
            </td>
            <td>
              ${type.description ? `<span class="small">${escapeHtml(type.description.length > 100 ? type.description.substring(0, 100) + '...' : type.description)}</span>` : '<span class="muted small">No description</span>'}
            </td>
            <td>
              ${hasSchema ? '<span class="badge success small">Has Schema</span>' : '<span class="muted small">None</span>'}
            </td>
            <td>
              <a href="${type.category === 'entity' ? `/ui/entities?type_id=${type.id}` : `/ui/links?type_id=${type.id}`}">${type.usage_count} ${type.category === 'entity' ? 'entities' : 'links'}</a>
            </td>
            <td>
              ${escapeHtml(createdByDisplay)}
            </td>
            <td>
              ${formatTimestamp(type.created_at)}
            </td>
            <td>
              <div class="button-group compact">
                <a href="/ui/types/${type.id}" class="button small">View</a>
              </div>
            </td>
          </tr>
        `;
          })
          .join('')}
      </tbody>
    </table>
  `;

  const content = `
    <h2>Types</h2>
    <p>Browse all registered types for entities and links.</p>

    <h3>Filter</h3>
    ${filterForm}

    <h3>Results</h3>
    <p>Showing ${typesResult.results.length} ${typesResult.results.length === 1 ? 'type' : 'types'}.</p>

    ${typesResult.results.length > 0 ? typesTable : '<p class="muted">No types found matching the filter.</p>'}

    <div class="button-group">
      <a href="/ui" class="button secondary">Back to Dashboard</a>
      <a href="/ui/entities/new" class="button secondary">Create Entity</a>
      <a href="/ui/links/new" class="button secondary">Create Link</a>
      ${user?.is_admin ? '<a href="/ui/types/new" class="button">Create New Type</a>' : ''}
    </div>
  `;

  const html = renderPage(
    {
      title: 'Types',
      user,
      activePath: '/ui/types',
      breadcrumbs: [{ label: 'Home', href: '/ui' }, { label: 'Types' }],
    },
    content
  );

  return c.html(html);
});

/**
 * Type detail view
 * GET /ui/types/:id
 */
ui.get('/types/:id', async c => {
  const user = c.get('user');
  const typeId = c.req.param('id');

  // Require authentication for type detail view
  if (!user) {
    return c.redirect('/ui/auth/login?return_to=' + encodeURIComponent(`/ui/types/${typeId}`));
  }

  try {
    // Fetch the type with creator information
    const type = await c.env.DB.prepare(
      `
      SELECT
        t.id, t.name, t.category, t.description, t.json_schema,
        t.created_at, t.created_by,
        u.display_name as created_by_name, u.email as created_by_email
      FROM types t
      LEFT JOIN users u ON t.created_by = u.id
      WHERE t.id = ?
    `
    )
      .bind(typeId)
      .first<{
        id: string;
        name: string;
        category: string;
        description: string | null;
        json_schema: string | null;
        created_at: number;
        created_by: string | null;
        created_by_name: string | null;
        created_by_email: string | null;
      }>();

    if (!type) {
      const content = `
        <div class="error-message">
          <h2>Type Not Found</h2>
          <p>The type with ID "${escapeHtml(typeId)}" could not be found.</p>
        </div>
        <div class="button-group">
          <a href="/ui/types" class="button secondary">Back to Types</a>
        </div>
      `;

      return c.html(
        renderPage(
          {
            title: 'Type Not Found',
            user,
            activePath: '/ui/types',
            breadcrumbs: [
              { label: 'Home', href: '/ui' },
              { label: 'Types', href: '/ui/types' },
              { label: 'Not Found' },
            ],
          },
          content
        ),
        404
      );
    }

    // Get usage count
    const usageCountQuery =
      type.category === 'entity'
        ? 'SELECT COUNT(*) as count FROM entities WHERE type_id = ? AND is_latest = 1 AND is_deleted = 0'
        : 'SELECT COUNT(*) as count FROM links WHERE type_id = ? AND is_latest = 1 AND is_deleted = 0';

    const usageResult = await c.env.DB.prepare(usageCountQuery)
      .bind(typeId)
      .first<{ count: number }>();
    const usageCount = usageResult?.count || 0;

    // Get recent items of this type (limit to 10)
    let recentItemsHtml = '';
    if (type.category === 'entity') {
      const recentEntities = await c.env.DB.prepare(
        `
        SELECT
          e.id, e.properties, e.version, e.created_at,
          u.display_name as created_by_name, u.email as created_by_email
        FROM entities e
        LEFT JOIN users u ON e.created_by = u.id
        WHERE e.type_id = ? AND e.is_latest = 1 AND e.is_deleted = 0
        ORDER BY e.created_at DESC
        LIMIT 10
      `
      )
        .bind(typeId)
        .all<{
          id: string;
          properties: string;
          version: number;
          created_at: number;
          created_by_name: string | null;
          created_by_email: string | null;
        }>();

      if (recentEntities.results.length > 0) {
        recentItemsHtml = `
          <h3>Recent Entities (${Math.min(usageCount, 10)} of ${usageCount})</h3>
          <table class="data-table">
            <thead>
              <tr>
                <th>Entity</th>
                <th>Version</th>
                <th>Created By</th>
                <th>Created At</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${recentEntities.results
                .map(entity => {
                  const props = JSON.parse(entity.properties);
                  const displayName =
                    props.name || props.title || props.label || entity.id.substring(0, 8);
                  const createdByDisplay =
                    entity.created_by_name || entity.created_by_email || 'Unknown';

                  return `
                <tr>
                  <td><a href="/ui/entities/${entity.id}">${escapeHtml(displayName)}</a></td>
                  <td>${entity.version}</td>
                  <td>${escapeHtml(createdByDisplay)}</td>
                  <td>${formatTimestamp(entity.created_at)}</td>
                  <td>
                    <a href="/ui/entities/${entity.id}" class="button small">View</a>
                  </td>
                </tr>
              `;
                })
                .join('')}
            </tbody>
          </table>
          ${usageCount > 10 ? `<p><a href="/ui/entities?type_id=${typeId}">View all ${usageCount} entities of this type &rarr;</a></p>` : ''}
        `;
      }
    } else {
      const recentLinks = await c.env.DB.prepare(
        `
        SELECT
          l.id, l.properties, l.version, l.created_at,
          l.source_entity_id, l.target_entity_id,
          se.properties as source_properties,
          te.properties as target_properties,
          st.name as source_type_name,
          tt.name as target_type_name,
          u.display_name as created_by_name, u.email as created_by_email
        FROM links l
        LEFT JOIN users u ON l.created_by = u.id
        LEFT JOIN entities se ON l.source_entity_id = se.id
        LEFT JOIN entities te ON l.target_entity_id = te.id
        LEFT JOIN types st ON se.type_id = st.id
        LEFT JOIN types tt ON te.type_id = tt.id
        WHERE l.type_id = ? AND l.is_latest = 1 AND l.is_deleted = 0
        ORDER BY l.created_at DESC
        LIMIT 10
      `
      )
        .bind(typeId)
        .all<{
          id: string;
          properties: string;
          version: number;
          created_at: number;
          source_entity_id: string;
          target_entity_id: string;
          source_properties: string;
          target_properties: string;
          source_type_name: string;
          target_type_name: string;
          created_by_name: string | null;
          created_by_email: string | null;
        }>();

      if (recentLinks.results.length > 0) {
        recentItemsHtml = `
          <h3>Recent Links (${Math.min(usageCount, 10)} of ${usageCount})</h3>
          <table class="data-table">
            <thead>
              <tr>
                <th>Link</th>
                <th>Source</th>
                <th>Target</th>
                <th>Version</th>
                <th>Created At</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${recentLinks.results
                .map(link => {
                  const sourceProps = JSON.parse(link.source_properties || '{}');
                  const targetProps = JSON.parse(link.target_properties || '{}');
                  const sourceDisplayName =
                    sourceProps.name ||
                    sourceProps.title ||
                    sourceProps.label ||
                    link.source_entity_id.substring(0, 8);
                  const targetDisplayName =
                    targetProps.name ||
                    targetProps.title ||
                    targetProps.label ||
                    link.target_entity_id.substring(0, 8);

                  return `
                <tr>
                  <td><a href="/ui/links/${link.id}">${link.id.substring(0, 8)}...</a></td>
                  <td>
                    <a href="/ui/entities/${link.source_entity_id}">${escapeHtml(sourceDisplayName)}</a>
                    <span class="muted small">(${escapeHtml(link.source_type_name || 'Unknown')})</span>
                  </td>
                  <td>
                    <a href="/ui/entities/${link.target_entity_id}">${escapeHtml(targetDisplayName)}</a>
                    <span class="muted small">(${escapeHtml(link.target_type_name || 'Unknown')})</span>
                  </td>
                  <td>${link.version}</td>
                  <td>${formatTimestamp(link.created_at)}</td>
                  <td>
                    <a href="/ui/links/${link.id}" class="button small">View</a>
                  </td>
                </tr>
              `;
                })
                .join('')}
            </tbody>
          </table>
          ${usageCount > 10 ? `<p><a href="/ui/links?type_id=${typeId}">View all ${usageCount} links of this type &rarr;</a></p>` : ''}
        `;
      }
    }

    // Parse JSON schema for display if present
    let schemaHtml = '<p class="muted">No JSON schema defined for this type.</p>';
    if (type.json_schema) {
      try {
        const schema = JSON.parse(type.json_schema);
        schemaHtml = `<pre><code>${escapeHtml(JSON.stringify(schema, null, 2))}</code></pre>`;
      } catch {
        schemaHtml = `<pre><code>${escapeHtml(type.json_schema)}</code></pre>`;
      }
    }

    const createdByDisplay = type.created_by_name || type.created_by_email || 'System';

    const content = `
      <h2>${escapeHtml(type.name)}</h2>

      <div class="card detail-card">
        <h3>Type Information</h3>
        <dl class="detail-list">
          <dt>ID</dt>
          <dd><code>${escapeHtml(type.id)}</code></dd>

          <dt>Name</dt>
          <dd><strong>${escapeHtml(type.name)}</strong></dd>

          <dt>Category</dt>
          <dd>
            <span class="badge ${type.category === 'entity' ? 'success' : 'muted'}">${escapeHtml(type.category)}</span>
          </dd>

          <dt>Description</dt>
          <dd>${type.description ? escapeHtml(type.description) : '<span class="muted">No description</span>'}</dd>

          <dt>Usage</dt>
          <dd>
            <a href="${type.category === 'entity' ? `/ui/entities?type_id=${type.id}` : `/ui/links?type_id=${type.id}`}">
              ${usageCount} ${type.category === 'entity' ? 'entities' : 'links'}
            </a>
          </dd>

          <dt>Created By</dt>
          <dd>${escapeHtml(createdByDisplay)}</dd>

          <dt>Created At</dt>
          <dd>${formatTimestamp(type.created_at)}</dd>
        </dl>
      </div>

      <div class="card">
        <h3>JSON Schema</h3>
        ${schemaHtml}
      </div>

      ${recentItemsHtml || `<p class="muted">No ${type.category === 'entity' ? 'entities' : 'links'} of this type yet.</p>`}

      <div class="button-group">
        <a href="/ui/types" class="button secondary">Back to Types</a>
        ${type.category === 'entity' ? `<a href="/ui/entities/new?type_id=${type.id}" class="button">Create Entity of This Type</a>` : `<a href="/ui/links/new?type_id=${type.id}" class="button">Create Link of This Type</a>`}
        ${
          user.is_admin
            ? usageCount === 0
              ? `<button class="button danger" onclick="deleteType('${type.id}', '${escapeHtml(type.name).replace(/'/g, "\\'")}')">Delete Type</button>`
              : `<button class="button danger" disabled title="Cannot delete: ${usageCount} ${type.category === 'entity' ? 'entities' : 'links'} still use this type">Delete Type</button>`
            : ''
        }
      </div>

      ${
        user.is_admin
          ? `
      <script>
        function deleteType(typeId, typeName) {
          if (!confirm('Are you sure you want to delete the type "' + typeName + '"? This action cannot be undone.')) {
            return;
          }

          fetch('/api/types/' + typeId, {
            method: 'DELETE',
          })
            .then(response => {
              if (!response.ok) {
                return response.json().then(data => {
                  throw new Error(data.message || 'Failed to delete type');
                });
              }
              // Redirect to types list on success
              window.location.href = '/ui/types';
            })
            .catch(error => {
              alert('Error deleting type: ' + error.message);
            });
        }
      </script>
      `
          : ''
      }
    `;

    const html = renderPage(
      {
        title: type.name,
        user,
        activePath: '/ui/types',
        breadcrumbs: [
          { label: 'Home', href: '/ui' },
          { label: 'Types', href: '/ui/types' },
          { label: type.name },
        ],
      },
      content
    );

    return c.html(html);
  } catch (error) {
    console.error('Error fetching type:', error);
    const content = `
      <div class="error-message">
        <h2>Error</h2>
        <p>An error occurred while fetching the type. Please try again later.</p>
      </div>
      <div class="button-group">
        <a href="/ui/types" class="button secondary">Back to Types</a>
      </div>
    `;

    return c.html(
      renderPage(
        {
          title: 'Error',
          user,
          activePath: '/ui/types',
          breadcrumbs: [
            { label: 'Home', href: '/ui' },
            { label: 'Types', href: '/ui/types' },
            { label: 'Error' },
          ],
        },
        content
      ),
      500
    );
  }
});

/**
 * Create new type form
 * GET /ui/types/new
 */
ui.get('/types/new', async c => {
  const user = c.get('user');

  // Require authentication
  if (!user) {
    return c.redirect('/ui/auth/login?return_to=' + encodeURIComponent('/ui/types/new'));
  }

  // Require admin role
  if (!user.is_admin) {
    const content = `
      <div class="error-message">
        <h2>Access Denied</h2>
        <p>Only administrators can create new types.</p>
      </div>
      <div class="button-group">
        <a href="/ui/types" class="button secondary">Back to Types</a>
      </div>
    `;

    return c.html(
      renderPage(
        {
          title: 'Access Denied',
          user,
          activePath: '/ui/types',
          breadcrumbs: [
            { label: 'Home', href: '/ui' },
            { label: 'Types', href: '/ui/types' },
            { label: 'Access Denied' },
          ],
        },
        content
      ),
      403
    );
  }

  const content = `
    <h2>Create New Type</h2>
    <p>Define a new type for entities or links. Once created, types cannot be edited - use a naming/versioning scheme for type evolution.</p>

    <div class="card">
      <form id="create-type-form" class="form">
        <div class="form-group">
          <label for="category">Category <span class="required">*</span></label>
          <select id="category" name="category" required>
            <option value="">Select category...</option>
            <option value="entity">Entity Type</option>
            <option value="link">Link Type</option>
          </select>
          <p class="help-text">Choose whether this type is for entities or links.</p>
        </div>

        <div class="form-group">
          <label for="name">Name <span class="required">*</span></label>
          <input type="text" id="name" name="name" required placeholder="e.g., Person, Organization, RelatesTo" />
          <p class="help-text">Unique name for this type. Use a clear, descriptive name.</p>
        </div>

        <div class="form-group">
          <label for="description">Description</label>
          <textarea id="description" name="description" rows="3" placeholder="Describe the purpose and usage of this type..."></textarea>
          <p class="help-text">Optional description to help users understand when to use this type.</p>
        </div>

        <div class="form-group">
          <label for="json_schema">JSON Schema (Optional)</label>
          <textarea id="json_schema" name="json_schema" rows="10" placeholder='{\n  "type": "object",\n  "properties": {\n    "name": { "type": "string" }\n  },\n  "required": ["name"]\n}'></textarea>
          <p class="help-text">Optional JSON Schema (Draft-07) for validating properties. Leave blank for no validation.</p>
        </div>

        <div id="form-error" class="error-message" style="display: none;"></div>

        <div class="button-group">
          <button type="submit" class="button">Create Type</button>
          <a href="/ui/types" class="button secondary">Cancel</a>
        </div>
      </form>
    </div>

    <script>
      (function() {
        const form = document.getElementById('create-type-form');
        const errorDiv = document.getElementById('form-error');

        form.addEventListener('submit', async function(e) {
          e.preventDefault();
          errorDiv.style.display = 'none';

          const formData = {
            category: document.getElementById('category').value,
            name: document.getElementById('name').value.trim(),
            description: document.getElementById('description').value.trim() || undefined,
            json_schema: document.getElementById('json_schema').value.trim() || undefined,
          };

          // Validate JSON schema if provided
          if (formData.json_schema) {
            try {
              JSON.parse(formData.json_schema);
            } catch (error) {
              errorDiv.textContent = 'Invalid JSON schema: ' + error.message;
              errorDiv.style.display = 'block';
              return;
            }
          }

          try {
            const response = await fetch('/api/types', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(formData),
            });

            const result = await response.json();

            if (!response.ok) {
              throw new Error(result.message || 'Failed to create type');
            }

            // Redirect to the newly created type
            window.location.href = '/ui/types/' + result.id;
          } catch (error) {
            errorDiv.textContent = 'Error: ' + error.message;
            errorDiv.style.display = 'block';
          }
        });
      })();
    </script>
  `;

  const html = renderPage(
    {
      title: 'Create New Type',
      user,
      activePath: '/ui/types',
      breadcrumbs: [
        { label: 'Home', href: '/ui' },
        { label: 'Types', href: '/ui/types' },
        { label: 'Create New Type' },
      ],
    },
    content
  );

  return c.html(html);
});

/**
 * Search interface
 * GET /ui/search
 */
ui.get('/search', async c => {
  const user = c.get('user');

  // Get search parameters from query string
  const searchTarget = c.req.query('target') || 'entities'; // 'entities' or 'links'
  const typeId = c.req.query('type_id') || '';
  const createdBy = c.req.query('created_by') || '';
  const createdAfter = c.req.query('created_after') || '';
  const createdBefore = c.req.query('created_before') || '';
  const includeDeleted = c.req.query('include_deleted') === 'true';

  // Property filters - up to 5 filters
  const propertyFilters: Array<{ path: string; operator: string; value: string }> = [];
  for (let i = 0; i < 5; i++) {
    const path = c.req.query(`filter_path_${i}`) || '';
    const operator = c.req.query(`filter_op_${i}`) || 'eq';
    const value = c.req.query(`filter_value_${i}`) || '';
    if (path && value) {
      propertyFilters.push({ path, operator, value });
    }
  }

  // Link-specific filters
  const sourceEntityId = c.req.query('source_entity_id') || '';
  const targetEntityId = c.req.query('target_entity_id') || '';

  // Pagination
  const cursor = c.req.query('cursor') || '';
  const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 100);

  // Fetch users for filter dropdown
  const allUsers = await c.env.DB.prepare(
    'SELECT id, email, display_name FROM users ORDER BY email'
  ).all<{ id: string; email: string; display_name?: string }>();

  // Fetch types for filter dropdown
  const typesCategory = searchTarget === 'entities' ? 'entity' : 'link';
  const allTypes = await c.env.DB.prepare(
    'SELECT id, name FROM types WHERE category = ? ORDER BY name'
  )
    .bind(typesCategory)
    .all<{ id: string; name: string }>();

  // Determine if we should perform search (any filter applied)
  const hasFilters =
    typeId ||
    createdBy ||
    createdAfter ||
    createdBefore ||
    includeDeleted ||
    propertyFilters.length > 0 ||
    (searchTarget === 'links' && (sourceEntityId || targetEntityId));

  let searchResults: Array<Record<string, unknown>> = [];
  let hasMore = false;
  let nextCursor: string | null = null;
  let searchError: string | null = null;

  // Perform search if filters are applied
  if (hasFilters) {
    try {
      // Build search request body
      const searchBody: Record<string, unknown> = {
        limit: limit + 1, // Fetch one extra to determine if there are more
      };

      if (typeId) searchBody.type_id = typeId;
      if (createdBy) searchBody.created_by = createdBy;
      if (createdAfter) {
        const timestamp = new Date(createdAfter).getTime();
        if (!isNaN(timestamp)) searchBody.created_after = timestamp;
      }
      if (createdBefore) {
        const timestamp = new Date(createdBefore).getTime() + 24 * 60 * 60 * 1000 - 1; // End of day
        if (!isNaN(timestamp)) searchBody.created_before = timestamp;
      }
      if (includeDeleted) searchBody.include_deleted = true;
      if (cursor) searchBody.cursor = cursor;

      // Add property filters
      if (propertyFilters.length > 0) {
        searchBody.property_filters = propertyFilters.map(f => {
          // Try to parse the value as JSON for numbers and booleans
          let parsedValue: unknown = f.value;
          if (f.value === 'true') parsedValue = true;
          else if (f.value === 'false') parsedValue = false;
          else if (!isNaN(Number(f.value)) && f.value.trim() !== '') parsedValue = Number(f.value);

          // Handle 'in' and 'not_in' operators - expect comma-separated values
          if ((f.operator === 'in' || f.operator === 'not_in') && typeof parsedValue === 'string') {
            parsedValue = parsedValue.split(',').map(v => {
              const trimmed = v.trim();
              if (trimmed === 'true') return true;
              if (trimmed === 'false') return false;
              if (!isNaN(Number(trimmed)) && trimmed !== '') return Number(trimmed);
              return trimmed;
            });
          }

          return {
            path: f.path,
            operator: f.operator,
            value: parsedValue,
          };
        });
      }

      // Add link-specific filters
      if (searchTarget === 'links') {
        if (sourceEntityId) searchBody.source_entity_id = sourceEntityId;
        if (targetEntityId) searchBody.target_entity_id = targetEntityId;
      }

      // Build WHERE clause dynamically based on criteria
      const whereClauses: string[] = [];
      const bindings: (string | number | boolean)[] = [];

      if (searchTarget === 'entities') {
        whereClauses.push('e.is_latest = 1');
        if (typeId) {
          whereClauses.push('e.type_id = ?');
          bindings.push(typeId);
        }
        if (createdBy) {
          whereClauses.push('e.created_by = ?');
          bindings.push(createdBy);
        }
        if (searchBody.created_after) {
          whereClauses.push('e.created_at >= ?');
          bindings.push(searchBody.created_after as number);
        }
        if (searchBody.created_before) {
          whereClauses.push('e.created_at <= ?');
          bindings.push(searchBody.created_before as number);
        }
        if (!includeDeleted) {
          whereClauses.push('e.is_deleted = 0');
        }

        // Add property filters to SQL
        if (propertyFilters.length > 0) {
          for (const filter of propertyFilters) {
            const jsonPath = `json_extract(e.properties, '$.${filter.path}')`;
            let parsedValue: unknown = filter.value;
            if (filter.value === 'true') parsedValue = true;
            else if (filter.value === 'false') parsedValue = false;
            else if (!isNaN(Number(filter.value)) && filter.value.trim() !== '')
              parsedValue = Number(filter.value);

            switch (filter.operator) {
              case 'eq':
                if (typeof parsedValue === 'boolean') {
                  whereClauses.push(`CAST(${jsonPath} AS INTEGER) = ?`);
                  bindings.push(parsedValue ? 1 : 0);
                } else if (typeof parsedValue === 'number') {
                  whereClauses.push(`CAST(${jsonPath} AS REAL) = ?`);
                  bindings.push(parsedValue);
                } else {
                  whereClauses.push(`${jsonPath} = ?`);
                  bindings.push(String(parsedValue));
                }
                break;
              case 'ne':
                if (typeof parsedValue === 'boolean') {
                  whereClauses.push(`CAST(${jsonPath} AS INTEGER) != ?`);
                  bindings.push(parsedValue ? 1 : 0);
                } else if (typeof parsedValue === 'number') {
                  whereClauses.push(`CAST(${jsonPath} AS REAL) != ?`);
                  bindings.push(parsedValue);
                } else {
                  whereClauses.push(`${jsonPath} != ?`);
                  bindings.push(String(parsedValue));
                }
                break;
              case 'gt':
                whereClauses.push(`CAST(${jsonPath} AS REAL) > ?`);
                bindings.push(Number(parsedValue));
                break;
              case 'lt':
                whereClauses.push(`CAST(${jsonPath} AS REAL) < ?`);
                bindings.push(Number(parsedValue));
                break;
              case 'gte':
                whereClauses.push(`CAST(${jsonPath} AS REAL) >= ?`);
                bindings.push(Number(parsedValue));
                break;
              case 'lte':
                whereClauses.push(`CAST(${jsonPath} AS REAL) <= ?`);
                bindings.push(Number(parsedValue));
                break;
              case 'like':
                whereClauses.push(`${jsonPath} LIKE ?`);
                bindings.push(String(parsedValue));
                break;
              case 'ilike':
                whereClauses.push(`LOWER(${jsonPath}) LIKE LOWER(?)`);
                bindings.push(String(parsedValue));
                break;
              case 'starts_with':
                whereClauses.push(`${jsonPath} LIKE ?`);
                bindings.push(`${parsedValue}%`);
                break;
              case 'ends_with':
                whereClauses.push(`${jsonPath} LIKE ?`);
                bindings.push(`%${parsedValue}`);
                break;
              case 'contains':
                whereClauses.push(`LOWER(${jsonPath}) LIKE LOWER(?)`);
                bindings.push(`%${parsedValue}%`);
                break;
              case 'exists':
                whereClauses.push(`${jsonPath} IS NOT NULL`);
                break;
              case 'not_exists':
                whereClauses.push(`${jsonPath} IS NULL`);
                break;
              // 'in' and 'not_in' would need array handling - simplified for UI
            }
          }
        }

        // Cursor pagination
        let cursorClause = '';
        if (cursor) {
          const parts = cursor.split(':');
          if (parts.length >= 2) {
            const cursorTimestamp = parts[0];
            const cursorId = parts.slice(1).join(':');
            cursorClause = ` AND (e.created_at < ? OR (e.created_at = ? AND e.id < ?))`;
            bindings.push(parseInt(cursorTimestamp), parseInt(cursorTimestamp), cursorId);
          }
        }

        const whereClause = whereClauses.join(' AND ');
        const query = `
          SELECT e.*, t.name as type_name, u.display_name, u.email
          FROM entities e
          LEFT JOIN types t ON e.type_id = t.id
          LEFT JOIN users u ON e.created_by = u.id
          WHERE ${whereClause}${cursorClause}
          ORDER BY e.created_at DESC, e.id DESC
          LIMIT ?
        `;
        bindings.push(limit + 1);

        const results = await c.env.DB.prepare(query)
          .bind(...bindings)
          .all();

        hasMore = results.results.length > limit;
        searchResults = results.results.slice(0, limit);

        if (hasMore && searchResults.length > 0) {
          const lastResult = searchResults[searchResults.length - 1] as {
            created_at: number;
            id: string;
          };
          nextCursor = `${lastResult.created_at}:${lastResult.id}`;
        }
      } else {
        // Link search
        whereClauses.push('l.is_latest = 1');
        if (typeId) {
          whereClauses.push('l.type_id = ?');
          bindings.push(typeId);
        }
        if (sourceEntityId) {
          whereClauses.push('l.source_entity_id = ?');
          bindings.push(sourceEntityId);
        }
        if (targetEntityId) {
          whereClauses.push('l.target_entity_id = ?');
          bindings.push(targetEntityId);
        }
        if (createdBy) {
          whereClauses.push('l.created_by = ?');
          bindings.push(createdBy);
        }
        if (searchBody.created_after) {
          whereClauses.push('l.created_at >= ?');
          bindings.push(searchBody.created_after as number);
        }
        if (searchBody.created_before) {
          whereClauses.push('l.created_at <= ?');
          bindings.push(searchBody.created_before as number);
        }
        if (!includeDeleted) {
          whereClauses.push('l.is_deleted = 0');
        }

        // Add property filters to SQL
        if (propertyFilters.length > 0) {
          for (const filter of propertyFilters) {
            const jsonPath = `json_extract(l.properties, '$.${filter.path}')`;
            let parsedValue: unknown = filter.value;
            if (filter.value === 'true') parsedValue = true;
            else if (filter.value === 'false') parsedValue = false;
            else if (!isNaN(Number(filter.value)) && filter.value.trim() !== '')
              parsedValue = Number(filter.value);

            switch (filter.operator) {
              case 'eq':
                if (typeof parsedValue === 'boolean') {
                  whereClauses.push(`CAST(${jsonPath} AS INTEGER) = ?`);
                  bindings.push(parsedValue ? 1 : 0);
                } else if (typeof parsedValue === 'number') {
                  whereClauses.push(`CAST(${jsonPath} AS REAL) = ?`);
                  bindings.push(parsedValue);
                } else {
                  whereClauses.push(`${jsonPath} = ?`);
                  bindings.push(String(parsedValue));
                }
                break;
              case 'ne':
                if (typeof parsedValue === 'boolean') {
                  whereClauses.push(`CAST(${jsonPath} AS INTEGER) != ?`);
                  bindings.push(parsedValue ? 1 : 0);
                } else if (typeof parsedValue === 'number') {
                  whereClauses.push(`CAST(${jsonPath} AS REAL) != ?`);
                  bindings.push(parsedValue);
                } else {
                  whereClauses.push(`${jsonPath} != ?`);
                  bindings.push(String(parsedValue));
                }
                break;
              case 'gt':
                whereClauses.push(`CAST(${jsonPath} AS REAL) > ?`);
                bindings.push(Number(parsedValue));
                break;
              case 'lt':
                whereClauses.push(`CAST(${jsonPath} AS REAL) < ?`);
                bindings.push(Number(parsedValue));
                break;
              case 'gte':
                whereClauses.push(`CAST(${jsonPath} AS REAL) >= ?`);
                bindings.push(Number(parsedValue));
                break;
              case 'lte':
                whereClauses.push(`CAST(${jsonPath} AS REAL) <= ?`);
                bindings.push(Number(parsedValue));
                break;
              case 'like':
                whereClauses.push(`${jsonPath} LIKE ?`);
                bindings.push(String(parsedValue));
                break;
              case 'ilike':
                whereClauses.push(`LOWER(${jsonPath}) LIKE LOWER(?)`);
                bindings.push(String(parsedValue));
                break;
              case 'starts_with':
                whereClauses.push(`${jsonPath} LIKE ?`);
                bindings.push(`${parsedValue}%`);
                break;
              case 'ends_with':
                whereClauses.push(`${jsonPath} LIKE ?`);
                bindings.push(`%${parsedValue}`);
                break;
              case 'contains':
                whereClauses.push(`LOWER(${jsonPath}) LIKE LOWER(?)`);
                bindings.push(`%${parsedValue}%`);
                break;
              case 'exists':
                whereClauses.push(`${jsonPath} IS NOT NULL`);
                break;
              case 'not_exists':
                whereClauses.push(`${jsonPath} IS NULL`);
                break;
            }
          }
        }

        // Cursor pagination
        let cursorClause = '';
        if (cursor) {
          const parts = cursor.split(':');
          if (parts.length >= 2) {
            const cursorTimestamp = parts[0];
            const cursorId = parts.slice(1).join(':');
            cursorClause = ` AND (l.created_at < ? OR (l.created_at = ? AND l.id < ?))`;
            bindings.push(parseInt(cursorTimestamp), parseInt(cursorTimestamp), cursorId);
          }
        }

        const whereClause = whereClauses.join(' AND ');
        const query = `
          SELECT
            l.*,
            t.name as type_name,
            se.properties as source_properties,
            st.name as source_type_name,
            te.properties as target_properties,
            tt.name as target_type_name,
            u.display_name, u.email
          FROM links l
          LEFT JOIN types t ON l.type_id = t.id
          LEFT JOIN entities se ON l.source_entity_id = se.id AND se.is_latest = 1
          LEFT JOIN types st ON se.type_id = st.id
          LEFT JOIN entities te ON l.target_entity_id = te.id AND te.is_latest = 1
          LEFT JOIN types tt ON te.type_id = tt.id
          LEFT JOIN users u ON l.created_by = u.id
          WHERE ${whereClause}${cursorClause}
          ORDER BY l.created_at DESC, l.id DESC
          LIMIT ?
        `;
        bindings.push(limit + 1);

        const results = await c.env.DB.prepare(query)
          .bind(...bindings)
          .all();

        hasMore = results.results.length > limit;
        searchResults = results.results.slice(0, limit);

        if (hasMore && searchResults.length > 0) {
          const lastResult = searchResults[searchResults.length - 1] as {
            created_at: number;
            id: string;
          };
          nextCursor = `${lastResult.created_at}:${lastResult.id}`;
        }
      }
    } catch (error) {
      console.error('Search error:', error);
      searchError = error instanceof Error ? error.message : 'An error occurred during search';
    }
  }

  // Build URL with current parameters for pagination and export
  const buildSearchUrl = (newCursor?: string, asExport?: boolean) => {
    const params = new URLSearchParams();
    params.set('target', searchTarget);
    if (typeId) params.set('type_id', typeId);
    if (createdBy) params.set('created_by', createdBy);
    if (createdAfter) params.set('created_after', createdAfter);
    if (createdBefore) params.set('created_before', createdBefore);
    if (includeDeleted) params.set('include_deleted', 'true');
    if (sourceEntityId) params.set('source_entity_id', sourceEntityId);
    if (targetEntityId) params.set('target_entity_id', targetEntityId);
    propertyFilters.forEach((f, i) => {
      params.set(`filter_path_${i}`, f.path);
      params.set(`filter_op_${i}`, f.operator);
      params.set(`filter_value_${i}`, f.value);
    });
    if (newCursor) params.set('cursor', newCursor);
    if (asExport) {
      // Build API export URL
      const apiParams = new URLSearchParams();
      if (typeId) apiParams.set('type_ids', typeId);
      if (createdAfter) {
        const timestamp = new Date(createdAfter).getTime();
        if (!isNaN(timestamp)) apiParams.set('created_after', timestamp.toString());
      }
      if (createdBefore) {
        const timestamp = new Date(createdBefore).getTime() + 24 * 60 * 60 * 1000 - 1;
        if (!isNaN(timestamp)) apiParams.set('created_before', timestamp.toString());
      }
      if (includeDeleted) apiParams.set('include_deleted', 'true');
      return `/api/export?${apiParams.toString()}`;
    }
    return `/ui/search?${params.toString()}`;
  };

  // Operators for the filter builder
  const operators = [
    { value: 'eq', label: 'equals' },
    { value: 'ne', label: 'not equals' },
    { value: 'gt', label: 'greater than' },
    { value: 'lt', label: 'less than' },
    { value: 'gte', label: 'greater or equal' },
    { value: 'lte', label: 'less or equal' },
    { value: 'like', label: 'like (pattern)' },
    { value: 'ilike', label: 'like (case-insensitive)' },
    { value: 'starts_with', label: 'starts with' },
    { value: 'ends_with', label: 'ends with' },
    { value: 'contains', label: 'contains' },
    { value: 'exists', label: 'exists' },
    { value: 'not_exists', label: 'does not exist' },
  ];

  // Render search form
  const searchForm = `
    <div class="card">
      <form method="GET" action="/ui/search" class="filter-form" id="search-form">
        <div class="form-row">
          <div class="form-group">
            <label for="target">Search Target:</label>
            <select id="target" name="target" onchange="this.form.submit()">
              <option value="entities" ${searchTarget === 'entities' ? 'selected' : ''}>Entities</option>
              <option value="links" ${searchTarget === 'links' ? 'selected' : ''}>Links</option>
            </select>
          </div>

          <div class="form-group">
            <label for="type_id">${searchTarget === 'entities' ? 'Entity' : 'Link'} Type:</label>
            <select id="type_id" name="type_id">
              <option value="">All types</option>
              ${allTypes.results
                .map(
                  t => `
                <option value="${t.id}" ${typeId === t.id ? 'selected' : ''}>
                  ${escapeHtml(t.name)}
                </option>
              `
                )
                .join('')}
            </select>
          </div>

          <div class="form-group">
            <label for="created_by">Created By:</label>
            <select id="created_by" name="created_by">
              <option value="">All users</option>
              ${allUsers.results
                .map(
                  u => `
                <option value="${u.id}" ${createdBy === u.id ? 'selected' : ''}>
                  ${escapeHtml(u.display_name || u.email)}
                </option>
              `
                )
                .join('')}
            </select>
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label for="created_after">Created After:</label>
            <input type="date" id="created_after" name="created_after" value="${escapeHtml(createdAfter)}">
          </div>

          <div class="form-group">
            <label for="created_before">Created Before:</label>
            <input type="date" id="created_before" name="created_before" value="${escapeHtml(createdBefore)}">
          </div>

          <div class="form-group">
            <label for="include_deleted">
              <input type="checkbox" id="include_deleted" name="include_deleted" value="true" ${includeDeleted ? 'checked' : ''}>
              Include deleted
            </label>
          </div>
        </div>

        ${
          searchTarget === 'links'
            ? `
        <div class="form-row">
          <div class="form-group">
            <label for="source_entity_id">Source Entity ID:</label>
            <input type="text" id="source_entity_id" name="source_entity_id" value="${escapeHtml(sourceEntityId)}" placeholder="UUID of source entity">
          </div>

          <div class="form-group">
            <label for="target_entity_id">Target Entity ID:</label>
            <input type="text" id="target_entity_id" name="target_entity_id" value="${escapeHtml(targetEntityId)}" placeholder="UUID of target entity">
          </div>
        </div>
        `
            : ''
        }

        <h4>Property Filters</h4>
        <p class="small muted">Filter by JSON properties. Use dot notation for nested paths (e.g., address.city).</p>

        <div id="property-filters">
          ${[0, 1, 2, 3, 4]
            .map(i => {
              const filter = propertyFilters[i] || { path: '', operator: 'eq', value: '' };
              return `
            <div class="form-row filter-row" id="filter-row-${i}" style="display: ${i === 0 || filter.path ? 'flex' : 'none'}">
              <div class="form-group" style="flex: 2">
                <input type="text" name="filter_path_${i}" placeholder="Property path (e.g., name, status)" value="${escapeHtml(filter.path)}">
              </div>
              <div class="form-group" style="flex: 2">
                <select name="filter_op_${i}">
                  ${operators
                    .map(
                      op => `
                    <option value="${op.value}" ${filter.operator === op.value ? 'selected' : ''}>${escapeHtml(op.label)}</option>
                  `
                    )
                    .join('')}
                </select>
              </div>
              <div class="form-group" style="flex: 2">
                <input type="text" name="filter_value_${i}" placeholder="Value" value="${escapeHtml(filter.value)}">
              </div>
              ${
                i > 0
                  ? `
              <button type="button" class="button small secondary" onclick="removeFilter(${i})">Remove</button>
              `
                  : ''
              }
            </div>
          `;
            })
            .join('')}
        </div>

        <div class="button-group">
          <button type="button" class="button secondary small" onclick="addFilter()">+ Add Filter</button>
        </div>

        <div class="button-group" style="margin-top: 1.5rem">
          <button type="submit" class="button">Search</button>
          <a href="/ui/search" class="button secondary">Clear All</a>
          ${hasFilters && searchResults.length > 0 ? `<a href="${buildSearchUrl(undefined, true)}" class="button secondary" target="_blank">Export Results (JSON)</a>` : ''}
        </div>
      </form>
    </div>

    <script>
      let filterCount = ${Math.max(1, propertyFilters.length)};

      function addFilter() {
        if (filterCount >= 5) return;
        const row = document.getElementById('filter-row-' + filterCount);
        if (row) {
          row.style.display = 'flex';
          filterCount++;
        }
      }

      function removeFilter(index) {
        const row = document.getElementById('filter-row-' + index);
        if (row) {
          row.style.display = 'none';
          // Clear the inputs
          row.querySelectorAll('input').forEach(input => input.value = '');
        }
      }
    </script>
  `;

  // Render search results
  let resultsHtml = '';
  if (searchError) {
    resultsHtml = `
      <div class="error-message">
        <strong>Search Error:</strong> ${escapeHtml(searchError)}
      </div>
    `;
  } else if (hasFilters) {
    if (searchResults.length === 0) {
      resultsHtml = '<p class="muted">No results found matching your search criteria.</p>';
    } else {
      if (searchTarget === 'entities') {
        resultsHtml = `
          <p>Found ${searchResults.length}${hasMore ? '+' : ''} results.</p>
          <table class="data-table">
            <thead>
              <tr>
                <th>Entity</th>
                <th>Type</th>
                <th>Properties</th>
                <th>Version</th>
                <th>Created By</th>
                <th>Created At</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${searchResults
                .map(entity => {
                  const props = entity.properties ? JSON.parse(entity.properties as string) : {};
                  const displayName =
                    props.name ||
                    props.title ||
                    props.label ||
                    (entity.id as string).substring(0, 8);
                  const propsPreview = JSON.stringify(props);
                  const truncatedProps =
                    propsPreview.length > 80 ? propsPreview.substring(0, 80) + '...' : propsPreview;

                  return `
                <tr>
                  <td>
                    <a href="/ui/entities/${entity.id}"><strong>${escapeHtml(String(displayName))}</strong></a>
                    <div class="small muted">${escapeHtml((entity.id as string).substring(0, 8))}...</div>
                  </td>
                  <td>
                    <a href="/ui/search?target=entities&type_id=${entity.type_id}">${escapeHtml(String(entity.type_name || 'Unknown'))}</a>
                  </td>
                  <td class="small"><code>${escapeHtml(truncatedProps)}</code></td>
                  <td>${entity.version}</td>
                  <td>${escapeHtml(String(entity.display_name || entity.email || 'Unknown'))}</td>
                  <td>${formatTimestamp(entity.created_at as number)}</td>
                  <td>
                    ${entity.is_latest ? '<span class="badge success small">Latest</span>' : '<span class="badge muted small">Old</span>'}
                    ${entity.is_deleted ? '<span class="badge danger small">Deleted</span>' : ''}
                  </td>
                  <td>
                    <a href="/ui/entities/${entity.id}" class="button small">View</a>
                  </td>
                </tr>
              `;
                })
                .join('')}
            </tbody>
          </table>
        `;
      } else {
        resultsHtml = `
          <p>Found ${searchResults.length}${hasMore ? '+' : ''} results.</p>
          <table class="data-table">
            <thead>
              <tr>
                <th>Link</th>
                <th>Type</th>
                <th>Source</th>
                <th>Target</th>
                <th>Version</th>
                <th>Created At</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${searchResults
                .map(link => {
                  const sourceProps = link.source_properties
                    ? JSON.parse(link.source_properties as string)
                    : {};
                  const targetProps = link.target_properties
                    ? JSON.parse(link.target_properties as string)
                    : {};
                  const sourceDisplayName =
                    sourceProps.name ||
                    sourceProps.title ||
                    sourceProps.label ||
                    (link.source_entity_id as string).substring(0, 8);
                  const targetDisplayName =
                    targetProps.name ||
                    targetProps.title ||
                    targetProps.label ||
                    (link.target_entity_id as string).substring(0, 8);

                  return `
                <tr>
                  <td>
                    <a href="/ui/links/${link.id}">${(link.id as string).substring(0, 8)}...</a>
                  </td>
                  <td>
                    <a href="/ui/search?target=links&type_id=${link.type_id}">${escapeHtml(String(link.type_name || 'Unknown'))}</a>
                  </td>
                  <td>
                    <a href="/ui/entities/${link.source_entity_id}">${escapeHtml(String(sourceDisplayName))}</a>
                    <div class="small muted">${escapeHtml(String(link.source_type_name || 'Unknown'))}</div>
                  </td>
                  <td>
                    <a href="/ui/entities/${link.target_entity_id}">${escapeHtml(String(targetDisplayName))}</a>
                    <div class="small muted">${escapeHtml(String(link.target_type_name || 'Unknown'))}</div>
                  </td>
                  <td>${link.version}</td>
                  <td>${formatTimestamp(link.created_at as number)}</td>
                  <td>
                    ${link.is_latest ? '<span class="badge success small">Latest</span>' : '<span class="badge muted small">Old</span>'}
                    ${link.is_deleted ? '<span class="badge danger small">Deleted</span>' : ''}
                  </td>
                  <td>
                    <a href="/ui/links/${link.id}" class="button small">View</a>
                  </td>
                </tr>
              `;
                })
                .join('')}
            </tbody>
          </table>
        `;
      }

      // Pagination
      if (hasMore || cursor) {
        resultsHtml += `
          <div class="pagination">
            ${cursor ? `<a href="${buildSearchUrl()}" class="button secondary">First Page</a>` : ''}
            ${hasMore && nextCursor ? `<a href="${buildSearchUrl(nextCursor)}" class="button">Next Page</a>` : ''}
          </div>
        `;
      }
    }
  } else {
    resultsHtml = `
      <p class="muted">Use the filters above to search for ${searchTarget}. At least one filter is required to perform a search.</p>
    `;
  }

  const content = `
    <h2>Search</h2>
    <p>Search for entities and links by type, properties, creator, and date range.</p>

    <h3>Search Filters</h3>
    ${searchForm}

    <h3>Results</h3>
    ${resultsHtml}

    <div class="button-group">
      <a href="/ui" class="button secondary">Back to Dashboard</a>
      <a href="/ui/entities" class="button secondary">Browse Entities</a>
      <a href="/ui/links" class="button secondary">Browse Links</a>
    </div>
  `;

  const html = renderPage(
    {
      title: 'Search',
      user,
      activePath: '/ui/search',
      breadcrumbs: [{ label: 'Home', href: '/ui' }, { label: 'Search' }],
    },
    content
  );

  return c.html(html);
});

// =============================================================================
// GROUP ADMINISTRATION ROUTES
// =============================================================================

/**
 * Group list view
 * GET /ui/groups
 */
ui.get('/groups', async c => {
  const user = c.get('user');

  // Require authentication for groups browser
  if (!user) {
    return c.redirect('/ui/auth/login?return_to=' + encodeURIComponent('/ui/groups'));
  }

  // Get filter/pagination parameters
  const nameFilter = c.req.query('name') || '';
  const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 100);
  const offset = parseInt(c.req.query('offset') || '0', 10);

  // Build query
  let query = `
    SELECT g.id, g.name, g.description, g.created_at, g.created_by,
           u.display_name as created_by_name, u.email as created_by_email,
           (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count
    FROM groups g
    LEFT JOIN users u ON g.created_by = u.id
    WHERE 1=1
  `;
  const params: unknown[] = [];

  if (nameFilter) {
    query += ' AND g.name LIKE ?';
    params.push(`%${nameFilter}%`);
  }

  query += ' ORDER BY g.name ASC LIMIT ? OFFSET ?';
  params.push(limit + 1, offset); // Fetch one extra to check if there are more

  const results = await c.env.DB.prepare(query)
    .bind(...params)
    .all<{
      id: string;
      name: string;
      description: string | null;
      created_at: number;
      created_by: string | null;
      created_by_name: string | null;
      created_by_email: string | null;
      member_count: number;
    }>();

  const groups = results.results || [];
  const hasMore = groups.length > limit;
  if (hasMore) groups.pop(); // Remove the extra one

  // Get total count for display
  let countQuery = 'SELECT COUNT(*) as total FROM groups WHERE 1=1';
  const countParams: unknown[] = [];
  if (nameFilter) {
    countQuery += ' AND name LIKE ?';
    countParams.push(`%${nameFilter}%`);
  }
  const countResult = await c.env.DB.prepare(countQuery)
    .bind(...countParams)
    .first<{ total: number }>();
  const total = countResult?.total || 0;

  // Build filter form
  const filterForm = `
    <div class="card">
      <form method="GET" action="/ui/groups" class="filter-form">
        <div class="form-row">
          <div class="form-group">
            <label for="name">Search by Name:</label>
            <input type="text" id="name" name="name" value="${escapeHtml(nameFilter)}" placeholder="Enter group name...">
          </div>
        </div>
        <div class="button-group">
          <button type="submit" class="button">Search</button>
          <a href="/ui/groups" class="button secondary">Clear</a>
        </div>
      </form>
    </div>
  `;

  // Build groups table
  const groupsTable =
    groups.length > 0
      ? `
    <table class="data-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Description</th>
          <th>Members</th>
          <th>Created By</th>
          <th>Created At</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${groups
          .map(
            group => `
          <tr>
            <td><a href="/ui/groups/${group.id}">${escapeHtml(group.name)}</a></td>
            <td class="muted">${group.description ? escapeHtml(group.description.substring(0, 50)) + (group.description.length > 50 ? '...' : '') : '-'}</td>
            <td><span class="badge muted">${group.member_count}</span></td>
            <td>${group.created_by_name || group.created_by_email ? escapeHtml(group.created_by_name || group.created_by_email || '') : '-'}</td>
            <td class="muted small">${formatTimestamp(group.created_at)}</td>
            <td>
              <div class="button-group compact">
                <a href="/ui/groups/${group.id}" class="button small">View</a>
                ${user?.is_admin ? `<a href="/ui/groups/${group.id}/edit" class="button small secondary">Edit</a>` : ''}
              </div>
            </td>
          </tr>
        `
          )
          .join('')}
      </tbody>
    </table>
  `
      : '<p class="muted">No groups found.</p>';

  // Build pagination
  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(total / limit);
  const buildPageUrl = (newOffset: number) => {
    const params = new URLSearchParams();
    if (nameFilter) params.set('name', nameFilter);
    params.set('limit', String(limit));
    params.set('offset', String(newOffset));
    return `/ui/groups?${params.toString()}`;
  };

  const pagination =
    total > limit
      ? `
    <div class="pagination">
      ${offset > 0 ? `<a href="${buildPageUrl(Math.max(0, offset - limit))}" class="button small secondary">&laquo; Previous</a>` : ''}
      <span class="muted">Page ${currentPage} of ${totalPages} (${total} total groups)</span>
      ${hasMore ? `<a href="${buildPageUrl(offset + limit)}" class="button small secondary">Next &raquo;</a>` : ''}
    </div>
  `
      : '';

  const adminActions = user?.is_admin
    ? `
    <div class="button-group">
      <a href="/ui/groups/new" class="button">Create New Group</a>
    </div>
  `
    : '';

  const content = `
    <h2>Groups</h2>
    <p>Manage groups and their memberships. Groups can contain users and other groups.</p>

    ${adminActions}

    <h3>Filter Groups</h3>
    ${filterForm}

    <h3>All Groups</h3>
    ${groupsTable}
    ${pagination}
  `;

  const html = renderPage(
    {
      title: 'Groups',
      user,
      activePath: '/ui/groups',
      breadcrumbs: [{ label: 'Home', href: '/ui' }, { label: 'Groups' }],
    },
    content
  );

  return c.html(html);
});

/**
 * Create group form
 * GET /ui/groups/new
 */
ui.get('/groups/new', async c => {
  const user = c.get('user');

  // Require admin authentication
  if (!user) {
    return c.redirect('/ui/auth/login?return_to=' + encodeURIComponent('/ui/groups/new'));
  }

  if (!user.is_admin) {
    // Redirect non-admins to groups list with error
    return c.redirect('/ui/groups?error=' + encodeURIComponent('Admin access required'));
  }

  const error = c.req.query('error') || '';

  const errorMessage = error
    ? `<div class="error-message">${escapeHtml(decodeURIComponent(error))}</div>`
    : '';

  const content = `
    <h2>Create New Group</h2>
    ${errorMessage}

    <div class="card">
      <form id="create-group-form" class="filter-form">
        <div class="form-row">
          <div class="form-group">
            <label for="name">Name: *</label>
            <input type="text" id="name" name="name" required placeholder="Enter group name">
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label for="description">Description:</label>
            <textarea id="description" name="description" rows="3" placeholder="Enter group description (optional)"></textarea>
          </div>
        </div>

        <div class="button-group">
          <button type="submit" class="button">Create Group</button>
          <a href="/ui/groups" class="button secondary">Cancel</a>
        </div>
      </form>
    </div>

    <script>
      document.getElementById('create-group-form').addEventListener('submit', async function(e) {
        e.preventDefault();

        const name = document.getElementById('name').value.trim();
        const description = document.getElementById('description').value.trim();

        if (!name) {
          alert('Name is required');
          return;
        }

        try {
          const response = await fetch('/api/groups', {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              name: name,
              description: description || undefined
            })
          });

          const data = await response.json();

          if (response.ok && data.data && data.data.id) {
            window.location.href = '/ui/groups/' + data.data.id;
          } else {
            const errorMsg = data.error || data.message || 'Failed to create group';
            alert('Error: ' + errorMsg);
          }
        } catch (err) {
          alert('Error: ' + err.message);
        }
      });
    </script>
  `;

  const html = renderPage(
    {
      title: 'Create Group',
      user,
      activePath: '/ui/groups',
      breadcrumbs: [
        { label: 'Home', href: '/ui' },
        { label: 'Groups', href: '/ui/groups' },
        { label: 'Create New Group' },
      ],
    },
    content
  );

  return c.html(html);
});

/**
 * Edit group form
 * GET /ui/groups/:id/edit
 */
ui.get('/groups/:id/edit', async c => {
  const user = c.get('user');
  const groupId = c.req.param('id');

  // Require admin authentication
  if (!user) {
    return c.redirect(
      '/ui/auth/login?return_to=' + encodeURIComponent(`/ui/groups/${groupId}/edit`)
    );
  }

  if (!user.is_admin) {
    // Redirect non-admins to group detail page with error
    return c.redirect(`/ui/groups/${groupId}?error=` + encodeURIComponent('Admin access required'));
  }

  // Fetch group
  const group = await c.env.DB.prepare(
    'SELECT id, name, description, created_at, created_by FROM groups WHERE id = ?'
  )
    .bind(groupId)
    .first<{
      id: string;
      name: string;
      description: string | null;
      created_at: number;
      created_by: string | null;
    }>();

  if (!group) {
    const content = `
      <div class="error-message">
        <h2>Group Not Found</h2>
        <p>The requested group does not exist.</p>
      </div>
      <div class="button-group">
        <a href="/ui/groups" class="button secondary">Back to Groups</a>
      </div>
    `;

    return c.html(
      renderPage(
        {
          title: 'Group Not Found',
          user,
          activePath: '/ui/groups',
          breadcrumbs: [
            { label: 'Home', href: '/ui' },
            { label: 'Groups', href: '/ui/groups' },
            { label: 'Not Found' },
          ],
        },
        content
      ),
      404
    );
  }

  const error = c.req.query('error') || '';
  const errorMessage = error
    ? `<div class="error-message">${escapeHtml(decodeURIComponent(error))}</div>`
    : '';

  const content = `
    <h2>Edit Group: ${escapeHtml(group.name)}</h2>
    ${errorMessage}

    <div class="card">
      <form id="edit-group-form" class="filter-form">
        <div class="form-row">
          <div class="form-group">
            <label for="name">Name: *</label>
            <input type="text" id="name" name="name" required value="${escapeHtml(group.name)}">
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label for="description">Description:</label>
            <textarea id="description" name="description" rows="3">${escapeHtml(group.description || '')}</textarea>
          </div>
        </div>

        <div class="button-group">
          <button type="submit" class="button">Save Changes</button>
          <a href="/ui/groups/${escapeHtml(groupId)}" class="button secondary">Cancel</a>
        </div>
      </form>
    </div>

    <script>
      document.getElementById('edit-group-form').addEventListener('submit', async function(e) {
        e.preventDefault();

        const name = document.getElementById('name').value.trim();
        const description = document.getElementById('description').value.trim();

        if (!name) {
          alert('Name is required');
          return;
        }

        try {
          const response = await fetch('/api/groups/${escapeHtml(groupId)}', {
            method: 'PUT',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              name: name,
              description: description || undefined
            })
          });

          const data = await response.json();

          if (response.ok) {
            window.location.href = '/ui/groups/${escapeHtml(groupId)}';
          } else {
            const errorMsg = data.error || data.message || 'Failed to update group';
            alert('Error: ' + errorMsg);
          }
        } catch (err) {
          alert('Error: ' + err.message);
        }
      });
    </script>
  `;

  const html = renderPage(
    {
      title: `Edit Group - ${group.name}`,
      user,
      activePath: '/ui/groups',
      breadcrumbs: [
        { label: 'Home', href: '/ui' },
        { label: 'Groups', href: '/ui/groups' },
        { label: group.name, href: `/ui/groups/${groupId}` },
        { label: 'Edit' },
      ],
    },
    content
  );

  return c.html(html);
});

/**
 * Group detail view with members
 * GET /ui/groups/:id
 */
ui.get('/groups/:id', async c => {
  const user = c.get('user');
  const groupId = c.req.param('id');

  // Fetch group
  const group = await c.env.DB.prepare(
    `SELECT g.id, g.name, g.description, g.created_at, g.created_by,
            u.display_name as created_by_name, u.email as created_by_email
     FROM groups g
     LEFT JOIN users u ON g.created_by = u.id
     WHERE g.id = ?`
  )
    .bind(groupId)
    .first<{
      id: string;
      name: string;
      description: string | null;
      created_at: number;
      created_by: string | null;
      created_by_name: string | null;
      created_by_email: string | null;
    }>();

  if (!group) {
    const content = `
      <div class="error-message">
        <h2>Group Not Found</h2>
        <p>The requested group does not exist.</p>
      </div>
      <div class="button-group">
        <a href="/ui/groups" class="button secondary">Back to Groups</a>
      </div>
    `;

    return c.html(
      renderPage(
        {
          title: 'Group Not Found',
          user,
          activePath: '/ui/groups',
          breadcrumbs: [
            { label: 'Home', href: '/ui' },
            { label: 'Groups', href: '/ui/groups' },
            { label: 'Not Found' },
          ],
        },
        content
      ),
      404
    );
  }

  // Fetch direct members
  const directMembers = await c.env.DB.prepare(
    `SELECT
       gm.member_type,
       gm.member_id,
       gm.created_at,
       CASE
         WHEN gm.member_type = 'user' THEN u.display_name
         WHEN gm.member_type = 'group' THEN mg.name
       END as name,
       CASE
         WHEN gm.member_type = 'user' THEN u.email
         ELSE NULL
       END as email
     FROM group_members gm
     LEFT JOIN users u ON gm.member_type = 'user' AND gm.member_id = u.id
     LEFT JOIN groups mg ON gm.member_type = 'group' AND gm.member_id = mg.id
     WHERE gm.group_id = ?
     ORDER BY gm.member_type, gm.created_at DESC`
  )
    .bind(groupId)
    .all<{
      member_type: string;
      member_id: string;
      created_at: number;
      name: string | null;
      email: string | null;
    }>();

  const members = directMembers.results || [];
  const userMembers = members.filter(m => m.member_type === 'user');
  const groupMembers = members.filter(m => m.member_type === 'group');

  // Fetch all users for add member dropdown
  const allUsers = await c.env.DB.prepare(
    'SELECT id, display_name, email FROM users ORDER BY email'
  ).all<{ id: string; display_name: string | null; email: string }>();

  // Fetch all groups (except this one) for add member dropdown
  const allGroups = await c.env.DB.prepare(
    'SELECT id, name FROM groups WHERE id != ? ORDER BY name'
  )
    .bind(groupId)
    .all<{ id: string; name: string }>();

  // Build group info card
  const groupInfoCard = `
    <div class="card">
      <h3>Group Details</h3>
      <dl class="detail-list">
        <dt>ID</dt>
        <dd><code>${escapeHtml(group.id)}</code></dd>

        <dt>Name</dt>
        <dd>${escapeHtml(group.name)}</dd>

        <dt>Description</dt>
        <dd>${group.description ? escapeHtml(group.description) : '<span class="muted">No description</span>'}</dd>

        <dt>Created By</dt>
        <dd>${group.created_by_name || group.created_by_email ? escapeHtml(group.created_by_name || group.created_by_email || '') : '<span class="muted">Unknown</span>'}</dd>

        <dt>Created At</dt>
        <dd>${formatTimestamp(group.created_at)}</dd>

        <dt>Total Members</dt>
        <dd><span class="badge muted">${members.length}</span> (${userMembers.length} users, ${groupMembers.length} groups)</dd>
      </dl>

      ${
        user?.is_admin
          ? `
        <div class="button-group">
          <a href="/ui/groups/${escapeHtml(groupId)}/edit" class="button">Edit Group</a>
          <button type="button" class="button danger" onclick="deleteGroup()">Delete Group</button>
        </div>
      `
          : ''
      }
    </div>
  `;

  // Build user members table
  const userMembersSection =
    userMembers.length > 0
      ? `
    <table class="data-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Email</th>
          <th>Added</th>
          ${user?.is_admin ? '<th>Actions</th>' : ''}
        </tr>
      </thead>
      <tbody>
        ${userMembers
          .map(
            m => `
          <tr>
            <td>${m.name ? escapeHtml(m.name) : '<span class="muted">-</span>'}</td>
            <td><a href="/ui/users/${m.member_id}">${escapeHtml(m.email || m.member_id)}</a></td>
            <td class="muted small">${formatTimestamp(m.created_at)}</td>
            ${
              user?.is_admin
                ? `<td>
                <button type="button" class="button small danger" onclick="removeMember('user', '${escapeHtml(m.member_id)}')">Remove</button>
              </td>`
                : ''
            }
          </tr>
        `
          )
          .join('')}
      </tbody>
    </table>
  `
      : '<p class="muted">No user members.</p>';

  // Build group members table
  const groupMembersSection =
    groupMembers.length > 0
      ? `
    <table class="data-table">
      <thead>
        <tr>
          <th>Group Name</th>
          <th>Added</th>
          ${user?.is_admin ? '<th>Actions</th>' : ''}
        </tr>
      </thead>
      <tbody>
        ${groupMembers
          .map(
            m => `
          <tr>
            <td><a href="/ui/groups/${m.member_id}">${escapeHtml(m.name || m.member_id)}</a></td>
            <td class="muted small">${formatTimestamp(m.created_at)}</td>
            ${
              user?.is_admin
                ? `<td>
                <button type="button" class="button small danger" onclick="removeMember('group', '${escapeHtml(m.member_id)}')">Remove</button>
              </td>`
                : ''
            }
          </tr>
        `
          )
          .join('')}
      </tbody>
    </table>
  `
      : '<p class="muted">No nested group members.</p>';

  // Build add member form
  const existingUserIds = new Set(userMembers.map(m => m.member_id));
  const existingGroupIds = new Set(groupMembers.map(m => m.member_id));
  const availableUsers = (allUsers.results || []).filter(u => !existingUserIds.has(u.id));
  const availableGroups = (allGroups.results || []).filter(g => !existingGroupIds.has(g.id));

  const addMemberForm = `
    <div class="card">
      <h3>Add Member</h3>
      <form id="add-member-form" class="filter-form">
        <div class="form-row">
          <div class="form-group">
            <label for="member_type">Member Type:</label>
            <select id="member_type" name="member_type" onchange="updateMemberOptions()">
              <option value="user">User</option>
              <option value="group">Group</option>
            </select>
          </div>

          <div class="form-group">
            <label for="member_id">Select Member:</label>
            <select id="member_id" name="member_id">
              ${availableUsers.map(u => `<option value="${u.id}">${escapeHtml(u.display_name || u.email)}</option>`).join('')}
            </select>
          </div>
        </div>

        <div class="button-group">
          <button type="submit" class="button">Add Member</button>
        </div>
      </form>
    </div>

    <script>
      const availableUsers = ${JSON.stringify(availableUsers.map(u => ({ id: u.id, label: u.display_name || u.email })))};
      const availableGroups = ${JSON.stringify(availableGroups.map(g => ({ id: g.id, label: g.name })))};

      function updateMemberOptions() {
        const memberType = document.getElementById('member_type').value;
        const memberSelect = document.getElementById('member_id');
        const options = memberType === 'user' ? availableUsers : availableGroups;

        memberSelect.innerHTML = options.map(o =>
          '<option value="' + o.id + '">' + escapeHtmlJs(o.label) + '</option>'
        ).join('');
      }

      function escapeHtmlJs(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
      }

      document.getElementById('add-member-form').addEventListener('submit', async function(e) {
        e.preventDefault();

        const memberType = document.getElementById('member_type').value;
        const memberId = document.getElementById('member_id').value;

        if (!memberId) {
          alert('Please select a member');
          return;
        }

        try {
          const response = await fetch('/api/groups/${escapeHtml(groupId)}/members', {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              member_type: memberType,
              member_id: memberId
            })
          });

          const data = await response.json();

          if (response.ok) {
            window.location.reload();
          } else {
            const errorMsg = data.error || data.message || 'Failed to add member';
            alert('Error: ' + errorMsg);
          }
        } catch (err) {
          alert('Error: ' + err.message);
        }
      });

      async function removeMember(memberType, memberId) {
        if (!confirm('Are you sure you want to remove this member from the group?')) {
          return;
        }

        try {
          const response = await fetch('/api/groups/${escapeHtml(groupId)}/members/' + memberType + '/' + memberId, {
            method: 'DELETE',
            credentials: 'include'
          });

          if (response.ok) {
            window.location.reload();
          } else {
            const data = await response.json();
            const errorMsg = data.error || data.message || 'Failed to remove member';
            alert('Error: ' + errorMsg);
          }
        } catch (err) {
          alert('Error: ' + err.message);
        }
      }

      async function deleteGroup() {
        if (!confirm('Are you sure you want to delete this group? This action cannot be undone.')) {
          return;
        }

        try {
          const response = await fetch('/api/groups/${escapeHtml(groupId)}', {
            method: 'DELETE',
            credentials: 'include'
          });

          if (response.ok) {
            window.location.href = '/ui/groups';
          } else {
            const data = await response.json();
            const errorMsg = data.error || data.message || 'Failed to delete group';
            alert('Error: ' + errorMsg);
          }
        } catch (err) {
          alert('Error: ' + err.message);
        }
      }
    </script>
  `;

  const content = `
    <h2>Group: ${escapeHtml(group.name)}</h2>

    ${groupInfoCard}

    <h3>User Members (${userMembers.length})</h3>
    ${userMembersSection}

    <h3>Nested Group Members (${groupMembers.length})</h3>
    ${groupMembersSection}

    ${user?.is_admin ? addMemberForm : ''}

    <div class="button-group">
      <a href="/ui/groups" class="button secondary">Back to Groups</a>
    </div>
  `;

  const html = renderPage(
    {
      title: `Group - ${group.name}`,
      user,
      activePath: '/ui/groups',
      breadcrumbs: [
        { label: 'Home', href: '/ui' },
        { label: 'Groups', href: '/ui/groups' },
        { label: group.name },
      ],
    },
    content
  );

  return c.html(html);
});

/**
 * Login page
 * GET /ui/auth/login
 */
ui.get('/auth/login', async c => {
  const user = c.get('user');

  // If already logged in, redirect to dashboard
  if (user) {
    return c.redirect('/ui');
  }

  const error = c.req.query('error') || '';
  const success = c.req.query('success') || '';
  const returnTo = c.req.query('return_to') || '/ui';

  // Check which OAuth providers are configured
  const googleEnabled = !!(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_REDIRECT_URI);
  const githubEnabled = !!(c.env.GITHUB_CLIENT_ID && c.env.GITHUB_REDIRECT_URI);

  const errorMessage = error
    ? `<div class="error-message">${escapeHtml(decodeURIComponent(error))}</div>`
    : '';
  const successMessage = success
    ? `<div class="success-message">${escapeHtml(decodeURIComponent(success))}</div>`
    : '';

  const oauthButtons =
    googleEnabled || githubEnabled
      ? `
    <div class="oauth-divider">
      <span>or continue with</span>
    </div>
    <div class="oauth-buttons">
      ${googleEnabled ? `<a href="/ui/auth/oauth/google?return_to=${encodeURIComponent(returnTo)}" class="button oauth-button google-button">Sign in with Google</a>` : ''}
      ${githubEnabled ? `<a href="/ui/auth/oauth/github?return_to=${encodeURIComponent(returnTo)}" class="button oauth-button github-button">Sign in with GitHub</a>` : ''}
    </div>
  `
      : '';

  const content = `
    <style>
      .auth-container {
        max-width: 400px;
        margin: 0 auto;
        padding: 2rem 0;
      }
      .auth-form {
        background: var(--color-muted);
        padding: 2rem;
        border-radius: 0.5rem;
        border: 1px solid var(--color-border);
      }
      .auth-form h2 {
        margin-top: 0;
        text-align: center;
      }
      .form-group {
        margin-bottom: 1rem;
      }
      .form-group label {
        display: block;
        margin-bottom: 0.5rem;
        font-weight: 600;
      }
      .form-group input {
        width: 100%;
        padding: 0.75rem;
        border: 1px solid var(--color-border);
        border-radius: 0.375rem;
        font-size: 1rem;
        background: var(--color-bg);
        color: var(--color-fg);
      }
      .form-group input:focus {
        outline: none;
        border-color: var(--color-primary);
        box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
      }
      .auth-form .button {
        width: 100%;
        padding: 0.75rem;
        font-size: 1rem;
      }
      .oauth-divider {
        text-align: center;
        margin: 1.5rem 0;
        position: relative;
      }
      .oauth-divider::before {
        content: '';
        position: absolute;
        top: 50%;
        left: 0;
        right: 0;
        height: 1px;
        background: var(--color-border);
      }
      .oauth-divider span {
        background: var(--color-muted);
        padding: 0 1rem;
        position: relative;
        color: var(--color-secondary);
        font-size: 0.875rem;
      }
      .oauth-buttons {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
      }
      .oauth-button {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        background: var(--color-bg);
        color: var(--color-fg);
        border: 1px solid var(--color-border);
      }
      .oauth-button:hover {
        background: var(--color-muted);
      }
      .auth-footer {
        text-align: center;
        margin-top: 1.5rem;
        color: var(--color-secondary);
      }
      .auth-footer a {
        color: var(--color-primary);
      }
    </style>

    <div class="auth-container">
      <div class="auth-form">
        <h2>Login</h2>
        ${errorMessage}
        ${successMessage}

        <form method="POST" action="/ui/auth/login">
          <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">

          <div class="form-group">
            <label for="email">Email</label>
            <input type="email" id="email" name="email" required autocomplete="email" placeholder="you@example.com">
          </div>

          <div class="form-group">
            <label for="password">Password</label>
            <input type="password" id="password" name="password" required autocomplete="current-password" placeholder="Enter your password">
          </div>

          <button type="submit" class="button">Sign In</button>
        </form>

        ${oauthButtons}
      </div>

      <div class="auth-footer">
        <p>Don't have an account? <a href="/ui/auth/register${returnTo !== '/ui' ? `?return_to=${encodeURIComponent(returnTo)}` : ''}">Register</a></p>
      </div>
    </div>
  `;

  const html = renderPage(
    {
      title: 'Login',
      activePath: '/ui/auth/login',
      breadcrumbs: [{ label: 'Home', href: '/ui' }, { label: 'Login' }],
    },
    content
  );

  return c.html(html);
});

/**
 * Login form handler
 * POST /ui/auth/login
 */
ui.post('/auth/login', async c => {
  const formData = await c.req.parseBody();
  const email = String(formData.email || '').trim();
  const password = String(formData.password || '');
  const returnTo = String(formData.return_to || '/ui');

  // Validate input
  if (!email || !password) {
    return c.redirect(
      `/ui/auth/login?error=${encodeURIComponent('Email and password are required')}&return_to=${encodeURIComponent(returnTo)}`
    );
  }

  // Find user by email
  const user = await c.env.DB.prepare(
    'SELECT id, email, display_name, provider, password_hash, is_active FROM users WHERE email = ?'
  )
    .bind(email)
    .first<{
      id: string;
      email: string;
      display_name: string | null;
      provider: string;
      password_hash: string | null;
      is_active: number;
    }>();

  if (!user) {
    return c.redirect(
      `/ui/auth/login?error=${encodeURIComponent('Invalid email or password')}&return_to=${encodeURIComponent(returnTo)}`
    );
  }

  // Check if account is active
  if (!user.is_active) {
    return c.redirect(
      `/ui/auth/login?error=${encodeURIComponent('Account is not active')}&return_to=${encodeURIComponent(returnTo)}`
    );
  }

  // Check if this is a local account
  if (user.provider !== 'local' || !user.password_hash) {
    return c.redirect(
      `/ui/auth/login?error=${encodeURIComponent('This account uses a different authentication method')}&return_to=${encodeURIComponent(returnTo)}`
    );
  }

  // Verify password
  const isValidPassword = await verifyPassword(password, user.password_hash);
  if (!isValidPassword) {
    return c.redirect(
      `/ui/auth/login?error=${encodeURIComponent('Invalid email or password')}&return_to=${encodeURIComponent(returnTo)}`
    );
  }

  // Get JWT secret
  const jwtSecret = c.env.JWT_SECRET;
  if (!jwtSecret) {
    return c.redirect(
      `/ui/auth/login?error=${encodeURIComponent('Server configuration error')}&return_to=${encodeURIComponent(returnTo)}`
    );
  }

  // Generate tokens
  const tokens = await createTokenPair(user.id, user.email, jwtSecret);

  // Store refresh token in KV
  await storeRefreshToken(c.env.KV, user.id, user.email, tokens.refreshToken);

  // Set cookies
  setCookie(c, ACCESS_TOKEN_COOKIE, tokens.accessToken, getCookieOptions(c, 15 * 60)); // 15 minutes
  setCookie(c, REFRESH_TOKEN_COOKIE, tokens.refreshToken, getCookieOptions(c, 7 * 24 * 60 * 60)); // 7 days

  // Redirect to return URL
  return c.redirect(returnTo);
});

/**
 * Registration page
 * GET /ui/auth/register
 */
ui.get('/auth/register', async c => {
  const user = c.get('user');

  // If already logged in, redirect to dashboard
  if (user) {
    return c.redirect('/ui');
  }

  const error = c.req.query('error') || '';
  const returnTo = c.req.query('return_to') || '/ui';

  const errorMessage = error
    ? `<div class="error-message">${escapeHtml(decodeURIComponent(error))}</div>`
    : '';

  const content = `
    <style>
      .auth-container {
        max-width: 400px;
        margin: 0 auto;
        padding: 2rem 0;
      }
      .auth-form {
        background: var(--color-muted);
        padding: 2rem;
        border-radius: 0.5rem;
        border: 1px solid var(--color-border);
      }
      .auth-form h2 {
        margin-top: 0;
        text-align: center;
      }
      .form-group {
        margin-bottom: 1rem;
      }
      .form-group label {
        display: block;
        margin-bottom: 0.5rem;
        font-weight: 600;
      }
      .form-group input {
        width: 100%;
        padding: 0.75rem;
        border: 1px solid var(--color-border);
        border-radius: 0.375rem;
        font-size: 1rem;
        background: var(--color-bg);
        color: var(--color-fg);
      }
      .form-group input:focus {
        outline: none;
        border-color: var(--color-primary);
        box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
      }
      .form-group .hint {
        font-size: 0.75rem;
        color: var(--color-secondary);
        margin-top: 0.25rem;
      }
      .auth-form .button {
        width: 100%;
        padding: 0.75rem;
        font-size: 1rem;
      }
      .auth-footer {
        text-align: center;
        margin-top: 1.5rem;
        color: var(--color-secondary);
      }
      .auth-footer a {
        color: var(--color-primary);
      }
    </style>

    <div class="auth-container">
      <div class="auth-form">
        <h2>Create Account</h2>
        ${errorMessage}

        <form method="POST" action="/ui/auth/register">
          <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">

          <div class="form-group">
            <label for="email">Email</label>
            <input type="email" id="email" name="email" required autocomplete="email" placeholder="you@example.com">
          </div>

          <div class="form-group">
            <label for="display_name">Display Name (optional)</label>
            <input type="text" id="display_name" name="display_name" autocomplete="name" placeholder="Your name">
          </div>

          <div class="form-group">
            <label for="password">Password</label>
            <input type="password" id="password" name="password" required autocomplete="new-password" placeholder="Create a password" minlength="8">
            <p class="hint">Must be at least 8 characters</p>
          </div>

          <div class="form-group">
            <label for="password_confirm">Confirm Password</label>
            <input type="password" id="password_confirm" name="password_confirm" required autocomplete="new-password" placeholder="Confirm your password">
          </div>

          <button type="submit" class="button">Create Account</button>
        </form>
      </div>

      <div class="auth-footer">
        <p>Already have an account? <a href="/ui/auth/login${returnTo !== '/ui' ? `?return_to=${encodeURIComponent(returnTo)}` : ''}">Login</a></p>
      </div>
    </div>
  `;

  const html = renderPage(
    {
      title: 'Register',
      activePath: '/ui/auth/register',
      breadcrumbs: [{ label: 'Home', href: '/ui' }, { label: 'Register' }],
    },
    content
  );

  return c.html(html);
});

/**
 * Registration form handler
 * POST /ui/auth/register
 */
ui.post('/auth/register', async c => {
  const formData = await c.req.parseBody();
  const email = String(formData.email || '').trim();
  const displayName = String(formData.display_name || '').trim() || null;
  const password = String(formData.password || '');
  const passwordConfirm = String(formData.password_confirm || '');
  const returnTo = String(formData.return_to || '/ui');

  // Validate input
  if (!email) {
    return c.redirect(
      `/ui/auth/register?error=${encodeURIComponent('Email is required')}&return_to=${encodeURIComponent(returnTo)}`
    );
  }

  if (!password || password.length < 8) {
    return c.redirect(
      `/ui/auth/register?error=${encodeURIComponent('Password must be at least 8 characters')}&return_to=${encodeURIComponent(returnTo)}`
    );
  }

  if (password !== passwordConfirm) {
    return c.redirect(
      `/ui/auth/register?error=${encodeURIComponent('Passwords do not match')}&return_to=${encodeURIComponent(returnTo)}`
    );
  }

  // Check if user already exists
  const existingUser = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(email)
    .first();

  if (existingUser) {
    return c.redirect(
      `/ui/auth/register?error=${encodeURIComponent('An account with this email already exists')}&return_to=${encodeURIComponent(returnTo)}`
    );
  }

  // Hash password
  const passwordHash = await hashPassword(password);

  // Create user
  const userId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  // Sanitize display name for XSS prevention
  const sanitizedDisplayName = displayName ? escapeHtml(displayName) : null;

  await c.env.DB.prepare(
    `INSERT INTO users (id, email, display_name, provider, provider_id, password_hash, created_at, updated_at, is_active)
     VALUES (?, ?, ?, 'local', NULL, ?, ?, ?, 1)`
  )
    .bind(userId, email, sanitizedDisplayName, passwordHash, now, now)
    .run();

  // Get JWT secret
  const jwtSecret = c.env.JWT_SECRET;
  if (!jwtSecret) {
    return c.redirect(`/ui/auth/login?error=${encodeURIComponent('Server configuration error')}`);
  }

  // Generate tokens
  const tokens = await createTokenPair(userId, email, jwtSecret);

  // Store refresh token in KV
  await storeRefreshToken(c.env.KV, userId, email, tokens.refreshToken);

  // Set cookies
  setCookie(c, ACCESS_TOKEN_COOKIE, tokens.accessToken, getCookieOptions(c, 15 * 60)); // 15 minutes
  setCookie(c, REFRESH_TOKEN_COOKIE, tokens.refreshToken, getCookieOptions(c, 7 * 24 * 60 * 60)); // 7 days

  // Redirect to return URL
  return c.redirect(returnTo);
});

/**
 * Logout handler
 * POST /ui/auth/logout
 */
ui.post('/auth/logout', async c => {
  const refreshToken = getCookie(c, REFRESH_TOKEN_COOKIE);

  // If we have a refresh token, invalidate the session in KV
  if (refreshToken && c.env.JWT_SECRET) {
    const { verifyRefreshToken } = await import('../utils/jwt.js');
    const payload = await verifyRefreshToken(refreshToken, c.env.JWT_SECRET);
    if (payload) {
      await invalidateSession(c.env.KV, payload.user_id);
    }
  }

  // Clear cookies
  deleteCookie(c, ACCESS_TOKEN_COOKIE, { path: '/' });
  deleteCookie(c, REFRESH_TOKEN_COOKIE, { path: '/' });

  // Redirect to login with success message
  return c.redirect('/ui/auth/login?success=' + encodeURIComponent('You have been logged out'));
});

/**
 * OAuth initiation routes
 * These redirect to the API OAuth endpoints and handle the callback
 */

// KV key prefix for OAuth state storage
const UI_OAUTH_STATE_PREFIX = 'ui_oauth_state:';
const UI_OAUTH_STATE_TTL = 15 * 60; // 15 minutes

/**
 * Google OAuth initiation
 * GET /ui/auth/oauth/google
 */
ui.get('/auth/oauth/google', async c => {
  const returnTo = c.req.query('return_to') || '/ui';

  // Check if Google OAuth is configured
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_REDIRECT_URI) {
    return c.redirect(
      `/ui/auth/login?error=${encodeURIComponent('Google sign-in is not configured')}`
    );
  }

  // Generate a state parameter and store return URL
  const state = crypto.randomUUID();
  await c.env.KV.put(
    `${UI_OAUTH_STATE_PREFIX}google:${state}`,
    JSON.stringify({ returnTo, timestamp: Date.now() }),
    { expirationTtl: UI_OAUTH_STATE_TTL }
  );

  // Redirect to the API OAuth endpoint
  // The callback will need to handle both API and UI flows
  return c.redirect(`/api/auth/google?ui_state=${state}`);
});

/**
 * GitHub OAuth initiation
 * GET /ui/auth/oauth/github
 */
ui.get('/auth/oauth/github', async c => {
  const returnTo = c.req.query('return_to') || '/ui';

  // Check if GitHub OAuth is configured
  if (!c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_REDIRECT_URI) {
    return c.redirect(
      `/ui/auth/login?error=${encodeURIComponent('GitHub sign-in is not configured')}`
    );
  }

  // Generate a state parameter and store return URL
  const state = crypto.randomUUID();
  await c.env.KV.put(
    `${UI_OAUTH_STATE_PREFIX}github:${state}`,
    JSON.stringify({ returnTo, timestamp: Date.now() }),
    { expirationTtl: UI_OAUTH_STATE_TTL }
  );

  // Redirect to the API OAuth endpoint
  return c.redirect(`/api/auth/github?ui_state=${state}`);
});

/**
 * OAuth callback handler for UI
 * GET /ui/auth/oauth/callback
 * Handles the callback from API OAuth endpoints
 */
ui.get('/auth/oauth/callback', async c => {
  const accessToken = c.req.query('access_token');
  const refreshToken = c.req.query('refresh_token');
  const error = c.req.query('error');
  const provider = c.req.query('provider');
  const uiState = c.req.query('ui_state');

  // Check for errors
  if (error) {
    return c.redirect(`/ui/auth/login?error=${encodeURIComponent(error)}`);
  }

  // Validate tokens
  if (!accessToken || !refreshToken) {
    return c.redirect(
      `/ui/auth/login?error=${encodeURIComponent('Authentication failed - missing tokens')}`
    );
  }

  // Get return URL from state
  let returnTo = '/ui';
  if (uiState && provider) {
    const stateData = await c.env.KV.get(`${UI_OAUTH_STATE_PREFIX}${provider}:${uiState}`);
    if (stateData) {
      const parsed = JSON.parse(stateData);
      returnTo = parsed.returnTo || '/ui';
      // Delete the state (one-time use)
      await c.env.KV.delete(`${UI_OAUTH_STATE_PREFIX}${provider}:${uiState}`);
    }
  }

  // Set cookies
  setCookie(c, ACCESS_TOKEN_COOKIE, accessToken, getCookieOptions(c, 15 * 60)); // 15 minutes
  setCookie(c, REFRESH_TOKEN_COOKIE, refreshToken, getCookieOptions(c, 7 * 24 * 60 * 60)); // 7 days

  // Redirect to return URL
  return c.redirect(returnTo);
});

/**
 * Users browser (admin only)
 * GET /ui/users
 */
ui.get('/users', async c => {
  const user = c.get('user');

  // Require authentication
  if (!user) {
    return c.redirect('/ui/auth/login?return_to=' + encodeURIComponent('/ui/users'));
  }

  // Require admin role
  if (!user.is_admin) {
    // Redirect non-admins to home with error
    return c.redirect('/ui?error=' + encodeURIComponent('Admin access required to view users'));
  }

  // Get filter/pagination parameters
  const emailFilter = c.req.query('email') || '';
  const providerFilter = c.req.query('provider') || '';
  const isActiveFilter = c.req.query('is_active') || '';
  const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 100);
  const offset = parseInt(c.req.query('offset') || '0', 10);

  // Build query
  let query = `
    SELECT id, email, display_name, provider, created_at, updated_at, is_active, is_admin
    FROM users
    WHERE 1=1
  `;
  const params: unknown[] = [];

  if (emailFilter) {
    query += ' AND email LIKE ?';
    params.push(`%${emailFilter}%`);
  }

  if (providerFilter) {
    query += ' AND provider = ?';
    params.push(providerFilter);
  }

  if (isActiveFilter === 'true' || isActiveFilter === '1') {
    query += ' AND is_active = 1';
  } else if (isActiveFilter === 'false' || isActiveFilter === '0') {
    query += ' AND is_active = 0';
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit + 1, offset); // Fetch one extra to check if there are more

  const results = await c.env.DB.prepare(query)
    .bind(...params)
    .all<{
      id: string;
      email: string;
      display_name: string | null;
      provider: string;
      created_at: number;
      updated_at: number;
      is_active: number;
      is_admin: number;
    }>();

  const users = results.results || [];
  const hasMore = users.length > limit;
  if (hasMore) users.pop(); // Remove the extra one

  // Get total count for display
  let countQuery = 'SELECT COUNT(*) as total FROM users WHERE 1=1';
  const countParams: unknown[] = [];
  if (emailFilter) {
    countQuery += ' AND email LIKE ?';
    countParams.push(`%${emailFilter}%`);
  }
  if (providerFilter) {
    countQuery += ' AND provider = ?';
    countParams.push(providerFilter);
  }
  if (isActiveFilter === 'true' || isActiveFilter === '1') {
    countQuery += ' AND is_active = 1';
  } else if (isActiveFilter === 'false' || isActiveFilter === '0') {
    countQuery += ' AND is_active = 0';
  }
  const countResult = await c.env.DB.prepare(countQuery)
    .bind(...countParams)
    .first<{ total: number }>();
  const total = countResult?.total || 0;

  // Get available providers for filter dropdown
  const providersResult = await c.env.DB.prepare(
    'SELECT DISTINCT provider FROM users ORDER BY provider'
  ).all<{ provider: string }>();
  const providers = (providersResult.results || []).map(p => p.provider);

  // Build filter form
  const filterForm = `
    <div class="card">
      <form method="GET" action="/ui/users" class="filter-form">
        <div class="form-row">
          <div class="form-group">
            <label for="email">Search by Email:</label>
            <input type="text" id="email" name="email" value="${escapeHtml(emailFilter)}" placeholder="Enter email...">
          </div>
          <div class="form-group">
            <label for="provider">Provider:</label>
            <select id="provider" name="provider">
              <option value="">All Providers</option>
              ${providers.map(p => `<option value="${escapeHtml(p)}" ${providerFilter === p ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label for="is_active">Status:</label>
            <select id="is_active" name="is_active">
              <option value="">All</option>
              <option value="true" ${isActiveFilter === 'true' ? 'selected' : ''}>Active</option>
              <option value="false" ${isActiveFilter === 'false' ? 'selected' : ''}>Inactive</option>
            </select>
          </div>
        </div>
        <div class="button-group">
          <button type="submit" class="button">Search</button>
          <a href="/ui/users" class="button secondary">Clear</a>
        </div>
      </form>
    </div>
  `;

  // Build users table
  const usersTable =
    users.length > 0
      ? `
    <table class="data-table">
      <thead>
        <tr>
          <th>Email</th>
          <th>Display Name</th>
          <th>Provider</th>
          <th>Status</th>
          <th>Role</th>
          <th>Created At</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${users
          .map(
            u => `
          <tr>
            <td>${escapeHtml(u.email)}</td>
            <td>${u.display_name ? escapeHtml(u.display_name) : '<span class="muted">-</span>'}</td>
            <td><span class="badge muted">${escapeHtml(u.provider)}</span></td>
            <td>${u.is_active ? '<span class="badge success">Active</span>' : '<span class="badge danger">Inactive</span>'}</td>
            <td>${u.is_admin ? '<span class="badge">Admin</span>' : '<span class="muted">User</span>'}</td>
            <td class="muted small">${formatTimestamp(u.created_at)}</td>
            <td>
              <div class="button-group compact">
                <a href="/ui/users/${u.id}" class="button small">View</a>
              </div>
            </td>
          </tr>
        `
          )
          .join('')}
      </tbody>
    </table>
  `
      : '<p class="muted">No users found.</p>';

  // Build pagination
  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(total / limit);
  const buildPageUrl = (newOffset: number) => {
    const params = new URLSearchParams();
    if (emailFilter) params.set('email', emailFilter);
    if (providerFilter) params.set('provider', providerFilter);
    if (isActiveFilter) params.set('is_active', isActiveFilter);
    params.set('limit', String(limit));
    params.set('offset', String(newOffset));
    return `/ui/users?${params.toString()}`;
  };

  const pagination =
    total > limit
      ? `
    <div class="pagination">
      ${offset > 0 ? `<a href="${buildPageUrl(Math.max(0, offset - limit))}" class="button small secondary">&laquo; Previous</a>` : ''}
      <span class="muted">Page ${currentPage} of ${totalPages} (${total} total users)</span>
      ${hasMore ? `<a href="${buildPageUrl(offset + limit)}" class="button small secondary">Next &raquo;</a>` : ''}
    </div>
  `
      : '';

  const content = `
    <h2>Users</h2>
    <p>View and manage user accounts. Only administrators can access this page.</p>

    <h3>Filter Users</h3>
    ${filterForm}

    <h3>All Users</h3>
    ${usersTable}
    ${pagination}
  `;

  const html = renderPage(
    {
      title: 'Users',
      user,
      activePath: '/ui/users',
      breadcrumbs: [{ label: 'Home', href: '/ui' }, { label: 'Users' }],
    },
    content
  );

  return c.html(html);
});

/**
 * User detail page (admin only)
 * GET /ui/users/:id
 */
ui.get('/users/:id', async c => {
  const user = c.get('user');
  const userId = c.req.param('id');

  // Require authentication
  if (!user) {
    return c.redirect('/ui/auth/login?return_to=' + encodeURIComponent(`/ui/users/${userId}`));
  }

  // Require admin role
  if (!user.is_admin) {
    return c.redirect(
      '/ui?error=' + encodeURIComponent('Admin access required to view user details')
    );
  }

  // Fetch the user
  const targetUser = await c.env.DB.prepare(
    'SELECT id, email, display_name, provider, provider_id, created_at, updated_at, is_active, is_admin FROM users WHERE id = ?'
  )
    .bind(userId)
    .first<{
      id: string;
      email: string;
      display_name: string | null;
      provider: string;
      provider_id: string | null;
      created_at: number;
      updated_at: number;
      is_active: number;
      is_admin: number;
    }>();

  if (!targetUser) {
    const content = `
      <h2>User Not Found</h2>
      <p class="muted">The user with ID "${escapeHtml(userId)}" was not found.</p>
      <a href="/ui/users" class="button">Back to Users</a>
    `;

    const html = renderPage(
      {
        title: 'User Not Found',
        user,
        activePath: '/ui/users',
        breadcrumbs: [
          { label: 'Home', href: '/ui' },
          { label: 'Users', href: '/ui/users' },
          { label: 'Not Found' },
        ],
      },
      content
    );

    return c.html(html, 404);
  }

  // Get groups the user belongs to
  const groupsResult = await c.env.DB.prepare(
    `SELECT g.id, g.name, gm.created_at as joined_at
     FROM groups g
     INNER JOIN group_members gm ON g.id = gm.group_id
     WHERE gm.member_type = 'user' AND gm.member_id = ?
     ORDER BY g.name ASC`
  )
    .bind(userId)
    .all<{ id: string; name: string; joined_at: number }>();

  const groups = groupsResult.results || [];

  // Get recent activity (entities and links created by this user)
  const recentEntities = await c.env.DB.prepare(
    `SELECT e.id, t.name as type_name, e.properties, e.created_at
     FROM entities e
     LEFT JOIN types t ON e.type_id = t.id
     WHERE e.created_by = ? AND e.is_latest = 1
     ORDER BY e.created_at DESC
     LIMIT 10`
  )
    .bind(userId)
    .all<{ id: string; type_name: string | null; properties: string; created_at: number }>();

  const recentLinks = await c.env.DB.prepare(
    `SELECT l.id, t.name as type_name, l.source_entity_id, l.target_entity_id, l.created_at
     FROM links l
     LEFT JOIN types t ON l.type_id = t.id
     WHERE l.created_by = ? AND l.is_latest = 1
     ORDER BY l.created_at DESC
     LIMIT 10`
  )
    .bind(userId)
    .all<{
      id: string;
      type_name: string | null;
      source_entity_id: string;
      target_entity_id: string;
      created_at: number;
    }>();

  // Get admin count to determine if this is the last admin
  const adminCountResult = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM users WHERE is_admin = 1'
  ).first<{ count: number }>();
  const adminCount = adminCountResult?.count || 0;

  // Determine if admin toggle button should be disabled
  const isSelf = user.user_id === targetUser.id;
  const isLastAdmin = targetUser.is_admin && adminCount <= 1;

  // Build groups section
  const groupsSection =
    groups.length > 0
      ? `
    <table class="data-table">
      <thead>
        <tr>
          <th>Group Name</th>
          <th>Joined</th>
        </tr>
      </thead>
      <tbody>
        ${groups
          .map(
            g => `
          <tr>
            <td><a href="/ui/groups/${g.id}">${escapeHtml(g.name)}</a></td>
            <td class="muted small">${formatTimestamp(g.joined_at)}</td>
          </tr>
        `
          )
          .join('')}
      </tbody>
    </table>
  `
      : '<p class="muted">User is not a member of any groups.</p>';

  // Build recent entities section
  const entitiesSection =
    (recentEntities.results || []).length > 0
      ? `
    <table class="data-table">
      <thead>
        <tr>
          <th>Entity</th>
          <th>Type</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        ${(recentEntities.results || [])
          .map(e => {
            let entityName = e.id.substring(0, 8) + '...';
            try {
              const props = JSON.parse(e.properties || '{}');
              if (props.name) entityName = props.name;
              else if (props.title) entityName = props.title;
            } catch {
              // Use truncated ID
            }
            return `
          <tr>
            <td><a href="/ui/entities/${e.id}">${escapeHtml(entityName)}</a></td>
            <td><span class="badge muted">${e.type_name ? escapeHtml(e.type_name) : '-'}</span></td>
            <td class="muted small">${formatTimestamp(e.created_at)}</td>
          </tr>
        `;
          })
          .join('')}
      </tbody>
    </table>
  `
      : '<p class="muted">No entities created by this user.</p>';

  // Build recent links section
  const linksSection =
    (recentLinks.results || []).length > 0
      ? `
    <table class="data-table">
      <thead>
        <tr>
          <th>Link Type</th>
          <th>Source</th>
          <th>Target</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        ${(recentLinks.results || [])
          .map(
            l => `
          <tr>
            <td><span class="badge muted">${l.type_name ? escapeHtml(l.type_name) : '-'}</span></td>
            <td><a href="/ui/entities/${l.source_entity_id}" class="id-link">${l.source_entity_id.substring(0, 8)}...</a></td>
            <td><a href="/ui/entities/${l.target_entity_id}" class="id-link">${l.target_entity_id.substring(0, 8)}...</a></td>
            <td class="muted small">${formatTimestamp(l.created_at)}</td>
          </tr>
        `
          )
          .join('')}
      </tbody>
    </table>
  `
      : '<p class="muted">No links created by this user.</p>';

  const content = `
    <style>
      .modal {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background-color: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
      }
      .modal-content {
        background-color: var(--color-bg);
        padding: 2rem;
        border-radius: 0.5rem;
        border: 1px solid var(--color-border);
        max-width: 500px;
        width: 90%;
        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      }
      .modal-content h3 {
        margin-top: 0;
        margin-bottom: 1rem;
      }
      .modal-content p {
        margin-bottom: 0.5rem;
      }
    </style>

    <h2>User Details</h2>

    <div class="card">
      <div class="detail-grid">
        <div class="detail-item">
          <span class="detail-label">ID</span>
          <span class="detail-value"><code>${escapeHtml(targetUser.id)}</code></span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Email</span>
          <span class="detail-value">${escapeHtml(targetUser.email)}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Display Name</span>
          <span class="detail-value">${targetUser.display_name ? escapeHtml(targetUser.display_name) : '<span class="muted">Not set</span>'}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Provider</span>
          <span class="detail-value"><span class="badge muted">${escapeHtml(targetUser.provider)}</span></span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Status</span>
          <span class="detail-value">${targetUser.is_active ? '<span class="badge success">Active</span>' : '<span class="badge danger">Inactive</span>'}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Role</span>
          <span class="detail-value">${targetUser.is_admin ? '<span class="badge">Admin</span>' : '<span class="muted">User</span>'}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Created</span>
          <span class="detail-value">${formatTimestamp(targetUser.created_at)}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Last Updated</span>
          <span class="detail-value">${formatTimestamp(targetUser.updated_at)}</span>
        </div>
      </div>
    </div>

    <h3>Group Memberships</h3>
    ${groupsSection}

    <h3>Recent Entities</h3>
    ${entitiesSection}

    <h3>Recent Links</h3>
    ${linksSection}

    <h3>Admin Management</h3>
    <div class="card">
      <p style="margin-bottom: 1rem;">
        Current admin status: ${targetUser.is_admin ? '<span class="badge">Admin</span>' : '<span class="muted">Regular User</span>'}
      </p>
      ${
        isSelf
          ? `
        <button class="button secondary" disabled title="You cannot change your own admin status">
          ${targetUser.is_admin ? 'Revoke Admin' : 'Grant Admin'}
        </button>
        <p class="muted small" style="margin-top: 0.5rem;">
          You cannot change your own admin status. Another admin must do this.
        </p>
      `
          : isLastAdmin
            ? `
        <button class="button secondary" disabled title="Cannot revoke - this is the only admin">
          Revoke Admin
        </button>
        <p class="muted small" style="margin-top: 0.5rem;">
          Cannot revoke admin status - this is the only admin in the system.
        </p>
      `
            : `
        <button
          class="button ${targetUser.is_admin ? 'danger' : 'primary'}"
          onclick="showAdminConfirmDialog()"
        >
          ${targetUser.is_admin ? 'Revoke Admin' : 'Grant Admin'}
        </button>
      `
      }
    </div>

    <!-- Admin Change Confirmation Dialog -->
    <div id="admin-confirm-dialog" class="modal" style="display: none;">
      <div class="modal-content">
        <h3>${targetUser.is_admin ? 'Revoke Admin Status' : 'Grant Admin Status'}</h3>
        <p>
          Are you sure you want to ${targetUser.is_admin ? 'revoke admin status from' : 'grant admin status to'}
          <strong>${escapeHtml(targetUser.display_name || targetUser.email)}</strong>?
        </p>
        ${
          targetUser.is_admin
            ? '<p class="muted small">This user will no longer be able to manage users, groups, or view audit logs.</p>'
            : '<p class="muted small">This user will be able to manage users, groups, and view audit logs.</p>'
        }
        <div class="button-group" style="margin-top: 1rem;">
          <button class="button secondary" onclick="hideAdminConfirmDialog()">Cancel</button>
          <button class="button ${targetUser.is_admin ? 'danger' : 'primary'}" onclick="changeAdminStatus()">
            ${targetUser.is_admin ? 'Revoke Admin' : 'Grant Admin'}
          </button>
        </div>
      </div>
    </div>

    <script>
      function showAdminConfirmDialog() {
        document.getElementById('admin-confirm-dialog').style.display = 'flex';
      }

      function hideAdminConfirmDialog() {
        document.getElementById('admin-confirm-dialog').style.display = 'none';
      }

      async function changeAdminStatus() {
        const button = event.target;
        button.disabled = true;
        button.textContent = 'Processing...';

        try {
          const response = await fetch('/api/users/${escapeHtml(targetUser.id)}/admin', {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
            },
            credentials: 'include',
            body: JSON.stringify({ is_admin: ${!targetUser.is_admin} })
          });

          const data = await response.json();

          if (response.ok) {
            // Reload the page to show updated status
            window.location.reload();
          } else {
            alert('Error: ' + (data.error || 'Failed to change admin status'));
            hideAdminConfirmDialog();
            button.disabled = false;
            button.textContent = '${targetUser.is_admin ? 'Revoke Admin' : 'Grant Admin'}';
          }
        } catch (err) {
          alert('Error: ' + err.message);
          hideAdminConfirmDialog();
          button.disabled = false;
          button.textContent = '${targetUser.is_admin ? 'Revoke Admin' : 'Grant Admin'}';
        }
      }

      // Close dialog when clicking outside
      document.getElementById('admin-confirm-dialog').addEventListener('click', function(e) {
        if (e.target === this) {
          hideAdminConfirmDialog();
        }
      });
    </script>

    <div class="button-group" style="margin-top: 2rem;">
      <a href="/ui/users" class="button secondary">Back to Users</a>
    </div>
  `;

  const html = renderPage(
    {
      title: `User: ${targetUser.display_name || targetUser.email}`,
      user,
      activePath: '/ui/users',
      breadcrumbs: [
        { label: 'Home', href: '/ui' },
        { label: 'Users', href: '/ui/users' },
        { label: targetUser.display_name || targetUser.email },
      ],
    },
    content
  );

  return c.html(html);
});

/**
 * Audit log viewer (admin only)
 * GET /ui/audit
 */
ui.get('/audit', async c => {
  const user = c.get('user');

  // Require authentication
  if (!user) {
    return c.redirect('/ui/auth/login?return_to=' + encodeURIComponent('/ui/audit'));
  }

  // Require admin role (matches the API's admin-only requirement for GET /api/audit)
  if (!user.is_admin) {
    return c.redirect(
      '/ui?error=' + encodeURIComponent('Admin access required to view audit logs')
    );
  }

  // Get filter/pagination parameters
  const userIdFilter = c.req.query('user_id') || '';
  const resourceTypeFilter = c.req.query('resource_type') || '';
  const resourceIdFilter = c.req.query('resource_id') || '';
  const operationFilter = c.req.query('operation') || '';
  const startDateFilter = c.req.query('start_date') || '';
  const endDateFilter = c.req.query('end_date') || '';
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100);
  const cursor = c.req.query('cursor') || '';

  // Build query
  let query = `
    SELECT al.*, u.email as user_email, u.display_name as user_display_name
    FROM audit_logs al
    LEFT JOIN users u ON al.user_id = u.id
    WHERE 1=1
  `;
  const params: (string | number)[] = [];

  if (userIdFilter) {
    query += ' AND al.user_id = ?';
    params.push(userIdFilter);
  }

  if (resourceTypeFilter) {
    query += ' AND al.resource_type = ?';
    params.push(resourceTypeFilter);
  }

  if (resourceIdFilter) {
    query += ' AND al.resource_id = ?';
    params.push(resourceIdFilter);
  }

  if (operationFilter) {
    query += ' AND al.operation = ?';
    params.push(operationFilter);
  }

  if (startDateFilter) {
    const startTimestamp = new Date(startDateFilter).getTime();
    if (!isNaN(startTimestamp)) {
      query += ' AND al.timestamp >= ?';
      params.push(startTimestamp);
    }
  }

  if (endDateFilter) {
    const endTimestamp = new Date(endDateFilter).getTime() + 24 * 60 * 60 * 1000 - 1; // End of day
    if (!isNaN(endTimestamp)) {
      query += ' AND al.timestamp <= ?';
      params.push(endTimestamp);
    }
  }

  // Handle cursor-based pagination (cursor is the timestamp of the last item)
  if (cursor) {
    query += ' AND al.timestamp < ?';
    params.push(parseInt(cursor, 10));
  }

  query += ' ORDER BY al.timestamp DESC LIMIT ?';
  params.push(limit + 1); // Fetch one extra to check if there are more

  interface AuditLogRow {
    id: number;
    operation: string;
    resource_type: string;
    resource_id: string;
    user_id: string;
    timestamp: number;
    details: string | null;
    ip_address: string | null;
    user_agent: string | null;
    user_email: string | null;
    user_display_name: string | null;
  }

  const results = await c.env.DB.prepare(query)
    .bind(...params)
    .all<AuditLogRow>();

  const logs = results.results || [];
  const hasMore = logs.length > limit;
  if (hasMore) logs.pop(); // Remove the extra one

  // Get next cursor (timestamp of last item)
  const nextCursor = hasMore && logs.length > 0 ? String(logs[logs.length - 1].timestamp) : null;

  // Get all users for filter dropdown
  const usersResult = await c.env.DB.prepare(
    'SELECT id, email, display_name FROM users ORDER BY email ASC'
  ).all<{ id: string; email: string; display_name: string | null }>();
  const allUsers = usersResult.results || [];

  // Get distinct resource types for filter dropdown
  const resourceTypesResult = await c.env.DB.prepare(
    'SELECT DISTINCT resource_type FROM audit_logs ORDER BY resource_type ASC'
  ).all<{ resource_type: string }>();
  const resourceTypes = (resourceTypesResult.results || []).map(r => r.resource_type);

  // Get distinct operations for filter dropdown
  const operationsResult = await c.env.DB.prepare(
    'SELECT DISTINCT operation FROM audit_logs ORDER BY operation ASC'
  ).all<{ operation: string }>();
  const operations = (operationsResult.results || []).map(o => o.operation);

  // Build filter form
  const filterForm = `
    <div class="card">
      <form method="GET" action="/ui/audit" class="filter-form">
        <div class="form-row">
          <div class="form-group">
            <label for="user_id">User:</label>
            <select id="user_id" name="user_id">
              <option value="">All Users</option>
              ${allUsers.map(u => `<option value="${escapeHtml(u.id)}" ${userIdFilter === u.id ? 'selected' : ''}>${escapeHtml(u.display_name || u.email)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label for="resource_type">Resource Type:</label>
            <select id="resource_type" name="resource_type">
              <option value="">All Types</option>
              ${resourceTypes.map(rt => `<option value="${escapeHtml(rt)}" ${resourceTypeFilter === rt ? 'selected' : ''}>${escapeHtml(rt)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label for="operation">Operation:</label>
            <select id="operation" name="operation">
              <option value="">All Operations</option>
              ${operations.map(op => `<option value="${escapeHtml(op)}" ${operationFilter === op ? 'selected' : ''}>${escapeHtml(op)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="resource_id">Resource ID:</label>
            <input type="text" id="resource_id" name="resource_id" value="${escapeHtml(resourceIdFilter)}" placeholder="Enter resource ID...">
          </div>
          <div class="form-group">
            <label for="start_date">From Date:</label>
            <input type="date" id="start_date" name="start_date" value="${escapeHtml(startDateFilter)}">
          </div>
          <div class="form-group">
            <label for="end_date">To Date:</label>
            <input type="date" id="end_date" name="end_date" value="${escapeHtml(endDateFilter)}">
          </div>
        </div>
        <div class="button-group">
          <button type="submit" class="button">Search</button>
          <a href="/ui/audit" class="button secondary">Clear</a>
        </div>
      </form>
    </div>
  `;

  // Helper to get resource link
  const getResourceLink = (resourceType: string, resourceId: string): string => {
    switch (resourceType) {
      case 'entity':
        return `/ui/entities/${resourceId}`;
      case 'link':
        return `/ui/links/${resourceId}`;
      case 'type':
        return `/ui/types/${resourceId}`;
      case 'user':
        return `/ui/users/${resourceId}`;
      default:
        return '#';
    }
  };

  // Helper to format operation as badge
  const getOperationBadge = (operation: string): string => {
    switch (operation) {
      case 'create':
        return '<span class="badge success">create</span>';
      case 'update':
        return '<span class="badge">update</span>';
      case 'delete':
        return '<span class="badge danger">delete</span>';
      case 'restore':
        return '<span class="badge warning">restore</span>';
      default:
        return `<span class="badge muted">${escapeHtml(operation)}</span>`;
    }
  };

  // Build audit logs table
  const logsTable =
    logs.length > 0
      ? `
    <table class="data-table">
      <thead>
        <tr>
          <th>Timestamp</th>
          <th>User</th>
          <th>Operation</th>
          <th>Resource</th>
          <th>Details</th>
        </tr>
      </thead>
      <tbody>
        ${logs
          .map(log => {
            const userName = log.user_display_name || log.user_email || log.user_id;
            const resourceLink = getResourceLink(log.resource_type, log.resource_id);
            let detailsPreview = '';
            if (log.details) {
              try {
                const details = JSON.parse(log.details);
                // Show a brief summary of details
                const keys = Object.keys(details);
                if (keys.length > 0) {
                  detailsPreview = keys.slice(0, 3).join(', ');
                  if (keys.length > 3) {
                    detailsPreview += '...';
                  }
                }
              } catch {
                detailsPreview = '(invalid JSON)';
              }
            }
            return `
          <tr>
            <td class="muted small">${formatTimestamp(log.timestamp)}</td>
            <td>
              <a href="/ui/users/${log.user_id}">${escapeHtml(userName)}</a>
            </td>
            <td>${getOperationBadge(log.operation)}</td>
            <td>
              <span class="badge muted">${escapeHtml(log.resource_type)}</span>
              <a href="${resourceLink}" class="id-link">${log.resource_id.substring(0, 8)}...</a>
            </td>
            <td class="muted small">${detailsPreview ? escapeHtml(detailsPreview) : '-'}</td>
          </tr>
        `;
          })
          .join('')}
      </tbody>
    </table>
  `
      : '<p class="muted">No audit logs found matching the criteria.</p>';

  // Build pagination
  const buildPageUrl = (newCursor: string | null) => {
    const params = new URLSearchParams();
    if (userIdFilter) params.set('user_id', userIdFilter);
    if (resourceTypeFilter) params.set('resource_type', resourceTypeFilter);
    if (resourceIdFilter) params.set('resource_id', resourceIdFilter);
    if (operationFilter) params.set('operation', operationFilter);
    if (startDateFilter) params.set('start_date', startDateFilter);
    if (endDateFilter) params.set('end_date', endDateFilter);
    params.set('limit', String(limit));
    if (newCursor) params.set('cursor', newCursor);
    return `/ui/audit?${params.toString()}`;
  };

  const pagination = hasMore
    ? `
    <div class="pagination">
      <span class="muted">Showing ${logs.length} logs</span>
      ${nextCursor ? `<a href="${buildPageUrl(nextCursor)}" class="button small secondary">Load More &raquo;</a>` : ''}
    </div>
  `
    : logs.length > 0
      ? `<div class="pagination"><span class="muted">Showing all ${logs.length} logs</span></div>`
      : '';

  const content = `
    <h2>Audit Logs</h2>
    <p>View the audit trail of all operations performed in the system. Only administrators can access this page.</p>

    <h3>Filter Logs</h3>
    ${filterForm}

    <h3>Audit Log Entries</h3>
    ${logsTable}
    ${pagination}
  `;

  const html = renderPage(
    {
      title: 'Audit Logs',
      user,
      activePath: '/ui/audit',
      breadcrumbs: [{ label: 'Home', href: '/ui' }, { label: 'Audit Logs' }],
    },
    content
  );

  return c.html(html);
});

export default ui;
