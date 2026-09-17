import type { ArtifactType, PipelineStage } from './stage-defs';

/**
 * 阶段产物版本化存储（T5-01 要点 3 / FR-PIPE-02）。
 *
 * 职责边界：
 * - **版本台账**在内存（每阶段一个版本数组），持久化到 stage_artifact 表由 persistence.ts 完成；
 * - 内容本体不进 SQLite —— `contentRef` / `diffRef` 是内容文件的引用（相对路径），
 *   落盘由调用方注入的 {@link ArtifactContentFs} 完成（临时文件 + 原子替换约束在 fs 实现里落实）；
 * - 每个版本独立保存内容引用与 diff 引用；diff 是相对上一版本的（v1 的 diffRef 为 null）；
 * - 切换版本只改"当前生效指针"，**绝不删除任何历史版本**（回看 / 回滚都靠它）；
 *   切换后由调用方通过状态机的 notifyDownstream 提示下游。
 */

/** 文件系统端口：外壳装配到 @ec/core FileService；测试用内存实现 */
export interface ArtifactContentFs {
  writeAtomic(path: string, content: string): Promise<void>;
  readText(path: string): Promise<string | null>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
}

/** 一个版本条目的台账（对齐 stage_artifact 表的列） */
export interface ArtifactVersion {
  stage: PipelineStage;
  artifactType: ArtifactType;
  /** 从 1 递增 */
  version: number;
  /** 内容文件引用（相对路径）；纯内存产物（如 S4 拆分 JSON）也落文件以保证可校验 */
  contentRef: string;
  /** 相对上一版本的 diff 引用；v1 为 null */
  diffRef: string | null;
  /** 创建时间（毫秒） */
  createdAt: number;
  /** 生成说明（追加要求 / 重新生成的指令摘要） */
  note: string;
}

export interface SaveArtifactInput {
  stage: PipelineStage;
  artifactType: ArtifactType;
  /** 产物正文（完整内容，不做增量） */
  content: string;
  /** 生成说明 */
  note?: string | undefined;
  /** 显式指定版本（恢复场景）；缺省为最新版本 +1 */
  version?: number | undefined;
  createdAt?: number | undefined;
}

export interface ArtifactStoreDeps {
  projectId: string;
  /** 内容文件的存放根目录（数据目录相对路径，如 `<project>/pipeline/S1`） */
  rootDir: string;
  fs: ArtifactContentFs;
  clock?: (() => number) | undefined;
  /** 版本号 / 文件名生成（测试可注入） */
  idPrefix?: string | undefined;
  /**
   * 版本落库回调（外壳装配到 `PipelineRepo.upsertArtifact`）。
   *
   * 为什么用回调而不是直接依赖 `PipelineRepo`：`ArtifactStore` 只负责"内存台账 + 内容文件"，
   * 表写入属于持久化层职责；用回调可让本模块保持零 SQL 依赖（浏览器入口也能安全引用）。
   * 不提供时仅内存台账（测试 / 纯前端场景）。
   */
  onVersionSaved?: ((entry: ArtifactVersion) => void) | undefined;
}

export class ArtifactNotFoundError extends Error {
  readonly stage: PipelineStage;
  readonly version: number | null;

  constructor(stage: PipelineStage, version: number | null, message?: string) {
    super(message ?? `阶段 ${stage} 的产物${version === null ? '' : ` v${version}`}不存在`);
    this.name = 'ArtifactNotFoundError';
    this.stage = stage;
    this.version = version;
    Object.setPrototypeOf(this, ArtifactNotFoundError.prototype);
  }
}

export class ArtifactStore {
  private readonly deps: ArtifactStoreDeps;
  private readonly clock: () => number;
  /** stage → 版本台账（按 version 升序） */
  private readonly ledger = new Map<PipelineStage, ArtifactVersion[]>();
  /** stage → 当前生效版本 */
  private readonly active = new Map<PipelineStage, number>();

  constructor(deps: ArtifactStoreDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? (() => Date.now());
  }

