import { defineConfig } from 'vitest/config';

/**
 * T10-03 质量门禁专用配置：六个核心模块分别跑、分别设阈值（行覆盖 ≥70%）。
 *
 * 为什么单独一份配置：全仓并行跑时 V8 覆盖率不跨 worker 聚合，per-package 单跑
 * 才能得到真实的分母。CI 的 quality-gate job 用本配置；阈值不达标 = 命令失败。
 *
 * 用法：vitest run --config ci/vitest.coverage.config.ts packages/memory
 */

export default defineConfig({
  test: {
    globals: false,
    include: ['{packages,apps}/*/src/**/*.test.{ts,tsx}'],
    environment: 'node',
    environmentMatchGlobs: [
      ['packages/ui/**', 'jsdom'],
      ['packages/designer/**', 'jsdom'],
    ],
    testTimeout: 15_000,
    restoreMocks: true,
  },
  coverage: {
    enabled: true,
    provider: 'v8',
    reportsDirectory: 'coverage/quality-gate',
    reporter: ['text', 'json-summary'],
    // 阈值由 ci/quality-gate.mts 逐模块校验（不同模块不同 include），这里只出报告
  },
});
