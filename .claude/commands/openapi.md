---
allowed-tools: Bash(npm format:*), Bash(npm test:*), Bash(npm run test:*), Bash(npm run lint:*), Bash(npm run format:*), Bash(npm run dev:*), Bash(npx tsc:*), Bash(npm install:*), Bash(git add:*), Bash(git status:*), Bash(git diff:*), Bash(git commit:*), Bash(git log:*), Bash(git push:*), Read(*), Write(*), Edit(*)
description: Carries out development according to the specification
---

You are going to help with a project, carrying out one step from it. You will take the next unchecked task (just one task) from `OPENAPI_REFACTOR_PLAN.md` and complete it.

## Background

**Overall Goal:** Replace manually maintained OpenAPI spec (2,624 lines in `src/openapi/spec.ts`) with auto-generated spec from `@hono/zod-openapi`.

**Why:** Currently, API documentation and validation schemas are separate. Changes require updating both places with no static checking. This causes drift and maintenance burden.

**Approach:** Convert routes to use `OpenAPIHono` + `createRoute()` so Zod schemas generate OpenAPI docs automatically.

## Testing

- To run the unit tests: `npm test:unit`
- To run the integration tests: `npm test`

## Hygiene

You **MUST** check for TS type errors (`npx tsc`) and lint errors (`npm run lint`) and make sure these are fixed.

You **MUST** run `npm run format:check` to ensure the code is correctly formatted with prettier, or just run `npm run format` to reformat it. This is essentially because the CI pipeline runs the check, so a commit that is not formatted correctly is entirely invalid.

## Fix Broken Windows!

Be a good engineer: if you spot a broken test, even if it's not in the area you're working on and you suspect it was already broken before you started work, **investigate and fix it**. Leave the codebase in a better state than you found it, so the next engineer (which may be you!) doesn't have to waste time stepping over the accumulating mess.

Pay careful attention to test output - there may be error messages even though the test doesn't fail. Challenge these: do they indicate an underlying problem? Is the error message expected for that test? Investigate thoroughly and fix as appropriate, being guided by `PRODUCT_SPEC.md`.

## Follow this approach exactly:

### 1. Pick ONE unchecked endpoint

Find a `[ ]` item from the `OPENAPI_REFACTOR_PLAN.md` checklist. Work top to bottom.

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
          schema: createTypeSchema, // Zod schema with .openapi() annotations
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Type created',
      content: {
        'application/json': {
          schema: z.object({
            success: z.literal(true),
            data: TypeSchema,
            timestamp: z.string(),
          }),
        },
      },
    },
    400: {
      /* ... */
    },
    401: {
      /* ... */
    },
  },
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

### 7. Check off the item

For your item, change `[ ]` to `[x]` in the `OPENAPI_REFACTOR_PLAN.md` file.

### 8. Commit

```bash
git add .
git commit -m "OpenAPI: Convert [endpoint description]"
```

## Resources

**Read these files for guidance:**

- **Code patterns:** `docs/HONO_OPENAPI_REFERENCE.md` - How to use OpenAPIHono, createRoute(), .openapi() annotations
- **Current spec:** `docs/openapi-baseline.json` - Baseline for comparison (4,145 lines)
- **Existing schemas:** `src/schemas/*.ts` - Zod schemas that need .openapi() annotations
- **Existing routes:** `src/routes/*.ts` - Route handlers to convert

## What to do if there's nothing to do!

**IMPORTANT**: If there is no remaining work to implement, output the following exact string, and quit:

NO_REMAINING_WORK
