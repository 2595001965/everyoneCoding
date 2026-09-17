import { defineConfig } from 'vitest/config';

/**
 * 账号服务端测试配置：使用 node 环境，通过 app.inject() 运行（不占用端口）。
 * 测试结果同时可被仓库根 vitest 一并触发。
 */
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 15000,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
    },
  },
});
