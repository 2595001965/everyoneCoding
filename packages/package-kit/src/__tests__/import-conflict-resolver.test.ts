import { describe, expect, it } from 'vitest';

import { batchDecideByType } from '../import/import-types';
import { buildDiffPreview, resolveConflicts } from '../import/conflict-resolver';
import { makeLocalPort, makeMemoryItem } from './import-testkit';
import type { PackageObject, PackageObjectType } from '../import/import-types';

function memPkg(id: string, content: string, updatedAt: number, projectId: string | null = null): PackageObject {
  const m = makeMemoryItem({ id, content, updatedAt, projectId });
  return { id, type: 'memory', projectId, name: content.slice(0, 20), updatedAt, payload: JSON.stringify(m) };
}

function genPkg(id: string, type: PackageObjectType, payload: string, updatedAt = 1): PackageObject {
  return { id, type, projectId: null, name: id, updatedAt, payload };
}

describe('conflict-resolver：差异分类', () => {
  const incoming: PackageObject[] = [
    memPkg('M1', 'm1', 100), // added
    memPkg('M2', 'm2', 100), // conflicted（本地内容不同）
    memPkg('M3', 'm3', 100), // unchanged
    genPkg('D1', 'document', 'doc-1'), // added
    genPkg('C1', 'code', 'c1', 5), // conflicted
    genPkg('R1', 'registry', 'r1', 1), // unchanged
  ];
  const local = makeLocalPort([
    memPkg('M2', 'local-m2', 100), // 内容不同 → conflicted
    memPkg('M3', 'm3', 100), // 相同 → unchanged
    genPkg('C1', 'code', 'local-c1', 5), // 不同 → conflicted
    genPkg('R1', 'registry', 'r1', 1), // 相同 → unchanged
    memPkg('M9', 'local-only', 50), // 本地独有 → missing
  ]);

  it('四类统计正确（added/conflicted/unchanged/missing）', () => {
    const preview = buildDiffPreview(incoming, local);
    expect(preview.counts).toEqual({ added: 2, conflicted: 2, unchanged: 2, missing: 1 });
    // 校验分类明细
    const byId = new Map(preview.items.map((i) => [i.incoming.id, i.classification]));
    expect(byId.get('M1')).toBe('added');
    expect(byId.get('M2')).toBe('conflicted');
    expect(byId.get('M3')).toBe('unchanged');
    expect(byId.get('C1')).toBe('conflicted');
    expect(byId.get('R1')).toBe('unchanged');
    expect(preview.missingLocals.some((l) => l.id === 'M9')).toBe(true);
  });

  it('未决策冲突默认 keepLocal（绝不自动覆盖）', () => {
    const preview = buildDiffPreview(incoming, local);
    const plan = resolveConflicts(preview, []);
    expect(plan.summary).toEqual({ keepLocal: 4, takeNew: 2, keepBoth: 0 });
    // M2/C1 都应落在 keepLocal（不覆盖本地）
    const m2 = plan.outcomes.find((o) => o.id === 'M2')!;
    const c1 = plan.outcomes.find((o) => o.id === 'C1')!;
    expect(m2.resolution).toBe('keepLocal');
    expect(c1.resolution).toBe('keepLocal');
  });

  it('keepBoth 生成新 id 且保留原 payload', () => {
    const preview = buildDiffPreview(incoming, local);
    const plan = resolveConflicts(preview, [
      { id: 'M2', resolution: 'takeNew' },
      { id: 'C1', resolution: 'keepBoth' },
    ]);
    const c1 = plan.outcomes.find((o) => o.id === 'C1')!;
    expect(c1.resolution).toBe('keepBoth');
    expect(c1.created).not.toBeNull();
    expect(c1.created!.id).not.toBe('C1');
    expect(c1.created!.payload).toBe('c1');
    expect(plan.summary.keepBoth).toBe(1);
    expect(plan.summary.takeNew).toBe(3); // M1 + D1 + M2
    expect(plan.summary.keepLocal).toBe(2); // M3 + R1
  });

  it('batchDecideByType 按类型批量生成决策', () => {
    const preview = buildDiffPreview(incoming, local);
    const decisions = batchDecideByType(preview, { code: 'takeNew', memory: 'keepBoth' });
    // 覆盖该类型全部条目（含 added/conflicted）
    const ids = new Set(decisions.map((d) => d.id));
    expect(ids.has('C1')).toBe(true);
    expect(ids.has('M1')).toBe(true);
    expect(ids.has('M2')).toBe(true);
    expect(decisions.find((d) => d.id === 'C1')?.resolution).toBe('takeNew');
  });
});
