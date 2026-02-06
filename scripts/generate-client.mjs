#!/usr/bin/env node
// Generate a TypeScript client from the Gruff OpenAPI spec.
//
// Prerequisites: The dev server must be running (`npm run dev`).
//
// Usage:
//   npm run generate:client
//
// Output is written to ./test-client/ (git-ignored).
// See package.json "generate:client" script for the underlying command.

import { execSync } from 'child_process';

try {
  execSync('npm run generate:client', { stdio: 'inherit' });
} catch {
  process.exit(1);
}
