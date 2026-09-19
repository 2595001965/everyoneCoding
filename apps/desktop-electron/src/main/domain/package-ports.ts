import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import type Database from 'better-sqlite3';

import type {
  ExportDocumentMeta,
  ExportMemoryItem,
  ExportProjectMeta,
  ExportSourcePort,
  ImportLocalStatePort,
  ImportTargetPort,
  PackageObject,
  PackageObjectType,
} from '@ec/package-kit';

import { resolveCodeRoot } from './code-root';

/**
 * `@ec/package-kit` 的三个端口的真实实现（归档导出 / 导入）。
 *
 * 存储分工与本仓库既有约定一致：
 * - **元数据**（项目 / 记忆 / 文档）在 SQLite，直接读写 `project` / `memory_item` / `document`；
 * - **工程产物**（代码 / 设计 DSL / 流水线产物 / 锚点 / 注册表）在文件系统，
 *   按 `@ec/core` 的 `WorkspaceLayout` 约定位于 `<projectsDir>/<projectId>/{design,docs,pipeline,code,meta}`。
 *
 * 两处**如实为空**（不编造）：
 * - `listAttachments()` 恒返回 `[]`——附件子系统尚未装配，没有内容寻址文件可导出；
 * - 设计 DSL / 流水线产物 / 锚点 / 注册表在写入端（设计器、流水线持久化）装配前目录为空，
 *   于是导出时自然为空、导入后写回同一位置，**导出→导入→再导出可自洽往返**。
 *
 * 记忆的序列化口径：导出为 `@ec/memory` 的 `MemoryItem` 领域形态（camelCase），
 * 因为 package-kit 的导入侧 `memoryObjectFromItem` 要读 `item.id / content / updatedAt`
 * 来做冲突分类；导入时再映射回 `memory_item` 的列。两侧由本文件保证自洽。
 */

/* ------------------------------- 行 → 领域 ------------------------------- */

interface MemoryRow {
  id: string;
  user_id: string;
  scope: string;
  project_id: string | null;
  feature_id: string | null;
  page_id: string | null;
  element_id: string | null;
  issue_id: string | null;
  title: string;
  content: string;
  structured: string | null;
  tags: string;
  source_type: string;
  source_ref: string | null;
  confidence: number;
  importance: number;
  status: string;
  pinned: number;
  version: number;
  created_at: number;
  updated_at: number;
}

