# Entity-Relationship Database with Versioning - Product Specification

## Overview

A graph database system built on Cloudflare D1 (SQLite) that supports versioned entities and relationships, user management, and flexible schema through JSON properties. The system provides a RESTful API built with Cloudflare Workers and TypeScript for managing entities, links, and their relationships while maintaining full audit history.

### Platform: Cloudflare Workers + D1

- **Cloudflare Workers**: Serverless runtime for the API layer
- **Cloudflare D1**: SQLite-based edge database with 10GB capacity per database
- **Cloudflare KV**: Key-value store for caching and session management
- **Local Development**: Wrangler CLI with offline testing capabilities

## Core Concepts

### Entities

- Fundamental nodes in the graph
- Have a type, custom JSON properties, and versioning
- Support soft deletion
- Every modification creates a new version referencing the previous one

### Links

- Directed relationships between entities
- Have a type, custom JSON properties, and versioning
- Connect a source entity to a target entity
- Support soft deletion

### Versioning

- Immutable history: updates create new records
- Each version references its predecessor via FK
- Track user and timestamp for every change
- Enable point-in-time queries and audit trails

### Types

- Centralized type registry for both entities and links
- Documents all extant types in the system
- Enables type-based queries and validation
- ✅ Allows creation of a new type (existing types can't be edited, user must use a naming-versioning scheme)
- ✅ Allows deletion of a type but only if there are no non-deleted entities of that type

## Database Schema

### ✅ Core Tables Structure

#### `users` Table

```sql
- id (TEXT, PK) -- UUID stored as TEXT
- email (TEXT, UNIQUE, NOT NULL)
- display_name (TEXT)
- provider (TEXT) -- e.g., 'google', 'github', 'local'
- provider_id (TEXT) -- External provider's user ID
- password_hash (TEXT) -- For local accounts (argon2 or scrypt)
- created_at (INTEGER) -- Unix timestamp
- updated_at (INTEGER) -- Unix timestamp
- is_active (INTEGER) -- SQLite boolean (0 or 1)
```

#### `types` Table

```sql
- id (TEXT, PK) -- UUID stored as TEXT
- name (TEXT, UNIQUE, NOT NULL)
- category (TEXT CHECK(category IN ('entity', 'link')))
- description (TEXT)
- json_schema (TEXT) -- JSON stored as TEXT for validation
- created_at (INTEGER) -- Unix timestamp
- created_by (TEXT, FK -> users.id)
```

#### `entities` Table

```sql
- id (TEXT, PK) -- UUID stored as TEXT
- type_id (TEXT, FK -> types.id, NOT NULL)
- properties (TEXT) -- JSON stored as TEXT (uses JSON1 extension)
- version (INTEGER, NOT NULL)
- previous_version_id (TEXT, FK -> entities.id, NULL for v1)
- created_at (INTEGER) -- Unix timestamp
- created_by (TEXT, FK -> users.id)
- is_deleted (INTEGER, DEFAULT 0) -- SQLite boolean
- is_latest (INTEGER, DEFAULT 1) -- Optimization for queries
- acl_id (INTEGER, FK -> acls.id, NULL) -- NULL means public/unrestricted
```

#### `links` Table

```sql
- id (TEXT, PK) -- UUID stored as TEXT
- type_id (TEXT, FK -> types.id, NOT NULL)
- source_entity_id (TEXT, FK -> entities.id, NOT NULL)
- target_entity_id (TEXT, FK -> entities.id, NOT NULL)
- properties (TEXT) -- JSON stored as TEXT (uses JSON1 extension)
- version (INTEGER, NOT NULL)
- previous_version_id (TEXT, FK -> links.id, NULL for v1)
- created_at (INTEGER) -- Unix timestamp
- created_by (TEXT, FK -> users.id)
- is_deleted (INTEGER, DEFAULT 0) -- SQLite boolean
- is_latest (INTEGER, DEFAULT 1)
- acl_id (INTEGER, FK -> acls.id, NULL) -- NULL means public/unrestricted
```

#### ✅ `groups` Table

```sql
- id (TEXT, PK) -- UUID stored as TEXT
- name (TEXT, UNIQUE, NOT NULL)
- description (TEXT)
- created_at (INTEGER) -- Unix timestamp
- created_by (TEXT, FK -> users.id)
```

#### ✅ `group_members` Table

```sql
- group_id (TEXT, FK -> groups.id, NOT NULL)
- member_type (TEXT CHECK(member_type IN ('user', 'group')), NOT NULL)
- member_id (TEXT, NOT NULL) -- FK to users.id or groups.id depending on member_type
- created_at (INTEGER) -- Unix timestamp
- created_by (TEXT, FK -> users.id)
- PRIMARY KEY (group_id, member_type, member_id)
```

Groups form a hierarchy: a group can contain users and other groups. Cycles are prevented by validation on insert.

#### ✅ `acls` Table

```sql
- id (INTEGER, PK, AUTOINCREMENT)
- hash (TEXT, UNIQUE, NOT NULL) -- SHA-256 hash of normalized ACL definition
- created_at (INTEGER) -- Unix timestamp
```

ACLs are deduplicated: when an entity or link's access control is modified, the system computes a canonical hash of the requested permissions. If an ACL with that hash already exists, its ID is reused; otherwise a new ACL is created. This allows efficient filtering via integer foreign keys.

#### ✅ `acl_entries` Table

```sql
- acl_id (INTEGER, FK -> acls.id, NOT NULL)
- principal_type (TEXT CHECK(principal_type IN ('user', 'group')), NOT NULL)
- principal_id (TEXT, NOT NULL) -- FK to users.id or groups.id
- permission (TEXT CHECK(permission IN ('read', 'write')), NOT NULL)
- PRIMARY KEY (acl_id, principal_type, principal_id, permission)
```

Each ACL entry grants a specific permission (read or write) to a principal (user or group). Write permission implicitly includes read permission.

### ✅ Database Indexes

- Composite index on `entities(type_id, is_latest, is_deleted)` for filtered queries
- Composite index on `links(source_entity_id, is_latest, is_deleted)` for graph traversal
- Composite index on `links(target_entity_id, is_latest, is_deleted)` for reverse traversal
- Indexes on JSON fields using generated columns for frequently queried properties
- Index on `entities.created_by` and `links.created_by` for user queries
- Index on `entities.created_at` and `links.created_at` for time-based queries

### ✅ Authorization Indexes

- Index on `group_members(member_type, member_id)` for reverse membership lookups
- Index on `acl_entries(principal_type, principal_id)` for finding ACLs that grant access to a principal
- Index on `entities(acl_id)` and `links(acl_id)` for ACL-based filtering

### Database Constraints and Triggers

- ✅ Check constraint: `version > 0`
- ✅ Trigger to auto-increment version on insert
- ✅ Trigger to set `is_latest = false` on previous version when new version is created
- ✅ Foreign key constraints with appropriate cascade rules

## Authentication & Authorization

### Local Authentication - Core Infrastructure

#### ✅ Password Hashing Utility

- Implement password hashing using Web Crypto API (PBKDF2)
- Create utility functions for hashing and verifying passwords
- Use appropriate iteration counts and salt generation
- Timing-safe comparison to prevent timing attacks

#### ✅ JWT Token Service

- Implement JWT creation and validation using Web Crypto API
- Support both access tokens (short-lived) and refresh tokens (long-lived)
- Include user ID and metadata in token payload
- Token expiration and renewal logic

#### ✅ KV-based Session Store

- Set up Cloudflare KV binding for session management
- Store refresh tokens with TTL in KV
- Implement token invalidation (logout) functionality
- Session lookup and validation utilities

### Local Authentication - API Endpoints

#### ✅ User Registration Endpoint

- POST /api/auth/register endpoint
- Email and password validation using Zod
- Create user record in database
- Hash password before storage
- Return access and refresh tokens

#### ✅ User Login Endpoint

- POST /api/auth/login endpoint
- Verify email and password
- Generate access and refresh tokens
- Store refresh token in KV
- Return tokens and user info

#### ✅ Token Refresh Endpoint

- POST /api/auth/refresh endpoint
- Validate refresh token JWT signature and expiration
- Validate refresh token exists in KV store
- Issue new access token
- Return new access token with same refresh token

#### ✅ Logout Endpoint

- POST /api/auth/logout endpoint
- Invalidate refresh token in KV
- Clear session data

#### ✅ Current User Endpoint

- GET /api/auth/me endpoint
- Return authenticated user's profile
- Require valid JWT in Authorization header

### Authorization Infrastructure

#### ✅ JWT Authentication Middleware

- Middleware to extract and validate JWT from Authorization header
- Parse Bearer token format
- Verify token signature and expiration
- Attach user context to request

#### ✅ Protected Route Patterns

- Apply authentication middleware to protected endpoints
- Consistent error responses for unauthorized requests
- Optional vs required authentication support

### Group Management

#### ✅ Group Hierarchy

- Groups contain members which can be users or other groups
- Recursive membership resolution: if User A is in Group X, and Group X is in Group Y, then User A is effectively a member of Group Y
- Cycle detection prevents circular group membership
- Maximum nesting depth of 10 levels to prevent performance issues

#### ✅ Effective Membership Resolution

- `getEffectiveGroups(userId)` returns all groups a user belongs to (directly or transitively)
- Results are cached in KV with TTL of 5 minutes
- Cache is invalidated when group membership changes

### Access Control Lists (ACLs)

#### ✅ ACL Deduplication

- ACLs are stored in a normalized, deduplicated table
- When setting permissions on an entity or link, the system:
  1. Computes a canonical representation of the requested ACL (sorted entries)
  2. Generates a SHA-256 hash of this representation
  3. Looks up existing ACL by hash, or creates a new one if not found
  4. Associates the entity/link with the ACL ID
- This ensures entities/links with identical permissions share the same ACL ID
- Implemented in `src/utils/acl.ts`:
  - `computeAclHash(entries)` - Computes SHA-256 hash of sorted, canonical ACL entries
  - `deduplicateAclEntries(entries)` - Removes duplicate entries before hashing
  - `getOrCreateAcl(db, entries)` - Returns existing ACL ID by hash or creates new ACL

#### ✅ Permission Checking

- For single-resource operations (GET /api/entities/:id, PUT, DELETE):
  - Retrieve the resource's ACL ID
  - Check if current user or any of their effective groups has required permission
  - Write permission implies read permission
  - Resources with NULL acl_id are public (accessible to all users, including unauthenticated)
  - Write operations (PUT, DELETE, restore) require authentication
  - Read operations (GET, list) use optional authentication for filtering

- For list operations (GET /api/entities, search endpoints):
  - Pre-compute the set of ACL IDs that grant the current user read access
  - Include `WHERE acl_id IN (...) OR acl_id IS NULL` in the query
  - This allows efficient index-based filtering without per-row permission checks
  - Falls back to per-row filtering when accessible ACL set exceeds 1000 entries

- Utility functions in `src/utils/acl.ts`:
  - `getEffectiveGroupsForUser(db, kv, userId)` - Gets all groups user belongs to (with caching)
  - `getAccessibleAclIds(db, kv, userId, permission)` - Gets all ACL IDs user can access
  - `hasPermission(db, kv, userId, resourceType, resourceId, permission)` - Checks permission on resource
  - `hasPermissionByAclId(db, kv, userId, aclId, permission)` - Checks permission when ACL ID is known
  - `buildAclFilterClause(db, kv, userId, permission, aclIdColumn)` - Builds SQL filter for list queries
  - `filterByAclPermission(items, accessibleAclIds)` - Per-row filtering fallback

#### ✅ Permission Inheritance

- New entities and links created without explicit ACL get creator write permission
- The creator is automatically granted write permission on all created resources
- Explicit ACL can be specified at creation time via `acl` field
- Empty ACL array (`acl: []`) creates a public resource (no ACL restrictions)
- If explicit ACL is provided, creator write permission is automatically added if not present

### OAuth2 Integration

#### ✅ OAuth2 - Google Provider

- Google OAuth2 sign-in flow
  - GET /api/auth/google - Initiates OAuth flow, returns authorization URL with PKCE
  - GET /api/auth/google/callback - Handles OAuth callback with authorization code
- User provisioning from Google profile
  - Creates new users with provider='google' and provider_id from Google
  - Stores display name from Google profile
- Link Google account to existing users
  - If email already exists with different provider, links Google to existing account
  - Updates provider and provider_id while preserving user data
- Security features:
  - PKCE (Proof Key for Code Exchange) with S256 challenge method
  - State parameter stored in KV with 15-minute TTL for CSRF protection
  - One-time use state (deleted after callback)
  - Email verification check from Google profile
- Configuration via environment variables:
  - GOOGLE_CLIENT_ID - OAuth client ID from Google Cloud Console
  - GOOGLE_CLIENT_SECRET - OAuth client secret (stored as secret)
  - GOOGLE_REDIRECT_URI - Callback URL for OAuth flow

#### ✅ OAuth2 - GitHub Provider

- GitHub OAuth2 sign-in flow
  - GET /api/auth/github - Initiates OAuth flow, returns authorization URL with state parameter
  - GET /api/auth/github/callback - Handles OAuth callback with authorization code
- User provisioning from GitHub profile
  - Creates new users with provider='github' and provider_id from GitHub
  - Stores display name from GitHub profile (name or login)
  - Fetches primary verified email via /user/emails endpoint when profile email is private
- Link GitHub account to existing users
  - If email already exists with different provider, links GitHub to existing account
  - Updates provider and provider_id while preserving user data
- Security features:
  - State parameter stored in KV with 15-minute TTL for CSRF protection
  - One-time use state (deleted after callback)
  - Verified email requirement from GitHub
- Configuration via environment variables:
  - GITHUB_CLIENT_ID - OAuth client ID from GitHub Developer Settings
  - GITHUB_CLIENT_SECRET - OAuth client secret (stored as secret)
  - GITHUB_REDIRECT_URI - Callback URL for OAuth flow

#### ✅ OAuth2 - Auth Providers Discovery

- GET /api/auth/providers endpoint to list available providers
  - Returns all authentication providers (local, Google, GitHub, etc.)
  - Indicates which providers are enabled based on environment configuration
  - Includes provider name, type (local/oauth2), and authorize URL for OAuth providers
  - Allows clients to dynamically discover available authentication methods

#### 🟥 OAuth2 - Additional Providers

- Support for Microsoft, Apple, or other OIDC-compliant providers
- Configurable provider registry for easy addition of new OAuth providers

### ✅ Type Management Endpoints

```
POST   /api/types                  # Create a new type
GET    /api/types                  # List all types (filter by category)
GET    /api/types/{id}             # Get specific type details
PUT    /api/types/{id}             # Update type metadata
DELETE /api/types/{id}             # Delete type (if unused)
```

### ✅ Entity CRUD Endpoints

```
POST   /api/entities               # Create new entity
GET    /api/entities               # List entities (paginated, filtered)
GET    /api/entities/{id}          # Get latest version of entity
PUT    /api/entities/{id}          # Update entity (creates new version)
DELETE /api/entities/{id}          # Soft delete entity
POST   /api/entities/{id}/restore  # Restore soft-deleted entity
```

### ✅ Entity Version Endpoints

```
GET    /api/entities/{id}/versions           # Get all versions of entity
GET    /api/entities/{id}/versions/{version} # Get specific version
GET    /api/entities/{id}/history            # Get version history with diffs
```

### ✅ Link CRUD Endpoints

```
POST   /api/links                  # Create new link
GET    /api/links                  # List links (paginated, filtered)
GET    /api/links/{id}             # Get latest version of link
PUT    /api/links/{id}             # Update link (creates new version)
DELETE /api/links/{id}             # Soft delete link
POST   /api/links/{id}/restore     # Restore soft-deleted link
```

### ✅ Link Version Endpoints

```
GET    /api/links/{id}/versions           # Get all versions of link
GET    /api/links/{id}/versions/{version} # Get specific version
GET    /api/links/{id}/history            # Get version history with diffs
```

### Graph Navigation Endpoints

#### ✅ Basic Graph Navigation - Outbound Links

```
GET    /api/entities/{id}/outbound        # Get outbound links from an entity
```

Returns all links where the specified entity is the source, with optional filtering by link type.

#### ✅ Basic Graph Navigation - Inbound Links

```
GET    /api/entities/{id}/inbound         # Get inbound links to an entity
```

Returns all links where the specified entity is the target, with optional filtering by link type.

#### ✅ Basic Graph Navigation - Neighbors

```
GET    /api/entities/{id}/neighbors       # Get connected entities
```

Returns all entities connected to the specified entity (both inbound and outbound), with optional filtering by link type, entity type, and direction.

#### Advanced Graph Traversal

##### ✅ Multi-hop Traversal Endpoint

```
POST   /api/graph/traverse                # Advanced graph traversal queries
```

Implement POST /api/graph/traverse endpoint that supports:

- Configurable depth limits (max hops from starting entity)
- Direction specification (outbound, inbound, or both)
- Link type filtering at each hop
- Entity type filtering for results
- Return entities and the paths that led to them

##### ✅ Breadth-First Search Implementation

Core traversal algorithm:

- BFS traversal starting from a given entity
- Track visited entities to avoid cycles
- Respect depth limits
- Apply filters at each step
- Collect and return matching entities with metadata

##### ✅ Shortest Path Finding

```
GET    /api/graph/path                    # Find shortest path between entities
```

Find the shortest path between two entities in the graph:

- BFS-based shortest path algorithm
- Query parameters: from (entity ID), to (entity ID)
- Optional link type filtering
- Return the path as array of entities and links
- Return 404 if no path exists

### Search and Query Endpoints

#### ✅ Basic Entity Search

```
POST   /api/search/entities        # Search entities by JSON properties
```

Implement basic entity search endpoint:

- Accept search criteria in request body (type filter, property filters, date range)
- Support basic equality matching on JSON properties
- Return paginated results
- Include entity type information in results

#### ✅ Basic Link Search

```
POST   /api/search/links           # Search links by JSON properties
```

Implement basic link search endpoint:

- Accept search criteria in request body (type filter, property filters, source/target entity filters)
- Support basic equality matching on JSON properties
- Return paginated results
- Include link type and connected entity information in results

#### ✅ Type-ahead Suggestions

```
GET    /api/search/suggest         # Type-ahead suggestions for entity names
```

Implement type-ahead suggestion endpoint:

- Search entity properties for partial matches
- Return quick results (limit 10) for autocomplete UIs
- Support configurable property path for searching (e.g., "name", "title")
- Include entity type and ID in results

### ✅ User Management Endpoints

```
GET    /api/users                  # List users (admin)
GET    /api/users/{id}             # Get user details
PUT    /api/users/{id}             # Update user profile
GET    /api/users/{id}/activity    # Get user's creation/edit history
```

### ✅ Admin Role Management Endpoint

```
PUT    /api/users/{id}/admin          # Grant or revoke admin role (admin only)
```

#### Endpoint Details

- **Authentication**: Requires admin role
- **Request body**:
  ```json
  {
    "is_admin": true
  }
  ```
- **Constraints**:
  - ✅ Only existing admins can grant or revoke admin status
  - ✅ Admins cannot revoke their own admin status (prevents lockout)
  - ✅ At least one admin must remain in the system
- **Response**: Updated user object with new admin status
- **Audit**: ✅ All admin role changes are logged to the audit log with operation type `admin_role_change`

### ✅ Group Management Endpoints

```
POST   /api/groups                   # Create a new group
GET    /api/groups                   # List all groups (paginated)
GET    /api/groups/{id}              # Get group details with members
PUT    /api/groups/{id}              # Update group name/description
DELETE /api/groups/{id}              # Delete group (fails if has members, is in parent groups, or in ACLs)
POST   /api/groups/{id}/members      # Add member (user or group) to group
DELETE /api/groups/{id}/members/{memberType}/{memberId}  # Remove member
GET    /api/groups/{id}/members      # List direct members
GET    /api/groups/{id}/effective-members  # List all members (recursive)
GET    /api/users/{id}/groups        # List groups a user belongs to
GET    /api/users/{id}/effective-groups  # List all groups (recursive)
```

### ✅ ACL Management Endpoints

```
GET    /api/entities/{id}/acl        # Get current ACL for entity
PUT    /api/entities/{id}/acl        # Set ACL for entity
GET    /api/links/{id}/acl           # Get current ACL for link
PUT    /api/links/{id}/acl           # Set ACL for link
```

ACL request/response format:

```json
{
  "entries": [
    { "principal_type": "user", "principal_id": "uuid", "permission": "write" },
    { "principal_type": "group", "principal_id": "uuid", "permission": "read" }
  ]
}
```

## Core Features

### ✅ Pagination System

- Cursor-based pagination for all list endpoints
- Support for page size configuration (limit parameter)
- Include total count in responses (optional, for performance)
- Default (20) and max (100) page size limits

### ✅ Filtering System

- Filter entities/links by type
- Filter by creation date range
- Filter by creator
- Filter by soft-deleted status
- Filter by JSON property values (basic equality)

### Advanced JSON Property Queries

This feature enhances property filtering capabilities beyond basic equality matching.

#### ✅ Comparison Operators for JSON Properties

- Support comparison operators: `eq` (equals), `ne` (not equals), `gt` (greater than), `lt` (less than), `gte` (greater than or equal), `lte` (less than or equal)
- Support string pattern matching: `like` (SQL LIKE), `ilike` (case-insensitive LIKE), `starts_with`, `ends_with`, `contains`
- Support set operations: `in` (value in array), `not_in` (value not in array)
- Support existence checks: `exists` (property exists), `not_exists` (property doesn't exist)
- Type-aware comparisons for strings, numbers, and booleans
- Apply to both entity and link search endpoints
- Implemented via `property_filters` parameter in search endpoints with backward compatibility for legacy `properties` parameter

#### ✅ Nested Property Path Support

- Support dot notation for nested JSON properties (e.g., `address.city`, `metadata.tags.0`)
- Support array indexing in JSON paths with bracket notation (`tags[0]`) and dot notation (`tags.0`)
- Support mixed notation for complex paths (`users[0].address.city`, `orders.0.items.1.name`)
- Validate JSON path expressions before query execution with proper error messages
- Handle missing or null values gracefully (returns NULL for non-existent paths)
- Maximum path depth of 10 levels to prevent abuse
- Property names must start with a letter or underscore, followed by letters, digits, or underscores
- Implemented via `parseJsonPath()` function that converts user paths to SQLite-compatible JSON paths

#### ✅ Logical Operators for Property Filters

- Support AND/OR logic for combining multiple property filters via `filter_expression` field
- Implement filter groups with nested conditions (maximum depth of 5 levels)
- JSON schema for filter expressions: `{"and": [filter1, filter2]}`, `{"or": [filter1, filter2]}`, or nested `{"and": [filter1, {"or": [filter2, filter3]}]}`
- Apply to both entity and link search endpoints (takes precedence over `property_filters`)
- Type guards: `isAndGroup()`, `isOrGroup()`, `isPropertyFilter()` for type-safe expression handling
- Implemented via `buildFilterExpression()` function with recursive processing

#### ✅ Generated Columns and Indexes

- Migration `0006_generated_columns.sql` creates generated columns for frequently queried properties:
  - Entities: `prop_name` ($.name), `prop_status` ($.status), `prop_email` ($.email)
  - Links: `prop_role` ($.role), `prop_weight` ($.weight)
- Partial indexes on generated columns for efficient filtered queries
- Composite indexes for common query patterns (type + property with is_latest/is_deleted filters)
- `generated_columns` metadata table tracks all generated columns with their JSON path mappings
- API endpoints for schema introspection (admin only):
  - GET `/api/schema/generated-columns` - List all generated columns
  - GET `/api/schema/generated-columns/optimization` - Query optimization information
  - GET `/api/schema/generated-columns/analyze` - Analyze if a JSON path has an optimized column
  - GET `/api/schema/generated-columns/mappings` - Static mapping of JSON paths to columns
- Utility module `src/utils/generated-columns.ts` provides:
  - `hasGeneratedColumn()` - Check if a path has a generated column
  - `getGeneratedColumnName()` - Get the column name for a path
  - `buildOptimizedCondition()` - Build SQL using generated column when available
  - `analyzeQueryPath()` - Analyze optimization potential for a query path

### ✅ Soft Delete Implementation

- `is_deleted` flag on entities and links
- Exclude soft-deleted items from default queries
- Include deleted items with explicit query parameter
- Restore functionality that creates new version with `is_deleted=false`

### ✅ Version History Diffing

- Calculate differences between consecutive versions
- Show what properties changed, were added, or removed
- Support for JSON diff format
- Human-readable change descriptions

### ✅ Graph Traversal - Basic Navigation

- Get direct neighbors (outbound/inbound)
- Filter by link type during traversal
- Include entity and link properties in results

### ✅ Graph Traversal - Advanced Queries

- Multi-hop traversal with depth limits
- Path finding between two entities
- Shortest path algorithms
- Traversal with filtering at each step

### ✅ Bulk Operations

- Batch create entities via POST /api/bulk/entities
- Batch create links via POST /api/bulk/links
- Batch update entities via PUT /api/bulk/entities
- Batch update links via PUT /api/bulk/links
- Transaction support for consistency using D1 batch operations
- Maximum 100 items per request to prevent abuse
- Partial success support with detailed per-item results
- Client-provided IDs for reference correlation

### ✅ Export and Import

- Export subgraph as JSON via GET /api/export
  - ACL-aware: only exports entities/links the user has read permission on
  - Unauthenticated requests only see public resources (NULL acl_id)
  - Filter by entity type IDs
  - Filter by creation date range
  - Option to include deleted entities/links
  - Option to include version history
  - Includes referenced types in export
  - Returns format_version, exported_at timestamp, and metadata
- Import graph structure from JSON via POST /api/export
  - Authentication required
  - Imported entities/links are owned by the authenticated user (creator gets write permission)
  - Support for creating new types as part of import
  - Support for creating entities and links in a single request
  - Client ID mapping for referential integrity
  - Support type resolution by name or ID
  - Support entity references by client_id or existing entity ID
  - Partial success support with detailed per-item results
  - Maximum 100 items per import request
- Validation during import with clear error codes

### ✅ Type Schema Validation

- Optional JSON schema validation for entity/link properties
- Validation on create and update for entities and links
- Validation in bulk operations (create/update)
- Validation in import operations
- Clear error messages with detailed validation errors
- Support for JSON Schema Draft-07 subset:
  - Type validation (string, number, boolean, array, object, null)
  - Required properties
  - Minimum/maximum constraints for numbers
  - MinLength/maxLength for strings
  - Pattern matching for strings
  - Enum constraints
  - Format validation (email, date, date-time, uri, uuid, etc.)
  - Array item validation
  - Nested object validation
  - allOf, anyOf, oneOf, not logical operators

### ✅ Audit Logging

- Comprehensive audit log of all operations (create, update, delete, restore for entities and links)
- Query audit logs by user, entity, date range via GET /api/audit endpoint
- Get resource-specific audit history via GET /api/audit/resource/:resource_type/:resource_id
- Get user-specific actions via GET /api/audit/user/:user_id
- Includes operation details, timestamps, user ID, IP address, and user agent
- Compliance and security tracking

### ✅ Rate Limiting

- Per-user rate limits on API endpoints (using user ID when authenticated, IP address otherwise)
- Configurable limits per endpoint category:
  - `auth`: 20 requests/minute (authentication endpoints)
  - `read`: 100 requests/minute (GET operations)
  - `write`: 60 requests/minute (POST, PUT, PATCH, DELETE operations)
  - `bulk`: 20 requests/minute (batch operations)
  - `search`: 60 requests/minute (search endpoints)
  - `graph`: 40 requests/minute (graph traversal operations)
  - `default`: 60 requests/minute (fallback)
- Cloudflare KV-based rate limiting for distributed tracking with sliding window algorithm
- Rate limit headers on all API responses: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`
- Returns 429 Too Many Requests with `Retry-After` header when limit exceeded
- Automatic endpoint category detection based on request path and method
- Cloudflare's built-in rate limiting rules available as additional protection layer

### ✅ API Documentation

- OpenAPI 3.1.0 specification available at `/docs/openapi.json`
- Interactive API documentation UI using Scalar at `/docs`
- Comprehensive endpoint documentation with request/response examples
- Authentication flow documentation with security schemes
- YAML spec available at `/docs/openapi.yaml`
- Covers all API endpoints: auth, users, types, entities, links, graph, search, bulk, export/import, and audit

## Built-In Web User Interface

A minimal, low-level administrative interface served directly by the Workers application for browsing and managing the graph database. This provides a built-in tool for developers and administrators to explore data without requiring external clients.

### ✅ UI Architecture

#### Server-Side Rendering

- HTML pages served via new GET routes (e.g., `/ui`, `/ui/entities/:id`)
- Lightweight, embedded HTML templates (no separate build process)
- Progressive enhancement: works without JavaScript, enhanced with JS
- Embedded CSS (no external stylesheets to deploy)
- Minimal JavaScript for interactive features (vanilla JS, no framework dependencies)

#### Route Structure

- `/ui` or `/ui/` - Main dashboard/home page
- `/ui/entities` - Entity list view with filters
- `/ui/entities/:id` - Entity detail view
- `/ui/entities/:id/edit` - Edit entity form
- `/ui/entities/:id/versions` - Version history view
- `/ui/entities/new` - Create new entity form
- `/ui/links/:id` - Link detail view
- `/ui/links/:id/edit` - Edit link form
- `/ui/links/new` - Create new link form (with source/target selection)
- `/ui/types` - Type registry browser
- `/ui/auth/login` - Login page (if not authenticated)

#### Design Principles

- Simple, functional, form-based interface
- Tables for listing data (entities, links, versions)
- Forms for CRUD operations
- Breadcrumb navigation
- No fancy UI framework - just HTML forms and tables
- Mobile-friendly responsive layout (CSS media queries)

### ✅ Home Page / Dashboard

**Route:** `GET /ui` or `GET /ui/`

#### Features

- Welcome message and quick stats (total entities, links, types, users)
- List of recently created entities (last 20)
- List of recently updated entities (last 20)
- Quick links to common actions (create entity, create link, browse types)

#### Filtering Controls

- **User filter:** Dropdown to filter by `created_by` or `updated_by` user
  - Shows all users from database
  - Option for "All users"
- **Time range filter:** Quick filters for common ranges
  - Last hour, Last day, Last week, Last month, All time
  - Custom date range picker (HTML5 date inputs)
- **Entity type filter:** Dropdown to filter by `type_id`
  - Shows all entity types from types table
  - Option for "All types"

#### Entity Display

Each entity in the list shows:

- Entity ID (linked to detail page)
- Type name (linked to type filter)
- Preview of key properties (e.g., name, title if present)
- Created by (user display name or email)
- Created at (human-readable timestamp)
- Updated at (if different from created_at)
- Version number

### ✅ Entity List View

**Route:** `GET /ui/entities`

#### Features

- Paginated list of all entities (cursor-based pagination)
- Same filtering controls as home page (user, time range, type)
- Additional filters:
  - Show deleted entities (checkbox)
  - Show all versions vs. latest only (checkbox)
- Sorting options (by created_at, type_name, version)
- Future: Bulk selection for batch operations (bulk delete, bulk export)

#### Table Columns

- Entity ID (truncated, linked with display name from properties)
- Type name (linked to filter by that type)
- Properties preview (JSON truncated to 100 chars)
- Version
- Created by (user display name or email)
- Created at (formatted timestamp)
- Status badges (Latest/Old, Deleted if applicable)
- Actions (View, Edit buttons - Edit only for latest non-deleted)

### ✅ Entity Detail View

**Route:** `GET /ui/entities/:id`

#### Entity Information Section

- Full entity details in a definition list or card:
  - ID, Type (linked to type browser), Properties (formatted JSON)
  - Version, Previous version (linked if exists)
  - Created by, Created at, Updated by, Updated at
  - Is latest, Is deleted status badges

#### Properties Display

- Pretty-printed JSON with syntax highlighting
- Editable via "Edit Entity" button
- Shows JSON schema validation rules if type has schema

#### Outgoing Links Section

- Table of all links where this entity is the source
- Columns: Link ID, Link Type, Target Entity (linked), Properties preview, Created at
- "Create new link from this entity" button
- Each link row has View/Edit/Delete actions

#### Incoming Links Section

- Table of all links where this entity is the target
- Columns: Link ID, Link Type, Source Entity (linked), Properties preview, Created at
- Each link row has View/Edit/Delete actions

#### Version History Section

- Timeline of all versions of this entity
- Each version shows:
  - Version number (linked to that version's detail view)
  - Modified by user
  - Modified at timestamp
  - Diff preview (properties changed)
  - "View this version" button
- Highlight current version being viewed
- If viewing an old version, show banner: "You are viewing version X. View latest version"

#### Actions

- Edit Entity button (navigates to edit form)
- Delete Entity button (soft delete with confirmation)
- Create New Version button
- Create Link from this Entity button
- Export Entity (JSON download)

### ✅ Entity Create/Edit Forms

**Routes:**

- `GET /ui/entities/new` - Create form
- `GET /ui/entities/:id/edit` - Edit form

#### Form Structure

- Type selection (dropdown, required) - only on create form
- Properties editor:
  - Large textarea with JSON editor
  - Schema hint displayed when type has JSON schema defined
- JSON validation (client-side)
- Cancel and Save buttons

#### Behavior

- **Create:** POST to `/api/entities`, redirects to new entity detail page on success
- **Edit:** PUT to `/api/entities/:id`, redirects to new entity version on success
- Shows validation errors inline
- Preserves form data on validation errors
- Disabled entities cannot be edited until restored

### ✅ Link List View

**Route:** `GET /ui/links`

#### Features

- Paginated list of all links (cursor-based pagination)
- Filtering controls:
  - Link type filter (dropdown)
  - User filter (created_by)
  - Time range filter (last hour, day, week, month, all time, custom)
  - Source entity filter
  - Target entity filter
  - Show deleted links (checkbox)
  - Show all versions vs. latest only (checkbox)
- Sorting options (by created_at, type_name, version)
- Bulk selection for batch operations (bulk delete, bulk export)

#### Table Columns

- Link ID (truncated, linked to detail page)
- Link type name (linked to filter by that type)
- Source entity (ID and name, linked to entity detail)
- Target entity (ID and name, linked to entity detail)
- Properties preview (JSON truncated to 100 chars)
- Version
- Created by (user display name or email)
- Created at (formatted timestamp)
- Status badges (Latest/Old, Deleted if applicable)
- Actions (View, Edit buttons - Edit only for latest non-deleted)

### ✅ Link Detail View

**Route:** `GET /ui/links/:id`

#### Link Information

- Full link details:
  - ID, Type (linked to type browser)
  - Source Entity (linked to entity detail page)
  - Target Entity (linked to entity detail page)
  - Properties (formatted JSON)
  - Version, Previous version (linked if exists)
  - Created by, Created at, Updated by, Updated at
  - Is latest, Is deleted status badges

#### Visual Representation

- Simple diagram showing: [Source Entity] --[Link Type]--> [Target Entity]
- Both entities clickable to navigate

#### Version History

- Similar to entity version history
- Timeline of all versions of this link

#### Actions

- Edit Link button
- Delete Link button (soft delete with confirmation)
- Create New Version button

### ✅ Link Create/Edit Forms

**Routes:**

- `GET /ui/links/new` - Create form
- `GET /ui/links/new?source=:entityId` - Create with pre-selected source
- `GET /ui/links/:id/edit` - Edit form

#### Form Structure

- Link type selection (dropdown, required)
- Source entity selection:
  - Entity ID input with autocomplete/search
  - Or entity browser/picker
- Target entity selection:
  - Entity ID input with autocomplete/search
  - Or entity browser/picker
- Properties editor (JSON textarea or dynamic fields)
- Cancel and Save buttons

#### Behavior

- **Create:** POST to `/api/links`, redirects to new link detail page
- **Edit:** PUT to `/api/links/:id`, creates new version, redirects to new link version

### ✅ Graph Visualization View

**Route:** `GET /ui/entities/:id/graph`

An interactive visual representation of an entity's local graph neighborhood, showing two generations of connected entities with the current entity at the center.

#### Visual Layout

**Center Node:**

- The current entity displayed prominently at the center of the view
- Shows entity type and distinguishing properties (e.g., name, title, or other unique identifiers)
- Highlighted or styled differently to indicate it's the focal entity

**First Generation (Direct Connections):**

- Incoming links: Entities that link TO the current entity
  - Positioned in an arc or semi-circle above/left of center
  - Arrows pointing toward the center entity
  - Link type label on each arrow
- Outgoing links: Entities that the current entity links TO
  - Positioned in an arc or semi-circle below/right of center
  - Arrows pointing away from the center entity
  - Link type label on each arrow

**Second Generation (Connections of Connections):**

- For each first-generation entity, show its direct connections
- Positioned in outer arcs/rings around their parent first-generation entity
- Arrows showing direction of relationships
- More compact or smaller than first-generation nodes
- May be grouped or collapsed if too numerous (e.g., "3 more connections")

#### Node Display

Each node shows:

- Entity type (as a label or color-coded badge)
- Selected distinguishing properties:
  - Automatically choose 1-2 properties that have distinct values across visible nodes
  - Prefer properties like: `name`, `title`, `label`, `email`, `status`
  - Fallback to entity ID if no distinguishing properties exist
- Truncate long values (max 30 characters with ellipsis)
- Visual indicators:
  - Node color or icon based on entity type
  - Border style indicating link direction (incoming vs outgoing)
  - Deleted entities shown with reduced opacity or strikethrough

#### Link/Edge Display

Each edge (link) shows:

- Directional arrow (solid line with arrowhead)
- Link type label positioned along the edge
- Optional: Link properties on hover
- Color or style variation based on link type
- Hover state shows full link details in tooltip

#### Interaction Features

**Navigation:**

- Click any node to re-center the view on that entity
- Clicking updates the URL to `/ui/entities/:newId/graph`
- Back/forward browser navigation works correctly

**Animation (Bonus):**

- When re-centering on a new node:
  - Nodes slide smoothly to their new positions
  - The new center node moves to the center position
  - Nodes moving out of view (no longer in 2-generation range) fade out
  - Newly visible nodes (now within 2-generation range) fade in
  - Animation duration: 500-800ms with easing function
  - Layout recalculates to maintain visual balance

**Additional Interactions:**

- Hover over node: Highlight node and its direct connections
- Hover over edge: Show full link details (properties, created by, created at)
- Zoom controls: +/- buttons or mouse wheel to zoom in/out
- Pan controls: Click and drag to pan the view
- Fit-to-view button: Reset zoom/pan to show all visible nodes
- Toggle controls:
  - Show/hide deleted entities
  - Show/hide link labels
  - Show only incoming, only outgoing, or both
  - Limit to specific link types (filter dropdown)

#### Layout Algorithm

- Use force-directed layout or radial layout algorithm
- Ensure nodes don't overlap
- Minimize edge crossings where possible
- Maintain consistent spacing between generations
- Adapt layout based on number of nodes (dense vs sparse graphs)

#### Performance Considerations

- Limit total nodes displayed to prevent performance issues (max 50-100 nodes)
- If a generation has too many connections, show a subset with "Show N more" expansion
- Lazy load second-generation data (fetch on demand when first-generation node is expanded)
- Debounce animations to prevent jank on rapid navigation

#### Implementation Approach

**Backend API:**

- Reuse existing graph traversal endpoints (`/api/entities/:id/neighbors`, `/api/graph/traverse`)
- New endpoint: `GET /api/entities/:id/graph-view?depth=2` returns:
  - Current entity
  - First-generation incoming/outgoing entities with link details
  - Second-generation entities (connections of first-generation)
  - Suggested distinguishing properties for visible entity types

**Frontend Rendering:**

- SVG-based rendering for crisp visuals and animations
- Use CSS transforms for smooth node transitions
- Vanilla JavaScript or lightweight graph library (e.g., D3.js if acceptable, or custom canvas/SVG)
- No heavy framework dependencies (keep it lightweight)

**Responsive Design:**

- Adapt layout for mobile (vertical stack or simplified radial layout)
- Touch-friendly node sizes and spacing
- Pinch-to-zoom support on mobile devices

#### Actions

- Re-center button: Return focus to the original entity
- View details button: Navigate to entity detail page
- Edit entity button: Navigate to edit form
- Export subgraph button: Export visible nodes and links as JSON
- Share link: Copy current graph view URL to clipboard

#### Integration with Existing UI

- Add "Graph View" tab or button on entity detail pages
- Add link in navigation menu: "Graph Explorer"
- Breadcrumb shows: Home > Entities > [Entity Name] > Graph View
- Quick toggle between list view, detail view, and graph view

### ✅ Type Browser

**Route:** `GET /ui/types`

#### Features

- List of all registered types (entities and links)
- Filter by category (entity/link)
- Each type shows:
  - Name, Category, Description
  - JSON Schema (if defined)
  - Usage count (number of entities/links using this type)
  - Created by, Created at
- Click to see all entities/links of that type
- ✅ "Create new type" button (admin feature)
- ✅ **GET /ui/types/new** - Create new type form (admin only)
  - Category selection (entity/link)
  - Name (required, unique)
  - Description (optional)
  - JSON Schema (optional, validated)
  - Form validation and error handling
  - Creates type via POST /api/types
- ✅ **Type deletion** - Delete unused types (admin only)
  - Delete button on type detail page
  - Only enabled when usage count is 0
  - Confirmation dialog before deletion
  - Deletes via DELETE /api/types/:id

### ✅ Version Comparison View

**Route:** `GET /ui/entities/:id/versions/:v1/compare/:v2`

#### Features

- Side-by-side comparison of two versions
- Highlighted differences in properties
- Show what changed (added, removed, modified fields)
- Metadata comparison (created_by, created_at)
- Version selector form to compare any two versions
- Summary of changes (added, removed, changed, unchanged counts)
- Full JSON comparison view
- Compare links in entity detail version history
- Responsive design for mobile viewing

### ✅ Search Interface

**Route:** `GET /ui/search`

#### Features

- Simple search form with property filters
- Uses `/api/search/entities` and `/api/search/links` endpoints
- Filter builder UI for complex queries
- Results displayed in table format (similar to entity list)
- Export search results button

### ✅ Group Administration

**Route:** `GET /ui/groups`

#### Features

- List of all groups with member counts
- Create new group button
- Search/filter groups by name

**Route:** `GET /ui/groups/:id`

#### Features

- Group details (name, description, created by/at)
- List of direct members (users and groups)
- Expandable view showing effective membership (recursive)
- Add member form (search for users or groups)
- Remove member buttons
- Edit group details button
- Delete group button (with confirmation)

**Route:** `GET /ui/groups/new` and `GET /ui/groups/:id/edit`

#### Features

- Form for creating/editing group name and description

### ✅ ACL Editor

The entity and link detail views include an ACL section for managing access control.

**Route:** `GET /ui/entities/:id` and `GET /ui/links/:id` (enhanced)

#### ACL Section Features

- Current permissions displayed as a table:
  - Principal (user email/name or group name)
  - Permission level (Read, Write)
  - Remove button
- Add permission form:
  - Principal type selector (User/Group)
  - Principal search with autocomplete
  - Permission level selector (Read/Write)
  - Add button
- "Make Public" button (removes ACL, allows all authenticated users)
- "Make Private" button (restricts to owner only)
- ✅ Can change permission level (Read/Write) on an existing entry.

### ✅ Authentication Integration

#### Login Page

- Login page at `/ui/auth/login` with email/password form
- OAuth provider buttons (Google, GitHub) when configured
- "Register new account" link to registration page
- Error/success message display
- Return URL support for redirecting after login

#### Registration Page

- Registration page at `/ui/auth/register`
- Email, display name (optional), password, and confirm password fields
- Password validation (minimum 8 characters)
- Automatic login after successful registration

#### Logout

- Logout route at `/ui/auth/logout`
- Invalidates session in KV store
- Clears authentication cookies
- Redirects to login with success message

#### OAuth Integration

- UI OAuth initiation routes at `/ui/auth/oauth/google` and `/ui/auth/oauth/github`
- Seamless integration with existing API OAuth endpoints
- State management for return URL preservation
- Automatic redirect back to UI after OAuth callback

#### User Context

- Show logged-in user in header/navbar
- Logout button
- Cookie-based session management with JWT tokens
- Automatic token refresh using refresh tokens
- Created/updated records automatically attributed to current user

#### Cookie-Based Sessions

- Access token cookie (15 minutes expiry)
- Refresh token cookie (7 days expiry)
- HttpOnly and Secure flags for production
- Automatic token refresh when access token expires

#### ✅ Permission Levels

- Access controlled via ACLs on entities and links (see Access Control Lists section)
- Resources with no ACL (NULL acl_id) are accessible to all authenticated users
- Write permission on a resource implies read permission
- Admin-only features (user management, type creation, group management) require admin role

### ✅ Technical Implementation

#### Routing Strategy

- New Hono router mounted at `/ui`
- Separate from `/api` routes but in same Worker
- Returns HTML responses with `Content-Type: text/html`

#### HTML Templating

- Simple template literal functions (no template engine needed)
- Example:
  ```typescript
  function renderEntityDetail(entity: Entity) {
    return `<!DOCTYPE html>
    <html>...entity details...</html>`;
  }
  ```
- Reusable components (header, footer, navigation)
- Escape user content to prevent XSS

#### Styling Approach

- Embedded CSS in `<style>` tags or inline
- Simple, clean design (inspired by GitHub, Linear, or system defaults)
- CSS variables for theming
- Responsive grid/flexbox layouts
- No external CSS framework (keep it lightweight)

#### Client-Side JavaScript

- Minimal vanilla JavaScript for:
  - Form validation and enhancement
  - AJAX requests for autocomplete
  - Confirmation dialogs
  - Dynamic filter updates
- No build step required
- Progressive enhancement (works without JS)

#### Data Fetching

- UI routes call internal API functions directly (no HTTP round-trip)
- Reuse existing route handlers and utilities
- Share validation, auth, and business logic with API

#### Asset Serving

- No separate static assets
- All HTML/CSS/JS embedded in route responses
- Potential small embedded icons (SVG inline or data URIs)

### ✅ UI Feature Checklist

#### Navigation and Layout

- Header with app title, user menu, logout
- Main navigation menu (Home, Entities, Links, Types, Search)
- Breadcrumb trail for current location
- Footer with version info and API docs link

#### Entity Management

- Create entity form with type selection
- Edit entity form (creates new version)
- Delete entity (soft delete with confirmation)
- View entity with all details
- Browse entity version history
- Navigate via outgoing/incoming links
- ✅ Interactive graph visualization (2-generation neighborhood view)
- Filter and search entities

#### Link Management

- Create link form with source/target selection
- Edit link form (creates new version)
- Delete link (soft delete with confirmation)
- View link with source/target context
- Browse link version history

#### User Experience

- Responsive design (mobile and desktop)
- Loading states for async operations
- Success/error notifications (toast or inline)
- Form validation with helpful error messages
- Keyboard shortcuts (optional enhancement)
- Dark mode support (optional, using CSS prefers-color-scheme)

#### Performance

- Server-side pagination for large lists
- Lazy loading for version history
- Minimal JavaScript bundle size
- Fast page loads (< 100ms server-side render)

### ✅ UI Routes Summary

| Route                                | Method | Description                        |
| ------------------------------------ | ------ | ---------------------------------- |
| `/ui`                                | GET    | Dashboard with recent entities     |
| `/ui/entities`                       | GET    | Entity list with filters           |
| `/ui/entities/new`                   | GET    | Create entity form                 |
| `/ui/entities/:id`                   | GET    | Entity detail view                 |
| `/ui/entities/:id/edit`              | GET    | Edit entity form                   |
| `/ui/entities/:id/versions`          | GET    | Version history list               |
| `/ui/entities/:id/versions/:version` | GET    | Specific version detail            |
| `/ui/entities/:id/graph`             | GET    | ✅ Interactive graph visualization |
| `/ui/links`                          | GET    | Link list with filters             |
| `/ui/links/new`                      | GET    | Create link form                   |
| `/ui/links/:id`                      | GET    | Link detail view                   |
| `/ui/links/:id/edit`                 | GET    | Edit link form                     |
| `/ui/links/:id/versions`             | GET    | Link version history               |
| `/ui/types`                          | GET    | Type browser                       |
| `/ui/types/:id`                      | GET    | Type detail with usage stats       |
| `/ui/search`                         | GET    | Search interface                   |

### ✅ Group Administration Routes

| Route                 | Method | Description               |
| --------------------- | ------ | ------------------------- |
| `/ui/groups`          | GET    | Group list                |
| `/ui/groups/new`      | GET    | Create group form         |
| `/ui/groups/:id`      | GET    | Group detail with members |
| `/ui/groups/:id/edit` | GET    | Edit group form           |

### ✅ User Administration Routes

| Route           | Method | Description                   |
| --------------- | ------ | ----------------------------- |
| `/ui/users`     | GET    | User list (admin only)        |
| `/ui/users/:id` | GET    | User detail page (admin only) |

#### ✅ User Detail Page Admin Management

The user detail page (`/ui/users/:id`) includes admin role management:

- ✅ **Admin status badge**: Shows whether user is an admin
- ✅ **Toggle admin button**: Available when viewing other users (not self)
  - "Grant Admin" button for non-admin users
  - "Revoke Admin" button for admin users
- ✅ **Confirmation dialog**: Required before changing admin status
- ✅ **Self-protection**: Button disabled when viewing own profile with tooltip explaining why
- ✅ **Last admin protection**: Button disabled if user is the only remaining admin

### ✅ Audit Log Routes

| Route       | Method | Description                   |
| ----------- | ------ | ----------------------------- |
| `/ui/audit` | GET    | Audit log viewer (admin only) |

### ✅ UI Authentication Routes

| Route                     | Method | Description                     |
| ------------------------- | ------ | ------------------------------- |
| `/ui/auth/login`          | GET    | Login page                      |
| `/ui/auth/login`          | POST   | Login form submission           |
| `/ui/auth/register`       | GET    | Registration page               |
| `/ui/auth/register`       | POST   | Registration form submission    |
| `/ui/auth/logout`         | POST   | Logout handler (clears session) |
| `/ui/auth/oauth/callback` | GET    | OAuth callback handler          |

Note: Entity and link form submissions use standard HTML forms that POST to existing `/api/*` endpoints, then redirect back to UI routes on success. Authentication forms have dedicated UI handlers to manage cookie-based sessions.

## Technical Architecture

### Project Setup

- ✅ Initialize Cloudflare Workers project with TypeScript (via Wrangler CLI)
- ✅ Configure ESLint and Prettier
- ✅ Set up D1 database bindings in wrangler.toml
- ✅ Environment configuration via wrangler.toml and secrets

### Database Migration System

- ✅ Wrangler D1 migrations (SQL files in migrations directory)
- ✅ Version control for schema changes via numbered migration files
- ✅ Migration rollback support through Wrangler CLI
- ✅ Seed data scripts for local development

### API Framework

- ✅ Hono framework for routing (lightweight, Workers-compatible)
- ✅ Request validation with Zod (TypeScript-first schema validation)
- ✅ Error handling middleware in Hono
- ✅ Response formatting utilities
- ✅ Type-safe routing with Hono's TypeScript support

### Logging System

#### ✅ Structured Logger Implementation

- Create centralized logger utility with log levels (debug, info, warn, error)
- JSON-formatted log output with timestamps, request IDs, and context
- Replace ad-hoc console.\* calls throughout the codebase

#### ✅ Request Context Logging

- Middleware to add request ID to all logs for request tracing
- Capture request metadata (method, path, user, duration)
- Correlation ID support for distributed tracing

#### ✅ Error Tracking Integration

- Integration with Workers Analytics Engine for error tracking
  - `AnalyticsEngineDataset` binding configured in wrangler.toml for all environments
  - Error data points written with blobs (error name, category, severity, code, method, path, userId, message, environment) and doubles (status code, timestamp)
  - Index-based partitioning by environment for efficient querying
- Structured error logging with stack traces
  - `ErrorTracker` class with automatic error categorization (validation, authentication, authorization, database, rate_limit, not_found, internal, external, unknown)
  - Error severity levels (low, medium, high, critical) with appropriate log level routing
  - Automatic redaction of sensitive data from error messages and stack traces
  - Convenience methods: `trackValidation()`, `trackAuth()`, `trackDatabase()`
- Error rate monitoring setup
  - Configurable minimum severity threshold for tracking
  - Custom categorizer function support for domain-specific error classification
  - Analytics Engine writes with graceful failure handling (won't affect application on write errors)
  - Health endpoint reports analytics availability status

#### 🟥 External Logging Service Integration

- Integration with external logging services (Datadog, Sentry, etc.)
- Configuration for different environments
- Log streaming setup via Wrangler tail command

### Testing Infrastructure

- ✅ Unit testing framework (Vitest - optimized for Workers)
- ✅ Integration testing with local D1 via Wrangler dev
- ✅ API endpoint testing with Miniflare (local Workers simulator)
- ✅ Test coverage reporting
- ✅ E2E testing against local environment

### ✅ Local Development Environment

- Wrangler dev for local Workers development
- Local D1 database with persistent storage in .wrangler/state
- Local KV storage simulation
- Hot reload during development
- Separate local and remote data by default

### ✅ CI/CD Pipeline

- Automated testing on commits (unit tests and integration tests on push/PR to main)
- Code quality checks (ESLint linting, Prettier formatting, TypeScript type checking)
- Wrangler deploy for automated deployments
- Database migration automation via Wrangler D1 migrations
- Preview deployments for pull requests (deploys to preview environment with PR comment)
- Environment-specific deployments (preview for PRs, production on main branch merge)
- GitHub Actions workflow with concurrency management (cancels in-progress runs)
- Coverage reports uploaded as artifacts
- Production environment protection with GitHub Environments

## Security Considerations

### ✅ Input Validation and Sanitization

- Validate all user inputs using Zod schemas
- Sanitize JSON properties for XSS prevention via automatic HTML escaping in schemas
- SQL injection prevention through D1 prepared statements
- Type validation for all endpoints
- Request size limits enforced by Workers platform
- Sanitization applied to: entity properties, link properties, type names/descriptions, user display names, bulk operations, and import operations
- All HTML special characters (&, <, >, ", ', `, =, /) escaped to prevent XSS attacks

### ✅ HTTPS and Security Headers

- HTTPS enforcement (automatic with Cloudflare)
- Security headers (HSTS, CSP, X-Frame-Options, X-Content-Type-Options, X-XSS-Protection, Referrer-Policy, Permissions-Policy) via Hono middleware
- Environment-aware configuration (stricter in production, relaxed for development)
- CORS configuration via Hono middleware with configurable origins
- Exposed headers for rate limit and request tracking
- Cloudflare's built-in DDoS protection

### ✅ Sensitive Data Protection

- Automatic redaction of sensitive data from logs (passwords, tokens, API keys, etc.)
  - Logger class with built-in sensitive data redaction (enabled by default)
  - `redactSensitiveData()` utility for custom redaction
  - `safeLogContext()` helper for logging request/user data
  - JWT tokens automatically detected and redacted from log strings
  - Bearer token prefixes handled appropriately
- Secure token storage
  - Refresh tokens hashed with SHA-256 before KV storage
  - Tokens never stored in plain text, only hashes
  - Backward compatibility with legacy sessions during migration
  - Timing-safe comparison for token validation
- Environment secrets management
  - Startup validation of required environment variables (JWT_SECRET)
  - Minimum length requirements for secrets (16 chars default, 32 in production)
  - Detection of development/test values in production environment
  - Clear error messages for configuration issues
  - Production mode fails fast on invalid configuration
  - Development mode logs warnings but continues
- Regular security dependency updates (npm audit for dependency scanning)

## Performance Optimization

### Database Query Optimization

Note: D1 provides automatic connection management and is single-threaded per database (~1,000 queries/sec for 1ms queries).

#### ✅ Index Optimization for Common Query Patterns

- Generated columns for frequently queried JSON properties (see Generated Columns section)
- Composite indexes for common filter combinations
- Partial indexes for is_latest and is_deleted flags

#### ✅ Query Plan Analysis Endpoint (Admin Only)

```
POST   /api/schema/query-plan          # Analyze query execution plan
GET    /api/schema/query-plan/templates         # List available query templates
GET    /api/schema/query-plan/templates/{name}  # Get specific template details
```

All query plan endpoints require admin authentication.

- Accept SQL query or predefined template in request body
- Execute EXPLAIN QUERY PLAN via D1 to analyze query execution
- Return query plan with index usage information
- Identify full table scans vs index lookups
- Provide optimization recommendations based on:
  - Index usage detection
  - Missing is_latest/is_deleted filters
  - JSON property filter optimization potential
  - ORDER BY without index detection
  - LIMIT without ORDER BY warnings
- Support 10 predefined query templates:
  - entity_by_id, entity_by_type, entity_by_property
  - links_by_source, links_by_target, links_by_type
  - neighbors_outbound, neighbors_inbound
  - search_entities, search_links
- Security: Only SELECT statements allowed for custom SQL analysis
- Implementation files:
  - `src/routes/query-plan.ts` - API endpoints
  - `src/utils/query-plan.ts` - Query plan analysis utilities
  - `src/schemas/generated-columns.ts` - Schema definitions

#### ✅ Query Performance Tracking via Analytics Engine

- Track query execution times for database operations
  - Middleware-based tracking (`src/middleware/query-tracking.ts`)
  - Utility module (`src/utils/query-performance-tracking.ts`)
  - Automatic SQL analysis to detect table names and query categories
- Write metrics to Cloudflare Analytics Engine
  - Environment-based partitioning for query analysis
  - Metrics include: duration, table name, category, operation type, row count
  - Request context: request ID, user ID
- Include query categorization (read, write, search, graph, schema, auth, audit)
  - Automatic detection from SQL patterns
  - Explicit context override for search and graph operations
- Track slow queries (configurable threshold, default >100ms)
  - Configurable via `slowQueryThreshold` option
  - Slow query flag included in metrics
- Include table name and operation type in metrics
  - Tables: entities, links, types, users, audit_log, multiple, other
  - Operations: first, all, run, batch
- Enable trend analysis for database performance over time
  - Analytics Engine writes with timestamp for time-series analysis
  - Configurable minimum duration to filter fast queries

### ✅ Caching Strategy

- Cloudflare KV for frequently accessed data
  - Types: Cached for 5 minutes (300s) - rarely changes
  - Types list: Cached for 5 minutes with version-based invalidation
  - Entities: Cached for 1 minute (60s) - individual lookups
  - Links: Cached for 1 minute (60s) - individual lookups
  - Users: Cached for 2 minutes (120s)
- Cache invalidation strategy with KV expiration
  - Automatic invalidation on create, update, delete, and restore operations
  - Version-based invalidation for list caches
  - Cache-aside pattern with getOrSet helper
- Configurable TTL per data type (KV supports per-key TTL)
- Cache utility module (`src/utils/cache.ts`) with:
  - Key generation functions for each data type
  - setCache, getCache, deleteCache operations
  - Cache invalidation functions per resource type
  - CacheStatsTracker for monitoring
- Integration with types, entities, and links routes

### ✅ ACL Query Optimization

- User's accessible ACL IDs computed per request via `getAccessibleAclIds(db, kv, userId, permission)`
- Returns Set of ACL IDs the user can access for a given permission level
- For list queries, ACL filter is added as `WHERE acl_id IN (?, ?, ...) OR acl_id IS NULL`
- Index on `acl_id` columns ensures efficient filtering
- For users with access to many ACLs (>1000), fallback to per-row checking via `filterByAclPermission()`
- Effective group membership cached in KV with 5-minute TTL via `getEffectiveGroupsForUser()`
- Implemented in `src/utils/acl.ts`:
  - `getAccessibleAclIds(db, kv, userId, permission)` - Gets all ACL IDs user can access
  - `buildAclFilterClause(db, kv, userId, permission, aclIdColumn)` - Builds SQL WHERE clause for list queries
  - `filterByAclPermission(items, accessibleAclIds)` - Per-row filtering fallback for large ACL sets
- Used in entity and link list endpoints (`GET /api/entities`, `GET /api/links`)

### API Response Optimization

#### ✅ Automatic Compression

- Compression handled automatically via Cloudflare's edge network
- No implementation required - Cloudflare automatically applies gzip/brotli compression

#### ✅ ETag Support for Conditional Requests

- Generate ETag header for GET responses containing data
- Support If-None-Match request header for conditional requests
- Return 304 Not Modified when ETag matches
- Apply to entity, link, type, and user endpoints
- Use content hash (SHA-256 truncated) for ETag generation
- Middleware-based implementation for consistent behavior across routes
- Skip auth endpoints, bulk operations, exports, audit, and search for freshness
- Support multiple ETags and wildcard (\*) in If-None-Match header
- Weak ETags (W/"...") by default for semantic equivalence

#### ✅ Partial Response / Field Selection

- Support `fields` query parameter on GET endpoints
- Allow comma-separated list of fields to include in response
- Reduce payload size for bandwidth-constrained clients
- Apply to entities, links, types, and users endpoints
- Validation of requested fields against allowed fields per resource type
- Returns 400 error with list of allowed fields when invalid fields requested
- Implemented via utility module with consistent behavior across all endpoints

#### ✅ Response Time Monitoring via Workers Analytics

- Track response times for all API endpoints
  - Response time tracking middleware (`src/middleware/response-time.ts`)
  - Response time tracker utility (`src/utils/response-time-tracking.ts`)
  - X-Response-Time header added to all responses
- Write metrics to Analytics Engine
  - Metrics include: duration, status code, content length, timestamp
  - Request context: method, path, user ID, request ID
  - Cloudflare edge context: colo (data center), country
- Categorize by endpoint type (read, write, search, graph, auth, bulk, export, health, docs)
  - Automatic endpoint categorization based on path and HTTP method
  - Route pattern extraction for grouping (UUIDs and numeric IDs replaced with :id)
- Enable performance trend analysis
  - Environment-based partitioning for Analytics Engine queries
  - Status code categorization (2xx, 3xx, 4xx, 5xx)
  - Configurable skip paths and minimum duration threshold

#### ✅ Global Edge Deployment

- Handled automatically by Cloudflare Workers
- No implementation required - Workers deploy globally by default

## Monitoring and Observability

### Health Check Endpoints

- ✅ D1 database connectivity check
- ✅ KV connectivity check
- ✅ System health status
- ✅ Version information endpoint
- ✅ Workers runtime status

### 🟥 Metrics and Monitoring

- Cloudflare Workers Analytics for request metrics
- D1 query performance metrics via Analytics Engine
- Error rate monitoring via Workers Analytics
- Real-time logs via Wrangler tail
- Integration with external monitoring (Sentry, Datadog, etc.)
- Custom metrics using Workers Analytics Engine

## Documentation

### Development Documentation

- ✅ Setup and installation guide
- ✅ Database schema documentation
- 🟥 API development guide
- 🟥 Contributing guidelines

### 🟥 Deployment Documentation

- Cloudflare Workers deployment guide via Wrangler
- Environment configuration reference (wrangler.toml and secrets)
- D1 database export and import procedures
- Scaling considerations and D1 limitations
- Multi-environment setup (dev, staging, production)
- Custom domain configuration

## Platform Limitations and Considerations

### ✅ D1 Database Limits

- **Storage**: 10 GB hard limit per D1 database (cannot be increased)
- **Concurrency**: Single-threaded query processing per database
- **Performance**: ~1,000 queries/sec for 1ms queries, ~10 queries/sec for 100ms queries
- **Batch Operations**: Large updates/deletes must be chunked (avoid millions of rows at once)
- **Scale Strategy**: Initially single database, can shard later if needed

### ✅ Workers Runtime Limits

- **CPU Time**: Free tier has time limits per request; paid plans offer more
- **Request Size**: Maximum request/response sizes enforced
- **npm Compatibility**: Not all Node.js packages work in Workers runtime
- **Execution Model**: Stateless by design; use KV/Durable Objects for state

## Future Enhancements

These features are potential future work:

- Real-time subscriptions via WebSockets (Durable Objects or Cloudflare Calls)
- Full-text search using D1's FTS5 extension or external search service
- Graph visualization endpoints
- Event sourcing architecture using Durable Objects
- Multi-tenancy support with database sharding per tenant
- GraphQL API alternative using Workers-compatible GraphQL libraries
- Automated backup and restore via D1 export/import
- Data export to different graph formats (Cypher, Gremlin)
- Analytics and metrics on graph structure using Workers Analytics Engine
- Horizontal scaling beyond 10GB via sharding strategy
- Integration with Cloudflare R2 for large binary attachments
