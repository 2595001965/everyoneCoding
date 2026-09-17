import { defineConfig } from 'vitest/config';

/** 渲染层单测：jsdom 环境 + RTL 清理（见根 vitest.setup.ts） */
export default defineConfig({
  test: {
    globals: false,
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['../../vitest.setup.ts'],
    testTimeout: 20000,
    restoreMocks: true,
  },
});
