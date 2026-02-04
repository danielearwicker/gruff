# OpenAPI Refactoring Checklist

**Goal:** Replace manually maintained OpenAPI spec (2,624 lines in `src/openapi/spec.ts`) with auto-generated spec from `@hono/zod-openapi`.

**Why:** Currently, API documentation and validation schemas are separate. Changes require updating both places with no static checking. This causes drift and maintenance burden.

**Approach:** Convert routes to use `OpenAPIHono` + `createRoute()` so Zod schemas generate OpenAPI docs automatically.

---

## Resources

**Read these files for guidance:**

- **Code patterns:** `docs/HONO_OPENAPI_REFERENCE.md` - How to use OpenAPIHono, createRoute(), .openapi() annotations
- **Current spec:** `docs/openapi-baseline.json` - Baseline for comparison (4,145 lines)
- **Existing schemas:** `src/schemas/*.ts` - Zod schemas that need .openapi() annotations
- **Existing routes:** `src/routes/*.ts` - Route handlers to convert

**External docs (if needed):**
- https://github.com/honojs/middleware/tree/main/packages/zod-openapi

---

## Prerequisites - DO NOW (Before Starting Loop)

These setup steps must be completed BEFORE starting the iterative loop. They establish the infrastructure that allows gradual migration.

### 1. Create backup branch
```bash
git checkout -b openapi-refactor
```

### 2. Run baseline tests
```bash
npm test
```
All tests must pass before starting. Record this as your baseline.

### 3. Create common OpenAPI schemas
Create `src/schemas/openapi-common.ts` with shared response schemas:

```typescript
import { z } from '@hono/zod-openapi';

export const ErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.string().openapi({ example: 'Resource not found' }),
  code: z.string().optional().openapi({ example: 'NOT_FOUND' }),
  timestamp: z.string().openapi({ example: '2024-01-15T10:30:00.000Z' }),
  path: z.string().optional(),
  requestId: z.string().optional()
}).openapi('ErrorResponse');

export const ValidationErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.literal('Validation failed'),
  code: z.literal('VALIDATION_ERROR'),
  details: z.array(z.object({
    path: z.string().openapi({ example: 'type_id' }),
    message: z.string().openapi({ example: 'Invalid UUID format' }),
    code: z.string().openapi({ example: 'invalid_string' })
  })),
  timestamp: z.string(),
  path: z.string(),
  requestId: z.string().optional()
}).openapi('ValidationErrorResponse');

export const SuccessResponseSchema = z.object({
  success: z.literal(true),
  message: z.string().optional(),
  timestamp: z.string()
}).openapi('SuccessResponse');

export const PaginationQuerySchema = z.object({
  limit: z.string().optional().openapi({
    param: { name: 'limit', in: 'query' },
    example: '20'
  }),
  cursor: z.string().optional().openapi({
    param: { name: 'cursor', in: 'query' },
    example: 'eyJpZCI6IjEyMyJ9'
  }),
  include_deleted: z.string().optional().openapi({
    param: { name: 'include_deleted', in: 'query' },
    example: 'false'
  })
});
```

See `docs/HONO_OPENAPI_REFERENCE.md` for more patterns.

### 4. Update main app to use OpenAPIHono

**CRITICAL: OpenAPIHono is backwards compatible with regular Hono routes.**

Edit `src/index.ts`:

```typescript
// Change this:
import { Hono } from 'hono';
const app = new Hono<{ Bindings: Bindings }>();

// To this:
import { OpenAPIHono } from '@hono/zod-openapi';
const app = new OpenAPIHono<{ Bindings: Bindings }>();

// Add OpenAPI spec generation endpoint (after middleware, before routes)
app.doc('/docs/openapi.json', {
  openapi: '3.1.0',
  info: {
    title: 'Gruff API',
    version: '1.0.0',
  },
  servers: [
    { url: 'http://localhost:8787', description: 'Local development' }
  ]
});

// Existing routes will continue to work unchanged!
// They mount with .route() as before
```

### 5. Verify gradual migration works

**Test that existing routes still work with OpenAPIHono:**

```bash
# Start dev server
npm run dev

# Test a few existing endpoints
curl http://localhost:8787/health
curl http://localhost:8787/api/types

# Check OpenAPI spec generates (will be empty initially)
curl http://localhost:8787/docs/openapi.json

# Check Scalar UI
open http://localhost:8787/docs
```

