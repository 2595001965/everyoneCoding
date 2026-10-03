import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { AgentStore, type AttemptContext, type GatewayContextPreviewRequest } from '@ec/ai';

import type { DomainKind } from '@ec/shell-api';
import {
  createCliGitBackend,
  createNodeGitRunner,
  type GitBackend,
  type GitCredentialStore,
} from '@ec/git';

import type { ControlledProcessHost } from './process-host';
import type { DomainRouter, SyncDomainRouter } from './runtime';
import { createMemoryDomain } from './domains/memory-domain';
import { createPipelineDomain } from './domains/pipeline-domain';
import { createGitDomain } from './domains/git-domain';
import { createPreviewDomain } from './domains/preview-domain';
import { createRenameDomain } from './domains/rename-domain';
import { createAiContextDomain } from './domains/ai-context-domain';
import { createCodeDomain } from './domains/code-domain';
import { createNavDomain } from './domains/nav-domain';
import { createDesignerDomain } from './domains/designer-domain';
import { createUsageDomain } from './domains/usage-domain';
import { createPackageDomain } from './domains/package-domain';
import { createDesignerNoteStore } from './designer-notes';
import { TaskWriteService } from './task-write-service';
import { taskFileSystem } from './task-file-system';
import { resolveCodeRoot } from './code-root';

/**
 * T12-01 生产端口总装：领域域工厂集合。
 *
 * 每个工厂接收共享上下文（业务库 / 工程目录根 / AI 栈 / 事件发射器），
 * 返回可挂进 `createDomainRuntime.routers` 的路由函数。
 * 域实现只调 `ctx.emit(payload)`，requestId/domain 由 runtime 补齐（见 runtime.ts）。
 */

export interface DomainFactoryContext {
  db: Database.Database;
  /** 工程目录根 `<workspaceRoot>/projects` */
  projectsDir: string;
  /** 数据目录（快照 / 缓存 / 导出落点） */
  dataDir: string;
  userId: string;
  /** AI 栈句柄（未装配时为 null；域按此如实降级，不伪造生成结果） */
  aiStack: AiStackHandle | null;
  /**
   * 事件发射器（**非请求来源**事件专用：外部改动监视器、定时器、长驻子进程日志等）。
   *
   * 请求内产生的进度事件一律走 `ctx.emit`——那条路径由 runtime 补齐
   * requestId/domain 信封。这里必须显式给出域标识，因为调用方没有请求上下文。
   * sink 侧对"找不到请求目标"的事件做常驻广播（见 `ipc/domain.ts`），
   * 因此本口产出的日志/监视事件最终能到达渲染层，而不是进黑洞。
   */
  emit: (domain: DomainKind, payload: unknown) => void;
  /**
   * 受控进程端口（T12-04）：真实后端托管 / 依赖安装的唯一出口。
   * null = 外壳未提供进程能力，preview 域如实报 NOT_SUPPORTED（静态预览仍可用）。
   */
  process: ControlledProcessHost | null;
  /**
   * 页面截图端口（V2-D02 缩略图；Electron 离屏窗口实现）。
   * 缺省 = 不生成缩略图，getThumbnailUrl 保持 null（工作台卡片显示明确占位）。
   */
  capturePage?: ((url: string) => Promise<Buffer | null>) | undefined;
  /**
   * Git 凭据存储（DPAPI）。null = 系统加密不可用，凭据类方法如实降级，绝不落明文。
   */
  credentials: GitCredentialStore | null;
  /** D07 任务副本使用的 Git 后端；缺省使用系统 Git CLI，不执行 init/commit。 */
  taskWriteGit?: GitBackend;
}

