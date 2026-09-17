/**
 * 记忆扫描器（T7-02 要点 3，FR-UNI-08）。
 *
 * 扫描五层记忆中对某个名称的提及，两路并行：
 * - **structured**（逻辑结构 JSON）：**精确匹配 confidence 1.0**，locator 精确到 JSON 路径，
 *   高置信自动改；
 * - **content**（正文）：语义匹配，置信度按 `semantic.mentionConfidence`，<0.8 的列为
 *   "记忆提及候选"，由用户在记忆中心逐条采纳 / 忽略。
 *
 * 输入为**结构化镜像**（`MemorySource`），由外壳从 `@ec/memory` 适配；
 * 注册表包不依赖 `@ec/memory`（避免把 `@ec/data` → better-sqlite3 拖进浏览器构建）。
 *
 * 作用范围（FR-UNI-13 / D-07）：只扫描**当前项目**传入的记忆条目，绝不跨项目检索。
 */

import type { ProjectionKind } from '../naming/presets';
import { PROJECTION_KINDS } from '../naming/presets';
import { mentionConfidence } from './semantic';
import type { MemorySource } from './types';

/** 一条记忆命中 */
export interface MemoryHit {
  /** 记忆条目 id */
  refPath: string;
  /** `条目id + 字段名`（PRD §6.2 occurrence.locator） */
  locator: string;
  /** 命中字段 */
  field: 'structured' | 'content';
  /** 命中的符号文本 */
  symbol: string;
  matchedSymbol: ProjectionKind | null;
  confidence: number;
  /** 记忆层级（longterm / project / feature / page / issue） */
  layer: string;
  detail: string;
}

/** 结构化 JSON 中的一个标量节点 */
interface StructuredLeaf {
  path: string;
  value: string;
}

/** 深度遍历 JSON，收集全部字符串叶子的 JSON 路径 */
export function collectStructuredLeaves(value: unknown, prefix = ''): StructuredLeaf[] {
  const out: StructuredLeaf[] = [];
  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      out.push({ path: path === '' ? '$' : path, value: node });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
        walk(item, path === '' ? key : `${path}.${key}`);
      }
    }
  };
  walk(value, prefix);
  return out;
}

/** 符号集合（规范名 + 八类投影 → 投影类型） */
function symbolIndex(canonicalName: string, projections: Partial<Record<ProjectionKind, string>>): Map<string, ProjectionKind | null> {
  const map = new Map<string, ProjectionKind | null>();
  if (canonicalName.length > 0) map.set(canonicalName, null);
  for (const kind of PROJECTION_KINDS) {
    const value = projections[kind];
    if (value !== undefined && value.length > 0) map.set(value, kind);
  }
  return map;
}

/**
 * 扫描单条记忆。
 *
 * - structured：字符串叶子与符号**全等** → confidence 1.0；
 * - content：语义匹配；高置信（≥0.8）全部产出，否则补一条最高分的候选。
 */
export function scanMemory(
  item: MemorySource,
  input: { canonicalName: string; projections: Partial<Record<ProjectionKind, string>> },
): MemoryHit[] {
  const symbols = symbolIndex(input.canonicalName, input.projections);
  const hits: MemoryHit[] = [];

  for (const leaf of collectStructuredLeaves(item.structured)) {
    if (!symbols.has(leaf.value)) continue;
    hits.push({
      refPath: item.id,
      locator: `${item.id}#structured.${leaf.path}`,
      field: 'structured',
      symbol: leaf.value,
      matchedSymbol: symbols.get(leaf.value) ?? null,
      confidence: 1,
      layer: item.layer,
      detail: `记忆「${item.title}」的结构化字段 ${leaf.path} 精确命中「${leaf.value}」`,
    });
  }

  const contentHits: MemoryHit[] = [];
  let best: MemoryHit | null = null;
  for (const [symbol, kind] of symbols) {
    const confidence = mentionConfidence(item.content, symbol);
    if (confidence >= 0.8) {
      contentHits.push({
        refPath: item.id,
        locator: `${item.id}#content`,
        field: 'content',
        symbol,
        matchedSymbol: kind,
        confidence,
        layer: item.layer,
        detail: `记忆「${item.title}」正文提及「${symbol}」（语义匹配 ${confidence.toFixed(2)}）`,
      });
      continue;
    }
    if (confidence >= 0.5 && (best === null || confidence > best.confidence)) {
      best = {
        refPath: item.id,
        locator: `${item.id}#content`,
        field: 'content',
        symbol,
        matchedSymbol: kind,
        confidence,
        layer: item.layer,
        detail: `记忆「${item.title}」正文疑似提及「${symbol}」（候选，语义匹配 ${confidence.toFixed(2)}）`,
      };
    }
  }
  hits.push(...contentHits);
  if (contentHits.length === 0 && best !== null) hits.push(best);
  return hits;
}

/** 批量扫描记忆集合 */
export function scanMemories(
  items: readonly MemorySource[],
  input: { canonicalName: string; projections: Partial<Record<ProjectionKind, string>> },
): MemoryHit[] {
  return items.flatMap((item) => scanMemory(item, input));
}

/** 是否为"记忆提及候选"（低置信，需用户逐条采纳 / 忽略，FR-UNI-08） */
export function isMemoryCandidate(hit: MemoryHit): boolean {
  return hit.field === 'content' && hit.confidence < 0.8;
}
