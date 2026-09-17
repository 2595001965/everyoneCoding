import { describe, expect, it } from 'vitest';

import { createElement } from '../factory';
import {
  ancestorChain,
  ancestorChainOfPath,
  cloneSubtree,
  collectIds,
  depthOf,
  findById,
  indexPathToJsonPath,
  insertChild,
  insertSibling,
  isDescendant,
  locateAllById,
  locateById,
  mapTree,
  moveNode,
  parentOf,
  pathOf,
  removeNode,
  replaceNode,
  resolveJsonPath,
  visit,
  walkElements,
} from '../traverse';
import type { ElementNode } from '../types';

/** A > (B > (D, E), C) */
function sample(): ElementNode {
  return createElement({
    id: 'A',
    type: 'Container',
    children: [
      createElement({
        id: 'B',
        type: 'Card',
        children: [createElement({ id: 'D', type: 'Text' }), createElement({ id: 'E', type: 'Button' })],
      }),
      createElement({ id: 'C', type: 'Footer' }),
    ],
  });
}

describe('T3-01 遍历与定位', () => {
  it('前序遍历顺序与深度正确', () => {
    const root = sample();
    expect(walkElements(root).map((walked) => walked.node.id)).toEqual(['A', 'B', 'D', 'E', 'C']);
    expect(walkElements(root).map((walked) => walked.depth)).toEqual([0, 1, 2, 2, 1]);
  });

  it('findById / parentOf / depthOf', () => {
    const root = sample();
    expect(findById(root, 'E')?.type).toBe('Button');
    expect(parentOf(root, 'E')?.id).toBe('B');
    expect(parentOf(root, 'A')).toBeNull();
    expect(depthOf(root, 'D')).toBe(2);
    expect(depthOf(root, 'missing')).toBe(-1);
  });

  it('ancestorChain 返回根 → 父（不含自身）', () => {
    const root = sample();
    expect(ancestorChain(root, 'D').map((node) => node.id)).toEqual(['A', 'B']);
    expect(ancestorChain(root, 'A')).toEqual([]);
  });

  it('pathOf 输出 JSON path 且可反向解析回同一节点', () => {
    const root = sample();
    const path = pathOf(root, 'E');
    expect(path).toBe('$.tree.children[0].children[1]');
    expect(resolveJsonPath(root, path as string)).toBe(findById(root, 'E'));
    expect(pathOf(root, 'missing')).toBeNull();
  });

  it('有重复 id 时不串味：首次出现优先，路径可精确寻址', () => {
    const root = createElement({
      id: 'root',
      type: 'Container',
      children: [
        createElement({ id: 'box', type: 'Card', children: [createElement({ id: 'dup', type: 'Text', name: '第一处' })] }),
        createElement({ id: 'box2', type: 'Card', children: [createElement({ id: 'dup', type: 'Text', name: '第二处' })] }),
      ],
    });
    const all = locateAllById(root, 'dup');
    expect(all).toHaveLength(2);
    expect(locateById(root, 'dup')?.node.name).toBe('第一处');
    expect(ancestorChain(root, 'dup').map((node) => node.id)).toEqual(['root', 'box']);
    expect(ancestorChainOfPath(root, all[1]!.indexPath).map((node) => node.id)).toEqual(['root', 'box2']);
    // 两处路径不同，各自解析回自身
    const firstPath = indexPathToJsonPath(all[0]!.indexPath);
    const secondPath = indexPathToJsonPath(all[1]!.indexPath);
    expect(firstPath).not.toBe(secondPath);
    expect(resolveJsonPath(root, firstPath)).toBe(all[0]!.node);
    expect(resolveJsonPath(root, secondPath)).toBe(all[1]!.node);
  });

  it('isDescendant 含自身且排除旁支', () => {
    const root = sample();
    expect(isDescendant(root, 'A', 'D')).toBe(true);
    expect(isDescendant(root, 'B', 'B')).toBe(true);
    expect(isDescendant(root, 'C', 'D')).toBe(false);
    expect(isDescendant(root, 'missing', 'D')).toBe(false);
  });

  it('visit 支持前序 / 后序', () => {
    const root = sample();
    const pre: string[] = [];
    const post: string[] = [];
    visit(root, { enter: (node) => pre.push(node.id) }, 'pre');
    visit(root, { leave: (node) => post.push(node.id) }, 'post');
    expect(pre).toEqual(['A', 'B', 'D', 'E', 'C']);
    expect(post).toEqual(['D', 'E', 'B', 'C', 'A']);
  });
});

