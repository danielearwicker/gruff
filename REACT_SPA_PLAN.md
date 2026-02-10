# React SPA Plan — Gruff Management UI

## Overview

Replace the server-side rendered UI (`src/routes/ui.ts` — 11,000 lines, `src/utils/html.ts` — 980 lines) with a React single-page application. The SPA will use the auto-generated TypeScript client (`@hey-api/openapi-ts`) for all API communication, providing type safety and ensuring the UI stays in sync with the OpenAPI spec.

### Goals

1. **Use the generated TS client** for every API call — if the API changes, the client regenerates and the build breaks, surfacing problems immediately
2. **Well-structured componentised codebase** — feature-based directory structure, shared components, clear separation of concerns
3. **Feature parity** with the existing SSR UI — same pages, same functionality
4. **Same deployment model** — served from the same Cloudflare Worker, no separate hosting

### Non-Goals

- Adding new features beyond what the current UI provides
- Changing the API or backend
- Mobile-native support (responsive web is sufficient, as today)

---

## Technology Stack

| Concern             | Choice                                                                              | Rationale                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Framework           | **React 19**                                                                        | Mature ecosystem, wide familiarity                                                          |
| Build tool          | **Vite**                                                                            | Fast builds, excellent React/TS support, simple config                                      |
| Routing             | **React Router v7**                                                                 | Standard SPA routing, supports loaders and lazy routes                                      |
| API client          | **@hey-api/openapi-ts** (already in project)                                        | Type-safe, auto-generated from OpenAPI spec                                                 |
| Styling             | **CSS Modules + CSS custom properties**                                             | Scoped styles per component, reuse existing design tokens from `html.ts`                    |
| State management    | **React Query (TanStack Query)**                                                    | Server-state caching, refetching, loading/error states — eliminates hand-rolled fetch logic |
| Forms               | **React Hook Form**                                                                 | Lightweight, good validation, works well with Zod                                           |
| Graph visualisation | **D3.js** (or **@xyflow/react**)                                                    | Replace the hand-rolled SVG force layout; D3 is closest to the existing approach            |
| JSON editing        | **Monaco Editor** (`@monaco-editor/react`) or a simple `<textarea>` with validation | For entity/link property editing                                                            |
| Testing             | **Vitest + React Testing Library**                                                  | Already using Vitest for unit tests                                                         |

### Serving Strategy

Wrangler v4 supports a `[assets]` directive that serves static files from a directory alongside the Worker. The React SPA builds to `ui/dist/`, and the Worker serves it at `/ui/*` with a catch-all fallback to `index.html` for client-side routing.

```toml
# wrangler.toml addition
[assets]
directory = "ui/dist"
binding = "ASSETS"
```

The Worker route at `/ui` becomes a simple catch-all that serves the SPA's `index.html`, letting React Router handle all `/ui/*` paths client-side.

---

## Project Structure

