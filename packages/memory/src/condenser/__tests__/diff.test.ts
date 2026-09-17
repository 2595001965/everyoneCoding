import { describe, test, expect } from 'vitest';
import { createLoginPageDslFixture, type PageDsl, type PageDslElement } from '../page-dsl';
import { diffDsl, diffSummary, hasStructuralChange } from '../diff';
import { condensePage } from '../condenser';

function clone(dsl: PageDsl): PageDsl {
  return JSON.parse(JSON.stringify(dsl)) as PageDsl;
}

function findById(node: PageDslElement, id: string): PageDslElement {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findById(child, id);
    if (found.id === id) return found;
  }
  return node;
}

describe('diff', () => {
  test('改一个 Button 的 text：changedIds 只含该元素，subtrees 最小', () => {
    const prev = createLoginPageDslFixture();
    const next = clone(prev);
    const submit = findById(next.tree, 'el-submit');
    submit.props = { ...(submit.props ?? {}), text: '立即登录' };
    const diff = diffDsl(prev, next);
    expect(diff.changedIds).toEqual(['el-submit']);
    expect(diff.subtrees).toEqual(['el-submit']);
  });

  test('改一个 binding：changedIds 只含该元素，subtrees 最小', () => {
    const prev = createLoginPageDslFixture();
    const next = clone(prev);
    const phone = findById(next.tree, 'el-phone');
    phone.bindings = { value: 'phoneX' };
    const diff = diffDsl(prev, next);
    expect(diff.changedIds).toEqual(['el-phone']);
    expect(diff.subtrees).toEqual(['el-phone']);
  });

  test('纯样式变更不计入结构变更', () => {
    const prev = createLoginPageDslFixture();
    const next = clone(prev);
    next.tree.style = { color: 'blue' };
    const diff = diffDsl(prev, next);
    expect(hasStructuralChange(diff)).toBe(false);
    expect(diff.changedIds).toHaveLength(0);
  });

  test('增删元素正确反映在 addedIds / removedIds / subtrees', () => {
    const prev = createLoginPageDslFixture();
    const next = clone(prev);
    // 新增一个元素到 Card 下
    const card = findById(next.tree, 'el-card');
    card.children = [...(card.children ?? []), { id: 'el-new', type: 'Badge', name: 'new' }];
    // 移除 footer
    next.tree.children = (next.tree.children ?? []).filter((c) => c.id !== 'el-footer');
    const diff = diffDsl(prev, next);
    expect(diff.addedIds).toContain('el-new');
    expect(diff.removedIds).toContain('el-footer');
    // subtree 应为新增/移除节点本身（其祖先未变更）
    expect(diff.subtrees).toContain('el-new');
    expect(diff.subtrees).toContain('el-footer');
  });

  test('diffSummary：基于摘要，text 变更不命中（摘要级精度）', () => {
    const prev = createLoginPageDslFixture();
    const next = clone(prev);
    const submit = findById(next.tree, 'el-submit');
    submit.props = { ...(submit.props ?? {}), text: '立即登录' };
    const pSummary = condensePage(prev);
    const nSummary = condensePage(next);
    const diff = diffSummary(pSummary, nSummary);
    // text 不影响 elementIndex 的 type/parentId/boundProps，故摘要级 diff 无变化
    expect(diff.changedIds).toHaveLength(0);
    expect(hasStructuralChange(diff)).toBe(false);
  });
});
