import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, sep, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
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
  S5GenerateStage,
  STAGE_DEFS,
  SplitModel,
  deserializeProgress,
  findResumeStage,
  parseSplitFromTechDoc,
  serializeProgress,
  techChoiceToStack,
  toStackObject,
  validateChoice,
  type ArtifactContentFs,
  type ArtifactVersion,
  type DocumentArchivePort,
  type PipelineDb,
  type PipelineStageSnapshot,
  type QueueNode,
  type QueueState,
  type RequirementMemoryPort,
  type S5NodeData,
  type S5RunResult,
  type SimilarProjectSummary,
  type SplitResult,
  type StageGenerationPort,
  type TechChoice,
} from '@ec/pipeline';
import { ShellError } from '@ec/shell-api';
import type { DependencyContract, GenerationOutput } from '@ec/ai';
import type { DomainRouter, DomainRouterContext, SyncDomainRouter } from '../runtime';
import { errorOfStreamChunk, textOfStreamChunk } from '../ai-stream-text';
import type { AiStackHandle } from '../domain-factories';
import { resolveCodeRoot } from '../code-root';
import { createPageDslReader } from '../designer-pages';
import { buildFullFilePatch, languageFromPath } from '../full-file-patch';
import type { CodeWritePort } from './code-domain';
import { PipelinePersistence } from '../pipeline-persistence';

/** Electron pipeline runtime: domain engines handle stages and versions; PipelinePersistence
 * commits SQLite rows, official project files and recovery checkpoints together. */

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
  /**
   * 用户在 S1 输入的原始想法。S3 提示词还要用它，而渲染层的输入框是临时状态，
   * 重启后就没了 —— 所以随快照持久化，由主进程作为唯一来源。
   */
  inputs: { description: string };
  /**
   * 进行中的阶段事务的补偿动作（入档写入的撤销）。非 null 表示本项目有生成任务在跑：
   * 同一项目同一时刻只允许一个阶段事务，避免两次生成共用一本撤销账。
   */
  journal: { current: Array<() => void> | null };
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
  /**
   * 代码写入口（code 域的 WritePipeline）。S5 生成的代码必须经它落盘（D-04：AI 唯一写入口），
   * 这样外部改动监视的自写抑制、冲突比对与失败回滚都与代码视图同一套。
   * 为 null 时 S5 节点如实失败（NOT_SUPPORTED），不绕过它直接写文件。
   */
  writeCode: CodeWritePort | null;
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
  /** 执行队列；`resume=true` 时沿用主进程持有的断点进度（已完成/已跳过节点不再生成） */
  run(input: { resume: boolean; ctx: DomainRouterContext }): Promise<S5RunResult>;
  retryNode(nodeId: string, ctx: DomainRouterContext): Promise<QueueState>;
  skipNode(nodeId: string, ctx: DomainRouterContext): Promise<QueueState>;
  pause(interrupted?: boolean): QueueState;
  /** 当前队列状态；重启后首次查询会按 split.json + 技术选型 + 断点进度重建 */
  state(): QueueState | null;
  progress(): string | null;
  running(): boolean;
}

