import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { detectVec } from '@ec/data';
import { MemoryRepo } from '../../repo/memory-repo';
import { createEmptyDb, seedGraph, TEST_GRAPH } from '../../__tests__/helpers';
import { HybridSearcher } from '../hybrid';
import { NullEmbedder, type EmbeddingPort } from '../embedder';
import { ensureVecTable, VecSearcher } from '../vector-search';
import { fakeEmbedding, makeFakeEmbedder, makeFailingEmbedder } from './testkit';

const DIMS = 8;

function buildSearcher(
  db: Database.Database,
  embedder: EmbeddingPort,
  vector?: VecSearcher,
): HybridSearcher {
  return new HybridSearcher({ db, embedder, ...(vector ? { vector } : {}), dimensions: DIMS });
}

describe('HybridSearcher —— 降级（语义不可用仍返回关键词结果）', () => {
  it('NullEmbedder：semanticAvailable=false，但关键词命中照常返回', async () => {
    const { db } = createEmptyDb();
    seedGraph(db);
    const repo = new MemoryRepo(db);
    const item = repo.create({
      userId: TEST_GRAPH.userId,
      scope: 'project',
      projectId: TEST_GRAPH.projectId,
      title: '命名规范草案',
      content: '统一组件命名规范。',
    });

    const hybrid = buildSearcher(db, new NullEmbedder());
    const result = await hybrid.search('命名规范', { userId: TEST_GRAPH.userId, limit: 10 });
    expect(result.diagnostics.semanticAvailable).toBe(false);
    expect(result.diagnostics.semanticReason).toContain('未配置向量化模型');
    expect(result.diagnostics.keywordMode).toBe('fts5');
    expect(result.hits.map((h) => h.id)).toContain(item.id);
    const hit = result.hits.find((h) => h.id === item.id);
    expect(hit?.matchedBy).toBe('keyword');
    expect(hit?.snippet).not.toBeNull();
    expect(hit?.item?.id).toBe(item.id);
  });

  it('GatewayEmbedder 返回 ok:false：semanticAvailable=false，关键词命中照常返回', async () => {
    const { db } = createEmptyDb();
    seedGraph(db);
    const repo = new MemoryRepo(db);
    const item = repo.create({
      userId: TEST_GRAPH.userId,
      scope: 'project',
      projectId: TEST_GRAPH.projectId,
      title: '组件命名约定',
      content: '命名约定很重要。',
    });

    const hybrid = buildSearcher(db, makeFailingEmbedder('unavailable', '网关未配置'));
    const result = await hybrid.search('命名约定', { userId: TEST_GRAPH.userId, limit: 10 });
    expect(result.diagnostics.semanticAvailable).toBe(false);
    expect(result.hits.map((h) => h.id)).toContain(item.id);
  });
});

