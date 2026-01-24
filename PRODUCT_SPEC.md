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

### 🟦 User Authentication System
- JWT-based authentication using Web Crypto API
- Refresh token mechanism for session management (stored in Cloudflare KV)
- Password hashing with argon2 or scrypt (for local accounts)

### 🟦 OAuth2 Integration - Google
- Google OAuth2 sign-in flow
- User provisioning from Google profile

### 🟦 OAuth2 Integration - GitHub
- GitHub OAuth2 sign-in flow
- User provisioning from GitHub profile

### 🟦 OAuth2 Integration - Additional Providers
- Support for Microsoft, Apple, or other OIDC-compliant providers
- Configurable provider registry

### 🟦 Authorization Middleware
- JWT validation middleware
- User context injection into requests
- Protected route patterns

## API Endpoints

### 🟦 Authentication Endpoints

```
POST   /api/auth/register          # Local account registration
POST   /api/auth/login             # Local account login
POST   /api/auth/refresh           # Refresh access token
POST   /api/auth/logout            # Invalidate refresh token
GET    /api/auth/providers         # List available OAuth providers
GET    /api/auth/{provider}        # Initiate OAuth flow
GET    /api/auth/{provider}/callback # OAuth callback handler
GET    /api/auth/me                # Get current user info
```

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

#### 🟦 Advanced Graph Traversal
```
POST   /api/graph/traverse                # Advanced graph traversal queries
```
Multi-hop traversal with depth limits and filtering at each step.

#### 🟦 Shortest Path Finding
```
GET    /api/graph/path                    # Find shortest path between entities
```
Find the shortest path between two entities in the graph.

### 🟦 Search and Query Endpoints

```
POST   /api/search/entities        # Advanced entity search (JSON properties)
POST   /api/search/links           # Advanced link search (JSON properties)
GET    /api/search/suggest         # Type-ahead suggestions
```

### 🟦 User Management Endpoints

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

### 🟦 Advanced JSON Property Queries
- SQLite JSON1 extension functions (json_extract, json_each, etc.)
- Support for nested property filtering using JSON path expressions
- Type-aware comparisons (string, number, boolean)
- Combine multiple property filters with AND/OR logic
- Generated columns for frequently queried JSON properties (with indexes)

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

### 🟦 Graph Traversal - Advanced Queries
- Multi-hop traversal with depth limits
- Path finding between two entities
- Shortest path algorithms
- Traversal with filtering at each step

### 🟦 Bulk Operations
- Batch create entities
- Batch create links
- Batch update operations
- Transaction support for consistency

### 🟦 Export and Import
- Export subgraph as JSON
- Import graph structure from JSON
- Maintain version history during import
- Validation during import

### 🟦 Type Schema Validation
- Optional JSON schema validation for entity/link properties
- Validation on create and update
- Clear error messages for validation failures
- Schema migration support

### 🟦 Audit Logging
- Comprehensive audit log of all operations
- Query audit logs by user, entity, date range
- Compliance and security tracking

### 🟦 Rate Limiting
- Per-user rate limits on API endpoints
- Configurable limits per endpoint category
- Cloudflare KV-based rate limiting for distributed tracking
- Consider Durable Objects for precise rate limiting
- Cloudflare's built-in rate limiting rules as additional protection

### 🟦 API Documentation
- OpenAPI 3.0 specification (generated from Zod schemas)
- Interactive API documentation UI (Scalar, Swagger UI hosted on Workers)
- Request/response examples
- Authentication flow documentation
- Hono's built-in OpenAPI support

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

#### 🟦 Request Context Logging
- Middleware to add request ID to all logs for request tracing
- Capture request metadata (method, path, user, duration)
- Correlation ID support for distributed tracing

#### 🟦 Error Tracking Integration
- Integration with Workers Analytics Engine for error tracking
- Structured error logging with stack traces
- Error rate monitoring setup

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

### 🟦 CI/CD Pipeline
- Automated testing on commits
- Code quality checks (linting, type checking)
- Wrangler deploy for automated deployments
- Database migration automation via Wrangler D1 migrations
- Preview deployments for pull requests
- Environment-specific deployments (dev, staging, production)

## Security Considerations

### 🟦 Input Validation and Sanitization
- Validate all user inputs using Zod schemas
- Sanitize JSON properties for XSS prevention
- SQL injection prevention through D1 prepared statements
- Type validation for all endpoints
- Request size limits enforced by Workers platform

### 🟦 HTTPS and Security Headers
- HTTPS enforcement (automatic with Cloudflare)
- Security headers (HSTS, CSP, X-Frame-Options) via Hono middleware
- CORS configuration via Hono middleware
- Cloudflare's built-in DDoS protection

### 🟦 Sensitive Data Protection
- Don't log sensitive data (passwords, tokens)
- Secure token storage
- Environment secrets management
- Regular security dependency updates

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
