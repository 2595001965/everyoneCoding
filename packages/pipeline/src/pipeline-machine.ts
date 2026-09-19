import { EventBus } from '@ec/core';

import {
  PIPELINE_STAGES,
  STAGE_DEFS,
  STAGE_ORDER,
  nextStage,
  stagesAfter,
  type PipelineStage,
  type StageStatus,
} from './stage-defs';

/**
 * 流水线状态机内核（T5-01 要点 2 / FR-PIPE-01 / FR-PIPE-04 / FR-PIPE-11）。
 *
 * 每个阶段一个状态位：pending | running | awaiting_confirm | confirmed | stale。
 *
 * 合法转移表（显式列举，表外的转移一律抛 {@link InvalidTransitionError}）：
 * ```
 * pending          → running / skipped 见下注 / stale（上游回退波及）
 * running          → awaiting_confirm / failed(=running 可重入) / stale
 * awaiting_confirm → confirmed / running（确认后要求修改，重新生成）
 * confirmed        → running（重跑本阶段）/ stale（上游变更波及）
 * stale            → running（重新生成后复活）/ pending（回退重置）
 * ```
 * 说明：
 * - `pending → awaiting_confirm`、`pending → confirmed` 一律非法（E2E 验收：未生成就确认被拒绝）；
 * - 跳过（skip）只对 `skippable` 阶段开放，语义是直接落到 confirmed 并记录 skippedAt，
 *   **不是**新增一个状态位（@ec/data 的 runStatus 枚举只有五个值，不私加）；
 * - 前进（advance）自动校验：前一阶段必须 confirmed，否则拒绝 —— 保证"S1→S7 顺序推进"。
 */

/** 状态机事件（UI 与持久化层订阅；经 @ec/core EventBus 发布） */
export interface PipelineEventMap {
  /** 阶段状态变化 */
  'pipeline:stage-changed': {
    projectId: string;
    stage: PipelineStage;
    from: StageStatus;
    to: StageStatus;
    reason: 'advance' | 'confirm' | 'regenerate' | 'stale' | 'reset' | 'skip' | 'restore' | 'load';
  };
  /** 阶段产物出现新版本（版本切换 / 重新生成都会发） */
  'pipeline:artifact-updated': {
    projectId: string;
    stage: PipelineStage;
    artifactType: string;
    version: number;
    /** 切换到的版本 ≠ 最新版本时为 true（提示"正在查看历史版本"） */
    historical: boolean;
  };
  /** 下游需重新生成的提示（版本切换 / 补充指令后发；UI 弹"是否重新生成下游"） */
  'pipeline:downstream-stale': {
    projectId: string;
    stage: PipelineStage;
    /** 受影响的下游阶段 */
    affected: PipelineStage[];
    message: string;
  };
  /** 回退完成（UI 据此刷新整条步骤条） */
  'pipeline:rolled-back': {
    projectId: string;
    from: PipelineStage;
    to: PipelineStage;
    markedStale: PipelineStage[];
  };
}

export class InvalidTransitionError extends Error {
  readonly stage: PipelineStage;
  readonly from: StageStatus;
  readonly to: StageStatus;

  constructor(stage: PipelineStage, from: StageStatus, to: StageStatus, hint?: string) {
    super(
      `非法状态转移：阶段 ${stage} 不能从 ${from} 转移到 ${to}${hint === undefined ? '' : `（${hint}）`}`,
    );
    this.name = 'InvalidTransitionError';
    this.stage = stage;
    this.from = from;
    this.to = to;
    Object.setPrototypeOf(this, InvalidTransitionError.prototype);
  }
}

/** 单阶段运行时状态（内存权威副本；持久化由 persistence.ts 负责） */
export interface StageState {
  stage: PipelineStage;
  status: StageStatus;
  /** 当前生效的产物版本（未生成过为 null） */
  activeVersion: number | null;
  /** 最新产物版本号（未生成过为 0） */
  latestVersion: number;
  /** skip 落地的时间戳（未跳过为 null） */
  skippedAt: number | null;
  /** 最近一次状态变更时间（断点恢复展示用） */
  updatedAt: number;
}