  private versionsOf(stage: PipelineStage): ArtifactVersion[] {
    let versions = this.ledger.get(stage);
    if (versions === undefined) {
      versions = [];
      this.ledger.set(stage, versions);
    }
    return versions;
  }

  /** 保存一个新版本（追加，不改当前指针除非这是第一版） */
  async save(input: SaveArtifactInput): Promise<ArtifactVersion> {
    const versions = this.versionsOf(input.stage);
    const nextVersion = input.version ?? versions.length + 1;
    const existing = versions.find((entry) => entry.version === nextVersion);
    if (existing !== undefined) {
      throw new Error(`阶段 ${input.stage} 的产物 v${nextVersion} 已存在，禁止覆盖历史版本`);
    }

    const contentRef = this.contentPath(input.stage, nextVersion);
    await this.deps.fs.writeAtomic(contentRef, input.content);

    const previous = versions[versions.length - 1];
    let diffRef: string | null = null;
    if (previous !== undefined) {
      // 注意参数顺序：read(stage, version)。历史上一处把两者写反，
      // 导致 diff 计算时抛 ArtifactNotFoundError，v2 起全部保存失败。
      const before = await this.read(input.stage, previous.version);
      const diffText = this.buildLineDiff(before, input.content);
      if (diffText.length > 0) {
        diffRef = this.diffPath(input.stage, nextVersion);
        await this.deps.fs.writeAtomic(diffRef, diffText);
      }
    }

    const entry: ArtifactVersion = {
      stage: input.stage,
      artifactType: input.artifactType,
      version: nextVersion,
      contentRef,
      diffRef,
      createdAt: input.createdAt ?? this.clock(),
      note: input.note ?? '',
    };
    versions.push(entry);
    versions.sort((a, b) => a.version - b.version);

    // 当前指针默认指向最新版本（FR-PIPE-02：新生成的文档即为生效版本）；
    // 显式指定 version 的恢复/回填场景不抢占指针，仅在没有指针时兜底。
    if (input.version === undefined || this.active.get(input.stage) === undefined) {
      this.active.set(input.stage, nextVersion);
    }
    // 落库（外壳装配 PipelineRepo；未装配时为纯内存台账）
    this.deps.onVersionSaved?.({ ...entry });
    return { ...entry };
  }

  /** 当前生效版本号；从未生成返回 0 */
  activeVersion(stage: PipelineStage): number {
    return this.active.get(stage) ?? 0;
  }

  /** 最新版本号；从未生成返回 0 */
  latestVersion(stage: PipelineStage): number {
    const versions = this.versionsOf(stage);
    return versions.length === 0 ? 0 : (versions[versions.length - 1]?.version ?? 0);
  }

  list(stage: PipelineStage): ArtifactVersion[] {
    return this.versionsOf(stage).map((entry) => ({ ...entry }));
  }

  get(stage: PipelineStage, version: number): ArtifactVersion {
    const entry = this.versionsOf(stage).find((candidate) => candidate.version === version);
    if (entry === undefined) throw new ArtifactNotFoundError(stage, version);
    return { ...entry };
  }

  /** 读取某版本内容 */
  async read(stage: PipelineStage, version: number): Promise<string> {
    const entry = this.get(stage, version);
    const content = await this.deps.fs.readText(entry.contentRef);
    if (content === null) throw new ArtifactNotFoundError(stage, version, `产物文件缺失：${entry.contentRef}`);
    return content;
  }

  /** 读取某版本相对上一版本的 diff（v1 返回全文 diff 语义：无 diffRef 返回 null） */
  async readDiff(stage: PipelineStage, version: number): Promise<string | null> {
    const entry = this.get(stage, version);
    if (entry.diffRef === null) return null;
    const diff = await this.deps.fs.readText(entry.diffRef);
    return diff;
  }

