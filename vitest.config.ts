import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
      },
    },
    // Coverage configuration
    // NOTE: Coverage with v8 provider is not compatible with @cloudflare/vitest-pool-workers
    // due to node:inspector dependency. Coverage can potentially work with other test pools
    // or by using istanbul provider, but is disabled in CI for now.
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
