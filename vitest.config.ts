import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
      },
    },
    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/**',
        'dist/**',
        'test/**',
        'test-runner.js',
        '**/*.config.ts',
        '**/*.d.ts',
      ],
    },
    // Test file patterns
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
