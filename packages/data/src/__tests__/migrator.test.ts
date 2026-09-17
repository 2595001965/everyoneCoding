import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { DataClient, Migrator, MigrationError, loadMigrations, parseMigration } from '../index';

const EXPECTED_TABLES = [
  'user',
  'workspace',
  'project',
  'feature',
  'page',
  'element',
  'note',
  'document',
  'memory_doc_link',
  'memory_item',
  'code_anchor',
  'pipeline_run',
  'stage_artifact',
  'provider',
  'model',
  'usage_record',
  'ai_model_config',
  'remote_config_source',
  'registry_entry',
  'occurrence',
  'rename_event',
  'package_job',
  'setting',
  'secure_ref',
];

function tableNames(db: Database.Database): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

describe('迁移框架', () => {
  let client: DataClient;
  let db: Database.Database;

  beforeEach(() => {
    client = DataClient.open();
    db = client.raw;
  });

  it('解析迁移文件：识别 up / down 段与版本号', () => {
    const script = parseMigration(
      ['-- migration: 0007_demo', '-- up', 'CREATE TABLE demo (id TEXT);', '-- down', 'DROP TABLE demo;'].join('\n'),
      '0007_demo',
    );
    expect(script.version).toBe(7);
    expect(script.up).toContain('CREATE TABLE demo');
    expect(script.down).toContain('DROP TABLE demo');
    expect(script.checksum).toHaveLength(8);
  });

  it('缺少 up 段的迁移文件解析即报错', () => {
    expect(() => parseMigration('-- migration: 0008_bad\nDROP TABLE x;', '0008_bad')).toThrow(MigrationError);
  });

  it('执行全部迁移后 22 张表齐备且外键检查通过', () => {
    const migrator = Migrator.fromDirectory(db);
    const result = migrator.up();

    expect(result.applied).toBeGreaterThanOrEqual(2);
    const names = tableNames(db);
    for (const table of EXPECTED_TABLES) {
      expect(names).toContain(table);
    }
    expect(client.foreignKeyCheck()).toEqual([]);
  });

  it('重复执行迁移是幂等的（第二次全部跳过）', () => {
    const migrator = Migrator.fromDirectory(db);
    expect(migrator.up().applied).toBeGreaterThan(0);

    const second = migrator.up();
    expect(second.applied).toBe(0);
    expect(second.skipped).toBeGreaterThanOrEqual(2);

    // status 与 applied 记录一致
    const status = migrator.status();
    expect(status.pending).toHaveLength(0);
    expect(status.currentVersion).toBeGreaterThanOrEqual(2);
    expect(client.foreignKeyCheck()).toEqual([]);
  });

  it('迁移中途失败即回滚，不留半截 schema', () => {
    const broken = [
      ...loadMigrations(),
      {
        version: 999,
        name: '9999_broken',
        up: 'CREATE TABLE should_not_exist (id TEXT PRIMARY KEY);\nTHIS IS NOT SQL;',
        down: 'DROP TABLE should_not_exist;',
        checksum: 'deadbeef',
      },
    ];
    const migrator = new Migrator(db, broken);

    expect(() => migrator.up()).toThrow(MigrationError);
    // 事务回滚：该迁移内的第一条 DDL 也不应残留
    expect(tableNames(db)).not.toContain('should_not_exist');
    // 失败迁移不应被记录为已应用
    expect(migrator.applied().map((r) => r.version)).not.toContain(999);
  });

  it('down 可回退最近一次迁移', () => {
    const migrator = Migrator.fromDirectory(db);
    migrator.up();
    expect(tableNames(db)).toContain('memory_item_fts');

    // 逐条回退到只剩 0001：FTS 虚表与其上层的 AI 表应被撤销，核心表仍在
    let current = migrator.status().currentVersion;
    expect(current).toBeGreaterThanOrEqual(2);
    while (current > 1) {
      migrator.down(1);
      const next = migrator.status().currentVersion;
      expect(next).toBeLessThan(current);
      current = next;
    }

    expect(tableNames(db)).not.toContain('memory_item_fts');
    expect(tableNames(db)).not.toContain('remote_config_source');
    expect(tableNames(db)).toContain('user');
    expect(migrator.status().currentVersion).toBe(1);
  });

  it('checksum 被篡改时可被 verify 检出', () => {
    const migrator = Migrator.fromDirectory(db);
    migrator.up();
    expect(migrator.verify().ok).toBe(true);

    db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 1').run('ffffffff');
    const result = migrator.verify();
    expect(result.ok).toBe(false);
    expect(result.mismatched.length).toBe(1);
  });
});