export type PipelineStageSnapshot = Record<PipelineStage, StageState>;

export interface PipelineMachineOptions {
  projectId: string;
  /** 时钟注入（测试可控） */
  clock?: () => number;
  /** 事件总线注入（缺省自建；外壳可传入共享总线） */
  bus?: EventBus<PipelineEventMap>;
}

export interface AdvanceCheck {
  /** 前进前允许的阶段校验钩子（返回错误文案即阻断，如 S3 前必须完成技术选型问卷） */
  beforeAdvance?: ((from: PipelineStage, to: PipelineStage) => string | null) | undefined;
}

/** 合法转移表：from → 允许的 to 集合 */
const LEGAL_TRANSITIONS: Readonly<Record<StageStatus, readonly StageStatus[]>> = {
  pending: ['running', 'stale'],
  running: ['awaiting_confirm', 'running', 'stale'],
  awaiting_confirm: ['confirmed', 'running', 'stale'],
  confirmed: ['running', 'stale'],
  stale: ['running', 'pending', 'stale'],
};

function assertLegal(stage: PipelineStage, from: StageStatus, to: StageStatus): void {
  if (from === to) return; // 幂等重入视为合法（no-op）
  const allowed = LEGAL_TRANSITIONS[from];
  if (allowed === undefined || !allowed.includes(to)) {
    throw new InvalidTransitionError(stage, from, to);
  }
}

export class PipelineMachine {
  private readonly projectId: string;
  private readonly clock: () => number;
  readonly bus: EventBus<PipelineEventMap>;
  private states: PipelineStageSnapshot;
  private guard: AdvanceCheck['beforeAdvance'];

  constructor(options: PipelineMachineOptions) {
    this.projectId = options.projectId;
    this.clock = options.clock ?? (() => Date.now());
    this.bus = options.bus ?? new EventBus<PipelineEventMap>();
    this.guard = undefined;
    this.states = blankSnapshot();
  }

  /** 注入前进前的额外校验（如 T5-04 的"未完成问卷不得进入 S3"） */
  setAdvanceGuard(guard: AdvanceCheck['beforeAdvance']): void {
    this.guard = guard;
  }

  /** 只读快照（UI 渲染与持久化用） */
  snapshot(): PipelineStageSnapshot {
    return cloneSnapshot(this.states);
  }

  stageState(stage: PipelineStage): StageState {
    return { ...this.states[stage] };
  }

  statusOf(stage: PipelineStage): StageStatus {
    return this.states[stage].status;
  }

  /** 当前推进到哪儿：最后一个非 pending 阶段 */
  currentStage(): PipelineStage {
    for (const stage of [...STAGE_ORDER].reverse()) {
      if (this.states[stage].status !== 'pending') return stage;
    }
    return 'S1';
  }

  private emit(
    stage: PipelineStage,
    from: StageStatus,
    to: StageStatus,
    reason: PipelineEventMap['pipeline:stage-changed']['reason'],
  ): void {
    void this.bus.emit('pipeline:stage-changed', {
      projectId: this.projectId,
      stage,
      from,
      to,
      reason,
    });
  }

  private setStatus(
    stage: PipelineStage,
    to: StageStatus,
    reason: PipelineEventMap['pipeline:stage-changed']['reason'],
  ): void {
    const state = this.states[stage];
    if (state.status === to) return;
    const from = state.status;
    state.status = to;
    state.updatedAt = this.clock();
    this.emit(stage, from, to, reason);
  }