```
gruff/
├── ui/                          # React SPA (new)
│   ├── package.json             # Separate package.json for frontend deps
│   ├── tsconfig.json            # Frontend TS config (jsx, dom libs)
│   ├── vite.config.ts           # Vite config (base: '/ui/')
│   ├── index.html               # SPA entry point
│   └── src/
│       ├── main.tsx             # React entry, router setup
│       ├── App.tsx              # Root layout (header, nav, outlet)
│       ├── client/              # Generated API client (output of openapi-ts)
│       │   └── ...              # Auto-generated — do not edit
│       ├── api/                 # API layer wrapping the generated client
│       │   ├── client.ts        # Client configuration (base URL, auth interceptor)
│       │   ├── queries.ts       # TanStack Query hooks (useEntities, useEntity, etc.)
│       │   └── mutations.ts     # TanStack Query mutations (useCreateEntity, etc.)
│       ├── auth/                # Authentication
│       │   ├── AuthContext.tsx   # Auth provider, useAuth hook
│       │   ├── RequireAuth.tsx  # Route guard component
│       │   ├── RequireAdmin.tsx # Admin route guard
│       │   └── LoginPage.tsx    # Login form + OAuth buttons
│       ├── components/          # Shared UI components
│       │   ├── Layout/
│       │   │   ├── Header.tsx        # Nav bar, user menu, logout
│       │   │   ├── Breadcrumbs.tsx
│       │   │   └── Footer.tsx
│       │   ├── DataTable.tsx         # Reusable striped table
│       │   ├── Pagination.tsx        # Cursor + offset pagination
│       │   ├── Badge.tsx             # Status badges (success, warning, error, etc.)
│       │   ├── ConfirmDialog.tsx     # Modal confirmation dialog
│       │   ├── FilterForm.tsx        # Reusable filter form with time range toggle
│       │   ├── JsonEditor.tsx        # JSON textarea with validation feedback
│       │   ├── EntityPicker.tsx      # Autocomplete entity search
│       │   ├── PrincipalSearch.tsx   # User/group autocomplete for ACL
│       │   ├── EmptyState.tsx        # "No results" placeholder
│       │   └── ErrorBoundary.tsx     # Catch rendering errors
│       ├── features/            # Feature modules (one per domain)
│       │   ├── dashboard/
│       │   │   └── DashboardPage.tsx      # Stats grid, recent entities/updates
│       │   ├── entities/
│       │   │   ├── EntityListPage.tsx     # Browser with filters, pagination
│       │   │   ├── EntityDetailPage.tsx   # Properties, ACL, links, actions
│       │   │   ├── EntityCreatePage.tsx   # Create form with type picker
│       │   │   ├── EntityEditPage.tsx     # Edit form
│       │   │   ├── EntityGraphPage.tsx    # SVG graph visualisation
│       │   │   ├── VersionListPage.tsx    # Version history table
│       │   │   ├── VersionDetailPage.tsx  # Single version view
│       │   │   ├── VersionComparePage.tsx # Side-by-side diff
│       │   │   └── components/
│       │   │       ├── AclPanel.tsx       # ACL editor (add/remove/change permissions)
│       │   │       ├── LinkedEntities.tsx # Outbound/inbound links list
│       │   │       └── PropertyDiff.tsx   # Property diff display
│       │   ├── links/
│       │   │   ├── LinkListPage.tsx       # Browser with filters
│       │   │   ├── LinkDetailPage.tsx     # Link view with arrow diagram
│       │   │   ├── LinkCreatePage.tsx     # Create with entity pickers
│       │   │   ├── LinkEditPage.tsx       # Edit form
│       │   │   └── components/
│       │   │       ├── LinkDiagram.tsx    # Source → arrow → target visual
│       │   │       └── AclPanel.tsx       # (shared or re-exported)
│       │   ├── types/
│       │   │   ├── TypeListPage.tsx       # Type browser with category filter
│       │   │   └── TypeDetailPage.tsx     # Schema display, recent items
│       │   ├── search/
│       │   │   └── SearchPage.tsx         # Advanced search with filter builder
│       │   ├── users/
│       │   │   ├── UserListPage.tsx       # Admin user browser
│       │   │   └── UserDetailPage.tsx     # Profile, groups, admin toggle
│       │   └── groups/
│       │       ├── GroupListPage.tsx      # Group browser
│       │       ├── GroupDetailPage.tsx    # Members, add/remove
│       │       ├── GroupCreatePage.tsx    # Create group form
│       │       └── GroupEditPage.tsx      # Edit name/description
│       ├── hooks/               # Shared custom hooks
│       │   ├── useDebounce.ts
│       │   └── useDocumentTitle.ts
│       └── styles/              # Global styles
│           ├── tokens.css       # CSS custom properties (from existing html.ts)
│           ├── reset.css        # Minimal reset
│           └── global.css       # Base typography, links, etc.
```

---

## Authentication Strategy

The existing SSR UI uses httpOnly cookies (`gruff_access_token`, `gruff_refresh_token`) set by server-side login handlers. The SPA will shift to a pure API-driven auth flow:

1. **Login**: SPA posts credentials to `POST /api/auth/login`, receives `{ access_token, refresh_token }` in the JSON response body
2. **Token storage**: Access token held in memory (React state/context). Refresh token in an httpOnly cookie (set by the API via `Set-Cookie`) or in memory
3. **API calls**: The generated TS client is configured with an auth interceptor that attaches `Authorization: Bearer <token>` to every request
4. **Token refresh**: On 401 response, the interceptor calls `POST /api/auth/refresh` to get a new access token, then retries the original request
5. **Auth state**: `AuthContext` provides `{ user, isAuthenticated, isAdmin, login, logout }` to the component tree
6. **Route guards**: `<RequireAuth>` redirects to login; `<RequireAdmin>` redirects to dashboard with an error

