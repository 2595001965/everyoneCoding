import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    // Git 集成用例在本机真实起git 进程（init → commit → merge → push），
    // 叠加杀软扫描时单例可达80s+，故不放 15s 默认预算。
    testTimeout: 180000,
    restoreMocks: true,
  },
});
