import { splitLines } from '../../generate/revision';
import type { FileDiffSummary } from '../../generate/revision';
import type { WritePlan, WritePlanEntry } from '../write-types';

/**
 * 预览策略（T4-05 要点 1：preview）。
 *
 * 语义澄清（容易误解）：preview 不是"人工编辑"，而是**先给人看 diff，确认后仍由 AI 侧应用**。
 * 因此本模块只做三件事：
 * 1. 把计划渲染成可展示的差异模型（{@link buildPreviews}）；
 * 2. 计算逐文件增删行数；
 * 3. 给出「选哪些文件 / 哪些块」的过滤结果，交给 `WritePipeline.apply` 执行
 *    —— 应用动作始终发生在 AI 侧，用户只在"要不要应用"上表达意志。
 */

export interface PreviewDiffLine {
  kind: 'context' | 'add' | 'remove';
  text: string;
  /** 原文件行号（add 行为 null） */
  oldLine: number | null;
  /** 新文件行号（remove 行为 null） */
  newLine: number | null;
}

export interface FilePreview {
  path: string;
  action: WritePlanEntry['action'];
  language: string;
  before: string | null;
  after: string | null;
  blocked: boolean;
  blockReason: string | null;
  changed: boolean;
  addedLines: number;
  removedLines: number;
  lines: PreviewDiffLine[];
  /** 内容过大（>1MB）时跳过逐行 diff，仅提示 */
  skippedContentDiff: boolean;
  /** 跳过原因（大文件 / 二进制） */
  skipReason: string | null;
}

/** >1MB 的文件不做内容 diff（任务卡：大文件跳过内容 diff 并提示） */
export const CONTENT_DIFF_SIZE_LIMIT = 1024 * 1024;

export function isLargeContent(before: string | null, after: string | null): boolean {
  const size = (before?.length ?? 0) + (after?.length ?? 0);
  return size > CONTENT_DIFF_SIZE_LIMIT;
}

/**
 * 逐行差异。
 *
 * 这里用"朴素 LCS"（内存 O(n·m)，但只对 ≤ 数千行的单个文件执行，且大文件直接跳过），
 * 之所以不引入 diff 库：本项目的差异仅用于**展示与选择**，
 * 真正的写入依据是 `after` 全文（已由补丁策略确定），不存在"按 diff 重新应用"的风险。
 */
/** 朴素的 LCS 单元格上限：超过则退化为"整体替换"（避免几百 MB 的中间数组） */
export const LCS_CELL_LIMIT = 4_000_000;

export function computeDiffLines(before: string, after: string): PreviewDiffLine[] {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const oldCount = oldLines.length;
  const newCount = newLines.length;

  if (oldCount * newCount > LCS_CELL_LIMIT) {
    return [
      ...oldLines.map((text, index) => ({
        kind: 'remove' as const,
        text,
        oldLine: index + 1,
        newLine: null,
      })),
      ...newLines.map((text, index) => ({
        kind: 'add' as const,
        text,
        oldLine: null,
        newLine: index + 1,
      })),
    ];
  }

  // 用扁平 Int32Array 而不是二维数组：2000×2000 的差异只需要 16MB
  const width = newCount + 1;
  const lcs = new Int32Array((oldCount + 1) * width);
  for (let i = oldCount - 1; i >= 0; i -= 1) {
    for (let j = newCount - 1; j >= 0; j -= 1) {
      const index = i * width + j;
      lcs[index] =
        oldLines[i] === newLines[j]
          ? (lcs[(i + 1) * width + (j + 1)] ?? 0) + 1
          : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + (j + 1)] ?? 0);
    }
  }

  const result: PreviewDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < oldCount && j < newCount) {
    if (oldLines[i] === newLines[j]) {
      result.push({ kind: 'context', text: oldLines[i] as string, oldLine: i + 1, newLine: j + 1 });
      i += 1;
      j += 1;
      continue;
    }
    const down = lcs[(i + 1) * width + j] ?? 0;
    const right = lcs[i * width + (j + 1)] ?? 0;
    if (down >= right) {
      result.push({ kind: 'remove', text: oldLines[i] as string, oldLine: i + 1, newLine: null });
      i += 1;
    } else {
      result.push({ kind: 'add', text: newLines[j] as string, oldLine: null, newLine: j + 1 });
      j += 1;
    }
  }
  while (i < oldCount) {
    result.push({ kind: 'remove', text: oldLines[i] as string, oldLine: i + 1, newLine: null });
    i += 1;
  }
  while (j < newCount) {
    result.push({ kind: 'add', text: newLines[j] as string, oldLine: null, newLine: j + 1 });
    j += 1;
  }
  return result;
}

export function previewOf(entry: WritePlanEntry): FilePreview {
  const before = entry.before ?? '';
  const after = entry.after ?? '';
  const large = isLargeContent(entry.before, entry.after);

  if (entry.action === 'create') {
    const added = splitLines(after).length;
    return {
      path: entry.path,
      action: entry.action,
      language: entry.language,
      before: entry.before,
      after: entry.after,
      blocked: entry.blocked,
      blockReason: entry.blockReason,
      changed: entry.changed,
      addedLines: added,
      removedLines: 0,
      lines: large ? [] : computeDiffLines('', after),
      skippedContentDiff: large,
      skipReason: large ? '新增内容超过 1MB，已跳过逐行 diff' : null,
    };
  }

  if (entry.action === 'delete') {
    return {
      path: entry.path,
      action: entry.action,
      language: entry.language,
      before: entry.before,
      after: entry.after,
      blocked: entry.blocked,
      blockReason: entry.blockReason,
      changed: entry.changed,
      addedLines: 0,
      removedLines: splitLines(before).length,
      lines: large ? [] : computeDiffLines(before, ''),
      skippedContentDiff: large,
      skipReason: large ? '被删除文件超过 1MB，已跳过逐行 diff' : null,
    };
  }

  if (entry.blocked || entry.after === null) {
    return {
      path: entry.path,
      action: entry.action,
      language: entry.language,
      before: entry.before,
      after: null,
      blocked: entry.blocked,
      blockReason: entry.blockReason,
      changed: false,
      addedLines: 0,
      removedLines: 0,
      lines: [],
      skippedContentDiff: false,
      skipReason: entry.blocked ? '补丁无法应用，未生成预览' : null,
    };
  }

  const lines = large ? [] : computeDiffLines(before, after);
  return {
    path: entry.path,
    action: entry.action,
    language: entry.language,
    before: entry.before,
    after: entry.after,
    blocked: false,
    blockReason: null,
    changed: entry.changed,
    addedLines: lines.filter((line) => line.kind === 'add').length,
    removedLines: lines.filter((line) => line.kind === 'remove').length,
    lines,
    skippedContentDiff: large,
    skipReason: large ? '文件超过 1MB，已跳过逐行 diff（仍可整体应用）' : null,
  };
}

export function buildPreviews(plan: WritePlan): FilePreview[] {
  return plan.entries.map(previewOf);
}

/** 与上一轮生成结果的差异汇总（多轮修正时展示"这次又改了什么"） */
export function previewsToSummaries(previews: readonly FilePreview[]): FileDiffSummary[] {
  return previews.map((preview) => ({
    path: preview.path,
    action: preview.action,
    addedLines: preview.addedLines,
    removedLines: preview.removedLines,
    unchanged: !preview.changed,
  }));
}

/** 可应用的文件（已勾选且未被阻塞） */
export function applicableEntries(plan: WritePlan): WritePlanEntry[] {
  return plan.entries.filter((entry) => entry.selected && !entry.blocked);
}
