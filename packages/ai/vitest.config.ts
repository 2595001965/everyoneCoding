import { defineConfig } from 'vitest/config';

/** @ec/ai 单测：node 环境（涉及 SQLite 与真实 HTTP） */
export default defineConfig({
  test: {
    globals: false,
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
    restoreMocks: true,
  },
});
