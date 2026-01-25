/**
 * HTML template utilities for server-side rendering
 * Provides functions for escaping HTML and creating reusable components
 */

/**
 * Escape HTML special characters to prevent XSS
 */
export function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Format a timestamp as human-readable string
 */
export function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Common CSS styles for the UI
 */
export const commonStyles = `
  :root {
    --color-bg: #ffffff;
    --color-fg: #1a1a1a;
    --color-border: #e0e0e0;
    --color-primary: #2563eb;
    --color-primary-hover: #1d4ed8;
    --color-secondary: #64748b;
    --color-success: #10b981;
    --color-warning: #f59e0b;
    --color-error: #ef4444;
    --color-muted: #f3f4f6;
    --font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --color-bg: #1a1a1a;
      --color-fg: #f5f5f5;
      --color-border: #404040;
      --color-primary: #3b82f6;
      --color-primary-hover: #2563eb;
      --color-secondary: #94a3b8;
      --color-muted: #262626;
    }
  }

  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  body {
    font-family: var(--font-family);
    color: var(--color-fg);
    background-color: var(--color-bg);
    line-height: 1.6;
  }

  .container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 0 1rem;
  }

  header {
    background-color: var(--color-muted);
    border-bottom: 1px solid var(--color-border);
    padding: 1rem 0;
    margin-bottom: 2rem;
  }

  header h1 {
    font-size: 1.5rem;
    font-weight: 600;
  }

  header h1 a {
    color: var(--color-fg);
    text-decoration: none;
  }

  header h1 a:hover {
    color: var(--color-primary);
  }

  nav {
    margin-top: 0.5rem;
  }

  nav ul {
    list-style: none;
    display: flex;
    gap: 1.5rem;
    flex-wrap: wrap;
  }

  nav a {
    color: var(--color-secondary);
    text-decoration: none;
    transition: color 0.2s;
  }

  nav a:hover,
  nav a.active {
    color: var(--color-primary);
  }

  .user-menu {
    float: right;
    margin-top: -2rem;
  }

  .user-menu span {
    color: var(--color-secondary);
    margin-right: 1rem;
  }

  .user-menu a {
    color: var(--color-primary);
    text-decoration: none;
  }

  main {
    min-height: calc(100vh - 200px);
  }

  footer {
    border-top: 1px solid var(--color-border);
    padding: 1.5rem 0;
    margin-top: 3rem;
    color: var(--color-secondary);
    font-size: 0.875rem;
  }

  .breadcrumb {
    margin-bottom: 1.5rem;
    color: var(--color-secondary);
    font-size: 0.875rem;
  }

  .breadcrumb a {
    color: var(--color-primary);
    text-decoration: none;
  }

  .breadcrumb a:hover {
    text-decoration: underline;
  }

  .breadcrumb span {
    margin: 0 0.5rem;
  }

  h2 {
    font-size: 1.875rem;
    font-weight: 600;
    margin-bottom: 1rem;
  }

  h3 {
    font-size: 1.25rem;
    font-weight: 600;
    margin-top: 2rem;
    margin-bottom: 0.75rem;
  }

  .button {
    display: inline-block;
    padding: 0.5rem 1rem;
    background-color: var(--color-primary);
    color: white;
    text-decoration: none;
    border: none;
    border-radius: 0.375rem;
    cursor: pointer;
    font-size: 0.875rem;
    transition: background-color 0.2s;
  }

  .button:hover {
    background-color: var(--color-primary-hover);
  }

  .button.secondary {
    background-color: var(--color-secondary);
  }

  .button.secondary:hover {
    background-color: #475569;
  }

  .button.danger {
    background-color: var(--color-error);
  }

  .button.danger:hover {
    background-color: #dc2626;
  }

  .button-group {
    display: flex;
    gap: 0.5rem;
    margin-top: 1rem;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    margin: 1rem 0;
  }

  th {
    background-color: var(--color-muted);
    padding: 0.75rem;
    text-align: left;
    font-weight: 600;
    border-bottom: 2px solid var(--color-border);
  }

  td {
    padding: 0.75rem;
    border-bottom: 1px solid var(--color-border);
  }

  tr:hover {
    background-color: var(--color-muted);
  }

  .badge {
    display: inline-block;
    padding: 0.25rem 0.5rem;
    font-size: 0.75rem;
    font-weight: 600;
    border-radius: 0.25rem;
    text-transform: uppercase;
  }

  .badge.success {
    background-color: var(--color-success);
    color: white;
  }

  .badge.warning {
    background-color: var(--color-warning);
    color: white;
  }

  .badge.error {
    background-color: var(--color-error);
    color: white;
  }

  .badge.muted {
    background-color: var(--color-secondary);
    color: white;
  }

  code {
    font-family: var(--font-mono);
    background-color: var(--color-muted);
    padding: 0.125rem 0.25rem;
    border-radius: 0.25rem;
    font-size: 0.875em;
  }

  pre {
    font-family: var(--font-mono);
    background-color: var(--color-muted);
    padding: 1rem;
    border-radius: 0.5rem;
    overflow-x: auto;
    font-size: 0.875rem;
  }

  pre code {
    background: none;
    padding: 0;
  }

  .card {
    background-color: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 0.5rem;
    padding: 1.5rem;
    margin: 1rem 0;
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1rem;
    margin: 1.5rem 0;
  }

  .stat-card {
    background-color: var(--color-muted);
    padding: 1rem;
    border-radius: 0.5rem;
    border: 1px solid var(--color-border);
  }

  .stat-card .value {
    font-size: 2rem;
    font-weight: 700;
    color: var(--color-primary);
  }

  .stat-card .label {
    color: var(--color-secondary);
    font-size: 0.875rem;
    margin-top: 0.25rem;
  }

  .entity-list,
  .link-list {
    list-style: none;
  }

  .entity-list li,
  .link-list li {
    border-bottom: 1px solid var(--color-border);
    padding: 1rem 0;
  }

  .entity-list li:last-child,
  .link-list li:last-child {
    border-bottom: none;
  }

  .entity-title {
    font-weight: 600;
    font-size: 1.125rem;
    margin-bottom: 0.25rem;
  }

  .entity-title a {
    color: var(--color-fg);
    text-decoration: none;
  }

  .entity-title a:hover {
    color: var(--color-primary);
  }

  .entity-meta {
    color: var(--color-secondary);
    font-size: 0.875rem;
  }

  .error-message {
    background-color: #fef2f2;
    border: 1px solid var(--color-error);
    color: #991b1b;
    padding: 1rem;
    border-radius: 0.5rem;
    margin: 1rem 0;
  }

  .success-message {
    background-color: #f0fdf4;
    border: 1px solid var(--color-success);
    color: #166534;
    padding: 1rem;
    border-radius: 0.5rem;
    margin: 1rem 0;
  }

  .filter-form {
    width: 100%;
  }

  .form-row {
    display: flex;
    gap: 1rem;
    margin-bottom: 1rem;
    flex-wrap: wrap;
  }

  .form-group {
    flex: 1;
    min-width: 200px;
  }

  .form-group label {
    display: block;
    font-weight: 600;
    margin-bottom: 0.5rem;
    color: var(--color-fg);
  }

  .form-group input,
  .form-group select,
  .form-group textarea {
    width: 100%;
    padding: 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: 0.375rem;
    background-color: var(--color-bg);
    color: var(--color-fg);
    font-family: var(--font-family);
    font-size: 0.875rem;
  }

  .form-group input:focus,
  .form-group select:focus,
  .form-group textarea:focus {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
  }

  .form-group textarea {
    min-height: 100px;
    resize: vertical;
  }

  @media (max-width: 768px) {
    .stats-grid {
      grid-template-columns: 1fr;
    }

    nav ul {
      flex-direction: column;
      gap: 0.5rem;
    }

    .user-menu {
      float: none;
      margin-top: 1rem;
    }

    table {
      font-size: 0.875rem;
    }

    th, td {
      padding: 0.5rem;
    }

    .form-row {
      flex-direction: column;
    }

    .form-group {
      min-width: 100%;
    }
  }
`;

