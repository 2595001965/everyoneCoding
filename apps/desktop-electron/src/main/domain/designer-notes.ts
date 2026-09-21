import type Database from 'better-sqlite3';

import {
  NoteRepository,
  documentToText,
  parseNote,
  type ContextNote,
  type CreateNoteInput,
  type Note,
  type NoteContextTarget,
  type NoteFilter,
  type NotePersistencePort,
  type NoteTargetType,
  type UpdateNoteInput,
} from '@ec/designer/notes';

/**
 * 备注（FR-ANN / T4-01）的生产持久化适配。
 *
 * 职责边界：
 * - **领域规则不在这里**：优先级加权（禁止事项恒为 5）、历史留痕、上下文排序、
 *   富文本与清单的展平全部复用 `@ec/designer/notes` 的 `NoteRepository`；
 * - **本文件只做落库映射**：`Note` ↔ `note` 表（列见 `packages/data/migrations/0006_designer_notes.sql`）。
 *
 * 映射口径（两处容易搞混，特此写明）：
 * 1. 备注**类型**（六类：业务规则 / 校验要求 / 交互说明 / 待办 / 疑问 / 禁止事项）落在
 *    `note.note_type`；`note.kind` 是另一套枚举（design|note|comment），固定写 'note'。
 *    这两者在领域里没有对应关系，不要用 `toLegacyNoteKind` 互转。
 * 2. 嵌套结构（富文本正文 / checklist / 代码片段 / 历史版本）整体存 `payload_json`，
 *    可查询的字段（target / type / status / priority / version）独立成列 —— 与
 *    `memory_item.structured` 的存法同源。
 *
 * 一致性策略：每个项目一个 `NoteRepository` 实例并缓存；`load` 只在首次访问时执行，
 * 此后内存副本即权威（所有写入都经由本模块），因此 `getNotesForContext` 能同步回答。
 */

/** `payload_json` 的形状（仅承载嵌套结构，标量字段已在独立列上） */
interface NotePayload {
  content?: unknown;
  checklists?: unknown;
  codeBlocks?: unknown;
  history?: unknown;
}

interface NoteRowShape {
  id: string;
  project_id: string;
  page_id: string | null;
  title: string | null;
  content: string | null;
  created_at: number;
  updated_at: number;
  element_id: string | null;
  target_type: string;
  target_id: string | null;
  note_type: string;
  status: string;
  priority: number;
  manual_priority: number | null;
  version: number;
  resolved_at: number | null;
  created_by: string | null;
  payload_json: string | null;
}

export interface DesignerNoteStore {
  /** 项目内全部备注（按更新时间倒序，与 NoteRepository.list 一致） */
  list(projectId: string, filter?: Omit<NoteFilter, 'projectId'>): Note[];
  /** 新建备注（优先级由领域规则派生） */
  create(input: CreateNoteInput): Note;
  /** 就地修改（版本 +1、历史留痕） */
  update(projectId: string, id: string, patch: UpdateNoteInput): Note | null;
  /** 标记已解决 / 重新打开 */
  setStatus(projectId: string, id: string, status: 'open' | 'resolved'): Note | null;
  /** 物理删除（UI 侧负责二次确认） */
  remove(projectId: string, id: string): boolean;
  /** 未解决备注计数（项目仪表盘角标） */
  unresolvedCount(projectId: string): number;
  /** 上下文注入：元素级 + 所属页面级 + 所属功能级，禁止事项置顶（FR-ANN-06） */
  getNotesForContext(target: NoteContextTarget): ContextNote[];
  /** 生成前判断「备注已更新」（T4-04） */
  noteIdsUpdatedSince(target: NoteContextTarget, since: number): string[];
  /** 某元素的未解决备注数（元素角标） */
  badgeCounts(projectId: string, targetType: NoteTargetType): Record<string, number>;
}

/** 逐行读取（不做仓储缓存）——仓储 `load` 与临时诊断共用 */
function readRows(db: Database.Database, projectId: string): NoteRowShape[] {
  return db
    .prepare(`SELECT * FROM note WHERE project_id = ? ORDER BY updated_at DESC`)
    .all(projectId) as NoteRowShape[];
}

function rowToNote(row: NoteRowShape): Note | null {
  let payload: NotePayload = {};
  if (row.payload_json !== null && row.payload_json.length > 0) {
    try {
      payload = JSON.parse(row.payload_json) as NotePayload;
    } catch {
      payload = {};
    }
  }
  const candidate = {
    id: row.id,
    projectId: row.project_id,
    targetType: row.target_type,
    targetId: row.target_id ?? row.element_id ?? row.page_id ?? row.id,
    type: row.note_type,
    title: row.title ?? '',
    content: payload.content,
    checklists: payload.checklists ?? [],
    codeBlocks: payload.codeBlocks ?? [],
    status: row.status,
    priority: row.priority,
    manualPriority: row.manual_priority,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    createdBy: row.created_by ?? 'user',
    history: payload.history ?? [],
  };
  try {
    return parseNote(candidate);
  } catch {
    // 单行损坏不应让整个项目的备注面板打不开：跳过并交由调用方（UI 显示缺口）
    return null;
  }
}

