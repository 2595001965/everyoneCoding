import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';

import { newUlid } from '@ec/data';
import {
  PROJECT_SUBDIRS,
  ProjectDomainError,
  ProjectService,
  findTemplate,
  inferProjectProfile,
  isValidGitUrl,
  projectNameFromUrl,
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
import { ShellError, WORKSPACE_IMPORT_PROGRESS_EVENT, type ShellErrorCode, type WorkspaceImportProgressEvent, type WorkspaceImportStage } from '@ec/shell-api';

import { LOCAL_USER_ID } from './db';
import { resolveCodeRoot, writeCodeRootPointer } from './code-root';
import { createGitImportPort } from './git-import-port';
import type { DomainRouter } from './runtime';
import { createSqliteProjectStore } from './sqlite-project-store';

/**
 * workspace 域运行时（工作台，19 个方法中的 17 个）。
 *
 * 存储分工：
 * - 项目 / 页面 / 元素 / 功能 / 记忆 / 文档 / 流水线的**元数据**在 SQLite（`@ec/data` 的迁移全集）
 * - **工程产物**在文件系统，按 `@ec/core` 的 `WorkspaceLayout` 约定：
 *   `<projectsDir>/<projectId>/{design,docs,pipeline,code,meta}`
 *
 * **未完成说明（如实）**：
 * - `createFromTemplate`：初始页面 DSL 必须用设计器的 `createPageDsl` / `serializePageDsl`
 *   （`@ec/designer`，含 React/dnd-kit 的浏览器 UI 包），主进程不应引入。
 *   要么给 designer 加一个纯 DSL 子入口，要么改由渲染层产出 DSL 再落库——属包入口策略，待定。
 * - `importFromGit`：需 `@ec/git` 的克隆能力与网络访问，随 git 集成一并接线。
 * 两者当前抛带原因的 `NOT_SUPPORTED`，不做静默降级。
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
const PLATFORM_KEYS: readonly string[] = ['web', 'android', 'ios', 'harmonyos', 'windows', 'linux', 'macos'];

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
    ...(children.length > 0 ? { children: children.map((child) => buildElementNode(child, nextId)) } : {}),
  });
}

export function createWorkspaceDomain(options: WorkspaceDomainOptions): WorkspaceDomain {
  const { db, projectsDir } = options;
  const userId = options.userId ?? LOCAL_USER_ID;

  const projectDir = (id: string): string => join(projectsDir, id);

  /** 幂等建出工程目录结构（与 WorkspaceLayout 的约定一致） */
  const ensureProjectDirs = (id: string): void => {
    mkdirSync(projectDir(id), { recursive: true });
    for (const subdir of PROJECT_SUBDIRS) mkdirSync(join(projectDir(id), subdir), { recursive: true });
  };

  /**
   * 复制端口（FR-WSP-05）。
   *
   * 只做**机械搬运**：行原样复制、文件原样拷贝，不重算 embedding、不改写内容。
   * 这是"复制"的语义，与"重新生成"（模板/导入）不同，因此可以直接落库。
   */
  const duplicatePort: ProjectDuplicatePort = {
    async copyResources(sourceId: string, targetId: string, opts: DuplicateOptions): Promise<Counts> {
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
            ).run(newPageId, targetId, page['name'], page['route'], page['dsl_ref'], Date.now(), Date.now());
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
          const items = db.prepare(`SELECT * FROM memory_item WHERE project_id = ?`).all(sourceId) as Array<
            Record<string, unknown>
          >;
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
          const docs = db.prepare(`SELECT * FROM document WHERE project_id = ?`).all(sourceId) as Array<
            Record<string, unknown>
          >;
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

  const service = new ProjectService({ store: createSqliteProjectStore(db), duplicate: duplicatePort });

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
   * 由于流水线写入端（@ec/pipeline + 持久化）尚未装配，本方法目前实际返回 null。
   */
  const projectStage = (projectId: string): ProjectStageInfo | null => {
    const latest = db
      .prepare(`SELECT stage, status FROM pipeline_run WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1`)
      .get(projectId) as { stage: string; status: string } | undefined;
    if (!latest) return null;
    return {
      stage: latest.stage,
      status: latest.status,
      confirmed: countRows(
        `SELECT COUNT(DISTINCT stage) AS n FROM pipeline_run WHERE project_id = ? AND status = 'confirmed'`,
        projectId,
      ),
      total: countRows(`SELECT COUNT(DISTINCT stage) AS n FROM pipeline_run WHERE project_id = ?`, projectId),
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

    const featureTotal = countRows(`SELECT COUNT(*) AS n FROM feature WHERE project_id = ?`, projectId);
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
      .prepare(`SELECT COALESCE(SUM(total_tokens), 0) AS tokens, COALESCE(SUM(cost), 0) AS cost FROM usage_record WHERE project_id = ? AND created_at >= ?`)
      .get(projectId, periodStartMs) as { tokens: number; cost: number };

    return {
      memory: { total: countRows(`SELECT COUNT(*) AS n FROM memory_item WHERE project_id = ?`, projectId), byScope },
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
        byModel: usageRows.map((row) => ({ modelId: row.model_id, tokens: row.tokens ?? 0, cost: row.cost ?? 0 })),
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
          .prepare(`SELECT scope, COUNT(*) AS n FROM memory_item WHERE project_id = ? GROUP BY scope ORDER BY n DESC`)
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
          rows: rows.map((row) => ({ label: row.name, value: row.route ?? '未设置路由', refId: row.id })),
        };
      }
      case 'features': {
        const rows = db
          .prepare(`SELECT id, name, status FROM feature WHERE project_id = ? ORDER BY updated_at DESC`)
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
          .all(projectId) as Array<{ model_id: string; tokens: number | null; cost: number | null }>;
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
          return await service.updateProject(String(params['id']), (params['patch'] ?? {}) as UpdateProjectPatch);

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
          const duplicated = await service.duplicateProject(id, (params['options'] ?? {}) as DuplicateOptions);
          ensureProjectDirs(duplicated.project.id);
          return duplicated;
        }

        case 'createFromTemplate': {
          const input = params['input'] as { templateId: string; name: string; description?: string | undefined };
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
            throw new ShellError('INVALID_ARGUMENT', '克隆目录不能为空：请指定一个空目录作为仓库落点。');
          }

          const gitPort = createGitImportPort();
          if (!(await gitPort.isDirAvailable(targetDir))) {
            throw new ShellError(
              'ALREADY_EXISTS',
              `克隆目录已存在且非空：${targetDir}。请换一个空目录，或先清空它（不会替你删除已有内容）。`,
            );
          }

          // 三阶段进度经域事件通道回渲染层（此前 clone 回调被出口剥掉、界面只能干等）
          const report = (stage: WorkspaceImportStage, ratio: number | null, message: string): void => {
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
            await gitPort.clone(url, targetDir, (ratio, message) => report('clone', ratio, message));
            report('inspect', null, '克隆完成，正在扫描仓库文件…');
            const snapshot = await gitPort.inspect(targetDir);
            report('finalize', null, '正在生成项目与记忆…');
            const profile = inferProjectProfile(snapshot);

            const updated = await service.updateProject(created.id, {
              ...(profile.platforms.length > 0 ? { targetPlatforms: profile.platforms } : {}),
              ...(Object.keys(profile.techStack).length > 0 ? { techStackFingerprint: profile.techStack } : {}),
            });

            // 推断出的项目记忆草稿（技术栈 / 框架依据）落库，与模板新建同一口径
            const now = Date.now();
            const insertMemory = db.prepare(
              `INSERT INTO memory_item (id, user_id, scope, project_id, page_id, title, content, tags, source_type,
                 confidence, importance, status, pinned, version, created_at, updated_at)
               VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 'git', 0.8, 3, 'active', 0, 1, ?, ?)`,
            );
            for (const draft of profile.memoryDrafts) {
              insertMemory.run(
                newUlid(),
                userId,
                draft.scope,
                created.id,
                draft.title,
                draft.content,
                JSON.stringify(draft.tags),
                now,
                now,
              );
            }

            return updated;
          } catch (error) {
            // 克隆/推断失败时补偿清理：不留一个"指向空目录"的项目
            try {
              await service.purgeProject(created.id);
            } catch {
              /* 清理失败不掩盖原始错误 */
            }
            rmSync(projectDirectory, { recursive: true, force: true });
            throw error;
          }
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

        case 'getThumbnailUrl':
          // 缩略图生成器未装配：契约允许返回 null，卡片显示占位（不编造地址）
          return null;

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
export function validateProjectLayout(projectsDir: string, projectId: string): WorkspaceValidateResult {
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
