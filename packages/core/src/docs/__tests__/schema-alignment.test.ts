/**
 * 跨包字段对齐测试（T9-04 ↔ `@ec/data`）。
 *
 * 文档域**不 import** `@ec/data`，行结构是"手工镜像"。本测试直接解析迁移 SQL，
 * 逐列比对 `document`（0001 基表 + 0005 扩展）/ `doc_version`（0005）/ `memory_doc_link`
 * （0001）三张表 —— 字段一旦漂移立刻红。沿用 Wave 7 注册表做法。
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { DOCUMENT_COLUMNS, DOC_VERSION_COLUMNS, MEMORY_DOC_LINK_COLUMNS } from '../doc-types';

const INIT_SQL = readFileSync(
  new URL('../../../../data/migrations/0001_init.sql', import.meta.url),
  'utf8',
);
const DOCS_SQL = readFileSync(
  new URL('../../../../data/migrations/0005_workspace_docs.sql', import.meta.url),
  'utf8',
);

/** 从 `CREATE TABLE <name> (...)` 抽取列名（跳过约束行与注释） */
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

/** 从 0005 抽取 `ALTER TABLE document ADD COLUMN <col>` 的列名（顺序即落库顺序） */
function addedColumnsOf(sql: string, table: string): string[] {
  const re = new RegExp(`ALTER TABLE ${table} ADD COLUMN (\\w+)`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) out.push(m[1]!);
  return out;
}

describe('T9-04 行结构与 @ec/data 迁移对齐', () => {
  it('document 全列 = 0001 基表列 + 0005 扩展列，且与 DOCUMENT_COLUMNS 一致', () => {
    const base = columnsOf(INIT_SQL, 'document');
    const added = addedColumnsOf(DOCS_SQL, 'document');
    expect([...base, ...added]).toEqual([...DOCUMENT_COLUMNS]);
  });

  it('doc_version 列与 DOC_VERSION_COLUMNS 完全一致且顺序相同', () => {
    expect(columnsOf(DOCS_SQL, 'doc_version')).toEqual([...DOC_VERSION_COLUMNS]);
  });

  it('memory_doc_link 列与 MEMORY_DOC_LINK_COLUMNS 完全一致且顺序相同', () => {
    expect(columnsOf(INIT_SQL, 'memory_doc_link')).toEqual([...MEMORY_DOC_LINK_COLUMNS]);
  });
});