function noteToRow(note: Note): NoteRowShape {
  return {
    id: note.id,
    project_id: note.projectId,
    page_id: note.targetType === 'page' ? note.targetId : null,
    title: note.title,
    // content 存正文纯文本：让既有基于 content 的检索与人工排查仍然可用
    content: documentToText(note.content),
    created_at: note.createdAt,
    updated_at: note.updatedAt,
    element_id: note.targetType === 'element' ? note.targetId : null,
    target_type: note.targetType,
    target_id: note.targetId,
    note_type: note.type,
    status: note.status,
    priority: note.priority,
    manual_priority: note.manualPriority,
    version: note.version,
    resolved_at: note.resolvedAt,
    created_by: note.createdBy,
    payload_json: JSON.stringify({
      content: note.content,
      checklists: note.checklists,
      codeBlocks: note.codeBlocks,
      history: note.history,
    }),
  };
}

const INSERT_SQL = `
INSERT INTO note (
  id, project_id, page_id, title, content, kind, created_at, updated_at,
  element_id, target_type, target_id, note_type, status, priority,
  manual_priority, version, resolved_at, created_by, payload_json
) VALUES (
  @id, @project_id, @page_id, @title, @content, 'note', @created_at, @updated_at,
  @element_id, @target_type, @target_id, @note_type, @status, @priority,
  @manual_priority, @version, @resolved_at, @created_by, @payload_json
)`;

export function createDesignerNoteStore(options: {
  db: Database.Database;
  userId: string;
}): DesignerNoteStore {
  const { db, userId } = options;
  const repos = new Map<string, NoteRepository>();

  /** 建/取项目仓储：首次访问从 SQLite 装载 */
  const repoOf = (projectId: string): NoteRepository => {
    const cached = repos.get(projectId);
    if (cached !== undefined) return cached;

    const persistence: NotePersistencePort = {
      load: ({ projectId: pid }) =>
        readRows(db, pid)
          .map(rowToNote)
          .filter((note): note is Note => note !== null),
      save: ({ projectId: pid, notes }) => {
        // 整体替换走单事务：备注是项目级小集合（几十条），
        // 逐条 diff 的复杂度换不来收益，而原子性必须保住（不留半写状态）。
        const replace = db.transaction((rows: NoteRowShape[]) => {
          db.prepare(`DELETE FROM note WHERE project_id = ?`).run(pid);
          const insert = db.prepare(INSERT_SQL);
          for (const row of rows) insert.run(row);
        });
        replace(notes.map(noteToRow));
      },
    };

    const repo = new NoteRepository({ projectId, persistence, actor: userId });
    // 同步装载：SQLite 是同步驱动，hydrate 之后本实例即权威副本
    repo.hydrate(
      readRows(db, projectId)
        .map(rowToNote)
        .filter((note): note is Note => note !== null),
    );
    repos.set(projectId, repo);
    return repo;
  };

  return {
    list(projectId, filter = {}) {
      return repoOf(projectId).list(filter);
    },

    create(input) {
      return repoOf(input.projectId).create(input);
    },

    update(projectId, id, patch) {
      const repo = repoOf(projectId);
      if (repo.get(id) === null) return null;
      return repo.update(id, patch, { editor: userId });
    },

    setStatus(projectId, id, status) {
      const repo = repoOf(projectId);
      if (repo.get(id) === null) return null;
      return status === 'resolved'
        ? repo.resolve(id, { editor: userId })
        : repo.reopen(id, { editor: userId });
    },

    remove(projectId, id) {
      const repo = repoOf(projectId);
      if (repo.get(id) === null) return false;
      repo.remove(id);
      return true;
    },

    unresolvedCount(projectId) {
      return repoOf(projectId).unresolvedCount();
    },

    getNotesForContext(target) {
      return repoOf(target.projectId).getNotesForContext(target);
    },

    noteIdsUpdatedSince(target, since) {
      return repoOf(target.projectId).noteIdsUpdatedSince(target, since);
    },

    badgeCounts(projectId, targetType) {
      const map = repoOf(projectId).badgeMap(targetType);
      const counts: Record<string, number> = {};
      for (const [targetId, info] of Object.entries(map)) counts[targetId] = info.count;
      return counts;
    },
  };
}
