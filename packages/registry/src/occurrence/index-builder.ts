/**
 * 出现位置索引构建器（T7-02，FR-UNI-04 / FR-UNI-06 / PRD §6.2 `occurrence`）。
 *
 * 一次构建 = 扫描四类来源 → 统一产出 `Occurrence[]` → 三级风险分级 → 汇总统计。
 *
 * 性能口径（NFR-P-06 ≤1.5s，1 万行工程）：`stats.elapsedMs` 用 `performance.now()`
 * 实测（可注入 `timer` 以便测试）；`linesScanned` 与 `filesScanned` 同时上报，
 * 便于人工复算"每万行耗时"。
 *
 * 增量重建：传入 `previous` 时，键（kind + refPath + locator + symbol）相同的条目**复用原 id**
 * 并置 `active`；本次未复现的旧条目置 `stale`（代码已变更但索引未刷新），仍保留在结果中
 * 供 UI 提示"索引已过期，建议重建"。
 */

import type { ProjectionKind } from '../naming/presets';
import type { RegistryEntry } from '../registry-model';
import { newUlid } from '../ids';
import { createAstDispatcher, isCodeFile, type AstDispatcherOptions } from './ast';
import { scanDocs } from './doc-scanner';
import { scanMemories } from './memory-scanner';
import { scanLogic } from './logic-scanner';
import { classifyRisk, defaultRiskConfig, type RiskConfig, type RiskSignal } from './risk-classifier';
import { splitLines } from './text-utils';
import {
  type DocSource,
  type IndexBuildStats,
  type IndexSourceFile,
  type LogicSourceNode,
  type MemorySource,
  type Occurrence,
  type OccurrenceRecord,
  type OccurrenceStatus,
  type ParserDegradation,
  type RawHit,
  type RiskLevel,
} from './types';

/** 语义命中进入索引的最低置信度 */
export const MIN_CONFIDENCE = 0.5;

/* ------------------------------- 构建输入 / 输出 ------------------------------- */

export interface BuildIndexInput {
  /** 注册表项（提供 registryId / canonicalName / projections / entityType） */
  registry: RegistryEntry;
  files?: readonly IndexSourceFile[] | undefined;
  docs?: readonly DocSource[] | undefined;
  memories?: readonly MemorySource[] | undefined;
  logic?: readonly LogicSourceNode[] | undefined;
  /** 外部解析器端口（libcst / JavaParser，可选增强） */
  astOptions?: AstDispatcherOptions | undefined;
  riskConfig?: RiskConfig | undefined;
  /** 增量重建：上一次的索引结果 */
  previous?: readonly Occurrence[] | undefined;
  now?: number | undefined;
  random?: (() => number) | undefined;
  /** 单帧计时器，默认 `performance.now` */
  timer?: (() => number) | undefined;
  /** 上下文行数（默认 3，PRD FR-UNI-05） */
  contextRadius?: number | undefined;
}

export interface BuildIndexResult {
  registryId: string;
  occurrences: Occurrence[];
  /** 本次未复现、被标记为 `stale` 的旧条目 */
  stale: Occurrence[];
  stats: IndexBuildStats;
  degraded: ParserDegradation[];
  warnings: string[];
}

/* ------------------------------- 构建 ------------------------------- */

function defaultTimer(): number {
  const scope = globalThis as { performance?: { now(): number } };
  return scope.performance?.now() ?? Date.now();
}

/** 出现位置的去重键（增量重建时用于复用 id） */
export function occurrenceKey(occurrence: {
  kind: string;
  refPath: string;
  locator: string | null;
  symbol: string;
}): string {
  return `${occurrence.kind}|${occurrence.refPath}|${occurrence.locator ?? ''}|${occurrence.symbol}`;
}

function signalOf(input: {
  kind: Occurrence['kind'];
  refPath: string;
  matchedSymbol: ProjectionKind | null;
  role: Occurrence['role'];
  confidence: number;
  detail: string | null;
}): RiskSignal {
  return {
    kind: input.kind,
    refPath: input.refPath,
    matchedSymbol: input.matchedSymbol,
    role: input.role,
    confidence: input.confidence,
    detail: input.detail,
  };
}

