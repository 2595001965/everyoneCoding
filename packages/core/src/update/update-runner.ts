/**
 * 更新编排（T10-04 / FR-SET-05）：把「静默检查 → 发现新版本 → 下载安装 → 重启应用 /
 * 稍后提醒 → 失败回滚」串成一条可测的流程。
 *
 * 为什么放在 core 而不是两个外壳各写一遍：
 * - 双形态（D-01）必须行为等价，编排逻辑共用才不会漂移；
 * - 外壳只提供"能力端口"（更新 API、时钟、在线状态、备份/还原、状态持久化），
 *   于是**整条流程可以在测试里用内存假端口跑通**，不需要真实安装包。
 *
 * 明确的边界：真实的"替换安装目录"由外壳完成（Tauri NSIS / electron-updater），
 * core 负责**何时做、做失败了怎么办**。
 */

import type { UpdateErrorKind, UpdateInfo, UpdateProgress, UpdaterApi } from '@ec/shell-api';

import {
  DEFAULT_UPDATE_SETTINGS,
  EMPTY_REMINDER,
  clearReminder,
  decideAction,
  decideCheck,
  snooze,
  type ReminderState,
  type UpdateSettings,
} from './update-policy';
import {
  UpdateLedger,
  type BootDecision,
  type UpdateLedgerState,
  type UpdateRecord,
} from './update-ledger';
import { isNewerVersion } from './update-types';
import { classifyUpdateError } from './update-errors';

/** 版本号非法时当作"没有更新"，而不是让更新检查抛错打断启动。 */
function isNewerSafe(candidate: string | undefined, current: string): boolean {
  if (candidate === undefined) return false;
  try {
    return isNewerVersion(candidate, current);
  } catch {
    return false;
  }
}

/** 需要跨会话保留的运行时状态（外壳负责落盘，core 不碰 IO）。 */
export interface UpdateRuntimeState {
  /** 上次检查更新的时间戳 */
  lastCheckAt: number | null;
  /** 延迟提醒状态 */
  reminder: ReminderState;
  /** 回滚台账 */
  ledger: UpdateLedgerState;
}

export const INITIAL_UPDATE_RUNTIME: UpdateRuntimeState = {
  lastCheckAt: null,
  reminder: { ...EMPTY_REMINDER },
  ledger: { current: null, history: [] },
};

/** 外壳必须提供的能力（全部为异步，便于 Electron/Tauri 走 IPC）。 */
export interface UpdatePorts {
  /** shell-api 的更新契约（check / downloadAndInstall / onProgress）；不支持时为 null */
  updater: UpdaterApi | null;
  now(): number;
  /** 是否在线；离线时静默跳过检查，不阻塞启动 */
  isOnline(): boolean;
  /**
   * 备份当前已安装版本，返回备份路径；外壳不支持备份时返回 null
   * （此时台账判定为 no-backup，如实上报"无法自动回滚"，不假装成功）。
   */
  backupCurrentVersion(fromVersion: string): Promise<string | null>;
  /** 还原到备份（回滚） */
  restoreBackup(backupPath: string): Promise<void>;
  loadRuntime(): Promise<UpdateRuntimeState | null>;
  saveRuntime(state: UpdateRuntimeState): Promise<void>;
  /** 读取当前应用版本（用于"是否比当前新"判定） */
  currentVersion(): Promise<string>;
}

