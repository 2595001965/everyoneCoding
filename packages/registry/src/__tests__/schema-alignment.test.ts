/**
 * 跨包字段对齐测试（Wave 7 ↔ `@ec/data`）。
 *
 * 注册表包**不 import** `@ec/data`（避免 better-sqlite3 进入浏览器构建），
 * 因此行结构是"手工镜像"。本测试直接解析 `@ec/data` 的迁移 SQL，逐列比对
 * `registry_entry` / `occurrence` / `rename_event` 三张表 —— 字段一旦漂移立刻红，
 * 不需要靠人工盯（沿用 Wave 4 的锚点字段对齐做法）。
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { OCCURRENCE_COLUMNS, REGISTRY_ENTRY_COLUMNS, RENAME_EVENT_COLUMNS } from '../index';

const MIGRATION_PATH = new URL('../../../data/migrations/0001_init.sql', import.meta.url);
const SQL = readFileSync(MIGRATION_PATH, 'utf8');

/** 从 `CREATE TABLE <name> (...)` 中抽取列名（跳过约束行） */
function columnsOf(sql: string, table: string): string[] {
  const match = new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`).exec(sql);
  if (match === null) throw new Error(`未在迁移脚本中找到表 ${table}`);
  return (match[1] ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('--'))
    .map((line) => line.split(/\s+/)[0] ?? '')
    .filter((name) => name.length > 0);
}

describe('Wave 7 行结构与 @ec/data 迁移对齐', () => {
  it('registry_entry 列与 REGISTRY_ENTRY_COLUMNS 完全一致且顺序相同', () => {
    expect(columnsOf(SQL, 'registry_entry')).toEqual([...REGISTRY_ENTRY_COLUMNS]);
  });

  it('occurrence 列与 OCCURRENCE_COLUMNS 完全一致且顺序相同', () => {
    expect(columnsOf(SQL, 'occurrence')).toEqual([...OCCURRENCE_COLUMNS]);
  });

  it('rename_event 列与 RENAME_EVENT_COLUMNS 完全一致且顺序相同', () => {
    expect(columnsOf(SQL, 'rename_event')).toEqual([...RENAME_EVENT_COLUMNS]);
  });

  it('三张表的迁移都带 down 段（可回滚）', () => {
    expect(SQL).toContain('DROP TABLE rename_event;');
    expect(SQL).toContain('DROP TABLE occurrence;');
    expect(SQL).toContain('DROP TABLE registry_entry;');
  });
});
