import { defineConfig } from 'vitest/config';

/**
 * 根级 Vitest 配置：用于从仓库根目录一次性跑全部包的测试。
 * 各包也可独立运行 `vitest run`（UI 与渲染层包自带 jsdom 配置）。
 */
export default defineConfig({
  test: {
    globals: false,
    include: ['{packages,apps}/*/src/**/*.test.{ts,tsx}'],
    environment: 'node',
    environmentMatchGlobs: [
      ['packages/ui/**', 'jsdom'],
      ['packages/designer/**', 'jsdom'],
      ['apps/renderer/**', 'jsdom'],
      ['apps/desktop-*/**', 'jsdom'],
      ['packages/ui/src/**/*.test.{ts,tsx}', 'jsdom'],
      ['apps/renderer/src/**/*.test.{ts,tsx}', 'jsdom'],
    ],
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 15000,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: ['packages/*/src/**', 'apps/*/src/**'],
      exclude: ['**/__tests__/**', '**/*.test.*', '**/index.ts'],
      // T10-03 质量门禁：六个核心模块行覆盖率 ≥70%（CI 的 quality-gate job 单独跑，
      // 全量并行时 V8 覆盖不聚合，因此阈值配置在 ci/vitest.coverage.config.ts）
    },
  },
});
