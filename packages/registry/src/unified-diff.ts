/**
 * 统一 diff 预览（T7-04 要点 1，FR-UNI-05）。
 *
 * 四栏 = **代码 / 文档 / 记忆 / 逻辑结构**（与出现位置的 `kind` 一一对应）。
 * 每栏内逐项可勾选、可检索定位、可展开 ±3 行上下文；文档栏支持"显示 / 隐藏修订标记"。
 *
 * 本模块是纯数据变换：输入影响面报告 + 勾选集合，输出可直接交给 `UnifiedDiffView`
 * 渲染的四栏视图；执行后的状态回填（`applied` / `skipped` / `failed`）也在这里维护。
 */

import type { ProjectionKind } from './naming/presets';
import { PROJECTION_KINDS } from './naming/presets';
import type { ProjectionSet } from './registry-model';
import type { ImpactReport } from './impact-analyzer';
import { summarizeImpact } from './impact-analyzer';
import type { HitRole, OccurrenceKind, RiskLevel } from './occurrence/types';
import type { LineContext } from './occurrence/text-utils';

/** 四栏（顺序即 UI 展示顺序） */
export const DIFF_COLUMNS: readonly OccurrenceKind[] = ['code', 'doc', 'memory', 'logic'];

/** 栏标题 */
export const DIFF_COLUMN_LABELS: Readonly<Record<OccurrenceKind, string>> = {
  code: '代码',
  doc: '文档',
  memory: '记忆',
  logic: '逻辑结构',
};

/** 单项执行状态 */
export const DIFF_STATUSES = ['pending', 'applied', 'skipped', 'failed'] as const;
export type DiffStatus = (typeof DIFF_STATUSES)[number];

/** 文档修订记录 */
export interface DocRevision {
  oldText: string;
  newText: string;
  at: number;
  reason: string;
}

/** 一条 diff 项 */
export interface DiffEntry {
  id: string;
  column: OccurrenceKind;
  refPath: string;
  locator: string | null;
  matchedSymbol: ProjectionKind | null;
  riskLevel: RiskLevel;
  confidence: number;
  role: HitRole | null;
  /** ±3 行上下文（仅代码栏） */
  context: LineContext | null;
  /** 替换前文本 */
  before: string;
  /** 替换后文本 */
  after: string;
  /** 文档修订记录（可切换显示 / 隐藏） */
  revision: DocRevision | null;
  /** 承载者 id（逻辑结构为 DSL 节点 id） */
  carrierId: string | null;
  detail: string | null;
  selected: boolean;
  status: DiffStatus;
  failure: string | null;
}

/** 一栏 */
export interface DiffColumnView {
  column: OccurrenceKind;
  label: string;
  entries: DiffEntry[];
  selectedCount: number;
}

/** 统一 diff 视图模型 */
export interface UnifiedDiff {
  registryId: string;
  projectId: string;
  oldName: string;
  newName: string;
  oldProjections: ProjectionSet;
  newProjections: ProjectionSet;
  projectionChanges: { kind: ProjectionKind; oldValue: string; newValue: string; changed: boolean }[];
  columns: DiffColumnView[];
  /** 文档栏是否显示修订标记（FR-UNI-09） */
  showRevisionMarks: boolean;
  summary: {
    total: number;
    selected: number;
    auto: number;
    confirm: number;
    warn: number;
    estimatedMs: number;
    inspectText: string;
  };
  scopeNotice: string;
  warnings: string[];
}

export interface BuildUnifiedDiffOptions {
  selection?: ReadonlySet<string> | undefined;
  showRevisionMarks?: boolean | undefined;
  now?: number | undefined;
}

/** 生成 doc 栏的修订说明文本（`show` 只影响展示，不改变 before/after） */
export function revisionNote(entry: Pick<DiffEntry, 'before' | 'after'>, show: boolean, now: number): DocRevision | null {
  if (!show) return null;
  return {
    oldText: entry.before,
    newText: entry.after,
    at: now,
    reason: `${entry.before} → ${entry.after}`,
  };
}