/**
 * 构建出现位置索引。
 *
 * 纯逻辑：不读写文件、不碰数据库；文件内容由调用方（外壳）读好后传入。
 */
export function buildOccurrenceIndex(input: BuildIndexInput): BuildIndexResult {
  const timer = input.timer ?? defaultTimer;
  const startedAt = timer();
  const now = input.now ?? Date.now();
  const random = input.random ?? Math.random;
  const riskConfig = input.riskConfig ?? defaultRiskConfig();
  const warnings: string[] = [];
  const degraded: ParserDegradation[] = [];

  const previousByKey = new Map<string, Occurrence>();
  for (const occurrence of input.previous ?? []) previousByKey.set(occurrenceKey(occurrence), occurrence);

  const projections: Partial<Record<ProjectionKind, string>> = input.registry.projections;
  const symbols = {
    canonicalName: input.registry.canonicalName,
    projections,
  };

  const occurrences: Occurrence[] = [];
  let linesScanned = 0;

  const emit = (draft: {
    kind: Occurrence['kind'];
    refPath: string;
    locator: string | null;
    matchedSymbol: ProjectionKind | null;
    symbol: string;
    confidence: number;
    role: Occurrence['role'];
    context: Occurrence['context'];
    detail: string | null;
    scopeLayer?: string | null | undefined;
    carrierId?: string | null | undefined;
    carrierField?: string | null | undefined;
  }): void => {
    const classification = classifyRisk(
      signalOf({
        kind: draft.kind,
        refPath: draft.refPath,
        matchedSymbol: draft.matchedSymbol,
        role: draft.role,
        confidence: draft.confidence,
        detail: draft.detail,
      }),
      riskConfig,
    );
    const existing = previousByKey.get(occurrenceKey(draft));
    const status: OccurrenceStatus = 'active';
    occurrences.push({
      id: existing?.id ?? newUlid(now, random),
      registryId: input.registry.id,
      kind: draft.kind,
      refPath: draft.refPath,
      locator: draft.locator,
      matchedSymbol: draft.matchedSymbol,
      symbol: draft.symbol,
      confidence: draft.confidence,
      riskLevel: classification.level,
      status,
      role: draft.role,
      context: draft.context,
      detail: draft.detail,
      scopeLayer: draft.scopeLayer ?? null,
      carrierId: draft.carrierId ?? null,
      carrierField: draft.carrierField ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  };

  /* ------------------------------ 代码（AST） ------------------------------ */
  const dispatcher = createAstDispatcher(input.astOptions ?? {});
  let codeCount = 0;
  let filesScanned = 0;
  for (const file of input.files ?? []) {
    if (!isCodeFile(file.path)) {
      const language = file.language ?? null;
      warnings.push(`跳过非代码文件：${file.path}${language === null ? '' : `（声明语言 ${language}）`}`);
      continue;
    }
    filesScanned += 1;
    linesScanned += splitLines(file.content).length;
    const result = dispatcher.parse(file.path, {
      content: file.content,
      targets: toTargets(projections),
      ...(input.contextRadius !== undefined ? { contextRadius: input.contextRadius } : {}),
    });
    if (result === null) continue;
    if (result.degradation !== null) degraded.push(result.degradation);
    for (const hit of result.hits) {
      if (hit.confidence < MIN_CONFIDENCE) continue;
      codeCount += 1;
      emit({
        kind: 'code',
        refPath: hit.refPath,
        locator: `${hit.refPath}:${hit.line}:${hit.column}`,
        matchedSymbol: hit.matchedSymbol,
        symbol: hit.symbol,
        confidence: hit.confidence,
        role: hit.role,
        context: hit.context,
        detail: describeHit(hit),
      });
    }
  }

  /* ------------------------------- 文档 ------------------------------- */
  const docHits = scanDocs(input.docs ?? [], symbols);
  for (const hit of docHits) {
    if (hit.confidence < MIN_CONFIDENCE) continue;
    emit({
      kind: 'doc',
      refPath: hit.refPath,
      locator: hit.locator,
      matchedSymbol: hit.matchedSymbol,
      symbol: hit.symbol,
      confidence: hit.confidence,
      role: null,
      context: null,
      detail: hit.detail,
    });
  }

  /* ------------------------------- 记忆 ------------------------------- */
  const memoryHits = scanMemories(input.memories ?? [], symbols);
  for (const hit of memoryHits) {
    if (hit.confidence < MIN_CONFIDENCE) continue;
    emit({
      kind: 'memory',
      refPath: hit.refPath,
      locator: hit.locator,
      matchedSymbol: hit.matchedSymbol,
      symbol: hit.symbol,
      confidence: hit.confidence,
      role: null,
      context: null,
      detail: hit.detail,
      scopeLayer: hit.layer,
    });
  }

  /* ----------------------------- 逻辑结构 ----------------------------- */
  const logicHits = scanLogic(input.logic ?? [], symbols);
  for (const hit of logicHits) {
    if (hit.confidence < MIN_CONFIDENCE) continue;
    emit({
      kind: 'logic',
      refPath: hit.refPath,
      locator: hit.locator,
      matchedSymbol: hit.matchedSymbol,
      symbol: hit.symbol,
      confidence: hit.confidence,
      role: null,
      context: null,
      detail: hit.detail,
      carrierId: hit.carrierId,
      carrierField: hit.carrierField,
    });
  }

  /* --------------------------- 增量重建 / stale --------------------------- */
  const seen = new Set(occurrences.map(occurrenceKey));
  const stale: Occurrence[] = [];
  for (const old of input.previous ?? []) {
    if (seen.has(occurrenceKey(old))) continue;
    stale.push({ ...old, status: 'stale', updatedAt: now });
  }

  const elapsedMs = Math.max(0, timer() - startedAt);
  const stats: IndexBuildStats = {
    filesScanned,
    linesScanned,
    code: codeCount,
    doc: docHits.length,
    memory: memoryHits.length,
    logic: logicHits.length,
    total: occurrences.length,
    elapsedMs: Number(elapsedMs.toFixed(2)),
  };

  if (stats.total === 0) {
    warnings.push('未在代码 / 文档 / 记忆 / 逻辑结构中发现该名称的引用（首次生成后属正常现象）');
  }

  return { registryId: input.registry.id, occurrences, stale, stats, degraded, warnings };
}

function toTargets(
  projections: Partial<Record<ProjectionKind, string>>,
): { kind: ProjectionKind; value: string }[] {
  return (Object.entries(projections) as [ProjectionKind, string | undefined][])
    .filter((entry): entry is [ProjectionKind, string] => typeof entry[1] === 'string' && entry[1].length > 0)
    .map(([kind, value]) => ({ kind, value }));
}

const ROLE_LABELS: Readonly<Record<RawHit['role'], string>> = {
  declaration: '声明',
  import: '导入',
  call: '调用 / 引用',
  'type-reference': '类型引用',
  'member-access': '成员访问',
  'jsx-tag': 'JSX 标签',
  binding: '绑定',
  'property-key': '属性键',
  'string-literal': '字符串字面量',
};

function describeHit(hit: RawHit): string {
  const base = `${hit.refPath}:${hit.line}:${hit.column} ${ROLE_LABELS[hit.role]}「${hit.symbol}」`;
  return hit.note === null ? base : `${base}（${hit.note}）`;
}

/* ------------------------------- 增量 / 失效 ------------------------------- */

/**
 * 代码变更后把相关出现位置标记为 `stale`（支持增量重建）。
 *
 * `changedPaths` 为空数组表示"整个工程都可能变了"，全部标记 stale。
 */
export function markOccurrencesStale(
  occurrences: readonly Occurrence[],
  changedPaths: readonly string[],
  now = Date.now(),
): Occurrence[] {
  const all = changedPaths.length === 0;
  const targets = new Set(changedPaths);
  return occurrences.map((occurrence) => {
    if (!all && !targets.has(occurrence.refPath)) return occurrence;
    return { ...occurrence, status: 'stale' as OccurrenceStatus, updatedAt: now };
  });
}

/** 是否仍有未失效的出现位置（决定是否需要重建） */
export function hasStale(occurrences: readonly Occurrence[]): boolean {
  return occurrences.some((occurrence) => occurrence.status === 'stale');
}

/** 按风险级别分组计数（UI 顶部的"将修改 N 处"） */
export function countByRisk(occurrences: readonly Occurrence[]): Record<RiskLevel, number> {
  const counts: Record<RiskLevel, number> = { auto: 0, confirm: 0, warn: 0 };
  for (const occurrence of occurrences) counts[occurrence.riskLevel] += 1;
  return counts;
}

/* ------------------------------- 存储 ------------------------------- */

/** 镜像 `@ec/data` 的 `occurrence` 表列（顺序与 DDL 一致） */
export interface OccurrenceStore {
  replaceForRegistry(registryId: string, records: readonly OccurrenceRecord[]): void;
  listByRegistry(registryId: string): OccurrenceRecord[];
  listByRefPath(refPath: string): OccurrenceRecord[];
  markStale(refPaths: readonly string[]): number;
}

/** 领域对象 → 存储行（`matched_symbol` 为 null 时表示命中规范名本身） */
export function toOccurrenceRecord(occurrence: Occurrence): OccurrenceRecord {
  return {
    id: occurrence.id,
    registry_id: occurrence.registryId,
    kind: occurrence.kind,
    ref_path: occurrence.refPath,
    locator: occurrence.locator,
    matched_symbol: occurrence.matchedSymbol,
    confidence: occurrence.confidence,
    risk_level: occurrence.riskLevel,
    status: occurrence.status,
    created_at: occurrence.createdAt,
    updated_at: occurrence.updatedAt,
  };
}

/**
 * 存储行 → 领域对象。
 *
 * ⚠️ `occurrence` 表按 PRD §6.2 只存 `matched_symbol`（投影类型），**不存符号文本**。
 * 因此从库中读回时符号文本需要用注册表的投影解回来：传入 `symbolOf` 即可；
 * 不传时 `symbol` 为空串，仅用于展示"命中了哪类投影"的场景。
 */
export function fromOccurrenceRecord(
  record: OccurrenceRecord,
  symbolOf?: (matched: ProjectionKind | null) => string,
): Occurrence {
  const matched = (record.matched_symbol as ProjectionKind | null) ?? null;
  return {
    id: record.id,
    registryId: record.registry_id,
    kind: record.kind,
    refPath: record.ref_path,
    locator: record.locator,
    matchedSymbol: matched,
    symbol: symbolOf === undefined ? '' : symbolOf(matched),
    confidence: record.confidence,
    riskLevel: record.risk_level,
    status: record.status,
    role: null,
    context: null,
    detail: null,
    scopeLayer: null,
    carrierId: null,
    carrierField: null,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

/** 内存实现（测试与降级用；真实装配由外壳绑定 SQLite） */
export function createInMemoryOccurrenceStore(
  initial: readonly OccurrenceRecord[] = [],
): OccurrenceStore {
  const rows = new Map<string, OccurrenceRecord>();
  for (const record of initial) rows.set(record.id, record);
  return {
    replaceForRegistry(registryId, records) {
      for (const [id, record] of [...rows.entries()]) {
        if (record.registry_id === registryId) rows.delete(id);
      }
      for (const record of records) rows.set(record.id, record);
    },
    listByRegistry(registryId) {
      return [...rows.values()].filter((record) => record.registry_id === registryId);
    },
    listByRefPath(refPath) {
      return [...rows.values()].filter((record) => record.ref_path === refPath);
    },
    markStale(refPaths) {
      const targets = new Set(refPaths);
      let updated = 0;
      for (const [id, record] of rows.entries()) {
        if (!targets.has(record.ref_path) || record.status === 'stale') continue;
        rows.set(id, { ...record, status: 'stale' });
        updated += 1;
      }
      return updated;
    },
  };
}
