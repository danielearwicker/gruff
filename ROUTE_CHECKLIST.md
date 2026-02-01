# Route Checklist

Complete list of all routes exposed by this Cloudflare Worker.

## Root & Health Endpoints

- [✅] `GET /` - Root endpoint (API info)
- [✅] `GET /health` - Health check (tests D1, KV connections)
- [✅] `GET /api` - API info endpoint
- [✅] `GET /api/version` - Version information

## Authentication Routes (`/api/auth`)

- [✅] `POST /api/auth/register` - Register new user with email/password
- [✅] `POST /api/auth/login` - Login with email and password
- [✅] `POST /api/auth/refresh` - Refresh access token using refresh token
- [✅] `POST /api/auth/logout` - Logout by invalidating refresh token
- [✅] `GET /api/auth/me` - Get authenticated user's profile (auth required)
- [ ] `GET /api/auth/google` - Initiate Google OAuth2 sign-in
- [ ] `GET /api/auth/google/callback` - Google OAuth2 callback handler
- [ ] `GET /api/auth/github` - Initiate GitHub OAuth2 sign-in
- [ ] `GET /api/auth/github/callback` - GitHub OAuth2 callback handler
- [✅] `GET /api/auth/providers` - List available authentication providers

## User Management Routes (`/api/users`)

- [ ] `GET /api/users` - List all users (admin only, paginated)
- [ ] `GET /api/users/{id}` - Get user details by ID
- [ ] `PUT /api/users/{id}` - Update user profile (admin or self)
- [ ] `GET /api/users/{id}/activity` - Get user's creation/edit history
- [ ] `GET /api/users/{id}/groups` - List groups user directly belongs to
- [ ] `GET /api/users/{id}/effective-groups` - List all groups (including nested)

## Group Management Routes (`/api/groups`)

- [ ] `POST /api/groups` - Create new group (admin only)
- [ ] `GET /api/groups` - List all groups (paginated)
- [ ] `GET /api/groups/{id}` - Get group details
- [ ] `PUT /api/groups/{id}` - Update group name/description (admin only)
- [ ] `DELETE /api/groups/{id}` - Delete group (admin only, must be empty)
- [ ] `POST /api/groups/{id}/members` - Add user or group as member (admin only)
- [ ] `DELETE /api/groups/{id}/members/{memberType}/{memberId}` - Remove member from group (admin only)
- [ ] `GET /api/groups/{id}/members` - List direct members of group
- [ ] `GET /api/groups/{id}/effective-members` - List all members (including nested)

## Type Management Routes (`/api/types`)

- [ ] `POST /api/types` - Create new type with optional JSON schema (admin only)
- [ ] `GET /api/types` - List all types (paginated, with field selection)
- [ ] `GET /api/types/{id}` - Get specific type by ID
- [ ] `PUT /api/types/{id}` - Update type metadata/schema (admin only)
- [ ] `DELETE /api/types/{id}` - Delete type (admin only, only if not in use)

## Entity Management Routes (`/api/entities`)

- [ ] `POST /api/entities` - Create new entity (auth required)
- [ ] `GET /api/entities` - List entities with filtering/pagination (ACL-aware)
- [ ] `GET /api/entities/{id}` - Get latest version of entity (cached)
- [ ] `PUT /api/entities/{id}` - Update entity (creates new version, auth required)
- [ ] `DELETE /api/entities/{id}` - Soft delete entity (auth required)
- [ ] `POST /api/entities/{id}/restore` - Restore soft-deleted entity (auth required)
- [ ] `GET /api/entities/{id}/versions` - Get all versions of entity
- [ ] `GET /api/entities/{id}/versions/{version}` - Get specific version of entity
- [ ] `GET /api/entities/{id}/history` - Get version history with diffs
- [ ] `GET /api/entities/{id}/outbound` - Get all outbound links
- [ ] `GET /api/entities/{id}/inbound` - Get all inbound links
- [ ] `GET /api/entities/{id}/neighbors` - Get connected entities (both directions)
- [ ] `GET /api/entities/{id}/acl` - Get entity's ACL (auth required)
- [ ] `PUT /api/entities/{id}/acl` - Set entity's ACL (auth required)

## Link Management Routes (`/api/links`)

- [ ] `POST /api/links` - Create new link (auth required)
- [ ] `GET /api/links` - List links with filtering/pagination (ACL-aware)
- [ ] `GET /api/links/{id}` - Get latest version of link (cached)
- [ ] `PUT /api/links/{id}` - Update link (creates new version, auth required)
- [ ] `DELETE /api/links/{id}` - Soft delete link (auth required)
- [ ] `POST /api/links/{id}/restore` - Restore soft-deleted link (auth required)
- [ ] `GET /api/links/{id}/versions` - Get all versions of link
- [ ] `GET /api/links/{id}/versions/{version}` - Get specific version of link
- [ ] `GET /api/links/{id}/history` - Get version history with diffs
- [ ] `GET /api/links/{id}/acl` - Get link's ACL (auth required)
- [ ] `PUT /api/links/{id}/acl` - Set link's ACL (auth required)

