import { createContext, useContext, type ReactNode } from 'react';

import type {
  ArtifactVersion,
  ImpactReport,
  ImpactRequest,
  PipelineStage,
  PipelineStageSnapshot,
  RequirementGenerationResult,
  S5RunResult,
  SplitResult,
  TechChoice,
  TechDocGenerationResult,
} from '@ec/pipeline';

/**
 * 开发流水线的端口（与记忆中心 `MemoryApi`、上下文面板 `ContextPanelApi` 同一套做法）。
 *
 * 渲染层只认这些接口：真实实现由外壳装配（PipelineMachine + ArtifactStore +
 * S1/S3/S4/S5 各阶段 + PipelineRecovery），未注入时展示初始化引导。
 * 领域层（packages/pipeline）的 Node 侧模块（persistence/recovery）不进渲染层，
 * 恢复与持久化由外壳在 Node 端完成，这里只暴露纯操作。
 */
export interface PipelineApi {
  readonly ready: boolean;
  readonly reason?: string | undefined;

  /* ------------------------------ 状态机 ------------------------------ */
  /** 只读阶段状态快照 */
  snapshot(projectId: string): PipelineStageSnapshot;
  /** 前进到下一阶段（前置校验失败抛 InvalidTransitionError） */
  advance(projectId: string, from: PipelineStage, to: PipelineStage): void;
  /** 开始 / 重新生成某阶段 */
  startStage(projectId: string, stage: PipelineStage): void;
  /** 生成完成进入待确认 */
  submitForReview(projectId: string, stage: PipelineStage): void;
  /** 确认通过 */
  confirm(projectId: string, stage: PipelineStage): void;
  /** 回退（UI 已二次确认；返回被置 stale 的阶段） */
  back(projectId: string, from: PipelineStage, to: PipelineStage): PipelineStage[];
  /** 跳过（仅 skippable 阶段） */
  skip(projectId: string, stage: PipelineStage): void;
  /** 确认"重新生成下游"后置 stale */
  applyDownstreamStale(projectId: string, stage: PipelineStage): PipelineStage[];

  /* ------------------------------ 阶段产物 ------------------------------ */
  /** 保存新版本产物 */
  saveArtifact(input: {
    projectId: string;
    stage: PipelineStage;
    artifactType: ArtifactVersion['artifactType'];
    content: string;
    note?: string | undefined;
  }): Promise<ArtifactVersion>;
  /** 某阶段的版本台账 */
  listArtifacts(projectId: string, stage: PipelineStage): ArtifactVersion[];
  /** 读取某版本内容 */
  readArtifact(projectId: string, stage: PipelineStage, version: number): Promise<string>;
  /** 读取相对上一版本的 diff（v1 为 null） */
  readDiff(projectId: string, stage: PipelineStage, version: number): Promise<string | null>;
  /** 切换生效版本（只改指针；提示由调用方用 notifyDownstream 发） */
  switchVersion(projectId: string, stage: PipelineStage, version: number): void;
  /** 发"下游需重新生成"提示事件 */
  notifyDownstream(projectId: string, stage: PipelineStage, message: string): void;

  /* ------------------------------ 阶段执行 ------------------------------ */
  /** S1：生成需求文档（入档 + 关联记忆） */
  generateRequirement(input: {
    projectId: string;
    userId: string;
    projectName: string;
    description: string;
    instruction?: string | undefined;
  }): Promise<RequirementGenerationResult>;
  /** 技术选型问卷：读取已保存结果（未选择返回 null → 阻断进入 S3） */
  getTechChoice(projectId: string): TechChoice | null;
  /** 保存问卷结果（写入项目记忆 structured.stack / targetPlatforms） */
  saveTechChoice(projectId: string, choice: TechChoice): Promise<void>;
  /** S3：生成技术文档（含 OpenAPI 草案与禁止技术后置校验） */
  generateTechDoc(input: {
    projectId: string;
    userId: string;
    projectName: string;
    description: string;
    choice: TechChoice;
    requirementDoc: string;
    instruction?: string | undefined;
  }): Promise<TechDocGenerationResult>;
  /** S4：读取拆分结果（未拆分返回 null） */
  getSplit(projectId: string): SplitResult | null;
  /** 保存拆分结果 */
  saveSplit(projectId: string, split: SplitResult): Promise<void>;
  /** S4：影响面评估（T5-02 补充需求 / T7 重命名消费） */
  evaluateImpact(projectId: string, change: ImpactRequest): ImpactReport;
  /** S5：执行生成队列（含断点续生成；返回终态与进度快照） */
  runGeneration(input: {
    projectId: string;
    userId: string;
    projectName: string;
    choice: TechChoice;
    requirementDoc: string;
    techDoc: string;
    split: SplitResult;
    resumeProgress?: string | null | undefined;
  }): Promise<S5RunResult>;

  /** 订阅流水线事件（阶段变化 / 产物更新 / 下游提示 / 回退） */
  subscribe(event: string, listener: (payload: unknown) => void): () => void;
}

const PipelineContext = createContext<PipelineApi | null>(null);

export interface PipelineProviderProps {
  api: PipelineApi | null;
  children: ReactNode;
}

export function PipelineProvider({ api, children }: PipelineProviderProps): JSX.Element {
  return <PipelineContext.Provider value={api}>{children}</PipelineContext.Provider>;
}

export function usePipelineOptional(): PipelineApi | null {
  return useContext(PipelineContext);
}

export function usePipelineApi(): PipelineApi {
  const api = useContext(PipelineContext);
  if (api === null) throw new Error('流水线未初始化：请先注入 PipelineApi');
  return api;
}

/** 从全局读取外壳注入的实现 */
export function readInjectedPipelineApi(): PipelineApi | null {
  const injected = (globalThis as unknown as { __EC_PIPELINE__?: PipelineApi }).__EC_PIPELINE__;
  if (typeof injected !== 'object' || injected === null) return null;
  return typeof injected.snapshot === 'function' &&
    typeof injected.generateRequirement === 'function'
    ? injected
    : null;
}
