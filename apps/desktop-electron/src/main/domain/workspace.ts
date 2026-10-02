import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type Database from 'better-sqlite3';

import { newUlid } from '@ec/data';
import {
  PROJECT_SUBDIRS,
  ProjectDomainError,
  ProjectService,
  anchorDraftToRoot,
  detectSource as detectSourceFromSnapshot,
  findTemplate,
  inferProjectProfile,
  isValidGitUrl,
  projectNameFromUrl,
  sourceDetectionSchema,
  SOURCE_SCANNER_VERSION,
  type CreateProjectInput,
  type DashboardMetrics,
  type DuplicateOptions,
  type ExtractedFeature,
  type ExtractedPage,
  type MetricDetail,
  type MetricKey,
  type ProjectDuplicatePort,
  type ProjectQuery,
  type ProjectStageInfo,
  type RequirementDigest,
  type SourceDetection,
  type TemplateElement,
  type UpdateProjectPatch,
  type WorkspaceValidateResult,
} from '@ec/core';
import {
  createElement,
  createPageDsl,
  createSequentialIdFactory,
  dslFileName,
  serializePageDsl,
  type ElementNode,
  type Platform,
} from '@ec/designer/dsl';
import {
  ShellError,
  WORKSPACE_IMPORT_PROGRESS_EVENT,
  type ShellErrorCode,
  type WorkspaceImportProgressEvent,
  type WorkspaceImportStage,
} from '@ec/shell-api';

import { LOCAL_USER_ID } from './db';
import { resolveCodeRoot, writeCodeRootPointer } from './code-root';
import { createGitImportPort, scanSourceSnapshot } from './git-import-port';
import { createZipImportPort } from './zip-import-port';
import type { DomainRouter } from './runtime';
import { createSqliteProjectStore } from './sqlite-project-store';

/**
 * workspace 域运行时（工作台）。
 *
 * 存储分工：
 * - 项目 / 页面 / 元素 / 功能 / 记忆 / 文档 / 流水线的**元数据**在 SQLite（`@ec/data` 的迁移全集）
 * - **工程产物**在文件系统，按 `@ec/core` 的 `WorkspaceLayout` 约定：
 *   `<projectsDir>/<projectId>/{design,docs,pipeline,code,meta}`
 *
 * 源码接入（V2-D01）：Git 克隆（`importFromGit`）、打开文件夹 / 复制导入
 * （`importFromFolder`）、ZIP 解压（`importFromZip`）四路共用同一扫描器
 * （`scanSourceSnapshot`）与同一识别管线（core `detectSource` → v2 SourceDetection，
 * 持久化在 `<projectDir>/meta/source-detection.json`），识别不执行任何工程脚本。
 * 文件夹 link 模式只登记代码根指针、只读扫描用户目录——未提交改动不写入、不受损。
 */

export interface WorkspaceDomainOptions {
  db: Database.Database;
  dataDir: string;
  /** 工程目录根（`<workspaceRoot>/projects`） */
  projectsDir: string;
  userId?: string;
}

export interface WorkspaceDomain {
  router: DomainRouter;
}

interface Counts {
  design: number;
  memory: number;
  docs: number;
  codeFiles: number;
}

/** 七端常量（`@ec/core` 的 `TARGET_PLATFORM_KEYS` 的本地镜像，用于 DSL 平台名校验） */
const PLATFORM_KEYS: readonly string[] = [
  'web',
  'android',
  'ios',
  'harmonyos',
  'windows',
  'linux',
  'macos',
];

function toShellError(error: unknown): never {
  if (error instanceof ProjectDomainError) {
    const map: Record<ProjectDomainError['code'], ShellErrorCode> = {
      not_found: 'NOT_FOUND',
      invalid_name: 'INVALID_ARGUMENT',
      duplicate_name: 'ALREADY_EXISTS',
      in_recycle_bin: 'INVALID_ARGUMENT',
    };
    throw new ShellError(map[error.code], error.message);
  }
  throw error;
}

function readJsonSafe<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** 递归列出目录内文件（返回相对路径，正斜杠统一） */
function listFilesRecursive(root: string, current = root): string[] {
  if (!existsSync(current)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const full = join(current, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(root, full));
    else out.push(full.slice(root.length + 1).replace(/\\/g, '/'));
  }
  return out;
}

/**
 * 模板元素 → DSL 元素节点（递归）。
 *
 * 走设计器工厂 `createElement` 而不是手搓对象：DSL 的字段约束（可选字段、
 * `exactOptionalPropertyTypes` 下的显式省略）由工厂统一负责，模板侧只提供结构。
 * 元素 id 用「页面 id + 序号」保证全局唯一且可读。
 */
function buildElementNode(template: TemplateElement, nextId: () => string): ElementNode {
  const children = template.children ?? [];
  return createElement({
    id: nextId(),
    type: template.type,
    ...(template.name !== undefined ? { name: template.name } : {}),
    ...(template.props !== undefined ? { props: template.props } : {}),
    ...(template.style !== undefined ? { style: template.style } : {}),
    ...(children.length > 0
      ? { children: children.map((child) => buildElementNode(child, nextId)) }
      : {}),
  });
}

