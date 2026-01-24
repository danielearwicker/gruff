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
```

### ✅ Database Indexes
- Composite index on `entities(type_id, is_latest, is_deleted)` for filtered queries
- Composite index on `links(source_entity_id, is_latest, is_deleted)` for graph traversal
- Composite index on `links(target_entity_id, is_latest, is_deleted)` for reverse traversal
- Indexes on JSON fields using generated columns for frequently queried properties
- Index on `entities.created_by` and `links.created_by` for user queries
- Index on `entities.created_at` and `links.created_at` for time-based queries

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

#### 🟦 OAuth2 - Additional Providers
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

#### 🟦 Generated Columns and Indexes
- Add migration to create generated columns for frequently queried properties
- Create indexes on generated columns
- Document which properties have generated columns
- Provide utility to add new generated columns for specific use cases

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
  - Filter by entity type IDs
  - Filter by creation date range
  - Option to include deleted entities/links
  - Option to include version history
  - Includes referenced types in export
  - Returns format_version, exported_at timestamp, and metadata
- Import graph structure from JSON via POST /api/export
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
- Replace ad-hoc console.* calls throughout the codebase

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

#### 🟦 External Logging Service Integration
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

### 🟦 Database Query Optimization
- Query analysis and optimization using D1's query plan analyzer
- Automatic connection management by D1
- Index optimization for common query patterns
- Database monitoring via Workers Analytics
- Note: D1 is single-threaded per database (~1,000 queries/sec for 1ms queries)

### 🟦 Caching Strategy
- Cloudflare KV for frequently accessed data
- Cache invalidation strategy with KV expiration
- Configurable TTL per data type (KV supports per-key TTL)
- Edge caching via Cache API for read-heavy endpoints
- Consider Durable Objects for strongly consistent caching needs

### 🟦 API Response Optimization
- Automatic compression via Cloudflare's edge network
- ETag support for conditional requests
- Partial response/field selection
- Response time monitoring via Workers Analytics
- Global edge deployment for low latency

## Monitoring and Observability

### Health Check Endpoints
- ✅ D1 database connectivity check
- ✅ KV connectivity check
- ✅ System health status
- ✅ Version information endpoint
- ✅ Workers runtime status

### 🟦 Metrics and Monitoring
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
- 🟦 API development guide
- 🟦 Contributing guidelines

### 🟦 Deployment Documentation
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

These features are not marked with 🟦 as they are potential future work:

- Real-time subscriptions via WebSockets (Durable Objects or Cloudflare Calls)
- Full-text search using D1's FTS5 extension or external search service
- Graph visualization endpoints
- Access control lists (ACLs) per entity/link
- Event sourcing architecture using Durable Objects
- Multi-tenancy support with database sharding per tenant
- GraphQL API alternative using Workers-compatible GraphQL libraries
- Automated backup and restore via D1 export/import
- Data export to different graph formats (Cypher, Gremlin)
- Analytics and metrics on graph structure using Workers Analytics Engine
- Horizontal scaling beyond 10GB via sharding strategy
- Integration with Cloudflare R2 for large binary attachments