export type UpdateFlowEvent =
  | { type: 'check-skipped'; reason: string }
  | { type: 'check-failed'; kind: UpdateErrorKind; error: string; detail: string }
  | { type: 'check-done'; info: UpdateInfo | null }
  | { type: 'remind'; version: string; notes?: string }
  | { type: 'defer'; version: string; until: number }
  | { type: 'install-started'; version: string }
  /** 更新包已下载并通过校验（sha512 / minisign），等待重启应用 */
  | { type: 'download-ready'; version: string }
  /** 台账已落盘，即将交给安装器并重启 */
  | { type: 'install-applied'; version: string; backupPath: string | null }
  | {
      type: 'install-failed';
      version: string;
      error: string;
      kind?: UpdateErrorKind;
      detail?: string;
    }
  /** 上一轮收尾核对：重启后仍是旧版本，更新没生效 */
  | { type: 'install-not-applied'; version: string; error: string }
  | { type: 'health-marked'; version: string }
  | { type: 'rollback-needed'; restoreFrom: string; toVersion: string; fromVersion: string }
  | { type: 'rollback-done'; toVersion: string }
  | { type: 'rollback-failed'; toVersion: string; error: string }
  | { type: 'rollback-unavailable'; toVersion: string };

export interface UpdateServiceOptions {
  ports: UpdatePorts;
  settings?: UpdateSettings;
  /** 启动尝试上限，透传台账（默认 2） */
  maxBootAttempts?: number;
  onProgress?: (progress: UpdateProgress) => void;
  onEvent?: (event: UpdateFlowEvent) => void;
}

export class UpdateService {
  private readonly ports: UpdatePorts;
  private readonly onProgress: ((progress: UpdateProgress) => void) | undefined;
  private readonly onEvent: ((event: UpdateFlowEvent) => void) | undefined;
  private readonly maxBootAttempts: number | undefined;
  private settings: UpdateSettings;
  private runtime: UpdateRuntimeState = { ...INITIAL_UPDATE_RUNTIME };
  /** 台账实例在整个会话内唯一——每次从 runtime 重建会让"改了却没写回"变成静默 bug。 */
  private ledgerInstance: UpdateLedger = new UpdateLedger();
  private readonly eventListeners = new Set<(event: UpdateFlowEvent) => void>();
  private readonly progressListeners = new Set<(progress: UpdateProgress) => void>();
  private availableInfoValue: UpdateInfo | null = null;
  /** 已下载并校验、等待重启的版本（会话内有效；重启后以台账为准） */
  private readyVersionValue: string | null = null;
  private ready = false;

  constructor(options: UpdateServiceOptions) {
    this.ports = options.ports;
    this.settings = options.settings ?? { ...DEFAULT_UPDATE_SETTINGS };
    this.maxBootAttempts = options.maxBootAttempts;
    this.onProgress = options.onProgress;
    this.onEvent = options.onEvent;
  }

