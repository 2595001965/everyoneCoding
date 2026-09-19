import { describe, expect, it } from 'vitest';

import { DependencyGraph } from '../stages/dependency-graph';
import { createSampleSplit, parseSplitFromTechDoc, SplitModel } from '../stages/s4-split';
import { topoSort } from '../stages/topo-sort';

/**
 * T5-05 测试：拆分结构 / 拓扑排序 / 环检测 / 手动调整 / 影响面传播（3 场景）。
 */

describe('topoSort（Kahn 稳定序 + 环检测）', () => {
  it('无依赖时按输入顺序输出', () => {
    const { order, hasCycle, blocked } = topoSort([
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: [] },
      { id: 'c', dependsOn: [] },
    ]);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(hasCycle).toBe(false);
    expect(blocked).toEqual([]);
  });

  it('依赖先于被依赖者输出', () => {
    const { order } = topoSort([
      { id: 'c', dependsOn: ['a', 'b'] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'a', dependsOn: [] },
    ]);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('c'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'));
  });

  it('环检测返回环路并阻断环内节点', () => {
    const { order, hasCycle, blocked, cycles } = topoSort([
      { id: 'a', dependsOn: ['c'] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['b'] },
      { id: 'd', dependsOn: [] },
    ]);
    expect(hasCycle).toBe(true);
    expect(blocked).toEqual(['a', 'b', 'c']);
    expect(order).toEqual(['d']);
    expect(cycles.length).toBeGreaterThan(0);
    const flattened = cycles.flat();
    expect(flattened).toContain('a');
    expect(flattened).toContain('b');
    expect(flattened).toContain('c');
  });

  it('悬空依赖视为已满足（宽容处理）', () => {
    const { order, hasCycle } = topoSort([
      { id: 'a', dependsOn: ['not-exist'] },
      { id: 'b', dependsOn: [] },
    ]);
    expect(hasCycle).toBe(false);
    expect(order).toEqual(['a', 'b']);
  });
});

describe('DependencyGraph（图结构 + 子图 + 影响面传播）', () => {
  it('出边/入边与依赖查询正确', () => {
    const graph = new DependencyGraph<string>();
    graph.addNode('a', 'A');
    graph.addNode('b', 'B');
    graph.addNode('c', 'C');
    graph.addEdge('c', 'a'); // c 依赖 a
    graph.addEdge('c', 'b'); // c 依赖 b
    graph.addEdge('b', 'a'); // b 依赖 a

    expect(graph.dependencies('c')).toEqual(['a', 'b']);
    expect(graph.dependents('a')).toEqual(['c', 'b']);
    expect(graph.nodeData('a')).toBe('A');
    expect(graph.edges()).toHaveLength(3);
  });

  it('allDependents 沿依赖正向传播（含间接）', () => {
    const graph = new DependencyGraph();
    graph.addEdge('d', 'c');
    graph.addEdge('c', 'b');
    graph.addEdge('b', 'a');
    const affected = graph.allDependents('a');
    expect(affected).toEqual(['b', 'c', 'd']);
  });

  it('removeEdge / removeNode 后拓扑重算', () => {
    const graph = new DependencyGraph();
    graph.addEdge('b', 'a');
    graph.removeEdge('b', 'a');
    // 无依赖时节点间相对顺序是实现相关，只断言集合一致
    expect(new Set(graph.topoOrder())).toEqual(new Set(['a', 'b']));
    graph.removeNode('b');
    expect(graph.nodeIds()).toEqual(['a']);
  });

  it('合并节点：被合并节点的边全部改接到新节点', () => {
    const graph = new DependencyGraph();
    graph.addEdge('p1', 'f1'); // 页面 1 属于功能 1
    graph.addEdge('p2', 'f1');
    graph.addEdge('f2', 'f1'); // 功能 2 依赖功能 1
    graph.mergeNodes(['p1', 'p2'], 'f-big', { kind: 'feature', name: '大功能' });
    expect(graph.has('p1')).toBe(false);
    expect(graph.has('p2')).toBe(false);
    expect(graph.has('f-big')).toBe(true);
    expect(graph.dependencies('f-big')).toEqual(['f1']);
    expect(new Set(graph.dependents('f1'))).toEqual(new Set(['f-big', 'f2']));
  });

  it('子图提取只保留内部边', () => {
    const graph = new DependencyGraph();
    graph.addEdge('b', 'a');
    graph.addEdge('c', 'a');
    const sub = graph.subgraph(['a', 'b']);
    expect(sub.nodeIds().sort()).toEqual(['a', 'b']);
    expect(sub.edges()).toEqual([{ from: 'b', to: 'a' }]);
  });
});