describe('T3-01 不可变更新', () => {
  it('replaceNode 返回新树且不改动原树', () => {
    const root = sample();
    const next = replaceNode(root, 'D', (node) => ({ ...node, props: { text: '改了' } }));
    expect(findById(root, 'D')?.props).toBeUndefined();
    expect(findById(next, 'D')?.props).toEqual({ text: '改了' });
  });

  it('removeNode 摘除节点并返回被删子树', () => {
    const root = sample();
    const result = removeNode(root, 'B');
    expect(result.removed?.id).toBe('B');
    expect(collectIds(result.root)).toEqual(['A', 'C']);
  });

  it('insertChild 支持指定下标与追加', () => {
    const root = sample();
    const inserted = insertChild(root, 'B', createElement({ id: 'F', type: 'Image' }), 1);
    expect(collectIds(inserted.root)).toEqual(['A', 'B', 'D', 'F', 'E', 'C']);
    const appended = insertChild(root, 'A', createElement({ id: 'G', type: 'Image' }));
    expect(collectIds(appended.root)).toEqual(['A', 'B', 'D', 'E', 'C', 'G']);
    expect(insertChild(root, 'missing', createElement({ id: 'H', type: 'Image' })).inserted).toBe(false);
  });

  it('insertSibling 支持 before / after', () => {
    const root = sample();
    expect(collectIds(insertSibling(root, 'C', createElement({ id: 'X', type: 'Image' }), 'before').root)).toEqual([
      'A', 'B', 'D', 'E', 'X', 'C',
    ]);
    expect(collectIds(insertSibling(root, 'A', createElement({ id: 'Y', type: 'Image' })).root)).toEqual([
      'A', 'B', 'D', 'E', 'C',
    ]);
  });

  it('moveNode 跨父移动', () => {
    const root = sample();
    const result = moveNode(root, 'E', 'A', 0);
    expect(result.moved).toBe(true);
    expect(collectIds(result.root)).toEqual(['A', 'E', 'B', 'D', 'C']);
  });

  it('moveNode 同父内移动时下标自动补偿', () => {
    const root = createElement({
      id: 'root',
      type: 'Container',
      children: ['a', 'b', 'c'].map((id) => createElement({ id, type: 'Text' })),
    });
    // 把 a 移到下标 2（原意图是放到 c 之后）
    const result = moveNode(root, 'a', 'root', 2);
    expect(result.moved).toBe(true);
    expect(collectIds(result.root)).toEqual(['root', 'b', 'a', 'c']);
  });

  it('moveNode 拒绝拖入自身 / 自身子树', () => {
    const root = sample();
    expect(moveNode(root, 'B', 'B')).toMatchObject({ moved: false, reason: 'cycle' });
    expect(moveNode(root, 'B', 'D')).toMatchObject({ moved: false, reason: 'cycle' });
    expect(moveNode(root, 'nope', 'A')).toMatchObject({ moved: false, reason: 'not-found' });
  });

  it('cloneSubtree 重新分配全部 id', () => {
    const root = sample();
    let counter = 0;
    const clone = cloneSubtree(findById(root, 'B') as ElementNode, () => `new-${(counter += 1)}`);
    expect(collectIds(clone)).toEqual(['new-1', 'new-2', 'new-3']);
    expect(findById(clone, 'D')).toBeNull();
  });

  it('mapTree 结构性映射保留层级', () => {
    const root = sample();
    const mapped = mapTree(root, (node) => ({ ...node, name: `n-${node.id}` }));
    expect(walkElements(mapped).map((walked) => walked.node.name)).toEqual(['n-A', 'n-B', 'n-D', 'n-E', 'n-C']);
  });
});
