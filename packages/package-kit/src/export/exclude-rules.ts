/**
 * 导出排除规则（T8-02 / FR-PKG-06）。
 *
 * 默认排除工程里"体积大但与可迁移知识无关"的产物：依赖目录、构建输出、
 * 版本控制元数据、缓存与日志。项目级 `.ecignore`（gitignore 语法子集）可追加规则。
 *
 * 匹配语义对齐 gitignore 子集：
 * - 行首 `#` 注释、空行忽略；
 * - `*` 匹配段内任意字符（不含 `/`）；`?` 匹配单个非 `/` 字符；
 * - `**` 作为完整段时跨越任意层级目录；
 * - 行首 `/` 锚定到工程（代码）根；
 * - 末尾 `/` 表示目录规则：命中该目录及其全部后代；
 * - 其余含 `/` 的模式按相对位置匹配（可出现在任意子目录）。
 */

import type { ExcludeRule, ExcludeStats } from './export-types';

/** 默认排除规则（builtin=true），覆盖主流依赖/构建/缓存目录 */
export const DEFAULT_EXCLUDE_RULES: readonly ExcludeRule[] = [
  { pattern: 'node_modules/**', builtin: true },
  { pattern: 'dist/**', builtin: true },
  { pattern: 'target/**', builtin: true },
  { pattern: 'build/**', builtin: true },
  { pattern: '.git/**', builtin: true },
  { pattern: 'coverage/**', builtin: true },
  { pattern: '.cache/**', builtin: true },
  { pattern: 'tmp/**', builtin: true },
  { pattern: '*.log', builtin: true },
  { pattern: '.DS_Store', builtin: true },
] as const;

/** 候选文件（排除统计用）：包内相对路径 + 字节数 */
export interface ExcludeCandidate {
  /** 相对工程根的路径（如 `src/app.ts`、`node_modules/a.js`） */
  path: string;
  bytes: number;
}

const REGEX_CACHE = new Map<string, RegExp>();

/** 把单条 gitignore 风格 pattern 编译为正则（带缓存，避免大批量匹配重复编译） */
export function compilePattern(pattern: string): RegExp {
  const cached = REGEX_CACHE.get(pattern);
  if (cached !== undefined) return cached;

  let raw = pattern.trim();
  if (raw === '' || raw.startsWith('#')) {
    // 注释 / 空行：永不命中（用一个不可能匹配任何非空串的正则）
    const never = /$^/;
    REGEX_CACHE.set(pattern, never);
    return never;
  }

  if (raw.endsWith('/')) raw = raw.slice(0, -1);

  const anchored = raw.startsWith('/');
  if (anchored) raw = raw.slice(1);

  const segments = raw.split('/');
  let re = anchored ? '^' : '^(?:.*\\/)?';

  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]!;
    if (seg === '') continue;
    if (seg === '**') {
      // 跨任意层级目录（零个或多个 ` /段`）
      re += '(?:\\/[^/]+)*';
    } else {
      re += globSegmentToRegex(seg);
    }
    // `**` 自带 `/` 处理，其后不补分隔符（避免双重 `/`）
    const nextIsGlobstar = i + 1 < segments.length && segments[i + 1] === '**';
    if (i < segments.length - 1 && !nextIsGlobstar) re += '\\/';
  }

  // 命中该目录 / 文件本身及其全部后代（gitignore：无 `/` 的模式同时匹配文件与目录）
  re += '(?:\\/.*)?$';

  const compiled = new RegExp(re);
  REGEX_CACHE.set(pattern, compiled);
  return compiled;
}

/** 把单个路径段里的 glob 字符转换为正则（不含 `/`） */
function globSegmentToRegex(segment: string): string {
  let out = '';
  let i = 0;
  while (i < segment.length) {
    const ch = segment[i]!;
    if (ch === '*') {
      // 段内 `*` 视为 `**` 的同义（段内不跨 `/`）
      out += '[^/]*';
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('\\.+*()|[]{}^$'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
    i += 1;
  }
  return out;
}

/** 解析 .ecignore 文本为规则列表（忽略注释 / 空行 / 取反 `!` 行） */
export function parseEcignore(text: string | null): ExcludeRule[] {
  if (text === null) return [];
  const rules: ExcludeRule[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('!')) continue; // 子集不支持取反，忽略
    rules.push({ pattern: line, builtin: false });
  }
  return rules;
}

/** 路径是否被任意规则命中（命中第一条即返回） */
export function matchExclude(pkgPath: string, rules: readonly ExcludeRule[]): boolean {
  for (const rule of rules) {
    if (compilePattern(rule.pattern).test(pkgPath)) return true;
  }
  return false;
}

/** 返回命中 pkgPath 的第一条规则（无则 null） */
function firstMatchingRule(pkgPath: string, rules: readonly ExcludeRule[]): ExcludeRule | null {
  for (const rule of rules) {
    if (compilePattern(rule.pattern).test(pkgPath)) return rule;
  }
  return null;
}

/**
 * 计算排除统计：遍历候选集，命中即计入 excluded，并分规则累加命中数。
 * reductionRatio = excludedBytes / totalBytes（0–1）。
 */
export function computeExcludeStats(
  candidates: readonly ExcludeCandidate[],
  rules: readonly ExcludeRule[],
): ExcludeStats {
  const hits = new Map<string, { files: number; bytes: number }>();
  let excludedFiles = 0;
  let excludedBytes = 0;
  let totalFiles = 0;
  let totalBytes = 0;

  for (const candidate of candidates) {
    totalFiles += 1;
    totalBytes += candidate.bytes;
    const hitRule = firstMatchingRule(candidate.path, rules);
    if (hitRule !== null) {
      excludedFiles += 1;
      excludedBytes += candidate.bytes;
      const prev = hits.get(hitRule.pattern) ?? { files: 0, bytes: 0 };
      prev.files += 1;
      prev.bytes += candidate.bytes;
      hits.set(hitRule.pattern, prev);
    }
  }

  const reductionRatio = totalBytes > 0 ? excludedBytes / totalBytes : 0;

  return {
    excludedFiles,
    excludedBytes,
    totalFiles,
    totalBytes,
    reductionRatio,
    hitsByPattern: [...hits.entries()].map(([pattern, value]) => ({
      pattern,
      files: value.files,
      bytes: value.bytes,
    })),
  };
}
