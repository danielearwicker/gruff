/**
 * UI Routes - Server-side rendered HTML interface
 * Provides a built-in web interface for browsing and managing the graph database
 */

import { Hono } from 'hono';
import { renderPage, escapeHtml, formatTimestamp } from '../utils/html.js';
import { optionalAuth } from '../middleware/auth.js';

type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  JWT_SECRET: string;
  ENVIRONMENT: string;
};

const ui = new Hono<{ Bindings: Bindings }>();

// Apply optional authentication to all UI routes
// This allows viewing the UI without authentication, but personalizes it when logged in
ui.use('*', optionalAuth());

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
  const createdQuery = `
    SELECT
      e.id, e.type_id, e.properties, e.version, e.created_at, e.created_by,
      t.name as type_name,
      u.display_name, u.email
    FROM entities e
    JOIN types t ON e.type_id = t.id
    LEFT JOIN users u ON e.created_by = u.id
    WHERE e.is_latest = 1 AND e.is_deleted = 0 ${timeRangeFilter} ${userFilter} ${typeFilter}
    ORDER BY e.created_at DESC
    LIMIT 20
  `;

  const createdParams: string[] = [];
  if (filterUserId) createdParams.push(filterUserId);
  if (filterTypeId) createdParams.push(filterTypeId);

  const recentEntities = await c.env.DB.prepare(createdQuery)
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
    }>();

  // Build query for recently updated entities (version > 1) with filters
  const updatedQuery = `
    SELECT
      e.id, e.type_id, e.properties, e.version, e.created_at, e.created_by,
      t.name as type_name,
      u.display_name, u.email
    FROM entities e
    JOIN types t ON e.type_id = t.id
    LEFT JOIN users u ON e.created_by = u.id
    WHERE e.is_latest = 1 AND e.is_deleted = 0 AND e.version > 1 ${timeRangeFilter.replace('created_at', 'created_at')} ${userFilter} ${typeFilter}
    ORDER BY e.created_at DESC
    LIMIT 20
  `;

  const updatedParams: string[] = [];
  if (filterUserId) updatedParams.push(filterUserId);
  if (filterTypeId) updatedParams.push(filterTypeId);

  const recentUpdates = await c.env.DB.prepare(updatedQuery)
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
    }>();

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
      recentEntities.results.length > 0
        ? `
      <ul class="entity-list">
        ${recentEntities.results
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
      recentUpdates.results.length > 0
        ? `
      <ul class="entity-list">
        ${recentUpdates.results
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
      e.is_latest, e.is_deleted, e.previous_version_id,
      t.name as type_name,
      u.display_name, u.email
    FROM entities e
    JOIN types t ON e.type_id = t.id
    LEFT JOIN users u ON e.created_by = u.id
    WHERE 1=1 ${timeRangeFilter} ${userFilter} ${typeFilter} ${deletedFilter} ${versionFilter} ${cursorFilter}
    ORDER BY ${sortColumn === 'type_name' ? 't.name' : 'e.' + sortColumn} ${sortDirection}
    LIMIT ?
  `;

  const queryParams: (string | number)[] = [];
  if (filterUserId) queryParams.push(filterUserId);
  if (filterTypeId) queryParams.push(filterTypeId);
  if (cursor) {
    // Cursor is a timestamp
    queryParams.push(parseInt(cursor, 10));
  }
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
      type_name: string;
      display_name?: string;
      email: string;
    }>();

  // Determine if there are more results
  const hasMore = entitiesResult.results.length > limit;
  const entities = hasMore ? entitiesResult.results.slice(0, limit) : entitiesResult.results;

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

        const typeId = document.getElementById('type_id').value;
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
            // Error - show message
            errorDiv.textContent = data.error || data.message || 'Failed to create entity';
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
              // Error - show message
              errorDiv.textContent = data.error || data.message || 'Failed to update entity';
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
        e.is_latest, e.is_deleted, e.previous_version_id,
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

    // Fetch outbound links (where this entity is the source)
    const outboundLinks = await c.env.DB.prepare(
      `
      SELECT
        l.id, l.type_id, l.target_entity_id, l.properties, l.version, l.created_at,
        l.is_deleted,
        t.name as link_type_name,
        e.properties as target_properties,
        et.name as target_type_name
      FROM links l
      JOIN types t ON l.type_id = t.id
      JOIN entities e ON l.target_entity_id = e.id
      JOIN types et ON e.type_id = et.id
      WHERE l.source_entity_id = ?
        AND l.is_latest = 1 AND l.is_deleted = 0
        AND e.is_latest = 1 AND e.is_deleted = 0
      ORDER BY l.created_at DESC
    `
    )
      .bind(entityId)
      .all<{
        id: string;
        type_id: string;
        target_entity_id: string;
        properties: string;
        version: number;
        created_at: number;
        is_deleted: number;
        link_type_name: string;
        target_properties: string;
        target_type_name: string;
      }>();

    // Fetch inbound links (where this entity is the target)
    const inboundLinks = await c.env.DB.prepare(
      `
      SELECT
        l.id, l.type_id, l.source_entity_id, l.properties, l.version, l.created_at,
        l.is_deleted,
        t.name as link_type_name,
        e.properties as source_properties,
        et.name as source_type_name
      FROM links l
      JOIN types t ON l.type_id = t.id
      JOIN entities e ON l.source_entity_id = e.id
      JOIN types et ON e.type_id = et.id
      WHERE l.target_entity_id = ?
        AND l.is_latest = 1 AND l.is_deleted = 0
        AND e.is_latest = 1 AND e.is_deleted = 0
      ORDER BY l.created_at DESC
    `
    )
      .bind(entityId)
      .all<{
        id: string;
        type_id: string;
        source_entity_id: string;
        properties: string;
        version: number;
        created_at: number;
        is_deleted: number;
        link_type_name: string;
        source_properties: string;
        source_type_name: string;
      }>();

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

    // Build outbound links section
    const outboundLinksSection = `
      <div class="card">
        <h3>Outgoing Links (${outboundLinks.results.length})</h3>
        ${
          outboundLinks.results.length > 0
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
              ${outboundLinks.results
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
        <h3>Incoming Links (${inboundLinks.results.length})</h3>
        ${
          inboundLinks.results.length > 0
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
              ${inboundLinks.results
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
            fetch('/api/entities/' + entityId, { method: 'DELETE' })
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
            fetch('/api/entities/' + entityId + '/restore', { method: 'POST' })
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

  const content = `
    <h2>Links</h2>
    <p>Link list view coming soon.</p>
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
            const response = await fetch('/api/search/suggest?q=' + encodeURIComponent(query) + '&limit=10');
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

        const typeId = document.getElementById('type_id').value;
        const sourceEntityId = document.getElementById('source_entity_id').value;
        const targetEntityId = document.getElementById('target_entity_id').value;
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
            // Error - show message
            errorDiv.textContent = data.error || data.message || 'Failed to create link';
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
              // Error - show message
              errorDiv.textContent = data.error || data.message || 'Failed to update link';
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
 * Type browser
 * GET /ui/types
 */
ui.get('/types', async c => {
  const user = c.get('user');

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
      </div>
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

/**
 * Login page (placeholder)
 * GET /ui/auth/login
 */
ui.get('/auth/login', async c => {
  const content = `
    <h2>Login</h2>
    <p>Login page coming soon.</p>
    <p>For now, you can use the <a href="/docs">API</a> to authenticate:</p>
    <ul>
      <li><code>POST /api/auth/register</code> - Register a new account</li>
      <li><code>POST /api/auth/login</code> - Login with email and password</li>
      <li><code>GET /api/auth/google</code> - Sign in with Google</li>
      <li><code>GET /api/auth/github</code> - Sign in with GitHub</li>
    </ul>
    <div class="button-group">
      <a href="/ui" class="button secondary">Back to Dashboard</a>
    </div>
  `;

  const html = renderPage(
    {
      title: 'Login',
      activePath: '/ui/auth/login',
    },
    content
  );

  return c.html(html);
});

export default ui;
