import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

import type { DomainKind } from '@ec/shell-api';
import type { GitCredentialStore } from '@ec/git';

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
   * Git 凭据存储（DPAPI）。null = 系统加密不可用，凭据类方法如实降级，绝不落明文。
   */
  credentials: GitCredentialStore | null;
}

/** AI 栈最小句柄（避免本文件 import @ec/ai 全量类型） */
export interface AiStackHandle {
  gateway: {
    chat(input: {
      userId: string;
      purpose: string;
      messages: ReadonlyArray<{ role: string; content: string }>;
      projectId?: string | undefined;
      signal?: AbortSignal | undefined;
    }): AsyncIterable<{ type: string; text?: string | undefined; [key: string]: unknown }>;
    embed?(input: {
      userId: string;
      texts: readonly string[];
      signal?: AbortSignal | undefined;
    }): Promise<{ vectors: number[][] } | null>;
  };
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
  const pipeline = createPipelineDomain({
    db: ctx.db,
    projectsDir: ctx.projectsDir,
    dataDir: ctx.dataDir,
    userId: ctx.userId,
    aiStack: ctx.aiStack,
    // 不传 emit：流水线的进度/阶段事件全部发生在请求内，走 runtime 的 ctx.emit
    memoryRouter: memory.router,
  });
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
  });
  // code 域要**先建**：它导出的 `writePort` 是 git（冲突落盘）与 rename（代码栏）
  // 的唯一写入口。顺序反了就会退化成"各写各的文件"，D-04 也就名存实亡。
  const code = createCodeDomain({
    db: ctx.db,
    projectsDir: ctx.projectsDir,
    emit: ctx.emit,
    aiStack: ctx.aiStack,
    userId: ctx.userId,
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
  const usage = createUsageDomain({ db: ctx.db, userId: ctx.userId });
  const pack = createPackageDomain({ db: ctx.db, projectsDir: ctx.projectsDir, userId: ctx.userId });

  disposers.push(pipeline.dispose, preview.dispose, code.dispose);

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
      package: pack,
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
