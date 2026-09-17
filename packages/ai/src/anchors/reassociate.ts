import { findMarker, parseAnchorComments } from './comment-marker';
import { defaultAstAdapter, findSymbol, type AstAdapter, type SymbolIndexEntry } from './ast-verify';
import type { AnchorKind, CodeAnchor } from './anchor-model';

/**
 * 重新关联与漂移修复（T4-06 要点 4、5）。
 *
 * 两类场景，共用一套候选排序：
 * ① **锚点丢失**：代码被大改 / 文件重命名，原符号找不到 → 按
 *    「元素规范名 ↔ 代码符号」的相似度给出候选，供用户一键修复；
 * ② **行号漂移**：代码被外部修改（加了几行注释），符号还在但行号变了 →
 *    按 `symbol` + 注释标记重新定位并更新行号。
 *
 * 定位优先级（后面的是兜底，顺序不能颠倒）：
 * 注释标记（最强，写在代码里的事实）→ 完整符号名 → 容器内短名 → 名称相似度。
 * 相似度只用于**给候选**，绝不自动改锚点 —— 自动"猜"位置会把锚点指到错误的代码上，
 * 比标成 drift 更危险。
 */

/* ------------------------------ 名称相似度 ------------------------------ */

/** 编辑距离（Levenshtein，滚动数组实现） */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** 名称切词：驼峰 / 下划线 / 短横线 / 点号全部拆开并小写 */
export function tokenizeName(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 0);
}

/**
 * 名称相似度（0–1）：
 * · 归一化后完全相同 → 1
 * · 编辑距离相似 → 0.5–0.9
 * · 词集合重叠（命名投影匹配，如 `login` 与 `AuthController.login`）→ 0.3–0.8
 */
export function nameSimilarity(a: string, b: string): number {
  const normalA = a.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  const normalB = b.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  if (normalA.length === 0 || normalB.length === 0) return 0;
  if (normalA === normalB) return 1;

  const maxLength = Math.max(normalA.length, normalB.length);
  const distanceScore = 1 - editDistance(normalA, normalB) / maxLength;

  const tokensA = new Set(tokenizeName(a));
  const tokensB = new Set(tokenizeName(b));
  const intersection = [...tokensA].filter((token) => tokensB.has(token));
  const union = new Set([...tokensA, ...tokensB]);
  const jaccard = union.size === 0 ? 0 : intersection.length / union.size;

  // 词集合重叠更能反映"命名投影"（login ↔ AuthController.login），因此加权更高
  return Number(Math.max(distanceScore * 0.7, distanceScore * 0.4 + jaccard * 0.6).toFixed(4));
}

/* ------------------------------ 候选推荐 ------------------------------ */

export interface ReassociateCandidate {
  symbol: string;
  filePath: string;
  startLine: number;
  endLine: number;
  form: SymbolIndexEntry['form'];
  score: number;
  reason: string;
}

export interface FindCandidatesInput {
  /** 原锚点（可为 null：锚点丢失后只剩元素 id 与规范名） */
  anchor: Pick<CodeAnchor, 'symbol' | 'kind' | 'filePath' | 'elementId'> | null;
  /** 元素规范名（中文显示名不参与比较，这里传英文/拼音规范名） */
  elementName?: string | null;
  /** 候选文件内容：path → content */
  contents: ReadonlyMap<string, string>;
  adapter?: AstAdapter | undefined;
  limit?: number;
}

/** 按名称相似度给出候选（跨文件，含同文件内的其它符号） */
export function findCandidates(input: FindCandidatesInput): ReassociateCandidate[] {
  const adapter = input.adapter ?? defaultAstAdapter;
  const target = input.anchor?.symbol ?? input.elementName ?? '';
  if (target.length === 0) return [];

  // 目标符号的容器投影：`AuthController.login` 的容器是 `AuthController`。
  // 同容器内的改名（login → signIn）是行号漂移最常见的形态，必须排在容器类本身前面，
  // 否则用户看到的第一个候选会是"整个类"，一键修复会把锚点指到错误的位置。
  const targetContainer = target.includes('.') ? (target.split('.')[0] ?? null) : null;

  const scored: { raw: number; candidate: ReassociateCandidate }[] = [];
  for (const [path, content] of input.contents) {
    let entries: SymbolIndexEntry[];
    try {
      entries = adapter.indexSymbols({ path, content });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const elementScore =
        input.elementName !== null && input.elementName !== undefined ? nameSimilarity(input.elementName, entry.name) : 0;
      const base = Math.max(nameSimilarity(target, entry.name), elementScore);
      if (base < 0.3) continue;

      const sameFile = input.anchor !== null && input.anchor.filePath === path;
      const kindBonus = matchesKind(input.anchor?.kind, entry.form) ? 0.15 : 0;
      const fileBonus = sameFile ? 0.1 : 0;
      // 容器加成：在同一个类里（改名前后）> 候选本身就是那个容器
      const containerBonus =
        targetContainer !== null && entry.container === targetContainer
          ? 0.25
          : targetContainer !== null && entry.name === targetContainer
            ? 0.15
            : 0;

      const raw = base + kindBonus + fileBonus + containerBonus;
      scored.push({ raw, candidate: {
        symbol: entry.name,
        filePath: path,
        startLine: entry.startLine,
        endLine: entry.endLine,
        form: entry.form,
        score: 0,
        reason: describeCandidateReason({ entry, target, sameFile }),
      } });
    }
  }

  // 关键：排序必须用**未封顶**的 raw。多个候选的 raw 都可能超过 1，
  // 先封顶再排序会让「容器内改名」与「容器类本身」并列成 1，
  // 字典序兜底又把类排在前面 —— 一键修复就会把锚点指到错误位置。
  return scored
    .sort((a, b) => (b.raw === a.raw ? (a.candidate.symbol < b.candidate.symbol ? -1 : 1) : b.raw - a.raw))
    .slice(0, input.limit ?? 10)
    .map((item) => ({ ...item.candidate, score: Number(Math.min(1, item.raw).toFixed(4)) }));
}