  /**
   * 前进：把 to 阶段置为 running。
   * 前置校验：from 阶段必须 confirmed；guard 钩子返回错误文案则拒绝。
   */
  advance(from: PipelineStage, to: PipelineStage): void {
    if (!STAGE_ORDER.includes(from) || !STAGE_ORDER.includes(to)) {
      throw new InvalidTransitionError(
        to,
        this.states[to]?.status ?? 'pending',
        'running',
        '未知阶段',
      );
    }
    if (STAGE_ORDER.indexOf(to) !== STAGE_ORDER.indexOf(from) + 1) {
      throw new InvalidTransitionError(
        to,
        this.states[to].status,
        'running',
        `只能从 ${from} 前进到紧邻的下一阶段`,
      );
    }
    if (this.states[from].status !== 'confirmed') {
      throw new InvalidTransitionError(
        from,
        this.states[from].status,
        'confirmed',
        '上一阶段尚未确认，不能前进',
      );
    }
    const blocked = this.guard?.(from, to) ?? null;
    if (blocked !== null) {
      throw new InvalidTransitionError(to, this.states[to].status, 'running', blocked);
    }
    this.setStatus(to, 'running', 'advance');
  }

  /** 阶段生成完成，进入待确认 */
  submitForReview(stage: PipelineStage): void {
    assertLegal(stage, this.states[stage].status, 'awaiting_confirm');
    this.setStatus(stage, 'awaiting_confirm', 'regenerate');
  }

  /** 开始 / 重新生成某阶段（running 可重入） */
  startStage(stage: PipelineStage): void {
    assertLegal(stage, this.states[stage].status, 'running');
    this.setStatus(stage, 'running', 'regenerate');
  }

  /** 确认通过（awaiting_confirm / confirmed → confirmed） */
  confirm(stage: PipelineStage): void {
    assertLegal(stage, this.states[stage].status, 'confirmed');
    this.setStatus(stage, 'confirmed', 'confirm');
  }

  /** 标记过期（产物切换 / 上游回退波及） */
  markStale(stage: PipelineStage): void {
    assertLegal(stage, this.states[stage].status, 'stale');
    this.setStatus(stage, 'stale', 'stale');
  }

  /** 重置为未开始（stale → pending；回退重置用） */
  resetStage(stage: PipelineStage): void {
    assertLegal(stage, this.states[stage].status, 'pending');
    this.setStatus(stage, 'pending', 'reset');
  }

  /** 跳过：只允许 skippable 阶段，且必须处于 pending；落为 confirmed 并记 skippedAt */
  skip(stage: PipelineStage): void {
    if (!STAGE_DEFS[stage].skippable) {
      throw new InvalidTransitionError(
        stage,
        this.states[stage].status,
        'confirmed',
        '该阶段不可跳过',
      );
    }
    const state = this.states[stage];
    if (state.status !== 'pending') {
      throw new InvalidTransitionError(stage, state.status, 'confirmed', '只能跳过未开始的阶段');
    }
    this.setStatus(stage, 'confirmed', 'skip');
    state.skippedAt = this.clock();
    state.updatedAt = this.clock();
  }

  /**
   * 版本切换提示（T5-01 要点 2 后半句）：切换产物版本不影响下游已生成内容，
   * 但发事件提示"文档已更新，是否重新生成下游"。是否真把下游置 stale 由调用方
   * （UI 确认后）调 {@link applyDownstreamStale} 决定 —— 这里只发通知。
   */
  notifyDownstream(stage: PipelineStage, message: string): void {
    const affected = stagesAfter(stage).filter(
      (candidate) => this.states[candidate].status !== 'pending',
    );
    void this.bus.emit('pipeline:downstream-stale', {
      projectId: this.projectId,
      stage,
      affected,
      message,
    });
  }

  /** UI 确认"重新生成下游"后调用：把 (stage, S7] 中非 pending 的阶段全部置 stale */
  applyDownstreamStale(stage: PipelineStage): PipelineStage[] {
    const marked: PipelineStage[] = [];
    for (const candidate of stagesAfter(stage)) {
      if (this.states[candidate].status === 'pending') continue;
      this.markStale(candidate);
      marked.push(candidate);
    }
    return marked;
  }

