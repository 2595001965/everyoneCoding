import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * E2E 验收用例（T10-05 / PRD §10.1）独立配置。
 *
 * 为什么单独一份配置：
 * - 根 vitest.config.ts 的 include 只覆盖 packages 与 apps 的 src 目录，e2e/ 不在其中；
 * - e2e/ 不在 pnpm workspace 内（没有自己的 node_modules），因此 `@ec/*` 必须显式 alias；
 * - alias 一律指向各包的**默认入口** `src/index.ts`（等价于 Node 侧解析结果），
 *   与各包既有测试保持一致；渲染层专属的 browser 条件入口只在 vite build 里需要。
 *
 * 运行：`pnpm test:e2e`（等价于 `vitest run -c e2e/vitest.config.ts`）。
 */
const here = fileURLToPath(new URL('.', import.meta.url));
const pkg = (name: string): string => resolve(here, `../packages/${name}/src/index.ts`);

export default defineConfig({
  // 作用域必须锁在 e2e/：不设 root 时 vitest 以 process.cwd()（仓库根）为 root，
  // include 会扫到全仓 200+ 个测试文件（且它们不在本配置的 jsdom 分流下，会批量假红）。
  root: here,
  resolve: {
    alias: {
      // 顺序敏感：@ec/ui 的 CSS 子路径必须排在 @ec/ui 之前（alias 按前缀匹配）
      '@ec/ui/tokens.css': resolve(here, '../packages/ui/src/tokens.css'),
      '@ec/ui/styles.css': resolve(here, '../packages/ui/src/styles.css'),
      '@ec/shell-api': pkg('shell-api'),
      '@ec/core': pkg('core'),
      '@ec/ui': pkg('ui'),
      '@ec/data': pkg('data'),
      '@ec/ai': pkg('ai'),
      '@ec/memory': pkg('memory'),
      '@ec/designer': pkg('designer'),
      '@ec/pipeline': pkg('pipeline'),
      '@ec/git': pkg('git'),
      '@ec/preview': pkg('preview'),
      '@ec/registry': pkg('registry'),
      '@ec/package-kit': pkg('package-kit'),
      '@ec/account': pkg('account'),
      // 渲染层源码（整链路用例直接驱动真实特性组件）
      '@renderer': resolve(here, '../apps/renderer/src'),
    },
  },
  test: {
    globals: false,
    include: ['**/*.test.{ts,tsx}'],
    environment: 'node',
    // 需要 DOM 的整链路用例放 ui/ 子目录
    environmentMatchGlobs: [['ui/**', 'jsdom']],
    setupFiles: [resolve(here, '../vitest.setup.ts')],
    // E2E 用例含真实子进程（git）与真实 HTTP，放宽超时；单条用例另有更细的超时
    testTimeout: 60_000,
    hookTimeout: 60_000,
    restoreMocks: true,
  },
});
