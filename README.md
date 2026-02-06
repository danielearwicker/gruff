# Gruff - Graph Database with Versioning

Entity-Relationship Graph Database with versioning built on Cloudflare Workers + D1.

## Local Development Setup

### Prerequisites

- Node.js (v18 or later)
- npm

### Installation

1. Install dependencies:

```bash
npm install
```

2. Set up the database:

```bash
npm run db:setup:local  # Runs migrations + loads seed data
```

3. Start the development server:

```bash
npm run dev
```

The server will start at `http://localhost:8787`

## Available Scripts

**Development:**

- `npm run dev` - Start local development server with Wrangler
- `npm test` - Run integration test suite (resets DB, starts server, runs tests)

**Database:**

- `npm run db:setup:local` - Run migrations + load seed data (first time setup)
- `npm run db:reset:local` - Nuke database and start fresh
- `npm run migrate:local` - Run all migrations (auto-discovers from migrations/)
- `npm run seed:local` - Load seed data only

**Deployment:**

- `npm run deploy` - Deploy to Cloudflare
- `npm run migrate:remote` - Apply migrations to remote D1 database
- `npm run db:setup:remote` - Run migrations + seed on remote database

## Local Database

The local D1 database is stored in `.wrangler/state/v3/d1/`. This directory is gitignored and contains your local development data.

## API Documentation

Gruff auto-generates its OpenAPI specification from route definitions using `@hono/zod-openapi`. This means the documentation always matches the implementation.

- **Interactive docs**: [http://localhost:8787/docs](http://localhost:8787/docs) — Scalar-powered API reference UI
- **OpenAPI spec (JSON)**: [http://localhost:8787/docs/openapi.json](http://localhost:8787/docs/openapi.json)
- **OpenAPI spec (YAML)**: [http://localhost:8787/docs/openapi.yaml](http://localhost:8787/docs/openapi.yaml)

### TypeScript Client Generation

Generate a typed API client from the running server:

```bash
npm run generate:client
```

This uses `@hey-api/openapi-ts` to produce a fully-typed fetch client in `./test-client/`. The server must be running (`npm run dev`) when you run this command.

## API Endpoints

The API is organized into the following groups (see `/docs` for full details):

| Group         | Base Path                 | Description                               |
| ------------- | ------------------------- | ----------------------------------------- |
| Health        | `/health`, `/api/version` | Health checks and version info            |
| Auth          | `/api/auth`               | Registration, login, OAuth, token refresh |
| Users         | `/api/users`              | User profiles and management              |
| Groups        | `/api/groups`             | Group management and membership           |
| Types         | `/api/types`              | Type registry for entities and links      |
| Entities      | `/api/entities`           | Entity CRUD, versioning, ACL              |
| Links         | `/api/links`              | Link CRUD, versioning, ACL                |
| Graph         | `/api/graph`              | Traversal and shortest-path queries       |
| Search        | `/api/search`             | Full-text search and suggestions          |
| Bulk          | `/api/bulk`               | Batch create/update operations            |
| Export/Import | `/api/export`             | Data export and import                    |
| Audit         | `/api/audit`              | Audit log queries                         |
| Schema        | `/api/schema`             | Generated columns and query plan analysis |

## Testing

### Automated Integration Tests

Run the full integration test suite:

```bash
npm test
```

This will automatically:

- Reset the local database
- Apply migrations
- Start the dev server
- Run all tests
- Stop the server and report results

See [TESTING.md](./TESTING.md) for details on adding new tests.

### Manual Testing

To test the setup manually:

1. Start the dev server: `npm run dev`
2. Visit `http://localhost:8787/health` in your browser
3. You should see a JSON response with connection status

## Project Structure

```
gruff/
├── src/
│   ├── index.ts              # Main Worker entry point, OpenAPI config
│   ├── routes/               # Route handlers (OpenAPIHono + createRoute)
│   ├── schemas/              # Zod schemas with .openapi() annotations
│   ├── middleware/            # Auth, validation, rate limiting, etc.
│   └── utils/                # Response helpers, logger, error tracking
├── migrations/               # Database migrations (auto-discovered)
├── scripts/                  # Migration runner, seed data loader
├── docs/                     # OpenAPI baseline and reference docs
├── test-runner.js            # Integration test runner
├── wrangler.toml             # Cloudflare Workers configuration
└── package.json
```