### 6. Run full test suite
```bash
npm test
```

**All tests must still pass.** If any fail, the setup has broken something. Fix before proceeding.

### 7. Commit setup
```bash
git add .
git commit -m "OpenAPI: Setup infrastructure (backwards compatible)"
```

---

## Iteration Process (FOLLOW EXACTLY)

Now you're ready for the iterative loop. Each iteration converts **ONE endpoint** from the checklist below.

### 1. Pick ONE unchecked endpoint
Find a `[ ]` item from the checklist. Work top to bottom.

### 2. Understand the endpoint
Read the checkbox description. It tells you:
- Which route to convert (e.g., `POST /api/types`)
- What file to edit (e.g., `src/routes/types.ts`)
- What the endpoint does
- How to test it

### 3. Review patterns
Check `docs/HONO_OPENAPI_REFERENCE.md` for relevant code patterns.

### 4. Convert the route
**Pattern to follow:**

```typescript
// 1. Import OpenAPIHono and createRoute
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';

// 2. Change router from Hono to OpenAPIHono
const router = new OpenAPIHono<{ Bindings: Bindings }>();

// 3. Define route with createRoute()
const createTypeRoute = createRoute({
  method: 'post',
  path: '/api/types',
  tags: ['Types'],
  summary: 'Create a new type',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: createTypeSchema // Zod schema with .openapi() annotations
        }
      }
    }
  },
  responses: {
    201: {
      description: 'Type created',
      content: {
        'application/json': {
          schema: z.object({
            success: z.literal(true),
            data: TypeSchema,
            timestamp: z.string()
          })
        }
      }
    },
    400: { /* ... */ },
    401: { /* ... */ }
  }
});

// 4. Replace old handler with .openapi() method
// OLD: router.post('/', requireAuth(), requireAdmin(), validateJson(schema), async c => {
// NEW:
router.openapi(createTypeRoute, async c => {
  // Access validated data: c.req.valid('json')
  // Existing implementation unchanged
});
```

### 5. Verify test coverage for this endpoint
- Read the integration test for this endpoint
- Ensure it covers success, errors, auth, validation
- If inadequate, improve tests first

### 6. Run full test suite ⚠️ CRITICAL
```bash
npm test
```

**All tests must pass.** If tests fail:
- Fix the refactored code, OR
- Update tests if they relied on old patterns
- Never proceed with failing tests

### 7. Manual smoke test (optional)
```bash
npm run dev
curl http://localhost:8787/api/endpoint  # Test it works
curl http://localhost:8787/docs/openapi.json | jq '.paths' # Verify in spec
open http://localhost:8787/docs  # Check Scalar UI
```

### 8. Check off the item
Change `[ ]` to `[x]` in this file.

### 9. Commit
```bash
git add .
git commit -m "OpenAPI: Convert [endpoint description]"
```

---

## The Checklist

Work through these in order. Each item is ONE endpoint conversion.

### Health Endpoints (Simple, no auth)

- [ ] **Convert GET /health** - File: `src/index.ts`. Endpoint checks system health. Test: `curl http://localhost:8787/health`
- [ ] **Convert GET /api/version** - File: `src/index.ts`. Endpoint returns API version. Test: `curl http://localhost:8787/api/version`

### Types API (`src/routes/types.ts`)

Before converting types routes, annotate schemas:
- [ ] **Annotate type schemas** - Add `.openapi()` to `createTypeSchema`, `updateTypeSchema`, `typeQuerySchema` in `src/schemas/type.ts`. See `docs/HONO_OPENAPI_REFERENCE.md` for examples.
- [ ] **Convert types router to OpenAPIHono** - Change `new Hono()` to `new OpenAPIHono()` at top of `src/routes/types.ts`

Then convert each endpoint:
- [ ] **Convert POST /api/types** - Creates type (admin only). Test: Create type via curl with admin token
- [ ] **Convert GET /api/types** - Lists all types with pagination. Test: `curl http://localhost:8787/api/types`
- [ ] **Convert GET /api/types/:id** - Gets single type by ID. Test: `curl http://localhost:8787/api/types/{uuid}`
- [ ] **Convert PUT /api/types/:id** - Updates type (admin only). Test: Update type via curl
- [ ] **Convert DELETE /api/types/:id** - Deletes type (admin only). Test: Delete type via curl