The SSR auth routes (`/ui/auth/login`, `/ui/auth/logout`, `/ui/auth/oauth/*`) can be removed once the SPA handles auth. OAuth flows will redirect to the existing API OAuth endpoints and return tokens to the SPA via a callback URL.

---

## Route Map

| SPA Path                                    | Component            | Current SSR Route                               |
| ------------------------------------------- | -------------------- | ----------------------------------------------- |
| `/ui`                                       | `DashboardPage`      | `GET /ui`                                       |
| `/ui/entities`                              | `EntityListPage`     | `GET /ui/entities`                              |
| `/ui/entities/new`                          | `EntityCreatePage`   | `GET /ui/entities/new`                          |
| `/ui/entities/:id`                          | `EntityDetailPage`   | `GET /ui/entities/:id`                          |
| `/ui/entities/:id/edit`                     | `EntityEditPage`     | `GET /ui/entities/:id/edit`                     |
| `/ui/entities/:id/graph`                    | `EntityGraphPage`    | `GET /ui/entities/:id/graph`                    |
| `/ui/entities/:id/versions`                 | `VersionListPage`    | `GET /ui/entities/:id/versions`                 |
| `/ui/entities/:id/versions/:v`              | `VersionDetailPage`  | `GET /ui/entities/:id/versions/:version`        |
| `/ui/entities/:id/versions/:v1/compare/:v2` | `VersionComparePage` | `GET /ui/entities/:id/versions/:v1/compare/:v2` |
| `/ui/links`                                 | `LinkListPage`       | `GET /ui/links`                                 |
| `/ui/links/new`                             | `LinkCreatePage`     | `GET /ui/links/new`                             |
| `/ui/links/:id`                             | `LinkDetailPage`     | `GET /ui/links/:id`                             |
| `/ui/links/:id/edit`                        | `LinkEditPage`       | `GET /ui/links/:id/edit`                        |
| `/ui/types`                                 | `TypeListPage`       | `GET /ui/types`                                 |
| `/ui/types/:id`                             | `TypeDetailPage`     | `GET /ui/types/:id`                             |
| `/ui/search`                                | `SearchPage`         | `GET /ui/search`                                |
| `/ui/users`                                 | `UserListPage`       | `GET /ui/users`                                 |
| `/ui/users/:id`                             | `UserDetailPage`     | `GET /ui/users/:id`                             |
| `/ui/groups`                                | `GroupListPage`      | `GET /ui/groups`                                |
| `/ui/groups/new`                            | `GroupCreatePage`    | `GET /ui/groups/new`                            |
| `/ui/groups/:id`                            | `GroupDetailPage`    | `GET /ui/groups/:id`                            |
| `/ui/groups/:id/edit`                       | `GroupEditPage`      | `GET /ui/groups/:id/edit`                       |
| `/ui/login`                                 | `LoginPage`          | `GET /ui/auth/login`                            |

---

## API Endpoints Used by the UI

All of these will be called via the generated TS client. Grouped by feature:

### Dashboard

- `GET /api/entities` (with `limit=5`, sorted by created)
- `GET /api/entities` (with `limit=5`, sorted by updated)
- `GET /api/types`
- `GET /api/users` (admin — for user count)

### Entities

- `GET /api/entities` — list with filters
- `POST /api/entities` — create
- `GET /api/entities/:id` — detail
- `PUT /api/entities/:id` — update
- `DELETE /api/entities/:id` — soft delete
- `POST /api/entities/:id/restore` — restore
- `GET /api/entities/:id/versions` — version history
- `GET /api/entities/:id/versions/:v` — specific version
- `PUT /api/entities/:id/acl` — manage ACL

### Links

- `GET /api/links` — list with filters
- `POST /api/links` — create
- `GET /api/links/:id` — detail
- `PUT /api/links/:id` — update
- `DELETE /api/links/:id` — soft delete
- `POST /api/links/:id/restore` — restore
- `PUT /api/links/:id/acl` — manage ACL