describe('parseSplitFromTechDoc（规则解析拆分）', () => {
  const doc = [
    '## 功能：认证（f-auth）',
    '- 依赖：无',
    '### 页面：登录页（p-login）',
    '### 页面：注册页（p-register）',
    '## 功能：订单（f-order）',
    '- 依赖：f-auth',
    '### 页面：订单列表（p-order-list）',
  ].join('\n');

  it('解析出功能树与页面清单，依赖关系正确', () => {
    const { features, pages } = parseSplitFromTechDoc(doc);
    expect(features).toHaveLength(2);
    expect(features[0]).toMatchObject({
      id: 'f-auth',
      name: '认证',
      pageIds: ['p-login', 'p-register'],
      dependsOn: [],
    });
    expect(features[1]).toMatchObject({
      id: 'f-order',
      name: '订单',
      pageIds: ['p-order-list'],
      dependsOn: ['f-auth'],
    });
    expect(pages).toHaveLength(3);
    expect(pages[2]).toMatchObject({ id: 'p-order-list', featureId: 'f-order' });
  });

  it('无功能标题的文档返回空结果', () => {
    const { features, pages } = parseSplitFromTechDoc('# 随便写的文档\n没有结构');
    expect(features).toEqual([]);
    expect(pages).toEqual([]);
  });
});

