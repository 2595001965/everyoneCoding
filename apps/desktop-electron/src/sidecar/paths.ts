import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { resolveMigrationsDir } from '../main/domain/db';

// esbuild 的 CJS 产物里 `__dirname` 是原生注入的全局；纯 ESM（vitest）下未定义，
// 故按"可能不存在"处理（与 `main/domain/db.ts` 同一策略）。
declare const __dirname: string | undefined;

/**
 * 侧车运行时需要的外部资源定位。
 *
 * 侧车产物是 `dist/sidecar/everyone-coding-sidecar.cjs`，而要跑起来还差一件外部资源：
 * **SQLite 迁移目录**（`packages/data/migrations`，含 `0001_init.sql` …）。
 * 它在仓库里是源码，不是 bundle 的一部分，所以必须显式定位。
 *
 * 探测顺序（命中即用，任一情形都不写死层级）：
 *
 * 1. `EC_SIDECAR_MIGRATIONS_DIR` —— 显式覆盖（打包 / 测试注入）；
 * 2. `<bundle 所在目录>/migrations` —— 打包时由 `scripts/build-sidecar.mjs` 复制到此处，
 *    使产物**自包含**（不再依赖仓库目录结构）；
 * 3. `main/domain/db.ts` 的逐级上溯探测 —— 开发期直接跑产物时的常态。
 *
 * 三者都失败时抛错并**指名缺的是哪一步**：侧车起不来最常见的原因是迁移目录没跟着分发，
 * 报一句笼统的"找不到目录"会让人去查 SQLite 版本，白白绕远。
 */
export function resolveSidecarMigrationsDir(): string {
  const override = process.env['EC_SIDECAR_MIGRATIONS_DIR'];
  if (override !== undefined && override.length > 0) {
    if (!existsSync(join(override, '0001_init.sql'))) {
      throw new Error(`EC_SIDECAR_MIGRATIONS_DIR 下没有 0001_init.sql：${override}`);
    }
    return override;
  }

  const starts: string[] = [];
  if (typeof __dirname === 'string') starts.push(__dirname);
  starts.push(process.cwd());
  for (const start of starts) {
    const candidate = join(start, 'migrations');
    if (existsSync(join(candidate, '0001_init.sql'))) return candidate;
  }

  return resolveMigrationsDir();
}
