---
allowed-tools: Bash(npm test:*), Bash(npm run test:*), Bash(npm run lint:*), Bash(npm run format:*), Bash(npm run dev:*), Bash(tsc:*), Bash(npm install:*), Bash(git add:*), Bash(git status:*), Bash(git diff:*), Bash(git commit:*), Bash(git log:*), Bash(git push:*), Read(*), Write(*), Edit(*)
description: Cleans up code hygiene issues
---

Your job is to check for TS type errors and eslint errors and make sure these are fixed, and to fix unit and integration tests.

You don't have to fix all of them, but just try to make some substantial progress.

Pay careful attention to test output - there may be error messages even though the test doesn't fail. Challenge these: do they indicate an underlying problem? Is the error message expected for that test? Investigate thoroughly and fix as appropriate.

Useful commands include:

- `tsc` to check TS types
- `npm run lint` for lint errors
- `npm run test:unit` for unit tests
- `npm run test` for integration tests

Refer to the `PRODUCT_SPEC.md` if you need to decide whether to fix the code or the tests.

When you are happy with your progress towards our goal of lint-free, type-correct code that passes tests, commit your changes to this git repo.

## What to do if there's nothing to do!

**IMPORTANT**: If there is no remaining work to implement, output the following exact string, and quit:

NO_REMAINING_WORK
