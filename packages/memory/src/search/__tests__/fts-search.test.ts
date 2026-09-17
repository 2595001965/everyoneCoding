import { describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';
import { MemoryRepo } from '../../repo/memory-repo';
import { createEmptyDb, seedGraph, TEST_GRAPH } from '../../__tests__/helpers';
import { FtsKeywordSearcher, segmentQuery } from '../fts-search';

function makeRepo(db: Database): MemoryRepo {
  return new MemoryRepo(db);
}

describe('segmentQuery（简单分词兜底）', () => {
  it('中文 4 字词做二元切分', () => {
    expect(segmentQuery('命名规范')).toEqual(['命名', '名规', '规范']);
  });

  it('中文 2 字词整体保留（bigram 退化为 1 项）', () => {
    expect(segmentQuery('命名')).toEqual(['命名']);
  });

  it('ASCII 单词 / 数字整体保留，不切分', () => {
    expect(segmentQuery('TypeScript')).toEqual(['TypeScript']);
    expect(segmentQuery('vue3')).toEqual(['vue3']);
  });

  it('中英混排：CJK 二元切分 + ASCII 整体保留（不跨边界成 bigram）', () => {
    expect(segmentQuery('使用React')).toEqual(['使用', 'React']);
  });

  it('标点与空白被丢弃，且不跨标点成 bigram', () => {
    // 标点把 CJK 段切成「命名」与「规范」两个独立 run，bigram 不跨标点
    expect(segmentQuery('命名，规范！')).toEqual(['命名', '规范']);
  });
});

describe('FtsKeywordSearcher —— 中文检索与降级', () => {
  it('3 字以上中文查询走 FTS5 MATCH 并命中，返回 snippet 区间', () => {
    const { db } = createEmptyDb();
    seedGraph(db);
    const repo = makeRepo(db);
    repo.create({
      userId: TEST_GRAPH.userId,
      scope: 'project',
      projectId: TEST_GRAPH.projectId,
      title: '命名规范草案',
      content: '我们统一使用命名规范来约束组件命名，避免风格分裂。',
    });

    const searcher = new FtsKeywordSearcher(db);
    expect(searcher.mode).toBe('fts5');

    const hits = searcher.search('命名规范');
    expect(hits.length).toBeGreaterThan(0);
    const first = hits[0];
    expect(first).toBeTruthy();
    expect(first!.snippet.ranges.length).toBeGreaterThan(0);
    // 区间落在 snippet 文本范围内
    for (const range of first!.snippet.ranges) {
      expect(range.start).toBeGreaterThanOrEqual(0);
      expect(range.end).toBeLessThanOrEqual(first!.snippet.text.length);
      expect(range.start).toBeLessThan(range.end);
    }
  });

  it('2 字词触发 bigram LIKE 兜底路径并命中', () => {
    const { db } = createEmptyDb();
    seedGraph(db);
    const repo = makeRepo(db);
    const item = repo.create({
      userId: TEST_GRAPH.userId,
      scope: 'project',
      projectId: TEST_GRAPH.projectId,
      title: '命名约定',
      content: '本项目的命名约定参考行业最佳实践。',
    });

    const searcher = new FtsKeywordSearcher(db);
    // 2 字查询 < trigram 限制的 3 字符，必走 LIKE 兜底
    const hits = searcher.search('命名');
    const ids = hits.map((h) => h.id);
    expect(ids).toContain(item.id);
    // 兜底路径也应给出 snippet
    const hit = hits.find((h) => h.id === item.id);
    expect(hit?.snippet).toBeTruthy();
  });

  it('filterIds 收敛到候选集，范围外不返回', () => {
    const { db } = createEmptyDb();
    seedGraph(db);
    const repo = makeRepo(db);
    const inScope = repo.create({
      userId: TEST_GRAPH.userId,
      scope: 'project',
      projectId: TEST_GRAPH.projectId,
      title: '命名规范总览',
      content: '组件命名规范。',
    });
    repo.create({
      userId: TEST_GRAPH.userId,
      scope: 'project',
      projectId: TEST_GRAPH.otherProjectId,
      title: '命名规范其它项目',
      content: '其它项目的命名规范。',
    });

    const searcher = new FtsKeywordSearcher(db);
    const hits = searcher.search('命名规范', { filterIds: [inScope.id] });
    expect(hits.map((h) => h.id)).toEqual([inScope.id]);
  });

  it('短查询降级与查询抛错时都不抛错，返回空数组而非崩溃', () => {
    const { db } = createEmptyDb();
    seedGraph(db);
    const searcher = new FtsKeywordSearcher(db);
    expect(() => searcher.search('')).not.toThrow();
    expect(() => searcher.search('命名')).not.toThrow();
    expect(searcher.search('')).toEqual([]);
  });
});
