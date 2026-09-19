import type Database from 'better-sqlite3';

import {
  DOCUMENT_COLUMNS,
  DOC_VERSION_COLUMNS,
  MEMORY_DOC_LINK_COLUMNS,
  type DocMemoryLink,
  type DocMemoryNode,
  type DocMemoryPort,
  type DocMemoryScope,
  type DocLinkType,
  type DocSourceRef,
  type DocStore,
  type DocVersionRowSnapshot,
  type DocumentRowSnapshot,
  type MemoryDocLinkRowSnapshot,
} from '@ec/core';
import { ShellError } from '@ec/shell-api';

/**
 * 文档域的 SQLite 适配器：`DocStore` + `DocMemoryPort`。
 *
 * `DocMemoryPort` 为什么在这里实现：它是**文档域自己定义的端口**，要求外壳提供
 * "记忆节点的读写 + 文档-记忆关联"能力。`@ec/memory` 的完整服务（含向量检索、
 * 变更日志、结构化版本）尚未装配，故这里按端口契约直接落 `memory_item` /
 * `memory_doc_link`：
 * - **不做 embedding**——向量检索会跳过这些条目（关键词检索正常），
 *   记忆域装配后应把本实现替换为委托其服务，届时补算向量；
 * - 不写 `memory_change_log`（那张表记录的是记忆侧的结构化变更，非本域职责）。
 */

const DOC_COLUMNS = DOCUMENT_COLUMNS;
const VERSION_COLUMNS = DOC_VERSION_COLUMNS;
const LINK_COLUMNS = MEMORY_DOC_LINK_COLUMNS;

function selectSql(table: string, columns: readonly string[]): string {
  return `SELECT ${columns.join(', ')} FROM ${table}`;
}

export function createSqliteDocStore(db: Database.Database): DocStore {
  return {
    async loadAll(projectId: string): Promise<DocumentRowSnapshot[]> {
      return db
        .prepare(`${selectSql('document', DOC_COLUMNS)} WHERE project_id = ? ORDER BY updated_at DESC`)
        .all(projectId) as DocumentRowSnapshot[];
    },

    async loadById(id: string): Promise<DocumentRowSnapshot | null> {
      const row = db.prepare(`${selectSql('document', DOC_COLUMNS)} WHERE id = ?`).get(id);
      return row === undefined ? null : (row as DocumentRowSnapshot);
    },

    async insert(row: DocumentRowSnapshot): Promise<void> {
      const placeholders = DOC_COLUMNS.map(() => '?').join(', ');
      const values = DOC_COLUMNS.map((column) => row[column] ?? null);
      db.prepare(`INSERT INTO document (${DOC_COLUMNS.join(', ')}) VALUES (${placeholders})`).run(...values);
    },

    async update(id: string, patch: Partial<DocumentRowSnapshot>): Promise<void> {
      const entries = Object.entries(patch).filter(([key]) =>
        (DOC_COLUMNS as readonly string[]).includes(key),
      ) as Array<[string, unknown]>;
      if (entries.length === 0) return;
      const assignments = entries.map(([column]) => `${column} = ?`).join(', ');
      db.prepare(`UPDATE document SET ${assignments} WHERE id = ?`).run(
        ...entries.map(([, value]) => value ?? null),
        id,
      );
    },

    async deleteRow(id: string): Promise<void> {
      const tx = db.transaction((documentId: string) => {
        db.prepare(`DELETE FROM memory_doc_link WHERE document_id = ?`).run(documentId);
        db.prepare(`DELETE FROM doc_version WHERE document_id = ?`).run(documentId);
        db.prepare(`DELETE FROM document WHERE id = ?`).run(documentId);
      });
      tx(id);
    },

    async saveVersion(row: DocVersionRowSnapshot): Promise<void> {
      const placeholders = VERSION_COLUMNS.map(() => '?').join(', ');
      const values = VERSION_COLUMNS.map((column) => row[column] ?? null);
      db.prepare(`INSERT INTO doc_version (${VERSION_COLUMNS.join(', ')}) VALUES (${placeholders})`).run(...values);
    },

    async loadVersions(documentId: string): Promise<DocVersionRowSnapshot[]> {
      return db
        .prepare(`${selectSql('doc_version', VERSION_COLUMNS)} WHERE document_id = ? ORDER BY version DESC`)
        .all(documentId) as DocVersionRowSnapshot[];
    },
  };
}

export interface DocMemoryPortOptions {
  db: Database.Database;
  userId: string;
  newId: () => string;
  clock: () => number;
}

