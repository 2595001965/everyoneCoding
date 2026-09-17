import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { detectVec } from '@ec/data';
import { VecSearcher, ensureVecTable } from '../vector-search';

const DIMS = 8;

describe('VecSearcher —— 降级路径', () => {
  it('vec 扩展不可用时 available=false 且 search 返回空数组不抛错', () => {
    const db = new Database(':memory:') as Database.Database;
    const status = detectVec(db, DIMS);
    const searcher = new VecSearcher(db, { dimensions: DIMS });

    expect(searcher.available).toBe(status.available);
    expect(() => searcher.search([0, 1, 2, 3, 4, 5, 6, 7])).not.toThrow();
    expect(searcher.search([0, 1, 2, 3, 4, 5, 6, 7])).toEqual([]);
    expect(() => searcher.upsert('x', [0, 1, 2, 3, 4, 5, 6, 7])).not.toThrow();
    expect(() => searcher.remove('x')).not.toThrow();

    if (!status.available) {
      // 环境确实未提供 sqlite-vec 时，确保降级信息如实且建表函数返回 false
      expect(searcher.reason).not.toBeNull();
      expect(ensureVecTable(db, { table: 'memory_item_vec', dimensions: DIMS })).toBe(false);
    }
  });
});

describe('VecSearcher —— 向量路径（仅在 sqlite-vec 可用时执行）', () => {
  it('upsert / search / 相似度换算正确', () => {
    const db = new Database(':memory:') as Database.Database;
    if (!detectVec(db, DIMS).available) {
      // 环境无 sqlite-vec：跳过而非失败，降级路径已在上方覆盖
      return;
    }

    const ok = ensureVecTable(db, { table: 'memory_item_vec', dimensions: DIMS });
    expect(ok).toBe(true);
    const searcher = new VecSearcher(db, { table: 'memory_item_vec', dimensions: DIMS });
    expect(searcher.available).toBe(true);

    const base = [1, 0, 0, 0, 0, 0, 0, 0];
    const near = [0.9, 0.1, 0, 0, 0, 0, 0, 0];
    const far = [0, 0, 0, 0, 0, 0, 0, 1];
    expect(searcher.upsert('a', base)).toBe(true);
    expect(searcher.upsert('b', near)).toBe(true);
    expect(searcher.upsert('c', far)).toBe(true);
    // 维度不匹配应被忽略而非抛错
    expect(searcher.upsert('d', [0, 1])).toBe(false);

    const hits = searcher.search(near, { limit: 10 });
    expect(hits.length).toBe(3);
    // 最近的应是 'b'（与查询向量几乎相同）
    expect(hits[0]?.id).toBe('b');
    expect(hits[0]?.similarity).toBeGreaterThan(0.9);
    for (const hit of hits) {
      expect(hit.similarity).toBeGreaterThanOrEqual(0);
      expect(hit.similarity).toBeLessThanOrEqual(1);
    }

    searcher.remove('b');
    const after = searcher.search(near, { limit: 10 });
    expect(after.map((h) => h.id)).not.toContain('b');

    // filterIds 收敛
    const filtered = searcher.search(near, { limit: 10, filterIds: ['a'] });
    expect(filtered.map((h) => h.id)).toEqual(['a']);
  });
});
