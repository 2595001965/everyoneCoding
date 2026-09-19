import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `@ec/designer/dsl` 子入口的**纯度守卫**。
 *
 * 背景：`exports['./dsl']` 的存在意义是让**主进程**（Electron / Tauri）也能产出初始页面 DSL，
 * 而包根入口会把 React / dnd-kit / zustand 等浏览器 UI 依赖一并拉进来。
 * 因此这个入口是"主进程可用"的承诺——一旦有人往里加了一个引 UI 的模块，
 * 主进程构建就会被打进一堆死代码甚至直接失败，而且**没有任何类型错误**能提前发现。
 *
 * 本测试的判据（与 dsl-entry.ts 头注释的维护约束一致）：
 * 1. 入口 re-export 的每个模块，其自身与（递归）本地依赖都不得引 UI 依赖或 Node 内置模块；
 * 2. 依赖闭包必须落在 `src/dsl/**` 与 `src/shared/**` 之内（防止"绕道"引回 UI 层）。
 *
 * 注意要先剥注释再扫描：注释里出现 "react" 字样（比如本文件）会自命中。
 */

const designerSrc = join(__dirname, '..', '..');
const entryFile = join(designerSrc, 'dsl-entry.ts');

/** 禁止进入主进程依赖闭包的模块前缀（UI 依赖与 Node 内置模块） */
const FORBIDDEN_PREFIXES = [
  'react',
  'react-dom',
  '@dnd-kit/',
  'zustand',
  '@ec/ui',
  'node:',
  'fs',
  'path',
  'crypto',
] as const;

/** 剥掉块注释与行注释，避免文档文字自命中 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 收集一个模块文件的全部 import 描述符（只看静态 import / export from） */
function collectImports(file: string): string[] {
  const source = stripComments(readFileSync(file, 'utf8'));
  const specs: string[] = [];
  const pattern = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const specifier = match[1];
    if (specifier) specs.push(specifier);
  }
  // `import 'x'`（副作用导入）没有 from 子句，单独抓
  const sideEffect = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
  while ((match = sideEffect.exec(source)) !== null) {
    const specifier = match[1];
    if (specifier) specs.push(specifier);
  }
  return specs;
}

/** 把相对描述符解析成绝对文件路径；非相对（包名）原样返回 null */
function resolveLocal(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const withoutExt = specifier.replace(/\.js$/, '');
  const candidates = [
    join(dirname(fromFile), `${withoutExt}.ts`),
    join(dirname(fromFile), withoutExt, 'index.ts'),
  ];
  return candidates.find((candidate) => {
    try {
      return readFileSync(candidate, 'utf8').length >= 0;
    } catch {
      return false;
    }
  }) ?? null;
}

/** 从入口出发做依赖闭包遍历，返回 { 模块文件 → 该文件的 import 描述符 } */
function closure(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    const specs = collectImports(file);
    seen.set(file, specs);
    for (const spec of specs) {
      const local = resolveLocal(file, spec);
      if (local !== null && !seen.has(local)) queue.push(local);
    }
  }
  return seen;
}

describe('@ec/designer/dsl 子入口纯度', () => {
  const files = closure(entryFile);

  it('入口确实存在且 re-export 了 dsl 模块', () => {
    const source = stripComments(readFileSync(entryFile, 'utf8'));
    expect(source).toContain("./dsl/types");
    expect(source).toContain("./dsl/factory");
    expect(source).toContain("./dsl/serialize");
  });

  it('依赖闭包不引 UI 依赖与 Node 内置模块', () => {
    const offenders: string[] = [];
    for (const [file, specs] of files) {
      for (const spec of specs) {
        if (FORBIDDEN_PREFIXES.some((prefix) => spec === prefix || spec.startsWith(`${prefix}/`))) {
          offenders.push(`${file} → ${spec}`);
        }
      }
    }
    expect(offenders, `以下 import 会把 UI/Node 依赖带进主进程：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('依赖闭包只落在入口文件与 dsl/、shared/ 之内', () => {
    const outside = [...files.keys()].filter((file) => {
      const normalized = file.replace(/\\/g, '/');
      // 入口文件本身当然在闭包里
      if (normalized.endsWith('/src/dsl-entry.ts')) return false;
      return !normalized.includes('/src/dsl/') && !normalized.includes('/src/shared/');
    });
    expect(outside, `以下文件不应被 DSL 子入口传递依赖：\n${outside.join('\n')}`).toEqual([]);
  });

  it('闭包非空（否则测试在自欺）', () => {
    expect(files.size).toBeGreaterThan(1);
  });
});