function describeCandidateReason(input: { entry: SymbolIndexEntry; target: string; sameFile: boolean }): string {
  const similarity = nameSimilarity(input.target, input.entry.name);
  const parts = [`名称相似度 ${(similarity * 100).toFixed(0)}%`, `形态 ${input.entry.form}`];
  if (input.sameFile) parts.push('同文件');
  if (input.entry.container !== null) parts.push(`容器 ${input.entry.container}`);
  return parts.join('；');
}

function matchesKind(kind: AnchorKind | undefined, form: SymbolIndexEntry['form']): boolean {
  if (kind === undefined) return false;
  const expected: Record<AnchorKind, SymbolIndexEntry['form'][]> = {
    controller: ['class', 'function', 'method'],
    service: ['class', 'function', 'method'],
    dto: ['class', 'interface', 'variable'],
    repo: ['class', 'interface', 'function', 'method'],
    sql: ['table', 'unknown'],
    test: ['function', 'method', 'class'],
    route: ['function', 'variable', 'class', 'method'],
  };
  return expected[kind].includes(form);
}

/* ------------------------------ 重定位 ------------------------------ */

export interface RelocateInput {
  anchor: Pick<CodeAnchor, 'elementId' | 'symbol' | 'filePath' | 'kind'>;
  /** 当前文件内容 */
  content: string;
  adapter?: AstAdapter | undefined;
}export type RelocateStatus = 'ok' | 'ambiguous' | 'missing';

export interface RelocateResult {
  status: RelocateStatus;
  symbol: string | null;
  startLine: number | null;
  endLine: number | null;
  /** 定位依据（展示给用户看"凭什么认为在这个位置"） */
  reason: string;
  candidates: ReassociateCandidate[];
}

/**
 * 重新定位锚点（漂移修复的主入口）。
 */
export function relocate(input: RelocateInput): RelocateResult {
  const adapter = input.adapter ?? defaultAstAdapter;
  const entries = adapter.indexSymbols({ path: input.anchor.filePath, content: input.content });
  const contents = new Map<string, string>([[input.anchor.filePath, input.content]]);

  // ① 注释标记：写在代码里的事实，优先级最高
  const elementId = input.anchor.elementId;
  const marker = elementId === null || elementId.length === 0 ? null : findMarker(input.content, elementId);
  if (marker !== null) {
    const target = findSymbol(entries, marker.symbol) ?? null;
    if (target !== null) {
      return {
        status: 'ok',
        symbol: target.name,
        startLine: target.startLine,
        endLine: target.endLine,
        reason: `依据代码内锚点标记（第 ${marker.line} 行）重新定位`,
        candidates: [],
      };
    }
  }

  // ② 完整符号名 / 容器内短名
  const exact = findSymbol(entries, input.anchor.symbol ?? '');
  if (exact !== null) {
    return {
      status: 'ok',
      symbol: exact.name,
      startLine: exact.startLine,
      endLine: exact.endLine,
      reason: '依据符号名重新定位（行号已更新）',
      candidates: [],
    };
  }

  // ③ 相似度候选：只给建议，不自动改
  const candidates = findCandidates({
    anchor: { symbol: input.anchor.symbol, kind: input.anchor.kind, filePath: input.anchor.filePath, elementId: input.anchor.elementId },
    contents,
  });
  if (candidates.length > 0) {
    return {
      status: 'ambiguous',
      symbol: null,
      startLine: null,
      endLine: null,
      reason: `原符号在文件中找不到，但有 ${candidates.length} 个候选可供重新关联`,
      candidates,
    };
  }

  return { status: 'missing', symbol: null, startLine: null, endLine: null, reason: '文件中已不存在可关联的符号', candidates: [] };
}

/** 一个文件里所有带锚点标记的位置（批量校准用：外部改动后用它对账） */
export function listMarkedLocations(content: string, path: string, adapter?: AstAdapter): { elementId: string; symbol: string; startLine: number; endLine: number }[] {
  const indexer = adapter ?? defaultAstAdapter;
  const entries = indexer.indexSymbols({ path, content });
  const result: { elementId: string; symbol: string; startLine: number; endLine: number }[] = [];
  for (const marker of parseAnchorComments(content, path)) {
    const found = findSymbol(entries, marker.symbol);
    if (found === null) continue;
    result.push({ elementId: marker.elementId, symbol: found.name, startLine: found.startLine, endLine: found.endLine });
  }
  return result;
}