  /** 订阅流程事件（UI 层据此刷新阶段 / 进度 / 提示）。返回取消函数。 */
  subscribeEvents(listener: (event: UpdateFlowEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** 订阅外壳下载进度（百分比 / 差分信息）。返回取消函数。 */
  subscribeProgress(listener: (progress: UpdateProgress) => void): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  /** 读取持久化状态（幂等；重复调用只加载一次）。 */
  async init(): Promise<void> {
    if (this.ready) return;
    const loaded = normalizeRuntime(await this.ports.loadRuntime());
    this.runtime = loaded;
    this.ledgerInstance = UpdateLedger.fromJSON(
      loaded.ledger,
      this.maxBootAttempts === undefined ? {} : { maxBootAttempts: this.maxBootAttempts },
    );
    this.ready = true;
  }

  get currentRecord(): UpdateRecord | null {
    return this.ledgerInstance.current;
  }

  /** 最近一次已落定的更新记录（healthy / rolled-back / rollback-failed）。 */
  get lastSettled(): UpdateRecord | null {
    return this.ledgerInstance.lastSettled();
  }

  get reminder(): ReminderState {
    return this.runtime.reminder;
  }

  /** 当前更新偏好（面板展示用）。 */
  getSettings(): UpdateSettings {
    return { ...this.settings };
  }

  /** 最近一次检查发现的可用更新（未发现时为 null）。 */
  get availableInfo(): UpdateInfo | null {
    return this.availableInfoValue;
  }

  /** 已下载就绪、等待重启的版本（null = 没有）。 */
  get readyVersion(): string | null {
    return this.readyVersionValue;
  }

  /** 导出当前运行时状态快照（只读用途：面板展示"上次检查时间"等）。 */
  async exportRuntime(): Promise<UpdateRuntimeState> {
    await this.init();
    return JSON.parse(JSON.stringify(this.runtime)) as UpdateRuntimeState;
  }

  /** 更新设置（用户在设置页改了自动检查 / 渠道等）。 */
  setSettings(settings: UpdateSettings): void {
    this.settings = settings;
  }

  /**
   * 启动时执行：先按台账判定是否需要回滚，再做一次静默检查。
   *
   * **必须在业务初始化之前调用**——崩溃循环场景下，业务初始化本身就是会崩的那一步。
   */
  async bootstrap(options: { skipCheck?: boolean } = {}): Promise<BootDecision> {
    await this.init();
    await this.reconcile();
    const decision = await this.recordBoot();
    if (decision.decision === 'rollback') {
      await this.performRollback(decision);
      return decision;
    }
    if (decision.decision === 'no-backup') {
      this.emit({ type: 'rollback-unavailable', toVersion: decision.toVersion });
      return decision;
    }
    // skipCheck：外壳先拿回滚判定、渲染完首屏再发起网络检查（启动不被网络阻塞）
    if (options.skipCheck !== true) await this.checkNow(false);
    return decision;
  }

  /**
   * 按实际运行版本核对上一轮收尾（安装是否生效、回滚是否落定）。
   * 安装器与回滚安装包都会结束当前进程，所以"成功与否"只能由下一次启动来判定。
   */
  async reconcile(): Promise<void> {
    await this.init();
    const running = await this.ports.currentVersion();
    const settled = this.ledgerInstance.reconcileBoot(running, this.ports.now());
    if (settled === null) return;
    await this.persist();
    if (settled.stage === 'install-failed') {
      this.emit({
        type: 'install-not-applied',
        version: settled.toVersion,
        error: settled.lastError ?? '',
      });
    } else if (settled.stage === 'rolled-back') {
      this.emit({ type: 'rollback-done', toVersion: settled.fromVersion });
    } else if (settled.stage === 'rollback-failed') {
      this.emit({
        type: 'rollback-failed',
        toVersion: settled.fromVersion,
        error: settled.lastError ?? '',
      });
    }
  }

  /** 启动计数 + 回滚判定（单独暴露，便于"只想知道该不该回滚"的场景）。 */
  async recordBoot(): Promise<BootDecision> {
    await this.init();
    const decision = this.ledgerInstance.recordBoot(this.ports.now());
    if (decision.decision === 'rollback') {
      this.emit({
        type: 'rollback-needed',
        restoreFrom: decision.restoreFrom,
        toVersion: decision.toVersion,
        fromVersion: decision.fromVersion,
      });
    }
    await this.persist();
    return decision;
  }

  /**
   * 检查更新。
   * @param manual 用户手动点"检查更新"：忽略间隔与自动检查开关，但仍要求在线。
   */
  async checkNow(manual: boolean): Promise<UpdateInfo | null> {
    await this.init();
    const now = this.ports.now();
    if (!manual) {
      const decision = decideCheck({
        settings: this.settings,
        lastCheckAt: this.runtime.lastCheckAt,
        now,
        online: this.ports.isOnline(),
      });
      if (!decision.shouldCheck) {
        this.emit({ type: 'check-skipped', reason: decision.reason });
        return null;
      }
    } else if (!this.ports.isOnline()) {
      this.emit({ type: 'check-skipped', reason: 'offline' });
      return null;
    }

    let info: UpdateInfo | null;
    try {
      info = (await this.ports.updater?.check()) ?? null;
    } catch (cause: unknown) {
      // 网络失败 / 清单异常都不能打断启动，也不能吞掉：归类后如实上报
      const classified = classifyUpdateError(cause);
      this.emit({
        type: 'check-failed',
        kind: classified.kind,
        error: classified.summary,
        detail: classified.detail,
      });
      return null;
    }
    this.runtime.lastCheckAt = now;
    this.availableInfoValue = isNewerSafe(info?.version, await this.ports.currentVersion())
      ? info
      : null;
    await this.persist();
    this.emit({ type: 'check-done', info });
    if (info === null) return null;

    const currentVersion = await this.ports.currentVersion();
    const action = decideAction({
      currentVersion,
      info,
      reminder: this.runtime.reminder,
      settings: this.settings,
      now,
    });
    if (action.action === 'remind') {
      this.emit({
        type: 'remind',
        version: action.version,
        ...(action.notes !== undefined ? { notes: action.notes } : {}),
      });
    } else if (action.action === 'defer') {
      this.emit({ type: 'defer', version: action.version, until: action.until });
    } else if (action.action === 'silent-install') {
      // 自动下载只做到"下载并校验"：重启时机交给用户，绝不在用户工作时强行重启
      await this.download();
    }
    return info;
  }

  /** 用户点"稍后提醒"。 */
  async deferVersion(version: string, snoozeMs?: number): Promise<void> {
    await this.init();
    const now = this.ports.now();
    this.runtime.reminder =
      snoozeMs === undefined
        ? snooze(this.runtime.reminder, version, now)
        : snooze(this.runtime.reminder, version, now, snoozeMs);
    await this.persist();
    this.emit({ type: 'defer', version, until: this.runtime.reminder.deferredUntil ?? now });
  }

  /**
   * 下载并校验更新包（不安装）。失败时**台账不动**——当前版本完好，没有什么需要回滚。
   */
  async download(): Promise<boolean> {
    await this.init();
    const updater = this.ports.updater;
    if (updater === null) {
      this.emit({
        type: 'install-failed',
        version: '',
        error: '当前外壳不支持自动更新',
        kind: 'not-configured',
      });
      return false;
    }
    if (!this.ports.isOnline()) {
      const classified = classifyUpdateError('UPDATE_OFFLINE: 系统报告当前离线');
      this.emit({
        type: 'install-failed',
        version: this.availableInfoValue?.version ?? '',
        error: classified.summary,
        kind: 'offline',
        detail: classified.detail,
      });
      return false;
    }

    const unsubscribe = updater.onProgress((progress) => {
      this.onProgress?.(progress);
      for (const listener of this.progressListeners) listener(progress);
    });
    let version = this.availableInfoValue?.version ?? '';
    try {
      const info = await updater.check();
      if (info === null) {
        this.emit({ type: 'install-failed', version: '', error: '没有可用更新' });
        return false;
      }
      version = info.version;
      this.emit({ type: 'install-started', version });
      const ready = await updater.download();
      if (ready === null) {
        this.emit({ type: 'install-failed', version, error: '没有可用更新' });
        return false;
      }
      version = ready.version;
    } catch (cause: unknown) {
      const classified = classifyUpdateError(cause);
      this.readyVersionValue = null;
      this.emit({
        type: 'install-failed',
        version,
        error: classified.summary,
        kind: classified.kind,
        detail: classified.detail,
      });
      return false;
    } finally {
      unsubscribe();
    }

    this.readyVersionValue = version;
    this.emit({ type: 'download-ready', version });
    return true;
  }

  /**
   * 应用已下载的更新并重启。
   *
   * 顺序不可调换：**先定位留档** → **登记 pending-healthy 并落盘** → **交给安装器**。
   * 安装器会结束当前进程，落盘必须发生在它之前，否则新版本启动失败时台账里什么都没有，
   * 回滚无从谈起。安装器没能启动时把台账改记 install-failed，当前版本照常可用。
   */
  async applyAndRestart(): Promise<boolean> {
    await this.init();
    const updater = this.ports.updater;
    const version = this.readyVersionValue;
    if (updater === null || version === null) {
      this.emit({
        type: 'install-failed',
        version: version ?? '',
        error: '没有已下载的更新，请先下载',
      });
      return false;
    }

    const currentVersion = await this.ports.currentVersion();
    let backupPath: string | null;
    try {
      backupPath = await this.ports.backupCurrentVersion(currentVersion);
    } catch {
      // 找不到留档不阻止更新：台账如实记 backupPath=null，崩溃时上报"无法自动回滚"
      backupPath = null;
    }
    this.ledgerInstance.beginUpdate({
      fromVersion: currentVersion,
      toVersion: version,
      backupPath,
      now: this.ports.now(),
    });
    this.ledgerInstance.markInstalled(this.ports.now());
    this.runtime.reminder = clearReminder();
    await this.persist();
    this.emit({ type: 'install-applied', version, backupPath });

    try {
      await updater.installAndRestart();
    } catch (cause: unknown) {
      const classified = classifyUpdateError(cause);
      this.ledgerInstance.markInstallFailed(this.ports.now(), classified.detail);
      await this.persist();
      this.emit({
        type: 'install-failed',
        version,
        error: classified.kind === 'unknown' ? '安装器启动失败' : classified.summary,
        kind: classified.kind === 'unknown' ? 'install' : classified.kind,
        detail: classified.detail,
      });
      return false;
    }
    return true;
  }

  /** 一步到位："立即更新" = 下载校验 + 应用并重启。 */
  async install(): Promise<boolean> {
    if (!(await this.download())) return false;
    return this.applyAndRestart();
  }

  /** 应用到达可交互后调用：落定本次更新，避免下次启动被误判为崩溃。 */
  async markHealthy(): Promise<void> {
    await this.init();
    const record = this.ledgerInstance.markHealthy(this.ports.now());
    await this.persist();
    if (record !== null) this.emit({ type: 'health-marked', version: record.toVersion });
  }

  private async performRollback(decision: {
    restoreFrom: string;
    toVersion: string;
    fromVersion: string;
  }): Promise<void> {
    // 回滚安装包会结束当前进程：先把"回滚中"落盘，结果由下次启动按实际版本核对
    this.ledgerInstance.markRollingBack(this.ports.now());
    await this.persist();
    try {
      await this.ports.restoreBackup(decision.restoreFrom);
    } catch (cause: unknown) {
      const error = cause instanceof Error ? cause.message : String(cause);
      this.ledgerInstance.markRollbackFailed(this.ports.now(), error);
      await this.persist();
      this.emit({ type: 'rollback-failed', toVersion: decision.fromVersion, error });
    }
  }

  /** 把内存中的台账快照写回 runtime，再交给外壳落盘。 */
  private async persist(): Promise<void> {
    this.runtime.ledger = this.ledgerInstance.toJSON();
    await this.ports.saveRuntime(this.runtime);
  }

  private emit(event: UpdateFlowEvent): void {
    this.onEvent?.(event);
    for (const listener of this.eventListeners) listener(event);
  }
}

/** 落盘数据归一化：坏数据降级为空状态，绝不阻塞启动（NFR-U-02）。 */
function normalizeRuntime(raw: UpdateRuntimeState | null): UpdateRuntimeState {
  if (raw === null || typeof raw !== 'object') return { ...INITIAL_UPDATE_RUNTIME };
  const reminder = raw.reminder;
  return {
    lastCheckAt: typeof raw.lastCheckAt === 'number' ? raw.lastCheckAt : null,
    reminder:
      reminder !== null && typeof reminder === 'object'
        ? {
            deferredVersion:
              typeof reminder.deferredVersion === 'string' ? reminder.deferredVersion : null,
            deferredUntil:
              typeof reminder.deferredUntil === 'number' ? reminder.deferredUntil : null,
            snoozeCount: typeof reminder.snoozeCount === 'number' ? reminder.snoozeCount : 0,
          }
        : { ...EMPTY_REMINDER },
    ledger: raw.ledger ?? { current: null, history: [] },
  };
}