  /**
   * 回退（FR-PIPE-04）：from 阶段回到 to 阶段。
   * - 二次确认由 UI 层在调用前完成（这里不做 UI，只负责状态后果）；
   * - (to, from] 区间内已推进的阶段全部置 stale；
   * - from 及其后已确认阶段同样失效 —— 上游一变，下游必然过期。
   */
  back(from: PipelineStage, to: PipelineStage): PipelineStage[] {
    if (STAGE_ORDER.indexOf(to) > STAGE_ORDER.indexOf(from)) {
      throw new InvalidTransitionError(
        from,
        this.states[from].status,
        this.states[to].status,
        '回退只能向后',
      );
    }
    const markedStale: PipelineStage[] = [];
    for (const stage of stagesAfter(to, from)) {
      const state = this.states[stage];
      if (state.status === 'pending') continue;
      if (stage === to) continue;
      // 回退目标阶段本身重置为 stale（等待重新生成），其余下游全部失效
      this.markStale(stage);
      markedStale.push(stage);
    }
    void this.bus.emit('pipeline:rolled-back', {
      projectId: this.projectId,
      from,
      to,
      markedStale,
    });
    return markedStale;
  }

  /** 直接覆写单阶段状态（仅供 recovery.ts 恢复时使用；业务代码不得调用） */
  restoreStageState(state: StageState): void {
    if (!PIPELINE_STAGES.includes(state.stage)) return;
    this.states[state.stage] = { ...state };
    this.emit(state.stage, state.status, state.status, 'restore');
  }

  /** 整体加载快照（persistence 恢复用） */
  loadSnapshot(snapshot: PipelineStageSnapshot): void {
    this.states = cloneSnapshot(sanitizeSnapshot(snapshot));
    for (const stage of STAGE_ORDER) {
      this.emit(stage, this.states[stage].status, this.states[stage].status, 'load');
    }
  }
}

export function blankStageState(stage: PipelineStage, now = 0): StageState {
  return {
    stage,
    status: 'pending',
    activeVersion: null,
    latestVersion: 0,
    skippedAt: null,
    updatedAt: now,
  };
}

function blankSnapshot(): PipelineStageSnapshot {
  const snapshot = {} as PipelineStageSnapshot;
  for (const stage of PIPELINE_STAGES) snapshot[stage] = blankStageState(stage);
  return snapshot;
}

function sanitizeSnapshot(snapshot: PipelineStageSnapshot): PipelineStageSnapshot {
  const merged = blankSnapshot();
  for (const stage of PIPELINE_STAGES) {
    const incoming = snapshot[stage];
    const base = merged[stage];
    if (incoming === undefined) continue;
    base.status =
      STAGE_ORDER.includes(stage) && isKnownStatus(incoming.status) ? incoming.status : 'pending';
    base.activeVersion = typeof incoming.activeVersion === 'number' ? incoming.activeVersion : null;
    base.latestVersion = typeof incoming.latestVersion === 'number' ? incoming.latestVersion : 0;
    base.skippedAt = typeof incoming.skippedAt === 'number' ? incoming.skippedAt : null;
    base.updatedAt = typeof incoming.updatedAt === 'number' ? incoming.updatedAt : 0;
  }
  return merged;
}

function isKnownStatus(value: unknown): value is StageStatus {
  return (
    value === 'pending' ||
    value === 'running' ||
    value === 'awaiting_confirm' ||
    value === 'confirmed' ||
    value === 'stale'
  );
}

function cloneSnapshot(snapshot: PipelineStageSnapshot): PipelineStageSnapshot {
  const clone = {} as PipelineStageSnapshot;
  for (const stage of PIPELINE_STAGES) clone[stage] = { ...snapshot[stage] };
  return clone;
}

/** 供 UI 判断"下一阶段能否前进"（不做转移，只做预检） */
export function canAdvance(
  machine: PipelineMachine,
  from: PipelineStage,
): { ok: boolean; reason: string | null } {
  const to = nextStage(from);
  if (to === null) return { ok: false, reason: '已是最后阶段' };
  if (machine.statusOf(from) !== 'confirmed') return { ok: false, reason: `阶段 ${from} 尚未确认` };
  return { ok: true, reason: null };
}
