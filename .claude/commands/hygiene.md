---
allowed-tools: Bash(npm test:*), Bash(npm run test:*), Bash(npm run lint:*), Bash(npm run format:*), Bash(npm run dev:*), Bash(tsc:*), Bash(npm install:*), Bash(git add:*), Bash(git status:*), Bash(git diff:*), Bash(git commit:*), Bash(git log:*), Bash(git push:*), Read(*), Write(*), Edit(*)
description: Cleans up code hygiene issues
---

Your job is to check for TS type errors and eslint errors and make sure these are fixed.

You don't have to fix all of them, but just try to make some substantial progress.

Useful commands include:

- tsc
- npm run lint

When you are happy with your progress towards our goal of lint-free, type-correct code, commit your changes to this git repo.

## What to do if there's nothing to do!

**IMPORTANT**: If there is no remaining work to implement, output the following exact string, and quit:

NO_REMAINING_WORK
