import { defineConfig } from 'vitest/config';
import path from 'node:path';

// 桌面端 Tauri 外壳单元测试配置。
// - 渲染层运行在 jsdom 中（WebView2 探测等会用到 document）。
// - 复用根 `vitest.setup.ts`（按需加载 jest-dom 扩展）。
// - 通过别名解析 `@ec/shell-api`，复用契约套件。
export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['../../vitest.setup.ts'],
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@ec/shell-api': path.resolve(__dirname, '../../packages/shell-api/src'),
    },
  },
});