  /**
   * 切换当前生效版本（FR-PIPE-02 要点 2）。
   * 只改指针，不动任何历史版本，也不动下游状态 ——
   * "是否重新生成下游"的提示由调用方用状态机 notifyDownstream 发出。
   */
  switchVersion(stage: PipelineStage, version: number): ArtifactVersion {
    const entry = this.get(stage, version);
    this.active.set(stage, version);
    return { ...entry };
  }

  /** 恢复场景：整表灌入（persistence.ts 从 stage_artifact 表重建台账） */
  hydrate(entries: readonly ArtifactVersion[], activeByStage: Readonly<Record<string, number>> = {}): void {
    this.ledger.clear();
    this.active.clear();
    for (const raw of entries) {
      const versions = this.versionsOf(raw.stage);
      versions.push({ ...raw });
    }
    for (const [stage, versions] of this.ledger) {
      versions.sort((a, b) => a.version - b.version);
      const newest = versions[versions.length - 1]?.version ?? 0;
      this.active.set(stage, activeByStage[stage] ?? newest);
    }
  }

  /** 台账导出（persistence 持久化用） */
  exportLedger(): ArtifactVersion[] {
    const rows: ArtifactVersion[] = [];
    for (const versions of this.ledger.values()) {
      for (const entry of versions) rows.push({ ...entry });
    }
    return rows;
  }

  exportActive(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [stage, version] of this.active) result[stage] = version;
    return result;
  }

  /**
   * 恢复时的一致性校验（FR-PIPE-11 要点 5）：台账里的每个版本都必须能读到内容文件。
   * 返回缺失 / 不可读的版本清单，由 UI 提示；不自动删除台账（可能只是暂时的挂载问题）。
   */
  async verifyIntegrity(): Promise<Array<{ stage: PipelineStage; version: number; contentRef: string; reason: string }>> {
    const problems: Array<{ stage: PipelineStage; version: number; contentRef: string; reason: string }> = [];
    for (const versions of this.ledger.values()) {
      for (const entry of versions) {
        const exists = await this.deps.fs.exists(entry.contentRef);
        if (!exists) {
          problems.push({ stage: entry.stage, version: entry.version, contentRef: entry.contentRef, reason: '产物文件不存在（可能被外部删除或移动）' });
          continue;
        }
        const content = await this.deps.fs.readText(entry.contentRef);
        if (content === null) {
          problems.push({ stage: entry.stage, version: entry.version, contentRef: entry.contentRef, reason: '产物文件不可读' });
        }
      }
    }
    return problems;
  }

  private contentPath(stage: PipelineStage, version: number): string {
    const prefix = this.deps.idPrefix ?? 'art';
    return `${this.deps.rootDir}/${stage.toLowerCase()}-${prefix}-v${version}.md`;
  }

  private diffPath(stage: PipelineStage, version: number): string {
    const prefix = this.deps.idPrefix ?? 'art';
    return `${this.deps.rootDir}/${stage.toLowerCase()}-${prefix}-v${version}.diff`;
  }

  /** 行级 diff（供 diff 面板与 diff_ref 文件用；统一 \n 行尾） */
  buildLineDiff(before: string, after: string): string {
    const beforeLines = before.replace(/\r\n?/g, '\n').split('\n');
    const afterLines = after.replace(/\r\n?/g, '\n').split('\n');
    if (beforeLines.length === 1 && beforeLines[0] === '') beforeLines.length = 0;
    if (afterLines.length === 1 && afterLines[0] === '') afterLines.length = 0;

    const lines: string[] = [];
    lines.push(`--- v${this.latestVersionOfDiffContext(before)} `);
    lines.push(`+++ 新版本 `);
    const removed = beforeLines.filter((line) => !afterLines.includes(line));
    const added = afterLines.filter((line) => !beforeLines.includes(line));
    for (const line of removed) lines.push(`- ${line}`);
    for (const line of added) lines.push(`+ ${line}`);
    return lines.join('\n');
  }

  private latestVersionOfDiffContext(_before: string): number {
    // 占位：diff 头部只区分方向，版本号由文件名本身承载
    return 0;
  }
}
