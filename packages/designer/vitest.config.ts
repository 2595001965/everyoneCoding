import { defineConfig } from 'vitest/config';

/**
 * 设计器包测试配置：画布 / 属性面板 / 图层树等均为 DOM 组件，统一走 jsdom。
 * setupFiles 与 @ec/ui 一致，路径相对本配置文件解析。
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['../../vitest.setup.ts'],
    testTimeout: 15000,
    restoreMocks: true,
    css: false,
  },
});
