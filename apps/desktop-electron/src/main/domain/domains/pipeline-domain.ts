import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import type Database from 'better-sqlite3';

import {
  ArtifactStore,
  ContractInjector,
  GenerationQueue,
  MultiPlatformGenerator,
  PipelineMachine,
  PipelineRepo,
  S1RequirementStage,
  S3TechDocStage,
  STAGE_DEFS,
  SplitModel,
  deserializeProgress,
  parseSplitFromTechDoc,
  serializeProgress,
  techChoiceToStack,
  toStackObject,
  validateChoice,
  type ArtifactContentFs,
  type DocumentArchivePort,
  type PipelineDb,
  type PipelineStageSnapshot,
  type QueueState,
  type RequirementMemoryPort,
  type S5NodeData,
  type S5RunResult,
  type SimilarProjectSummary,
  type StageGenerationPort,
  type TechChoice,
} from '@ec/pipeline';
import { ShellError } from '@ec/shell-api';
import type { DependencyContract } from '@ec/ai';
import type { DomainRouter, DomainRouterContext, SyncDomainRouter } from '../runtime';
import { errorOfStreamChunk, textOfStreamChunk } from '../ai-stream-text';
import type { AiStackHandle } from '../domain-factories';

/**
 * pipeline 域生产路由（T12-03 / Wave5 生产运行时）。
 *
 * 职责：把 @ec/pipeline 的真实域实现（PipelineMachine + ArtifactStore +
 * S1/S3/S4/S5 阶段 + recovery 逻辑）装配进 Electron 主进程：
 * - 状态权威在 PipelineMachine（内存），落库三路：快照文件（断点）、
 *   stage_artifact 表（产物台账）、document / memory_item 表（文档入档与项目记忆）；
 * - 重启恢复：CrashRecovery 快照（dirty）→ 阶段状态；表台账 → 产物版本与 activeVersion；
 *   TechChoice 从 memory_item（scope=project, title=技术选型）恢复；
 * - S3 阻断：状态机 advance guard 检查 TechChoice，未选择不得进入 S3；
 * - S5 队列：真实 GenerationQueue 执行，节点级重试/跳过/暂停，进度经域事件下发；
 * - AI 不可用时如实报 NOT_SUPPORTED 并带引导文案，不用模板伪装生成结果。
 */

/** 每个装配中的项目一套真实域实例（machine/artifacts/stages/queue） */
interface MachineEntry {
  machine: PipelineMachine;
  artifacts: ArtifactStore;
  stages: {
    s1: S1RequirementStage;
    s3: S3TechDocStage;
    generator: MultiPlatformGenerator;
    contracts: ContractInjector;
  };
  queue: S5QueueRuntime | null;
  runId: string;
  /** 装配时快照是否仍是 dirty（true = 上次异常退出） */
  unexpectedExit: boolean;
  /** 节点 id → 该节点声明的对外接口契约（下游节点注入用，FR-PIPE-10） */
  nodeContracts: Map<string, DependencyContract[]>;
  /** 当前请求上下文持有器：长任务的模型调用进度要发到发起它的那个请求上 */
  holder: { ctx: DomainRouterContext | null };
}

export interface PipelineDomainOptions {
  db: Database.Database;
  projectsDir: string;
  dataDir: string;
  userId: string;
  aiStack: AiStackHandle | null;
  /** 项目记忆路由（TechChoice 写入用） */
  memoryRouter: DomainRouter;
}

const STAGES = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'] as const;
type Stage = (typeof STAGES)[number];

/** 同步处理器：不得 await（由渲染层 sendSync 驱动） */
type SyncHandler = (params: Record<string, unknown>, ctx: DomainRouterContext) => unknown;
/** 异步处理器：AI 生成 / 子进程 IO 等长任务只走这里 */
type AsyncHandler = (params: Record<string, unknown>, ctx: DomainRouterContext) => Promise<unknown>;

/* ------------------------------ S5 队列运行时 ------------------------------ */

/**
 * S5 真实队列运行时：包 GenerationQueue，把节点级
 * 重试 / 跳过 / 暂停 / 断点恢复落到主进程，并把状态与进度经域事件下发。
 */
interface S5QueueRuntime {
  run(input: {
    projectId: string;
    userId: string;
    projectName: string;
    choice: TechChoice;
    requirementDoc: string;
    techDoc: string;
    splitJson: string;
    resumeProgress: string | null;
    ctx: DomainRouterContext;
  }): Promise<S5RunResult>;
  retryNode(nodeId: string, ctx: DomainRouterContext): Promise<QueueState>;
  skipNode(nodeId: string): QueueState;
  pause(): QueueState;
  state(): QueueState | null;
  progress(): string | null;
}

