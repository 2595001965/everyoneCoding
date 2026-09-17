import type { EventBus } from '@ec/core';

import type { ContractInjector } from './contract-injector';
import type { GenerationQueue, QueueNode } from './generation-queue';
import type { BuildVerification, MultiPlatformGenerator, PlatformGenerationInput } from './multi-platform-generator';
import type { SplitModel, SplitResult } from './s4-split';
import type { TargetPlatform, TechChoice } from './tech-choice-questionnaire';

/**
 * S5 逐个生成编排（T5-06 / FR-PIPE-09 / FR-PIPE-10 / FR-AI-12 / FR-GIT-09）。
 *
 * 职责：
 * - 把拆分结果转成队列节点（feature 节点生成端工程，page 节点生成页面级代码）；
 * - 默认执行链：契约注入 → 多端生成 → 落盘 → 写回 Code Anchor → 预览热更新 →
 *   Git 变更通知 →（可选）自动提交；
 * - 断点续生成：节点级进度快照（generation-queue.serializeProgress）交给 recovery；
 * - 提交信息格式 `<type>(<scope>): <subject>`（FR-GIT-09）。
 */

export interface S5NodeData {
  /** 该节点覆盖的页面 */
  pageIds: string[];
  /** 生成目标端（feature 节点按问卷主端生成；page 节点为前端页面） */
  platform: string;
  framework: string;
  /** 已生成的接口契约块（执行时注入） */
  contractsBlock: string;
  /** 生成结果摘要（UI 展示） */
  summary: string;
}

export interface S5GenerateDeps {
  generator: MultiPlatformGenerator;
  contracts: ContractInjector;
  queue: GenerationQueue<S5NodeData>;
  /** 文件落盘端口（外壳装配 WorkspaceFileSystem；测试用内存实现） */
  fs?: FileWriterPort | undefined;
  /** 锚点写回端口（外壳装配 @ec/ai anchors 落库） */
  anchors?: AnchorWriterPort | undefined;
  /** 预览热更新端口 */
  preview?: PreviewHotReloadPort | undefined;
  /** Git 端口（自动提交 / 单独回退） */
  git?: GitPort | undefined;
  /** 自动提交开关（默认关闭；建议每阶段提交） */
  autoCommit?: boolean | undefined;
  /** 提交 scope（默认 's5'） */
  commitScope?: string | undefined;
  /** 事件总线（节点完成 / 变更通知，UI 与 Git 视图订阅） */
  bus?: EventBus<S5EventMap> | undefined;
  /**
   * 多端工程总产出开关（FR-AI-12 / E2E-21）。
   *
   * 关闭时沿用「feature 节点按主端生成」的旧行为；开启后额外为**每个勾选的目标端**
   * 生成一套完整可编译工程（Web / Android / HarmonyOS / Windows …），单端失败不影响他端。
   */
  multiTarget?: boolean | undefined;
  /** 各端工程根目录覆盖（默认见 DEFAULT_TARGET_ROOTS） */
  targetRoots?: Partial<Record<TargetPlatform, string>> | undefined;
}

/** 各端工程在工作区内的默认根目录 */
export const DEFAULT_TARGET_ROOTS: Readonly<Record<TargetPlatform, string>> = {
  web: 'apps/web',
  android: 'apps/mobile',
  ios: 'apps/mobile-ios',
  harmonyos: 'apps/harmony',
  windows: 'apps/desktop',
  linux: 'apps/desktop-linux',
  macos: 'apps/desktop-macos',
};

/** 单个目标端的工程产出（E2E-21 逐端验收单位） */
export interface TargetProjectResult {
  platform: TargetPlatform;
  framework: string;
  /** 工程根目录（相对项目工作区） */
  root: string;
  /** 工程内文件（路径已带 root 前缀，可直接落盘） */
  files: Array<{ path: string; content: string }>;
  build: BuildVerification;
  degraded: boolean;
}

export interface FileWriterPort {
  writeFiles(projectId: string, files: ReadonlyArray<{ path: string; content: string }>): Promise<void>;
  /** 生成前快照（单独回退用）；返回引用 */
  snapshot(projectId: string, nodeId: string): Promise<string>;
  /** 按快照恢复 */
  restore(projectId: string, nodeId: string, ref: string): Promise<void>;
}

