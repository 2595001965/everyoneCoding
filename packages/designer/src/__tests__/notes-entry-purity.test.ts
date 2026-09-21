import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * 备注子入口的依赖纯度守卫（`exports['./notes']` → `src/notes-entry.ts`）。
 *
 * 这个子入口存在的唯一理由：**外壳（Electron 主进程）**要为备注提供持久化与
 * 上下文注入，而备注的优先级 / 禁止事项 / 历史留痕规则只在领域层成立
 * （见 notes-entry.ts 的说明）。包根入口会把 NotePanel 等 React 组件带进来，
 * 主进程构建不能引。
 *
 * 判据与 `dsl-entry-purity.test.ts` 一致：从入口出发做相对 import 传递闭包，
 * 闭包内不允许出现浏览器 UI 依赖，第三方运行时依赖只允许 zod。
 */

const ENTRY = resolve(__dirname, '..', 'notes-entry.ts');

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

describe('@ec/designer 备注子入口', () => {
  const { files, bare } = closure(ENTRY);

  it('传递闭包覆盖到 note-model 与 note-repo（确认解析真的生效）', () => {
    // 解析失败会让闭包只剩入口一个文件，测试会"假绿"，故先断言规模
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(files.some((file) => file.endsWith('note-model.ts'))).toBe(true);
    expect(files.some((file) => file.endsWith('note-repo.ts'))).toBe(true);
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