export function createPipelineDomain(options: PipelineDomainOptions): {
  router: DomainRouter;
  syncRouter: SyncDomainRouter;
  dispose: () => Promise<void>;
} {
  const { db, projectsDir, dataDir } = options;
  const entries = new Map<string, MachineEntry>();
  const snapshotDir = join(dataDir, 'snapshots');
  mkdirSync(snapshotDir, { recursive: true });

  const pipelineDirOf = (projectId: string): string => join(projectsDir, projectId, 'pipeline');
  const docsDirOf = (projectId: string): string => join(projectsDir, projectId, 'docs');

  /**
   * 持久化走 `@ec/pipeline` 的官方 `PipelineRepo`（pipeline_run + stage_artifact 两张表）。
   * 域内不再自带 SQL：表结构、主键口径（`sa-<stage>-<version>`）与幂等语义由仓库层统一。
   */
  const repo = new PipelineRepo(db as unknown as PipelineDb);

  /** 产物内容文件 fs 端口：写 `<projectsDir>/<projectId>/pipeline/`（临时文件 + 原子替换） */
  const artifactFs = (_projectId: string): ArtifactContentFs => ({
    async writeAtomic(path, content) {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.ec-tmp`;
      writeFileSync(tmp, content, 'utf8');
      renameSync(tmp, path);
    },
    async readText(path) {
      return existsSync(path) ? readFileSync(path, 'utf8') : null;
    },
    async exists(path) {
      return existsSync(path);
    },
    async remove(path) {
      if (existsSync(path)) {
        const fs = await import('node:fs');
        fs.unlinkSync(path);
      }
    },
  });

  /** 读项目记忆里的技术选型（memory_item：scope=project、title=技术选型、structured JSON） */
  const readTechChoice = (projectId: string): TechChoice | null => {
    const rows = db
      .prepare(
        `SELECT structured FROM memory_item WHERE project_id = ? AND scope = 'project'
         AND title = '技术选型' AND status = 'active' ORDER BY updated_at DESC LIMIT 1`,
      )
      .all(projectId) as Array<{ structured: string | null }>;
    for (const row of rows) {
      if (!row.structured) continue;
      try {
        const parsed = JSON.parse(row.structured) as { choice?: unknown };
        if (parsed['choice'] !== undefined && parsed['choice'] !== null) {
          return parsed['choice'] as TechChoice;
        }
      } catch {
        // 坏结构化数据按未选处理，继续找下一条
      }
    }
    return null;
  };

  /** 阶段状态快照文件路径（CrashRecovery 领域：pipeline:<projectId>） */
  const snapshotFileOf = (projectId: string): string =>
    join(snapshotDir, `pipeline-${projectId}.snapshot.json`);

  /**
   * 状态持久化信封：阶段快照 + 生效版本指针 + S5 断点进度（一起原子写）。
   *
   * 信封形状对齐 @ec/core `SnapshotEnvelope`（domain/savedAt/dirty/state）：
   * 同步处理器里不能 await，所以不走 `CrashRecovery` 的异步 API，只沿用它的 dirty 语义——
   * 每次落盘写 `dirty: true`，正常退出（`dispose`）才改写为 `false`，
   * 于是"启动时看到 dirty"就等价于"上次异常退出"。
   */
  const persistSnapshot = (projectId: string, entry: MachineEntry, dirty = true): void => {
    const envelope = {
      domain: `pipeline:${projectId}`,
      savedAt: Date.now(),
      dirty,
      state: {
        stages: entry.machine.snapshot(),
        active: entry.artifacts.exportActive(),
        s5Progress: entry.queue?.progress() ?? null,
      },
    };
    const file = snapshotFileOf(projectId);
    const tmp = `${file}.ec-tmp`;
    writeFileSync(tmp, JSON.stringify(envelope), 'utf8');
    renameSync(tmp, file);
  };

  /** 文档入档端口：document 表 + doc_version 表（官方位置 `<project>/docs/`，事务性落盘） */
  const documentArchive = (projectId: string): DocumentArchivePort => ({
    async saveDocument(input) {
      const now = Date.now();
      const contentRef = join(docsDirOf(projectId), input.title);
      mkdirSync(dirname(contentRef), { recursive: true });
      const tmp = `${contentRef}.ec-tmp`;
      writeFileSync(tmp, input.content, 'utf8');
      renameSync(tmp, contentRef);

      // 同 title 的文档视为同一份的多版本（版本递增），否则新开一行
      const existing = db
        .prepare(
          `SELECT id, version FROM document WHERE project_id = ? AND title = ? AND deleted_at IS NULL`,
        )
        .get(projectId, input.title) as { id: string; version: number } | undefined;
      let documentId: string;
      if (existing !== undefined) {
        documentId = existing.id;
        db.prepare(
          `UPDATE document SET content_ref = ?, version = ?, content_text = ?, updated_at = ? WHERE id = ?`,
        ).run(contentRef, input.version, input.content, now, documentId);
      } else {
        documentId = `doc-${projectId}-${input.kind}-${input.version}-${now.toString(36)}`;
        db.prepare(
          `INSERT INTO document (id, project_id, kind, title, content_ref, version, format, content_text, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'markdown', ?, ?, ?)`,
        ).run(
          documentId,
          projectId,
          input.kind,
          input.title,
          contentRef,
          input.version,
          input.content,
          now,
          now,
        );
      }
      // 版本历史（FR-DOC-05：修改后保留历史版本）
      db.prepare(
        `INSERT INTO doc_version (id, document_id, version, title, content_text, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, 'pipeline', ?)`,
      ).run(
        `dv-${documentId}-${input.version}`,
        documentId,
        input.version,
        input.title,
        input.content,
        now,
      );
      return { documentId, version: input.version };
    },
    async linkMemory(input) {
      const now = Date.now();
      db.prepare(
        `INSERT OR IGNORE INTO memory_doc_link (id, memory_id, document_id, link_type, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        `mdl-${input.memoryId}-${input.documentId}`,
        input.memoryId,
        input.documentId,
        input.linkType,
        now,
      );
    },
    async latestVersion(projectId, kind) {
      const prefix = kind === 'requirement' ? '需求文档' : '技术文档';
      const rows = db
        .prepare(
          `SELECT title FROM document WHERE project_id = ? AND kind = ? AND deleted_at IS NULL AND title LIKE ?`,
        )
        .all(projectId, kind, `%${prefix}%`) as Array<{ title: string }>;
      let max = 0;
      for (const row of rows) {
        const match = /-v(\d+)\.md$/.exec(row.title);
        if (match !== null) max = Math.max(max, Number(match[1]));
      }
      return max;
    },
  });

  /** 单次模型调用端口：AI 栈未装配时如实报 NOT_SUPPORTED（不伪造） */
  const generationPort = (ctx: DomainRouterContext): StageGenerationPort => ({
    async generate(prompt) {
      if (options.aiStack === null) {
        throw new ShellError(
          'NOT_SUPPORTED',
          'AI 栈未装配：请先在设置页配置模型服务与 API Key，再使用 AI 生成。当前可以手动编辑文本后确认继续。',
        );
      }
      let text = '';
      for await (const chunk of options.aiStack.gateway.chat({
        userId: options.userId,
        purpose: 'pipeline',
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
      })) {
        text += textOfStreamChunk(chunk).text;
        const streamError = errorOfStreamChunk(chunk);
        if (streamError !== null) {
          throw new ShellError('UNKNOWN', `模型生成失败：${streamError}`);
        }
      }
      if (text.trim().length === 0) {
        throw new ShellError('UNKNOWN', '模型返回为空，请检查模型配置或稍后重试');
      }
      ctx.emit({ type: 'pipeline:progress', ratio: null, message: '模型生成完成' });
      return { content: text, degraded: false };
    },
  });

  /** S1 记忆端口：直接读 memory_item 表（长期偏好 / 禁止事项 / 相似项目） */
  const requirementMemory: RequirementMemoryPort = {
    async getPreferences(userId) {
      const rows = db
        .prepare(
          `SELECT content, structured FROM memory_item WHERE user_id = ? AND scope = 'longterm'
           AND status = 'active' ORDER BY importance DESC, updated_at DESC LIMIT 20`,
        )
        .all(userId) as Array<{ content: string; structured: string | null }>;
      const preferences: string[] = [];
      const forbidden: string[] = [];
      for (const row of rows) {
        const tagText = row.structured
          ? (() => {
              try {
                const parsed = JSON.parse(row.structured) as { tags?: unknown };
                return Array.isArray(parsed['tags']) ? parsed['tags'] : [];
              } catch {
                return [];
              }
            })()
          : [];
        const text = row.content.trim();
        if (text.length === 0) continue;
        if ((tagText as string[]).some((tag) => typeof tag === 'string' && tag.includes('禁止'))) {
          forbidden.push(text);
        } else {
          preferences.push(text);
        }
      }
      return { preferences, forbidden };
    },
    async findSimilarProjects(_userId, _description, limit) {
      const rows = db
        .prepare(
          `SELECT project_id, content FROM memory_item WHERE scope = 'project' AND status = 'active'
           ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(limit) as Array<{ project_id: string; content: string }>;
      const result: SimilarProjectSummary[] = [];
      for (const row of rows) {
        const name = db.prepare(`SELECT name FROM project WHERE id = ?`).get(row.project_id) as
          { name: string } | undefined;
        result.push({
          projectId: row.project_id,
          name: name?.name ?? row.project_id,
          summary: row.content,
          score: 0.5,
        });
      }
      return result;
    },
  };

  /**
   * S5 真实队列运行时：按拓扑序逐节点生成，单节点失败不阻塞；
   * 节点级重试 / 跳过 / 暂停 / 断点续生成；进度与节点结果经域事件下发。
   */
  const buildS5Queue = (
    entry: MachineEntry,
    projectId: string,
    restoredProgress: string | null,
  ): S5QueueRuntime => {
    let lastState: QueueState | null = null;
    let lastProgress: string | null = restoredProgress;
    let context: {
      projectId: string;
      userId: string;
      projectName: string;
      choice: TechChoice;
      requirementDoc: string;
      techDoc: string;
      ctx: DomainRouterContext;
    } | null = null;
    const nodeContracts = entry.nodeContracts;
    /** 节点 id → 该节点覆盖的页面清单（多端生成时进提示词） */
    let pagesByNode = new Map<string, Array<{ id: string; name: string; route: string | null }>>();
    const queue = new GenerationQueue<S5NodeData>({
      executor: async (node) => {
        if (context === null) throw new ShellError('UNKNOWN', 'S5 队列缺少执行上下文');
        context.ctx.emit({
          type: 'pipeline:progress',
          ratio: null,
          message: `生成 ${node.name}…`,
        });
        // FR-PIPE-10：只注入「已生成依赖」的对外接口契约摘要，禁止注入全部历史代码
        const injected = await entry.stages.contracts.injectForNode(projectId, node);
        const pages = pagesByNode.get(node.id) ?? [];
        const result = await entry.stages.generator.generateFor({
          platform: (node.data?.platform ?? 'web') as never,
          framework: node.data?.framework ?? 'react',
          projectName: context.projectName,
          stack: techChoiceToStack(context.choice),
          requirementDoc: context.requirementDoc,
          techDoc: `${context.techDoc}\n\n${injected.block}`,
          pages,
        });
        const files = result.files;
        const codeRoot = join(projectsDir, projectId, 'code');
        for (const file of files) {
          if (typeof file.path !== 'string' || typeof file.content !== 'string') continue;
          const target = join(codeRoot, file.path.replace(/\\/g, '/'));
          if (target !== codeRoot && !target.startsWith(codeRoot + sep)) continue;
          mkdirSync(dirname(target), { recursive: true });
          const tmp = `${target}.ec-tmp`;
          writeFileSync(tmp, file.content, 'utf8');
          renameSync(tmp, target);
        }
        // 本节点对外契约登记：下游（或重试后的节点）才拿得到真实依赖接口签名
        const contracts = contractsFromFiles(files);
        if (contracts.length > 0) nodeContracts.set(node.id, contracts);
        if (node.data !== undefined) {
          node.data.contractsBlock = injected.block;
          const buildNote =
            result.build.status === 'passed'
              ? `编译校验通过（重试 ${result.build.retries} 次）`
              : result.build.status === 'failed'
                ? `编译校验失败：${result.build.output}`
                : `未编译校验：${result.build.output}${result.build.installGuide === null ? '' : `\n安装引导：${result.build.installGuide}`}`;
          node.data.summary = `已生成 ${files.length} 个文件；${buildNote}`;
        }
        context.ctx.emit({
          type: 'pipeline:progress',
          ratio: null,
          message: `${node.name} 完成（${files.length} 个文件，编译校验：${result.build.status}）`,
        });
      },
      onStateChange: (state: QueueState) => {
        lastState = state;
        // 进度用官方序列化（version 1）；另挂契约表，断点续生成后下游仍能拿到依赖契约
        lastProgress = JSON.stringify({
          ...serializeProgress(state),
          contracts: [...nodeContracts.entries()].map(([nodeId, list]) => ({ nodeId, list })),
        });
        persistSnapshot(projectId, entry);
      },
    });

    return {
      async run(input) {
        context = {
          projectId: input.projectId,
          userId: input.userId,
          projectName: input.projectName,
          choice: input.choice,
          requirementDoc: input.requirementDoc,
          techDoc: input.techDoc,
          ctx: input.ctx,
        };
        const split = JSON.parse(input.splitJson) as {
          features: Array<{ id: string; name: string; dependsOn: string[]; pageIds?: string[] }>;
          pages: Array<{
            id: string;
            name: string;
            dependsOn: string[];
            featureId?: string | null;
            route?: string | null;
          }>;
        };
        // 阶段实例共用当前请求上下文：S1/S3/S5 的模型调用进度都发到发起它的请求上
        entry.holder.ctx = input.ctx;
        pagesByNode = new Map(
          split.pages.map((page) => [
            page.id,
            [{ id: page.id, name: page.name, route: page.route ?? null }],
          ]),
        );
        // 功能节点覆盖它名下的页面（多端生成时进提示词）
        for (const feature of split.features) {
          const ids = Array.isArray(feature.pageIds) ? feature.pageIds : [];
          const list = ids
            .map((id) => split.pages.find((page) => page.id === id))
            .filter((page) => page !== undefined)
            .map((page) => ({ id: page.id, name: page.name, route: page.route ?? null }));
          if (list.length > 0) pagesByNode.set(feature.id, list);
        }
        const nodeData = (kind: 'feature' | 'page'): S5NodeData => {
          const target = deriveNodeTarget(input.choice, kind);
          return {
            pageIds: [],
            platform: target.platform,
            framework: target.framework,
            contractsBlock: '',
            summary: '',
          };
        };
        const nodes = [
          ...split.features.map((feature) => ({
            id: feature.id,
            name: feature.name,
            kind: 'feature' as const,
            dependsOn: feature.dependsOn,
            status: 'pending' as const,
            attempts: 0,
            error: null,
            startedAt: null,
            finishedAt: null,
            durationMs: null,
            data: {
              ...nodeData('feature'),
              ...(Array.isArray(feature.pageIds) ? { pageIds: feature.pageIds } : {}),
            },
          })),
          ...split.pages
            // 归属某个已存在功能的页面，随其功能节点一并生成；其余按独立节点执行
            .filter(
              (page) =>
                page.featureId === undefined ||
                page.featureId === null ||
                !split.features.some((feature) => feature.id === page.featureId),
            )
            .map((page) => ({
              id: page.id,
              name: page.name,
              kind: 'page' as const,
              dependsOn: page.dependsOn,
              status: 'pending' as const,
              attempts: 0,
              error: null,
              startedAt: null,
              finishedAt: null,
              durationMs: null,
              data: { ...nodeData('page'), pageIds: [page.id] },
            })),
        ];
        // 断点续生成：官方反序列化（已完成/已跳过节点直接跳过），并恢复节点契约表
        nodeContracts.clear();
        if (input.resumeProgress !== null && input.resumeProgress.length > 0) {
          try {
            const saved = JSON.parse(input.resumeProgress) as {
              contracts?: Array<{ nodeId: string; list: DependencyContract[] }>;
            };
            for (const item of saved.contracts ?? []) {
              if (typeof item.nodeId === 'string' && Array.isArray(item.list)) {
                nodeContracts.set(item.nodeId, item.list);
              }
            }
          } catch {
            // 坏进度：契约按空处理；节点状态由 deserializeProgress 内部回落为全新
          }
        }
        queue.load(deserializeProgress<S5NodeData>(input.resumeProgress, nodes));
        const finalState = await queue.run();
        entry.holder.ctx = null;
        lastState = finalState;
        const results: Record<string, { status: string; files: number; summary: string }> = {};
        for (const node of finalState.nodes as Array<{
          id: string;
          status: string;
          error: string | null;
          data?: S5NodeData;
        }>) {
          results[node.id] = {
            status: node.status,
            files: 0,
            summary: node.data?.summary ?? node.error ?? '',
          };
        }
        return {
          state: finalState,
          results,
          progress: lastProgress ?? '',
          commits: [],
        };
      },
      retryNode: async (nodeId) => {
        await queue.retry(nodeId);
        return queue.state();
      },
      skipNode: (nodeId) => {
        queue.skip(nodeId);
        return queue.state();
      },
      pause: () => {
        queue.pause();
        return queue.state();
      },
      state: () => lastState,
      progress: () => lastProgress,
    };
  };

  /** 装配一个项目的全部真实域实例（幂等；首次调用时执行重启恢复） */
  const loadEntry = (projectId: string): MachineEntry => {
    const existing = entries.get(projectId);
    if (existing) return existing;
    const run = repo.ensureRun(projectId);
    const machine = new PipelineMachine({ projectId });
    // S3 阻断（FR-PIPE-13 / E2E-19）：进入 S3 前必须完成技术选型问卷，
    // 选择结果存项目记忆（memory_item），重启后依然生效。
    machine.setAdvanceGuard((from, to) =>
      from === 'S2' && to === 'S3' && readTechChoice(projectId) === null
        ? '请先完成技术选型问卷（目标端 / 各端方案 / 前端 / 后端 / 数据库 / ORM / 部署）'
        : null,
    );
    const artifacts = new ArtifactStore({
      projectId,
      rootDir: pipelineDirOf(projectId),
      fs: artifactFs(projectId),
      idPrefix: 'art',
      onVersionSaved: (saved) => {
        repo.upsertArtifact(saved, run.id, projectId);
        repo.updateRunPointer(run.id, saved.stage, machine.statusOf(saved.stage), saved.version);
      },
    });

    // --- 重启恢复 ---------------------------------------------------------
    // 权威划分：产物台账以 stage_artifact 表为准（每版本一行，内容文件在磁盘）；
    // 阶段状态以 CrashRecovery 快照为准；两者缺一都能近似恢复，不炸装配。
    const snapshotFile = snapshotFileOf(projectId);
    const ledger = repo.listArtifacts(projectId);
    let restoredStages = false;
    /** 上次关停时的 S5 断点进度（节点状态序列化），重启后继续用 */
    let restoredS5Progress: string | null = null;
    /** 快照仍是 dirty ⇒ 上次是异常退出（正常退出会在 dispose 里改写为 false） */
    let dirtyAtLoad = false;
    if (existsSync(snapshotFile)) {
      try {
        const envelope = JSON.parse(readFileSync(snapshotFile, 'utf8')) as {
          dirty?: boolean;
          state?: {
            stages?: PipelineStageSnapshot;
            active?: Record<string, number>;
            s5Progress?: string | null;
          };
        };
        dirtyAtLoad = envelope.dirty === true;
        const stages = envelope.state?.stages;
        if (stages) {
          for (const stage of STAGES) {
            const saved = stages[stage];
            if (saved) machine.restoreStageState(saved);
          }
          restoredStages = true;
        }
        // 快照里的生效指针优先（activeVersion 必须与关闭前一致），缺省跟台账最新版
        artifacts.hydrate(ledger, envelope.state?.active ?? {});
        const progress = envelope.state?.s5Progress;
        restoredS5Progress = typeof progress === 'string' && progress.length > 0 ? progress : null;
      } catch {
        // 坏快照按无快照处理（首次进入语义）
        artifacts.hydrate(ledger, {});
      }
    } else {
      artifacts.hydrate(ledger, {});
    }
    // 没有阶段状态快照时，从台账指针近似恢复（"有过产物"就至少不是 pending）
    if (!restoredStages) {
      for (const stage of STAGES) {
        const state = machine.stageState(stage);
        const activeVersion = state.activeVersion ?? artifacts.activeVersion(stage);
        if (activeVersion > 0) {
          machine.restoreStageState({
            ...state,
            activeVersion,
            latestVersion: artifacts.latestVersion(stage),
          });
        }
      }
    }

    // --- 域阶段实现装配（真实 S1/S3/S4/S5）---
    // 阶段实例共用当前请求上下文：长任务的模型调用进度要发到发起它的那个请求上
    const holder: { ctx: DomainRouterContext | null } = { ctx: null };
    const progressCtx: DomainRouterContext = {
      requestId: 'pipeline-internal',
      emit: (payload) => holder.ctx?.emit(payload),
    };
    const nodeContracts = new Map<string, DependencyContract[]>();
    const stages = {
      s1: new S1RequirementStage({
        memory: requirementMemory,
        archive: documentArchive(projectId),
        generate: generationPort(progressCtx),
      }),
      s3: new S3TechDocStage({
        memory: {
          async getProjectConstraints(id) {
            const choice = readTechChoice(id);
            return {
              declaredStack: choice === null ? null : techChoiceToStack(choice),
              forbidden: [],
            };
          },
        },
        archive: documentArchive(projectId),
        generate: generationPort(progressCtx),
      }),
      generator: new MultiPlatformGenerator({
        generate: generationPort(progressCtx),
        // 真实工具链端口：探测与构建都真跑（缺工具链 → 生成结果带安装引导，不静默跳过）
        toolchain: {
          async detect(command) {
            const parts = command.split(' ').filter((part) => part.length > 0);
            const bin = parts[0];
            if (bin === undefined) return false;
            try {
              await runProcess(bin, parts.slice(1), process.cwd(), 20_000);
              return true;
            } catch {
              return false;
            }
          },
          async run(command) {
            const parts = command.filter((part) => part.length > 0);
            const bin = parts[0];
            if (bin === undefined) return { ok: false, output: '构建命令为空' };
            try {
              const output = await runProcess(
                bin,
                parts.slice(1),
                join(projectsDir, projectId, 'code'),
                300_000,
              );
              return { ok: true, output };
            } catch (cause) {
              return { ok: false, output: cause instanceof Error ? cause.message : String(cause) };
            }
          },
        },
      }),
      // 契约注入端口：只回「已生成节点声明的对外接口契约」，不注入实现与历史代码（FR-PIPE-10）
      contracts: new ContractInjector({
        port: {
          async listContracts(_projectId, nodeIds) {
            const out: DependencyContract[] = [];
            for (const id of nodeIds) out.push(...(nodeContracts.get(id) ?? []));
            return out;
          },
        },
      }),
    };

    const entry: MachineEntry = {
      machine,
      artifacts,
      stages,
      queue: null,
      runId: run.id,
      unexpectedExit: dirtyAtLoad,
      nodeContracts,
      holder,
    };
    // S5 队列运行时（引用 entry 自身的 stage 实例；断点进度从快照回灌）
    entry.queue = buildS5Queue(entry, projectId, restoredS5Progress);
    entries.set(projectId, entry);
    return entry;
  };

  const requireProject = (params: Record<string, unknown>): string => {
    const projectId = String(params['projectId'] ?? '');
    if (projectId.length === 0) throw new ShellError('INVALID_ARGUMENT', '缺少 projectId');
    if (!existsSync(join(projectsDir, projectId))) {
      throw new ShellError('NOT_FOUND', `项目不存在或工程目录缺失：${projectId}`);
    }
    return projectId;
  };

  const dispose = async (): Promise<void> => {
    for (const [projectId, entry] of entries) {
      // 正常退出：把快照标记为干净（下次启动不会再报"上次异常退出"）
      persistSnapshot(projectId, entry, false);
    }
    entries.clear();
  };

  /**
   * 域内互调用的请求上下文。
   *
   * pipeline 需要经 memory 域写「技术选型」记忆，但这不是外部请求、没有 requestId。
   * 给一个固定的内部标识：事件照旧送不出去（没有订阅目标），也不会串到任何外部请求的信封上。
   */
  const innerCtx: DomainRouterContext = { requestId: 'pipeline-internal', emit: () => {} };

  /**
   * 处理器表：同步与异步分列，两条域通道（invoke / invokeSync）共用同一份实现。
   *
   * 为什么分列而不是一个大 switch：同步口由渲染层的 sendSync 驱动，
   * 一旦某个方法在同步口上被调用，它就必须在下一次事件循环前返回；
   * 把「会不会 await」做成结构上的分列，比在 switch 里靠注释约束安全得多。
   */
  const syncHandlers: Record<string, SyncHandler> = {};
  const asyncHandlers: Record<string, AsyncHandler> = {};

  /* ------------------------------ 状态机（同步） ------------------------------ */

  syncHandlers['initProject'] = (params, _ctx) => {
    const projectId = requireProject(params);
    const entry = loadEntry(projectId);
    persistSnapshot(projectId, entry);
    return entry.machine.snapshot();
  };

  syncHandlers['snapshot'] = (params, _ctx) => {
    const projectId = requireProject(params);
    return loadEntry(projectId).machine.snapshot();
  };

  syncHandlers['advance'] = (params, ctx) => {
    const projectId = requireProject(params);
    const entry = loadEntry(projectId);
    entry.machine.advance(params['from'] as Stage, params['to'] as Stage);
    repo.updateRunPointer(
      entry.runId,
      params['to'] as Stage,
      'running',
      entry.machine.stageState(params['to'] as Stage).activeVersion ?? 0,
    );
    persistSnapshot(projectId, entry);
    ctx.emit({
      type: 'pipeline:stage-event',
      projectId,
      event: 'advance',
      data: { from: params['from'], to: params['to'] },
    });
    return entry.machine.snapshot();
  };

  syncHandlers['startStage'] = (params, ctx) => {
    const projectId = requireProject(params);
    const entry = loadEntry(projectId);
    entry.machine.startStage(params['stage'] as Stage);
    persistSnapshot(projectId, entry);
    ctx.emit({
      type: 'pipeline:stage-event',
      projectId,
      event: 'start',
      data: { stage: params['stage'] },
    });
    return undefined;
  };

  syncHandlers['submitForReview'] = (params, ctx) => {
    const projectId = requireProject(params);
    const entry = loadEntry(projectId);
    entry.machine.submitForReview(params['stage'] as Stage);
    repo.updateRunPointer(
      entry.runId,
      params['stage'] as Stage,
      'awaiting_confirm',
      entry.machine.stageState(params['stage'] as Stage).activeVersion ?? 0,
    );
    persistSnapshot(projectId, entry);
    ctx.emit({
      type: 'pipeline:stage-event',
      projectId,
      event: 'submitForReview',
      data: { stage: params['stage'] },
    });
    return undefined;
  };

  syncHandlers['confirm'] = (params, ctx) => {
    const projectId = requireProject(params);
    const entry = loadEntry(projectId);
    entry.machine.confirm(params['stage'] as Stage);
    repo.updateRunPointer(
      entry.runId,
      params['stage'] as Stage,
      'confirmed',
      entry.machine.stageState(params['stage'] as Stage).activeVersion ?? 0,
    );
    persistSnapshot(projectId, entry);
    ctx.emit({
      type: 'pipeline:stage-event',
      projectId,
      event: 'confirm',
      data: { stage: params['stage'] },
    });
    return undefined;
  };

  syncHandlers['back'] = (params, ctx) => {
    const projectId = requireProject(params);
    const entry = loadEntry(projectId);
    const stale = entry.machine.back(params['from'] as Stage, params['to'] as Stage);
    persistSnapshot(projectId, entry);
    ctx.emit({
      type: 'pipeline:stage-event',
      projectId,
      event: 'rolled-back',
      data: { from: params['from'], to: params['to'], markedStale: stale },
    });
    return stale;
  };

  syncHandlers['skip'] = (params, _ctx) => {
    const projectId = requireProject(params);
    const entry = loadEntry(projectId);
    entry.machine.skip(params['stage'] as Stage);
    persistSnapshot(projectId, entry);
    return undefined;
  };

  syncHandlers['applyDownstreamStale'] = (params, _ctx) => {
    const projectId = requireProject(params);
    const entry = loadEntry(projectId);
    const stale = entry.machine.applyDownstreamStale(params['stage'] as Stage);
    persistSnapshot(projectId, entry);
    return stale;
  };

  /* ------------------------------ 阶段产物（同步读 / 异步写） ------------------------------ */

  asyncHandlers['saveArtifact'] = async (params, ctx) => {
    const projectId = requireProject(params);
    const entry = loadEntry(projectId);
    const stage = params['stage'] as Stage;
    const content = String(params['content'] ?? '');
    const saved = await entry.artifacts.save({
      stage,
      artifactType: params['artifactType'] as never,
      content,
      ...(typeof params['note'] === 'string' ? { note: params['note'] } : {}),
    });
    // activeVersion 指针同步进阶段状态（重启后从快照/表都能恢复）
    entry.machine.restoreStageState({
      ...entry.machine.stageState(stage),
      activeVersion: saved.version,
      latestVersion: entry.artifacts.latestVersion(stage),
    });
    persistSnapshot(projectId, entry);
    ctx.emit({
      type: 'pipeline:stage-event',
      projectId,
      event: 'artifact-updated',
      data: { stage, version: saved.version },
    });
    return saved;
  };

  syncHandlers['listArtifacts'] = (params, _ctx) => {
    const projectId = requireProject(params);
    const entry = loadEntry(projectId);
    return entry.artifacts.list(params['stage'] as Stage);
  };

  asyncHandlers['readArtifact'] = async (params, _ctx) => {
    const projectId = requireProject(params);
    const entry = loadEntry(projectId);
    return entry.artifacts.read(params['stage'] as Stage, Number(params['version']));
  };

  asyncHandlers['readDiff'] = async (params, _ctx) => {
    const projectId = requireProject(params);
    const entry = loadEntry(projectId);
    return entry.artifacts.readDiff(params['stage'] as Stage, Number(params['version']));
  };

  syncHandlers['switchVersion'] = (params, _ctx) => {
    const projectId = requireProject(params);
    const entry = loadEntry(projectId);
    entry.artifacts.switchVersion(params['stage'] as Stage, Number(params['version']));
    entry.machine.restoreStageState({
      ...entry.machine.stageState(params['stage'] as Stage),
      activeVersion: Number(params['version']),
    });
    persistSnapshot(projectId, entry);
    return undefined;
  };

  syncHandlers['notifyDownstream'] = (params, ctx) => {
    const projectId = requireProject(params);
    ctx.emit({
      type: 'pipeline:stage-event',
      projectId,
      event: 'downstream-stale',
      data: { stage: params['stage'], message: String(params['message'] ?? '') },
    });
    return undefined;
  };

  /* ------------------------------ 阶段执行（异步） ------------------------------ */

  asyncHandlers['generateRequirement'] = async (params, ctx) => {
    const projectId = requireProject(params);
    const entry = loadEntry(projectId);
    const description = String(params['description'] ?? '');
    const projectName = String(params['projectName'] ?? '未命名项目');
    ctx.emit({ type: 'pipeline:progress', ratio: null, message: '正在生成需求文档…' });
    const result = await entry.stages.s1.generate({
      userId: options.userId,
      projectId,
      projectName,
      description,
      ...(typeof params['instruction'] === 'string' && params['instruction'].length > 0
        ? { instruction: params['instruction'] }
        : {}),
    });
    ctx.emit({ type: 'pipeline:progress', ratio: 1, message: '需求文档已生成并入档' });
    return result;
  };

  syncHandlers['getTechChoice'] = (params, _ctx) => {
    const projectId = requireProject(params);
    return readTechChoice(projectId);
  };

  asyncHandlers['saveTechChoice'] = async (params, _ctx) => {
    const projectId = requireProject(params);
    const choice = params['choice'] as TechChoice | null;
    if (choice === null) throw new ShellError('INVALID_ARGUMENT', '缺少技术选型结果（choice）');
    // 不完整的选择一律拒绝：宁可在 S3 前拦下，也不要写入一份"看着像已选"的记忆
    const validation = validateChoice(choice);
    if (!validation.ok) {
      throw new ShellError('INVALID_ARGUMENT', `技术选型不完整：${validation.issues.join('；')}`);
    }
    const stack = toStackObject(choice);
    await options.memoryRouter(
      'create',
      {
        userId: options.userId,
        scope: 'project',
        projectId,
        title: '技术选型',
        structured: { choice, stack: stack.stack, targetPlatforms: stack.targetPlatforms },
        content: stack.stack,
      },
      innerCtx,
    );
    return undefined;
  };

  asyncHandlers['generateTechDoc'] = async (params, ctx) => {
    const projectId = requireProject(params);
    const entry = loadEntry(projectId);
    const choice = params['choice'] as TechChoice;
    // S3 阻断（FR-PIPE-13）：未完成技术选型不得生成技术文档
    if (readTechChoice(projectId) === null && params['allowWithoutSavedChoice'] !== true) {
      throw new ShellError(
        'INVALID_ARGUMENT',
        '尚未完成技术选型问卷：进入 S3 前必须先完成目标端与技术方案选择（结果写入项目记忆）',
      );
    }
    ctx.emit({ type: 'pipeline:progress', ratio: null, message: '正在生成技术文档…' });
    const result = await entry.stages.s3.generate({
      userId: options.userId,
      projectId,
      projectName: String(params['projectName'] ?? '未命名项目'),
      description: String(params['description'] ?? ''),
      choice,
      requirementDoc: String(params['requirementDoc'] ?? ''),
      ...(typeof params['instruction'] === 'string' && params['instruction'].length > 0
        ? { instruction: params['instruction'] }
        : {}),
    });
    ctx.emit({ type: 'pipeline:progress', ratio: 1, message: '技术文档已生成并入档' });
    return result;
  };

  /* ------------------------------ S4 拆分（同步读 / 异步写） ------------------------------ */

  syncHandlers['getSplit'] = (params, _ctx) => {
    const projectId = requireProject(params);
    const file = join(pipelineDirOf(projectId), 'S4', 'split.json');
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  };

  /**
   * S4 拆分结果落产物台账：拆分子目录里的 split.json 是**当前值**（S5 直接消费），
   * 台账负责版本回看 / diff / 回退。内容与最新版一致时不造重复版本。
   */
  const saveSplitArtifact = async (
    entry: MachineEntry,
    split: unknown,
  ): Promise<{ version: number; created: boolean }> => {
    const content = JSON.stringify(split, null, 2);
    const latest = entry.artifacts.latestVersion('S4');
    if (latest > 0) {
      const existing = await entry.artifacts.read('S4', latest).catch(() => null);
      if (existing === content) return { version: latest, created: false };
    }
    const saved = await entry.artifacts.save({
      stage: 'S4',
      artifactType: STAGE_DEFS.S4.artifactType,
      content,
      note: latest === 0 ? '初始拆分' : '拆分调整',
    });
    entry.machine.restoreStageState({
      ...entry.machine.stageState('S4'),
      activeVersion: saved.version,
      latestVersion: entry.artifacts.latestVersion('S4'),
    });
    return { version: saved.version, created: true };
  };

  asyncHandlers['saveSplit'] = async (params, _ctx) => {
    const projectId = requireProject(params);
    const entry = loadEntry(projectId);
    const file = join(pipelineDirOf(projectId), 'S4', 'split.json');
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.ec-tmp`;
    writeFileSync(tmp, JSON.stringify(params['split'], null, 2), 'utf8');
    renameSync(tmp, file);
    await saveSplitArtifact(entry, params['split']);
    persistSnapshot(projectId, entry);
    return undefined;
  };

  /**
   * S4 自动拆分（规则解析）：优先从技术文档按标题约定解析（`## 功能：xxx（id）`），
   * 解析不到时回退到需求文档的功能清单，再不行给一个最小可编辑骨架（绝不给空）。
   */
  asyncHandlers['generateSplit'] = async (params, ctx) => {
    const projectId = requireProject(params);
    const entry = loadEntry(projectId);
    const techDocVersion = Number(params['techDocVersion'] ?? 0);
    const techDoc =
      techDocVersion > 0 ? await entry.artifacts.read('S3', techDocVersion).catch(() => '') : '';
    let split = techDoc.length > 0 ? parseSplitFromTechDoc(techDoc) : { features: [], pages: [] };
    if (split.features.length === 0) {
      // 回退：从需求文档 P0/P1 清单提取功能单元
      const reqDocVersion = Number(params['requirementDocVersion'] ?? 0);
      const reqDoc =
        reqDocVersion > 0 ? await entry.artifacts.read('S1', reqDocVersion).catch(() => '') : '';
      const features = [...reqDoc.matchAll(/^[-*]\s*(P[0-2])[：:]\s*(.+)$/gm)].map(
        (match, index) => ({
          id: `f-${index + 1}`,
          name: (match[2] ?? '').trim(),
          pageIds: [],
          dependsOn: [],
        }),
      );
      split =
        features.length > 0
          ? { features, pages: [] }
          : {
              features: [{ id: 'f-1', name: '核心功能（待编辑）', pageIds: [], dependsOn: [] }],
              pages: [],
            };
    }
    const file = join(pipelineDirOf(projectId), 'S4', 'split.json');
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.ec-tmp`;
    writeFileSync(tmp, JSON.stringify(split, null, 2), 'utf8');
    renameSync(tmp, file);
    await saveSplitArtifact(entry, split);
    persistSnapshot(projectId, entry);
    ctx.emit({
      type: 'pipeline:progress',
      ratio: 1,
      message: `拆分完成：${split.features.length} 个功能 / ${split.pages.length} 个页面`,
    });
    return split;
  };

  asyncHandlers['evaluateImpact'] = async (params, _ctx) => {
    const projectId = requireProject(params);
    const file = join(pipelineDirOf(projectId), 'S4', 'split.json');
    if (!existsSync(file)) {
      throw new ShellError('NOT_FOUND', '尚未保存拆分结果（S4），无法评估影响面');
    }
    const split = SplitModel.fromResult(JSON.parse(readFileSync(file, 'utf8')) as never);
    return split.evaluateImpact(params['change'] as never);
  };

  /* ------------------------------ S5 队列（异步执行 / 同步查态） ------------------------------ */

  asyncHandlers['runGeneration'] = async (params, ctx) => {
    const projectId = requireProject(params);
    const entry = loadEntry(projectId);
    const choice = params['choice'] as TechChoice | null;
    if (choice === null) {
      throw new ShellError('INVALID_ARGUMENT', 'S5 生成需要技术选型结果（choice 缺失）');
    }
    const validation = validateChoice(choice);
    if (!validation.ok) {
      throw new ShellError('INVALID_ARGUMENT', `技术选型不完整：${validation.issues.join('；')}`);
    }
    const split = params['split'] as { features: unknown[]; pages: unknown[] };
    ctx.emit({ type: 'pipeline:progress', ratio: null, message: 'S5 生成队列启动' });
    const result = await entry.queue!.run({
      projectId,
      userId: options.userId,
      projectName: String(params['projectName'] ?? '未命名项目'),
      choice,
      requirementDoc: String(params['requirementDoc'] ?? ''),
      techDoc: String(params['techDoc'] ?? ''),
      splitJson: JSON.stringify(split),
      resumeProgress:
        typeof params['resumeProgress'] === 'string' ? params['resumeProgress'] : null,
      ctx,
    });
    const stats = (result.state as QueueState).stats;
    ctx.emit({
      type: 'pipeline:progress',
      ratio: 1,
      message: `S5 队列结束：成功 ${stats.success} / 失败 ${stats.failed} / 跳过 ${stats.skipped}`,
    });
    return result;
  };

  asyncHandlers['retryNode'] = async (params, ctx) => {
    const projectId = requireProject(params);
    const entry = loadEntry(projectId);
    const state = await entry.queue!.retryNode(String(params['nodeId']), ctx);
    persistSnapshot(projectId, entry);
    return state;
  };

  syncHandlers['skipNode'] = (params, _ctx) => {
    const projectId = requireProject(params);
    const entry = loadEntry(projectId);
    const state = entry.queue!.skipNode(String(params['nodeId']));
    persistSnapshot(projectId, entry);
    return state;
  };

  syncHandlers['pauseQueue'] = (params, _ctx) => {
    const projectId = requireProject(params);
    const entry = loadEntry(projectId);
    return entry.queue!.pause();
  };

  syncHandlers['getQueueState'] = (params, _ctx) => {
    const projectId = requireProject(params);
    const entry = loadEntry(projectId);
    return entry.queue!.state();
  };

  /* ------------------------------ 断点恢复 ------------------------------ */

  syncHandlers['getResumeProgress'] = (params, _ctx) => {
    const projectId = requireProject(params);
    const entry = loadEntry(projectId);
    return {
      snapshot: entry.machine.snapshot(),
      s5Progress: entry.queue!.progress(),
      resumeStage: findResumeStage(entry.machine.snapshot()),
    };
  };

  /**
   * 重启恢复：dirty 快照恢复阶段状态（断点），干净快照只回灌进度不报"异常退出"；
   * 同时校验产物文件一致性（缺失/不可读的版本如实列出）。
   */
  asyncHandlers['recoverProject'] = async (params, _ctx) => {
    const projectId = requireProject(params);
    const entry = loadEntry(projectId);
    const snapshot = entry.machine.snapshot();
    // 一致性校验用 ArtifactStore 官方实现（存在性 + 可读性），不另起一套判据
    const integrityProblems = await entry.artifacts.verifyIntegrity();
    return {
      snapshot,
      resumeStage: findResumeStage(snapshot),
      integrityProblems,
      // 正常退出（dispose 把快照标干净）时为 false；只有异常退出才为 true
      unexpectedExit: entry.unexpectedExit,
      artifactVersions: STAGES.reduce((sum, stage) => sum + entry.artifacts.list(stage).length, 0),
    };
  };

  const router: DomainRouter = async (method, params, ctx) => {
    const async = asyncHandlers[method];
    if (async) return async(params, ctx);
    const sync = syncHandlers[method];
    if (sync) return sync(params, ctx);
    throw new ShellError('INVALID_ARGUMENT', `pipeline 域未知方法：${method}`);
  };

  /**
   * 同步口（渲染层 `PipelineApi` 的同步签名方法）。
   *
   * 命中异步方法时**如实拒绝**：UI 会看到明确的「该动作需要异步执行」而不是一个
   * 卡住渲染进程的 sendSync。
   */
  const syncRouter: SyncDomainRouter = (method, params, ctx) => {
    const handler = syncHandlers[method];
    if (!handler) {
      throw new ShellError(
        'NOT_SUPPORTED',
        `pipeline.${method} 需要异步执行（AI 生成 / 子进程 IO），不提供同步调用口`,
      );
    }
    return handler(params, ctx);
  };

  return { router, dispose, syncRouter };
}

/**
 * 从本节点产物中提取**对外接口面**（只取声明行，不取函数体）。
 *
 * FR-PIPE-10 的机器可断言点：下游节点拿到的契约块里不得出现实现细节。
 * 这里刻意只做逐行扫描——跨行的参数列表会被截到首行，宁缺毋滥。
 */
function extractExports(content: string): { signatures: string[]; types: string[] } {
  const signatures: string[] = [];
  const types: string[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('export')) continue;
    if (/^export\s+(interface|type|enum)\s+[\w$]/.test(line)) {
      types.push(line.replace(/\s*\{$/, '').trim());
      continue;
    }
    if (
      /^export\s+(declare\s+)?(async\s+)?function\s+[\w$]/.test(line) ||
      /^export\s+(abstract\s+)?class\s+[\w$]/.test(line) ||
      /^export\s+(const|let|var)\s+[\w$]/.test(line)
    ) {
      const brace = line.indexOf('{');
      signatures.push((brace === -1 ? line : line.slice(0, brace)).replace(/[,\s]+$/, '').trim());
    }
  }
  return { signatures, types };
}

/** 按文件路径猜契约种类（生成器只给文件，不给语义标注） */
function contractKindOf(path: string): DependencyContract['kind'] {
  const p = path.toLowerCase();
  if (p.includes('controller')) return 'controller';
  if (p.includes('service')) return 'service';
  if (p.includes('dto') || p.includes('types') || p.includes('model')) return 'dto';
  if (p.includes('repo') || p.includes('dao')) return 'repo';
  if (p.endsWith('.sql')) return 'sql';
  if (p.includes('test') || p.includes('spec')) return 'test';
  if (p.includes('route') || p.includes('api') || p.includes('page')) return 'route';
  return 'service';
}

/** 节点产物 → 下游可注入的契约清单（无可注入面时返回空数组，调用方按"无依赖契约"渲染） */
function contractsFromFiles(
  files: ReadonlyArray<{ path: string; content: string }>,
): DependencyContract[] {
  const contracts: DependencyContract[] = [];
  for (const file of files) {
    const { signatures, types } = extractExports(file.content);
    if (signatures.length === 0 && types.length === 0) continue;
    const first = signatures[0] ?? '';
    const name = first
      .replace(/^export\s+(declare\s+)?(async\s+)?(function|class|const|let|var)\s+/, '')
      .split(/[<(:=]/)[0]
      ?.trim();
    contracts.push({
      name: name !== undefined && name.length > 0 ? name : file.path,
      kind: contractKindOf(file.path),
      filePath: file.path,
      summary: [...signatures, ...types].join('\n'),
      types,
    });
  }
  return contracts;
}

/**
 * 跑一条外部命令（工具链探测 / 构建）。
 *
 * 命令来自 `TOOLCHAIN_BY_FRAMEWORK` 常量（非用户输入），故此处允许 shell 解析，
 * 以兼容 Windows 下的 `npx.cmd` / `flutter.bat` 这类 shim；超时与输出上限都由这里兜住，
 * 避免构建把主进程挂死。
 */
function runProcess(
  file: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        cwd,
        timeout: timeoutMs,
        shell: process.platform === 'win32',
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ''}${stderr ?? ''}`.trim();
        if (error !== null && error !== undefined) {
          reject(new Error(output.length > 0 ? output : error.message));
          return;
        }
        resolve(output);
      },
    );
  });
}

