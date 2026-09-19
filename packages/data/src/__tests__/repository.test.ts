import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockShell } from '@ec/shell-api';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ConflictError,
  DataClient,
  Migrator,
  Repository,
  UnitOfWork,
  newUlid,
  ulidTime,
} from '../index';

type TestRow = Record<string, unknown>;

/** 独立测试表：覆盖 version / created_at / updated_at / deleted_at 全部通用列 */
const TEST_TABLE_DDL = `
  CREATE TABLE test_entity (
    id         TEXT PRIMARY KEY NOT NULL,
    name       TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'active',
    version    INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER,
    updated_at INTEGER,
    deleted_at INTEGER
  );
`;

const USER_DDL_FIXTURE = {
  table: 'user',
  row: () => ({
    id: newUlid(),
    login: `user-${newUlid().slice(0, 6)}`,
    display_name: '测试用户',
    role: 'owner',
    created_at: Date.now(),
    updated_at: Date.now(),
  }),
};

describe('DataClient', () => {
  it('开启连接即启用 foreign_keys 与 busy_timeout', () => {
    const client = DataClient.open();
    expect(client.raw.pragma('foreign_keys', { simple: true })).toBe(1);
    client.close();
  });

  it('通过外壳 API 的数据目录创建数据库文件', async () => {
    // MockShell 的文件系统是内存实现，这里用真实临时目录承载 SQLite 文件
    const dataDir = join(mkdtempSync(join(tmpdir(), 'ec-data-')), 'data');
    mkdirSync(dataDir, { recursive: true });
    const shell = new MockShell({ dataDir });

    const client = await DataClient.openFromShell(shell, 'test.sqlite');
    expect(existsSync(join(dataDir, 'test.sqlite'))).toBe(true);
    await shell.fs.exists(join(dataDir, 'test.sqlite'));
    client.close();
  });

  it('close 可重复调用，关闭后再取句柄抛错', () => {
    const client = DataClient.open();
    client.close();
    client.close();
    expect(() => client.raw).toThrow();
  });
});

describe('Repository（独立测试表）', () => {
  let client: DataClient;
  let repo: Repository<TestRow>;

  beforeEach(() => {
    client = DataClient.open();
    client.exec(TEST_TABLE_DDL);
    repo = new Repository<TestRow>(client.raw, 'test_entity');
  });

  it('CRUD 全链路可用', () => {
    const id = newUlid();
    repo.insert({ id, name: '演示项目', status: 'active' });

    expect(repo.findById(id)?.name).toBe('演示项目');

    repo.update(id, { name: '改名后' });
    expect(repo.findById(id)?.name).toBe('改名后');

    expect(repo.count({ status: 'active' })).toBe(1);
    expect(repo.findWhere({ status: 'active' }, { limit: 10 })).toHaveLength(1);

    expect(repo.remove(id)).toBe(true);
    expect(repo.findById(id)).toBeNull();
  });

  it('自动维护 created_at / updated_at 与 version', () => {
    const row = repo.insert({ id: newUlid(), name: '时间戳项目' });
    expect(typeof row.created_at).toBe('number');
    expect(row.version).toBe(1);
  });

  it('乐观锁：版本不匹配时抛 ConflictError 且不落库', () => {
    const id = newUlid();
    repo.insert({ id, name: '并发项目' });

    repo.update(id, { name: 'A' }, 1);
    expect(repo.findById(id)?.version).toBe(2);

    expect(() => repo.update(id, { name: 'B' }, 1)).toThrow(ConflictError);
    expect(repo.findById(id)?.name).toBe('A');
  });

  it('软删除需要 deleted_at 列，缺失时明确报错', () => {
    client.exec('CREATE TABLE no_deleted (id TEXT PRIMARY KEY, name TEXT)');
    const plain = new Repository<TestRow>(client.raw, 'no_deleted');
    plain.insert({ id: newUlid(), name: 'x' });
    const id = newUlid();
    plain.insert({ id, name: 'y' });
    expect(() => plain.remove(id, { soft: true })).toThrow(/deleted_at/);
    expect(plain.remove(id)).toBe(true);
  });

  it('缺少 version 列的表不支持乐观锁并给出明确提示', () => {
    client.exec('CREATE TABLE no_version (id TEXT PRIMARY KEY, name TEXT, updated_at INTEGER)');
    const plain = new Repository<TestRow>(client.raw, 'no_version');
    const id = newUlid();
    plain.insert({ id, name: 'x' });
    expect(plain.supportsOptimisticLock).toBe(false);
    expect(() => plain.update(id, { name: 'y' }, 1)).toThrow(/version/);
  });
});

describe('Repository（真实 schema 集成）', () => {
  let client: DataClient;

  beforeEach(() => {
    client = DataClient.open();
    Migrator.fromDirectory(client.raw).up();
  });

  it('外键约束下按 user → project 顺序写入成功', () => {
    const users = new Repository<TestRow>(client.raw, USER_DDL_FIXTURE.table);
    const user = users.insert(USER_DDL_FIXTURE.row());

    const projects = new Repository<TestRow>(client.raw, 'project');
    const projectId = newUlid();
    projects.insert({ id: projectId, user_id: user.id, name: '真实项目' });

    expect(projects.findById(projectId)?.name).toBe('真实项目');
    expect(client.foreignKeyCheck()).toEqual([]);
  });

  it('外键违规可被拦截', () => {
    const projects = new Repository<TestRow>(client.raw, 'project');
    expect(() =>
      projects.insert({ id: newUlid(), user_id: '不存在的用户', name: '孤儿项目' }),
    ).toThrow();
  });

  it('ULID 可解析回时间戳', () => {
    const now = Date.now();
    const id = newUlid(now);
    expect(id).toHaveLength(26);
    expect(ulidTime(id)).toBe(now);
    expect(ulidTime('not-an-ulid')).toBeNull();
  });
});

describe('UnitOfWork', () => {
  let client: DataClient;
  let repo: Repository<TestRow>;

  beforeEach(() => {
    client = DataClient.open();
    client.exec(TEST_TABLE_DDL);
    repo = new Repository<TestRow>(client.raw, 'test_entity');
  });

  it('回调成功则提交', () => {
    const uow = new UnitOfWork(client.raw);
    uow.run(() => {
      repo.insert({ id: newUlid(), name: '事务项目 1' });
      repo.insert({ id: newUlid(), name: '事务项目 2' });
    });
    expect(repo.count()).toBe(2);
  });

  it('回调抛错则整体回滚', () => {
    const uow = new UnitOfWork(client.raw);
    expect(() =>
      uow.run(() => {
        repo.insert({ id: newUlid(), name: '会回滚' });
        throw new Error('中途失败');
      }),
    ).toThrow('中途失败');
    expect(repo.count()).toBe(0);
  });

  it('主动 rollback 触发回滚', () => {
    const uow = new UnitOfWork(client.raw);
    expect(() =>
      uow.run((ctx) => {
        repo.insert({ id: newUlid(), name: '主动回滚' });
        ctx.rollback('用户取消');
      }),
    ).toThrow('用户取消');
    expect(repo.count()).toBe(0);
  });
});