export function createWorkspaceDomain(options: WorkspaceDomainOptions): WorkspaceDomain {
  const { db, projectsDir } = options;
  const userId = options.userId ?? LOCAL_USER_ID;

  const projectDir = (id: string): string => join(projectsDir, id);

  /** 幂等建出工程目录结构（与 WorkspaceLayout 的约定一致） */
  const ensureProjectDirs = (id: string): void => {
    mkdirSync(projectDir(id), { recursive: true });
    for (const subdir of PROJECT_SUBDIRS)
      mkdirSync(join(projectDir(id), subdir), { recursive: true });
  };

  /**
   * 复制端口（FR-WSP-05）。
   *
   * 只做**机械搬运**：行原样复制、文件原样拷贝，不重算 embedding、不改写内容。
   * 这是"复制"的语义，与"重新生成"（模板/导入）不同，因此可以直接落库。
   */
  const duplicatePort: ProjectDuplicatePort = {
    async copyResources(
      sourceId: string,
      targetId: string,
      opts: DuplicateOptions,
    ): Promise<Counts> {
      const counts: Counts = { design: 0, memory: 0, docs: 0, codeFiles: 0 };

      const tx = db.transaction(() => {
        if (opts.includeDesign) {
          const pages = db
            .prepare(`SELECT * FROM page WHERE project_id = ?`)
            .all(sourceId) as Array<Record<string, unknown>>;
          for (const page of pages) {
            const newPageId = newUlid();
            db.prepare(
              `INSERT INTO page (id, project_id, feature_id, name, route, dsl_ref, created_at, updated_at)
               VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
            ).run(
              newPageId,
              targetId,
              page['name'],
              page['route'],
              page['dsl_ref'],
              Date.now(),
              Date.now(),
            );
            const elements = db
              .prepare(`SELECT * FROM element WHERE page_id = ? ORDER BY order_index`)
              .all(String(page['id'])) as Array<Record<string, unknown>>;
            for (const element of elements) {
              // 元素自引用父链：父子都重置为新 id，故 parent_id 先置空（层级由 order_index 保持）
              db.prepare(
                `INSERT INTO element (id, page_id, parent_id, type, name, props_json, style_json, feature_ref, note_id, order_index, anchor_json, created_at, updated_at)
                 VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
              ).run(
                newUlid(),
                newPageId,
                element['type'],
                element['name'],
                element['props_json'],
                element['style_json'],
                element['order_index'],
                element['anchor_json'],
                Date.now(),
                Date.now(),
              );
              counts.design += 1;
            }
            counts.design += 1;
          }
        }

        if (opts.includeMemory) {
          const items = db
            .prepare(`SELECT * FROM memory_item WHERE project_id = ?`)
            .all(sourceId) as Array<Record<string, unknown>>;
          for (const item of items) {
            db.prepare(
              `INSERT INTO memory_item (id, user_id, scope, project_id, feature_id, page_id, element_id, issue_id,
                 title, content, structured, tags, source_type, source_ref, confidence, importance, status, pinned,
                 version, created_at, updated_at)
               VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 1, ?, ?)`,
            ).run(
              newUlid(),
              userId,
              item['scope'],
              targetId,
              item['title'],
              item['content'],
              item['structured'],
              item['tags'],
              item['source_type'],
              item['confidence'],
              item['importance'],
              item['status'],
              item['pinned'],
              Date.now(),
              Date.now(),
            );
            counts.memory += 1;
          }
        }

        if (opts.includeDocs) {
          const docs = db
            .prepare(`SELECT * FROM document WHERE project_id = ?`)
            .all(sourceId) as Array<Record<string, unknown>>;
          for (const doc of docs) {
            db.prepare(
              `INSERT INTO document (id, project_id, kind, title, content_ref, version, created_at, updated_at,
                 format, content_text, sections_json, source_ref, deleted_at, ignored_version)
               VALUES (?, ?, ?, ?, NULL, 1, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
            ).run(
              newUlid(),
              targetId,
              doc['kind'],
              doc['title'],
              Date.now(),
              Date.now(),
              doc['format'],
              doc['content_text'],
              doc['sections_json'],
              doc['source_ref'],
            );
            counts.docs += 1;
          }
        }
      });
      tx();

      if (opts.includeCode) {
        // 代码根可能被登记到工程目录之外（从 Git 导入时用户指定了克隆目录）
        const source = resolveCodeRoot(projectDir(sourceId));
        const target = join(projectDir(targetId), 'code');
        ensureProjectDirs(targetId);
        for (const rel of listFilesRecursive(source)) {
          const from = join(source, rel);
          const to = join(target, rel);
          mkdirSync(dirname(to), { recursive: true });
          copyFileSync(from, to);
          counts.codeFiles += 1;
        }
      }

      return counts;
    },
  };

  const service = new ProjectService({
    store: createSqliteProjectStore(db),
    duplicate: duplicatePort,
  });

  /* --------------------- 文件接入（V2-D01）：共享识别与安全 --------------------- */

  const zipPort = createZipImportPort();

  /** 导入进度上报（阶段经域事件通道回渲染层；requestId 由 runtime 层补齐） */
  const makeImportReporter =
    (emitCtx: { emit(payload: unknown): void }) =>
    (stage: WorkspaceImportStage, ratio: number | null, message: string): void => {
      const progress: WorkspaceImportProgressEvent = {
        type: WORKSPACE_IMPORT_PROGRESS_EVENT,
        stage,
        ratio,
        message,
      };
      emitCtx.emit(progress);
    };

  /** 导入取消登记（importToken → 已取消）。只存本次进程内的导入令牌。 */
  const cancelledImports = new Set<string>();

  /** 识别结果落盘位置（`<projectDir>/meta/source-detection.json`） */
  const detectionPath = (projectDirectory: string): string =>
    join(projectDirectory, 'meta', 'source-detection.json');

  /** 读取已持久化的识别结果（损坏/缺失按无结果处理，重扫可重建——识别是派生数据） */
  const readPersistedDetection = (projectDirectory: string): SourceDetection | null => {
    const raw = readJsonSafe<SourceDetection>(detectionPath(projectDirectory));
    if (raw === null) return null;
    // 落库时已经过 schema 校验；读取侧仍复核一次，防手改文件带来畸形数据
    const parsed = sourceDetectionSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  };

  /**
   * 统一识别管线：扫描 → detectSource → 锚定代码根 → schema 校验 → 落盘。
   * 四路接入（Git/文件夹/复制/ZIP）都走这里，revision 在上一次基础上递增。
   */
  const runAndPersistDetection = (
    projectId: string,
    projectDirectory: string,
    codeRoot: string,
  ): SourceDetection => {
    const snapshot = scanSourceSnapshot(codeRoot);
    const draft = anchorDraftToRoot(detectSourceFromSnapshot(snapshot), codeRoot);
    const previous = readPersistedDetection(projectDirectory);
    const detection = sourceDetectionSchema.parse({
      detectionId: newUlid(),
      projectId,
      scannerVersion: draft.scannerVersion || SOURCE_SCANNER_VERSION,
      scannedAt: Date.now(),
      subProjects: draft.subProjects,
      requiresConfirmation: draft.requiresConfirmation,
      notes: draft.notes.length > 0 ? draft.notes : null,
      revision: (previous?.revision ?? 0) + 1,
    }) as SourceDetection;
    mkdirSync(join(projectDirectory, 'meta'), { recursive: true });
    writeFileSync(detectionPath(projectDirectory), JSON.stringify(detection, null, 2), 'utf8');
    return detection;
  };

  /** 目标目录可用（不存在或为空）——克隆与 ZIP 解压共用同一语义（不覆盖已有内容） */
  const isDirAvailable = (dir: string): boolean => {
    if (!existsSync(dir)) return true;
    try {
      return readdirSync(dir).length === 0;
    } catch {
      return false;
    }
  };

  /** 由本地路径推断默认项目名（复用 URL 版本按 / \ : 切分） */
  const projectNameFromLocalPath = (path: string, suffix: RegExp | null = null): string => {
    const base = projectNameFromUrl(path);
    const stripped = suffix !== null ? base.replace(suffix, '') : base;
    return stripped.length > 0 ? stripped : '导入项目';
  };

  /** link 模式防自嵌套：源目录与 projectsDir 互相包含或相同都拒绝（purge 误删风险） */
  const isInsideOrEqual = (a: string, b: string): boolean => {
    const norm = (p: string): string => resolve(p).toLowerCase();
    const na = norm(a);
    const nb = norm(b);
    return (
      na === nb ||
      na.startsWith(nb.endsWith('\\') ? nb : nb + '\\') ||
      nb.startsWith(na.endsWith('\\') ? na : na + '\\')
    );
  };

  /** 项目记忆初稿落库（与模板/文档导入同一口径；sourceType 如实标注来源） */
  const insertImportMemoryDrafts = (
    projectId: string,
    drafts: Array<{ scope: string; title: string; content: string; tags: string[] }>,
    sourceType: string,
  ): void => {
    if (drafts.length === 0) return;
    const insertMemory = db.prepare(
      `INSERT INTO memory_item (id, user_id, scope, project_id, page_id, title, content, tags, source_type,
         confidence, importance, status, pinned, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 0.8, 3, 'active', 0, 1, ?, ?)`,
    );
    const now = Date.now();
    for (const draft of drafts) {
      insertMemory.run(
        newUlid(),
        userId,
        draft.scope,
        projectId,
        draft.title,
        draft.content,
        JSON.stringify(draft.tags),
        sourceType,
        now,
        now,
      );
    }
  };

  /** 导入失败补偿（V2-SRC-10）：只清本次创建的项目行与工程目录，不触碰用户源目录 */
  const compensateImport = async (
    projectId: string,
    projectDirectory: string,
    extras: ReadonlyArray<string> = [],
  ): Promise<void> => {
    try {
      await service.purgeProject(projectId);
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    try {
      rmSync(projectDirectory, { recursive: true, force: true });
    } catch {
      /* 同上 */
    }
    for (const extra of extras) {
      try {
        rmSync(extra, { recursive: true, force: true });
      } catch {
        /* 同上 */
      }
    }
  };

  /** 取消判定（条目间/文件间轮询） */
  const isImportCancelled = (importToken: string | null): boolean =>
    importToken !== null && cancelledImports.has(importToken);

  /**
   * 复制循环每 64 个文件让出一拍事件循环：取消 RPC 才有机会在复制中途执行
   * （主进程单线程，纯同步循环会让 cancelSourceImport 排队到复制结束才跑），
   * 大目录复制也不再阻塞 IPC。
   */
  const yieldToEventLoop = (): Promise<void> =>
    new Promise((resolve) => {
      setImmediate(resolve);
    });

  /* ----------------------------- 仪表盘聚合 ----------------------------- */

  const countRows = (sql: string, ...params: unknown[]): number => {
    const row = db.prepare(sql).get(...params) as { n: number } | undefined;
    return row?.n ?? 0;
  };

  /**
   * 页面按端分组。
   *
   * `page` 表没有 platform 列（平台信息在设计 DSL 里），故读 `design/pages/*.dsl.json`
   * 的 `page.platform`。没有 DSL 文件时返回空分组——**不编造平台**。
   */
  const pagesByPlatform = (projectId: string): Record<string, number> => {
    const dir = join(projectDir(projectId), 'design', 'pages');
    const out: Record<string, number> = {};
    for (const rel of listFilesRecursive(dir)) {
      if (!rel.endsWith('.dsl.json')) continue;
      const envelope = readJsonSafe<{ page?: { platform?: unknown } }>(join(dir, rel));
      const platform = envelope?.page?.platform;
      if (typeof platform === 'string' && PLATFORM_KEYS.includes(platform)) {
        out[platform] = (out[platform] ?? 0) + 1;
      }
    }
    return out;
  };

  /**
   * 流水线阶段。
   *
   * 尚无 pipeline_run 记录时返回 null（= 项目未进入流水线），这是真实状态。
   * `confirmed` 取「状态为 confirmed 的阶段数」，`total` 取「出现过的阶段数」——
   * 生产运行时从 pipeline_checkpoint 读取七阶段快照；旧数据回退到 run 表。
   */
  const projectStage = (projectId: string): ProjectStageInfo | null => {
    const latest = db
      .prepare(
        `SELECT stage, status FROM pipeline_run WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(projectId) as { stage: string; status: string } | undefined;
    if (!latest) return null;
    const checkpoint = db
      .prepare('SELECT envelope_json FROM pipeline_checkpoint WHERE project_id = ?')
      .get(projectId) as { envelope_json: string } | undefined;
    if (checkpoint) {
      const saved = JSON.parse(checkpoint.envelope_json) as {
        state: { stages: Record<string, { status: string }> };
      };
      const stages = Object.values(saved.state.stages);
      return {
        ...latest,
        confirmed: stages.filter((state) => state.status === 'confirmed').length,
        total: stages.length,
      };
    }
    return {
      stage: latest.stage,
      status: latest.status,
      confirmed: countRows(
        `SELECT COUNT(DISTINCT stage) AS n FROM pipeline_run WHERE project_id = ? AND status = 'confirmed'`,
        projectId,
      ),
      total: countRows(
        `SELECT COUNT(DISTINCT stage) AS n FROM pipeline_run WHERE project_id = ?`,
        projectId,
      ),
    };
  };

  const buildMetrics = (projectId: string): DashboardMetrics => {
    const startedAt = Date.now();

    const memoryRows = db
      .prepare(`SELECT scope, COUNT(*) AS n FROM memory_item WHERE project_id = ? GROUP BY scope`)
      .all(projectId) as Array<{ scope: string; n: number }>;
    const byScope: Record<string, number> = {};
    for (const row of memoryRows) byScope[row.scope] = row.n;

    const pageTotal = countRows(`SELECT COUNT(*) AS n FROM page WHERE project_id = ?`, projectId);
    const byPlatform = pagesByPlatform(projectId);

    const featureTotal = countRows(
      `SELECT COUNT(*) AS n FROM feature WHERE project_id = ?`,
      projectId,
    );
    // 假定完成态标记为 'done'（表默认 'planned'）；写入端装配后需复核该取值
    const featureDone = countRows(
      `SELECT COUNT(*) AS n FROM feature WHERE project_id = ? AND status = 'done'`,
      projectId,
    );

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const periodStartMs = monthStart.getTime();

    const usageRows = db
      .prepare(
        `SELECT COALESCE(model_id, '未标注') AS model_id,
                SUM(total_tokens) AS tokens,
                SUM(COALESCE(cost, 0)) AS cost
           FROM usage_record WHERE project_id = ? GROUP BY COALESCE(model_id, '未标注')`,
      )
      .all(projectId) as Array<{ model_id: string; tokens: number | null; cost: number | null }>;
    const periodRows = db
      .prepare(
        `SELECT COALESCE(SUM(total_tokens), 0) AS tokens, COALESCE(SUM(cost), 0) AS cost FROM usage_record WHERE project_id = ? AND created_at >= ?`,
      )
      .get(projectId, periodStartMs) as { tokens: number; cost: number };

    return {
      memory: {
        total: countRows(`SELECT COUNT(*) AS n FROM memory_item WHERE project_id = ?`, projectId),
        byScope,
      },
      pages: { total: pageTotal, byPlatform },
      features: {
        done: featureDone,
        total: featureTotal,
        completion: featureTotal === 0 ? 0 : featureDone / featureTotal,
      },
      usage: {
        periodLabel: `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, '0')}`,
        periodTokens: periodRows.tokens,
        periodCost: periodRows.cost,
        totalTokens: usageRows.reduce((sum, row) => sum + (row.tokens ?? 0), 0),
        totalCost: usageRows.reduce((sum, row) => sum + (row.cost ?? 0), 0),
        byModel: usageRows.map((row) => ({
          modelId: row.model_id,
          tokens: row.tokens ?? 0,
          cost: row.cost ?? 0,
        })),
      },
      // Git 提交记录需要调用 git（克隆/日志能力属 @ec/git，尚未在域内装配），此处如实为空
      git: { recent: [] },
      computeMs: Date.now() - startedAt,
    };
  };

  const buildDetail = (projectId: string, key: MetricKey): MetricDetail => {
    switch (key) {
      case 'memory': {
        const rows = db
          .prepare(
            `SELECT scope, COUNT(*) AS n FROM memory_item WHERE project_id = ? GROUP BY scope ORDER BY n DESC`,
          )
          .all(projectId) as Array<{ scope: string; n: number }>;
        return {
          key,
          title: '记忆条目明细',
          rows: rows.map((row) => ({ label: row.scope, value: String(row.n) })),
        };
      }
      case 'pages': {
        const rows = db
          .prepare(`SELECT id, name, route FROM page WHERE project_id = ? ORDER BY updated_at DESC`)
          .all(projectId) as Array<{ id: string; name: string; route: string | null }>;
        return {
          key,
          title: '页面明细',
          rows: rows.map((row) => ({
            label: row.name,
            value: row.route ?? '未设置路由',
            refId: row.id,
          })),
        };
      }
      case 'features': {
        const rows = db
          .prepare(
            `SELECT id, name, status FROM feature WHERE project_id = ? ORDER BY updated_at DESC`,
          )
          .all(projectId) as Array<{ id: string; name: string; status: string }>;
        return {
          key,
          title: '功能明细',
          rows: rows.map((row) => ({ label: row.name, value: row.status, refId: row.id })),
        };
      }
      case 'usage': {
        const rows = db
          .prepare(
            `SELECT COALESCE(model_id, '未标注') AS model_id, SUM(total_tokens) AS tokens, SUM(COALESCE(cost, 0)) AS cost
               FROM usage_record WHERE project_id = ? GROUP BY COALESCE(model_id, '未标注') ORDER BY tokens DESC`,
          )
          .all(projectId) as Array<{
          model_id: string;
          tokens: number | null;
          cost: number | null;
        }>;
        return {
          key,
          title: '用量明细',
          rows: rows.map((row) => ({
            label: row.model_id,
            value: `${row.tokens ?? 0} tokens / ¥${(row.cost ?? 0).toFixed(4)}`,
          })),
        };
      }
      case 'git':
      default:
        // Git 明细依赖 git 调用，装配后可补；当前如实为空列表
        return { key: 'git', title: '最近提交', rows: [] };
    }
  };

  /* -------------------------------- 路由 -------------------------------- */

  const router: DomainRouter = async (method, params, ctx) => {
    try {
      switch (method) {
        case 'listProjects':
          return await service.listProjects((params['query'] ?? {}) as ProjectQuery);

        case 'getProject':
          return await service.getProject(String(params['id']));

        case 'createProject': {
          const input = params['input'] as CreateProjectInput;
          const created = await service.createProject(input, userId);
          ensureProjectDirs(created.id);
          return created;
        }

        case 'updateProject':
          return await service.updateProject(
            String(params['id']),
            (params['patch'] ?? {}) as UpdateProjectPatch,
          );

        case 'markOpened':
          await service.markOpened(String(params['id']));
          return undefined;

        case 'archiveProject':
          await service.archiveProject(String(params['id']));
          return undefined;

        case 'unarchiveProject':
          await service.unarchiveProject(String(params['id']));
          return undefined;

        case 'moveToRecycleBin':
          await service.moveToRecycleBin(String(params['id']));
          return undefined;

        case 'restoreFromRecycleBin':
          await service.restoreFromRecycleBin(String(params['id']));
          return undefined;

        case 'purgeProject': {
          const id = String(params['id']);
          await service.purgeProject(id);
          // 彻底删除时一并清掉工程目录（数据库级联已在 ProjectStore.deleteRow 里完成）
          rmSync(projectDir(id), { recursive: true, force: true });
          return undefined;
        }

        case 'cleanupExpiredRecycleBin':
          return (await service.cleanupExpiredRecycleBin()).length;

        case 'duplicateProject': {
          const id = String(params['id']);
          const duplicated = await service.duplicateProject(
            id,
            (params['options'] ?? {}) as DuplicateOptions,
          );
          ensureProjectDirs(duplicated.project.id);
          return duplicated;
        }

        case 'createFromTemplate': {
          const input = params['input'] as {
            templateId: string;
            name: string;
            description?: string | undefined;
          };
          const template = findTemplate(input.templateId);
          if (!template) throw new ShellError('NOT_FOUND', `模板不存在：${input.templateId}`);

          const created = await service.createProject(
            {
              name: input.name,
              description: input.description ?? template.description,
              targetPlatforms: template.targetPlatforms,
              techStackFingerprint: template.techStack,
              sourceKind: 'template',
              sourceRef: template.id,
            },
            userId,
          );
          ensureProjectDirs(created.id);

          const pagesDir = join(projectDir(created.id), 'design', 'pages');
          mkdirSync(pagesDir, { recursive: true });
          const now = Date.now();
          const insertPage = db.prepare(
            `INSERT INTO page (id, project_id, feature_id, name, route, dsl_ref, created_at, updated_at)
             VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
          );
          const insertMemory = db.prepare(
            `INSERT INTO memory_item (id, user_id, scope, project_id, page_id, title, content, tags, source_type,
               confidence, importance, status, pinned, version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'template', 1.0, 3, 'active', 0, 1, ?, ?)`,
          );

          for (const page of template.pages) {
            const pageId = newUlid();
            // 元素 id 前缀带上页面 id，保证跨页面唯一
            const tree = buildElementNode(
              { type: 'Root', name: page.name, props: {}, children: page.elements },
              createSequentialIdFactory(`${pageId}-el`),
            );
            const dsl = createPageDsl({
              id: pageId,
              projectId: created.id,
              name: page.name,
              platform: page.platform as Platform,
              route: page.route,
              tree,
            });
            const fileName = dslFileName(pageId);
            writeFileSync(join(pagesDir, fileName), serializePageDsl(dsl), 'utf8');
            insertPage.run(pageId, created.id, page.name, page.route, fileName, now, now);

            // 页面级备注随页面记忆一起落库（TemplatePage.note 的既定语义）
            if (page.note.trim().length > 0) {
              insertMemory.run(
                newUlid(),
                userId,
                'page',
                created.id,
                pageId,
                `${page.name} 备注`,
                page.note,
                '[]',
                now,
                now,
              );
            }
          }

          for (const draft of template.memoryDrafts) {
            // 模板草稿只有 project / feature 两级；feature 级无对应功能行时 feature_id 留空（列可空）
            insertMemory.run(
              newUlid(),
              userId,
              draft.scope,
              created.id,
              null,
              draft.title,
              draft.content,
              JSON.stringify(draft.tags),
              now,
              now,
            );
          }

          return created;
        }

        case 'importFromGit': {
          const input = params['input'] as {
            url: string;
            projectName?: string | undefined;
            targetDir: string;
          };
          const url = input.url.trim();
          const targetDir = input.targetDir.trim();
          if (!isValidGitUrl(url)) {
            throw new ShellError(
              'INVALID_ARGUMENT',
              `不是可识别的 Git 地址：${url}（支持 https:// 与 git@ 形式的仓库地址）`,
            );
          }
          if (targetDir.length === 0) {
            throw new ShellError(
              'INVALID_ARGUMENT',
              '克隆目录不能为空：请指定一个空目录作为仓库落点。',
            );
          }

          const gitPort = createGitImportPort();
          if (!(await gitPort.isDirAvailable(targetDir))) {
            throw new ShellError(
              'ALREADY_EXISTS',
              `克隆目录已存在且非空：${targetDir}。请换一个空目录，或先清空它（不会替你删除已有内容）。`,
            );
          }

          // 三阶段进度经域事件通道回渲染层（此前 clone 回调被出口剥掉、界面只能干等）
          const report = (
            stage: WorkspaceImportStage,
            ratio: number | null,
            message: string,
          ): void => {
            const progress: WorkspaceImportProgressEvent = {
              type: WORKSPACE_IMPORT_PROGRESS_EVENT,
              stage,
              ratio,
              message,
            };
            ctx.emit(progress);
          };

          const created = await service.createProject(
            {
              name: input.projectName?.trim() || projectNameFromUrl(url),
              sourceKind: 'git_import',
              sourceRef: url,
              gitRemote: url,
            },
            userId,
          );
          ensureProjectDirs(created.id);
          const projectDirectory = projectDir(created.id);
          // 仓库落在用户指定目录：登记代码根，供导出/复制按它取文件（见 code-root.ts）
          writeCodeRootPointer(projectDirectory, targetDir);

          try {
            report('clone', 0, '正在克隆仓库…');
            await gitPort.clone(url, targetDir, (ratio, message) =>
              report('clone', ratio, message),
            );
            report('inspect', null, '克隆完成，正在扫描仓库文件…');
            const snapshot = await gitPort.inspect(targetDir);
            report('finalize', null, '正在生成项目与记忆…');
            const profile = inferProjectProfile(snapshot);

            const updated = await service.updateProject(created.id, {
              ...(profile.platforms.length > 0 ? { targetPlatforms: profile.platforms } : {}),
              ...(Object.keys(profile.techStack).length > 0
                ? { techStackFingerprint: profile.techStack }
                : {}),
            });

            // 推断出的项目记忆草稿（技术栈 / 框架依据）落库，与模板新建同一口径
            insertImportMemoryDrafts(created.id, profile.memoryDrafts, 'git');

            // Git 导入产物接入统一识别管线（V2-D01）：同一扫描器/识别/落盘口径
            runAndPersistDetection(created.id, projectDirectory, targetDir);

            return updated;
          } catch (error) {
            // 克隆/推断失败时补偿清理：不留一个"指向空目录"的项目
            await compensateImport(created.id, projectDirectory);
            throw error;
          }
        }

        case 'previewSourceDetection': {
          // 打开/复制/ZIP 前的只读预扫描：不建项目、不写任何文件（V2-SRC-03/05）
          const sourcePath = String(params['path'] ?? '').trim();
          if (sourcePath.length === 0) {
            throw new ShellError('INVALID_ARGUMENT', '缺少源码目录路径。');
          }
          let stat;
          try {
            stat = statSync(sourcePath);
          } catch {
            throw new ShellError('NOT_FOUND', `目录不存在或不可访问：${sourcePath}`);
          }
          if (!stat.isDirectory()) {
            throw new ShellError('INVALID_ARGUMENT', `不是目录：${sourcePath}`);
          }
          const snapshot = scanSourceSnapshot(sourcePath);
          const draft = anchorDraftToRoot(detectSourceFromSnapshot(snapshot), sourcePath);
          return { codeRoot: sourcePath, detection: draft };
        }

        case 'importFromFolder': {
          const input = params['input'] as {
            path: string;
            projectName?: string | undefined;
            /** link=直接关联原目录（默认，不复制）；copy=复制到工程 code 目录 */
            mode?: 'link' | 'copy' | undefined;
            /** 取消令牌：cancelSourceImport 据此中止复制循环 */
            importToken?: string | undefined;
          };
          const sourcePath = input.path.trim();
          const mode = input.mode === 'copy' ? 'copy' : 'link';
          const importToken =
            typeof input.importToken === 'string' && input.importToken.length > 0
              ? input.importToken
              : null;
          if (sourcePath.length === 0) {
            throw new ShellError('INVALID_ARGUMENT', '源码目录不能为空。');
          }
          let sourceStat;
          try {
            sourceStat = statSync(sourcePath);
          } catch {
            throw new ShellError('NOT_FOUND', `目录不存在或不可访问：${sourcePath}`);
          }
          if (!sourceStat.isDirectory()) {
            throw new ShellError('INVALID_ARGUMENT', `不是目录：${sourcePath}`);
          }
          if (mode === 'link' && isInsideOrEqual(sourcePath, projectsDir)) {
            throw new ShellError(
              'INVALID_ARGUMENT',
              '不能把工作区内的目录直接关联为代码根（请使用复制模式，或选择工作区之外的目录）。',
            );
          }
          if (isImportCancelled(importToken)) {
            throw new ShellError('CANCELLED', '导入已取消。');
          }

          const report = makeImportReporter(ctx);
          report(mode === 'copy' ? 'copy' : 'inspect', mode === 'copy' ? 0 : null, '正在建立项目…');

          const created = await service.createProject(
            {
              name: input.projectName?.trim() || projectNameFromLocalPath(sourcePath),
              sourceKind: mode === 'copy' ? 'copied_folder' : 'existing_folder',
              sourceRef: sourcePath,
            },
            userId,
          );
          ensureProjectDirs(created.id);
          const projectDirectory = projectDir(created.id);

          try {
            let codeRoot: string;
            if (mode === 'link') {
              // 直接关联原目录：只登记代码根指针 + 只读扫描，绝不写入用户目录
              // （未提交改动保护：导入全程对源目录零写入）
              writeCodeRootPointer(projectDirectory, sourcePath);
              codeRoot = sourcePath;
              report('inspect', null, '正在扫描源码目录…');
            } else {
              codeRoot = join(projectDirectory, 'code');
              const relFiles = listFilesRecursive(sourcePath);
              let done = 0;
              for (const rel of relFiles) {
                if (isImportCancelled(importToken)) {
                  throw new ShellError('CANCELLED', '复制导入已取消，本次创建的内容将被清理。');
                }
                const to = join(codeRoot, rel);
                mkdirSync(dirname(to), { recursive: true });
                copyFileSync(join(sourcePath, rel), to);
                done += 1;
                report(
                  'copy',
                  relFiles.length === 0 ? 1 : done / relFiles.length,
                  `正在复制源码（${done}/${relFiles.length}）…`,
                );
                // 周期性让出事件循环：取消 RPC 能在复制中途落地（否则只能等复制完）
                if (done % 64 === 0) await yieldToEventLoop();
              }
              if (relFiles.length === 0) report('copy', 1, '源目录为空：已建立空项目。');
            }

            report('inspect', null, '正在扫描与识别工程…');
            const snapshot = scanSourceSnapshot(codeRoot);
            const profile = inferProjectProfile({
              files: snapshot.files,
              manifests: snapshot.manifests,
              defaultBranch: null,
              remoteUrl: '',
            });
            const updated = await service.updateProject(created.id, {
              ...(profile.platforms.length > 0 ? { targetPlatforms: profile.platforms } : {}),
              ...(Object.keys(profile.techStack).length > 0
                ? { techStackFingerprint: profile.techStack }
                : {}),
            });
            insertImportMemoryDrafts(
              created.id,
              profile.memoryDrafts,
              mode === 'copy' ? 'copied_folder' : 'existing_folder',
            );

            report('finalize', null, '正在生成运行计划…');
            runAndPersistDetection(created.id, projectDirectory, codeRoot);
            return updated;
          } catch (error) {
            // 只清本次创建的工程目录；源目录（含未提交改动）永不触碰
            await compensateImport(created.id, projectDirectory);
            throw error;
          }
        }

        case 'importFromZip': {
          const input = params['input'] as {
            zipPath: string;
            targetDir: string;
            projectName?: string | undefined;
            importToken?: string | undefined;
          };
          const zipPath = input.zipPath.trim();
          const targetDir = input.targetDir.trim();
          const importToken =
            typeof input.importToken === 'string' && input.importToken.length > 0
              ? input.importToken
              : null;
          if (zipPath.length === 0 || targetDir.length === 0) {
            throw new ShellError('INVALID_ARGUMENT', '请提供 ZIP 文件路径与解压目标目录。');
          }
          let zipStat;
          try {
            zipStat = statSync(zipPath);
          } catch {
            throw new ShellError('NOT_FOUND', `ZIP 文件不存在或不可访问：${zipPath}`);
          }
          if (!zipStat.isFile()) {
            throw new ShellError('INVALID_ARGUMENT', `不是文件：${zipPath}`);
          }
          if (!isDirAvailable(targetDir)) {
            throw new ShellError(
              'ALREADY_EXISTS',
              `解压目标目录已存在且非空：${targetDir}。请换一个空目录（不会替你删除已有内容）。`,
            );
          }
          if (isImportCancelled(importToken)) {
            throw new ShellError('CANCELLED', '导入已取消。');
          }

          const report = makeImportReporter(ctx);
          // 早期校验（损坏/非法 ZIP 在建项目前就失败，不做无谓补偿）
          zipPort.listEntries(zipPath);

          const created = await service.createProject(
            {
              name: input.projectName?.trim() || projectNameFromLocalPath(zipPath, /\.zip$/i),
              sourceKind: 'zip_extract',
              sourceRef: zipPath,
            },
            userId,
          );
          ensureProjectDirs(created.id);
          const projectDirectory = projectDir(created.id);
          // ZIP 一律解压到新目录：登记代码根指针（与 Git 克隆同一登记约定）
          writeCodeRootPointer(projectDirectory, targetDir);
          const targetExistedBefore = existsSync(targetDir);

          try {
            report('extract', 0, '正在安全解压…');
            await zipPort.extract(zipPath, targetDir, {
              isCancelled: () => isImportCancelled(importToken),
              onProgress: (done, total) =>
                report('extract', total === 0 ? 1 : done / total, `正在解压（${done}/${total}）…`),
            });
            report('inspect', null, '解压完成，正在扫描与识别工程…');
            const snapshot = scanSourceSnapshot(targetDir);
            const profile = inferProjectProfile({
              files: snapshot.files,
              manifests: snapshot.manifests,
              defaultBranch: null,
              remoteUrl: '',
            });
            const updated = await service.updateProject(created.id, {
              ...(profile.platforms.length > 0 ? { targetPlatforms: profile.platforms } : {}),
              ...(Object.keys(profile.techStack).length > 0
                ? { techStackFingerprint: profile.techStack }
                : {}),
            });
            insertImportMemoryDrafts(created.id, profile.memoryDrafts, 'zip_extract');

            report('finalize', null, '正在生成运行计划…');
            runAndPersistDetection(created.id, projectDirectory, targetDir);
            return updated;
          } catch (error) {
            // 只清理本次解压目录（若为本次新建）与工程目录；ZIP 原件不动
            await compensateImport(
              created.id,
              projectDirectory,
              targetExistedBefore ? [] : [targetDir],
            );
            throw error;
          }
        }

        case 'cancelSourceImport': {
          const importToken = String(params['importToken'] ?? '');
          if (importToken.length === 0) {
            throw new ShellError('INVALID_ARGUMENT', '缺少 importToken。');
          }
          cancelledImports.add(importToken);
          return undefined;
        }

        case 'getSourceDetection': {
          const projectId = String(params['projectId'] ?? '');
          // 无落盘结果时如实返回 null（旧项目/导入前取消），UI 显示"尚未识别"
          return readPersistedDetection(projectDir(projectId));
        }

        case 'detectSource': {
          // 重扫（V2-SRC-09）：只读扫描 + revision 递增；识别失败不改源码
          const projectId = String(params['projectId'] ?? '');
          const project = await service.getProject(projectId);
          if (project === null) {
            throw new ShellError('NOT_FOUND', `项目不存在：${projectId}`);
          }
          const codeRoot = resolveCodeRoot(projectDir(projectId));
          if (!existsSync(codeRoot)) {
            throw new ShellError('NOT_FOUND', `代码根目录不存在：${codeRoot}`);
          }
          return runAndPersistDetection(projectId, projectDir(projectId), codeRoot);
        }

        case 'createFromDigest': {
          const input = params['input'] as { digest: RequirementDigest; name: string };
          const digest = input.digest;
          const created = await service.createProject(
            {
              name: input.name,
              description: digest.summary || undefined,
              sourceKind: 'doc_import',
              sourceRef: digest.title || undefined,
            },
            userId,
          );
          ensureProjectDirs(created.id);
          const now = Date.now();

          const insertFeature = db.prepare(
            `INSERT INTO feature (id, project_id, name, description, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'planned', ?, ?)`,
          );
          for (const feature of digest.features as ExtractedFeature[]) {
            insertFeature.run(newUlid(), created.id, feature.name, feature.description, now, now);
          }

          const insertPage = db.prepare(
            `INSERT INTO page (id, project_id, feature_id, name, route, dsl_ref, created_at, updated_at)
             VALUES (?, ?, NULL, ?, ?, NULL, ?, ?)`,
          );
          for (const page of digest.pageCandidates as ExtractedPage[]) {
            insertPage.run(newUlid(), created.id, page.name, page.route, now, now);
          }

          const insertMemory = db.prepare(
            `INSERT INTO memory_item (id, user_id, scope, project_id, title, content, tags, source_type,
               confidence, importance, status, pinned, version, created_at, updated_at)
             VALUES (?, ?, 'project', ?, ?, ?, ?, 'doc', 1.0, 3, 'active', 0, 1, ?, ?)`,
          );
          for (const draft of digest.memoryDrafts) {
            insertMemory.run(
              newUlid(),
              userId,
              created.id,
              draft.title,
              draft.content,
              JSON.stringify(draft.tags),
              now,
              now,
            );
          }

          return created;
        }

        case 'getProjectStage':
          return projectStage(String(params['projectId']));

        case 'getThumbnailUrl': {
          // V2-D02：预览域把真实页面截图持久化在 meta/thumbnail.png；读到即返回
          // data URL（file:// 在渲染层受 webSecurity 限制，data URL 最稳）。
          // 没有可渲染页面（文件不存在/过大）时保持 null，卡片显示明确占位。
          // 注意：@ec/core 的 PROJECT_SUBDIRS 是数组；这里直接用 'meta' 字面量
          const thumbnail = readThumbnailDataUrl(
            join(projectsDir, String(params['projectId']), 'meta', 'thumbnail.png'),
          );
          return thumbnail;
        }

        case 'getDashboardMetrics':
          return buildMetrics(String(params['projectId']));

        case 'getMetricDetail':
          return buildDetail(String(params['projectId']), params['key'] as MetricKey);

        default:
          throw new ShellError('INVALID_ARGUMENT', `workspace 域不支持的方法：${method}`);
      }
    } catch (error) {
      toShellError(error);
    }
  };

  return { router };
}

/** 供测试与诊断：工程目录是否存在且结构完整 */
/** 缩略图文件大小上限（超限视为损坏，宁可不显示也不拖垮项目卡片列表） */
const MAX_THUMBNAIL_BYTES = 2_097_152;

/**
 * 读取持久化的项目缩略图（V2-D02）并转成 data URL。
 * 文件缺失 / 超限 / 读取失败一律返回 null —— 契约允许 null，卡片显示明确占位，
 * 不编造地址、不用假图冒充真实预览。
 */
function readThumbnailDataUrl(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    if (statSync(file).size > MAX_THUMBNAIL_BYTES) return null;
    const png = readFileSync(file);
    if (png.length === 0) return null;
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch {
    return null;
  }
}

export function validateProjectLayout(
  projectsDir: string,
  projectId: string,
): WorkspaceValidateResult {
  const root = join(projectsDir, projectId);
  const missing: string[] = [];
  if (!existsSync(root)) missing.push(root);
  for (const subdir of PROJECT_SUBDIRS) {
    const dir = join(root, subdir);
    if (!existsSync(dir)) missing.push(dir);
  }
  return { projectId, root, missing, ok: missing.length === 0 };
}

/** 供测试与诊断：目录内文件总数 */
export function countProjectFiles(projectsDir: string, projectId: string): number {
  const root = join(projectsDir, projectId);
  if (!existsSync(root)) return 0;
  let total = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) total += listFilesRecursive(full).length;
    else if (statSync(full).isFile()) total += 1;
  }
  return total;
}