// User type for rendering - matches JwtPayload shape
interface User {
  user_id: string;
  email: string;
  display_name?: string;
}

interface PageOptions {
  title: string;
  user?: User | null;
  activePath?: string;
  breadcrumbs?: Array<{ label: string; href?: string }>;
}

/**
 * Render the HTML header section
 */
export function renderHeader(options: PageOptions): string {
  const { user, activePath = '' } = options;

  const navItems = [
    { label: 'Home', href: '/ui', path: '/ui' },
    { label: 'Entities', href: '/ui/entities', path: '/ui/entities' },
    { label: 'Links', href: '/ui/links', path: '/ui/links' },
    { label: 'Types', href: '/ui/types', path: '/ui/types' },
    { label: 'Search', href: '/ui/search', path: '/ui/search' },
  ];

  const userMenu = user
    ? `
    <div class="user-menu">
      <span>${escapeHtml(user.display_name || user.email)}</span>
      <a href="/ui/auth/logout">Logout</a>
    </div>
  `
    : `
    <div class="user-menu">
      <a href="/ui/auth/login">Login</a>
    </div>
  `;

  return `
    <header>
      <div class="container">
        <h1><a href="/ui">Gruff</a></h1>
        ${userMenu}
        <nav>
          <ul>
            ${navItems
              .map(
                item => `
              <li><a href="${item.href}" ${activePath.startsWith(item.path) ? 'class="active"' : ''}>${item.label}</a></li>
            `
              )
              .join('')}
          </ul>
        </nav>
      </div>
    </header>
  `;
}

/**
 * Render breadcrumb navigation
 */
export function renderBreadcrumbs(breadcrumbs: Array<{ label: string; href?: string }>): string {
  if (!breadcrumbs || breadcrumbs.length === 0) return '';

  const items = breadcrumbs
    .map(crumb => {
      if (crumb.href) {
        return `<a href="${crumb.href}">${escapeHtml(crumb.label)}</a>`;
      }
      return `<span>${escapeHtml(crumb.label)}</span>`;
    })
    .join(' <span>/</span> ');

  return `<div class="breadcrumb">${items}</div>`;
}

/**
 * Render the HTML footer section
 */
export function renderFooter(): string {
  return `
    <footer>
      <div class="container">
        <p>Gruff v1.0.0 - Entity-Relationship Database with Versioning</p>
        <p>
          <a href="/docs">API Documentation</a> |
          <a href="/health">Health Check</a> |
          <a href="/api/version">Version Info</a>
        </p>
      </div>
    </footer>
  `;
}

/**
 * Render a complete HTML page
 */
export function renderPage(options: PageOptions, content: string): string {
  const { title, breadcrumbs } = options;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} - Gruff</title>
  <style>${commonStyles}</style>
</head>
<body>
  ${renderHeader(options)}
  <main>
    <div class="container">
      ${breadcrumbs ? renderBreadcrumbs(breadcrumbs) : ''}
      ${content}
    </div>
  </main>
  ${renderFooter()}
</body>
</html>`;
}
