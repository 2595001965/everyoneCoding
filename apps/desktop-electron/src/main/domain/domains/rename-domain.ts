import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, type Dirent } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import Database from 'better-sqlite3';

import {
  analyzeImpact,
  buildMigrationPreview,
  buildOccurrenceIndex,
  buildRenameCommitMessage,
  buildUnifiedDiff,
  checkName,
  cleanAliases,
  createInMemoryRenameEventStore,
  createRegistryEntry,
  createRegistryRepository,
  executeBatchRename,
  executeMigration,
  executeRename,
  fromOccurrenceRecord,
  fromRenameEventRecord,
  generateMigration,
  isGenerationError,
  newUlid,
  pendingCleanup,
  planBatchRename,
  planNormalization,
  resolveNamingRule,
  toHistoryEntry,
  toOccurrenceRecord,
  toRegistryRecord,
  toRenameEventRecord,
  touchedPaths,
  undoRename,
  type BatchPlan,
  type ConflictCheckResult,
  type ExecutionContext,
  type GeneratedMigration,
  type MigrationLogLine,
  type MigrationPreview,
  type NamingOverride,
  type NamingPlatform,
  type Occurrence,
  type OccurrenceRecord,
  type OccurrenceStore,
  type ProjectionKind,
  type RegistryEntry,
  type RegistryEntryRecord,
  type RegistryRecordStore,
  type RenameEvent,
  type RenameEventRecord,
  type RenameEventStore,
  type RenameTransactionDeps,
  type ResolvedNamingRule,
  type SymbolTable,
} from '@ec/registry';
import { GitClient } from '@ec/git';
import { ShellError } from '@ec/shell-api';

import type { AiStackHandle } from '../domain-factories';
import { createProjectPaths, PROJECT_SUBDIRS, type ProjectPaths } from '../paths';
import type { DomainRouter } from '../runtime';

/**
 * rename 域生产路由（T12-04 重命名部分）。
 *
 * ## 这一版真正接上了什么
 *
 * `@ec/registry` 早已交付注册表 / 出现位置索引 / 影响面 / 事务执行四个引擎，
 * 但此前**没有任何外壳装配**，渲染层的重命名面板只能显示"需要完整影响面引擎"。
 * 本文件把它们接到真实工程上：
 *
 * - 注册表 → `registry_entry` 表；出现位置 → `occurrence` 表
 * - 索引来源 → 真实代码文件（AST 作用域感知）+ `document` / `memory_item` 表 + `design/pages/*.dsl.json`
 * - 事务执行 → 五个执行器全部落到真实文件与真实表，**任一步失败整体回滚**
 *   （执行器写前快照 + 事务临时区备份 + 逆序还原）
 * - 代码栏**只能**经 AST 重构：`buildOccurrenceIndex` 出位置 → `code-ast` 执行器按位置复核后改写，
 *   域内不存在任何"全文替换"的旁路（FR-UNI-06 / E2E-16 的关键）
 *
 * ## 三个刻意的设计取舍
 *
 * 1. **Git 提交是"事后补 sha"**：`RenameTransactionDeps.git.commit` 是**同步**签名，
 *    而真实 `git commit` 必然异步。注入的端口先返回 `null`；事务结束后本域真正执行提交，
 *    再用 `RenameEventStore.setCommitSha` 回填（`rename_event.commit_sha` 因此是真实值）。
 *    提交只包含**代码仓库内**的路径——`<project>/code` 是仓库根，文档与 DSL 不在其中，
 *    这里如实过滤而不是让整次提交失败。
 * 2. **迁移连接来自项目设置**：键 `rename:datasource:<projectId>`，形如
 *    `{"dialect":"sqlite","file":"D:/db/app.db"}`。未配置时返回结构化失败 + 引导文案，
 *    **绝不假装执行成功**（D-08：默认只生成不执行）。
 * 3. **批量计划留在进程内**：`planBatch` 的产物含 `Set`（不可结构化克隆）且体量可能很大，
 *    不适合跨进程往返；`planBatch → runBatch` 之间用进程内暂存表（带过期提示）。
 */

export interface RenameDomainOptions {
  projectsDir: string;
  db: Database.Database;
  userId: string;
  aiStack: AiStackHandle | null;
  /** 非请求来源事件（迁移流式日志） */
  emit: (domain: 'rename', payload: unknown) => void;
}

/** 索引构建的规模上限（性能口径 NFR-P-06：1 万行工程 ≤1.5s） */
const INDEX_LIMITS = {
  maxFiles: 400,
  maxFileBytes: 512 * 1024,
  maxDocs: 60,
  maxMemories: 400,
} as const;

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java']);

const NAMING_PLATFORMS: readonly NamingPlatform[] = [
  'web',
  'android',
  'ios',
  'harmonyos',
  'windows',
  'linux',
  'macos',
];