export function createSqliteDocMemoryPort(options: DocMemoryPortOptions): DocMemoryPort {
  const { db, userId, newId, clock } = options;

  const rowToLink = (row: MemoryDocLinkRowSnapshot): DocMemoryLink => ({
    id: row.id,
    memoryId: row.memory_id,
    documentId: row.document_id,
    linkType: row.link_type as DocLinkType,
    createdAt: row.created_at,
  });

  return {
    async listMemoryNodes(projectId: string | null): Promise<DocMemoryNode[]> {
      // projectId 为 null 表示取跨项目节点（长期记忆）；均只看 active
      const rows = (
        projectId === null
          ? db
              .prepare(`SELECT id, scope, title FROM memory_item WHERE project_id IS NULL AND status = 'active' ORDER BY updated_at DESC`)
              .all()
          : db
              .prepare(`SELECT id, scope, title FROM memory_item WHERE project_id = ? AND status = 'active' ORDER BY updated_at DESC`)
              .all(projectId)
      ) as Array<{ id: string; scope: string; title: string }>;
      return rows.map((row) => ({ id: row.id, scope: row.scope as DocMemoryScope, title: row.title }));
    },

    async createMemory(input: {
      projectId: string;
      scope: DocMemoryScope;
      title: string;
      content: string;
      sourceRef?: DocSourceRef | null;
    }): Promise<DocMemoryNode> {
      const id = newId();
      const now = clock();
      db.prepare(
        `INSERT INTO memory_item (id, user_id, scope, project_id, title, content, tags, source_type, source_ref,
           confidence, importance, status, pinned, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, '[]', 'doc', ?, 1.0, 3, 'active', 0, 1, ?, ?)`,
      ).run(
        id,
        userId,
        input.scope,
        input.projectId,
        input.title,
        input.content,
        input.sourceRef ? JSON.stringify(input.sourceRef) : null,
        now,
        now,
      );
      return { id, scope: input.scope, title: input.title };
    },

    async link(input: { memoryId: string; documentId: string; linkType: DocLinkType }): Promise<DocMemoryLink> {
      const existing = db
        .prepare(
          `SELECT ${LINK_COLUMNS.join(', ')} FROM memory_doc_link WHERE memory_id = ? AND document_id = ?`,
        )
        .get(input.memoryId, input.documentId) as MemoryDocLinkRowSnapshot | undefined;
      if (existing) return rowToLink(existing);

      const row: MemoryDocLinkRowSnapshot = {
        id: newId(),
        memory_id: input.memoryId,
        document_id: input.documentId,
        link_type: input.linkType,
        created_at: clock(),
      };
      db.prepare(
        `INSERT INTO memory_doc_link (${LINK_COLUMNS.join(', ')}) VALUES (?, ?, ?, ?, ?)`,
      ).run(row.id, row.memory_id, row.document_id, row.link_type, row.created_at);
      return rowToLink(row);
    },

    async listLinksByDoc(documentId: string): Promise<DocMemoryLink[]> {
      const rows = db
        .prepare(`${selectSql('memory_doc_link', LINK_COLUMNS)} WHERE document_id = ? ORDER BY created_at DESC`)
        .all(documentId) as MemoryDocLinkRowSnapshot[];
      return rows.map(rowToLink);
    },

    async listLinksByMemory(memoryId: string): Promise<DocMemoryLink[]> {
      const rows = db
        .prepare(`${selectSql('memory_doc_link', LINK_COLUMNS)} WHERE memory_id = ? ORDER BY created_at DESC`)
        .all(memoryId) as MemoryDocLinkRowSnapshot[];
      return rows.map(rowToLink);
    },

    async removeLink(id: string): Promise<void> {
      const result = db.prepare(`DELETE FROM memory_doc_link WHERE id = ?`).run(id);
      if (result.changes === 0) throw new ShellError('NOT_FOUND', `关联不存在：${id}`);
    },
  };
}

/** 批量统计每个记忆被多少篇文档引用（记忆卡片「📎 N 篇关联文档」） */
export function countLinksForMemories(db: Database.Database, memoryIds: readonly string[]): Record<string, number> {
  const ids = memoryIds.filter((id) => typeof id === 'string' && id.length > 0);
  if (ids.length === 0) return {};
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT memory_id, COUNT(*) AS n FROM memory_doc_link WHERE memory_id IN (${placeholders}) GROUP BY memory_id`,
    )
    .all(...ids) as Array<{ memory_id: string; n: number }>;
  const out: Record<string, number> = {};
  for (const row of rows) out[row.memory_id] = row.n;
  return out;
}
