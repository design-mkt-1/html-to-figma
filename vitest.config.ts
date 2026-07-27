import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // The end-to-end tests inject the built capture bundle into a real browser,
    // so a stale bundle silently tests the previous revision. Rebuilding in
    // global setup makes that impossible, however vitest is invoked.
    globalSetup: ['./test/build-capture.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