### Authentication API (`src/routes/auth.ts`)

Prepare schemas and router:
- [ ] **Annotate auth schemas** - Add `.openapi()` to `createUserSchema`, `loginSchema`, `refreshTokenSchema`, `logoutSchema` in `src/schemas/user.ts`
- [ ] **Convert auth router to OpenAPIHono** - Change to `new OpenAPIHono()` in `src/routes/auth.ts`

Convert endpoints:
- [ ] **Convert POST /api/auth/register** - Registers new user. Test: Register via curl
- [ ] **Convert POST /api/auth/login** - Login with email/password. Test: Login via curl, verify tokens returned
- [ ] **Convert POST /api/auth/refresh** - Refreshes access token. Test: Refresh with valid refresh token
- [ ] **Convert POST /api/auth/logout** - Invalidates session. Test: Logout via curl
- [ ] **Convert GET /api/auth/me** - Gets current user (requires auth). Test: Get user with Bearer token
- [ ] **Convert GET /api/auth/google** - Initiates Google OAuth. Test: Check redirect URL
- [ ] **Convert GET /api/auth/google/callback** - Google OAuth callback. Test: Mock callback flow
- [ ] **Convert GET /api/auth/github** - Initiates GitHub OAuth. Test: Check redirect URL
- [ ] **Convert GET /api/auth/github/callback** - GitHub OAuth callback. Test: Mock callback flow
- [ ] **Convert GET /api/auth/providers** - Lists OAuth providers. Test: `curl http://localhost:8787/api/auth/providers`

### Entities API (`src/routes/entities.ts`)

Prepare:
- [ ] **Annotate entity schemas** - Add `.openapi()` to `createEntitySchema`, `updateEntitySchema`, `entityQuerySchema` in `src/schemas/entity.ts`
- [ ] **Convert entities router to OpenAPIHono** - Change to `new OpenAPIHono()` in `src/routes/entities.ts`

Convert endpoints:
- [ ] **Convert POST /api/entities** - Creates entity with auto ACL. Test: Create entity via curl
- [ ] **Convert GET /api/entities** - Lists entities with ACL filtering. Test: List entities
- [ ] **Convert GET /api/entities/:id** - Gets entity by ID. Test: Get specific entity
- [ ] **Convert PUT /api/entities/:id** - Updates entity (creates new version). Test: Update entity
- [ ] **Convert DELETE /api/entities/:id** - Soft-deletes entity. Test: Delete entity
- [ ] **Convert POST /api/entities/:id/restore** - Restores soft-deleted entity. Test: Restore entity
- [ ] **Convert GET /api/entities/:id/versions** - Lists all versions. Test: Get version list
- [ ] **Convert GET /api/entities/:id/versions/:version** - Gets specific version. Test: Get version by number
- [ ] **Convert GET /api/entities/:id/history** - Gets version history with diffs. Test: Get history
- [ ] **Convert GET /api/entities/:id/outbound** - Gets outbound links. Test: Get outbound links
- [ ] **Convert GET /api/entities/:id/inbound** - Gets inbound links. Test: Get inbound links
- [ ] **Convert GET /api/entities/:id/neighbors** - Gets all connected entities. Test: Get neighbors
- [ ] **Convert GET /api/entities/:id/acl** - Gets ACL permissions. Test: Get ACL
- [ ] **Convert PUT /api/entities/:id/acl** - Sets ACL permissions. Test: Update ACL

### Links API (`src/routes/links.ts`)

Prepare:
- [ ] **Annotate link schemas** - Add `.openapi()` to `createLinkSchema`, `updateLinkSchema`, `linkQuerySchema` in `src/schemas/link.ts`
- [ ] **Convert links router to OpenAPIHono** - Change to `new OpenAPIHono()` in `src/routes/links.ts`