export interface AnchorWriterPort {
  write(projectId: string, anchors: unknown[]): Promise<void>;
}

export interface PreviewHotReloadPort {
  hotReload(projectId: string, paths: readonly string[]): Promise<void>;
}

export interface GitPort {
  commit(projectId: string, message: string): Promise<{ sha: string }>;
  /** 单独回退：恢复该节点生成前的 Git 状态或代码快照 */
  rollback(projectId: string, nodeId: string, ref: string): Promise<void>;
}

export interface S5EventMap {
  'pipeline:node-generated': { projectId: string; nodeId: string; paths: string[] };
  'pipeline:node-failed': { projectId: string; nodeId: string; error: string };
  'pipeline:git-changed': { projectId: string; paths: string[] };
  'pipeline:auto-committed': { projectId: string; nodeId: string; sha: string };
}

export interface S5RunInput {
  projectId: string;
  userId: string;
  projectName: string;
  choice: TechChoice;
  requirementDoc: string;
  techDoc: string;
  split: SplitModel;
  /** 断点续生成：上次的进度快照 JSON（null = 全新执行） */
  resumeProgress?: string | null | undefined;
}

export interface S5RunResult {
  /** 队列终态（UI 面板直接消费） */
  state: unknown;
  /** 节点结果摘要（按节点 id） */
  results: Record<string, { status: string; files: number; summary: string }>;
  /** 进度快照（recovery 持久化用） */
  progress: string;
  /** 提交记录（自动提交开启时） */
  commits: Array<{ nodeId: string; sha: string; message: string }>;
  /** 各目标端工程产出（multiTarget 开启时；E2E-21） */
  targets?: TargetProjectResult[] | undefined;
}

export class S5GenerateStage {
  private readonly deps: S5GenerateDeps;

  constructor(deps: S5GenerateDeps) {
    this.deps = deps;
  }

  /** 拆分结果 → 队列节点（feature 节点生成端工程；孤儿 page 节点生成页面代码） */
  buildNodes(split: SplitResult, choice: TechChoice): QueueNode<S5NodeData>[] {
    const nodes: QueueNode<S5NodeData>[] = [];
    const pages = new Map(split.pages.map((page) => [page.id, page]));

    for (const feature of split.features) {
      const platform = this.mainPlatform(choice);
      nodes.push({
        id: feature.id,
        name: feature.name,
        kind: 'feature',
        dependsOn: [...feature.dependsOn],
        status: 'pending',
        attempts: 0,
        error: null,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        data: {
          pageIds: feature.pageIds,
          platform,
          framework: this.frameworkFor(choice, platform),
          contractsBlock: '',
          summary: '',
        },
      });
    }

    // 不属于任何功能的页面：作为 page 节点（依赖其所属功能 / 声明的依赖）
    const orphanPages = split.pages.filter((page) => page.featureId === null);
    for (const page of orphanPages) {
      nodes.push({
        id: page.id,
        name: page.name,
        kind: 'page',
        dependsOn: [...page.dependsOn],
        status: 'pending',
        attempts: 0,
        error: null,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        data: {
          pageIds: [page.id],
          platform: 'web',
          framework: choice.web,
          contractsBlock: '',
          summary: '',
        },
      });
    }
    void pages;
    return nodes;
  }

  /**
   * 执行队列。
   * - 节点上下文 = 依赖契约 + （可选）生成器内部注入的记忆/需求/技术文档；
   * - 每节点完成后写回锚点、触发预览热更新与 Git 变更事件、按开关自动提交；
   * - 单节点失败不阻塞队列（GenerationQueue 默认行为）。
   */
  async run(input: S5RunInput): Promise<S5RunResult> {
    const nodes = this.buildNodes(input.split.result(), input.choice);
    // 断点续生成：合并上次进度（跳过已完成节点）
    const resumed = this.resumeNodes(nodes, input.resumeProgress);
    this.deps.queue.load(resumed);

    const results: Record<string, { status: string; files: number; summary: string }> = {};
    const commits: Array<{ nodeId: string; sha: string; message: string }> = [];
    this.deps.queue.setExecutor(this.defaultExecutor(input, results, commits));

    const finalState = await this.deps.queue.run();

    const progress = JSON.stringify({
      version: 1 as const,
      nodes: finalState.nodes.map((node) => ({ id: node.id, status: node.status, attempts: node.attempts, error: node.error })),
    });

    const targets = this.deps.multiTarget === true ? await this.generateTargetProjects(input) : undefined;
    return { state: finalState, results, progress, commits, ...(targets === undefined ? {} : { targets }) };
  }

