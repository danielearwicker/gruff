# OpenAPI Spec Comparison: Baseline vs Auto-Generated

Comparison of the manually-maintained baseline (`docs/openapi-baseline.json`) against
the auto-generated spec from `@hono/zod-openapi` route definitions.

## Summary

| Metric            | Baseline | Auto-Generated | Change                       |
| ----------------- | -------- | -------------- | ---------------------------- |
| Paths             | 39       | 62             | +23 new                      |
| Component Schemas | 36       | ~158           | +122 new                     |
| Tags              | 11       | 13             | +2 new                       |
| Breaking Changes  | -        | **None**       | All baseline paths preserved |

## No Breaking Changes

All 39 paths from the baseline spec are present in the auto-generated spec with the same
HTTP methods, security requirements, and operationIds. Existing API consumers will not
be affected.

## New Paths (23 additions)

These endpoints existed in the codebase but were not documented in the manual spec:

### OAuth Authentication (4 paths)

- `GET /api/auth/google` - Initiate Google OAuth flow
- `GET /api/auth/google/callback` - Google OAuth callback
- `GET /api/auth/github` - Initiate GitHub OAuth flow
- `GET /api/auth/github/callback` - GitHub OAuth callback

### User Management (4 paths)

- `GET /api/users/search` - Search users by email/name
- `GET /api/users/{id}/groups` - Get user's direct group memberships
- `GET /api/users/{id}/effective-groups` - Get user's effective groups (nested)
- `PUT /api/users/{id}/admin` - Grant/revoke admin role

### Groups (5 paths)

- `GET/POST /api/groups` - List/create groups
- `GET/PUT/DELETE /api/groups/{id}` - Manage group
- `GET/POST /api/groups/{id}/members` - List/add members
- `DELETE /api/groups/{id}/members/{memberType}/{memberId}` - Remove member
- `GET /api/groups/{id}/effective-members` - List effective members

### ACL (2 paths)

- `GET/PUT /api/entities/{id}/acl` - Entity access control
- `GET/PUT /api/links/{id}/acl` - Link access control

### Graph (1 path)

- `GET /api/graph/entities/{id}/graph-view` - Graph visualization data

### Schema Analysis (7 paths)

- `GET /api/schema/generated-columns` - List generated columns
- `GET /api/schema/generated-columns/optimization` - Optimization suggestions
- `POST /api/schema/generated-columns/analyze` - Analyze column usage
- `GET /api/schema/generated-columns/mappings` - Column mappings
- `GET /api/schema/query-plan/templates` - List query templates
- `GET /api/schema/query-plan/templates/{template}` - Get specific template
- `POST /api/schema/query-plan/analyze` - Analyze custom query

## New Tags

- **Groups** - Group management endpoints
- **Schema** - Database schema information and optimization

## Schema Changes

The auto-generated spec has significantly more detailed schemas (~158 vs 36) because:

1. **Specific response types**: Each endpoint gets its own response schema (e.g.,
   `EntityListResponse`, `UserDetailResponse`) instead of generic wrappers
2. **Feature-area error schemas**: Separate error response schemas per domain
   (e.g., `EntityErrorResponse`, `LinkErrorResponse`)
3. **New feature schemas**: Groups, ACL, OAuth, and Schema analysis schemas
4. **FilterExpression**: Recursive filter expression schema now properly documented

All baseline schemas are preserved. New schemas are additive.

## Technical Notes

### Recursive Schema Fix

The `filterExpressionSchema` in `src/schemas/search.ts` uses `z.lazy()` for recursive
AND/OR filter expressions. This caused "Maximum call stack size exceeded" during spec
generation. Fixed by adding `.openapi('FilterExpression')` to register as a named
component, allowing the generator to use `$ref` instead of infinite inline expansion.

### app.doc() Positioning

The `app.doc()` call must be placed:

- **AFTER** all sub-router mounts (so their route definitions are merged into the registry)
- **BEFORE** the docs router mount (so it takes routing precedence over the old manual spec)
