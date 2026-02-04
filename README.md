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

## Project Structure

```
gruff/
├── src/
│   └── index.ts          # Main Worker entry point
├── migrations/           # Database migrations (auto-discovered)
│   ├── 0001_initial_schema.sql
│   ├── 0002_version_triggers.sql
│   └── ...               # Just add numbered .sql files here
├── scripts/
│   ├── migrate.js        # Migration runner (auto-discovers migrations)
│   └── seed.js           # Seed data loader
├── wrangler.toml         # Cloudflare Workers configuration
├── tsconfig.json         # TypeScript configuration
└── package.json          # Dependencies and scripts
```

## Local Database

The local D1 database is stored in `.wrangler/state/v3/d1/`. This directory is gitignored and contains your local development data.

## API Endpoints

### Health Check

```
GET /health
```

Returns the health status of the API, database, and KV store.

### Root

```
GET /
```

Returns basic API information.

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

## Next Steps

- Implement authentication endpoints
- Add entity and link CRUD operations
- Set up OAuth2 integrations
- Add graph traversal queries
