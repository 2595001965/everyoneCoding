import { describe, expect, it } from 'vitest';

import { describeMode, previewMode, MODE_PARTICIPATING_TYPES } from '../import/mode-selector';
import type {
  PackageDiffItem,
  PackageDiffPreview,
  PackageObjectType,
} from '../import/import-types';

function item(
  type: PackageObjectType,
  classification: PackageDiffItem['classification'],
  id = `${type}-1`,
): PackageDiffItem {
  return {
    incoming: { id, type, projectId: null, name: id, updatedAt: 1, payload: '{}' },
    local: null,
    classification,
  };
}

function preview(): PackageDiffPreview {
  const items: PackageDiffItem[] = [
    item('memory', 'added', 'mem-a'),
    item('memory', 'conflicted', 'mem-c'),
    item('memory', 'unchanged', 'mem-u'),
    item('document', 'added', 'doc-a'),
    item('document', 'conflicted', 'doc-c'),
    item('code', 'added', 'code-a'),
    item('design', 'unchanged', 'design-u'),
    item('registry', 'added', 'reg-a'),
    item('anchor', 'unchanged', 'anc-u'),
    item('pipeline', 'added', 'pipe-a'),
  ];
  const counts = { added: 0, conflicted: 0, unchanged: 0, missing: 0 };
  for (const it of items) counts[it.classification] += 1;
  return { items, counts, missingLocals: [] };
}

describe('mode-selector：五种模式的参与类别与统计', () => {
  it('describeMode 返回中文标签', () => {
    expect(describeMode('full-restore')).toContain('完整恢复');
    expect(describeMode('memory-only')).toBe('仅记忆');
  });

  it('full-restore：全部 7 类参与，added 计 apply、conflicted 计 overwrite', () => {
    const m = previewMode('full-restore', preview());
    // 统计按分类，added 共 5 个（mem-a,doc-a,code-a,reg-a,pipe-a）
    expect(m.toApply).toBe(5);
    expect(m.toOverwrite).toBe(2); // mem-c, doc-c
    expect(m.toSkip).toBe(3); // 3 unchanged
    expect(m.byType.design.skip).toBe(1);
  });

  it('memory-only：仅 memory 参与，其余全部跳过', () => {
    const m = previewMode('memory-only', preview());
    expect(m.toApply).toBe(1); // mem-a
    expect(m.toOverwrite).toBe(1); // mem-c
    expect(m.toSkip).toBe(8); // 其余 8
    expect(m.byType.code.apply).toBe(0);
    expect(m.byType.code.skip).toBe(1);
    expect(MODE_PARTICIPATING_TYPES['memory-only'].has('document')).toBe(false);
  });

  it('documents-only：仅 document 参与（摘要说明含附件）', () => {
    const m = previewMode('documents-only', preview());
    expect(m.toApply).toBe(1); // doc-a
    expect(m.toOverwrite).toBe(1); // doc-c
    expect(m.summary).toContain('附件');
    expect(MODE_PARTICIPATING_TYPES['documents-only'].has('memory')).toBe(false);
  });

  it('code-only：code+design+registry+anchor+pipeline 参与，不含 memory/document', () => {
    const m = previewMode('code-only', preview());
    expect(m.toApply).toBe(3); // code-a, reg-a, pipe-a
    expect(m.toSkip).toBe(7); // mem(3)+doc(2)+design unchanged(1) =6? design 是 unchanged 不在 code-only? design 在 code-only 参与集合
    // design 在 code-only 参与：design-u 是 unchanged → toSkip 计 design 的 skip
    // 参与类别：code,design,registry,anchor,pipeline（5类）。document/memory 不参与。
    // apply: code-a,reg-a,pipe-a =3；overwrite: 无（conflicted 只在 mem/doc）；skip: mem-a,mem-c,mem-u,doc-a,doc-c,design-u,anc-u =7
    expect(m.toSkip).toBe(7);
    expect(m.summary).toContain('设计');
    expect(MODE_PARTICIPATING_TYPES['code-only'].has('memory')).toBe(false);
  });

  it('merge：与 full-restore 同覆盖全部类别', () => {
    const m = previewMode('merge', preview());
    expect(m.toApply).toBe(5);
    expect(m.toOverwrite).toBe(2);
    expect(m.toSkip).toBe(3);
  });
});
