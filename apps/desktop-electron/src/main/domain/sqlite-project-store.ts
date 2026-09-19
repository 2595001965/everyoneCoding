import type Database from 'better-sqlite3';

import type { ProjectRowSnapshot, ProjectStore } from '@ec/core';

/**
 * `ProjectStore` 的 SQLite 实现（`@ec/core` 的 `ProjectService` 只认这个端口）。
 *
 * 与 `@ec/data` 的通用 `Repository` 相比这里手写 SQL：项目表的列在 0005 迁移里
 * 被 ALTER 扩过，字段名与领域快照一一对应，直接映射比绕通用仓储更省事也更少歧义。
 */

/** 可写列白名单（同时用于 insert 与 patch，避免把任意键拼进 SQL） */
const COLUMNS = [
  'id',
  'user_id',
  'workspace_id',
  'name',
  'description',
  'tech_stack_json',
  'status',
  'created_at',
  'updated_at',
  'target_platforms',
  'tech_stack_fingerprint',
  'git_remote',
  'pinned',
  'last_opened_at',
  'deleted_at',
  'source_kind',
  'source_ref',
] as const satisfies readonly (keyof ProjectRowSnapshot)[];

type Column = (typeof COLUMNS)[number];

const SELECT_ALL = `SELECT ${COLUMNS.join(', ')} FROM project`;

export function createSqliteProjectStore(db: Database.Database): ProjectStore {
  const rowToSnapshot = (row: unknown): ProjectRowSnapshot => row as ProjectRowSnapshot;

  return {
    async loadAll(): Promise<ProjectRowSnapshot[]> {
      return (db.prepare(`${SELECT_ALL} ORDER BY updated_at DESC`).all() as unknown[]).map(
        rowToSnapshot,
      );
    },

    async loadById(id: string): Promise<ProjectRowSnapshot | null> {
      const row = db.prepare(`${SELECT_ALL} WHERE id = ?`).get(id);
      return row === undefined ? null : rowToSnapshot(row);
    },

    async insert(row: ProjectRowSnapshot): Promise<void> {
      const placeholders = COLUMNS.map(() => '?').join(', ');
      const values = COLUMNS.map((column) => row[column] ?? null);
      db.prepare(`INSERT INTO project (${COLUMNS.join(', ')}) VALUES (${placeholders})`).run(
        ...values,
      );
    },

    async update(id: string, patch: Partial<ProjectRowSnapshot>): Promise<void> {
      const entries = Object.entries(patch).filter(([key]) =>
        (COLUMNS as readonly string[]).includes(key),
      ) as Array<[Column, unknown]>;
      if (entries.length === 0) return;
      const assignments = entries.map(([column]) => `${column} = ?`).join(', ');
      const values = entries.map(([, value]) => value ?? null);
      db.prepare(`UPDATE project SET ${assignments} WHERE id = ?`).run(...values, id);
    },

    async deleteRow(id: string): Promise<void> {
      // 级联清理：项目下的页面/元素/功能/文档/记忆引用都要先摘掉，否则外键会拦
      const tx = db.transaction((projectId: string) => {
        db.prepare(
          `DELETE FROM element WHERE page_id IN (SELECT id FROM page WHERE project_id = ?)`,
        ).run(projectId);
        db.prepare(`DELETE FROM page WHERE project_id = ?`).run(projectId);
        db.prepare(`DELETE FROM feature WHERE project_id = ?`).run(projectId);
        db.prepare(
          `DELETE FROM memory_doc_link WHERE document_id IN (SELECT id FROM document WHERE project_id = ?)`,
        ).run(projectId);
        db.prepare(
          `DELETE FROM doc_version WHERE document_id IN (SELECT id FROM document WHERE project_id = ?)`,
        ).run(projectId);
        db.prepare(`DELETE FROM document WHERE project_id = ?`).run(projectId);
        db.prepare(`DELETE FROM code_anchor WHERE project_id = ?`).run(projectId);
        db.prepare(`DELETE FROM stage_artifact WHERE project_id = ?`).run(projectId);
        db.prepare(`DELETE FROM pipeline_run WHERE project_id = ?`).run(projectId);
        db.prepare(`DELETE FROM registry_entry WHERE project_id = ?`).run(projectId);
        db.prepare(`DELETE FROM memory_item WHERE project_id = ?`).run(projectId);
        db.prepare(`DELETE FROM project WHERE id = ?`).run(projectId);
      });
      tx(id);
    },
  };
}