export function createPipelineDomain(options: PipelineDomainOptions): {
  router: DomainRouter;
  syncRouter: SyncDomainRouter;
  dispose: () => Promise<void>;
} {
  const { db, projectsDir, dataDir } = options;
  const storage = new PipelinePersistence(db, dataDir);
  const shutdown = new AbortController();
  const inFlight = new Set<Promise<unknown>>();
  const entries = new Map<string, MachineEntry>();
  const pageReader = createPageDslReader({ projectsDir });
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
  const artifactFs = (projectId: string): ArtifactContentFs => ({
    async writeAtomic(path, content) {
      storage.write(projectId, path, content);
    },
    async readText(path) {
      return storage.read(projectId, path);
    },
    async exists(path) {
      return storage.read(projectId, path) !== null;
    },
    async remove(path) {
      storage.write(projectId, path, null);
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
          const choice = parsed['choice'] as TechChoice;
          if (validateChoice(choice).ok) return choice;
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

  /** One checkpoint covers stage state, active versions, input and queue progress.
   * SQLite is authoritative; the snapshot file also preserves compatibility with older installs. */
  const persistSnapshot = (projectId: string, entry: MachineEntry, dirty = true): void => {
    const envelope = {
      domain: `pipeline:${projectId}`,
      savedAt: Date.now(),
      dirty,
      state: {
        stages: entry.machine.snapshot(),
        active: entry.artifacts.exportActive(),
        s5Progress: entry.queue?.progress() ?? null,
        inputs: entry.inputs,
      },
    };
    const file = snapshotFileOf(projectId);
    storage.commit(projectId, JSON.stringify(envelope), file, () => {
      const stage = findResumeStage(entry.machine.snapshot()) ?? entry.machine.currentStage();
      repo.updateRunPointer(
        entry.runId,
        stage,
        entry.machine.statusOf(stage),
        entry.artifacts.activeVersion(stage),
      );
    });
  };

  /** Document and ledger rows are committed together after the stage succeeds. */
  const documentArchive = (projectId: string): DocumentArchivePort => ({
    async saveDocument(input) {
      const now = Date.now();
      const documentId = `pipeline-doc-${projectId}-${input.kind}-${input.version}`;
      const contentRef = join(docsDirOf(projectId), input.title.replace(/[<>:"/\\|?*]/g, '_'));
      storage.write(projectId, contentRef, input.content);
      storage.sql(projectId, () => {
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
        db.prepare(
          `INSERT INTO doc_version (id, document_id, version, title, content_text, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, 'pipeline', ?)`,
        ).run(`dv-${documentId}`, documentId, input.version, input.title, input.content, now);
      });
      return { documentId, version: input.version };
    },
    async linkMemory(input) {
      storage.sql(projectId, () => {
        db.prepare(
          `INSERT OR IGNORE INTO memory_doc_link (id, memory_id, document_id, link_type, created_at)
          VALUES (?, ?, ?, ?, ?)`,
        ).run(
          `mdl-${input.memoryId}-${input.documentId}`,
          input.memoryId,
          input.documentId,
          input.linkType,
          Date.now(),
        );
      });
    },
    async latestVersion(id, kind) {
      return loadEntry(id).artifacts.latestVersion(kind === 'requirement' ? 'S1' : 'S3');
    },
  });

  /**
   * 单次模型调用端口：AI 栈未装配时如实报 NOT_SUPPORTED（不伪造）。
   *
   * `purpose` 按阶段区分（S1 需求 / S3 技术文档 / 多端代码），用途化模型绑定才能生效——
   * 此前统一写 `'pipeline'`，不在标准用途里，设置页的逐用途绑定对流水线全部失效。
   */
  const generationPort = (
    ctx: DomainRouterContext,
    projectId: string,
    purpose: 'requirement' | 'techdoc' | 'code',
  ): StageGenerationPort => ({
    async generate(prompt) {
      if (options.aiStack === null) {
        throw new ShellError(
          'NOT_SUPPORTED',
          'AI 栈未装配：请先在设置页配置模型服务与 API Key，再使用 AI 生成。当前可以手动编辑文本后确认继续。',
        );
      }
      let text = '';
      for await (const chunk of options.aiStack.gateway.chat({
        signal: shutdown.signal,
        userId: options.userId,
        purpose,
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
      if (shutdown.signal.aborted) throw new ShellError('CANCELLED', '生成已中断');
      if (text.trim().length === 0) {
        throw new ShellError('UNKNOWN', '模型返回为空，请检查模型配置或稍后重试');
      }
      ctx.emit({ type: 'pipeline:progress', projectId, ratio: null, message: '模型生成完成' });
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

  /** S4 拆分的当前值（S5 直接消费）；未拆分返回 null */
  const readSplitFile = (projectId: string): SplitResult | null => {
    const entry = entries.get(projectId);
    const active = entry?.artifacts.activeVersion('S4') ?? 0;
    const file =
      active > 0
        ? entry!.artifacts.get('S4', active).contentRef
        : join(pipelineDirOf(projectId), 'S4', 'split.json');
    const raw = storage.read(projectId, file);
    return raw === null ? null : (JSON.parse(raw) as SplitResult);
  };

  /** 某阶段生效版本的产物内容；从未生成返回空串 */
  const readActiveArtifact = async (entry: MachineEntry, stage: Stage): Promise<string> => {
    const version = entry.artifacts.activeVersion(stage);
    return version > 0 ? entry.artifacts.read(stage, version) : '';
  };

  /** 项目名以 project 表为准（渲染层传来的只作兜底） */
  const projectNameOf = (projectId: string, fallback: unknown): string => {
    const row = db.prepare(`SELECT name FROM project WHERE id = ?`).get(projectId) as
      { name: string } | undefined;
    if (row !== undefined && row.name.trim().length > 0) return row.name;
    return typeof fallback === 'string' && fallback.length > 0 ? fallback : '未命名项目';
  };

  /**
   * S5 真实队列运行时：按拓扑序逐节点生成，单节点失败不阻塞；
   * 节点级重试 / 跳过 / 暂停 / 断点续生成；进度与队列状态经域事件下发。
   *
   * 输入全部由主进程自己取（不信任渲染层传来的全文）：技术选型读项目记忆、
   * 需求/技术文档读 S1/S3 生效版本、拆分读 S4/split.json —— 重启后
   * 即使渲染层什么都没有，也能按同一份输入重建队列并续跑。
   */
  const buildS5Queue = (
    entry: MachineEntry,
    projectId: string,
    restoredProgress: string | null,
  ): S5QueueRuntime => {
    let lastState: QueueState | null = null;
    let lastProgress: string | null = restoredProgress;
    let loaded = false;
    let inputKey: string | null = null;
    let isRunning = false;
    let interruptedId: string | null = null;
    /** 发起当前执行（run / retry / skip）的请求上下文：进度与队列状态事件发到它上面 */
    let activeCtx: DomainRouterContext | null = null;
    let docs: { requirementDoc: string; techDoc: string; choice: TechChoice } | null = null;
    const nodeContracts = entry.nodeContracts;
    /** 节点 id → 本节点落盘的文件（进报告；随断点进度持久化） */
    const nodeFiles = new Map<string, string[]>();
    const emitProgress = (ratio: number | null, message: string): void => {
      activeCtx?.emit({ type: 'pipeline:progress', projectId, ratio, message });
    };

    /** 断点进度里的附加表（契约 / 落盘文件）回灌；坏进度按空处理 */
    const restoreSideTables = (raw: string | null): void => {
      nodeContracts.clear();
      nodeFiles.clear();
      if (raw === null || raw.length === 0) return;
      try {
        const saved = JSON.parse(raw) as {
          contracts?: Array<{ nodeId: string; list: DependencyContract[] }>;
          files?: Array<{ nodeId: string; paths: string[] }>;
        };
        for (const item of saved.contracts ?? []) {
          if (typeof item.nodeId === 'string' && Array.isArray(item.list)) {
            nodeContracts.set(item.nodeId, item.list);
          }
        }
        for (const item of saved.files ?? []) {
          if (typeof item.nodeId === 'string' && Array.isArray(item.paths)) {
            nodeFiles.set(item.nodeId, item.paths);
          }
        }
      } catch {
        // 坏进度：附加表按空处理；节点状态由 deserializeProgress 内部回落为全新
      }
    };

    /**
     * 装载队列：`resume` 时按断点进度恢复节点状态（上次停在 running 的节点回到 pending 重跑），
     * 否则全新开始。拆分或选型缺失时返回 false（调用方给结构化引导）。
     */
    const load = (resume: boolean): boolean => {
      const split = readSplitFile(projectId);
      const choice = readTechChoice(projectId);
      if (split === null || choice === null) return false;
      const key = JSON.stringify([
        entry.artifacts.activeVersion('S1'),
        entry.artifacts.activeVersion('S3'),
        entry.artifacts.activeVersion('S4'),
        choice,
      ]);
      const savedKey =
        lastProgress === null ? null : (JSON.parse(lastProgress) as { inputKey?: string }).inputKey;
      const progress = resume && (savedKey === undefined || savedKey === key) ? lastProgress : null;
      inputKey = key;
      restoreSideTables(progress);
      const nodes = deserializeProgress<S5NodeData>(
        progress,
        s5Stage.buildNodes(split, choice),
      ).map((node) => (node.status === 'running' ? { ...node, status: 'pending' as const } : node));
      const order = queue.load(nodes);
      if (order.blocked.length > 0) throw new ShellError('INVALID_ARGUMENT', '拆分依赖有环路');
      if (progress !== null && (JSON.parse(progress) as { paused?: boolean }).paused) queue.pause();
      loaded = true;
      lastState = queue.state();
      return true;
    };

    /** 同步查询 / 跳过前确保队列已装载（重启后第一次访问按断点进度重建） */
    const ensureLoaded = (): boolean => {
      const choice = readTechChoice(projectId);
      const key = JSON.stringify([
        entry.artifacts.activeVersion('S1'),
        entry.artifacts.activeVersion('S3'),
        entry.artifacts.activeVersion('S4'),
        choice,
      ]);
      return (loaded && key === inputKey) || load(true);
    };

    /** 生成结果经 code 域 WritePipeline 事务落盘：新文件 create、已存在文件整文件 patch */
    const writeNodeFiles = async (
      node: QueueNode<S5NodeData>,
      files: ReadonlyArray<{ path: string; content: string }>,
    ): Promise<string[]> => {
      if (options.writeCode === null) {
        throw new ShellError('NOT_SUPPORTED', '代码写入管线未装配：S5 生成结果无法落盘');
      }
      const codeRoot = resolveCodeRoot(join(projectsDir, projectId));
      if (files.length === 0) throw new ShellError('INVALID_ARGUMENT', '模型未返回可写入文件');
      const valid = files.filter(
        (file) => typeof file.path === 'string' && typeof file.content === 'string',
      );
      const output: GenerationOutput = {
        files: valid.map((file) => {
          const path = file.path.replace(/\\/g, '/');
          const full = join(codeRoot, path);
          // 越界路径交给 WritePipeline 的 fs 守卫拒绝（计划期即抛出，节点记为失败）
          const before =
            full.startsWith(codeRoot + sep) && existsSync(full) ? readFileSync(full, 'utf8') : null;
          return before === null
            ? {
                path,
                content: file.content,
                action: 'create' as const,
                language: languageFromPath(path),
              }
            : {
                path,
                content: buildFullFilePatch(before, file.content, path),
                action: 'patch' as const,
                language: languageFromPath(path),
              };
        }),
        anchors: [],
        summary: `S5 逐个生成：${node.name}`,
        notes: '流水线 S5 节点生成结果，经写入管线事务落盘。',
        decision: {
          referencedMemory: [],
          rationale: '按技术选型与拆分结果逐节点生成（上下文只含依赖接口契约）',
          risks: [],
          uncovered: [],
        },
      };
      const plan = await options.writeCode.plan(projectId, output, 'create');
      const blocked = plan.entries.filter((item) => item.blocked);
      if (blocked.length > 0) {
        throw new Error(
          `写入管线拒绝了 ${blocked.length} 个文件：${blocked
            .map((item) => `${item.path}（${item.blockReason ?? '未给出原因'}）`)
            .join('；')}`,
        );
      }
      const applied = await options.writeCode.apply(projectId, plan);
      if (!applied.ok) {
        throw new Error(`代码写入失败，已回滚：${applied.error ?? '写入管线拒绝该计划'}`);
      }
      return valid.map((file) => file.path.replace(/\\/g, '/'));
    };

    const queue = new GenerationQueue<S5NodeData>({
      executor: async (node) => {
        if (docs === null) throw new ShellError('UNKNOWN', 'S5 缺少上下文');
        emitProgress(null, `生成 ${node.name}…`);
        activeNode = node;
        await s5Stage.createNodeExecutor({
          projectId,
          userId: options.userId,
          projectName: projectNameOf(projectId, null),
          ...docs,
          split: SplitModel.fromResult(readSplitFile(projectId)!),
        })(node);
        emitProgress(null, `${node.name} 完成（${nodeFiles.get(node.id)?.length ?? 0} 个文件）`);
      },
      onStateChange: (state: QueueState) => {
        lastState = state;
        // 进度用官方序列化（version 1）；另挂契约表与落盘文件表，断点续生成后下游仍能拿到依赖契约
        lastProgress = JSON.stringify({
          ...serializeProgress(state),
          nodes: serializeProgress(state).nodes.map((node) =>
            node.id === interruptedId && node.status === 'failed'
              ? { ...node, status: 'pending', error: null }
              : node,
          ),
          inputKey,
          paused: state.paused,
          contracts: [...nodeContracts.entries()].map(([nodeId, list]) => ({ nodeId, list })),
          files: [...nodeFiles.entries()].map(([nodeId, paths]) => ({ nodeId, paths })),
        });
        persistSnapshot(projectId, entry);
        activeCtx?.emit({
          type: 'pipeline:stage-event',
          projectId,
          event: 'queue-state',
          data: { state },
        });
      },
    });

    let activeNode: QueueNode<S5NodeData>;
    const s5Stage = new S5GenerateStage({
      generator: entry.stages.generator,
      contracts: entry.stages.contracts,
      queue,
      fs: {
        async snapshot(_projectId, nodeId) {
          return nodeId;
        },
        async restore() {
          throw new ShellError('NOT_SUPPORTED', '请通过版本回退重新生成');
        },
        async writeFiles(_projectId, files) {
          nodeFiles.set(activeNode.id, await writeNodeFiles(activeNode, files));
          nodeContracts.set(activeNode.id, contractsFromFiles(files));
        },
      },
    });

    /** 执行前备好输入（选型 / 文档）；缺哪样就给哪样的结构化引导 */
    const prepareDocs = async (): Promise<void> => {
      const choice = readTechChoice(projectId);
      if (choice === null) {
        throw new ShellError('INVALID_ARGUMENT', 'S5 生成需要先完成技术选型问卷（S3 前）');
      }
      if (readSplitFile(projectId) === null) {
        throw new ShellError('NOT_FOUND', '尚未生成拆分结果（S4），请先完成 S4');
      }
      docs = {
        choice,
        requirementDoc: await readActiveArtifact(entry, 'S1'),
        techDoc: await readActiveArtifact(entry, 'S3'),
      };
    };

    const guardIdle = (): void => {
      if (isRunning) throw new ShellError('ALREADY_EXISTS', 'S5 队列正在执行，请等待或先暂停');
    };

    const summarize = (state: QueueState): S5RunResult => {
      const results: S5RunResult['results'] = {};
      for (const node of state.nodes as Array<QueueNode<S5NodeData>>) {
        results[node.id] = {
          status: node.status,
          files: nodeFiles.get(node.id)?.length ?? 0,
          summary: node.data?.summary || node.error || '',
        };
      }
      return { state, results, progress: lastProgress ?? '', commits: [] };
    };

    const withCtx = async <T>(ctx: DomainRouterContext, work: () => Promise<T>): Promise<T> => {
      isRunning = true;
      activeCtx = ctx;
      entry.holder.ctx = ctx;
      try {
        return await work();
      } finally {
        isRunning = false;
        activeCtx = null;
        entry.holder.ctx = null;
      }
    };

    return {
      async run({ resume, ctx }) {
        guardIdle();
        return withCtx(ctx, async () => {
          await prepareDocs();
          load(resume);
          const finalState = await queue.run();
          lastState = finalState;
          await finalizeS5(entry, projectId, finalState, nodeFiles);
          return summarize(finalState);
        });
      },
      async retryNode(nodeId, ctx) {
        guardIdle();
        return withCtx(ctx, async () => {
          await prepareDocs();
          if (!ensureLoaded()) throw new ShellError('NOT_FOUND', 'S5 队列尚未建立');
          try {
            await queue.retry(nodeId);
          } catch (cause) {
            throw new ShellError(
              'NOT_FOUND',
              cause instanceof Error ? cause.message : String(cause),
            );
          }
          const state = queue.state();
          await finalizeS5(entry, projectId, state, nodeFiles);
          return state;
        });
      },
      async skipNode(nodeId, ctx) {
        guardIdle();
        if (!ensureLoaded()) throw new ShellError('NOT_FOUND', 'S5 队列尚未建立');
        activeCtx = ctx;
        try {
          queue.skip(nodeId);
        } catch (cause) {
          throw new ShellError('NOT_FOUND', cause instanceof Error ? cause.message : String(cause));
        } finally {
          activeCtx = null;
        }
        const state = queue.state();
        await finalizeS5(entry, projectId, state, nodeFiles);
        return state;
      },
      pause: (interrupted = false) => {
        if (interrupted) interruptedId = queue.state().currentId;
        // 正在跑的节点做完即停；已完成节点不受影响，之后可从断点继续
        queue.pause();
        return queue.state();
      },
      state: () => (ensureLoaded() ? (lastState ?? queue.state()) : null),
      progress: () => lastProgress,
      running: () => isRunning,
    };
  };

  /**
   * S5 收尾：队列全部节点成功或跳过时，把本轮的逐节点报告存为 S5 产物新版本
   * （与上一版一致时不重复造版本），并把 S5 提交确认。仍有失败/待生成节点时只落进度。
   */
  const finalizeS5 = async (
    entry: MachineEntry,
    projectId: string,
    state: QueueState,
    nodeFiles: ReadonlyMap<string, string[]>,
  ): Promise<void> => {
    const done =
      state.nodes.length > 0 &&
      !state.paused &&
      state.nodes.every((node) => node.status === 'success' || node.status === 'skipped');
    if (!done) {
      persistSnapshot(projectId, entry);
      return;
    }
    const content = renderS5Report(state, nodeFiles, resolveCodeRoot(join(projectsDir, projectId)));
    const latest = entry.artifacts.latestVersion('S5');
    const same =
      latest > 0 && (await entry.artifacts.read('S5', latest).catch(() => null)) === content;
    if (!same) {
      await runStageTransaction(
        projectId,
        entry,
        'S5',
        entry.holder.ctx ?? innerCtx,
        async () => {
          await saveStageArtifact(
            entry,
            'S5',
            content,
            `逐个生成：成功 ${state.stats.success} / 跳过 ${state.stats.skipped}`,
          );
        },
        true,
      );
    } else {
      if (entry.machine.statusOf('S5') === 'running') entry.machine.submitForReview('S5');
      persistSnapshot(projectId, entry);
    }
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
        storage.sql(projectId, () => repo.upsertArtifact(saved, run.id, projectId));
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
    const inputs = { description: '' };
    const persisted =
      storage.checkpoint(projectId) ??
      (existsSync(snapshotFile) ? readFileSync(snapshotFile, 'utf8') : null);
    if (persisted !== null) {
      try {
        const envelope = JSON.parse(persisted) as {
          dirty?: boolean;
          state?: {
            stages?: PipelineStageSnapshot;
            active?: Record<string, number>;
            s5Progress?: string | null;
            inputs?: { description?: unknown };
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
        const description = envelope.state?.inputs?.description;
        if (typeof description === 'string') inputs.description = description;
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
    const journal: MachineEntry['journal'] = { current: null };
    const stages = {
      s1: new S1RequirementStage({
        memory: requirementMemory,
        archive: documentArchive(projectId),
        generate: generationPort(progressCtx, projectId, 'requirement'),
      }),
      s3: new S3TechDocStage({
        memory: {
          async getProjectConstraints(id) {
            const choice = readTechChoice(id);
            return {
              declaredStack: choice === null ? null : techChoiceToStack(choice),
              forbidden: (await requirementMemory.getPreferences(options.userId)).forbidden,
            };
          },
        },
        archive: documentArchive(projectId),
        generate: generationPort(progressCtx, projectId, 'techdoc'),
      }),
      generator: new MultiPlatformGenerator({
        generate: generationPort(progressCtx, projectId, 'code'),
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
          async run(command, files = []) {
            const parts = command.filter((part) => part.length > 0);
            const bin = parts[0];
            if (bin === undefined) return { ok: false, output: '构建命令为空' };
            const buildRoot = mkdtempSync(join(tmpdir(), 'ec-pipeline-build-'));
            try {
              for (const file of files) {
                const target = resolve(buildRoot, file.path);
                if (!target.startsWith(buildRoot + sep))
                  throw new ShellError('PATH_ESCAPE', '生成路径越界');
                mkdirSync(dirname(target), { recursive: true });
                writeFileSync(target, file.content, 'utf8');
              }
              const output = await runProcess(
                bin,
                parts.slice(1),
                buildRoot,
                300_000,
                shutdown.signal,
              );
              return { ok: true, output };
            } catch (cause) {
              return { ok: false, output: cause instanceof Error ? cause.message : String(cause) };
            } finally {
              // buildRoot is a fresh absolute directory created above; never a model-provided path.
              rmSync(buildRoot, { recursive: true, force: true });
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
      inputs,
      journal,
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
    if (/[\\/.:]/.test(projectId)) throw new ShellError('INVALID_ARGUMENT', 'Invalid project id');
    if (projectId.length === 0) throw new ShellError('INVALID_ARGUMENT', '缺少 projectId');
    if (!existsSync(join(projectsDir, projectId))) {
      throw new ShellError('NOT_FOUND', `项目不存在或工程目录缺失：${projectId}`);
    }
    return projectId;
  };

  const dispose = async (): Promise<void> => {
    for (const entry of entries.values()) if (entry.queue?.running()) entry.queue.pause(true);
    shutdown.abort();
    await Promise.allSettled([...inFlight]);
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
   * S3 阻断（FR-PIPE-13 / D-04）：S3 及之后的阶段都以技术选型为输入，
   * 未完成问卷时不论经哪个入口（advance / startStage / 生成方法）都拒绝，不做任何默认假设。
   */
  const requireChoiceFor = (projectId: string, stage: Stage): void => {
    if (STAGES.indexOf(stage) < STAGES.indexOf('S3')) return;
    if (readTechChoice(projectId) !== null) return;
    throw new ShellError(
      'INVALID_ARGUMENT',
      '尚未完成技术选型问卷：进入 S3 前必须先完成目标端与技术方案选择（结果写入项目记忆）',
    );
  };

  const emitProgress = (
    ctx: DomainRouterContext,
    projectId: string,
    ratio: number | null,
    message: string,
  ): void => {
    ctx.emit({ type: 'pipeline:progress', projectId, ratio, message });
  };

  /**
   * 阶段事务：startStage → 生成/入档 → 保存阶段产物 → submitForReview。
   *
   * 任一步失败：逆序执行入档补偿（撤掉已写入文档库的文档/版本/记忆关联）、
   * 阶段状态回到开始前、快照重写，然后把原错误抛给调用方 —— 失败后文档库与产物台账里
   * 都不会留下半成品，阶段也不会卡在"生成中"。
   */
  const runStageTransaction = async <T>(
    projectId: string,
    entry: MachineEntry,
    stage: Stage,
    ctx: DomainRouterContext,
    work: () => Promise<T>,
    queueFinalization = false,
  ): Promise<T> => {
    if (entry.journal.current !== null || (!queueFinalization && entry.queue?.running() === true)) {
      throw new ShellError('ALREADY_EXISTS', '该项目已有生成任务在执行，请等待完成后再试');
    }
    requireChoiceFor(projectId, stage);
    const before = entry.machine.snapshot();
    const ledger = entry.artifacts.exportLedger();
    const active = entry.artifacts.exportActive();
    const inputs = { ...entry.inputs };
    entry.journal.current = [];
    entry.holder.ctx = ctx;
    try {
      entry.machine.startStage(stage);
      persistSnapshot(projectId, entry);
      storage.begin(projectId);
      const result = await work();
      entry.machine.submitForReview(stage);
      persistSnapshot(projectId, entry);
      ctx.emit({
        type: 'pipeline:stage-event',
        projectId,
        event: 'submitForReview',
        data: { stage },
      });
      return result;
    } catch (cause) {
      storage.discard(projectId);
      entry.artifacts.hydrate(ledger, active);
      entry.machine.loadSnapshot(before);
      entry.inputs = inputs;
      persistSnapshot(projectId, entry);
      throw cause;
    } finally {
      entry.journal.current = null;
      entry.holder.ctx = null;
    }
  };

  /** 保存阶段产物并把生效指针同步进阶段状态 */
  const saveStageArtifact = async (
    entry: MachineEntry,
    stage: Stage,
    content: string,
    note: string,
  ): Promise<ArtifactVersion> => {
    const saved = await entry.artifacts.save({
      stage,
      artifactType: STAGE_DEFS[stage].artifactType,
      content,
      note,
    });
    entry.machine.restoreStageState({
      ...entry.machine.stageState(stage),
      activeVersion: saved.version,
      latestVersion: entry.artifacts.latestVersion(stage),
    });
    return saved;
  };

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
    requireChoiceFor(projectId, params['stage'] as Stage);
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
    return runStageTransaction(projectId, entry, stage, ctx, async () => {
      const content = String(params['content'] ?? '');
      if (stage === 'S1' || stage === 'S3') {
        const version = entry.artifacts.latestVersion(stage) + 1;
        const kind = stage === 'S1' ? 'requirement' : 'techdoc';
        await documentArchive(projectId).saveDocument({
          projectId,
          kind,
          version,
          content,
          title: `${projectNameOf(projectId, null)}-${stage === 'S1' ? '需求文档' : '技术文档'}-v${version}.md`,
        });
      }
      if (stage === 'S4')
        await saveSplitVersioned(projectId, entry, JSON.parse(content) as SplitResult);
      else await saveStageArtifact(entry, stage, content, String(params['note'] ?? '手动编辑'));
      return entry.artifacts.get(stage, entry.artifacts.latestVersion(stage));
    });
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
    if (params['stage'] === 'S4') {
      storage.begin(projectId);
      const content = storage.read(
        projectId,
        entry.artifacts.get('S4', Number(params['version'])).contentRef,
      );
      storage.write(projectId, join(pipelineDirOf(projectId), 'S4', 'split.json'), content);
    }
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

  /**
   * S1：生成需求文档 → 入档（document / doc_version / 记忆关联）→ 存 S1 产物新版本 → 待确认。
   * 整体是一个阶段事务：任一步失败都不留文档库半成品，阶段回到生成前。
   * 用户输入的想法随快照持久化（S3 还要用；渲染层输入框重启即失）。
   */
  asyncHandlers['generateRequirement'] = async (params, ctx) => {
    const projectId = requireProject(params);
    const entry = loadEntry(projectId);
    const typed = String(params['description'] ?? '').trim();
    const description = typed.length > 0 ? typed : entry.inputs.description;
    if (description.length === 0) {
      throw new ShellError('INVALID_ARGUMENT', '请先输入想法（约 200 字）再生成需求文档');
    }
    const instruction =
      typeof params['instruction'] === 'string' && params['instruction'].trim().length > 0
        ? params['instruction']
        : null;
    entry.inputs.description = description;
    return runStageTransaction(projectId, entry, 'S1', ctx, async () => {
      emitProgress(ctx, projectId, null, '正在生成需求文档…');
      const result = await entry.stages.s1.generate({
        userId: options.userId,
        projectId,
        projectName: projectNameOf(projectId, params['projectName']),
        description,
        ...(instruction !== null
          ? {
              instruction: `${instruction}\n\n原文档（请保留未要求修改的内容并返回完整新版）：\n${await readActiveArtifact(entry, 'S1')}`,
            }
          : {}),
      });
      const artifact = await saveStageArtifact(
        entry,
        'S1',
        result.content,
        instruction !== null ? `追加要求：${instruction}` : '初始生成',
      );
      entry.inputs.description = description;
      emitProgress(ctx, projectId, 1, '需求文档已生成并入档');
      return { ...result, artifact };
    });
  };

  syncHandlers['getTechChoice'] = (params, _ctx) => {
    const projectId = requireProject(params);
    return readTechChoice(projectId);
  };

  asyncHandlers['saveTechChoice'] = async (params, ctx) => {
    const projectId = requireProject(params);
    const choice = params['choice'] as TechChoice | null;
    if (choice === null || choice === undefined) {
      throw new ShellError('INVALID_ARGUMENT', '缺少技术选型结果（choice）');
    }
    // 不完整的选择一律拒绝：宁可在 S3 前拦下，也不要写入一份"看着像已选"的记忆
    const validation = validateChoice(choice);
    if (!validation.ok) {
      throw new ShellError('INVALID_ARGUMENT', `技术选型不完整：${validation.issues.join('；')}`);
    }
    const stack = toStackObject(choice);
    const existing = db
      .prepare(
        "SELECT id FROM memory_item WHERE project_id=? AND title='技术选型' AND scope='project' AND status='active' ORDER BY updated_at DESC LIMIT 1",
      )
      .get(projectId) as { id: string } | undefined;
    const patch = {
      structured: { choice, stack: stack.stack, targetPlatforms: stack.targetPlatforms },
      content: stack.stack,
    };
    if (existing) await options.memoryRouter('update', { id: existing.id, patch }, innerCtx);
    else
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
    ctx.emit({
      type: 'pipeline:stage-event',
      projectId,
      event: existing ? 'downstream-stale' : 'tech-choice-saved',
      data: { stage: 'S2' },
    });
    return undefined;
  };

  /**
   * S3：技术文档。选型以项目记忆为准（渲染层传来的 choice 不作数），
   * 需求文档读 S1 生效版本，想法读持久化输入 —— 重启后同样可生成。
   */
  asyncHandlers['generateTechDoc'] = async (params, ctx) => {
    const projectId = requireProject(params);
    const entry = loadEntry(projectId);
    requireChoiceFor(projectId, 'S3');
    const choice = readTechChoice(projectId) as TechChoice;
    const instruction =
      typeof params['instruction'] === 'string' && params['instruction'].trim().length > 0
        ? params['instruction']
        : null;
    return runStageTransaction(projectId, entry, 'S3', ctx, async () => {
      emitProgress(ctx, projectId, null, '正在生成技术文档…');
      const requirementDoc = await readActiveArtifact(entry, 'S1');
      const result = await entry.stages.s3.generate({
        userId: options.userId,
        projectId,
        projectName: projectNameOf(projectId, params['projectName']),
        description: entry.inputs.description,
        choice,
        requirementDoc,
        instruction: `${instruction ?? ''}\n\n页面逻辑结构：\n${await readActiveArtifact(entry, 'S2')}\n\n原技术文档（保留未要求修改的内容，返回完整新版）：\n${await readActiveArtifact(entry, 'S3')}`,
      });
      const artifact = await saveStageArtifact(
        entry,
        'S3',
        result.content,
        instruction !== null ? `追加要求：${instruction}` : '初始生成',
      );
      emitProgress(ctx, projectId, 1, '技术文档已生成并入档');
      return { ...result, artifact };
    });
  };

  /**
   * S2：界面设计由设计器承接。本方法把设计器当前的页面（`design/pages/*.dsl.json`）
   * 固化成 S2 产物新版本（页面清单 + 路由 + 元素数），进入待确认 ——
   * 用户确认后才能前进到 S3。内容与上一版一致时不重复造版本。
   */
  asyncHandlers['captureDesign'] = async (params, ctx) => {
    const projectId = requireProject(params);
    const entry = loadEntry(projectId);
    return runStageTransaction(projectId, entry, 'S2', ctx, async () => {
      const pages = pageReader
        .listPages(projectId)
        .map(({ page }) => page)
        .sort((a, b) => a.id.localeCompare(b.id));
      if (pages.length === 0)
        throw new ShellError('INVALID_ARGUMENT', '请先在设计器创建并保存页面');
      const content = JSON.stringify({ pages }, null, 2);
      const latest = entry.artifacts.latestVersion('S2');
      if (latest > 0 && (await entry.artifacts.read('S2', latest).catch(() => null)) === content) {
        return { artifact: entry.artifacts.get('S2', latest), pages: pages.length };
      }
      const artifact = await saveStageArtifact(
        entry,
        'S2',
        content,
        pages.length === 0
          ? '设计稿快照（设计器中暂无页面）'
          : `设计稿快照：${pages.length} 个页面`,
      );
      return { artifact, pages: pages.length };
    });
  };

  /* ------------------------------ S4 拆分（同步读 / 异步写） ------------------------------ */

  syncHandlers['getSplit'] = (params, _ctx) => {
    const projectId = requireProject(params);
    loadEntry(projectId);
    return readSplitFile(projectId);
  };

  const saveSplitVersioned = async (
    projectId: string,
    entry: MachineEntry,
    split: SplitResult,
  ): Promise<void> => {
    const model = SplitModel.fromResult(split);
    if (model.hasCycle()) throw new ShellError('INVALID_ARGUMENT', '拆分依赖存在环路');
    const content = JSON.stringify(split, null, 2);
    storage.write(projectId, join(pipelineDirOf(projectId), 'S4', 'split.json'), content);
    await saveStageArtifact(entry, 'S4', content, '拆分调整');
  };

  asyncHandlers['saveSplit'] = async (params, ctx) => {
    const projectId = requireProject(params);
    const entry = loadEntry(projectId);
    return runStageTransaction(projectId, entry, 'S4', ctx, () =>
      saveSplitVersioned(projectId, entry, params['split'] as SplitResult),
    );
  };

  /**
   * S4 自动拆分（规则解析）：优先从技术文档按标题约定解析（`## 功能：xxx（id）`），
   * 解析不到时回退到需求文档的功能清单，再不行给一个最小可编辑骨架（绝不给空）。
   * 文档默认取 S3/S1 生效版本；显式传版本号时按版本读。
   */
  asyncHandlers['generateSplit'] = async (params, ctx) => {
    const projectId = requireProject(params);
    const entry = loadEntry(projectId);
    return runStageTransaction(projectId, entry, 'S4', ctx, async () => {
      const readVersion = async (stage: Stage, raw: unknown): Promise<string> => {
        const version = Number(raw ?? 0);
        return version > 0
          ? entry.artifacts.read(stage, version)
          : readActiveArtifact(entry, stage);
      };
      const techDoc = await readVersion('S3', params['techDocVersion']);
      let split: SplitResult =
        techDoc.length > 0 ? parseSplitFromTechDoc(techDoc) : { features: [], pages: [] };
      if (split.features.length === 0) {
        // 回退：从需求文档 P0/P1 清单提取功能单元
        const reqDoc = await readVersion('S1', params['requirementDocVersion']);
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
      await saveSplitVersioned(projectId, entry, split);
      emitProgress(
        ctx,
        projectId,
        1,
        `拆分完成：${split.features.length} 个功能 / ${split.pages.length} 个页面`,
      );
      return split;
    });
  };

  asyncHandlers['evaluateImpact'] = async (params, _ctx) => {
    const projectId = requireProject(params);
    const split = readSplitFile(projectId);
    if (split === null) {
      throw new ShellError('NOT_FOUND', '尚未保存拆分结果（S4），无法评估影响面');
    }
    return SplitModel.fromResult(split).evaluateImpact(params['change'] as never);
  };

  /* ------------------------------ S5 队列（异步执行 / 同步查态） ------------------------------ */

  /**
   * S5 执行：必须已从 S4 前进到 S5（S4 已确认）且技术选型已完成。
   * 输入（选型 / 文档 / 拆分）全部由主进程读取；`resume` 为真时从主进程持有的断点继续。
   */
  asyncHandlers['runGeneration'] = async (params, ctx) => {
    const projectId = requireProject(params);
    const entry = loadEntry(projectId);
    requireChoiceFor(projectId, 'S5');
    const status = entry.machine.statusOf('S5');
    if (status === 'pending') {
      throw new ShellError('INVALID_ARGUMENT', '请先确认 S4 拆分结果并进入 S5（逐个生成）');
    }
    if (entry.journal.current !== null) {
      throw new ShellError('ALREADY_EXISTS', '该项目已有生成任务在执行，请等待完成后再试');
    }
    if (status !== 'running' && entry.queue?.running() !== true) {
      entry.machine.startStage('S5');
      persistSnapshot(projectId, entry);
    }
    const resume =
      status !== 'stale' &&
      (params['resume'] === true ||
        (typeof params['resumeProgress'] === 'string' && params['resumeProgress'].length > 0));
    emitProgress(ctx, projectId, null, resume ? 'S5 从断点继续生成' : 'S5 生成队列启动');
    const result = await entry.queue!.run({ resume, ctx });
    const stats = (result.state as QueueState).stats;
    emitProgress(
      ctx,
      projectId,
      1,
      `S5 队列结束：成功 ${stats.success} / 失败 ${stats.failed} / 跳过 ${stats.skipped}`,
    );
    return result;
  };

  asyncHandlers['retryNode'] = async (params, ctx) => {
    const projectId = requireProject(params);
    const entry = loadEntry(projectId);
    const state = await entry.queue!.retryNode(String(params['nodeId']), ctx);
    persistSnapshot(projectId, entry);
    return state;
  };

  asyncHandlers['skipNode'] = async (params, ctx) => {
    const projectId = requireProject(params);
    const entry = loadEntry(projectId);
    const state = await entry.queue!.skipNode(String(params['nodeId']), ctx);
    persistSnapshot(projectId, entry);
    return state;
  };

  syncHandlers['pauseQueue'] = (params, _ctx) => {
    const projectId = requireProject(params);
    const entry = loadEntry(projectId);
    const state = entry.queue!.pause();
    persistSnapshot(projectId, entry);
    return state;
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
      inputs: { ...entry.inputs },
      queue: entry.queue!.state(),
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
      inputs: { ...entry.inputs },
      queue: entry.queue!.state(),
    };
  };

  const reads = new Set([
    'snapshot',
    'listArtifacts',
    'readArtifact',
    'readDiff',
    'getTechChoice',
    'getSplit',
    'getResumeProgress',
    'getQueueState',
    'recoverProject',
    'evaluateImpact',
  ]);
  const guardMutation = (method: string, params: Record<string, unknown>): void => {
    const projectId = requireProject(params);
    const entry = loadEntry(projectId);
    if (
      !reads.has(method) &&
      method !== 'pauseQueue' &&
      (entry.journal.current !== null || entry.queue?.running())
    ) {
      throw new ShellError('ALREADY_EXISTS', '该项目已有生成任务正在执行');
    }
    for (const key of ['stage', 'from', 'to']) {
      const stage = params[key];
      if (stage !== undefined && !STAGES.includes(stage as Stage))
        throw new ShellError('INVALID_ARGUMENT', '未知阶段');
      if (stage !== undefined && !reads.has(method)) requireChoiceFor(projectId, stage as Stage);
    }
  };
  const syncRouter: SyncDomainRouter = (method, params, ctx) => {
    const handler = syncHandlers[method];
    if (!handler) throw new ShellError('NOT_SUPPORTED', `pipeline.${method} 需要异步执行`);
    guardMutation(method, params);
    if (reads.has(method) || method === 'pauseQueue') return handler(params, ctx);
    const projectId = requireProject(params);
    const entry = loadEntry(projectId);
    const snapshot = entry.machine.snapshot();
    const ledger = entry.artifacts.exportLedger();
    const active = entry.artifacts.exportActive();
    try {
      return handler(params, ctx);
    } catch (cause) {
      storage.discard(projectId);
      entry.machine.loadSnapshot(snapshot);
      entry.artifacts.hydrate(ledger, active);
      throw cause;
    }
  };
  const router: DomainRouter = async (method, params, ctx) => {
    if (shutdown.signal.aborted) throw new ShellError('CANCELLED', 'Runtime is shutting down');
    guardMutation(method, params);
    const handler = asyncHandlers[method];
    if (handler) {
      const pending = handler(params, ctx);
      inFlight.add(pending);
      try {
        return await pending;
      } finally {
        inFlight.delete(pending);
      }
    }
    return syncRouter(method, params, ctx);
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
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        cwd,
        ...(signal ? { signal } : {}),
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

function renderS5Report(
  state: QueueState,
  nodeFiles: ReadonlyMap<string, string[]>,
  codeRoot: string,
): string {
  return JSON.stringify(
    {
      nodes: state.nodes.map((node) => ({
        id: node.id,
        name: node.name,
        status: node.status,
        files: (nodeFiles.get(node.id) ?? []).map((path) => ({
          path,
          content: existsSync(join(codeRoot, path))
            ? readFileSync(join(codeRoot, path), 'utf8')
            : null,
        })),
      })),
    },
    null,
    2,
  );
}