/** 由影响面报告构建四栏 diff */
export function buildUnifiedDiff(
  report: ImpactReport,
  options: BuildUnifiedDiffOptions = {},
): UnifiedDiff {
  const now = options.now ?? Date.now();
  const showRevisionMarks = options.showRevisionMarks ?? false;
  const entries: DiffEntry[] = report.groups.flatMap((group) =>
    group.items.map((item) => {
      const entry: DiffEntry = {
        id: item.id,
        column: item.kind,
        refPath: item.refPath,
        locator: item.locator,
        matchedSymbol: item.matchedSymbol,
        riskLevel: item.riskLevel,
        confidence: item.confidence,
        role: item.role,
        context: item.context,
        before: item.oldText,
        after: item.newText,
        revision: null,
        carrierId: item.carrierId,
        detail: item.detail,
        selected: options.selection === undefined ? item.selected : options.selection.has(item.id),
        status: 'pending',
        failure: null,
      };
      if (entry.column === 'doc') entry.revision = revisionNote(entry, showRevisionMarks, now);
      return entry;
    }),
  );

  const columns: DiffColumnView[] = DIFF_COLUMNS.map((column) => {
    const columnEntries = entries.filter((entry) => entry.column === column);
    return {
      column,
      label: DIFF_COLUMN_LABELS[column],
      entries: columnEntries,
      selectedCount: columnEntries.filter((entry) => entry.selected).length,
    };
  });

  const selected = entries.filter((entry) => entry.selected).length;
  return {
    registryId: report.registryId,
    projectId: report.projectId,
    oldName: report.oldName,
    newName: report.newName,
    oldProjections: report.oldProjections,
    newProjections: report.newProjections,
    projectionChanges: report.projectionChanges.map((change) => ({
      kind: change.kind,
      oldValue: change.oldValue,
      newValue: change.newValue,
      changed: change.changed,
    })),
    columns,
    showRevisionMarks,
    summary: {
      total: report.totals.total,
      selected,
      auto: report.totals.auto,
      confirm: report.totals.confirm,
      warn: report.totals.warn,
      estimatedMs: report.totals.estimatedMs,
      inspectText: summarizeImpact(report),
    },
    scopeNotice: report.scopeNotice,
    warnings: report.warnings,
  };
}

/** 勾选 / 取消勾选单项（返回新视图，保持不可变） */
export function toggleEntry(diff: UnifiedDiff, id: string, selected: boolean): UnifiedDiff {
  return {
    ...diff,
    columns: diff.columns.map((column) => {
      const entries = column.entries.map((entry) => (entry.id === id ? { ...entry, selected } : entry));
      return { ...column, entries, selectedCount: entries.filter((entry) => entry.selected).length };
    }),
    summary: updateSelected(diff, id, selected),
  };
}

function updateSelected(diff: UnifiedDiff, id: string, selected: boolean): UnifiedDiff['summary'] {
  const current = diff.columns
    .flatMap((column) => column.entries)
    .find((entry) => entry.id === id);
  if (current === undefined || current.selected === selected) return diff.summary;
  return { ...diff.summary, selected: diff.summary.selected + (selected ? 1 : -1) };
}

/** 整栏全选 / 全不选 */
export function toggleColumn(diff: UnifiedDiff, column: OccurrenceKind, selected: boolean): UnifiedDiff {
  let next = diff;
  for (const entry of diff.columns.find((view) => view.column === column)?.entries ?? []) {
    next = toggleEntry(next, entry.id, selected);
  }
  return next;
}

/** 切换修订标记显示（FR-UNI-09） */
export function setRevisionMarks(diff: UnifiedDiff, show: boolean, now = Date.now()): UnifiedDiff {
  if (diff.showRevisionMarks === show) return diff;
  return {
    ...diff,
    showRevisionMarks: show,
    columns: diff.columns.map((column) => ({
      ...column,
      entries: column.entries.map((entry) =>
        entry.column === 'doc' ? { ...entry, revision: revisionNote(entry, show, now) } : entry,
      ),
    })),
  };
}

/** 检索定位：按文件路径 / 定位 / 符号 / 说明模糊匹配 */
export function searchEntries(diff: UnifiedDiff, query: string): DiffEntry[] {
  const keyword = query.trim().toLowerCase();
  const all = diff.columns.flatMap((column) => column.entries);
  if (keyword.length === 0) return all;
  return all.filter((entry) =>
    [entry.refPath, entry.locator ?? '', entry.before, entry.after, entry.detail ?? '', entry.matchedSymbol ?? '']
      .join(' ')
      .toLowerCase()
      .includes(keyword),
  );
}

/** 执行后回填单项状态 */
export function applyDiffStatus(
  diff: UnifiedDiff,
  id: string,
  status: DiffStatus,
  failure: string | null = null,
): UnifiedDiff {
  return {
    ...diff,
    columns: diff.columns.map((column) => ({
      ...column,
      entries: column.entries.map((entry) => (entry.id === id ? { ...entry, status, failure } : entry)),
    })),
  };
}

/** 勾选集合（执行事务时使用） */
export function selectionOf(diff: UnifiedDiff): Set<string> {
  const selection = new Set<string>();
  for (const column of diff.columns) {
    for (const entry of column.entries) if (entry.selected) selection.add(entry.id);
  }
  return selection;
}

/** 底部文案："将修改 N 处，其中确认区 M 处、警告区 K 处" */
export function diffFooterText(diff: UnifiedDiff): string {
  return `将修改 ${diff.summary.selected} 处，其中确认区 ${diff.summary.confirm} 处、警告区 ${diff.summary.warn} 处`;
}

/** 投影前后对照表（T7-01 验收要求的"投影前后对照表"） */
export function projectionTable(diff: UnifiedDiff): string {
  const rows = PROJECTION_KINDS.map((kind) => {
    const change = diff.projectionChanges.find((item) => item.kind === kind);
    const mark = change?.changed === true ? '（变更）' : '';
    return `| ${kind} | ${change?.oldValue ?? ''} | ${change?.newValue ?? ''} ${mark} |`;
  });
  return ['| 投影 | 旧值 | 新值 |', '| --- | --- | --- |', ...rows].join('\n');
}
