/**
 * 出现位置索引的文本工具（行号 / 列号 / 上下文切片 / 正则转义）。
 *
 * 被 AST 解析器、文档 / 记忆 / 逻辑结构扫描器共用，保证 `file:line:col` 口径一致
 * （**行号与列号均从 1 开始**，与编辑器跳转一致）。
 */

/** 按 `\n` 切分并保留行内容（`\r` 已剥离，保证列号按字符计） */
export function splitLines(content: string): string[] {
  return content.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/** 偏移量 → 1 基行号 / 列号（逐段扫描，避免整串 O(n²)） */
export function positionOf(content: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < content.length; i += 1) {
    if (content[i] === '\n') {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

/** `file:line:col` 定位串 */
export function locate(refPath: string, line: number, column: number): string {
  return `${refPath}:${line}:${column}`;
}

/** 解析 `file:line:col` 定位串 */
export function parseLocator(locator: string): { refPath: string; line: number; column: number } | null {
  const match = /^(.*):(\d+):(\d+)$/.exec(locator);
  if (match === null) return null;
  return { refPath: match[1]!, line: Number(match[2]), column: Number(match[3]) };
}

/** ±N 行上下文（默认 ±3，PRD FR-UNI-05） */
export interface LineContext {
  startLine: number;
  before: readonly string[];
  line: string;
  after: readonly string[];
}

/** 取 `line`（1 基）前后各 `radius` 行 */
export function extractContext(lines: readonly string[], line: number, radius = 3): LineContext {
  const index = Math.max(0, line - 1);
  const start = Math.max(0, index - radius);
  const end = Math.min(lines.length, index + radius + 1);
  return {
    startLine: start + 1,
    before: lines.slice(start, index),
    line: lines[index] ?? '',
    after: lines.slice(index + 1, end),
  };
}

/** 转义正则元字符（把符号文本安全地用于正则匹配） */
export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 判断字符是否可作为标识符字符（ASCII 字母 / 数字 / `_` / `$`） */
export function isIdentifierChar(char: string | undefined): boolean {
  return char !== undefined && /[0-9A-Za-z_$]/.test(char);
}

/** 精确词匹配：`index` 处命中 `word` 且两侧不是标识符字符（`_` 也视为词内字符） */
export function matchWordAt(text: string, index: number, word: string): boolean {
  if (word.length === 0) return false;
  if (!text.startsWith(word, index)) return false;
  const before = index > 0 ? text[index - 1] : undefined;
  const after = text[index + word.length];
  if (before !== undefined && /[0-9A-Za-z_$\u4e00-\u9fff]/.test(before)) return false;
  if (after !== undefined && /[0-9A-Za-z_$\u4e00-\u9fff]/.test(after)) return false;
  return true;
}