### Graph

- `GET /api/graph/entities/:id/graph-view` — neighbourhood graph data

### Search

- `GET /api/search/suggest` — autocomplete
- `GET /api/search` — full search with property filters

### Types

- `GET /api/types` — list
- `GET /api/types/:id` — detail
- `DELETE /api/types/:id` — delete (admin)

### Users (admin)

- `GET /api/users` — list
- `GET /api/users/:id` — detail
- `PUT /api/users/:id` — update (toggle admin)
- `GET /api/users/search` — search by email

### Groups (admin)

- `GET /api/groups` — list
- `POST /api/groups` — create
- `GET /api/groups/:id` — detail
- `PUT /api/groups/:id` — update
- `DELETE /api/groups/:id` — delete
- `POST /api/groups/:id/members` — add member
- `DELETE /api/groups/:id/members/:type/:id` — remove member

### Auth

- `POST /api/auth/login` — login
- `POST /api/auth/register` — register
- `POST /api/auth/refresh` — refresh token
- `GET /api/auth/me` — current user
- `GET /api/auth/google` — initiate OAuth
- `GET /api/auth/github` — initiate OAuth

---

## Implementation Checklist

Each step is independently deployable. The old SSR UI remains functional until the SPA is complete and can coexist during development (e.g. SPA at `/app` temporarily, SSR at `/ui`).

### Phase 1: Project Scaffolding

- [✅] **1.1** Create `ui/` directory with Vite + React + TypeScript scaffold (`npm create vite@latest`)
- [✅] **1.2** Configure Vite: set `base: '/ui/'`, configure build output to `ui/dist/`
- [✅] **1.3** Add `ui/package.json` with dependencies: `react`, `react-dom`, `react-router`, `@tanstack/react-query`, `react-hook-form`
- [✅] **1.4** Add `ui/tsconfig.json` with DOM libs, JSX support, strict mode
- [✅] **1.5** Extract CSS custom properties from `src/utils/html.ts` into `ui/src/styles/tokens.css` — preserve the existing design language
- [✅] **1.6** Create `ui/src/styles/reset.css` and `ui/src/styles/global.css` with base styles from `html.ts`
- [✅] **1.7** Add npm scripts to root `package.json`: `"ui:dev"`, `"ui:build"`, `"ui:generate-client"`
- [✅] **1.8** Configure `@hey-api/openapi-ts` to output into `ui/src/client/` (update `generate:client` script or add a new one)
- [✅] **1.9** Generate the TS client into `ui/src/client/`
- [✅] **1.10** Update `wrangler.toml` with `[assets]` directive pointing to `ui/dist/`
- [✅] **1.11** Add a catch-all Worker route for `/ui/*` that serves `index.html` (for client-side routing)
- [✅] **1.12** Verify the dev workflow: `wrangler dev` serves both the API and the SPA

### Phase 2: Core Infrastructure

- [🟦] **2.1** Set up `ui/src/api/client.ts` — configure the generated client with base URL and auth interceptor
- [🟦] **2.2** Build `AuthContext.tsx` — login, logout, token refresh, expose `user`/`isAuthenticated`/`isAdmin`
- [🟦] **2.3** Build `RequireAuth.tsx` and `RequireAdmin.tsx` route guard components
- [🟦] **2.4** Build `LoginPage.tsx` — email/password form, OAuth buttons (Google, GitHub), redirect after login
- [🟦] **2.5** Set up React Router in `main.tsx` with the full route tree (lazy-loaded routes)
- [🟦] **2.6** Build `App.tsx` root layout with `<Header>`, `<Outlet>`, `<Footer>`
- [🟦] **2.7** Build `Header.tsx` — nav links (Home, Entities, Links, Types, Groups, Search), user menu, logout, admin badge
- [🟦] **2.8** Build `Breadcrumbs.tsx` and `Footer.tsx`
- [🟦] **2.9** Build `ErrorBoundary.tsx` — catch rendering errors, show recovery UI
- [🟦] **2.10** Set up TanStack Query provider in `main.tsx`

### Phase 3: Shared Components

