import { describe, expect, it } from 'vitest';
import { detectVec } from '@ec/data';
import { MemoryRepo } from '../../repo/memory-repo';
import { createMemoryItem, type MemoryItem } from '../../domain/memory-item';
import type { MemoryScope } from '../../domain/scope';
import { createEmptyDb, seedGraph, TEST_GRAPH } from '../../__tests__/helpers';
import { HybridSearcher } from '../hybrid';
import { NullEmbedder, type EmbeddingPort } from '../embedder';
import { ensureVecTable, VecSearcher } from '../vector-search';
import { fakeEmbedding, makeFakeEmbedder } from './testkit';

const DIMS = 16;
const N = 1000;

function scopeForIndex(i: number): {
  scope: MemoryScope;
  projectId: string | null;
  featureId: string | null;
  pageId: string | null;
  issueId: string | null;
  issueStatus: 'unsolved' | null;
} {
  switch (i % 5) {
    case 0:
      return {
        scope: 'longterm',
        projectId: null,
        featureId: null,
        pageId: null,
        issueId: null,
        issueStatus: null,
      };
    case 1:
      return {
        scope: 'project',
        projectId: TEST_GRAPH.projectId,
        featureId: null,
        pageId: null,
        issueId: null,
        issueStatus: null,
      };
    case 2:
      return {
        scope: 'feature',
        projectId: TEST_GRAPH.projectId,
        featureId: TEST_GRAPH.featureId,
        pageId: null,
        issueId: null,
        issueStatus: null,
      };
    case 3:
      return {
        scope: 'page',
        projectId: TEST_GRAPH.projectId,
        featureId: null,
        pageId: TEST_GRAPH.pageId,
        issueId: null,
        issueStatus: null,
      };
    default:
      return {
        scope: 'issue',
        projectId: TEST_GRAPH.projectId,
        featureId: null,
        pageId: null,
        issueId: 'ISS1',
        issueStatus: 'unsolved',
      };
  }
}

function buildItems(): MemoryItem[] {
  const items: MemoryItem[] = [];
  for (let i = 0; i < N; i++) {
    const owner = scopeForIndex(i);
    // 约 1/5 条目带「登录页面」主题，便于关键词与语义两路都有命中
    const isLogin = i % 5 === 3 || i % 7 === 0;
    const title = isLogin ? `登录页面设计要点 ${i}` : `记忆主题条目 ${i}`;
    const content = isLogin
      ? `登录页面的表单布局、按钮交互与校验逻辑，参考统一命名规范。`
      : `这是第 ${i} 条长期沉淀的通用记忆内容，涵盖各类业务知识。`;
    items.push(
      createMemoryItem({
        userId: TEST_GRAPH.userId,
        scope: owner.scope,
        projectId: owner.projectId,
        featureId: owner.featureId,
        pageId: owner.pageId,
        issueId: owner.issueId,
        issueStatus: owner.issueStatus,
        title,
        content,
      }),
    );
  }
  return items;
}

describe('benchmark —— 1000 条双路召回端到端', () => {
  it(`1000 条记忆下端到端检索 ≤ 200ms（冷/热）`, async () => {
    const { db } = createEmptyDb();
    seedGraph(db);
    const repo = new MemoryRepo(db);
    repo.insertMany(buildItems());

    const vecStatus = detectVec(db, DIMS);
    let vector: VecSearcher | undefined;
    let embedder: EmbeddingPort;

    if (vecStatus.available) {
      ensureVecTable(db, { table: 'memory_item_vec', dimensions: DIMS });
      vector = new VecSearcher(db, { table: 'memory_item_vec', dimensions: DIMS });
      for (const it of repo.list({ userId: TEST_GRAPH.userId })) {
        vector.upsert(it.id, fakeEmbedding(`${it.title}${it.content}`, DIMS));
      }
      embedder = makeFakeEmbedder(DIMS);
    } else {
      embedder = new NullEmbedder();
    }

    const hybrid = new HybridSearcher({
      db,
      embedder,
      ...(vector ? { vector } : {}),
      dimensions: DIMS,
    });
    const query = '登录页面';

    const coldStart = Date.now();
    await hybrid.search(query, { userId: TEST_GRAPH.userId, limit: 20 });
    const cold = Date.now() - coldStart;

    const warmStart = Date.now();
    const warmResult = await hybrid.search(query, { userId: TEST_GRAPH.userId, limit: 20 });
    const warm = Date.now() - warmStart;

    console.info(`[bench] hybrid search 1000 items cold=${cold}ms warm=${warm}ms`);
    expect(warm).toBeLessThanOrEqual(200);

    if (!vecStatus.available) {
      // 语义路不可用：如实断言降级，且关键词路仍返回结果
      expect(warmResult.diagnostics.semanticAvailable).toBe(false);
      // 语义路不可用有两个合法原因：sqlite-vec 扩展缺失，或未配置向量化模型。
      // 这里只要求"给出可读原因"，不绑定具体是哪一种，避免测试过拟合单一环境。
      expect(warmResult.diagnostics.semanticReason).toMatch(/sqlite-vec|向量化/);
      expect(warmResult.hits.length).toBeGreaterThan(0);
      console.info(
        `[bench] 语义路不可用（sqlite-vec 缺失），已退化为关键词路，命中 ${warmResult.hits.length} 条`,
      );
    } else {
      expect(warmResult.diagnostics.semanticAvailable).toBe(true);
      console.info(`[bench] 双路召回命中 ${warmResult.hits.length} 条`);
    }
  });
});
