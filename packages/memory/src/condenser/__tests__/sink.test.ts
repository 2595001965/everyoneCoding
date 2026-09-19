import { describe, test, expect } from 'vitest';
import { MemoryRepo } from '../../repo/memory-repo';
import { createEmptyDb, seedGraph, TEST_GRAPH } from '../../__tests__/helpers';
import { createLoginPageDslFixture, type PageDsl, type PageDslElement } from '../page-dsl';
import { condensePage } from '../condenser';
import { deriveLayerAssignments } from '../layer-dispatch';
import { hasStructuralChange } from '../diff';
import { StructureCondenser } from '../sink';

function withPageId(dsl: PageDsl): PageDsl {
  return {
    ...dsl,
    id: TEST_GRAPH.pageId,
    projectId: TEST_GRAPH.projectId,
    featureId: TEST_GRAPH.featureId,
  };
}

function findById(node: PageDslElement, id: string): PageDslElement {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findById(child, id);
    if (found.id === id) return found;
  }
  return node;
}

describe('分层归属推导', () => {
  test('含 featureRef 的页面把流程/接口沉到 feature 层，layerOverride 可覆盖', () => {
    const dsl = withPageId(createLoginPageDslFixture());
    const summary = condensePage(dsl);
    const assignments = deriveLayerAssignments(dsl, summary);
    const layers = assignments.map((a) => a.layer);
    expect(layers).toContain('page');
    expect(layers).toContain('project');
    expect(layers).toContain('feature');
    const featureAssignments = assignments.filter((a) => a.layer === 'feature');
    // 登录页引用了 F1、F2 两个功能
    expect(featureAssignments).toHaveLength(2);
    // 每个 feature 归属都携带 featureId，供 sink 写入
    for (const fa of featureAssignments) {
      expect(typeof fa.payload['featureId']).toBe('string');
    }
    // 手动覆盖：全部沉到 project 层
    const overridden = deriveLayerAssignments(dsl, summary, { layerOverride: 'project' });
    expect(overridden.every((a) => a.layer === 'project')).toBe(true);
  });
});

describe('StructureCondenser.sync', () => {
  test('首次同步 diff 为 null，后续改一个元素 diff 仅含该子树', async () => {
    const { db, close } = createEmptyDb();
    seedGraph(db);
    const condenser = new StructureCondenser({
      repo: new MemoryRepo(db),
      userId: TEST_GRAPH.userId,
    });

    const dsl = withPageId(createLoginPageDslFixture());
    const first = await condenser.sync(dsl);
    expect(first.revision).toBe(1);
    expect(first.diff).toBeNull();

    const next = JSON.parse(JSON.stringify(dsl)) as PageDsl;
    const submit = findById(next.tree, 'el-submit');
    submit.props = { ...(submit.props ?? {}), text: '立即登录' };
    const result = await condenser.sync(next);
    expect(result.diff?.changedIds).toEqual(['el-submit']);
    expect(result.diff?.subtrees).toEqual(['el-submit']);
    expect(result.revision).toBe(2);
    close();
  });

  test('连续多次结构变更，revisions 最多保留 5 次', async () => {
    const { db, close } = createEmptyDb();
    seedGraph(db);
    const repo = new MemoryRepo(db);
    const condenser = new StructureCondenser({ repo, userId: TEST_GRAPH.userId });

    const dsl = withPageId(createLoginPageDslFixture());
    const first = await condenser.sync(dsl);
    const pageMemoryId = first.pageMemoryId;

    for (let i = 0; i < 6; i += 1) {
      const varied = JSON.parse(JSON.stringify(dsl)) as PageDsl;
      const pwd = findById(varied.tree, 'el-password');
      pwd.props = { ...(pwd.props ?? {}), placeholder: `请输入密码-${i}` };
      await condenser.sync(varied);
    }

    const revs = repo.revisions.list(pageMemoryId);
    expect(revs.length).toBeLessThanOrEqual(5);
    close();
  });

  test('结构无变化时不再追加 revision', async () => {
    const { db, close } = createEmptyDb();
    seedGraph(db);
    const repo = new MemoryRepo(db);
    const condenser = new StructureCondenser({ repo, userId: TEST_GRAPH.userId });

    const dsl = withPageId(createLoginPageDslFixture());
    const first = await condenser.sync(dsl);
    const again = await condenser.sync(JSON.parse(JSON.stringify(dsl)) as PageDsl);
    expect(again.revision).toBe(first.revision);
    expect(again.diff && hasStructuralChange(again.diff)).toBe(false);
    expect(repo.revisions.list(first.pageMemoryId).length).toBe(1);
    close();
  });
});
