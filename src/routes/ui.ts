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

    // Build version history section
    const versionHistorySection = `
      <div class="card">
        <h3>Version History (${versionHistory.results.length} versions)</h3>
        <div class="version-timeline">
          ${versionHistory.results
            .map(version => {
              const isCurrentView = version.id === entityId;
              const changePreview = getChangePreview(version, versionHistory.results);

              return `
              <div class="version-item ${isCurrentView ? 'current' : ''}">
                <div class="version-header">
                  <span class="version-number">
                    ${isCurrentView ? `<strong>Version ${version.version}</strong> (viewing)` : `<a href="/ui/entities/${version.id}">Version ${version.version}</a>`}
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
        <div class="button-group">
          <a href="/ui/entities/${entityId}/versions" class="button secondary">View Full History</a>
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
 * Link detail view (placeholder)
 * GET /ui/links/:id
 */
ui.get('/links/:id', async c => {
  const user = c.get('user');
  const linkId = c.req.param('id');

  const content = `
    <h2>Link: ${escapeHtml(linkId)}</h2>
    <p>Link detail view coming soon.</p>
    <div class="button-group">
      <a href="/ui/links" class="button secondary">Back to Links</a>
    </div>
  `;

  const html = renderPage(
    {
      title: `Link ${linkId}`,
      user,
      activePath: '/ui/links',
      breadcrumbs: [
        { label: 'Home', href: '/ui' },
        { label: 'Links', href: '/ui/links' },
        { label: linkId.substring(0, 8) },
      ],
    },
    content
  );

  return c.html(html);
});

/**
 * Type browser (placeholder)
 * GET /ui/types
 */
ui.get('/types', async c => {
  const user = c.get('user');

  const content = `
    <h2>Types</h2>
    <p>Type browser coming soon.</p>
    <div class="button-group">
      <a href="/ui" class="button secondary">Back to Dashboard</a>
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
 * Search interface (placeholder)
 * GET /ui/search
 */
ui.get('/search', async c => {
  const user = c.get('user');

  const content = `
    <h2>Search</h2>
    <p>Search interface coming soon.</p>
    <div class="button-group">
      <a href="/ui" class="button secondary">Back to Dashboard</a>
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