export function createRenameDomain(options: RenameDomainOptions): DomainRouter {
  const paths: ProjectPaths = createProjectPaths({ projectsDir: options.projectsDir });
  const db = options.db;

  /* ------------------------------ 存储适配 ------------------------------ */

  const registryStore: RegistryRecordStore = {
    upsert(record) {
      db.prepare(
        `INSERT INTO registry_entry (id, project_id, entity_type, entity_id, canonical_name, projections_json, aliases_json, naming_rule_id, name_history_json, sync_state, created_at, updated_at)
         VALUES (@id, @project_id, @entity_type, @entity_id, @canonical_name, @projections_json, @aliases_json, @naming_rule_id, @name_history_json, @sync_state, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           canonical_name = excluded.canonical_name,
           projections_json = excluded.projections_json,
           aliases_json = excluded.aliases_json,
           naming_rule_id = excluded.naming_rule_id,
           name_history_json = excluded.name_history_json,
           sync_state = excluded.sync_state,
           updated_at = excluded.updated_at`,
      ).run(record);
    },
    get(id) {
      const row = db.prepare(`SELECT * FROM registry_entry WHERE id = ?`).get(id);
      return row === undefined ? null : (row as RegistryEntryRecord);
    },
    listByProject(projectId) {
      return db
        .prepare(`SELECT * FROM registry_entry WHERE project_id = ? ORDER BY canonical_name`)
        .all(projectId) as RegistryEntryRecord[];
    },
    delete(id) {
      db.prepare(`DELETE FROM registry_entry WHERE id = ?`).run(id);
    },
  };
  const registry = createRegistryRepository(registryStore);

  const occurrenceStore: OccurrenceStore = {
    replaceForRegistry(registryId, records) {
      const replace = db.transaction((next: readonly OccurrenceRecord[]) => {
        db.prepare(`DELETE FROM occurrence WHERE registry_id = ?`).run(registryId);
        const insert = db.prepare(
          `INSERT INTO occurrence (id, registry_id, kind, ref_path, locator, matched_symbol, confidence, risk_level, status, created_at, updated_at)
           VALUES (@id, @registry_id, @kind, @ref_path, @locator, @matched_symbol, @confidence, @risk_level, @status, @created_at, @updated_at)`,
        );
        for (const record of next) insert.run(record);
      });
      replace(records);
    },
    listByRegistry(registryId) {
      return db
        .prepare(`SELECT * FROM occurrence WHERE registry_id = ?`)
        .all(registryId) as OccurrenceRecord[];
    },
    listByRefPath(refPath) {
      return db
        .prepare(`SELECT * FROM occurrence WHERE ref_path = ?`)
        .all(refPath) as OccurrenceRecord[];
    },
    markStale(refPaths) {
      const update = db.prepare(
        `UPDATE occurrence SET status = 'stale', updated_at = ? WHERE ref_path = ? AND status <> 'stale'`,
      );
      const now = Date.now();
      let count = 0;
      for (const refPath of refPaths) count += update.run(now, refPath).changes;
      return count;
    },
  };

  /**
   * 重命名事件仓库（`rename_event` 表）。
   *
   * `changeset_json` 是撤销的**唯一依据**，所以读写必须保真：序列化/反序列化统一走
   * 领域层的 `toRenameEventRecord` / `fromRenameEventRecord`（内部用 `serializeChangeset`），
   * 自己拼 JSON 会在字段漂移时让"撤销"悄悄失效——而撤销失效通常要到用户点下按钮才发现。
   */
  const eventStore: RenameEventStore = (() => {
    const base = createInMemoryRenameEventStore();
    const rows = db
      .prepare(`SELECT * FROM rename_event ORDER BY created_at DESC LIMIT 500`)
      .all() as RenameEventRecord[];
    for (const row of rows) base.append(fromRenameEventRecord(row));

    const persist = (event: RenameEvent): void => {
      db.prepare(
        `INSERT INTO rename_event (id, project_id, registry_id, old_name, new_name, changeset_json, scope, commit_sha, undone, created_at)
         VALUES (@id, @project_id, @registry_id, @old_name, @new_name, @changeset_json, @scope, @commit_sha, @undone, @created_at)
         ON CONFLICT(id) DO UPDATE SET
           changeset_json = excluded.changeset_json,
           commit_sha = excluded.commit_sha,
           undone = excluded.undone`,
      ).run(toRenameEventRecord(event));
    };

    return {
      append(event) {
        base.append(event);
        persist(event);
      },
      get: (id) => base.get(id),
      list: (projectId) => base.list(projectId),
      markUndone(id) {
        const next = base.markUndone(id);
        if (next !== null) persist(next);
        return next;
      },
      setCommitSha(id, commitSha) {
        const next = base.setCommitSha(id, commitSha);
        if (next !== null) persist(next);
        return next;
      },
    };
  })();

  /* ------------------------------ 工程口径 ------------------------------ */

  const requireProject = (params: Record<string, unknown>): string => {
    const projectId = String(params['projectId'] ?? '');
    if (projectId.length === 0) throw new ShellError('INVALID_ARGUMENT', '缺少 projectId');
    if (!existsSync(paths.projectRoot(projectId))) {
      throw new ShellError('NOT_FOUND', `项目不存在：${projectId}`);
    }
    return projectId;
  };

  /**
   * 解析重命名落点路径。两类输入：
   * ① 执行器给的**仓库相对路径**（`src/pages/Login.tsx`）→ 拼到代码根；
   * ② `backup.ts` 传的**绝对备份路径**（事务临时区）→ 仍必须落在工程根内。
   */
  const resolveRefPath = (projectId: string, refPath: string): string => {
    if (isAbsolute(refPath) || /^[A-Za-z]:/.test(refPath)) {
      const root = paths.projectRoot(projectId);
      if (!paths.contains(root, refPath)) {
        throw new ShellError('PATH_ESCAPE', '重命名落点越出工程根目录，已拒绝');
      }
      return resolve(refPath);
    }
    return paths.inside(paths.codeRoot(projectId), refPath);
  };

  const logicPathOf = (projectId: string, documentId: string): string =>
    join(paths.pagesDir(projectId), `${documentId}.dsl.json`);

  const platformOf = (projectId: string): NamingPlatform => {
    const row = db
      .prepare(`SELECT target_platforms FROM project WHERE id = ?`)
      .get(projectId) as { target_platforms: string | null } | undefined;
    if (row?.target_platforms == null) return 'web';
    const parsed = parseJsonSafe(row.target_platforms);
    if (!Array.isArray(parsed) || parsed.length === 0) return 'web';
    const first = String(parsed[0] ?? 'web');
    return NAMING_PLATFORMS.includes(first as NamingPlatform) ? (first as NamingPlatform) : 'web';
  };

  const overrideOf = (projectId: string): NamingOverride | null => {
    const row = db
      .prepare(`SELECT value_json FROM setting WHERE user_id = ? AND key = ?`)
      .get(options.userId, `rename_override:${projectId}`) as
      | { value_json: string | null }
      | undefined;
    if (row?.value_json == null) return null;
    const parsed = parseJsonSafe(row.value_json);
    return parsed !== null && typeof parsed === 'object' ? (parsed as NamingOverride) : null;
  };

  const ruleOf = (projectId: string): ResolvedNamingRule => {
    const override = overrideOf(projectId);
    return resolveNamingRule({
      platform: platformOf(projectId),
      ...(override !== null ? { override } : {}),
    });
  };

  /* ------------------------------ 索引来源采集 ------------------------------ */

  const collectCodeFiles = (projectId: string): Array<{ path: string; content: string }> => {
    const root = paths.codeRoot(projectId);
    const out: Array<{ path: string; content: string }> = [];
    if (!existsSync(root)) return out;
    const walk = (dir: string, depth: number): void => {
      if (depth > 10 || out.length >= INDEX_LIMITS.maxFiles) return;
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
      } catch {
        return;
      }
      for (const entry of entries) {
        if (out.length >= INDEX_LIMITS.maxFiles) return;
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
          continue;
        }
        const ext = entry.name.slice(entry.name.lastIndexOf('.'));
        if (!CODE_EXTENSIONS.has(ext)) continue;
        try {
          if (statSync(full).size > INDEX_LIMITS.maxFileBytes) continue;
          out.push({ path: paths.relative(root, full), content: readFileSync(full, 'utf8') });
        } catch {
          // 读不到就跳过：索引少一条不影响正确性（执行前还会复核位置）
        }
      }
    };
    walk(root, 0);
    return out;
  };

  const collectDocs = (
    projectId: string,
  ): Array<{ id: string; title: string; content: string; type: 'requirement' | 'tech' | 'related' }> =>
    (
      db
        .prepare(
          `SELECT id, title, kind, content_text, content_ref FROM document WHERE project_id = ? LIMIT ?`,
        )
        .all(projectId, INDEX_LIMITS.maxDocs) as Array<{
        id: string;
        title: string;
        kind: string;
        content_text: string | null;
        content_ref: string | null;
      }>
    ).map((row) => ({
      id: row.id,
      title: row.title,
      type: row.kind === 'requirement' || row.kind === 'tech' ? row.kind : 'related',
      content:
        row.content_text ??
        (row.content_ref !== null ? (readTextSafe(row.content_ref) ?? '') : ''),
    }));

  const collectMemories = (
    projectId: string,
  ): Array<{ id: string; layer: string; title: string; structured: unknown; content: string }> =>
    (
      db
        .prepare(
          `SELECT id, scope, title, structured, content FROM memory_item
           WHERE project_id = ? AND status = 'active' LIMIT ?`,
        )
        .all(projectId, INDEX_LIMITS.maxMemories) as Array<{
        id: string;
        scope: string;
        title: string;
        structured: string | null;
        content: string;
      }>
    ).map((row) => ({
      id: row.id,
      layer: row.scope,
      title: row.title,
      structured: parseJsonSafe(row.structured),
      content: row.content,
    }));

  /** DSL 节点扁平表（含状态变量——八类投影里的 variable 就落在它们身上） */
  interface LogicNodeFlat {
    documentId: string;
    id: string;
    type: string;
    name: string;
    identifier?: string;
    bindings?: string[];
  }

  const collectLogic = (projectId: string): LogicNodeFlat[] => {
    const dir = paths.pagesDir(projectId);
    if (!existsSync(dir)) return [];
    const out: LogicNodeFlat[] = [];
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return out;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.dsl.json')) continue;
      const text = readTextSafe(join(dir, entry));
      if (text === null) continue;
      const parsed = parseJsonSafe(text) as Record<string, unknown> | null;
      if (parsed === null) continue;
      const page = (parsed['page'] ?? parsed) as Record<string, unknown>;
      const documentId = String(page['id'] ?? entry.replace('.dsl.json', ''));
      const push = (raw: unknown): void => {
        if (raw === null || typeof raw !== 'object') return;
        const record = raw as Record<string, unknown>;
        const id = typeof record['id'] === 'string' ? record['id'] : '';
        if (id.length === 0) return;
        const bindingValues = Object.values((record['bindings'] ?? {}) as Record<string, unknown>)
          .filter((value): value is string => typeof value === 'string');
        const flat: LogicNodeFlat = {
          documentId,
          id,
          type: typeof record['type'] === 'string' ? record['type'] : 'Unknown',
          name: typeof record['name'] === 'string' ? record['name'] : id,
        };
        if (bindingValues.length > 0) flat.bindings = bindingValues;
        out.push(flat);
        const children = record['children'];
        if (Array.isArray(children)) for (const child of children) push(child);
      };
      push(page['tree']);

      const state = page['state'];
      if (Array.isArray(state)) {
        for (const item of state) {
          const record = item as Record<string, unknown>;
          const name = typeof record['name'] === 'string' ? record['name'] : '';
          if (name.length === 0) continue;
          out.push({ documentId, id: `state:${name}`, type: 'State', name, identifier: name });
        }
      }
    }
    return out;
  };

  /* ------------------------------ 索引与影响面 ------------------------------ */

  const occurrencesOf = (projectId: string, entry: RegistryEntry): Occurrence[] => {
    /**
     * **增量重建**：把库里的旧索引作为 `previous` 传进去。
     *
     * 为什么必须这么做：出现位置 id 是 ULID，每次重建都会变。而 UI 的流程是
     * `analyze →（用户勾选）→ buildDiff → execute`，**每次都是独立的一次域调用**；
     * 每次重建都换 id 的话，`execute` 拿到的勾选集合一个都匹配不上，
     * 结果是"用户明明勾了 12 处，却提示未勾选任何变更项"。
     * 索引器对键（kind + refPath + locator + symbol）相同的条目**复用原 id**，
     * 这正是这条链路能成立的前提。
     */
    const symbolOf = (matched: ProjectionKind | null): string =>
      matched === null ? entry.canonicalName : (entry.projections[matched] ?? '');
    const previous = occurrenceStore
      .listByRegistry(entry.id)
      .map((record) => fromOccurrenceRecord(record, symbolOf));

    const result = buildOccurrenceIndex({
      registry: entry,
      files: collectCodeFiles(projectId),
      docs: collectDocs(projectId),
      memories: collectMemories(projectId),
      logic: collectLogic(projectId),
      previous,
    });
    for (const warning of result.warnings) console.warn(`[rename] ${warning}`);
    // 出现位置按注册表项整体替换（`occurrence` 表不存符号文本，回读时用投影解回）
    occurrenceStore.replaceForRegistry(entry.id, result.occurrences.map(toOccurrenceRecord));
    return result.occurrences;
  };

  const requireEntry = (projectId: string, registryId: string): RegistryEntry => {
    const entry = registry.get(registryId);
    if (entry === null || entry.projectId !== projectId) {
      throw new ShellError('NOT_FOUND', `注册表项不存在或不属于当前项目：${registryId}`);
    }
    return entry;
  };

  const analyzeFor = (projectId: string, entry: RegistryEntry, newName: string) =>
    analyzeImpact({
      registry: entry,
      newCanonicalName: newName,
      rule: ruleOf(projectId),
      occurrences: occurrencesOf(projectId, entry),
    });

  /* ------------------------------ 执行上下文（真实端口） ------------------------------ */

  const logicCache = new Map<string, { path: string; json: Record<string, unknown> }>();

  const buildContext = (projectId: string, showRevisionMarks: boolean): ExecutionContext => {
    const backupDir = paths.projectDir(projectId, PROJECT_SUBDIRS.meta, 'rename-backups');
    if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });

    return {
      projectId,
      showRevisionMarks,
      backupDir,
      now: Date.now(),
      files: {
        read: (refPath) => readTextSafe(resolveRefPath(projectId, refPath)),
        write: (refPath, content) => writeAtomic(resolveRefPath(projectId, refPath), content),
        exists: (refPath) => {
          try {
            return existsSync(resolveRefPath(projectId, refPath));
          } catch {
            return false;
          }
        },
      },
      docs: {
        read: (documentId) => {
          const row = db
            .prepare(`SELECT content_text, content_ref FROM document WHERE id = ?`)
            .get(documentId) as
            | { content_text: string | null; content_ref: string | null }
            | undefined;
          if (row === undefined) return null;
          if (row.content_text !== null) return row.content_text;
          return row.content_ref === null ? null : readTextSafe(row.content_ref);
        },
        write: (documentId, content) => {
          const row = db
            .prepare(`SELECT content_ref FROM document WHERE id = ?`)
            .get(documentId) as { content_ref: string | null } | undefined;
          db.prepare(
            `UPDATE document SET content_text = ?, version = version + 1, updated_at = ? WHERE id = ?`,
          ).run(content, Date.now(), documentId);
          // 正文文件同步：`content_ref` 是"人打开文件看到的那一份"，
          // 不同步就会出现"文档中心是新名字、磁盘文件还是旧名字"的分裂状态
          if (row?.content_ref != null && row.content_ref.length > 0) {
            try {
              writeAtomic(resolveRefPath(projectId, row.content_ref), content);
            } catch {
              // 文件不在工程内（历史遗留绝对路径）：只更新库内正文，不阻断事务
            }
          }
        },
      },
      memory: {
        read: (itemId) => {
          const row = db
            .prepare(`SELECT structured, content FROM memory_item WHERE id = ?`)
            .get(itemId) as { structured: string | null; content: string } | undefined;
          if (row === undefined) return null;
          return { structured: parseJsonSafe(row.structured), content: row.content };
        },
        setStructured: (itemId, jsonPath, value) => {
          const row = db
            .prepare(`SELECT structured FROM memory_item WHERE id = ?`)
            .get(itemId) as { structured: string | null } | undefined;
          if (row === undefined) return;
          const root = (parseJsonSafe(row.structured) ?? {}) as Record<string, unknown>;
          if (!setLeaf(root, jsonPath, value)) return;
          db.prepare(`UPDATE memory_item SET structured = ?, updated_at = ? WHERE id = ?`).run(
            JSON.stringify(root),
            Date.now(),
            itemId,
          );
        },
        replaceInContent: (itemId, from, to, occurrenceIndex) => {
          const row = db
            .prepare(`SELECT content FROM memory_item WHERE id = ?`)
            .get(itemId) as { content: string } | undefined;
          if (row === undefined) return;
          db.prepare(`UPDATE memory_item SET content = ?, updated_at = ? WHERE id = ?`).run(
            replaceNth(row.content, from, to, occurrenceIndex),
            Date.now(),
            itemId,
          );
        },
        restore: (itemId, snapshot) => {
          db.prepare(
            `UPDATE memory_item SET structured = ?, content = ?, updated_at = ? WHERE id = ?`,
          ).run(
            snapshot.structured === undefined ? null : JSON.stringify(snapshot.structured),
            snapshot.content,
            Date.now(),
            itemId,
          );
        },
      },
      logic: {
        readDocument: (documentId) => {
          const path = logicPathOf(projectId, documentId);
          const text = readTextSafe(path);
          if (text === null) return null;
          const parsed = parseJsonSafe(text) as Record<string, unknown> | null;
          if (parsed === null) return null;
          logicCache.set(documentId, { path, json: parsed });
          return JSON.parse(text) as unknown;
        },
        rename: (input) => {
          const cached = logicCache.get(input.documentId);
          if (cached === undefined) throw new Error(`DSL 文档未加载：${input.documentId}`);
          const page = (cached.json['page'] ?? cached.json) as Record<string, unknown>;
          const node = findNodes(page['tree']).find((item) => item['id'] === input.nodeId);
          if (node === undefined) throw new Error(`DSL 节点不存在：${input.nodeId}`);
          switch (input.field) {
            case 'name': {
              node['name'] = input.to;
              break;
            }
            case 'identifier': {
              // 状态变量的"标识符"就是它的 name；同时把引用它的绑定路径一起改掉，
              // 否则改完名字会出现"状态变量改了、绑定还指着旧键"的悬空引用
              const state = page['state'];
              if (Array.isArray(state)) {
                for (const item of state) {
                  const record = item as Record<string, unknown>;
                  if (record['name'] === input.from) record['name'] = input.to;
                }
              }
              const bindings = (node['bindings'] ?? {}) as Record<string, unknown>;
              for (const [key, value] of Object.entries(bindings)) {
                if (typeof value === 'string' && value.includes(input.from)) {
                  bindings[key] = value.split(input.from).join(input.to);
                }
              }
              node['bindings'] = bindings;
              break;
            }
            case 'binding': {
              const bindings = (node['bindings'] ?? {}) as Record<string, unknown>;
              for (const [key, value] of Object.entries(bindings)) {
                if (value === input.from) bindings[key] = input.to;
              }
              node['bindings'] = bindings;
              break;
            }
            case 'action': {
              const actions = node['actions'];
              if (Array.isArray(actions)) {
                node['actions'] = actions.map((item) => (item === input.from ? input.to : item));
              } else {
                node['actionTarget'] = input.to;
              }
              break;
            }
            default:
              throw new Error(`未知的 DSL 承载字段：${String(input.field)}`);
          }
          writeAtomic(cached.path, `${JSON.stringify(cached.json, null, 2)}\n`);
        },
        recalcSummary: () => {
          // 逻辑结构摘要由设计器在下次打开时按 DSL 重算（T2-06）。
          // 这里不"顺手重算"：摘要口径属于设计器，越界重算会引入两份不一致的真相。
        },
        restore: (documentId, snapshot) => {
          if (snapshot === null || snapshot === undefined) return;
          writeAtomic(logicPathOf(projectId, documentId), `${JSON.stringify(snapshot, null, 2)}\n`);
          logicCache.delete(documentId);
        },
      },
      anchors: {
        read: (anchorId) => {
          const row = db
            .prepare(`SELECT symbol FROM code_anchor WHERE id = ?`)
            .get(anchorId) as { symbol: string | null } | undefined;
          return row?.symbol ?? null;
        },
        update: (anchorId, to) => {
          db.prepare(`UPDATE code_anchor SET symbol = ?, updated_at = ? WHERE id = ?`).run(
            to,
            Date.now(),
            anchorId,
          );
        },
        restore: (anchorId, from) => {
          db.prepare(`UPDATE code_anchor SET symbol = ?, updated_at = ? WHERE id = ?`).run(
            from,
            Date.now(),
            anchorId,
          );
        },
        findBySymbol: (symbol) =>
          (
            db
              .prepare(`SELECT id FROM code_anchor WHERE project_id = ? AND symbol = ?`)
              .all(projectId, symbol) as Array<{ id: string }>
          ).map((row) => row.id),
      },
    };
  };

  /**
   * Git 提交端口（同步签名 → 只登记意图）。
   * 真正的提交由 `commitRename` 在事务结束后执行并回填 sha（见文件头取舍 1）。
   */
  const pendingCommit: { message: string; paths: readonly string[] } = { message: '', paths: [] };
  const gitPort = {
    commit(input: { message: string; paths: readonly string[] }): string | null {
      pendingCommit.message = input.message;
      pendingCommit.paths = [...input.paths];
      return null;
    },
  };

  const commitRename = async (
    projectId: string,
    message: string,
    refPaths: readonly string[],
  ): Promise<string | null> => {
    const codeRoot = paths.codeRoot(projectId);
    if (!existsSync(codeRoot) || refPaths.length === 0) return null;
    // 只提交落在代码仓库内的路径：仓库根是 `<project>/code`，
    // 文档（`<project>/docs`）与 DSL（`<project>/design`）不在仓库里。
    const inside: string[] = [];
    for (const refPath of refPaths) {
      try {
        if (existsSync(paths.inside(codeRoot, refPath))) inside.push(refPath);
      } catch {
        // 越界或不存在：跳过
      }
    }
    if (inside.length === 0) return null;
    try {
      const client = await GitClient.create({ repoPath: codeRoot });
      const staged = await client.stage(inside);
      if (!staged.ok) return null;
      const committed = await client.commit({ subject: message });
      return committed.ok ? (committed.data ?? null) : null;
    } catch {
      return null;
    }
  };

  const depsOf = (projectId: string, showRevisionMarks: boolean): RenameTransactionDeps => ({
    context: buildContext(projectId, showRevisionMarks),
    rule: ruleOf(projectId),
    registry: { save: (entry) => void registry.save(entry) },
    git: gitPort,
    events: eventStore,
  });

  /* ------------------------------ 迁移 ------------------------------ */

  const pendingMigrations = new Map<string, { migration: GeneratedMigration; preview: MigrationPreview }>();

  const generateMigrationFor = async (
    projectId: string,
    input: Record<string, unknown>,
  ): Promise<MigrationPreview | { error: string; guidance: string }> => {
    if (options.aiStack === null) {
      return {
        error: 'AI 栈未装配，无法生成迁移脚本',
        guidance: '请在设置页配置 Provider 与 API Key 后重试（D-08：DDL 只能由 AI 生成）。',
      };
    }
    const request = {
      dialect: (['sqlite', 'mysql', 'postgres'].includes(String(input['dialect']))
        ? String(input['dialect'])
        : 'sqlite') as 'sqlite' | 'mysql' | 'postgres',
      table: String(input['table'] ?? ''),
      oldColumn: String(input['oldColumn'] ?? ''),
      newColumn: String(input['newColumn'] ?? ''),
      columnType: typeof input['columnType'] === 'string' ? input['columnType'] : null,
      nullable: typeof input['nullable'] === 'boolean' ? input['nullable'] : null,
      dependents: Array.isArray(input['dependents']) ? (input['dependents'] as string[]) : [],
      estimatedRows: null,
    };
    if (request.table.length === 0 || request.oldColumn.length === 0 || request.newColumn.length === 0) {
      throw new ShellError('INVALID_ARGUMENT', '表名与新旧字段名不能为空');
    }
    const gateway = options.aiStack.gateway;
    const generated = await generateMigration({
      request,
      id: newUlid(),
      model: {
        async complete(prompt: string): Promise<string> {
          let text = '';
          for await (const chunk of gateway.chat({
            userId: options.userId,
            purpose: 'migration',
            projectId,
            messages: [{ role: 'user', content: prompt }],
          })) {
            if (chunk.type === 'chunk' && typeof chunk.text === 'string') text += chunk.text;
            if (chunk.type === 'error') throw new Error(String(chunk['error'] ?? '模型调用失败'));
          }
          return text;
        },
      },
    });
    if (isGenerationError(generated)) {
      return { error: generated.reason, guidance: generated.guidance };
    }
    const preview = await buildMigrationPreview({ migration: generated });
    pendingMigrations.set(preview.migrationId, { migration: generated, preview });
    return preview;
  };

  const datasourceOf = (projectId: string): { dialect: string; file: string } | null => {
    const row = db
      .prepare(`SELECT value_json FROM setting WHERE user_id = ? AND key = ?`)
      .get(options.userId, `rename:datasource:${projectId}`) as
      | { value_json: string | null }
      | undefined;
    if (row?.value_json == null) return null;
    const parsed = parseJsonSafe(row.value_json) as Record<string, unknown> | null;
    if (parsed === null) return null;
    return { dialect: String(parsed['dialect'] ?? ''), file: String(parsed['file'] ?? '') };
  };

  /* ------------------------------ 批量计划暂存 ------------------------------ */

  const batchPlans = new Map<string, BatchPlan>();

  /* ------------------------------ 路由 ------------------------------ */

  const router: DomainRouter = async (method, params) => {
    switch (method) {
      case 'openProject': {
        const projectId = requireProject(params);
        return { projectId, count: registryStore.listByProject(projectId).length };
      }

      case 'projectContext': {
        const projectId = requireProject(params);
        const nameRow = db
          .prepare(`SELECT name FROM project WHERE id = ?`)
          .get(projectId) as { name: string } | undefined;
        return {
          projectId,
          projectName: nameRow?.name ?? projectId,
          platform: platformOf(projectId),
          override: overrideOf(projectId),
        };
      }

      case 'resolveRule':
        return ruleOf(requireProject(params));

      case 'symbolTable': {
        const projectId = requireProject(params);
        const table = registry.symbolTable(projectId);
        return {
          frontend: [...table.frontend],
          backend: [...table.backend],
          database: [...table.database],
        } satisfies SymbolTable;
      }

      case 'listTargets': {
        const projectId = requireProject(params);
        return registry.listByProject(projectId).map((entry) => ({
          registryId: entry.id,
          entityType: entry.entityType,
          entityId: entry.entityId,
          canonicalName: entry.canonicalName,
          projections: entry.projections,
          aliases: entry.aliases,
          syncState: entry.syncState,
          ownerName: ownerNameOf(db, entry),
        }));
      }

      case 'check': {
        const projectId = requireProject(params);
        const entry = requireEntry(projectId, String(params['registryId'] ?? ''));
        return checkName({
          canonicalName: String(params['newName'] ?? ''),
          entityType: entry.entityType,
          rule: ruleOf(projectId),
          symbols: registry.symbolTable(projectId),
          exclude: [entry.canonicalName],
        }) satisfies ConflictCheckResult;
      }

      case 'analyze': {
        const projectId = requireProject(params);
        const entry = requireEntry(projectId, String(params['registryId'] ?? ''));
        return analyzeFor(projectId, entry, String(params['newName'] ?? ''));
      }

      case 'buildDiff': {
        const projectId = requireProject(params);
        const entry = requireEntry(projectId, String(params['registryId'] ?? ''));
        const report = analyzeFor(projectId, entry, String(params['newName'] ?? ''));
        const rawSelection = params['selection'];
        const selection = Array.isArray(rawSelection)
          ? new Set(rawSelection.map((item) => String(item)))
          : undefined;
        return buildUnifiedDiff(report, {
          ...(selection !== undefined ? { selection } : {}),
          showRevisionMarks: params['showRevisionMarks'] === true,
        });
      }

      case 'execute': {
        const projectId = requireProject(params);
        const entry = requireEntry(projectId, String(params['registryId'] ?? ''));
        const newName = String(params['newName'] ?? '');
        const check = checkName({
          canonicalName: newName,
          entityType: entry.entityType,
          rule: ruleOf(projectId),
          symbols: registry.symbolTable(projectId),
          exclude: [entry.canonicalName],
        });
        if (!check.ok) {
          // 非法名绝不进入事务：否则"改完发现名字不合法"要回滚一大片文件
          throw new ShellError(
            'INVALID_ARGUMENT',
            `名称不合法，已阻断执行：${check.violations.map((item) => item.detail).join('；')}`,
          );
        }
        const report = analyzeFor(projectId, entry, newName);
        const rawSelection = params['selection'];
        const selection = new Set(
          (Array.isArray(rawSelection) ? rawSelection : []).map((item) => String(item)),
        );
        // 勾选集合必须能在**这次**影响面里找到落点，否则说明 UI 拿的是过期报告。
        // 直接放行会出现两种坏结果：静默什么都不改（用户以为改了），
        // 或退回"全部勾选"（改了用户没确认的位置）。两者都不可接受，故拒绝并要求重新分析。
        if (selection.size > 0) {
          const known = new Set(report.groups.flatMap((group) => group.items.map((item) => item.id)));
          const matched = [...selection].filter((id) => known.has(id)).length;
          if (matched === 0) {
            throw new ShellError(
              'INVALID_ARGUMENT',
              '影响面已变化（代码或文档在此期间被改动），请重新执行影响面分析后再勾选执行',
            );
          }
        }
        pendingCommit.message = '';
        pendingCommit.paths = [];
        const result = executeRename({
          registry: entry,
          newCanonicalName: newName,
          report,
          selection,
          deps: depsOf(projectId, params['showRevisionMarks'] === true),
        });

        if (result.ok && result.changeset !== null) {
          const sha = await commitRename(
            projectId,
            buildRenameCommitMessage(result.oldName, result.newName),
            touchedPaths(result.changeset),
          );
          if (sha !== null && result.event !== null) {
            const updated = eventStore.setCommitSha(result.event.id, sha);
            return { ...result, commitSha: sha, event: updated ?? result.event };
          }
        }
        return result;
      }

      case 'undo': {
        const projectId = requireProject(params);
        const eventId = String(params['eventId'] ?? '');
        const event = eventStore.get(eventId);
        if (event === null) throw new ShellError('NOT_FOUND', `重命名事件不存在：${eventId}`);
        if (event.projectId !== projectId) {
          throw new ShellError('INVALID_ARGUMENT', '该事件不属于当前项目');
        }
        const undo = undoRename({ event, deps: depsOf(projectId, false) });
        if (!undo.ok) return undo;
        const sha = await commitRename(
          projectId,
          `revert(rename): ${event.newName} → ${event.oldName}`,
          event.changeset === null ? [] : touchedPaths(event.changeset),
        );
        return { ...undo, commitSha: sha ?? undo.commitSha };
      }

      case 'history': {
        const projectId = requireProject(params);
        return eventStore
          .list(projectId)
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((event) => toHistoryEntry(event));
      }

      case 'planMigration':
        return generateMigrationFor(requireProject(params), params);

      case 'runMigration': {
        const projectId = requireProject(params);
        const migrationId = String(params['migrationId'] ?? '');
        const pending = pendingMigrations.get(migrationId);
        if (pending === undefined) {
          throw new ShellError(
            'NOT_FOUND',
            '迁移脚本已过期（应用重启后需重新生成），请重新生成迁移脚本后再执行',
          );
        }
        const logs: MigrationLogLine[] = [];
        const onLog = (line: MigrationLogLine): void => {
          logs.push(line);
          // 流式日志走常驻事件口：执行期间可能没有在飞请求可以附着
          options.emit('rename', { type: 'rename:migration-log', ...line, projectId });
        };
        const datasource = datasourceOf(projectId);
        if (datasource === null || datasource.dialect !== 'sqlite' || datasource.file.length === 0) {
          return {
            ok: false,
            executed: [],
            failedStatement: null,
            failure:
              '未配置项目数据源连接：迁移脚本已生成但**未执行**（D-08：默认只生成不执行）。' +
              '请复制脚本到自己的数据库客户端执行，或配置项目数据源后重试。',
            rolledBack: false,
            rollbackFailure: null,
            log: logs,
            event: null,
            commitSha: null,
            refused: 'datasource_missing',
          };
        }
        let sqlite: Database.Database;
        try {
          sqlite = new Database(datasource.file);
        } catch (error) {
          throw new ShellError(
            'IO_ERROR',
            `无法连接数据源：${error instanceof Error ? error.message : String(error)}`,
          );
        }
        try {
          const result = await executeMigration({
            migration: pending.migration,
            connection: {
              async execute(statement: string) {
                sqlite.exec(statement);
              },
            },
            confirmed: params['confirmed'] === true,
            secondConfirmed: params['secondConfirmed'] === true,
            requiresSecondConfirm: pending.preview.requiresSecondConfirm,
            events: eventStore,
            git: {
              commit: (input) => {
                // 迁移提交同样只能异步做；登记意图后由外层提交（保持 sha 可选）
                pendingCommit.message = input.message;
                pendingCommit.paths = [...input.paths];
                return null;
              },
            },
            projectId,
            ...(typeof params['registryId'] === 'string' ? { registryId: params['registryId'] } : {}),
            onLog,
          });
          pendingMigrations.delete(migrationId);
          return result;
        } finally {
          sqlite.close();
        }
      }

      case 'pendingCleanup': {
        const projectId = requireProject(params);
        return pendingCleanup(registry.listByProject(projectId), Date.now());
      }

      case 'cleanAliases': {
        const projectId = requireProject(params);
        const items = (params['items'] ?? []) as Array<{
          registryId: string;
          kind: never;
          name: string;
        }>;
        const result = cleanAliases(registry.listByProject(projectId), items, Date.now());
        for (const entry of result.entries) registry.save(entry);
        return result.cleanedKeys.length;
      }

      case 'planBatch': {
        const projectId = requireProject(params);
        const rule = ruleOf(projectId);
        const entries = registry.listByProject(projectId);
        const rawItems = params['items'];
        const itemsParam = Array.isArray(rawItems)
          ? (rawItems as Array<{ registryId: string; newName: string }>)
          : null;

        let plan: BatchPlan;
        if (itemsParam !== null && itemsParam.length > 0) {
          const items = [];
          for (const item of itemsParam) {
            const entry = registry.get(String(item.registryId));
            if (entry === null || entry.projectId !== projectId) continue;
            items.push({
              registry: entry,
              newCanonicalName: String(item.newName),
              occurrences: occurrencesOf(projectId, entry),
            });
          }
          plan = planBatchRename({
            projectId,
            items,
            rule,
            symbols: registry.symbolTable(projectId),
          });
        } else if (params['normalize'] === true) {
          plan = planNormalization({
            projectId,
            entries,
            occurrencesOf: (registryId) => {
              const entry = registry.get(registryId);
              return entry === null ? [] : occurrencesOf(projectId, entry);
            },
            rule,
          });
        } else {
          throw new ShellError(
            'INVALID_ARGUMENT',
            '批量规划需要 items（多选改名）或 normalize=true（一键全项目规范化）',
          );
        }
        batchPlans.set(plan.batchId, plan);
        return plan;
      }

      case 'runBatch': {
        const projectId = requireProject(params);
        const plan = batchPlans.get(String(params['batchId'] ?? ''));
        if (plan === undefined) {
          throw new ShellError('NOT_FOUND', '批量计划已过期，请重新规划后再执行');
        }
        pendingCommit.message = '';
        pendingCommit.paths = [];
        const result = executeBatchRename({ plan, deps: depsOf(projectId, false) });
        for (const step of result.steps) {
          if (!step.ok || step.transaction.changeset === null) continue;
          await commitRename(
            projectId,
            buildRenameCommitMessage(step.transaction.oldName, step.transaction.newName),
            touchedPaths(step.transaction.changeset),
          );
        }
        return result;
      }

      default:
        throw new ShellError('INVALID_ARGUMENT', `rename 域未知方法：${method}`);
    }
  };

  return router;
}