Convert endpoints:
- [ ] **Convert POST /api/links** - Creates link between entities. Test: Create link
- [ ] **Convert GET /api/links** - Lists links with ACL filtering. Test: List links
- [ ] **Convert GET /api/links/:id** - Gets link by ID. Test: Get specific link
- [ ] **Convert PUT /api/links/:id** - Updates link (creates new version). Test: Update link
- [ ] **Convert DELETE /api/links/:id** - Soft-deletes link. Test: Delete link
- [ ] **Convert POST /api/links/:id/restore** - Restores soft-deleted link. Test: Restore link
- [ ] **Convert GET /api/links/:id/versions** - Lists all versions. Test: Get version list
- [ ] **Convert GET /api/links/:id/versions/:version** - Gets specific version. Test: Get version by number
- [ ] **Convert GET /api/links/:id/history** - Gets version history with diffs. Test: Get history
- [ ] **Convert GET /api/links/:id/acl** - Gets ACL permissions. Test: Get ACL
- [ ] **Convert PUT /api/links/:id/acl** - Sets ACL permissions. Test: Update ACL

### Graph API (`src/routes/graph.ts`)

Prepare:
- [ ] **Annotate graph schemas** - Add `.openapi()` to traversal/path schemas in `src/schemas/` (create `src/schemas/graph.ts` if needed)
- [ ] **Convert graph router to OpenAPIHono** - Change to `new OpenAPIHono()` in `src/routes/graph.ts`

Convert endpoints:
- [ ] **Convert POST /api/graph/traverse** - Multi-hop graph traversal. Test: Traverse with depth/direction filters
- [ ] **Convert GET /api/graph/path** - Finds shortest path between entities. Test: Find path between two entities
- [ ] **Convert GET /api/graph/entities/:id/graph-view** - Gets graph visualization data. Test: Get graph view for entity

### Search API (`src/routes/search.ts`)

Prepare:
- [ ] **Annotate search schemas** - Add `.openapi()` to `searchEntitiesSchema`, `searchLinksSchema`, `suggestionsSchema` in `src/schemas/search.ts`
- [ ] **Convert search router to OpenAPIHono** - Change to `new OpenAPIHono()` in `src/routes/search.ts`

Convert endpoints:
- [ ] **Convert POST /api/search/entities** - Searches entities with property filters. Test: Search with filters
- [ ] **Convert POST /api/search/links** - Searches links with filters. Test: Search links
- [ ] **Convert GET /api/search/suggest** - Type-ahead suggestions. Test: Get suggestions for partial query

### Users API (`src/routes/users.ts`)

Prepare:
- [ ] **Annotate user schemas** - Add `.openapi()` to user-related schemas in `src/schemas/user.ts`
- [ ] **Convert users router to OpenAPIHono** - Change to `new OpenAPIHono()` in `src/routes/users.ts`

Convert endpoints:
- [ ] **Convert GET /api/users** - Lists users (admin only). Test: List users with admin token
- [ ] **Convert GET /api/users/search** - Searches users by email/name. Test: Search users
- [ ] **Convert GET /api/users/:id** - Gets user profile. Test: Get user by ID
- [ ] **Convert PUT /api/users/:id** - Updates user (admin or self). Test: Update user
- [ ] **Convert GET /api/users/:id/activity** - Gets user activity log. Test: Get activity
- [ ] **Convert GET /api/users/:id/groups** - Gets direct group memberships. Test: Get groups
- [ ] **Convert GET /api/users/:id/effective-groups** - Gets all groups (nested). Test: Get effective groups
- [ ] **Convert PUT /api/users/:id/admin** - Grants/revokes admin role. Test: Toggle admin

### Groups API (`src/routes/groups.ts`)

Prepare:
- [ ] **Annotate group schemas** - Add `.openapi()` to group schemas in `src/schemas/group.ts`
- [ ] **Convert groups router to OpenAPIHono** - Change to `new OpenAPIHono()` in `src/routes/groups.ts`

Convert endpoints:
- [ ] **Convert POST /api/groups** - Creates group (admin only). Test: Create group
- [ ] **Convert GET /api/groups** - Lists groups with pagination. Test: List groups
- [ ] **Convert GET /api/groups/:id** - Gets group details. Test: Get group by ID
- [ ] **Convert PUT /api/groups/:id** - Updates group (admin only). Test: Update group
- [ ] **Convert DELETE /api/groups/:id** - Deletes group (admin only). Test: Delete group
- [ ] **Convert POST /api/groups/:id/members** - Adds member to group. Test: Add member
- [ ] **Convert DELETE /api/groups/:id/members/:member_id** - Removes member from group. Test: Remove member
- [ ] **Convert GET /api/groups/:id/members** - Lists direct members. Test: Get members
- [ ] **Convert GET /api/groups/:id/effective-members** - Lists all members (nested groups). Test: Get effective members