- [🟦] **3.1** `DataTable.tsx` — striped rows, sortable headers, loading skeleton
- [🟦] **3.2** `Pagination.tsx` — support both cursor-based and offset-based pagination
- [🟦] **3.3** `Badge.tsx` — variants: success, warning, error, muted, admin
- [🟦] **3.4** `ConfirmDialog.tsx` — modal with confirm/cancel, used for delete, admin toggle, etc.
- [🟦] **3.5** `FilterForm.tsx` — generic filter form with time range toggle, type dropdown, user dropdown
- [🟦] **3.6** `JsonEditor.tsx` — textarea with real-time JSON validation, error display, optional schema hints
- [🟦] **3.7** `EntityPicker.tsx` — debounced search calling `/api/search/suggest`, dropdown results, selection display
- [🟦] **3.8** `PrincipalSearch.tsx` — search users/groups for ACL management
- [🟦] **3.9** `EmptyState.tsx` — friendly "no results" with optional action button

### Phase 4: TanStack Query Hooks

- [🟦] **4.1** `queries.ts` — define query hooks for all GET endpoints: `useEntities`, `useEntity`, `useEntityVersions`, `useLinks`, `useLink`, `useTypes`, `useType`, `useUsers`, `useUser`, `useGroups`, `useGroup`, `useGroupMembers`, `useGraphView`, `useSearchSuggest`, `useSearch`
- [🟦] **4.2** `mutations.ts` — define mutation hooks for all write endpoints: `useCreateEntity`, `useUpdateEntity`, `useDeleteEntity`, `useRestoreEntity`, `useUpdateEntityAcl`, `useCreateLink`, `useUpdateLink`, `useDeleteLink`, `useRestoreLink`, `useUpdateLinkAcl`, `useDeleteType`, `useUpdateUser`, `useCreateGroup`, `useUpdateGroup`, `useDeleteGroup`, `useAddGroupMember`, `useRemoveGroupMember`
- [🟦] **4.3** Configure query invalidation — e.g. creating an entity invalidates the entity list cache

### Phase 5: Feature Pages — Dashboard

- [🟦] **5.1** `DashboardPage.tsx` — stats grid (entity count, link count, type count, user count), recent entities, recent updates
- [🟦] **5.2** Verify dashboard matches existing SSR dashboard functionality

### Phase 6: Feature Pages — Entities

- [🟦] **6.1** `EntityListPage.tsx` — filter form (user, type, time range, deleted, all versions), cursor pagination, entity cards
- [🟦] **6.2** `EntityCreatePage.tsx` — type selector with schema hints, JSON properties editor, form submission
- [🟦] **6.3** `EntityDetailPage.tsx` — property display, metadata, action buttons (edit, delete, restore, graph, export JSON)
- [🟦] **6.4** `AclPanel.tsx` — inline ACL editor on entity detail: list permissions, add/remove principals, make public/private
- [🟦] **6.5** `LinkedEntities.tsx` — outbound and inbound link lists on entity detail
- [🟦] **6.6** `EntityEditPage.tsx` — pre-populated form, JSON validation, submit update
- [🟦] **6.7** `VersionListPage.tsx` — version history table with compare links
- [🟦] **6.8** `VersionDetailPage.tsx` — single version view with prev/next navigation
- [🟦] **6.9** `VersionComparePage.tsx` — side-by-side diff with change summary (added, removed, changed, unchanged)
- [🟦] **6.10** `EntityGraphPage.tsx` — SVG graph with pan/zoom, toggle deleted, toggle labels, fit-to-view, click-to-navigate

### Phase 7: Feature Pages — Links

- [🟦] **7.1** `LinkListPage.tsx` — filter form (user, type, source/target, time range, deleted), pagination
- [🟦] **7.2** `LinkCreatePage.tsx` — dual entity pickers (source + target), type selector, properties editor
- [🟦] **7.3** `LinkDetailPage.tsx` — link diagram (source → arrow → target), properties, metadata, actions
- [🟦] **7.4** `LinkEditPage.tsx` — pre-populated form, submit update
- [🟦] **7.5** Link ACL panel (reuse or adapt entity AclPanel)

### Phase 8: Feature Pages — Types, Search

