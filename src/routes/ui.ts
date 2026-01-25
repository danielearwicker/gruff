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

  // Fetch recently created entities (last 20)
  const recentEntities = await c.env.DB.prepare(
    `
    SELECT
      e.id, e.type_id, e.properties, e.version, e.created_at, e.created_by,
      t.name as type_name,
      u.display_name, u.email
    FROM entities e
    JOIN types t ON e.type_id = t.id
    LEFT JOIN users u ON e.created_by = u.id
    WHERE e.is_latest = 1 AND e.is_deleted = 0
    ORDER BY e.created_at DESC
    LIMIT 20
  `
  ).all<{
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

    <h3>Recent Entities</h3>
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
        : '<p>No entities found. <a href="/ui/entities/new">Create your first entity</a>.</p>'
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
 * Entity list view (placeholder)
 * GET /ui/entities
 */
ui.get('/entities', async c => {
  const user = c.get('user');

  const content = `
    <h2>Entities</h2>
    <p>Entity list view coming soon.</p>
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
