# API Development Guide

This guide covers how to extend and develop the Gruff API. It explains the project structure, patterns, and conventions used throughout the codebase.

## Table of Contents

1. [Project Structure](#project-structure)
2. [Technology Stack](#technology-stack)
3. [Adding New Routes](#adding-new-routes)
4. [Schema Validation](#schema-validation)
5. [Middleware](#middleware)
6. [Database Operations](#database-operations)
7. [Response Formatting](#response-formatting)
8. [Error Handling](#error-handling)
9. [Authentication](#authentication)
10. [Caching](#caching)
11. [Logging and Monitoring](#logging-and-monitoring)
12. [Testing](#testing)

## Project Structure

```
gruff/
├── src/
│   ├── index.ts              # Main entry point, middleware chain, route mounting
│   ├── routes/               # Route handlers (one file per resource)
│   │   ├── entities.ts       # Entity CRUD operations
│   │   ├── links.ts          # Link CRUD operations
│   │   ├── types.ts          # Type management
│   │   ├── auth.ts           # Authentication endpoints
│   │   ├── users.ts          # User management
│   │   ├── graph.ts          # Graph traversal operations
│   │   ├── search.ts         # Search endpoints
│   │   ├── bulk.ts           # Bulk operations
│   │   ├── export.ts         # Import/export functionality
│   │   ├── audit.ts          # Audit log queries
│   │   ├── docs.ts           # OpenAPI documentation
│   │   ├── generated-columns.ts  # Schema introspection
│   │   └── query-plan.ts     # Query plan analysis
│   ├── schemas/              # Zod validation schemas
│   │   ├── common.ts         # Shared schemas (UUID, timestamps, pagination)
│   │   ├── entity.ts         # Entity schemas
│   │   ├── link.ts           # Link schemas
│   │   ├── type.ts           # Type schemas
│   │   ├── user.ts           # User and JWT schemas
│   │   ├── search.ts         # Search query schemas
│   │   ├── bulk.ts           # Bulk operation schemas
│   │   ├── export.ts         # Import/export schemas
│   │   ├── audit.ts          # Audit log schemas
│   │   └── index.ts          # Re-exports all schemas
│   ├── middleware/           # Hono middleware
│   │   ├── auth.ts           # JWT authentication
│   │   ├── validation.ts     # Request validation
│   │   ├── rate-limit.ts     # Rate limiting
│   │   ├── security.ts       # CORS and security headers
│   │   ├── etag.ts           # ETag caching
│   │   ├── request-context.ts    # Request ID and logger
│   │   ├── response-time.ts  # Performance tracking
│   │   ├── query-tracking.ts # Database query tracking
│   │   └── error-handler.ts  # Error handling utilities
│   ├── utils/                # Utility functions
│   │   ├── response.ts       # Response formatting
│   │   ├── jwt.ts            # JWT creation and verification
│   │   ├── password.ts       # Password hashing (PBKDF2)
│   │   ├── logger.ts         # Structured logging
│   │   ├── cache.ts          # KV caching utilities
│   │   ├── sanitize.ts       # XSS prevention
│   │   ├── json-schema.ts    # JSON Schema validation
│   │   ├── property-filters.ts   # Advanced property filtering
│   │   ├── audit.ts          # Audit logging utilities
│   │   ├── session.ts        # Session management
│   │   ├── rate-limit.ts     # Rate limit utilities
│   │   ├── error-tracking.ts # Analytics Engine error tracking
│   │   ├── field-selection.ts    # Partial response support
│   │   └── sensitive-data.ts # Data redaction
│   ├── services/             # External service integrations
│   │   ├── google-oauth.ts   # Google OAuth2
│   │   └── github-oauth.ts   # GitHub OAuth2
│   └── openapi/              # OpenAPI specification
│       ├── config.ts         # OpenAPI configuration
│       ├── schemas.ts        # OpenAPI schema definitions
│       ├── spec.ts           # Full OpenAPI spec
│       └── index.ts          # Spec exports
├── migrations/               # D1 database migrations
│   ├── 0001_initial_schema.sql
│   ├── 0002_version_triggers.sql
│   └── ...
├── test/                     # Unit tests
├── test-runner.js            # Integration test runner
├── wrangler.toml             # Cloudflare Workers configuration
└── vitest.config.ts          # Test configuration
```

## Technology Stack

- **Runtime**: Cloudflare Workers (serverless edge computing)
- **Framework**: [Hono](https://hono.dev/) - lightweight, fast web framework
- **Database**: Cloudflare D1 (SQLite at the edge)
- **Cache/Sessions**: Cloudflare KV (key-value store)
- **Validation**: [Zod](https://zod.dev/) - TypeScript-first schema validation
- **Language**: TypeScript

## Adding New Routes

### Step 1: Create the Route File

Create a new file in `src/routes/`. Follow the existing pattern:

```typescript
// src/routes/myresource.ts
import { Hono } from 'hono';
import { validateJson, validateQuery } from '../middleware/validation.js';
import { myResourceSchema, myResourceQuerySchema } from '../schemas/index.js';
import * as response from '../utils/response.js';
import { getLogger } from '../middleware/request-context.js';

// Define environment bindings
type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  ENVIRONMENT: string;
};

const myResource = new Hono<{ Bindings: Bindings }>();

// GET /api/myresource - List resources
myResource.get('/', validateQuery(myResourceQuerySchema), async c => {
  const logger = getLogger(c);
  const query = c.get('validated_query') as any;
  const db = c.env.DB;

  try {
    // Database query logic here
    const results = await db.prepare('SELECT * FROM my_table LIMIT ?').bind(query.limit).all();

    return c.json(response.success(results.results));
  } catch (error) {
    logger.error('Failed to list resources', error as Error);
    return c.json(response.internalError(), 500);
  }
});

// GET /api/myresource/:id - Get single resource
myResource.get('/:id', async c => {
  const logger = getLogger(c);
  const { id } = c.req.param();
  const db = c.env.DB;

  try {
    const result = await db.prepare('SELECT * FROM my_table WHERE id = ?').bind(id).first();

    if (!result) {
      return c.json(response.notFound('Resource'), 404);
    }

    return c.json(response.success(result));
  } catch (error) {
    logger.error('Failed to get resource', error as Error, { id });
    return c.json(response.internalError(), 500);
  }
});

// POST /api/myresource - Create resource
myResource.post('/', validateJson(myResourceSchema), async c => {
  const logger = getLogger(c);
  const data = c.get('validated_json') as any;
  const db = c.env.DB;

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  try {
    await db
      .prepare('INSERT INTO my_table (id, name, created_at) VALUES (?, ?, ?)')
      .bind(id, data.name, now)
      .run();

    const created = await db.prepare('SELECT * FROM my_table WHERE id = ?').bind(id).first();

    logger.info('Resource created', { id });
    return c.json(response.created(created), 201);
  } catch (error) {
    logger.error('Failed to create resource', error as Error);
    return c.json(response.internalError(), 500);
  }
});

export default myResource;
```

### Step 2: Mount the Route

In `src/index.ts`, import and mount your route:

```typescript
import myResourceRouter from './routes/myresource.js';

// ... other route mounts ...

// Mount your new route
app.route('/api/myresource', myResourceRouter);
```

### Step 3: Add Protected Routes (if needed)

To require authentication, use the auth middleware:

```typescript
import { requireAuth } from '../middleware/auth.js';

// Apply to specific routes
myResource.post('/', requireAuth(), validateJson(myResourceSchema), async c => {
  // Access authenticated user
  const user = c.get('user');
  // user.user_id, user.email, etc.
});

// Or apply to all routes in the router
myResource.use('*', requireAuth());
```

## Schema Validation

All input validation uses Zod schemas defined in `src/schemas/`.

### Creating Schemas

```typescript
// src/schemas/myresource.ts
import { z } from 'zod';
import {
  uuidSchema,
  timestampSchema,
  paginationQuerySchema,
  sanitizedJsonPropertiesSchema,
} from './common.js';

// Create schema (request body)
export const createMyResourceSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  properties: sanitizedJsonPropertiesSchema.optional().default({}),
});

// Update schema (partial)
export const updateMyResourceSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  properties: sanitizedJsonPropertiesSchema.optional(),
});

// Query parameters schema
export const myResourceQuerySchema = paginationQuerySchema.extend({
  name: z.string().optional(),
  created_after: z
    .string()
    .transform(val => parseInt(val, 10))
    .pipe(z.number().int().positive())
    .optional(),
});

// Response schema (for documentation)
export const myResourceResponseSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  description: z.string().nullable(),
  properties: z.record(z.string(), z.unknown()),
  created_at: timestampSchema,
});

// Export types
export type CreateMyResource = z.infer<typeof createMyResourceSchema>;
export type UpdateMyResource = z.infer<typeof updateMyResourceSchema>;
export type MyResourceQuery = z.infer<typeof myResourceQuerySchema>;
export type MyResourceResponse = z.infer<typeof myResourceResponseSchema>;
```

### Using Validation Middleware

```typescript
import { validateJson, validateQuery, validateParam } from '../middleware/validation.js';

// Validate JSON body
router.post('/', validateJson(createSchema), handler);

// Validate query parameters
router.get('/', validateQuery(querySchema), handler);

// Access validated data
const data = c.get('validated_json') as CreateMyResource;
const query = c.get('validated_query') as MyResourceQuery;
```

### Common Schema Patterns

```typescript
import {
  uuidSchema, // z.string().uuid()
  timestampSchema, // z.number().int().positive()
  sqliteBooleanSchema, // z.union([z.literal(0), z.literal(1)])
  jsonPropertiesSchema, // z.record(z.string(), z.unknown())
  sanitizedJsonPropertiesSchema, // Auto-sanitizes for XSS
  paginationQuerySchema, // limit, cursor, include_deleted, fields
} from './common.js';
```

## Middleware

### Global Middleware (in order of execution)

1. **Request Context** - Adds request ID and logger
2. **Environment Validation** - Validates required secrets
3. **Security** - CORS and security headers
4. **Response Time** - Tracks performance metrics
5. **Rate Limiting** - Per-user/IP rate limits
6. **Query Tracking** - Database performance metrics
7. **ETag** - Conditional request caching

### Creating Custom Middleware

```typescript
// src/middleware/my-middleware.ts
import { Context, Next } from 'hono';
import { getLogger } from './request-context.js';

type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
};

export function myMiddleware(options?: { someOption: boolean }) {
  return async (c: Context<{ Bindings: Bindings }>, next: Next) => {
    const logger = getLogger(c);

    // Pre-processing
    logger.debug('Middleware executing');

    // Continue to next handler
    await next();

    // Post-processing (after route handler)
    const status = c.res.status;
    logger.debug('Request completed', { status });
  };
}
```

### Applying Middleware

```typescript
// To specific routes
router.get('/protected', myMiddleware(), handler);

// To all routes in a router
router.use('*', myMiddleware());

// To path patterns in main app
app.use('/api/*', myMiddleware());
```

## Database Operations

### Using D1 Database

```typescript
const db = c.env.DB;

// Single row
const row = await db.prepare('SELECT * FROM table WHERE id = ?')
  .bind(id)
  .first();

// Multiple rows
const { results } = await db.prepare('SELECT * FROM table WHERE type = ? LIMIT ?')
  .bind(type, limit)
  .all();

// Insert/Update/Delete
const { success, meta } = await db.prepare('INSERT INTO table (id, name) VALUES (?, ?)')
  .bind(id, name)
  .run();

// Batch operations (transaction-like)
const batchResults = await db.batch([
  db.prepare('INSERT INTO table1 ...').bind(...),
  db.prepare('INSERT INTO table2 ...').bind(...),
]);
```

### Migration Patterns

Migrations are automatically discovered and run in order from the `migrations/` directory.

**Adding a new migration:**

1. Find the next available number (e.g., if last is 0009, use 0010)
2. Create `migrations/0010_my_feature.sql` with your schema changes
3. That's it! The migration runner will automatically pick it up

Example migration file:

```sql
-- migrations/0010_my_feature.sql

-- Create new table
CREATE TABLE IF NOT EXISTS my_table (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  is_deleted INTEGER DEFAULT 0
);

-- Add indexes
CREATE INDEX IF NOT EXISTS idx_my_table_name ON my_table(name);
CREATE INDEX IF NOT EXISTS idx_my_table_created ON my_table(created_at);
```

**Running migrations:**

```bash
# Local development
npm run migrate:local          # Run all migrations
npm run seed:local             # Load seed data
npm run db:setup:local         # Migrations + seed in one command
npm run db:reset:local         # Nuke everything and start fresh

# Production/remote
npm run migrate:remote         # Run all migrations on remote DB
npm run db:setup:remote        # Migrations + seed on remote DB
```

**How it works:**

The migration runner (`scripts/migrate.js`):

- Auto-discovers all `.sql` files in `migrations/`
- Sorts them alphabetically (0001, 0002, 0003, ...)
- Runs them in order
- Excludes `0004_seed_data.sql` (not a migration, just test data)
- No need to update package.json when adding migrations!

### Versioning Pattern

Entities and links use immutable versioning:

```typescript
// Creating a new version
const newId = crypto.randomUUID();
await db
  .prepare(
    `
  UPDATE entities SET is_latest = 0 WHERE id = ?
`
  )
  .bind(currentId)
  .run();

await db
  .prepare(
    `
  INSERT INTO entities (id, type_id, properties, version, previous_version_id, created_at, created_by, is_latest)
  VALUES (?, ?, ?, ?, ?, ?, ?, 1)
`
  )
  .bind(newId, typeId, JSON.stringify(properties), newVersion, currentId, now, userId)
  .run();
```

## Response Formatting

Use the response utilities for consistent API responses:

```typescript
import * as response from '../utils/response.js';

// Success responses
return c.json(response.success(data));
return c.json(response.success(data, 'Operation completed'));
return c.json(response.created(data), 201);
return c.json(response.updated(data));
return c.json(response.deleted());

// Paginated responses
return c.json(response.cursorPaginated(items, nextCursor, hasMore));

// Error responses
return c.json(response.notFound('Entity'), 404);
return c.json(response.badRequest('Invalid input'), 400);
return c.json(response.unauthorized(), 401);
return c.json(response.forbidden(), 403);
return c.json(response.validationError(details), 400);
return c.json(response.internalError(), 500);
```

### Standard Response Structure

```typescript
// Success
{
  "success": true,
  "data": { ... },
  "message": "Optional message",
  "metadata": {
    "hasMore": true,
    "cursor": "next-cursor",
    "total": 100
  },
  "timestamp": "2024-01-15T10:30:00.000Z"
}

// Error
{
  "success": false,
  "error": "Error message",
  "code": "ERROR_CODE",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

## Error Handling

### Global Error Handler

The global error handler in `src/index.ts` catches all unhandled errors:

- Zod validation errors → 400 with detailed field errors
- JSON parse errors → 400 with message
- Generic errors → 500 (with stack traces in development only)

### Throwing Errors

```typescript
// Use response utilities for expected errors
if (!entity) {
  return c.json(response.notFound('Entity'), 404);
}

// Throw for unexpected errors (caught by global handler)
throw new Error('Unexpected database state');
```

### Error Tracking

Errors are automatically tracked in Analytics Engine:

```typescript
import { createErrorTracker } from '../utils/error-tracking.js';

// Manual error tracking
const tracker = createErrorTracker(c.env.ANALYTICS, {
  environment: c.env.ENVIRONMENT,
});

tracker.track(error, {
  requestId: getRequestId(c),
  path: c.req.path,
  method: c.req.method,
  statusCode: 500,
  userId: c.get('user')?.id,
});
```

## Authentication

### JWT Authentication

```typescript
import { requireAuth, optionalAuth } from '../middleware/auth.js';

// Required authentication
router.post('/', requireAuth(), handler);

// Optional authentication
router.get('/', optionalAuth(), handler);

// Access user in handler
const user = c.get('user');
// user.user_id, user.email, user.display_name
```

### Creating JWTs

```typescript
import { createAccessToken, createRefreshToken, verifyAccessToken } from '../utils/jwt.js';

// Create tokens
const accessToken = await createAccessToken(
  { user_id: userId, email, display_name },
  jwtSecret,
  '15m' // expiration
);

const refreshToken = await createRefreshToken({ user_id: userId }, jwtSecret, '7d');

// Verify tokens
const payload = await verifyAccessToken(token, jwtSecret);
```

## Caching

### KV Cache Utilities

```typescript
import {
  getCache,
  setCache,
  deleteCache,
  getEntityCacheKey,
  invalidateEntityCache,
  CACHE_TTL,
} from '../utils/cache.js';

// Get from cache
const cached = await getCache<MyType>(c.env.KV, cacheKey);
if (cached) {
  return c.json(response.success(cached));
}

// Set cache
await setCache(c.env.KV, cacheKey, data, CACHE_TTL.ENTITIES);

// Invalidate on changes
await invalidateEntityCache(c.env.KV, entityId);
```

### Cache TTLs

```typescript
CACHE_TTL = {
  TYPES: 300, // 5 minutes
  ENTITIES: 60, // 1 minute
  LINKS: 60, // 1 minute
  USERS: 120, // 2 minutes
};
```

## Logging and Monitoring

### Structured Logging

```typescript
import { getLogger } from '../middleware/request-context.js';

const logger = getLogger(c);

logger.debug('Debug message', { context: 'value' });
logger.info('Info message', { userId: id });
logger.warn('Warning message');
logger.error('Error message', error, { context: 'value' });
```

### Performance Tracking

Response times and query performance are automatically tracked via middleware and written to Analytics Engine.

### Audit Logging

```typescript
import { logEntityOperation } from '../utils/audit.js';

await logEntityOperation(db, {
  operation: 'create', // or 'update', 'delete', 'restore'
  resourceType: 'entity',
  resourceId: entityId,
  userId: userId,
  details: { ... },
  ipAddress: c.req.header('cf-connecting-ip'),
  userAgent: c.req.header('user-agent'),
});
```

## Testing

### Unit Tests

Unit tests use Vitest with the Cloudflare Workers pool:

```typescript
// test/utils/myutil.test.ts
import { describe, it, expect } from 'vitest';
import { myFunction } from '../../src/utils/myutil.js';

describe('myFunction', () => {
  it('should return expected result', () => {
    const result = myFunction('input');
    expect(result).toBe('expected');
  });

  it('should handle edge cases', () => {
    expect(() => myFunction(null)).toThrow();
  });
});
```

Run unit tests:

```bash
npm run test:unit
npm run test:unit:watch
npm run test:coverage
```

### Integration Tests

Integration tests run against the local dev server. Add tests to `test-runner.js`:

```javascript
async function testMyFeature() {
  logTest('My Feature Description');

  // Create test data
  const createRes = await makeRequest('POST', '/api/myresource', {
    name: 'Test Resource',
  });
  assertEquals(createRes.status, 201, 'Should create resource');

  const id = createRes.data.data.id;
  assert(id, 'Should return resource ID');

  // Read test
  const getRes = await makeRequest('GET', `/api/myresource/${id}`);
  assertEquals(getRes.status, 200, 'Should get resource');
  assertEquals(getRes.data.data.name, 'Test Resource', 'Should return correct name');

  // Update test
  const updateRes = await makeRequest('PUT', `/api/myresource/${id}`, {
    name: 'Updated Name',
  });
  assertEquals(updateRes.status, 200, 'Should update resource');

  // Delete test
  const deleteRes = await makeRequest('DELETE', `/api/myresource/${id}`);
  assertEquals(deleteRes.status, 200, 'Should delete resource');
}
```

Add to the test array:

```javascript
const tests = [
  // ... existing tests
  testMyFeature,
];
```

Run integration tests:

```bash
npm test
```

## API Documentation

### OpenAPI Specification

The API is documented using OpenAPI 3.1.0, auto-generated from route definitions via `@hono/zod-openapi`. There is no manually maintained spec file — the spec is derived directly from `createRoute()` definitions in `src/routes/*.ts` and Zod schemas in `src/schemas/*.ts`.

To add a new endpoint to the spec, define it using `createRoute()` and register it with `router.openapi()`:

```typescript
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';

const myRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['MyResource'],
  summary: 'List resources',
  request: {
    query: z.object({
      limit: z
        .string()
        .optional()
        .openapi({ param: { name: 'limit', in: 'query' } }),
      cursor: z
        .string()
        .optional()
        .openapi({ param: { name: 'cursor', in: 'query' } }),
    }),
  },
  responses: {
    200: {
      description: 'List of resources',
      content: {
        'application/json': {
          schema: MyResourceListSchema,
        },
      },
    },
  },
});

router.openapi(myRoute, async c => {
  // Handler implementation
});
```

View documentation at:

- Interactive UI: `http://localhost:8787/docs`
- OpenAPI JSON: `http://localhost:8787/docs/openapi.json`
- OpenAPI YAML: `http://localhost:8787/docs/openapi.yaml`

## Best Practices

### Do's

- Use TypeScript types derived from Zod schemas
- Always validate input with Zod schemas
- Use response utilities for consistent formatting
- Log with structured context using `getLogger(c)`
- Handle errors gracefully with appropriate status codes
- Write unit tests for utility functions
- Write integration tests for API endpoints
- Use parameterized queries to prevent SQL injection
- Sanitize user input with `sanitizedJsonPropertiesSchema`

### Don'ts

- Don't expose stack traces in production
- Don't store sensitive data in logs (auto-redacted by logger)
- Don't bypass validation middleware
- Don't use string concatenation for SQL queries
- Don't assume request data is valid without validation
- Don't forget to invalidate cache on mutations

## Quick Reference

### Environment Bindings

```typescript
type Bindings = {
  DB: D1Database; // Cloudflare D1 database
  KV: KVNamespace; // Cloudflare KV store
  JWT_SECRET: string; // JWT signing secret
  ENVIRONMENT: string; // development | preview | production
  ANALYTICS?: AnalyticsEngineDataset; // Error tracking
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
};
```

### Common Imports

```typescript
// Routes
import { Hono } from 'hono';
import { validateJson, validateQuery } from '../middleware/validation.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import * as response from '../utils/response.js';
import { getLogger, getRequestId } from '../middleware/request-context.js';

// Schemas
import { z } from 'zod';
import { uuidSchema, paginationQuerySchema, sanitizedJsonPropertiesSchema } from './common.js';

// Utilities
import { getCache, setCache, deleteCache, CACHE_TTL } from '../utils/cache.js';
import { applyFieldSelection, ENTITY_ALLOWED_FIELDS } from '../utils/field-selection.js';
import { logEntityOperation } from '../utils/audit.js';
```

### HTTP Status Codes

| Code | Usage                          |
| ---- | ------------------------------ |
| 200  | Success (GET, PUT, DELETE)     |
| 201  | Created (POST)                 |
| 304  | Not Modified (ETag match)      |
| 400  | Bad Request / Validation Error |
| 401  | Unauthorized                   |
| 403  | Forbidden                      |
| 404  | Not Found                      |
| 409  | Conflict                       |
| 429  | Rate Limited                   |
| 500  | Internal Server Error          |
