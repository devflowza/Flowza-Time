import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['src/**/*.test.ts'], environment: 'node', passWithNoTests: true, fileParallelism: false, testTimeout: 60_000, hookTimeout: 120_000 } });