/* ------------------------------ 纯工具 ------------------------------ */

/**
 * 注册表登记（设计器建页 / 改页时调用，T7-01 的数据来源之一）。
 *
 * 关键点：
 * - **id 稳定**（`reg-<entityType>-<entityId>`），重复保存是 upsert 而不是插入新行，
 *   否则同一个元素改两次名就会在注册表里留下两条互相打脸的记录；
 * - 八类投影用领域层的 `createRegistryEntry` 派生（`deriveProjections`），
 *   不要手写 `{routeSegment}` 之类的部分投影——`symbolTable()` 与冲突检测都依赖
 *   完整投影，缺项会让"新名字和已有变量冲突"检测不出来；
 * - 已存在时保留 `created_at` 与 `name_history`，只刷新规范名与投影。
 */
export function upsertRegistryEntry(
  db: Database.Database,
  entry: {
    projectId: string;
    entityType: 'element' | 'page' | 'feature';
    entityId: string;
    canonicalName: string;
    /** 项目命名规则覆盖（缺省用 Web 预设） */
    override?: NamingOverride | null;
    platform?: NamingPlatform;
    /** 显式补充/覆盖个别投影（如设计器已知的路由片段） */
    projections?: Partial<ReturnType<typeof createRegistryEntry>['entry']['projections']>;
  },
): void {
  const rule = resolveNamingRule({
    platform: entry.platform ?? 'web',
    ...(entry.override !== null && entry.override !== undefined ? { override: entry.override } : {}),
  });
  const now = Date.now();
  const id = `reg-${entry.entityType}-${entry.entityId}`;
  const existing = db
    .prepare(`SELECT created_at, name_history_json, aliases_json FROM registry_entry WHERE id = ?`)
    .get(id) as
    | { created_at: number; name_history_json: string | null; aliases_json: string | null }
    | undefined;

  const created = createRegistryEntry({
    projectId: entry.projectId,
    entityType: entry.entityType,
    entityId: entry.entityId,
    canonicalName: entry.canonicalName,
    rule,
    id,
    now,
    random: () => 0.5,
  });
  const record = toRegistryRecord({
    ...created.entry,
    projections: { ...created.entry.projections, ...(entry.projections ?? {}) },
    ...(existing !== undefined
      ? {
          createdAt: existing.created_at,
          ...(Array.isArray(parseJsonSafe(existing.name_history_json))
            ? { nameHistory: parseJsonSafe(existing.name_history_json) as RegistryEntry['nameHistory'] }
            : {}),
          ...(Array.isArray(parseJsonSafe(existing.aliases_json))
            ? { aliases: parseJsonSafe(existing.aliases_json) as RegistryEntry['aliases'] }
            : {}),
        }
      : {}),
  });
  db.prepare(
    `INSERT INTO registry_entry (id, project_id, entity_type, entity_id, canonical_name, projections_json, aliases_json, naming_rule_id, name_history_json, sync_state, created_at, updated_at)
     VALUES (@id, @project_id, @entity_type, @entity_id, @canonical_name, @projections_json, @aliases_json, @naming_rule_id, @name_history_json, @sync_state, @created_at, @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       canonical_name = excluded.canonical_name,
       projections_json = excluded.projections_json,
       updated_at = excluded.updated_at`,
  ).run(record);
}

