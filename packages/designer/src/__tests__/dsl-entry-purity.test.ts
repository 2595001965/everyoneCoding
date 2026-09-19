import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * 纯 DSL 子入口的依赖纯度守卫（`exports['./dsl']` → `src/dsl-entry.ts`）。
 *
 * 这个子入口存在的唯一理由：**主进程**在「按模板新建项目」时要产出初始页面 DSL，
 * 而包根入口会把 React / dnd-kit / zustand 拉进主进程构建。
 * 一旦有人往 `dsl/` 或 `shared/{expression,condition}` 里引入浏览器依赖，
 * 这条纪律就会静默失效（类型检查与单测都不会红），所以必须由本测试盯住。
 *
 * 判据：从 `dsl-entry.ts` 出发按**相对路径 import** 做传递闭包，
 * 闭包内任何文件都不允许出现被禁的裸包名。
 */

const ENTRY = resolve(__dirname, '..', 'dsl-entry.ts');

/** 禁止出现的运行时依赖（type-only import 会被编译期擦除，但仍统一禁掉，避免误判） */
const BANNED = [
  'react',
  'react-dom',
  '@dnd-kit/core',
  '@dnd-kit/sortable',
  '@dnd-kit/modifiers',
  '@dnd-kit/utilities',
  'zustand',
  '@ec/ui',
  'immer',
];

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+'([^']+)'/g;

function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const specifiers: string[] = [];
  for (const match of text.matchAll(IMPORT_RE)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

/** 解析相对 import 到实际文件（本仓库只写 `.ts` 后缀的显式路径） */
function resolveRelative(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      /* 继续试下一个 */
    }
  }
  return null;
}

function closure(entry: string): { files: string[]; bare: string[] } {
  const files = new Set<string>([entry]);
  const bare = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) break;
    for (const specifier of importsOf(current)) {
      const target = resolveRelative(current, specifier);
      if (target !== null) {
        if (!files.has(target)) {
          files.add(target);
          queue.push(target);
        }
      } else if (!specifier.startsWith('node:')) {
        // 只保留包名（`zod`、`@scope/pkg/sub` → `@scope/pkg`）
        const parts = specifier.split('/');
        const pkg = specifier.startsWith('@')
          ? parts.slice(0, 2).join('/')
          : (parts[0] ?? specifier);
        bare.add(pkg);
      }
    }
  }
  return { files: [...files], bare: [...bare] };
}

describe('@ec/designer 纯 DSL 子入口', () => {
  const { files, bare } = closure(ENTRY);

  it('传递闭包覆盖到 dsl 与 shared 的多个文件（确认解析真的生效）', () => {
    // 解析失败会让闭包只剩入口一个文件，测试会"假绿"，故先断言规模
    expect(files.length).toBeGreaterThanOrEqual(8);
    expect(files.some((file) => file.endsWith('factory.ts'))).toBe(true);
    expect(files.some((file) => file.endsWith('serialize.ts'))).toBe(true);
  });

  it('闭包内不出现浏览器 UI 依赖', () => {
    for (const banned of BANNED) {
      expect(bare, `子入口闭包引入了 ${banned}`).not.toContain(banned);
    }
  });

  it('闭包内只允许 zod 这一个第三方运行时依赖', () => {
    expect(bare.filter((pkg) => !pkg.startsWith('@ec/'))).toEqual(['zod']);
  });
});
