#!/usr/bin/env node
import { spawn } from 'child_process';

const args = process.argv.slice(2);
const mode = args.includes('--remote') ? 'remote' : 'local';

const DB_NAME = 'gruff-db';
const SEED_FILE = './migrations/0004_seed_data.sql';

async function runSeed() {
  console.log(`\n🌱 Loading seed data in ${mode} mode...\n`);

  try {
    await runCommand('npx', [
      'wrangler',
      'd1',
      'execute',
      DB_NAME,
      `--${mode}`,
      `--file=${SEED_FILE}`
    ]);

    console.log('\n✅ Seed data loaded successfully!\n');
  } catch (error) {
    console.error('\n❌ Seed failed:', error.message);
    process.exit(1);
  }
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: 'inherit',
      shell: true
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

// Run seed
runSeed();