/** AI 栈最小句柄（避免本文件 import @ec/ai 全量类型） */
export interface AiStackHandle {
  agentStore?: AgentStore;
  gateway: {
    chat(input: {
      userId: string;
      purpose: string;
      messages: ReadonlyArray<{ role: string; content: string }>;
      projectId?: string | undefined;
      modelId?: string | undefined;
      providerId?: string | undefined;
      sessionId?: string | undefined;
      taskId?: string | undefined;
      logicalRequestId?: string | undefined;
      temperature?: number | undefined;
      maxTokens?: number | undefined;
      signal?: AbortSignal | undefined;
    }): AsyncIterable<{ type: string; text?: string | undefined; [key: string]: unknown }>;
    /**
     * 某用途实际会用的模型（与 chat 同一条解析链）。
     * 上下文组装据此取绑定模型的上下文窗口作预算；null = 尚未配置可用模型。
     */
    describeModel?(
      userId: string,
      purpose: string,
    ): { modelName: string; providerName: string; contextWindow: number | null } | null;
    previewContext?(input: GatewayContextPreviewRequest): AttemptContext | null;
    embed?(input: {
      userId: string;
      texts: readonly string[];
      signal?: AbortSignal | undefined;
    }): Promise<{ vectors: number[][] } | null>;
  };
  /**
   * 预算护栏（可选）。
   *
   * usage 域在设置页改预算后必须把新配置推给运行中的网关，
   * 否则"超限拒绝"要等重启才生效——那是"改了预算却还在烧钱"的典型症状。
   */
  budget?: {
    configure(patch: {
      dailyUsd?: number | null;
      monthlyUsd?: number | null;
      alertRatio?: number;
    }): void;
  };
  usage?: { onEvent(listener: (event: unknown) => void): () => void };
}

export interface DomainFactories {
  memory: DomainRouter;
  pipeline: DomainRouter;
  git: DomainRouter;
  preview: DomainRouter;
  rename: DomainRouter;
  'ai-context': DomainRouter;
  code: DomainRouter;
  nav: DomainRouter;
  designer: DomainRouter;
  usage: DomainRouter;
  package: DomainRouter;
}

export interface DomainFactoryResult {
  routers: Partial<Record<string, DomainRouter>>;
  /**
   * 同步路由（记忆 / 流水线两域）。
   *
   * 渲染层的 `MemoryApi` / `PipelineApi` 是同步签名端口，且消费方会在写入后
   * 立刻同步读回（如 `advance()` 后紧跟 `snapshot()`）；它们经 `ec:domain:invokeSync`
   * 走这条通道，主进程侧复用同一份域实现，不产生第二套状态。
   */
  syncRouters: Partial<Record<string, SyncDomainRouter>>;
  disposers: ReadonlyArray<() => Promise<void>>;
}

