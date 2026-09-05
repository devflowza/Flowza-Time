import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/**/*.db.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
