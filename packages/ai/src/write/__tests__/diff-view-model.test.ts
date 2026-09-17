import { describe, expect, it } from 'vitest';

import { computeDiffLines, CONTENT_DIFF_SIZE_LIMIT, isLargeContent, previewOf } from '../apply-strategy/preview';
import {
  applySelectionToPlan,
  describeHunkSelection,
  groupIntoHunks,
  toDiffViewModel,
  toggleFile,
  toggleHunk,
} from '../diff-view-model';
import type { WritePlan, WritePlanEntry } from '../write-types';

function entry(overrides: Partial<WritePlanEntry> = {}): WritePlanEntry {
  return {
    path: 'a.ts',
    action: 'patch',
    language: 'ts',
    content: '',
    before: 'one\ntwo\nthree\n',
    after: 'one\nTWO\nthree\nfour\n',
    blocked: false,
    blockReason: null,
    changed: true,
    selected: true,
    ...overrides,
  };
}

function planOf(entries: WritePlanEntry[]): WritePlan {
  return {
    id: 'plan-1',
    mode: 'preview',
    entries,
    createdAt: 1,
    summary: '变更说明',
    anchors: [],
    noteIds: [],
    addedLines: 0,
    removedLines: 0,
    blockedCount: 0,
  };
}

/** 30 行文件，在两处相距较远的位置各改一行 —— 才能稳定切出两个 hunk */
const LONG_BEFORE = Array.from({ length: 30 }, (_, index) => `line-${index + 1}`).join('\n');
const LONG_AFTER = LONG_BEFORE.replace('line-3', 'line-3-changed').replace('line-25', 'line-25-changed');

describe('逐行差异与分块（T4-05 要点 4）', () => {
  it('computeDiffLines 给出正确的增删与行号', () => {
    const lines = computeDiffLines('a\nb\nc', 'a\nB\nc');
    expect(lines.map((line) => line.kind)).toEqual(['context', 'remove', 'add', 'context']);
    const removed = lines.find((line) => line.kind === 'remove');
    const added = lines.find((line) => line.kind === 'add');
    expect(removed?.oldLine).toBe(2);
    expect(removed?.newLine).toBeNull();
    expect(added?.newLine).toBe(2);
    expect(added?.oldLine).toBeNull();
  });

  it('无差异时返回全上下文', () => {
    expect(computeDiffLines('a\nb', 'a\nb').every((line) => line.kind === 'context')).toBe(true);
  });

  it('超过 1MB 判定为大文件（跳过内容 diff，仍可整体应用）', () => {
    expect(isLargeContent('x'.repeat(CONTENT_DIFF_SIZE_LIMIT + 1), '')).toBe(true);
    expect(isLargeContent('small', 'also small')).toBe(false);

    const preview = previewOf(entry({ before: 'x'.repeat(CONTENT_DIFF_SIZE_LIMIT + 1), after: 'y' }));
    expect(preview.skippedContentDiff).toBe(true);
    expect(preview.skipReason).toContain('1MB');
    expect(preview.lines).toEqual([]);
  });

  it('被阻塞的文件不生成 diff，但有明确原因', () => {
    const preview = previewOf(entry({ blocked: true, blockReason: '补丁应用失败', after: null }));
    expect(preview.blocked).toBe(true);
    expect(preview.lines).toEqual([]);
    expect(preview.addedLines).toBe(0);
  });

  it('groupIntoHunks 把相距较远的改动切成独立的块，并带上下文行号', () => {
    const hunks = groupIntoHunks(computeDiffLines(LONG_BEFORE, LONG_AFTER));
    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.header).toContain('@@');
    expect(hunks[0]?.addedLines).toBe(1);
    expect(hunks[0]?.removedLines).toBe(1);
    expect(hunks[0]?.defaultCollapsed).toBe(false);
  });

  it('相距很近的改动（上下文重叠）合并为一块，与 git 行为一致', () => {
    const before = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].join('\n');
    const after = ['1', '2', '3', 'X', '5', '6', '7', '8', 'Y', '10'].join('\n');
    expect(groupIntoHunks(computeDiffLines(before, after))).toHaveLength(1);
  });

  it('无改动时不产生块', () => {
    expect(groupIntoHunks(computeDiffLines('a', 'a'))).toEqual([]);
  });
});

describe('diff 视图模型与选择（T4-05 要点 4）', () => {
  it('汇总总数、可应用数与阻塞文件', () => {
    const model = toDiffViewModel(
      planOf([
        entry(),
        entry({ path: 'b.ts', action: 'create', before: null, after: 'new\n' }),
        entry({ path: 'c.ts', blocked: true, after: null, blockReason: '冲突' }),
      ]),
    );

    expect(model.files).toHaveLength(3);
    expect(model.blockedFiles).toEqual(['c.ts']);
    expect(model.selectedFiles).toEqual(['a.ts', 'b.ts']);
    expect(model.applicableCount).toBe(2);
    expect(model.totalAdded).toBeGreaterThan(0);
    expect(model.files[2]?.selected).toBe(false);
  });

  it('toggleFile 在选中集合中增删；applySelectionToPlan 写回计划', () => {
    const model = toDiffViewModel(planOf([entry(), entry({ path: 'b.ts' })]));
    expect(toggleFile(model, 'a.ts')).toEqual(['b.ts']);

    const updated = applySelectionToPlan(planOf([entry(), entry({ path: 'b.ts' })]), ['b.ts']);
    expect(updated.entries[0]?.selected).toBe(false);
    expect(updated.entries[1]?.selected).toBe(true);
  });

  it('被阻塞的文件永远不可选中（即便显式传入）', () => {
    const updated = applySelectionToPlan(planOf([entry({ blocked: true })]), ['a.ts']);
    expect(updated.entries[0]?.selected).toBe(false);
  });

  it('toggleHunk 维护 path#index 形式的未选集合，并生成重改说明', () => {
    const plan = planOf([entry({ before: LONG_BEFORE, after: LONG_AFTER })]);
    const model = toDiffViewModel(plan);
    expect(model.files[0]?.hunks).toHaveLength(2);

    const unselected = toggleHunk(model, 'a.ts', 1);
    expect(unselected).toEqual(['a.ts#1']);

    const withHunkOff = toDiffViewModel(plan, { unselectedHunks: ['a.ts#1'] });
    expect(withHunkOff.files[0]?.hunks[1]?.selected).toBe(false);
    expect(describeHunkSelection(withHunkOff)).toContain('仅关注第 1 处改动');
  });

  it('未取消任何文件时重改说明为空（避免无意义指令）', () => {
    const model = toDiffViewModel(planOf([entry()]));
    expect(describeHunkSelection(model)).toBe('');
  });
});
