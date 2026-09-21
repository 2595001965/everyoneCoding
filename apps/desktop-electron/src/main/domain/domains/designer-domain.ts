import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type Database from 'better-sqlite3';

import {
  MemoryRepo,
  PageMemoryService,
  ProjectMemoryService,
  condensePage,
  diffSummary,
  enforceTokenBudget,
  hasStructuralChange,
  type CondensedDiff,
  type CondensedSummary,
  type PageDsl as CondenserPageDsl,
  type PageDslElement as CondenserElementNode,
} from '@ec/memory';
import {
  createEmptyPage,
  serializePageDsl,
  validatePageDsl,
  type ElementNode,
  type PageDsl,
  type Platform,
} from '@ec/designer/dsl';
import { documentFromText, type NoteType, type UpdateNoteInput } from '@ec/designer/notes';
import { ShellError } from '@ec/shell-api';

import type { DomainRouter } from '../runtime';
import type { AiStackHandle } from '../domain-factories';
import { createDesignerNoteStore, type DesignerNoteStore } from '../designer-notes';
import { upsertRegistryEntry } from './rename-domain';

/**
 * designer 域生产路由（T12-02 设计器端口）。
 *
 * 职责：
 * - DSL 落盘：`<projectsDir>/<projectId>/design/pages/<pageId>.dsl.json`（信封结构，原子写）；
 * - 页面表登记：page 行与 DSL 文件同步（dsl_ref 指向文件）；
 * - **页面记忆增量写**（`PageMemoryPort`）：结构精简 → 写页面记忆 → 结构变更追加 revision；
 * - **路由总表**（`ProjectRouteMemoryPort`）：写项目记忆的 `路由总表` 分区；
 * - 元素备注（FR-ANN）：真实落库并复用领域层的优先级 / 历史规则；
 * - AI 生成页面：走真实 gateway（interface 用途）并**校验 DSL**。
 *
 * 为什么不用 `StructureCondenser.sync()` 一把梭：它除了写页面记忆，还会顺手写
 * 项目记忆（routes / modules）与功能记忆。本项目里"路由总表"由 `ProjectRouteMemoryPort`
 * 独家负责（新增/改名/删除页面时触发），两条路径同时写会产生互相覆盖的竞争；
 * 而模块划分需要跨页面的全局信息，单页保存时推导出来的只是该页的 featureRef。
 * 因此这里只取它前三步的语义（精简 → 页面记忆 → 增量 revision），用同一批
 * 领域原语实现，不复制任何规则。
 */

export interface DesignerDomainOptions {
  db: Database.Database;
  projectsDir: string;
  aiStack: AiStackHandle | null;
  userId: string;
  /** 与 ai-context 域共用同一份备注存储 */
  notes?: DesignerNoteStore | undefined;
}

/**
 * 单页面结构摘要的 token 上限（T2-06 验收口径：≤2k）
 */
const PAGE_SUMMARY_TOKEN_BUDGET = 2_000;

/**
 * 设计器 DSL → 精简器 DSL 的桥接。
 *
 * 两个 PageDsl 是**同名不同包**的类型：设计器的 `ElementNode.noteId` 是
 * `string | null`，精简器的是可选 `string`（`exactOptionalPropertyTypes` 下二者不兼容），
 * 另外设计器侧还有 `locked` / `hidden` / `masterRef` / `responsive` / `condition` /
 * `permission` 等精简器不认识的字段。与其放宽类型（会掩盖真实的形状差异），
 * 不如在这里显式映射一次：**只搬运精简器真正消费的字段**，并顺手说明"哪些字段被有意丢弃"。
 *
 * 丢弃是安全的：精简器只输出组件类型 / 层级 / 绑定 / 事件目标 / 接口依赖，
 * 锁定态、断点差异、母版引用与条件表达式都不影响后端契约（它们属于前端渲染细节）。
 */
function toCondenserDsl(page: PageDsl): CondenserPageDsl {
  return {
    id: page.id,
    projectId: page.projectId,
    name: page.name,
    platform: page.platform,
    route: page.route,
    featureId: page.featureId ?? null,
    viewport: { width: page.viewport.width, height: page.viewport.height },
    state: page.state.map((entry) => ({
      name: entry.name,
      type: entry.type,
      ...(entry.initial !== undefined ? { initial: entry.initial } : {}),
      ...(entry.source !== undefined ? { source: entry.source } : {}),
    })),
    tree: toCondenserElement(page.tree),
    events: page.events.map((event) => ({
      id: event.id,
      trigger: event.trigger,
      actions: event.actions.map((action) => ({
        kind: action.kind,
        ...(action.target !== undefined ? { target: action.target } : {}),
        ...(action.value !== undefined ? { value: action.value } : {}),
      })),
    })),
    apiDeps: [...page.apiDeps],
  };
}

