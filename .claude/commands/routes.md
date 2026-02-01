---
allowed-tools: Bash(npm test:*), Bash(npm run test:*), Bash(npm run lint:*), Bash(npm run format:*), Bash(npm run dev:*), Bash(tsc:*), Bash(npm install:*), Bash(git add:*), Bash(git status:*), Bash(git diff:*), Bash(git commit:*), Bash(git log:*), Bash(git push:*), Read(*), Write(*), Edit(*)
description: Cleans up code hygiene issues
---

You are going to look at `ROUTE_CHECKLIST.md` and choose one of the routes that isn't already checked:

- [✅] (checked)
- [ ] (unchecked)

For your chosen route, examine its implementation and ensure that it correctly implements authorisation checks. Every route that deals with entities or links must allow/deny access to data or operations according to the access control lists for entities and links, as described in the `PRODUCT_SPEC.md`.

Also make sure that the route is documented correctly in the `PRODUCT_SPEC.md`.

When you've made any code changes, run tests and code cleanness checks:

- `tsc` to check TS types
- `npm run lint` for lint errors
- `npm run test:unit` for unit tests
- `npm run test` for integration tests

Pay careful attention to test output - there may be error messages even though the test doesn't fail. Challenge these: do they indicate an underlying problem? Is the error message expected for that test? Investigate thoroughly and fix as appropriate.

Refer to the `PRODUCT_SPEC.md` if you need to decide whether to fix the code or the tests.

When finished with your chosen route, check its item in the check list, like this:

- [✅]

and commit your changes to this git repo.

## What to do if there's nothing to do!

**IMPORTANT**: If there is no remaining work to implement, output the following exact string, and quit:

NO_REMAINING_WORK