- [🟦] **8.1** `TypeListPage.tsx` — category filter (entity/link), usage counts, type cards
- [🟦] **8.2** `TypeDetailPage.tsx` — schema display, description, recent items of that type
- [🟦] **8.3** `SearchPage.tsx` — advanced filter builder (up to 5 property filters with operators), entity/link toggle, date range, results display, export JSON link

### Phase 9: Feature Pages — Admin (Users & Groups)

- [🟦] **9.1** `UserListPage.tsx` — email search, provider filter, status filter, pagination
- [🟦] **9.2** `UserDetailPage.tsx` — profile info, group memberships, recent activity, admin toggle with confirmation modal
- [🟦] **9.3** `GroupListPage.tsx` — group list with description
- [🟦] **9.4** `GroupDetailPage.tsx` — member list (users + nested groups), add/remove members
- [🟦] **9.5** `GroupCreatePage.tsx` — name + description form
- [🟦] **9.6** `GroupEditPage.tsx` — edit name/description

### Phase 10: Polish & Parity

- [🟦] **10.1** Dark mode — CSS custom properties already support `prefers-color-scheme: dark`; verify all components respect it
- [🟦] **10.2** Responsive layout — verify mobile breakpoint (768px) works for all pages
- [🟦] **10.3** Loading states — skeleton screens or spinners for every data-fetching page
- [🟦] **10.4** Error states — display API errors inline, network errors in a toast/banner
- [🟦] **10.5** Page titles — `useDocumentTitle` hook to set `<title>` per page
- [🟦] **10.6** Keyboard accessibility — focus management, skip links, ARIA labels on interactive elements
- [🟦] **10.7** Walk through every page side-by-side with the SSR version and verify feature parity

### Phase 11: Integration & Cleanup

- [🟦] **11.1** Update root `package.json` build scripts: `"build"` should build both Worker and SPA
- [🟦] **11.2** Update `.gitignore` with `ui/dist/`, `ui/node_modules/`, `ui/src/client/` (generated)
- [🟦] **11.3** Run the full integration test suite (`npm test`) — all 1935 tests should still pass (API unchanged)
- [🟦] **11.4** Switch the `/ui` route from SSR to serving the SPA
- [🟦] **11.5** Delete `src/routes/ui.ts` (11,000 lines) and `src/utils/html.ts` (980 lines)
- [🟦] **11.6** Remove the `uiRouter` import and `app.route('/ui', uiRouter)` from `src/index.ts`
- [🟦] **11.7** Remove any SSR-only dependencies (cookie helpers used only by UI, etc.)
- [🟦] **11.8** Update CI/CD pipeline to build the SPA before deploying the Worker
- [🟦] **11.9** Update `README.md` with new UI development instructions

---

## Development Workflow

```bash
# Terminal 1: Run the API (Worker)
npm run dev

# Terminal 2: Run the React dev server with HMR (proxies API to Worker)
cd ui && npm run dev

# Regenerate TS client after API changes
npm run ui:generate-client

# Build SPA for production
npm run ui:build

# Full deploy (builds SPA + deploys Worker)
npm run build && npm run deploy
```

Vite's dev server will proxy `/api/*`, `/docs/*`, and `/health` to the Wrangler dev server (port 8787), so the SPA can be developed with hot reload while hitting the real API.

---

## Risks & Mitigations

| Risk                                                               | Mitigation                                                                                                                                     |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `[assets]` directive doesn't play well with existing Worker routes | Test early in Phase 1. Fallback: use Workers Sites with `@cloudflare/kv-asset-handler`                                                         |
| Graph visualisation is complex to port (custom SVG force layout)   | Keep the same algorithmic approach but wrap it in a React component with `useRef` for the SVG. Consider D3's force simulation for cleaner code |
| OAuth callback flow needs rethinking for SPA                       | Use a popup or redirect pattern — the API OAuth endpoints redirect to a callback URL that the SPA can intercept                                |
| Two `package.json` files (monorepo-lite) adds complexity           | Keep it simple — no workspace manager needed. `ui/` is self-contained. Root scripts orchestrate both                                           |
| Generated TS client may not cover all endpoints perfectly          | Audit during Phase 4. Gaps can be filled with manual fetch wrappers typed against the OpenAPI spec                                             |