### Bulk Operations API (`src/routes/bulk.ts`)

Prepare:
- [ ] **Annotate bulk schemas** - Add `.openapi()` to bulk operation schemas in `src/schemas/` (create `src/schemas/bulk.ts` if needed)
- [ ] **Convert bulk router to OpenAPIHono** - Change to `new OpenAPIHono()` in `src/routes/bulk.ts`

Convert endpoints:
- [ ] **Convert POST /api/bulk/entities** - Batch creates entities. Test: Bulk create multiple entities
- [ ] **Convert POST /api/bulk/links** - Batch creates links. Test: Bulk create multiple links
- [ ] **Convert PUT /api/bulk/entities** - Batch updates entities. Test: Bulk update multiple entities
- [ ] **Convert PUT /api/bulk/links** - Batch updates links. Test: Bulk update multiple links

### Audit Logs API (`src/routes/audit.ts`)

Prepare:
- [ ] **Annotate audit schemas** - Add `.openapi()` to `auditLogQuerySchema` in `src/schemas/audit.ts`
- [ ] **Convert audit router to OpenAPIHono** - Change to `new OpenAPIHono()` in `src/routes/audit.ts`

Convert endpoints:
- [ ] **Convert GET /api/audit** - Lists audit logs (admin only). Test: List audit logs
- [ ] **Convert GET /api/audit/resource/:resource_type/:resource_id** - Gets audit log for specific resource. Test: Get resource audit
- [ ] **Convert GET /api/audit/user/:user_id** - Gets audit log for user. Test: Get user audit

### Export/Import API (`src/routes/export.ts`)

Prepare:
- [ ] **Annotate export schemas** - Add `.openapi()` to export/import schemas in `src/schemas/` (create `src/schemas/export.ts` if needed)
- [ ] **Convert export router to OpenAPIHono** - Change to `new OpenAPIHono()` in `src/routes/export.ts`

Convert endpoints:
- [ ] **Convert GET /api/export** - Exports entities/links as JSON. Test: Export data with filters
- [ ] **Convert POST /api/export** - Imports entities/links from JSON. Test: Import data payload

### Admin/Schema APIs

**File: `src/routes/generated-columns.ts`**
- [ ] **Convert generated-columns router to OpenAPIHono** - Change to `new OpenAPIHono()` in file
- [ ] **Convert GET /api/schema/generated-columns** - Lists generated columns (admin). Test with admin token
- [ ] **Convert GET /api/schema/generated-columns/optimization** - Suggests optimizations (admin). Test optimization endpoint
- [ ] **Convert GET /api/schema/generated-columns/analyze** - Analyzes column usage (admin). Test analyze endpoint
- [ ] **Convert GET /api/schema/generated-columns/mappings** - Gets column mappings (admin). Test mappings endpoint

**File: `src/routes/query-plan.ts`**
- [ ] **Convert query-plan router to OpenAPIHono** - Change to `new OpenAPIHono()` in file
- [ ] **Convert GET /api/schema/query-plan/templates** - Lists query templates (admin). Test list templates
- [ ] **Convert GET /api/schema/query-plan/templates/:template** - Gets specific template query plan (admin). Test get template
- [ ] **Convert POST /api/schema/query-plan/analyze** - Analyzes custom query (admin). Test analyze custom query

### Final Cleanup

- [ ] **Compare OpenAPI specs** - Run `curl http://localhost:8787/docs/openapi.json > docs/openapi-new.json`, compare to `docs/openapi-baseline.json`, document breaking changes
- [ ] **Delete old OpenAPI code** - Delete `src/openapi/spec.ts` (2,624 lines) and unused code from `src/openapi/schemas.ts`
- [ ] **Update docs route** - Ensure `src/routes/docs.ts` serves auto-generated spec correctly
- [ ] **Run full test suite** - Final `npm test` - all tests must pass
- [ ] **Generate TypeScript client** - Test: `npx @hey-api/openapi-ts --input http://localhost:8787/docs/openapi.json --output ./test-client --client fetch`
- [ ] **Update README** - Document OpenAPI at `/docs`, spec at `/docs/openapi.json`, client generation
- [ ] **Merge to main** - Merge `openapi-refactor` branch after all tests pass

---

## Done!

When all checkboxes are `[x]`, the refactoring is complete. OpenAPI spec is auto-generated from routes, making docs-code drift impossible.