function readTextSafe(file: string): string | null {
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return null;
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 原子写（临时文件 + rename）：与 code 域同一口径，避免落半截文件 */
function writeAtomic(file: string, content: string): void {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${file}.ec-tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, file);
}

function parseJsonSafe(text: string | null): unknown {
  if (text === null || text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** 按 JSON 路径写叶子（`state.loginButton.label` 形态）；路径不存在时返回 false */
function setLeaf(root: Record<string, unknown>, jsonPath: string, value: string): boolean {
  const segments = jsonPath.split('.').filter((item) => item.length > 0);
  if (segments.length === 0) return false;
  let cursor: Record<string, unknown> = root;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    if (next === null || typeof next !== 'object') return false;
    cursor = next as Record<string, unknown>;
  }
  const last = segments[segments.length - 1] as string;
  if (!(last in cursor)) return false;
  cursor[last] = value;
  return true;
}

/** 只替换第 index 次出现（避免正文里多处同名被一次性改光） */
function replaceNth(text: string, from: string, to: string, index: number): string {
  if (from.length === 0) return text;
  let seen = 0;
  let cursor = 0;
  while (cursor < text.length) {
    const found = text.indexOf(from, cursor);
    if (found < 0) return text;
    if (seen === index) {
      return `${text.slice(0, found)}${to}${text.slice(found + from.length)}`;
    }
    seen += 1;
    cursor = found + from.length;
  }
  return text;
}

/** 递归收集 DSL 节点对象（就地修改用） */
function findNodes(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (node === null || typeof node !== 'object') return out;
  const record = node as Record<string, unknown>;
  out.push(record);
  const children = record['children'];
  if (Array.isArray(children)) for (const child of children) findNodes(child, out);
  return out;
}

/** 命名对象的归属（页面名 / 功能名），供 UI 分组展示 */
function ownerNameOf(db: Database.Database, entry: RegistryEntry): string | null {
  try {
    if (entry.entityType === 'element') {
      const row = db
        .prepare(
          `SELECT p.name AS name FROM element e JOIN page p ON p.id = e.page_id WHERE e.id = ?`,
        )
        .get(entry.entityId) as { name: string } | undefined;
      return row?.name ?? null;
    }
    if (entry.entityType === 'page') {
      const row = db
        .prepare(`SELECT name FROM page WHERE id = ?`)
        .get(entry.entityId) as { name: string } | undefined;
      return row?.name ?? null;
    }
    if (entry.entityType === 'feature') {
      const row = db
        .prepare(`SELECT name FROM feature WHERE id = ?`)
        .get(entry.entityId) as { name: string } | undefined;
      return row?.name ?? null;
    }
  } catch {
    // 表结构缺列等异常不该让整个列表挂掉
  }
  return null;
}
