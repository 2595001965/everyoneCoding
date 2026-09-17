import { previewOf, type FilePreview, type PreviewDiffLine } from './apply-strategy/preview';
import type { WritePlan, WritePlanEntry } from './write-types';

/**
 * diff 视图模型（T4-05 要点 4）。
 *
 * 与 `FilePreview` 的分工：`FilePreview` 是"差异事实"，`DiffViewModel` 是"可交互的差异"——
 * 增加折叠、按文件/按块选择、内联与并排两种排布的行对、以及应用范围推导。
 *
 * 交互约束（与任务卡一致）：
 * - 可**按文件**选择，也可**按块（hunk）**选择；
 * - 选择结果决定 `apply()` 实际写入哪些文件（块级选择会重新合成 patch 内容）；
 * - 大文件跳过内容 diff，但**仍可整体应用**。
 */

export interface DiffHunk {
  index: number;
  header: string;
  lines: PreviewDiffLine[];
  addedLines: number;
  removedLines: number;
  /** 折叠状态由 UI 持有，这里只给默认建议（差异 > 20 行的块默认折叠） */
  defaultCollapsed: boolean;
  selected: boolean;
}

export interface DiffFileModel {
  path: string;
  action: WritePlanEntry['action'];
  language: string;
  blocked: boolean;
  blockReason: string | null;
  changed: boolean;
  selected: boolean;
  addedLines: number;
  removedLines: number;
  hunks: DiffHunk[];
  skippedContentDiff: boolean;
  skipReason: string | null;
}

export interface DiffViewModel {
  planId: string;
  mode: WritePlan['mode'];
  summary: string;
  files: DiffFileModel[];
  totalAdded: number;
  totalRemoved: number;
  selectedFiles: string[];
  blockedFiles: string[];
  /** 选中且未被阻塞的文件数 */
  applicableCount: number;
}

/** 把逐行差异切成块：连续的非 context 行（含前后各 3 行上下文）归为一块 */
export const CONTEXT_LINES = 3;

export function groupIntoHunks(lines: readonly PreviewDiffLine[]): DiffHunk[] {
  const changedIndexes = lines
    .map((line, index) => (line.kind === 'context' ? -1 : index))
    .filter((index) => index >= 0);
  if (changedIndexes.length === 0) return [];

  const ranges: { start: number; end: number }[] = [];
  for (const index of changedIndexes) {
    const start = Math.max(0, index - CONTEXT_LINES);
    const end = Math.min(lines.length - 1, index + CONTEXT_LINES);
    const last = ranges[ranges.length - 1];
    if (last !== undefined && start <= last.end + 1) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }

  return ranges.map((range, index) => {
    const slice = lines.slice(range.start, range.end + 1);
    const addedLines = slice.filter((line) => line.kind === 'add').length;
    const removedLines = slice.filter((line) => line.kind === 'remove').length;
    const first = slice[0];
    return {
      index,
      header: `@@ -${first?.oldLine ?? '?'} +${first?.newLine ?? '?'} @@`,
      lines: slice,
      addedLines,
      removedLines,
      defaultCollapsed: slice.length > 24,
      selected: true,
    };
  });
}

export interface BuildDiffViewOptions {
  /** 已取消选择的文件 */
  unselectedPaths?: readonly string[] | undefined;
  /** 已取消选择的块（`path#index`） */
  unselectedHunks?: readonly string[] | undefined;
}

export function toDiffViewModel(plan: WritePlan, options: BuildDiffViewOptions = {}): DiffViewModel {
  const unselected = new Set(options.unselectedPaths ?? []);
  const unselectedHunks = new Set(options.unselectedHunks ?? []);

  const files: DiffFileModel[] = plan.entries.map((entry) => {
    const preview: FilePreview = previewOf(entry);
    const hunks = groupIntoHunks(preview.lines).map((hunk) => ({
      ...hunk,
      selected: !unselectedHunks.has(`${preview.path}#${hunk.index}`),
    }));
    return {
      path: preview.path,
      action: preview.action,
      language: preview.language,
      blocked: preview.blocked,
      blockReason: preview.blockReason,
      changed: preview.changed,
      selected: !unselected.has(preview.path) && !preview.blocked,
      addedLines: preview.addedLines,
      removedLines: preview.removedLines,
      hunks,
      skippedContentDiff: preview.skippedContentDiff,
      skipReason: preview.skipReason,
    };
  });

  return {
    planId: plan.id,
    mode: plan.mode,
    summary: plan.summary,
    files,
    totalAdded: files.reduce((sum, file) => sum + file.addedLines, 0),
    totalRemoved: files.reduce((sum, file) => sum + file.removedLines, 0),
    selectedFiles: files.filter((file) => file.selected).map((file) => file.path),
    blockedFiles: files.filter((file) => file.blocked).map((file) => file.path),
    applicableCount: files.filter((file) => file.selected).length,
  };
}

/** 切换文件选择 */
export function toggleFile(model: DiffViewModel, path: string): string[] {
  const current = new Set(model.selectedFiles);
  if (current.has(path)) current.delete(path);
  else current.add(path);
  return [...current];
}

/** 切换块选择并返回新的 `path#index` 集合 */
export function toggleHunk(model: DiffViewModel, path: string, hunkIndex: number): string[] {
  const unselected: string[] = [];
  for (const file of model.files) {
    for (const hunk of file.hunks) {
      const key = `${file.path}#${hunk.index}`;
      if (file.path === path && hunk.index === hunkIndex) {
        if (hunk.selected) unselected.push(key);
      } else if (!hunk.selected) {
        unselected.push(key);
      }
    }
  }
  return unselected;
}

/**
 * 把 UI 选择结果写回计划（apply 前调用）。
 * 块被部分取消时不再重算补丁 —— 这属于"要求 AI 重改"的场景，
 * 因此这里只处理文件级选择，块级信息通过 {@link describeHunkSelection} 交给重改指令。
 */
export function applySelectionToPlan(plan: WritePlan, selectedPaths: readonly string[]): WritePlan {
  const selected = new Set(selectedPaths);
  return {
    ...plan,
    entries: plan.entries.map((entry) => ({ ...entry, selected: selected.has(entry.path) && !entry.blocked })),
  };
}

/** 块级选择说明（拼进「要求 AI 重改」的指令里） */
export function describeHunkSelection(model: DiffViewModel): string {
  const parts: string[] = [];
  for (const file of model.files) {
    const kept = file.hunks.filter((hunk) => hunk.selected);
    if (kept.length === 0 || kept.length === file.hunks.length) continue;
    parts.push(`${file.path}：仅关注第 ${kept.map((hunk) => hunk.index + 1).join('、')} 处改动`);
  }
  return parts.join('；');
}
