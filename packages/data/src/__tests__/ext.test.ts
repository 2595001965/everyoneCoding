import { beforeEach, describe, expect, it } from 'vitest';
import {
  DataClient,
  KeywordSearch,
  Migrator,
  Repository,
  VectorIndex,
  detectFts5,
  detectVec,
  newUlid,
} from '../index';

type Row = Record<string, unknown>;

function insertMemory(repo: Repository<Row>, userId: string, index: number): void {
  const now = Date.now();
  repo.insert({
    id: newUlid(),
    user_id: userId,
    scope: 'project',
    title: `记忆条目 ${index}`,
    content: index % 3 === 0 ? '登录接口需要图形验证码校验' : '普通说明文本',
    tags: JSON.stringify(['demo']),
    source_type: 'manual',
    confidence: 1,
    importance: 3,
    status: 'active',
    pinned: 0,
    version: 1,
    created_at: now,
    updated_at: now,
  });
}

function createUser(client: DataClient): string {
  const users = new Repository<Row>(client.raw, 'user');
  const id = newUlid();
  users.insert({
    id,
    login: `tester-${id.slice(0, 6)}`,
    display_name: '测试用户',
    role: 'owner',
    created_at: Date.now(),
    updated_at: Date.now(),
  });
  return id;
}

describe('扩展能力检测与降级', () => {
  let client: DataClient;
  let userId: string;

  beforeEach(() => {
    client = DataClient.open();
    Migrator.fromDirectory(client.raw).up();
    userId = createUser(client);
  });

  it('FTS5 可用时走 MATCH 检索，中文可命中', () => {
    expect(detectFts5(client.raw)).toBe(true);
    const repo = new Repository<Row>(client.raw, 'memory_item');
    for (let i = 0; i < 30; i += 1) insertMemory(repo, userId, i);

    const search = new KeywordSearch(client.raw);
    expect(search.mode).toBe('fts5');
    expect(search.degradedReason).toBeNull();

    const result = search.search('图形验证码', 10);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]?.score).toBeGreaterThan(0);
  });

  it('FTS5 虚表缺失时自动退化为 LIKE 且不抛错', () => {
    // 构造没有 FTS5 虚表的环境：MATCH 失败后应自动退回 LIKE
    const bare = DataClient.open();
    Migrator.fromDirectory(bare.raw).up(1);
    const bareUserId = createUser(bare);
    bare.exec('DROP TABLE IF EXISTS memory_item_fts');
    const repo = new Repository<Row>(bare.raw, 'memory_item');
    for (let i = 0; i < 9; i += 1) insertMemory(repo, bareUserId, i);

    const search = new KeywordSearch(bare.raw);
    const result = search.search('图形验证码', 10);
    expect(result.hits.length).toBe(3);
    expect(result.mode).toBe('like');
    bare.close();
  });

  it('sqlite-vec 不可用时返回明确原因且检索返回空结果', () => {
    const status = detectVec(client.raw);
    expect(status.available).toBe(false);
    expect(status.reason).toContain('sqlite-vec 不可用');

    const index = new VectorIndex(client.raw, { dimensions: 4 });
    expect(index.available).toBe(false);
    expect(index.search([0.1, 0.2, 0.3, 0.4])).toEqual([]);
    // 不可用时 upsert 静默忽略，不抛错
    expect(() => index.upsert(newUlid(), [0.1, 0.2, 0.3, 0.4])).not.toThrow();
  });
});

describe('批量写入性能基线', () => {
  it('1 万行批量插入在事务内完成并给出耗时', () => {
    const client = DataClient.open();
    Migrator.fromDirectory(client.raw).up();
    const userId = createUser(client);
    const repo = new Repository<Row>(client.raw, 'memory_item');

    const started = Date.now();
    client.raw.transaction(() => {
      for (let i = 0; i < 10000; i += 1) insertMemory(repo, userId, i);
    })();
    const elapsed = Date.now() - started;

    expect(repo.count()).toBe(10000);
    // 仅记录基线，阈值放宽避免机器抖动误报
    expect(elapsed).toBeLessThan(60000);
    // eslint-disable-next-line no-console
    console.info(`[perf] 1 万行批量插入耗时 ${elapsed}ms（事务内）`);
    client.close();
  });
});