describe('HybridSearcher —— 过滤条件生效', () => {
  function seedItems(db: Database.Database): MemoryRepo {
    const repo = new MemoryRepo(db);
    repo.create({
      userId: TEST_GRAPH.userId,
      scope: 'project',
      projectId: TEST_GRAPH.projectId,
      tags: ['vue'],
      title: '命名规范',
      content: 'P1 的命名规范',
    });
    repo.create({
      userId: TEST_GRAPH.userId,
      scope: 'project',
      projectId: TEST_GRAPH.otherProjectId,
      tags: ['react'],
      title: '命名规范',
      content: 'P2 的命名规范',
    });
    repo.create({
      userId: TEST_GRAPH.userId,
      scope: 'longterm',
      tags: ['vue'],
      title: '命名规范',
      content: '长期命名规范',
    });
    repo.create({
      userId: TEST_GRAPH.userId,
      scope: 'project',
      projectId: TEST_GRAPH.projectId,
      tags: ['vue'],
      status: 'archived',
      title: '命名规范',
      content: '已归档的命名规范',
    });
    return repo;
  }

  it('按 scope 过滤只返回对应层', async () => {
    const { db } = createEmptyDb();
    seedGraph(db);
    seedItems(db);
    const hybrid = buildSearcher(db, new NullEmbedder());
    const res = await hybrid.search('命名规范', {
      userId: TEST_GRAPH.userId,
      scopes: ['longterm'],
    });
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0]?.item?.scope).toBe('longterm');
  });

  it('按 projectId 过滤只返回该项目', async () => {
    const { db } = createEmptyDb();
    seedGraph(db);
    seedItems(db);
    const hybrid = buildSearcher(db, new NullEmbedder());
    const res = await hybrid.search('命名规范', {
      userId: TEST_GRAPH.userId,
      projectId: TEST_GRAPH.projectId,
    });
    const scopes = res.hits.map((h) => h.item?.projectId);
    expect(scopes.every((p) => p === TEST_GRAPH.projectId)).toBe(true);
    expect(res.hits.length).toBeGreaterThanOrEqual(2); // 含 archived
  });

  it('按 tags AND 过滤只返回带标签项', async () => {
    const { db } = createEmptyDb();
    seedGraph(db);
    seedItems(db);
    const hybrid = buildSearcher(db, new NullEmbedder());
    const res = await hybrid.search('命名规范', { userId: TEST_GRAPH.userId, tags: ['react'] });
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0]?.item?.projectId).toBe(TEST_GRAPH.otherProjectId);
  });

  it('按 status 过滤排除非活跃项', async () => {
    const { db } = createEmptyDb();
    seedGraph(db);
    seedItems(db);
    const hybrid = buildSearcher(db, new NullEmbedder());
    const res = await hybrid.search('命名规范', {
      userId: TEST_GRAPH.userId,
      projectId: TEST_GRAPH.projectId,
      status: 'active',
    });
    expect(res.hits.every((h) => h.item?.status === 'active')).toBe(true);
    expect(res.hits.every((h) => h.item?.projectId === TEST_GRAPH.projectId)).toBe(true);
  });
});

describe('HybridSearcher —— 双路召回（仅在 sqlite-vec 可用时执行）', () => {
  it('vec + 伪嵌入器：语义可用且 matchedBy 标注 both/semantic', async () => {
    const handle = createEmptyDb();
    const db = handle.db;
    seedGraph(db);
    if (!detectVec(db, DIMS).available) return; // 环境无扩展则跳过

    const repo = new MemoryRepo(db);
    const items = [
      repo.create({
        userId: TEST_GRAPH.userId,
        scope: 'project',
        projectId: TEST_GRAPH.projectId,
        title: '登录页面设计',
        content: '登录页面的表单与按钮布局',
      }),
      repo.create({
        userId: TEST_GRAPH.userId,
        scope: 'project',
        projectId: TEST_GRAPH.projectId,
        title: '注册流程',
        content: '注册的字段校验逻辑',
      }),
      repo.create({
        userId: TEST_GRAPH.userId,
        scope: 'longterm',
        title: '通用命名规范',
        content: '统一的命名规范建议',
      }),
    ];
    ensureVecTable(db, { table: 'memory_item_vec', dimensions: DIMS });
    const vector = new VecSearcher(db, { table: 'memory_item_vec', dimensions: DIMS });
    for (const it of items) vector.upsert(it.id, fakeEmbedding(`${it.title}${it.content}`, DIMS));

    const hybrid = buildSearcher(db, makeFakeEmbedder(DIMS), vector);
    const res = await hybrid.search('登录页面', { userId: TEST_GRAPH.userId, limit: 10 });
    expect(res.diagnostics.semanticAvailable).toBe(true);
    expect(res.hits.length).toBeGreaterThan(0);
    // 与查询语义最接近（"登录页面设计"）应被语义路命中
    const top = res.hits[0];
    expect(top).toBeTruthy();
    expect(['semantic', 'both']).toContain(top!.matchedBy);
  });
});