function parseJsonOr<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** `memory_item` 行 → `MemoryItem` 领域 JSON（导入侧按此形态分类冲突） */
function memoryRowToItemJson(row: MemoryRow): string {
  return JSON.stringify({
    id: row.id,
    userId: row.user_id,
    scope: row.scope,
    projectId: row.project_id,
    featureId: row.feature_id,
    pageId: row.page_id,
    elementId: row.element_id,
    issueId: row.issue_id,
    title: row.title,
    content: row.content,
    structured: parseJsonOr<Record<string, unknown> | null>(row.structured, null),
    tags: parseJsonOr<string[]>(row.tags, []),
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    confidence: row.confidence,
    importance: row.importance,
    status: row.status,
    issueStatus: null,
    pinned: row.pinned === 1,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/** 领域 JSON → `memory_item` 列值（宽容：缺字段用默认值，不让脏包炸导入） */
function itemJsonToMemoryColumns(payload: string, fallbackUserId: string): Array<string | number | null> {
  const item = parseJsonOr<Record<string, unknown>>(payload, {});
  const str = (key: string, fallback: string | null = null): string | null =>
    typeof item[key] === 'string' ? (item[key] as string) : fallback;
  const num = (key: string, fallback: number): number =>
    typeof item[key] === 'number' ? (item[key] as number) : fallback;
  const now = Date.now();
  return [
    str('id') ?? `mem-${now}-${Math.random().toString(36).slice(2, 8)}`,
    str('userId') ?? fallbackUserId,
    str('scope') ?? 'project',
    str('projectId'),
    str('featureId'),
    str('pageId'),
    str('elementId'),
    str('issueId'),
    str('title') ?? '未命名记忆',
    str('content') ?? '',
    item['structured'] === undefined || item['structured'] === null ? null : JSON.stringify(item['structured']),
    JSON.stringify(Array.isArray(item['tags']) ? item['tags'] : []),
    str('sourceType') ?? 'manual',
    str('sourceRef'),
    num('confidence', 1),
    num('importance', 3),
    str('status') ?? 'active',
    item['pinned'] === true ? 1 : 0,
    num('version', 1),
    num('createdAt', now),
    num('updatedAt', now),
  ] as Array<string | number | null>;
}

const MEMORY_INSERT_COLUMNS = [
  'id',
  'user_id',
  'scope',
  'project_id',
  'feature_id',
  'page_id',
  'element_id',
  'issue_id',
  'title',
  'content',
  'structured',
  'tags',
  'source_type',
  'source_ref',
  'confidence',
  'importance',
  'status',
  'pinned',
  'version',
  'created_at',
  'updated_at',
] as const;

/* --------------------------------- 公共 -------------------------------- */

export interface PackagePortsOptions {
  db: Database.Database;
  projectsDir: string;
  userId: string;
}

/** 递归列出目录内文件（返回相对路径，正斜杠统一） */
function listFiles(root: string, current = root): string[] {
  if (!existsSync(current)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const full = join(current, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(root, full));
    else out.push(full.slice(root.length + 1).replace(/\\/g, '/'));
  }
  return out;
}

function readTextOrNull(file: string): string | null {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
}

function readBytesOrNull(file: string): Buffer | null {
  try {
    return existsSync(file) ? readFileSync(file) : null;
  } catch {
    return null;
  }
}

/**
 * 在 root 下安全拼接相对路径：拼出来的目标必须仍在 root 之内。
 * 越界（含 `..` 逃逸）返回 null，调用方按"不可读/跳过"处理。
 */
function safeJoin(root: string, ...segments: string[]): string | null {
  const base = join(root);
  const target = join(base, ...segments);
  return target === base || target.startsWith(`${base}${sep}`) ? target : null;
}

/* ------------------------------ 导出源端口 ------------------------------ */

export function createExportSourcePort(options: PackagePortsOptions): ExportSourcePort {
  const { db, projectsDir } = options;
  const projectDir = (projectId: string): string => join(projectsDir, projectId);

  const projectRows = (): Array<{ id: string; name: string; description: string | null; status: string; updated_at: number }> =>
    db
      .prepare(`SELECT id, name, description, status, updated_at FROM project WHERE deleted_at IS NULL`)
      .all() as Array<{ id: string; name: string; description: string | null; status: string; updated_at: number }>;

  return {
    listProjects(): ExportProjectMeta[] {
      return projectRows().map((row) => ({
        id: row.id,
        name: row.name,
        // metaJson 是包内 `projects/<id>/meta.json` 的内容：项目元信息快照
        metaJson: JSON.stringify({
          id: row.id,
          name: row.name,
          description: row.description,
          status: row.status,
          updatedAt: row.updated_at,
        }),
      }));
    },

    listMemory(projectIds, layers): ExportMemoryItem[] {
      const scopeFilter = (
        ['longterm', 'project', 'feature', 'page', 'issue'] as const
      ).filter((scope) => layers[scope]);
      if (scopeFilter.length === 0) return [];

      const placeholders = scopeFilter.map(() => '?').join(', ');
      const params: unknown[] = [...scopeFilter];
      let sql = `SELECT * FROM memory_item WHERE scope IN (${placeholders}) AND status = 'active'`;
      if (projectIds !== null) {
        sql += ` AND (project_id IS NULL OR project_id IN (${projectIds.map(() => '?').join(', ')}))`;
        params.push(...projectIds);
      }

      return (db.prepare(sql).all(...params) as MemoryRow[]).map((row) => ({
        id: row.id,
        layer: row.scope as ExportMemoryItem['layer'],
        projectId: row.project_id,
        updatedAt: row.updated_at,
        json: memoryRowToItemJson(row),
      }));
    },

    listMemoryLinks(projectIds): Array<{ projectId: string; linksJson: string }> {
      const params: unknown[] = [];
      let sql = `SELECT l.id, l.memory_id, l.document_id, l.link_type, l.created_at, d.project_id AS pid
                   FROM memory_doc_link l JOIN document d ON d.id = l.document_id`;
      if (projectIds !== null) {
        sql += ` WHERE d.project_id IN (${projectIds.map(() => '?').join(', ')})`;
        params.push(...projectIds);
      }
      const rows = db.prepare(sql).all(...params) as Array<{
        id: string;
        memory_id: string;
        document_id: string;
        link_type: string;
        created_at: number;
        pid: string;
      }>;
      const byProject = new Map<string, typeof rows>();
      for (const row of rows) {
        const list = byProject.get(row.pid) ?? [];
        list.push(row);
        byProject.set(row.pid, list);
      }
      return [...byProject.entries()].map(([projectId, list]) => ({
        projectId,
        linksJson: JSON.stringify(
          list.map((row) => ({
            id: row.id,
            memoryId: row.memory_id,
            documentId: row.document_id,
            linkType: row.link_type,
            createdAt: row.created_at,
          })),
        ),
      }));
    },

    listDocuments(projectIds): ExportDocumentMeta[] {
      const params: unknown[] = [];
      let sql = `SELECT id, title, project_id, format, updated_at FROM document WHERE deleted_at IS NULL`;
      if (projectIds !== null) {
        sql += ` AND project_id IN (${projectIds.map(() => '?').join(', ')})`;
        params.push(...projectIds);
      }
      const rows = db.prepare(sql).all(...params) as Array<{
        id: string;
        title: string;
        project_id: string;
        format: string;
        updated_at: number;
      }>;
      return rows.map((row) => ({
        id: row.id,
        // name 会被当作包内文件名使用，故带上格式扩展名
        name: `${row.title}.${docExtension(row.format)}`,
        projectId: row.project_id,
        updatedAt: row.updated_at,
      }));
    },

    readDocument(docId, _fileName): { content: Buffer } | null {
      const row = db
        .prepare(`SELECT content_text, content_ref FROM document WHERE id = ?`)
        .get(docId) as { content_text: string | null; content_ref: string | null } | undefined;
      if (!row) return null;
      // 优先取原始文件（docx/pdf 的二进制才是"原文"），没有则用提取正文
      if (row.content_ref) {
        const bytes = readBytesOrNull(row.content_ref);
        if (bytes) return { content: bytes };
      }
      if (row.content_text === null) return null;
      return { content: Buffer.from(row.content_text, 'utf8') };
    },

    listCodeFiles(projectId): string[] {
      return listFiles(resolveCodeRoot(projectDir(projectId)));
    },

    readCodeFile(projectId, relativePath): Buffer | null {
      const target = safeJoin(resolveCodeRoot(projectDir(projectId)), relativePath);
      return target === null ? null : readBytesOrNull(target);
    },

    readAnchors(projectId): string | null {
      return readTextOrNull(join(projectDir(projectId), 'meta', 'anchors.json'));
    },

    listPipelineFiles(projectId): string[] {
      return listFiles(join(projectDir(projectId), 'pipeline'));
    },

    readPipelineFile(projectId, relativePath): Buffer | null {
      return readBytesOrNull(join(projectDir(projectId), 'pipeline', relativePath));
    },

    readRegistry(projectId): string | null {
      return readTextOrNull(join(projectDir(projectId), 'meta', 'registry.json'));
    },

    listDesignPages(projectId): string[] {
      return listFiles(join(projectDir(projectId), 'design', 'pages')).filter((rel) => rel.endsWith('.json'));
    },

    readDesignPage(projectId, fileName): string | null {
      return readTextOrNull(join(projectDir(projectId), 'design', 'pages', fileName));
    },

    listDesignComponents(projectId): string[] {
      return listFiles(join(projectDir(projectId), 'design', 'components')).filter((rel) => rel.endsWith('.json'));
    },

    readDesignComponent(projectId, fileName): string | null {
      return readTextOrNull(join(projectDir(projectId), 'design', 'components', fileName));
    },

    listAttachments(): Array<{ hashName: string; sourcePath: string }> {
      // 附件子系统未装配：如实为空，不编造内容寻址文件
      return [];
    },

    readEcignore(projectId): string | null {
      return readTextOrNull(join(projectDir(projectId), '.ecignore'));
    },
  };
}

function docExtension(format: string): string {
  switch (format) {
    case 'markdown':
      return 'md';
    case 'docx':
      return 'docx';
    case 'pdf':
      return 'pdf';
    case 'image':
      return 'png';
    default:
      return 'txt';
  }
}

/* --------------------------- 导入：本地状态端口 --------------------------- */

export function createImportLocalStatePort(options: PackagePortsOptions): ImportLocalStatePort {
  const { db, projectsDir } = options;

  return {
    listProjects(): Array<{ id: string; name: string; updatedAt: number }> {
      return db.prepare(`SELECT id, name, updated_at FROM project`).all() as Array<{
        id: string;
        name: string;
        updatedAt: number;
      }>;
    },

    /**
     * 本地对象清单（冲突分类用）。
     *
     * 注意 `projectId` 的语义：`runImport` / `buildDiffPreview` 一律传 **null**，
     * 含义是「该类型的**全部**本地对象」，不是「仅跨项目对象」——
     * 若按后者窄化，项目内的记忆/文档会被误判成"包内新增"，导致冲突永远统计不到。
     */
    listObjects(type: PackageObjectType, projectId: string | null): PackageObject[] {
      const projectIds =
        projectId === null
          ? (db.prepare(`SELECT id FROM project`).all() as Array<{ id: string }>).map((row) => row.id)
          : [projectId];

      switch (type) {
        case 'memory': {
          const rows = (
            projectId === null
              ? db.prepare(`SELECT * FROM memory_item`).all()
              : db.prepare(`SELECT * FROM memory_item WHERE project_id = ?`).all(projectId)
          ) as MemoryRow[];
          return rows.map((row) => ({
            id: row.id,
            type: 'memory' as const,
            projectId: row.project_id,
            name: row.content.slice(0, 20),
            updatedAt: row.updated_at,
            payload: memoryRowToItemJson(row),
          }));
        }
        case 'document': {
          const rows = (
            projectId === null
              ? db.prepare(`SELECT id, title, project_id, updated_at FROM document`).all()
              : db.prepare(`SELECT id, title, project_id, updated_at FROM document WHERE project_id = ?`).all(projectId)
          ) as Array<{ id: string; title: string; project_id: string; updated_at: number }>;
          return rows.map((row) => ({
            id: row.id,
            type: 'document' as const,
            projectId: row.project_id,
            name: row.title.slice(0, 20),
            updatedAt: row.updated_at,
            payload: JSON.stringify({ id: row.id, name: row.title, projectId: row.project_id, updatedAt: row.updated_at }),
          }));
        }
        case 'code':
          return projectIds.flatMap((pid) =>
            listFiles(resolveCodeRoot(join(projectsDir, pid))).map((rel) => ({
              id: `code:${pid}:${rel}`,
              type: 'code' as const,
              projectId: pid,
              name: rel,
              updatedAt: 0,
              payload: readTextOrNull(join(resolveCodeRoot(join(projectsDir, pid)), rel)) ?? '',
            })),
          );

        case 'registry':
          return projectIds.flatMap((pid) => {
            const text = readTextOrNull(join(projectsDir, pid, 'meta', 'registry.json'));
            return text === null
              ? []
              : [
                  {
                    id: `registry:${pid}`,
                    type: 'registry' as const,
                    projectId: pid,
                    name: '注册表',
                    updatedAt: 0,
                    payload: text,
                  },
                ];
          });

        case 'anchor':
          return projectIds.flatMap((pid) => {
            const text = readTextOrNull(join(projectsDir, pid, 'meta', 'anchors.json'));
            return text === null
              ? []
              : [
                  {
                    id: `anchors:${pid}`,
                    type: 'anchor' as const,
                    projectId: pid,
                    name: '锚点',
                    updatedAt: 0,
                    payload: text,
                  },
                ];
          });

        case 'design':
          return projectIds.flatMap((pid) =>
            ['pages', 'components'].flatMap((kind) =>
              listFiles(join(projectsDir, pid, 'design', kind))
                .filter((rel) => rel.endsWith('.json'))
                .map((rel) => ({
                  id: rel.replace(/\.json$/, ''),
                  type: 'design' as const,
                  projectId: pid,
                  name: rel.split('/').pop() ?? rel,
                  updatedAt: 0,
                  payload: readTextOrNull(join(projectsDir, pid, 'design', kind, rel)) ?? '',
                })),
            ),
          );

        case 'pipeline':
          return projectIds.flatMap((pid) =>
            listFiles(join(projectsDir, pid, 'pipeline')).map((rel) => ({
              id: rel,
              type: 'pipeline' as const,
              projectId: pid,
              name: rel.split('/').pop() ?? rel,
              updatedAt: 0,
              payload: readTextOrNull(join(projectsDir, pid, 'pipeline', rel)) ?? '',
            })),
          );

        default:
          return [];
      }
    },
  };
}

/* --------------------------- 导入：目标写入端口 --------------------------- */

export function createImportTargetPort(options: PackagePortsOptions): ImportTargetPort {
  const { db, projectsDir, userId } = options;
  const projectDir = (projectId: string): string => join(projectsDir, projectId);

  const ensureDirs = (projectId: string): void => {
    for (const subdir of ['design/pages', 'design/components', 'docs', 'pipeline', 'code', 'meta']) {
      mkdirSync(join(projectDir(projectId), subdir), { recursive: true });
    }
  };

  const writeUnder = (
    projectId: string,
    subdir: string,
    relativePath: string,
    text: string,
  ): 'created' | 'updated' | 'skipped' => {
    const root = join(projectDir(projectId), subdir);
    const target = safeJoin(root, relativePath);
    if (target === null) return 'skipped';
    const existed = existsSync(target);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text, 'utf8');
    return existed ? 'updated' : 'created';
  };

  return {
    upsertProject(meta: { id: string; name: string; metaJson: string }): 'created' | 'updated' {
      const existed = db.prepare(`SELECT 1 AS x FROM project WHERE id = ?`).get(meta.id) !== undefined;
      const parsed = parseJsonOr<{ description?: string | null; status?: string }>(meta.metaJson, {});
      const now = Date.now();
      if (existed) {
        db.prepare(`UPDATE project SET name = ?, description = ?, status = ?, updated_at = ? WHERE id = ?`).run(
          meta.name,
          parsed.description ?? null,
          parsed.status === 'archived' ? 'archived' : 'active',
          now,
          meta.id,
        );
      } else {
        db.prepare(
          `INSERT INTO project (id, user_id, workspace_id, name, description, tech_stack_json, status,
             created_at, updated_at, target_platforms, tech_stack_fingerprint, git_remote, pinned,
             last_opened_at, deleted_at, source_kind, source_ref)
           VALUES (?, ?, NULL, ?, ?, NULL, ?, ?, ?, '[]', NULL, NULL, 0, NULL, NULL, 'blank', NULL)`,
        ).run(
          meta.id,
          userId,
          meta.name,
          parsed.description ?? null,
          parsed.status === 'archived' ? 'archived' : 'active',
          now,
          now,
        );
      }
      ensureDirs(meta.id);
      return existed ? 'updated' : 'created';
    },

    putObject(object: PackageObject): 'created' | 'updated' | 'skipped' {
      const projectId = object.projectId;
      switch (object.type) {
        case 'memory': {
          const columns = itemJsonToMemoryColumns(object.payload, userId);
          const existed = db.prepare(`SELECT 1 AS x FROM memory_item WHERE id = ?`).get(columns[0]) !== undefined;
          const placeholders = MEMORY_INSERT_COLUMNS.map(() => '?').join(', ');
          if (existed) {
            const assignments = MEMORY_INSERT_COLUMNS.slice(1)
              .map((column) => `${column} = ?`)
              .join(', ');
            db.prepare(`UPDATE memory_item SET ${assignments} WHERE id = ?`).run(...columns.slice(1), columns[0]);
          } else {
            db.prepare(
              `INSERT INTO memory_item (${MEMORY_INSERT_COLUMNS.join(', ')}) VALUES (${placeholders})`,
            ).run(...columns);
          }
          if (projectId) ensureDirs(projectId);
          return existed ? 'updated' : 'created';
        }

        case 'document': {
          const meta = parseJsonOr<{ id: string; name: string; updatedAt?: number }>(object.payload, {
            id: object.id,
            name: object.name,
          });
          if (projectId === null) return 'skipped';
          const existed = db.prepare(`SELECT 1 AS x FROM document WHERE id = ?`).get(meta.id) !== undefined;
          const now = Date.now();
          if (existed) {
            db.prepare(`UPDATE document SET title = ?, project_id = ?, updated_at = ? WHERE id = ?`).run(
              meta.name,
              projectId,
              meta.updatedAt ?? now,
              meta.id,
            );
          } else {
            db.prepare(
              `INSERT INTO document (id, project_id, kind, title, content_ref, version, created_at, updated_at,
                 format, content_text, sections_json, source_ref, deleted_at, ignored_version)
               VALUES (?, ?, 'imported', ?, NULL, 1, ?, ?, 'markdown', NULL, NULL, NULL, NULL, NULL)`,
            ).run(meta.id, projectId, meta.name, now, meta.updatedAt ?? now);
          }
          ensureDirs(projectId);
          return existed ? 'updated' : 'created';
        }

        case 'code':
          if (projectId === null) return 'skipped';
          return writeUnder(projectId, 'code', object.name, object.payload);

        case 'design':
          if (projectId === null) return 'skipped';
          // 已知保真度限制：package-kit 的 collectPackageObjects 只给出文件名（basename），
          // 不区分 design/pages 与 design/components，故导入时统一落到 pages。
          // 设计器持久化装配后若需要区分，应改 package-kit 的对象分类，而不是在这里猜。
          return writeUnder(projectId, 'design/pages', object.name, object.payload);

        case 'pipeline':
          if (projectId === null) return 'skipped';
          return writeUnder(projectId, 'pipeline', object.name, object.payload);

        case 'registry':
          if (projectId === null) return 'skipped';
          return writeUnder(projectId, 'meta', 'registry.json', object.payload);

        case 'anchor':
          if (projectId === null) return 'skipped';
          return writeUnder(projectId, 'meta', 'anchors.json', object.payload);

        default:
          return 'skipped';
      }
    },

    putFile(packagePath: string, content: Buffer): 'created' | 'updated' | 'skipped' {
      // 只处理文档原文件；附件（内容寻址）本仓库尚未装配
      const match = /^documents\/([^/]+)\/(.+)$/.exec(packagePath);
      if (!match) return 'skipped';
      const docId = match[1] ?? '';
      const fileName = match[2] ?? '';
      const row = db.prepare(`SELECT project_id FROM document WHERE id = ?`).get(docId) as
        | { project_id: string }
        | undefined;
      if (!row) return 'skipped';

      const target = join(projectDir(row.project_id), 'docs', fileName);
      const existed = existsSync(target);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      // 同时把正文灌进库，导入后立刻可检索（文本格式才有意义，二进制按 UTF-8 尽力而为）
      const text = content.toString('utf8');
      db.prepare(`UPDATE document SET content_text = ?, content_ref = ?, updated_at = ? WHERE id = ?`).run(
        text,
        target,
        Date.now(),
        docId,
      );
      return existed ? 'updated' : 'created';
    },

    applyMemoryMerge(intents: {
      toCreate: Array<{ json: string }>;
      toUpdate: Array<{ json: string }>;
      toSupersede: string[];
    }): { created: number; updated: number; superseded: number } {
      const placeholders = MEMORY_INSERT_COLUMNS.map(() => '?').join(', ');
      const assignments = MEMORY_INSERT_COLUMNS.slice(1)
        .map((column) => `${column} = ?`)
        .join(', ');

      let created = 0;
      let updated = 0;
      const tx = db.transaction(() => {
        for (const intent of intents.toCreate) {
          db.prepare(`INSERT INTO memory_item (${MEMORY_INSERT_COLUMNS.join(', ')}) VALUES (${placeholders})`).run(
            ...itemJsonToMemoryColumns(intent.json, userId),
          );
          created += 1;
        }
        for (const intent of intents.toUpdate) {
          const columns = itemJsonToMemoryColumns(intent.json, userId);
          db.prepare(`UPDATE memory_item SET ${assignments} WHERE id = ?`).run(...columns.slice(1), columns[0]);
          updated += 1;
        }
        for (const id of intents.toSupersede) {
          db.prepare(`UPDATE memory_item SET status = 'superseded', updated_at = ? WHERE id = ?`).run(Date.now(), id);
        }
      });
      tx();
      return { created, updated, superseded: intents.toSupersede.length };
    },
  };
}

/** 供导入完成后按类型统计包内对象数量（`ImportReportData` 只有四分类计数） */
