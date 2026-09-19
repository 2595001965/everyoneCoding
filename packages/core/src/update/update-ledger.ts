/**
 * 更新回滚台账（T10-04 / FR-SET-05「更新失败可回滚到上一版本」）。
 *
 * 问题：安装包替换成功、但新版本启动即崩（缺 DLL / 迁移失败 / WebView2 异常）时，
 * 进程内已没有能力"自己退回去"——必须在**启动早期**由一个独立于业务代码的账簿判定。
 *
 * 解法（双形态共用，纯逻辑、JSON 可序列化）：
 *   1. 安装前 `beginUpdate()`：记录 from/to 版本与上一版本备份路径，状态置 pending-healthy；
 *   2. 每次启动调用 `recordBoot()`，累计尝试次数未达上限 → allow（正常启动）；
 *      达上限仍未 markHealthy → decision='rollback'，并给出 restoreFrom；
 *   3. 应用到达"可交互"后调用 `markHealthy()` 落定；
 *   4. 外壳按 decision 还原备份 → `markRolledBack()`，并保留历史供审计。
 *
 * 这样"崩溃循环"最多发生 `maxBootAttempts` 次就自愈，而不是无限重启。
 */

export type UpdateStage =
  | 'idle'
  | 'downloading'
  | 'installing'
  /** 已安装、等待下一次启动后的健康确认 */
  | 'pending-healthy'
  | 'healthy'
  | 'rolled-back'
  /** 回滚也失败了——需要人工介入，必须让用户看见 */
  | 'rollback-failed';

export interface UpdateRecord {
  /** 目标版本（正在安装/等待确认的版本） */
  toVersion: string;
  /** 来源版本（回滚目标） */
  fromVersion: string;
  /** 上一版本备份路径（目录或安装包）；无备份时为 null，此时无法回滚 */
  backupPath: string | null;
  startedAt: number;
  updatedAt: number;
  stage: UpdateStage;
  /** 自本次更新落地以来的启动尝试次数 */
  bootAttempts: number;
  lastError: string | null;
}

export interface UpdateLedgerState {
  current: UpdateRecord | null;
  /** 历史记录（新→旧），用于设置页展示"上次更新/上次回滚" */
  history: UpdateRecord[];
}

export type BootDecision =
  /** 正常启动（未达尝试上限） */
  | { decision: 'allow'; attempts: number }
  /** 判定为启动失败，需要还原 */
  | {
      decision: 'rollback';
      attempts: number;
      restoreFrom: string;
      toVersion: string;
      fromVersion: string;
    }
  /** 没有待确认的更新，什么都不用做 */
  | { decision: 'none' }
  /** 待确认但**没有备份**——无法自动回滚，如实上报，不假装成功 */
  | { decision: 'no-backup'; attempts: number; toVersion: string };

export interface UpdateLedgerOptions {
  /** 允许的启动尝试次数（含首次）。默认 2：首次启动失败一次即回滚。 */
  maxBootAttempts?: number;
  /** 历史保留条数上限 */
  maxHistory?: number;
}

export const DEFAULT_MAX_BOOT_ATTEMPTS = 2;
const DEFAULT_MAX_HISTORY = 10;

export class UpdateLedger {
  private state: UpdateLedgerState;
  private readonly maxBootAttempts: number;
  private readonly maxHistory: number;

  constructor(initial?: Partial<UpdateLedgerState> | null, options: UpdateLedgerOptions = {}) {
    this.maxBootAttempts = options.maxBootAttempts ?? DEFAULT_MAX_BOOT_ATTEMPTS;
    this.maxHistory = options.maxHistory ?? DEFAULT_MAX_HISTORY;
    this.state = {
      current: initial?.current ?? null,
      history: initial?.history ? [...initial.history] : [],
    };
  }

  /** 从落盘的 JSON 恢复；坏数据一律降级为"空账簿"，绝不阻塞启动（NFR-U-02）。 */
  static fromJSON(raw: unknown, options: UpdateLedgerOptions = {}): UpdateLedger {
    if (raw === null || typeof raw !== 'object') return new UpdateLedger(null, options);
    const input = raw as Partial<UpdateLedgerState>;
    const current = isRecord(input.current) ? normalizeRecord(input.current) : null;
    const list = Array.isArray(input.history)
      ? (input.history as unknown[]).filter(isRecord).map(normalizeRecord)
      : [];
    return new UpdateLedger({ current, history: list }, options);
  }

  toJSON(): UpdateLedgerState {
    return { current: this.state.current, history: [...this.state.history] };
  }

  get current(): UpdateRecord | null {
    return this.state.current;
  }

  get history(): UpdateRecord[] {
    return [...this.state.history];
  }