describe('SplitModel（拆分模型 + 拓扑 + 环 + 影响面）', () => {
  it('样例拆分：5 功能 8 页面，拓扑序正确', () => {
    const sample = createSampleSplit();
    expect(sample.features).toHaveLength(5);
    expect(sample.pages).toHaveLength(8);

    const model = SplitModel.fromResult(sample);
    const order = model.topoOrder();
    // f-auth 必须先于依赖它的 f-user / f-cart / f-order
    expect(order.indexOf('f-auth')).toBeLessThan(order.indexOf('f-user'));
    expect(order.indexOf('f-auth')).toBeLessThan(order.indexOf('f-cart'));
    expect(order.indexOf('f-catalog')).toBeLessThan(order.indexOf('f-cart'));
    expect(model.hasCycle()).toBe(false);
  });

  it('环检测定位环路（功能互依赖）', () => {
    const model = SplitModel.fromResult({
      features: [
        { id: 'f-a', name: 'A', pageIds: [], dependsOn: ['f-b'] },
        { id: 'f-b', name: 'B', pageIds: [], dependsOn: ['f-a'] },
        { id: 'f-c', name: 'C', pageIds: [], dependsOn: [] },
      ],
      pages: [],
    });
    expect(model.hasCycle()).toBe(true);
    const cycles = model.detectCycles();
    const flattened = cycles.flat();
    expect(flattened).toContain('f-a');
    expect(flattened).toContain('f-b');
    expect(flattened).not.toContain('f-c');
  });

  it('手动合并后拓扑重算且环被消除/产生', () => {
    const model = SplitModel.fromResult({
      features: [
        { id: 'f-a', name: 'A', pageIds: ['p-1', 'p-2'], dependsOn: [] },
        { id: 'f-b', name: 'B', pageIds: [], dependsOn: ['f-a'] },
      ],
      pages: [
        { id: 'p-1', name: 'P1', featureId: 'f-a', dependsOn: [], route: null },
        { id: 'p-2', name: 'P2', featureId: 'f-a', dependsOn: [], route: null },
      ],
    });
    // 合并两个页面为一个功能
    model.mergeNodes(['p-1', 'p-2'], { id: 'f-pages', name: '页面组' });
    expect(model.pageCount()).toBe(0);
    expect(model.featureCount()).toBe(3);
    const result = model.result();
    const pages = result.features.find((feature) => feature.id === 'f-pages');
    expect(pages?.pageIds).toEqual(['p-1', 'p-2']);
  });

  it('拆分功能后页面归属迁移到第一个 part', () => {
    const model = SplitModel.fromResult({
      features: [
        { id: 'f-base', name: '基础', pageIds: [], dependsOn: [] },
        { id: 'f-big', name: '大功能', pageIds: ['p-1'], dependsOn: ['f-base'] },
      ],
      pages: [{ id: 'p-1', name: 'P1', featureId: 'f-big', dependsOn: [], route: null }],
    });
    model.splitFeature('f-big', [
      { id: 'f-big-a', name: '大功能A' },
      { id: 'f-big-b', name: '大功能B' },
    ]);
    const result = model.result();
    const page = result.pages.find((candidate) => candidate.id === 'p-1');
    expect(page?.featureId).toBe('f-big-a');
    expect(result.features.map((feature) => feature.id)).toEqual(['f-base', 'f-big-a', 'f-big-b']);
  });

  it('影响面评估场景 1：需求变更影响功能及其页面，沿依赖传播', () => {
    const model = SplitModel.fromResult(createSampleSplit());
    const report = model.evaluateImpact({ type: 'requirement', targets: ['f-auth'] });
    // 归属链补全：功能变更波及所属页面
    expect(report.direct).toContain('f-auth');
    expect(report.direct).toContain('p-login');
    expect(report.direct).toContain('p-register');
    // 传播：f-auth → f-user → f-cart → f-order（f-catalog 不受影响）
    expect(report.affected).toContain('f-user');
    expect(report.affected).toContain('f-cart');
    expect(report.affected).toContain('f-order');
    expect(report.affected).not.toContain('f-catalog');
    // 传播路径存在
    expect(report.paths['f-user']).toEqual(['f-auth', 'f-user']);
  });

  it('影响面评估场景 2：补充需求沿依赖正向传播含间接影响', () => {
    const model = SplitModel.fromResult(createSampleSplit());
    const report = model.evaluateImpact({ type: 'supplement', targets: ['f-user'] });
    expect(report.direct).toContain('f-user');
    // 归属链：f-user 的页面
    expect(report.direct).toContain('p-profile');
    // f-user 被 f-cart / f-order 依赖
    expect(report.affected).toContain('f-cart');
    expect(report.affected).toContain('f-order');
    expect(report.affected).not.toContain('f-auth');
    // 传播顺序：先直接依赖，再间接
    expect(report.affected.indexOf('f-cart')).toBeLessThan(report.affected.indexOf('f-order'));
  });

  it('影响面评估场景 3：重命名页面波及所属功能与依赖它的功能', () => {
    const model = SplitModel.fromResult(createSampleSplit());
    const report = model.evaluateImpact({ type: 'rename', targets: ['p-list'] });
    expect(report.direct).toContain('p-list');
    expect(report.direct).toContain('f-catalog');
    // 归属链：f-catalog 的全部页面
    expect(report.direct).toContain('p-detail');
    // f-cart 依赖 f-catalog → 间接影响；传播路径从 f-catalog 起
    expect(report.affected).toContain('f-cart');
    expect(report.paths['f-cart']).toEqual(['f-catalog', 'f-cart']);
  });

  it('未知目标返回空影响（不报错）', () => {
    const model = SplitModel.fromResult(createSampleSplit());
    const report = model.evaluateImpact({ type: 'rename', targets: ['not-exist'] });
    expect(report.affected).toEqual([]);
  });
});