/**
 * 第一个待续生成的阶段：running 优先（断点），其次 awaiting_confirm，再次 stale
 */
function findResumeStage(snapshot: PipelineStageSnapshot): Stage | null {
  for (const stage of STAGES) {
    if (snapshot[stage].status === 'running') return stage;
  }
  for (const stage of STAGES) {
    if (snapshot[stage].status === 'awaiting_confirm' || snapshot[stage].status === 'stale')
      return stage;
  }
  return null;
}

/**
 * 节点的目标端与框架：按技术选型的目标端落位。
 * - 页面节点恒为 Web；功能节点优先 Web，其次移动端（Flutter 等单代码库覆盖双端）、
 *   鸿蒙（ArkTS）、桌面端（Tauri 2 等）。
 */
function deriveNodeTarget(
  choice: TechChoice,
  kind: 'feature' | 'page',
): { platform: string; framework: string } {
  if (kind === 'page') return { platform: 'web', framework: choice.frontend };
  if (choice.targets.includes('web')) return { platform: 'web', framework: choice.frontend };
  if (choice.targets.includes('android') || choice.targets.includes('ios')) {
    return { platform: 'android', framework: choice.mobile };
  }
  if (choice.targets.includes('harmonyos')) return { platform: 'harmonyos', framework: 'arkts' };
  if (choice.targets.includes('windows')) return { platform: 'windows', framework: choice.desktop };
  const first = choice.targets[0] ?? 'web';
  return { platform: first, framework: first === 'web' ? choice.frontend : choice.desktop };
}