  get maxAttempts(): number {
    return this.maxBootAttempts;
  }

  /** 安装前登记。已有未落定的更新会先归档进历史，避免台账"悬空"。 */
  beginUpdate(input: {
    fromVersion: string;
    toVersion: string;
    backupPath: string | null;
    now: number;
  }): UpdateRecord {
    const { fromVersion, toVersion, backupPath, now } = input;
    const previous = this.state.current;
    if (previous !== null && previous.stage === 'pending-healthy') {
      this.pushHistory(previous);
    }
    const record: UpdateRecord = {
      toVersion,
      fromVersion,
      backupPath,
      startedAt: now,
      updatedAt: now,
      stage: 'installing',
      bootAttempts: 0,
      lastError: null,
    };
    this.state.current = record;
    return record;
  }

  /** 标记"已安装，等待下次启动确认"。 */
  markInstalled(now: number): UpdateRecord | null {
    const record = this.state.current;
    if (record === null) return null;
    record.stage = 'pending-healthy';
    record.updatedAt = now;
    return record;
  }

  /**
   * 启动时调用一次，决定本次启动是否被允许。
   *
   * 注意：`pending-healthy` 状态下**每次启动都计数**，包括正常启动——
   * 因为正常启动随后会 `markHealthy()`，计数本身不会造成误判。
   */
  recordBoot(now: number): BootDecision {
    const record = this.state.current;
    if (record === null || record.stage !== 'pending-healthy') return { decision: 'none' };

    record.bootAttempts += 1;
    record.updatedAt = now;

    if (record.bootAttempts < this.maxBootAttempts) {
      return { decision: 'allow', attempts: record.bootAttempts };
    }
    if (record.backupPath === null) {
      return { decision: 'no-backup', attempts: record.bootAttempts, toVersion: record.toVersion };
    }
    return {
      decision: 'rollback',
      attempts: record.bootAttempts,
      restoreFrom: record.backupPath,
      toVersion: record.toVersion,
      fromVersion: record.fromVersion,
    };
  }

  /** 应用到达可交互后落定（由外壳在首屏渲染完成后调用）。 */
  markHealthy(now: number): UpdateRecord | null {
    const record = this.state.current;
    if (record === null || record.stage !== 'pending-healthy') return null;
    record.stage = 'healthy';
    record.updatedAt = now;
    this.pushHistory(record);
    this.state.current = null;
    return record;
  }

  /** 回滚成功：版本回到 fromVersion，当前状态清空。 */
  markRolledBack(now: number, error: string | null = null): UpdateRecord | null {
    const record = this.state.current;
    if (record === null) return null;
    record.stage = 'rolled-back';
    record.updatedAt = now;
    record.lastError = error;
    this.pushHistory(record);
    this.state.current = null;
    return record;
  }

  /** 回滚失败：如实记成 rollback-failed，UI 必须提示用户手动重装。 */
  markRollbackFailed(now: number, error: string): UpdateRecord | null {
    const record = this.state.current;
    if (record === null) return null;
    record.stage = 'rollback-failed';
    record.updatedAt = now;
    record.lastError = error;
    this.pushHistory(record);
    this.state.current = null;
    return record;
  }

  /** 最近一次已落定的记录（healthy / rolled-back / rollback-failed）。 */
  lastSettled(): UpdateRecord | null {
    return this.state.history[0] ?? null;
  }

  private pushHistory(record: UpdateRecord): void {
    this.state.history = [record, ...this.state.history].slice(0, this.maxHistory);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/** 归一化落盘记录：缺字段补默认、非法枚举退回 idle，坏数据不炸启动。 */
function normalizeRecord(raw: Record<string, unknown>): UpdateRecord {
  const stages: UpdateStage[] = [
    'idle',
    'downloading',
    'installing',
    'pending-healthy',
    'healthy',
    'rolled-back',
    'rollback-failed',
  ];
  const stage = stages.includes(raw['stage'] as UpdateStage)
    ? (raw['stage'] as UpdateStage)
    : 'idle';
  return {
    toVersion: typeof raw['toVersion'] === 'string' ? raw['toVersion'] : '',
    fromVersion: typeof raw['fromVersion'] === 'string' ? raw['fromVersion'] : '',
    backupPath: typeof raw['backupPath'] === 'string' ? raw['backupPath'] : null,
    startedAt: typeof raw['startedAt'] === 'number' ? raw['startedAt'] : 0,
    updatedAt: typeof raw['updatedAt'] === 'number' ? raw['updatedAt'] : 0,
    stage,
    bootAttempts: typeof raw['bootAttempts'] === 'number' ? raw['bootAttempts'] : 0,
    lastError: typeof raw['lastError'] === 'string' ? raw['lastError'] : null,
  };
}
