#!/usr/bin/env node
import { readdir } from 'fs/promises';
import { join } from 'path';
import { spawn } from 'child_process';

const args = process.argv.slice(2);
const mode = args.includes('--remote') ? 'remote' : 'local';
const includeSeed = args.includes('--seed');

const MIGRATIONS_DIR = './migrations';
const DB_NAME = 'gruff-db';

// Migration files to exclude (seed data, etc.)
const EXCLUDE_FILES = ['0004_seed_data.sql'];

async function runMigrations() {
  console.log(`\n🔄 Running migrations in ${mode} mode...\n`);

  try {
    // Read all .sql files from migrations directory
    const files = await readdir(MIGRATIONS_DIR);

    // Filter and sort migration files
    const migrationFiles = files
      .filter(f => f.endsWith('.sql'))
      .filter(f => !EXCLUDE_FILES.includes(f))
      .sort(); // Alphabetical sort works because files are numbered 0001, 0002, etc.

    if (migrationFiles.length === 0) {
      console.log('⚠️  No migration files found');
      return;
    }

    console.log(`📋 Found ${migrationFiles.length} migration(s):\n`);
    migrationFiles.forEach((f, i) => {
      console.log(`   ${i + 1}. ${f}`);
    });
    console.log('');

    // Run each migration
    for (const file of migrationFiles) {
      const filePath = join(MIGRATIONS_DIR, file);
      console.log(`⚙️  Running: ${file}`);

      await runCommand('npx', [
        'wrangler',
        'd1',
        'execute',
        DB_NAME,
        `--${mode}`,
        `--file=${filePath}`,
      ]);
    }

    console.log('\n✅ All migrations completed successfully!\n');

    // Run seed data if requested
    if (includeSeed) {
      console.log('🌱 Running seed data...\n');
      await runCommand('npx', [
        'wrangler',
        'd1',
        'execute',
        DB_NAME,
        `--${mode}`,
        '--file=./migrations/0004_seed_data.sql',
      ]);
      console.log('\n✅ Seed data loaded successfully!\n');
    }
  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    process.exit(1);
  }
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: 'inherit',
      shell: true,
    });

    proc.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });

    proc.on('error', reject);
  });
}

// Run migrations
runMigrations();
