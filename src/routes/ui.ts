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
 * Entity detail view (placeholder)
 * GET /ui/entities/:id
 */
ui.get('/entities/:id', async c => {
  const user = c.get('user');
  const entityId = c.req.param('id');

  const content = `
    <h2>Entity: ${escapeHtml(entityId)}</h2>
    <p>Entity detail view coming soon.</p>
    <div class="button-group">
      <a href="/ui/entities" class="button secondary">Back to Entities</a>
    </div>
  `;

  const html = renderPage(
    {
      title: `Entity ${entityId}`,
      user,
      activePath: '/ui/entities',
      breadcrumbs: [
        { label: 'Home', href: '/ui' },
        { label: 'Entities', href: '/ui/entities' },
        { label: entityId.substring(0, 8) },
      ],
    },
    content
  );

  return c.html(html);
});

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