export function createProductionDomains(ctx: DomainFactoryContext): DomainFactoryResult {
  // 工程目录根幂等建出（WorkspaceLayout 约定：design/docs/pipeline/code/meta）
  mkdirSync(ctx.projectsDir, { recursive: true });

  const disposers: Array<() => Promise<void>> = [];

  const memory = createMemoryDomain({ db: ctx.db, userId: ctx.userId });
  // 备注存储单例：设计器（读写）与上下文引擎（注入）必须看到同一份内存副本，
  // 否则「刚加的备注没进上下文」这类问题会以"偶发"的形态长期存在。
  const notes = createDesignerNoteStore({ db: ctx.db, userId: ctx.userId });
  const designer = createDesignerDomain({
    db: ctx.db,
    projectsDir: ctx.projectsDir,
    aiStack: ctx.aiStack,
    userId: ctx.userId,
    notes,
  });
  const aiContext = createAiContextDomain({
    db: ctx.db,
    projectsDir: ctx.projectsDir,
    userId: ctx.userId,
    notes,
    aiStack: ctx.aiStack,
    readDomAttachments: (projectId) => preview.readDomAttachments(projectId),
  });
  const agentStore = ctx.aiStack?.agentStore ?? new AgentStore(ctx.db);
  const taskWriteGit = ctx.taskWriteGit ?? createCliGitBackend({ runner: createNodeGitRunner() });
  const taskWrites = new TaskWriteService({
    storageDir: join(ctx.dataDir, 'task-writes'),
    codeRoot: (projectId) => resolveCodeRoot(join(ctx.projectsDir, projectId)),
    git: taskWriteGit,
    owner: {
      assertOwner: () => agentStore.assertOwner(),
      fencingToken: () => {
        if (agentStore.token === null) throw new Error('协调器尚未取得任务写入租约');
        return agentStore.token;
      },
      write: <T>(action: () => T): T => agentStore.write(action),
    },
    validate: async (root, changed, task) => {
      const fs = taskFileSystem(root);
      return Promise.all(
        changed.map(async (path) => {
          const entry = task.journal.find((candidate) => candidate.path === path);
          const exists = await fs.exists(path);
          const expected = entry?.action === 'delete' ? !exists : exists;
          return {
            name: 'task-write-integrity',
            ok: expected,
            detail: expected
              ? `受影响文件 ${path} 已按计划落盘`
              : `受影响文件 ${path} 的合入状态与计划不一致`,
          };
        }),
      );
    },
    onTask: (task) => {
      // 把 D07 的副本/读写授权投影回 D06 的 AgentTask，保证任务中心看到的
      // worktreeId、baseRevision 和写集与磁盘上的权威 task.json 同步。
      try {
        const record = agentStore.get(ctx.userId, task.projectId, task.taskId);
        const gitCommit =
          task.baseRevision.head !== null && /^[0-9a-f]{40}$/.test(task.baseRevision.head)
            ? task.baseRevision.head
            : null;
        const contentHash = /^[0-9a-f]{64}$/.test(task.baseRevision.hash)
          ? `sha256:${task.baseRevision.hash}`
          : null;
        record.task = {
          ...record.task,
          worktreeId: task.worktreeRoot ?? task.copyRoot,
          readSet: [...task.readSet],
          writeSet: [...task.writeSet],
          ...(gitCommit !== null || contentHash !== null
            ? { baseRevision: { gitCommit, contentHash } }
            : {}),
        };
        const status =
          task.state === 'merged'
            ? 'merged'
            : task.state === 'cleaned'
              ? 'completed'
              : task.state === 'conflicted'
                ? 'conflicted'
                : task.state === 'failed'
                  ? 'failed'
                  : task.state === 'cancelled'
                    ? 'cancelled'
                    : task.state === 'awaiting_confirmation'
                      ? 'awaiting_confirmation'
                      : task.state === 'queued' || task.state === 'applying'
                        ? 'validating'
                        : record.task.status;
        agentStore.update(record, status);
      } catch {
        // 文件事务已先持久化；D06 状态投影可由下一次 owner 恢复重新对齐。
      }
    },
    emit: (task) =>
      ctx.emit('code', {
        type: 'code:task-write-updated',
        taskId: task.taskId,
        projectId: task.projectId,
        state: task.state,
        conflicts: task.conflicts.map((conflict) => conflict.path),
      }),
  });
  // code 域要**先建**：它导出的 `writePort` 是 git（冲突落盘）与 rename（代码栏）
  // 的唯一写入口。顺序反了就会退化成"各写各的文件"，D-04 也就名存实亡。
  const code = createCodeDomain({
    db: ctx.db,
    projectsDir: ctx.projectsDir,
    emit: ctx.emit,
    aiStack: ctx.aiStack,
    userId: ctx.userId,
    agentStore,
    taskWrites,
    readDomAttachments: (projectId) => preview.readDomAttachments(projectId),
  });
  const pipeline = createPipelineDomain({
    db: ctx.db,
    projectsDir: ctx.projectsDir,
    dataDir: ctx.dataDir,
    userId: ctx.userId,
    aiStack: ctx.aiStack,
    memoryRouter: memory.router,
    writeCode: code.writePort,
  });
  const git = createGitDomain({
    projectsDir: ctx.projectsDir,
    db: ctx.db,
    userId: ctx.userId,
    credentials: ctx.credentials,
    aiStack: ctx.aiStack,
    writeCode: code.writePort,
  });
  const preview = createPreviewDomain({
    projectsDir: ctx.projectsDir,
    db: ctx.db,
    userId: ctx.userId,
    process: ctx.process,
    capturePage: ctx.capturePage,
    resolveTaskPreview: (projectId, taskId) => {
      try {
        const task = taskWrites.get(taskId);
        if (task.projectId !== projectId || task.state === 'cleaned' || task.state === 'cancelled')
          return null;
        return { codeRoot: task.copyRoot, dataDir: task.dataDir };
      } catch {
        return null;
      }
    },
    // 后端进程日志在请求结束后仍会持续产生：只能走常驻事件口
    emit: (domain, payload) => ctx.emit(domain, payload),
  });
  const nav = createNavDomain({
    db: ctx.db,
    projectsDir: ctx.projectsDir,
    readRequestLogs: preview.readRequestLogs,
  });
  const rename = createRenameDomain({
    db: ctx.db,
    projectsDir: ctx.projectsDir,
    userId: ctx.userId,
    aiStack: ctx.aiStack,
    emit: (domain, payload) => ctx.emit(domain, payload),
  });
  const usage = createUsageDomain({
    db: ctx.db,
    userId: ctx.userId,
    ...(ctx.aiStack?.gateway.previewContext
      ? { previewContext: (input) => ctx.aiStack?.gateway.previewContext?.(input) ?? null }
      : {}),
    // 预算变更即时回灌 AI 网关：设置页改完当场生效（见 AiStackHandle.budget 注释）
    ...(ctx.aiStack?.budget
      ? { onBudgetChanged: (config) => ctx.aiStack?.budget?.configure(config) }
      : {}),
  });
  const unsubscribeUsage = ctx.aiStack?.usage?.onEvent((event) => {
    const value = event as { type?: string; event?: unknown };
    if (value.type === 'attempt-updated')
      ctx.emit('usage', { type: 'usage:updated', event: value.event });
  });
  if (unsubscribeUsage) disposers.push(async () => unsubscribeUsage());
  const pack = createPackageDomain({
    db: ctx.db,
    projectsDir: ctx.projectsDir,
    userId: ctx.userId,
    dataDir: ctx.dataDir,
    exportsDir: join(ctx.dataDir, 'exports'),
  });

  disposers.push(pipeline.dispose, preview.dispose, code.dispose, async () => pack.dispose());

  // 定时备份：启动补偿（漏跑立即补一次）→ 按配置排下一次。
  // 客户端内调度，不依赖系统任务计划程序。
  void pack.start().then((result) => {
    if (result.caughtUp) console.info(`[backup] ${result.message}`);
  });

  return {
    routers: {
      memory: memory.router,
      // 这三个域还带生命周期（监听器 / http server / 文件监视），既要挂路由也要收尾
      pipeline: pipeline.router,
      git,
      preview: preview.router,
      rename,
      'ai-context': aiContext,
      code: code.router,
      nav,
      designer: designer.router,
      usage,
      package: pack.router,
    },
    syncRouters: {
      memory: memory.syncRouter,
      pipeline: pipeline.syncRouter,
    },
    disposers,
  };
}

/** 工程目录下各产物的官方位置（WorkspaceLayout 约定，域内共用） */
export const PROJECT_LAYOUT = {
  designDir(projectsDir: string, projectId: string): string {
    return join(projectsDir, projectId, 'design');
  },
  pagesDir(projectsDir: string, projectId: string): string {
    return join(projectsDir, projectId, 'design', 'pages');
  },
  codeDir(projectsDir: string, projectId: string): string {
    return join(projectsDir, projectId, 'code');
  },
  pipelineDir(projectsDir: string, projectId: string): string {
    return join(projectsDir, projectId, 'pipeline');
  },
  docsDir(projectsDir: string, projectId: string): string {
    return join(projectsDir, projectId, 'docs');
  },
  metaDir(projectsDir: string, projectId: string): string {
    return join(projectsDir, projectId, 'meta');
  },
} as const;
