import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { seedDatabase, clearSeed } from './seed';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');

/** 从迁移文件中提取 `-- up` 段（到 `-- down` 为止）的 SQL。 */
function upSegment(file: string): string {
  const content = readFileSync(join(migrationsDir, file), 'utf-8');
  const upIdx = content.indexOf('-- up');
  const downIdx = content.indexOf('-- down');
  const end = downIdx === -1 ? content.length : downIdx;
  return content.slice(upIdx + '-- up'.length, end);
}

/**
 * 建库：按文件名顺序执行全部迁移的 up 段。
 *
 * 这里刻意不写死迁移清单 —— 新增迁移（如 0003_ai_provider / 0004_memory）后
 * seed 仍应落在最新 DDL 上，否则种子数据里的新列会找不到，测试会以
 * "no such column" 失败且原因难以定位。
 */
function buildDb(): Database.Database {
  const db = new Database(':memory:');
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();
  for (const file of files) db.exec(upSegment(file));
  return db;
}

function count(db: Database.Database, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
  return row.c;
}

describe('seed 种子数据', () => {
  it('建表 → 播种 → 断言数量 → 清空 → 断言已空', () => {
    const db = buildDb();

    const res = seedDatabase(db);
    expect(res.users).toBe(1);
    expect(res.projects).toBe(2);
    expect(res.features).toBe(2);
    expect(res.pages).toBe(2);
    expect(res.notes).toBe(1);
    expect(res.elements).toBe(1);
    expect(res.documents).toBe(1);
    expect(res.memoryItems).toBe(9);
    expect(res.memoryDocLinks).toBe(1);

    expect(count(db, 'user')).toBe(1);
    expect(count(db, 'project')).toBe(2);
    expect(count(db, 'memory_item')).toBe(9);
    expect(count(db, 'memory_doc_link')).toBe(1);
    expect(count(db, 'document')).toBe(1);

    // FTS 索引应与 memory_item 同步
    expect(count(db, 'memory_item_fts')).toBe(9);
    const hit = db
      .prepare(`SELECT id FROM memory_item_fts WHERE memory_item_fts MATCH ?`)
      .all('商品详情') as { id: string }[];
    expect(hit.length).toBeGreaterThan(0);

    clearSeed(db);
    expect(count(db, 'memory_item')).toBe(0);
    expect(count(db, 'project')).toBe(0);
    expect(count(db, 'user')).toBe(0);
    expect(count(db, 'memory_doc_link')).toBe(0);
    // 清空后 FTS 索引应被触发器同步清空
    expect(count(db, 'memory_item_fts')).toBe(0);

    db.close();
  });
});