function toCondenserElement(node: ElementNode): CondenserElementNode {
  return {
    id: node.id,
    type: node.type,
    ...(node.name !== undefined ? { name: node.name } : {}),
    ...(node.props !== undefined ? { props: node.props } : {}),
    ...(node.bindings !== undefined ? { bindings: node.bindings } : {}),
    featureRef: node.featureRef ?? null,
    ...(node.children !== undefined ? { children: node.children.map(toCondenserElement) } : {}),
  };
}

export function createDesignerDomain(options: DesignerDomainOptions): {
  router: DomainRouter;
  notes: DesignerNoteStore;
} {
  const repo = new MemoryRepo(options.db);
  const pageMemory = new PageMemoryService(repo, options.userId);
  const projectMemory = new ProjectMemoryService(repo, options.userId);
  const notes =
    options.notes ?? createDesignerNoteStore({ db: options.db, userId: options.userId });

  const pagesDirOf = (projectId: string): string =>
    join(options.projectsDir, projectId, 'design', 'pages');

  const requireProject = (params: Record<string, unknown>): string => {
    const projectId = String(params['projectId'] ?? '');
    if (projectId.length === 0) throw new ShellError('INVALID_ARGUMENT', '缺少 projectId');
    if (!existsSync(join(options.projectsDir, projectId))) {
      throw new ShellError('NOT_FOUND', `项目不存在：${projectId}`);
    }
    return projectId;
  };

  /**
   * 登记 DSL 引用到的功能行。
   *
   * 为什么必须有：`memory_item.feature_id` 与 `element.feature_ref` 都是
   * **指向 `feature` 表的外键**。DSL 里的 `featureRef` 是设计器按需打上的标签，
   * 不保证功能行已经存在 —— 不补这一行，写页面记忆（带 featureId）和元素行
   * 会直接抛 `FOREIGN KEY constraint failed`，而且只在"页面真的归属某功能"时现形。
   */
  const ensureFeatureRows = (projectId: string, featureIds: readonly string[]): void => {
    if (featureIds.length === 0) return;
    const now = Date.now();
    const insert = options.db.prepare(
      `INSERT OR IGNORE INTO feature (id, project_id, name, description, status, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 'planned', ?, ?)`,
    );
    for (const featureId of featureIds) {
      if (featureId.length === 0) continue;
      insert.run(featureId, projectId, featureId, now, now);
    }
  };

  /** 收集页面与元素上声明的功能引用（去重、稳定排序） */
  const featureRefsOf = (page: PageDsl): string[] => {
    const refs = new Set<string>();
    if (typeof page.featureId === 'string' && page.featureId.length > 0) refs.add(page.featureId);
    const walk = (node: ElementNode): void => {
      if (typeof node.featureRef === 'string' && node.featureRef.length > 0)
        refs.add(node.featureRef);
      for (const child of node.children ?? []) walk(child);
    };
    walk(page.tree);
    return [...refs].sort();
  };

  /**
   * 把 DSL 组件树同步到 `element` 表。
   *
   * 这不是"顺手做的一致性工作"，而是 `code_anchor.element_id` 外键的前提：
   * 锚点（T4-06）按元素入库，元素行不存在时整个写回会失败。
   * `note_id` 刻意留空 —— DSL 里的 `noteId` 指向设计器内部的 PageNote，
   * 与 `note` 表（FR-ANN 的备注）不是同一套 id，硬塞会破坏外键语义。
   */
  const syncElementRows = (page: PageDsl): void => {
    const now = Date.now();
    const remove = options.db.prepare(`DELETE FROM element WHERE page_id = ?`);
    const insert = options.db.prepare(
      `INSERT INTO element (id, page_id, parent_id, type, name, props_json, style_json, feature_ref, note_id, order_index, anchor_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)`,
    );
    const replace = options.db.transaction(() => {
      remove.run(page.id);
      let order = 0;
      const walk = (node: ElementNode, parentId: string | null): void => {
        insert.run(
          node.id,
          page.id,
          parentId,
          node.type,
          node.name ?? node.type,
          node.props !== undefined ? JSON.stringify(node.props) : null,
          node.style !== undefined ? JSON.stringify(node.style) : null,
          typeof node.featureRef === 'string' && node.featureRef.length > 0
            ? node.featureRef
            : null,
          order,
          now,
          now,
        );
        order += 1;
        for (const child of node.children ?? []) walk(child, node.id);
      };
      walk(page.tree, null);
    });
    replace();
  };

  const upsertPageRow = (
    projectId: string,
    page: { pageId: string; name: string; route: string | null },
  ): void => {
    const now = Date.now();
    const existing = options.db
      .prepare(`SELECT id FROM page WHERE project_id = ? AND id = ?`)
      .get(projectId, page.pageId);
    if (existing) {
      options.db
        .prepare(`UPDATE page SET name = ?, route = ?, dsl_ref = ?, updated_at = ? WHERE id = ?`)
        .run(page.name, page.route, `design/pages/${page.pageId}.dsl.json`, now, page.pageId);
    } else {
      options.db
        .prepare(
          `INSERT INTO page (id, project_id, feature_id, name, route, dsl_ref, created_at, updated_at)
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
        )
        .run(
          page.pageId,
          projectId,
          page.name,
          page.route,
          `design/pages/${page.pageId}.dsl.json`,
          now,
          now,
        );
    }
  };

  /**
   * 页面结构摘要落页面记忆（T2-06 前三步，增量语义）。
   *
   * 返回 revision 台账：`revision` 只在结构**真的变了**时才递增 ——
   * 设计器每 600ms 就会因为一次拖拽把整份 DSL 重发一遍，
   * 若无条件追加 revision，"最近 5 次结构变更"会被同一次拖拽刷满。
   */
  const syncPageStructure = (
    projectId: string,
    pageId: string,
    pageName: string,
    route: string | null,
    dsl: PageDsl,
  ): {
    memoryId: string;
    revision: number;
    changed: string[];
    tokenEstimate: number;
    truncated: boolean;
  } => {
    const condensed = condensePage(toCondenserDsl(dsl));
    const budget = enforceTokenBudget(condensed, PAGE_SUMMARY_TOKEN_BUDGET);
    const summary = budget.summary;
    const outcome = pageMemory.upsert({
      projectId,
      pageId,
      featureId: dsl.featureId ?? null,
      pageName,
      route,
      structured: {
        skeleton: summary.skeleton,
        blocks: summary.blocks,
        state: summary.state,
        events: summary.events,
        dataFlow: summary.dataFlow,
        apiDeps: summary.apiDeps,
      },
      options: { sourceType: 'auto_design', confidence: 0.9, importance: 3 },
    });
    const memoryId = outcome.item.id;

    const latest = repo.revisions.latest(memoryId);
    const diff: CondensedDiff | null = latest
      ? diffSummary(latest.summary as unknown as CondensedSummary, summary)
      : null;
    const changed = diff === null ? true : hasStructuralChange(diff);
    const revision = changed
      ? repo.revisions.append({
          memoryId,
          pageId,
          summary: summary as unknown as Record<string, unknown>,
          tokenEstimate: budget.tokens.tokens,
          truncated: budget.truncated,
          diff,
        }).revision
      : (latest?.revision ?? 0);

    return {
      memoryId,
      revision,
      // 「变更的元素」对 UI 而言是"这次动了哪些节点"：新增 / 修改 / 移除三者都算。
      // 只报 changedIds 会让"刚拖进来一个按钮"显示成"没有变更"。
      changed:
        diff === null
          ? []
          : [...new Set([...diff.changedIds, ...diff.addedIds, ...diff.removedIds])],
      tokenEstimate: budget.tokens.tokens,
      truncated: budget.truncated,
    };
  };

  const router: DomainRouter = async (method, params, ctx) => {
    switch (method) {
      case 'openProject': {
        const projectId = requireProject(params);
        mkdirSync(pagesDirOf(projectId), { recursive: true });
        return { projectId };
      }

      case 'listPages': {
        const projectId = requireProject(params);
        const dir = pagesDirOf(projectId);
        if (!existsSync(dir)) return [];
        const pages: Array<{ pageId: string; name: string; route: string | null }> = [];
        for (const entry of readdirSync(dir)) {
          if (!entry.endsWith('.dsl.json')) continue;
          try {
            const envelope = JSON.parse(readFileSync(join(dir, entry), 'utf8')) as {
              page?: { id?: string; name?: string; route?: string };
            };
            pages.push({
              pageId: envelope.page?.id ?? entry.replace('.dsl.json', ''),
              name: envelope.page?.name ?? entry,
              route: envelope.page?.route ?? null,
            });
          } catch {
            // 坏文件跳过
          }
        }
        return pages;
      }

      case 'loadPage': {
        const projectId = requireProject(params);
        const pageId = String(params['pageId'] ?? '');
        const file = join(pagesDirOf(projectId), `${pageId}.dsl.json`);
        if (!existsSync(file)) throw new ShellError('NOT_FOUND', `页面不存在：${pageId}`);
        const envelope = JSON.parse(readFileSync(file, 'utf8')) as unknown;
        return envelope;
      }

      case 'savePage': {
        const projectId = requireProject(params);
        const envelope = params['envelope'] as Record<string, unknown>;
        const page = (envelope['page'] ?? {}) as Record<string, unknown>;
        const pageId = String(page['id'] ?? '');
        if (pageId.length === 0) throw new ShellError('INVALID_ARGUMENT', 'DSL 缺少页面 id');
        const dir = pagesDirOf(projectId);
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${pageId}.dsl.json`);
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, JSON.stringify(envelope, null, 2), 'utf8');
        renameSync(tmp, file);

        upsertPageRow(projectId, {
          pageId,
          name: String(page['name'] ?? pageId),
          route: typeof page['route'] === 'string' ? page['route'] : null,
        });

        // 组件树 → element 表（锚点写回与导航关系的外键前提）。
        // DSL 校验不过时只跳过这一步：保存本身仍成功，避免"老文件打不开"。
        const validated = validatePageDsl(envelope['page']);
        if (validated.ok) {
          ensureFeatureRows(projectId, featureRefsOf(validated.value));
          syncElementRows(validated.value);
        }

        // 注册表登记（统一标识，T7 注册表的数据源之一）
        upsertRegistryEntry(options.db, {
          projectId,
          entityType: 'page',
          entityId: pageId,
          canonicalName: String(page['name'] ?? pageId),
          projections: { routeSegment: String(page['route'] ?? '').replace(/^\//, '') },
        });

        ctx.emit({
          type: 'pipeline:stage-event',
          projectId,
          event: 'page-saved',
          data: { pageId },
        });
        return { pageId, savedAt: Date.now() };
      }

      case 'createPage': {
        const projectId = requireProject(params);
        const input = params['input'] as { name: string; route: string; platform?: string };
        const pageId = `page-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        /**
         * 用 `@ec/designer/dsl` 的领域工厂产出**合法** PageDsl，不手写对象字面量。
         *
         * 教训：手写曾漏掉 `projectId` / `viewport` / `apiDeps` / `notes` / `anchors`，
         * 并把 `state` 写成 `states` —— 文件落盘成功、`listPages` 也能列出来，
         * 但渲染层 `deserializePageDsl` 的 zod 校验必然失败，于是"新建项目后打开设计器"
         * 会直接报「项目内没有可用的页面 DSL」。字段完整性由工厂统一保证。
         */
        const page = createEmptyPage({
          id: pageId,
          projectId,
          name: input.name,
          platform: (input.platform ?? 'web') as Platform,
          route: input.route,
        });
        const serialized = serializePageDsl(page);
        const dir = pagesDirOf(projectId);
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${pageId}.dsl.json`);
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, serialized, 'utf8');
        renameSync(tmp, file);
        upsertPageRow(projectId, {
          pageId,
          name: input.name,
          route: input.route,
        });
        ensureFeatureRows(projectId, featureRefsOf(page));
        syncElementRows(page);
        // 返回与落盘内容逐字一致的信封（渲染层据此直接装载，不必再读一次文件）
        return JSON.parse(serialized) as unknown;
      }

      case 'writePageStructure': {
        const projectId = requireProject(params);
        const input = params['input'] as {
          pageId: string;
          pageName: string;
          route?: string;
          /** 页面 DSL 全文：精简由主进程完成（渲染层的 browser 入口不含 condenser） */
          dsl?: unknown;
          /** 兼容：调用方已精简过的摘要（内部/测试用） */
          summary?: unknown;
        };
        const pageId = String(input.pageId ?? '');
        if (pageId.length === 0) throw new ShellError('INVALID_ARGUMENT', '缺少 pageId');

        if (input.dsl === undefined) {
          // 只有摘要的旧路径：直接落页面记忆（不做精简，也不追加 revision）
          const structured = (input.summary ?? {}) as Record<string, unknown>;
          const outcome = pageMemory.upsert({
            projectId,
            pageId,
            pageName: input.pageName,
            route: input.route ?? null,
            structured: {
              skeleton: structured['skeleton'],
              blocks: structured['blocks'],
              state: structured['state'],
              events: structured['events'],
              dataFlow: structured['dataFlow'],
              apiDeps: structured['apiDeps'],
            },
            options: { sourceType: 'auto_design' },
          });
          return {
            id: outcome.item.id,
            revision: 0,
            changed: [],
            tokenEstimate: 0,
            truncated: false,
          };
        }

        // DSL 本体先过领域校验：非法结构直接拒绝，而不是把垃圾摘要写进记忆
        const validation = validatePageDsl(input.dsl);
        if (!validation.ok) {
          throw new ShellError(
            'INVALID_ARGUMENT',
            `页面 DSL 不合法，已拒绝写入页面记忆：${validation.issues.slice(0, 5).join('；')}`,
          );
        }
        const dsl = validation.value;
        // 功能行先落地，否则带 featureId 的页面记忆会撞外键
        ensureFeatureRows(projectId, featureRefsOf(dsl));
        // `route` 以 DSL 为准；显式传入的 route 只在前者缺失时兜底
        const route = dsl.route ?? input.route ?? null;
        return syncPageStructure(projectId, pageId, input.pageName ?? dsl.name, route, dsl);
      }

      case 'listStructureRevisions': {
        const pageId = String(params['pageId'] ?? '');
        const item = pageMemory.findByPage(pageId);
        if (item === null) return [];
        return repo.revisions.list(item.id).map((row) => ({
          revision: row.revision,
          tokenEstimate: row.tokenEstimate,
          createdAt: row.createdAt,
          changed: (() => {
            const diff = row.diff as CondensedDiff | null;
            if (diff === null || typeof diff !== 'object') return [];
            return [
              ...new Set([
                ...(diff.changedIds ?? []),
                ...(diff.addedIds ?? []),
                ...(diff.removedIds ?? []),
              ]),
            ];
          })(),
          truncated: row.truncated,
        }));
      }

      case 'upsertRoutes': {
        const projectId = requireProject(params);
        const input = (params['routes'] as readonly unknown[]) ?? [];
        // 渲染层给的是 RouteEntry[]；测试与内部调用给的是路径字符串数组。
        // 两种都接受，但**存进去的永远是规范化后的路径**：路由总表的消费者是
        // 冲突检测（按 path 判重）与上下文注入（结构化摘要只提取 routes 键）。
        const paths: string[] = [];
        for (const entry of input) {
          if (typeof entry === 'string') paths.push(entry);
          else if (entry !== null && typeof entry === 'object') {
            const path = (entry as { path?: unknown }).path;
            if (typeof path === 'string' && path.length > 0) paths.push(path);
          }
        }
        projectMemory.mergeRoutes(projectId, paths);
        return readRoutePaths(projectId);
      }

      case 'readRoutes': {
        const projectId = requireProject(params);
        return readRoutePaths(projectId);
      }

      case 'generatePage': {
        const projectId = requireProject(params);
        const request = params['request'] as Record<string, unknown>;
        if (options.aiStack === null) {
          throw new ShellError(
            'NOT_SUPPORTED',
            'AI 栈未装配：请先在设置页配置模型服务与 API Key，再使用 AI 生成页面。可先手动拖拽搭建。',
          );
        }
        let text = '';
        let model = '';
        for await (const chunk of options.aiStack.gateway.chat({
          userId: options.userId,
          purpose: 'interface',
          projectId,
          messages: [
            {
              role: 'system',
              content:
                '你是界面生成器。按描述输出页面 DSL 候选 JSON（PageDsl 结构：id/name/route/platform/tree/states/events）。只输出 JSON。',
            },
            {
              role: 'user',
              content: `页面描述：${String(request['prompt'] ?? '')}\n平台：${String(request['platform'] ?? 'web')}\n路由：${String(request['route'] ?? '/')}`,
            },
          ],
        })) {
          if (chunk.type === 'chunk' && typeof chunk['text'] === 'string') text += chunk['text'];
          if (typeof chunk['model'] === 'string' && chunk['model'].length > 0) {
            model = chunk['model'];
          }
          if (chunk.type === 'error') {
            throw new ShellError('UNKNOWN', `页面生成失败：${String(chunk['error'] ?? '')}`);
          }
        }
        let candidate: unknown;
        try {
          candidate = JSON.parse(text) as unknown;
        } catch {
          candidate = null;
        }
        // 领域侧先校验一次并如实上报结论：渲染层仍会走 `dslFromAi` 的容错归一化
        // （未知组件降级、超深裁剪），但那属于"修复"，这里给出的是"原始候选是否合规"。
        const validation = candidate === null ? null : validatePageDsl(candidate);
        return {
          candidate,
          raw: text,
          model: model.length > 0 ? model : '未上报（由用途绑定决定）',
          validation:
            validation === null
              ? { ok: false, issues: ['模型输出不是合法 JSON'] }
              : validation.ok
                ? { ok: true, issues: [] }
                : { ok: false, issues: validation.issues },
        };
      }

      /* ------------------------------ 备注（FR-ANN） ------------------------------ */

      case 'readNotes': {
        const input = params as {
          projectId: string;
          targetType?: string;
          targetId?: string;
          status?: 'open' | 'resolved';
        };
        const projectId = requireProject(params);
        return notes.list(projectId, {
          ...(input.targetType !== undefined
            ? { targetType: input.targetType as 'element' | 'page' | 'feature' }
            : {}),
          ...(input.targetId !== undefined ? { targetId: input.targetId } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
        });
      }

      case 'saveNote': {
        const projectId = requireProject(params);
        const input = params['input'] as {
          targetType: 'element' | 'page' | 'feature';
          targetId: string;
          type?: string;
          title?: string;
          text?: string;
          manualPriority?: number | null;
        };
        return notes.create({
          projectId,
          targetType: input.targetType,
          targetId: input.targetId,
          ...(input.type !== undefined ? { type: input.type as NoteType } : {}),
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.text !== undefined ? { text: input.text } : {}),
          ...(input.manualPriority !== undefined ? { manualPriority: input.manualPriority } : {}),
          createdBy: options.userId,
        });
      }

      case 'updateNote': {
        const projectId = requireProject(params);
        const id = String(params['id'] ?? '');
        const raw = (params['patch'] ?? {}) as Record<string, unknown> & { text?: unknown };
        // 渲染层用纯文本编辑备注（`text`），领域层要的是富文本文档：在这里转一次，
        // 而不是把 `documentFromText` 的规则在渲染层再实现一遍。
        const patch: UpdateNoteInput = {
          ...(raw['type'] !== undefined ? { type: raw['type'] as NoteType } : {}),
          ...(raw['title'] !== undefined ? { title: String(raw['title']) } : {}),
          ...(typeof raw['text'] === 'string' ? { content: documentFromText(raw['text']) } : {}),
          ...(raw['status'] !== undefined ? { status: raw['status'] as 'open' | 'resolved' } : {}),
          ...(raw['manualPriority'] !== undefined
            ? { manualPriority: raw['manualPriority'] as number | null }
            : {}),
        };
        const updated = notes.update(projectId, id, patch);
        if (updated === null) throw new ShellError('NOT_FOUND', `备注不存在：${id}`);
        return updated;
      }

      case 'setNoteStatus': {
        const projectId = requireProject(params);
        const id = String(params['id'] ?? '');
        const status = params['status'] === 'resolved' ? 'resolved' : 'open';
        const updated = notes.setStatus(projectId, id, status);
        if (updated === null) throw new ShellError('NOT_FOUND', `备注不存在：${id}`);
        return updated;
      }

      case 'removeNote': {
        const projectId = requireProject(params);
        const id = String(params['id'] ?? '');
        return { removed: notes.remove(projectId, id) };
      }

      case 'noteBadges': {
        const projectId = requireProject(params);
        const targetType = (params['targetType'] ?? 'element') as 'element' | 'page' | 'feature';
        return notes.badgeCounts(projectId, targetType);
      }

      default:
        throw new ShellError('INVALID_ARGUMENT', `designer 域未知方法：${method}`);
    }
  };

  /** 读回路由总表（项目记忆的 `路由总表` 分区，结构化键为 routes） */
  function readRoutePaths(projectId: string): string[] {
    const item = projectMemory.get(projectId).routes;
    if (item === null || item.structured === null) return [];
    const routes = item.structured['routes'];
    if (!Array.isArray(routes)) return [];
    return routes.filter((path): path is string => typeof path === 'string');
  }

  return { router, notes };
}

/** 保留给 T12-02 扩展：路径校验共享 */
export const designerPathGuard = (projectsDir: string, projectId: string): string => {
  const base = resolve(join(projectsDir, projectId));
  if (!base.startsWith(resolve(projectsDir) + sep)) {
    throw new ShellError('INVALID_ARGUMENT', '非法项目标识');
  }
  return base;
};
