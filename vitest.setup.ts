// Vitest 全局初始化：仅在 jsdom 环境下加载 DOM 断言扩展与 RTL 清理。
// node 环境的包（shell-api / core / data）不应依赖 document。
if (typeof document !== 'undefined') {
  const { cleanup } = await import('@testing-library/react');
  const { afterEach } = await import('vitest');
  afterEach(() => {
    cleanup();
  });
  await import('@testing-library/jest-dom/vitest');
}
