---
allowed-tools: Bash(npm format:*), Bash(npm test:*), Bash(npm run test:*), Bash(npm run lint:*), Bash(npm run format:*), Bash(npm run dev:*), Bash(npx tsc:*), Bash(npm install:*), Bash(git add:*), Bash(git status:*), Bash(git diff:*), Bash(git commit:*), Bash(git log:*), Bash(git push:*), Read(*), Write(*), Edit(*)
description: Carries out development according to the specification
---

You are going to choose what to work on from `PRODUCT_SPEC.md`. Identify the outstanding work by searching for the 🟦 marker, and choose whichever such feature seems the most appropriate next step. You must choose only ONE feature.

Having chosen a feature to implement, you should read around related areas of the spec to make sure you understand the context.

- Implement that feature,
- Be sure to test the functionality against the real local dev server (see below),
- Update its entry in the specification to have the ✅ marker,
- Commit the changes to this git repository with a short, snappy description of the feature.

If you determine that the feature is already implemented, just update it to have the ✅ marker.

## Testing

In addition, to preserve the robustness of the product, refer to `TESTING.md`. Extend the tests to cover your newly implemented feature. You **MUST** run the tests and address any discrepancies:

- To run the unit tests: `npm test:unit`
- To run the integration tests: `npm test`

## Hygiene

You **MUST** check for TS type errors (`npx tsc`) and lint errors (`npm run lint`) and make sure these are fixed.

You **MUST** run `npm run format:check` to ensure the code is correctly formatted with prettier, or just run `npm run format` to reformat it. This is essentially because the CI pipeline runs the check, so a commit that is not formatted correctly is entirely invalid.

## Fix Broken Windows!

Be a good engineer: if you spot a broken test, even if it's not in the area you're working on and you suspect it was already broken before you started work, **investigate and fix it**. Leave the codebase in a better state than you found it, so the next engineer (which may be you!) doesn't have to waste time stepping over the accumulating mess.

Pay careful attention to test output - there may be error messages even though the test doesn't fail. Challenge these: do they indicate an underlying problem? Is the error message expected for that test? Investigate thoroughly and fix as appropriate, being guided by `PRODUCT_SPEC.md`.

## What to do if there's nothing to do!

**IMPORTANT**: If there is no remaining work to implement, output the following exact string, and quit:

NO_REMAINING_WORK
