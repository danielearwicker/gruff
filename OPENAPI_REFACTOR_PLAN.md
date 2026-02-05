## OpenAPI Refactor Checklist

Work through these in order. Each item is ONE endpoint conversion.

### Health Endpoints (Simple, no auth)

- [x] **Convert GET /health** - File: `src/index.ts`. Endpoint checks system health. Test: `curl http://localhost:8787/health`
- [x] **Convert GET /api/version** - File: `src/index.ts`. Endpoint returns API version. Test: `curl http://localhost:8787/api/version`

### Types API (`src/routes/types.ts`)

Before converting types routes, annotate schemas:

- [x] **Annotate type schemas** - Add `.openapi()` to `createTypeSchema`, `updateTypeSchema`, `typeQuerySchema` in `src/schemas/type.ts`. See `docs/HONO_OPENAPI_REFERENCE.md` for examples.
- [x] **Convert types router to OpenAPIHono** - Change `new Hono()` to `new OpenAPIHono()` at top of `src/routes/types.ts`

Then convert each endpoint:

- [x] **Convert POST /api/types** - Creates type (admin only). Test: Create type via curl with admin token
- [x] **Convert GET /api/types** - Lists all types with pagination. Test: `curl http://localhost:8787/api/types`
- [x] **Convert GET /api/types/:id** - Gets single type by ID. Test: `curl http://localhost:8787/api/types/{uuid}`
- [x] **Convert PUT /api/types/:id** - Updates type (admin only). Test: Update type via curl
- [x] **Convert DELETE /api/types/:id** - Deletes type (admin only). Test: Delete type via curl

### Authentication API (`src/routes/auth.ts`)

Prepare schemas and router:

- [x] **Annotate auth schemas** - Add `.openapi()` to `createUserSchema`, `loginSchema`, `refreshTokenSchema`, `logoutSchema` in `src/schemas/user.ts`
- [x] **Convert auth router to OpenAPIHono** - Change to `new OpenAPIHono()` in `src/routes/auth.ts`

Convert endpoints:

- [x] **Convert POST /api/auth/register** - Registers new user. Test: Register via curl
- [x] **Convert POST /api/auth/login** - Login with email/password. Test: Login via curl, verify tokens returned
- [x] **Convert POST /api/auth/refresh** - Refreshes access token. Test: Refresh with valid refresh token
- [x] **Convert POST /api/auth/logout** - Invalidates session. Test: Logout via curl
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