## Graph Traversal Routes (`/api/graph`)

- [ ] `GET /api/graph/path` - Find shortest path between two entities (BFS)
- [ ] `POST /api/graph/traverse` - Multi-hop graph traversal with filtering

## Search Routes (`/api/search`)

- [ ] `POST /api/search/entities` - Search entities with advanced filtering
- [ ] `POST /api/search/links` - Search links with advanced filtering
- [ ] `GET /api/search/suggest` - Type-ahead suggestions for properties

## Bulk Operations Routes (`/api/bulk`)

- [✅] `POST /api/bulk/entities` - Batch create multiple entities (auth required)
- [✅] `POST /api/bulk/links` - Batch create multiple links (auth required)
- [✅] `PUT /api/bulk/entities` - Batch update multiple entities (auth required)
- [✅] `PUT /api/bulk/links` - Batch update multiple links (auth required)

## Export/Import Routes (`/api/export`)

- [ ] `GET /api/export` - Export entities/links as JSON
- [ ] `POST /api/export` - Import entities/links from JSON

## Audit Log Routes (`/api/audit`)

- [ ] `GET /api/audit` - Query audit logs with filtering (auth required)
- [ ] `GET /api/audit/resource/{resourceType}/{resourceId}` - Get audit history for specific resource (auth required)
- [ ] `GET /api/audit/user/{userId}` - Get audit logs for specific user (auth required)

## Schema Information Routes (`/api/schema`)

### Generated Columns

- [ ] `GET /api/schema/generated-columns` - List all generated columns
- [ ] `GET /api/schema/generated-columns/optimization` - Get query optimization info
- [ ] `GET /api/schema/generated-columns/analyze` - Analyze a query path
- [ ] `GET /api/schema/generated-columns/mappings` - Get static column mappings

### Query Plan Analysis

- [ ] `GET /api/schema/query-plan/templates` - List query templates
- [ ] `GET /api/schema/query-plan/templates/{template}` - Get details about template
- [ ] `POST /api/schema/query-plan` - Analyze query execution plan

## Documentation Routes (`/docs`)

- [ ] `GET /docs/openapi.json` - OpenAPI specification (JSON)
- [ ] `GET /docs/openapi.yaml` - OpenAPI specification (YAML)
- [ ] `GET /docs` - Interactive API documentation (Scalar UI)

## UI Routes (`/ui`)

- [ ] `GET /ui` - Web interface home (Server-side rendered)
- [ ] `GET /ui/auth/login` - Login page
- [ ] `GET /ui/auth/register` - Registration page
- [ ] `GET /ui/auth/oauth/callback` - OAuth callback handler
- [ ] `POST /ui/auth/login` - Login form submission
- [ ] `POST /ui/auth/register` - Register form submission
- [ ] `POST /ui/auth/logout` - Logout handler (auth required)
- [ ] `GET /ui/entities` - Entities browser (auth required)
- [ ] `GET /ui/entities/{id}` - Entity detail page (auth required)
- [ ] `GET /ui/types` - Types browser (auth required)
- [ ] `GET /ui/groups` - Groups browser (auth required)
- [ ] `GET /ui/users` - Users browser (admin only)
- [ ] `GET /ui/audit` - Audit log viewer (auth required)

## Validation Demo Routes (`/api/validate`)

- [ ] `POST /api/validate/entity` - Validate entity against schema
- [ ] `GET /api/validate/query` - Validate query parameters
- [ ] `POST /api/validate/test` - Custom validation test

## Response Format Demo Routes (`/api/demo/response`)

- [ ] `GET /api/demo/response/success` - Success response format
- [ ] `GET /api/demo/response/created` - Created (201) response format
- [ ] `GET /api/demo/response/updated` - Updated response format
- [ ] `GET /api/demo/response/deleted` - Deleted response format
- [ ] `GET /api/demo/response/paginated` - Paginated response format
- [ ] `GET /api/demo/response/cursor-paginated` - Cursor-paginated response format
- [ ] `GET /api/demo/response/not-found` - Not found (404) response format
- [ ] `GET /api/demo/response/error` - Error response format
- [ ] `GET /api/demo/response/validation-error` - Validation error response format
- [ ] `GET /api/demo/response/unauthorized` - Unauthorized (401) response format
- [ ] `GET /api/demo/response/forbidden` - Forbidden (403) response format