  /**
   * 逐目标端生成完整工程（FR-AI-12 / FR-AI-13 / E2E-21）。
   *
   * - 对 `choice.targets` 中每个端各跑一次 `MultiPlatformGenerator.generateFor`，
   *   产物路径统一加该端工程根目录前缀（web → `apps/web`，android → `apps/mobile` …）；
   * - **单端失败不阻塞他端**：某端抛错时该端记为 `failed` 构建状态并继续其余端；
   * - 工具链缺失时保留产物并回传安装引导（NFR-C-05，绝不静默跳过）。
   */
  async generateTargetProjects(input: S5RunInput): Promise<TargetProjectResult[]> {
    const pages = input.split.result().pages;
    const out: TargetProjectResult[] = [];

    for (const platform of input.choice.targets) {
      const framework = this.frameworkFor(input.choice, platform);
      const root = this.rootFor(platform);
      const generationInput: PlatformGenerationInput = {
        platform,
        framework,
        projectName: input.projectName,
        stack: this.stackText(input.choice),
        requirementDoc: input.requirementDoc,
        techDoc: input.techDoc,
        pages,
      };

      try {
        const result = await this.deps.generator.generateFor(generationInput);
        const files = result.files.map((file) => ({ path: `${root}/${file.path.replace(/^\.?\//, '')}`, content: file.content }));
        out.push({ platform, framework, root, files, build: result.build, degraded: result.degraded });

        if (this.deps.fs !== undefined && files.length > 0) {
          // 快照/落盘按端隔离，便于单端回退（gen:<platform>）
          await this.deps.fs.snapshot(input.projectId, `gen:${platform}`);
          await this.deps.fs.writeFiles(input.projectId, files);
        }
        if (this.deps.anchors !== undefined && files.length > 0) {
          await this.deps.anchors.write(input.projectId, files.map((file) => ({ filePath: file.path })));
        }
        if (this.deps.preview !== undefined && files.length > 0) {
          await this.deps.preview.hotReload(input.projectId, files.map((file) => file.path));
        }
        void this.deps.bus?.emit('pipeline:node-generated', { projectId: input.projectId, nodeId: `gen:${platform}`, paths: files.map((file) => file.path) });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        out.push({
          platform,
          framework,
          root,
          files: [],
          build: { status: 'failed', output: message, retries: 0, installGuide: null },
          degraded: false,
        });
        void this.deps.bus?.emit('pipeline:node-failed', { projectId: input.projectId, nodeId: `gen:${platform}`, error: message });
      }
    }
    return out;
  }

  /** 该端工程根目录（deps.targetRoots 覆盖优先） */
  rootFor(platform: TargetPlatform): string {
    return this.deps.targetRoots?.[platform] ?? DEFAULT_TARGET_ROOTS[platform];
  }

  /** 提交信息格式 `<type>(<scope>): <subject>`（FR-GIT-09） */
  buildCommitMessage(type: 'feat' | 'fix' | 'docs' | 'refactor' | 'chore', scope: string, subject: string): string {
    const safeScope = scope.replace(/[^\w-]/g, '').toLowerCase();
    const safeSubject = subject.replace(/\s+/g, ' ').trim();
    return `${type}(${safeScope}): ${safeSubject}`;
  }

  /* ------------------------------ 内部 ------------------------------ */

