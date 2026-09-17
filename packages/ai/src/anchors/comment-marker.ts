import { ANCHOR_KINDS, type AnchorKind } from './anchor-model';

/**
 * 三重锚定的第 ② 层：代码注释标记（T4-06 要点 2 / 4）。
 *
 * 形态：`// @everyonecoding:anchor <elementId> <symbol> <kind>`
 *
 * 为什么注释标记不可省：AI 声明的 anchors 与 AST 校验都依赖"模型说了什么"与
 * "解析器能不能读懂"，而注释标记是**写进产物里的事实**——即使数据库丢了、
 * 即使项目被拷到另一台机器，只要代码还在，锚点就能重新关联（`reassociate.ts` 依赖它）。
 *
 * 注释前缀按语言适配：`//`（TS/JS/Java/ArkTS）、`#`（Python/YAML/Shell）、`--`（SQL）。
 */

export interface CommentStyle {
  /** 行注释前缀 */
  line: string;
}

/** 语言/扩展名 → 注释风格 */
export const COMMENT_STYLES: Record<string, CommentStyle> = {
  ts: { line: '//' },
  tsx: { line: '//' },
  js: { line: '//' },
  jsx: { line: '//' },
  mjs: { line: '//' },
  cjs: { line: '//' },
  java: { line: '//' },
  kt: { line: '//' },
  kts: { line: '//' },
  ets: { line: '//' },
  dart: { line: '//' },
  rs: { line: '//' },
  go: { line: '//' },
  cs: { line: '//' },
  css: { line: '/*' },
  py: { line: '#' },
  rb: { line: '#' },
  yml: { line: '#' },
  yaml: { line: '#' },
  sh: { line: '#' },
  bash: { line: '#' },
  toml: { line: '#' },
  sql: { line: '--' },
  lua: { line: '--' },
  md: { line: '<!--' },
};

/** 兜底：无法识别时用 `//`（JS 生态最常见） */
export function commentPrefixFor(pathOrLanguage: string): string {
  const extension = pathOrLanguage.includes('.') ? (pathOrLanguage.split('.').pop() ?? '') : pathOrLanguage;
  return (COMMENT_STYLES[extension.toLowerCase()] ?? COMMENT_STYLES.ts)?.line ?? '//';
}

export const ANCHOR_MARKER_TAG = '@everyonecoding:anchor';

export interface AnchorMarkerRecord {
  elementId: string;
  symbol: string;
  kind: AnchorKind | null;
  /** 1-based 行号（标记所在行） */
  line: number;
}

/** 生成标记行（`symbol` 与 `kind` 可省，但强烈建议都给） */
export function buildAnchorComment(input: {
  elementId: string;
  symbol?: string | null;
  kind?: AnchorKind | null;
  pathOrLanguage: string;
}): string {
  const prefix = commentPrefixFor(input.pathOrLanguage);
  const parts = [ANCHOR_MARKER_TAG, input.elementId];
  if (input.symbol !== undefined && input.symbol !== null && input.symbol.length > 0) parts.push(input.symbol);
  if (input.kind !== undefined && input.kind !== null) parts.push(input.kind);
  return `${prefix} ${parts.join(' ')}`;
}

const MARKER_PATTERN = new RegExp(
  `${ANCHOR_MARKER_TAG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+([\\w:.-]+)(?:\\s+([\\w.$#]+))?(?:\\s+(${ANCHOR_KINDS.join('|')}))?`,
);

/** 解析文件里所有锚点标记（含 1-based 行号） */
export function parseAnchorComments(content: string, pathOrLanguage = 'ts'): AnchorMarkerRecord[] {
  void pathOrLanguage;
  const records: AnchorMarkerRecord[] = [];
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = MARKER_PATTERN.exec(lines[index] ?? '');
    if (match === null) continue;
    const elementId = match[1];
    if (elementId === undefined) continue;
    const kind = match[3] !== undefined && (ANCHOR_KINDS as readonly string[]).includes(match[3]) ? (match[3] as AnchorKind) : null;
    records.push({
      elementId,
      symbol: match[2] ?? elementId,
      kind,
      line: index + 1,
    });
  }
  return records;
}

export function findMarker(content: string, elementId: string): AnchorMarkerRecord | null {
  return parseAnchorComments(content).find((record) => record.elementId === elementId) ?? null;
}

export function hasMarker(content: string, elementId: string): boolean {
  return findMarker(content, elementId) !== null;
}

/* ------------------------------ 注入与移除 ------------------------------ */

export interface InjectTarget {
  /** 需要挂锚点的符号名（如 `AuthController.login`） */
  symbol: string;
  kind: AnchorKind;
}

/**
 * 在对应符号声明之前插入锚点标记。
 *
 * 定位策略（按语言给出声明模式）：先按最简单的「最后一段符号名」去找声明行，
 * 找到就在其上方插入；找不到则**不插入**并记入 `unmatched`，由调用方决定是否报错 ——
 * 悄悄插到文件顶部会造成"锚点指向错误位置"这种更难查的问题。
 */
export function injectAnchorComments(
  content: string,
  input: { elementId: string; symbols: readonly InjectTarget[]; pathOrLanguage: string },
): { content: string; injected: string[]; unmatched: string[] } {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const injected: string[] = [];
  const unmatched: string[] = [];
  const prefix = commentPrefixFor(input.pathOrLanguage);
  let offset = 0;

  for (const target of input.symbols) {
    const bare = target.symbol.split('.').pop() ?? target.symbol;
    const declarationIndex = lines.findIndex((line) => isDeclarationOf(line, bare));
    if (declarationIndex < 0) {
      unmatched.push(target.symbol);
      continue;
    }
    const marker = `${prefix} ${ANCHOR_MARKER_TAG} ${input.elementId} ${target.symbol} ${target.kind}`;
    lines.splice(declarationIndex + offset, 0, marker);
    offset += 1;
    injected.push(target.symbol);
  }

  return { content: lines.join(newline), injected, unmatched };
}

/** 是否是该符号的声明行（覆盖 TS/JS/Java/ArkTS/Python/Dart/Go 的常见写法） */
export function isDeclarationOf(line: string, symbol: string): boolean {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`\\b(class|interface|enum|type|struct)\\s+${escaped}\\b`),
    new RegExp(`\\b(function|func|fun)\\s+${escaped}\\s*[(<]`),
    new RegExp(`\\b(def)\\s+${escaped}\\s*\\(`),
    new RegExp(`\\b(const|let|var|final)\\s+${escaped}\\s*[=:]`),
    new RegExp(`\\bpublic\\s+[\\w<>,\\[\\]]+\\s+${escaped}\\s*\\(`),
    new RegExp(`^\\s*(async\\s+)?${escaped}\\s*\\(`),
    new RegExp(`\\bCREATE\\s+(TABLE|VIEW)\\s+${escaped}\\b`, 'i'),
  ];
  return patterns.some((pattern) => pattern.test(line));
}

/** 移除某元素的所有锚点标记（重新生成前的清理；返回移除条数） */
export function removeAnchorComments(content: string, elementId: string): { content: string; removed: number } {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const kept = lines.filter((line) => {
    const match = MARKER_PATTERN.exec(line);
    return !(match !== null && match[1] === elementId);
  });
  return { content: kept.join('\n'), removed: lines.length - kept.length };
}