  private defaultExecutor(
    input: S5RunInput,
    results: Record<string, { status: string; files: number; summary: string }>,
    commits: Array<{ nodeId: string; sha: string; message: string }>,
  ): (node: QueueNode<S5NodeData>) => Promise<void> {
    const bus = this.deps.bus;
    return async (node) => {
      const data = node.data ?? { pageIds: [], platform: 'web', framework: 'react', contractsBlock: '', summary: '' };
      try {
        // 1. 契约注入（依赖的接口摘要）
        const { block } = await this.deps.contracts.injectForNode(input.projectId, { id: node.id, name: node.name, dependsOn: node.dependsOn });
        data.contractsBlock = block;

        // 2. 多端生成（feature 节点按端生成工程；page 节点生成页面代码）
        const generationInput: PlatformGenerationInput = {
          platform: (data.platform as never) ?? 'web',
          framework: data.framework,
          projectName: input.projectName,
          stack: this.stackText(input.choice),
          requirementDoc: input.requirementDoc,
          techDoc: `${block}\n\n${input.techDoc}`,
          pages: input.split.result().pages.filter((page) => data.pageIds.includes(page.id)),
        };
        const result = await this.deps.generator.generateFor(generationInput);
        data.summary = `${result.framework}（${result.build.status}）`;

        // 3. 落盘（未装配 fs 时跳过；Wave 9/10 外壳装配）
        const paths = result.files.map((file) => file.path);
        if (this.deps.fs !== undefined) {
          await this.deps.fs.snapshot(input.projectId, node.id);
          await this.deps.fs.writeFiles(input.projectId, result.files);
        }

        // 4. 写回锚点（未装配时跳过）
        if (this.deps.anchors !== undefined) {
          await this.deps.anchors.write(input.projectId, result.files.map((file) => ({ filePath: file.path })));
        }

        // 5. 预览热更新 + Git 变更事件
        if (this.deps.preview !== undefined) await this.deps.preview.hotReload(input.projectId, paths);
        void bus?.emit('pipeline:git-changed', { projectId: input.projectId, paths });
        void bus?.emit('pipeline:node-generated', { projectId: input.projectId, nodeId: node.id, paths });

        // 6. 自动提交（默认关闭）
        if (this.deps.autoCommit === true && this.deps.git !== undefined) {
          const message = this.buildCommitMessage('feat', this.deps.commitScope ?? 's5', node.name);
          const { sha } = await this.deps.git.commit(input.projectId, message);
          commits.push({ nodeId: node.id, sha, message });
          void bus?.emit('pipeline:auto-committed', { projectId: input.projectId, nodeId: node.id, sha });
        }

        results[node.id] = { status: 'success', files: result.files.length, summary: data.summary };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        results[node.id] = { status: 'failed', files: 0, summary: message };
        void bus?.emit('pipeline:node-failed', { projectId: input.projectId, nodeId: node.id, error: message });
        throw cause;
      }
    };
  }

  private resumeNodes(nodes: QueueNode<S5NodeData>[], resumeProgress: string | null | undefined): QueueNode<S5NodeData>[] {
    if (resumeProgress === null || resumeProgress === undefined || resumeProgress.trim().length === 0) return nodes;
    try {
      const parsed = JSON.parse(resumeProgress) as { nodes?: Array<{ id: string; status: string }> };
      if (!Array.isArray(parsed.nodes)) return nodes;
      const progress = new Map(parsed.nodes.map((node) => [node.id, node.status]));
      return nodes.map((node) => {
        const status = progress.get(node.id);
        if (status === 'success' || status === 'skipped') return { ...node, status: status as QueueNode<S5NodeData>['status'] };
        return node;
      });
    } catch {
      return nodes;
    }
  }

  private mainPlatform(choice: TechChoice): string {
    if (choice.targets.includes('harmonyos')) return 'harmonyos';
    if (choice.targets.some((target) => target === 'android' || target === 'ios')) return 'android';
    if (choice.targets.some((target) => target === 'windows' || target === 'linux' || target === 'macos')) return 'windows';
    return 'web';
  }

  private frameworkFor(choice: TechChoice, platform: string): string {
    switch (platform) {
      case 'harmonyos':
        return 'arkts';
      case 'android':
      case 'ios':
        return choice.mobile;
      case 'windows':
      case 'linux':
      case 'macos':
        return choice.desktop;
      default:
        return choice.web;
    }
  }

  private stackText(choice: TechChoice): string {
    return [
      `目标端：${choice.targets.join(' / ')}`,
      `移动方案：${choice.mobile}`,
      `桌面方案：${choice.desktop}`,
      `前端：${choice.frontend}`,
      `后端：${choice.backend}`,
      `数据库：${choice.database}`,
      `ORM：${choice.orm}`,
      `部署：${choice.deploy}`,
    ].join('\n');
  }
}
