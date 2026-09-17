/**
 * 定时本地备份——调度器（T8-04 要点 6 / FR-PKG-13，P2）。
 *
 * **在客户端内调度**（定时器 + 启动时补偿执行），绝不依赖系统任务计划程序
 * （权限与非管理员环境的坑；与 DSH 的 schtasks 黑名单教训一致）。
 *
 * 设计：
 * - 配置：`BackupScheduleConfig { enabled, frequency: 'daily'|'weekly', timeOfDay, weekday?, targetDir, keepCount }`；
 * - `computeNextRun(config, now, lastRunAt)`：daily = 明天（或今天未到）的 timeOfDay；
 *   weekly = 下一个指定 weekday 的 timeOfDay（默认周一）；
 * - 启动补偿：`catchUpIfNeeded`——若上次应跑而未跑（now ≥ nextRun(lastRunAt)），
 *   启动后立即补跑一次（错过的 12 小时内的窗口都算漏跑）；
 * - 定时器经 `TimerPort` 注入（真实环境用 setTimeout，测试用假时钟），
 *   领域层不碰 Date.now（统一 clock 注入）。
 */

export type BackupFrequency = 'daily' | 'weekly';

export interface BackupScheduleConfig {
  enabled: boolean;
  frequency: BackupFrequency;
  /** 触发时间 HH:mm（本地时区） */
  timeOfDay: string;
  /** weekly 时的目标星期（0=周日 … 6=周六；默认 1=周一） */
  weekday?: number | undefined;
  /** 快照输出目录（用户指定） */
  targetDir: string;
  /** 保留份数（超出自动清理最旧） */
  keepCount: number;
}

/** 定时器端口（测试注入假定时器） */
export interface TimerPort {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 解析 HH:mm 为当天内的毫秒偏移；非法格式抛错（配置保存时校验） */
export function parseTimeOfDay(timeOfDay: string): { hours: number; minutes: number } {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(timeOfDay);
  if (match === null) {
    throw new Error(`时间格式不合法（期望 HH:mm）：${timeOfDay}`);
  }
  return { hours: Number(match[1]), minutes: Number(match[2]) };
}

/** 在 day 上构造 timeOfDay 时刻 */
function atTimeOfDay(day: Date, timeOfDay: string): Date {
  const { hours, minutes } = parseTimeOfDay(timeOfDay);
  const result = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes, 0, 0);
  return result;
}

/**
 * 计算下一次应执行时间。
 * - daily：今天/明天的 timeOfDay 中下一个未过的；
 * - weekly：从 now 起往后找到下一个 `weekday`（默认周一）的 timeOfDay
 *   （今天就是目标星期但时间已过 → 下周同一天）。
 */
export function computeNextRun(config: BackupScheduleConfig, now: Date, _lastRunAt: number | null): Date {
  const { hours, minutes } = parseTimeOfDay(config.timeOfDay);
  void hours;
  void minutes;
  void _lastRunAt;

  if (config.frequency === 'daily') {
    const todayRun = atTimeOfDay(now, config.timeOfDay);
    if (todayRun.getTime() > now.getTime()) return todayRun;
    const tomorrow = new Date(now.getTime() + DAY_MS);
    return atTimeOfDay(tomorrow, config.timeOfDay);
  }

  const targetWeekday = config.weekday ?? 1;
  const candidate = new Date(now.getTime());
  for (let i = 0; i < 8; i += 1) {
    if (candidate.getDay() === targetWeekday) {
      const run = atTimeOfDay(candidate, config.timeOfDay);
      if (run.getTime() > now.getTime()) return run;
    }
    candidate.setDate(candidate.getDate() + 1);
  }
  // 不可达（8 天内必含目标星期）
  throw new Error('无法计算下一次备份时间');
}

/**
 * 是否已漏跑（启动补偿判据）：启用状态下，按 lastRunAt 推算的下一次时间 ≤ now
 * 即为漏跑。lastRunAt 为 null（从未备份）且创建时间晚于当天 timeOfDay 时不算漏。
 */
export function isCatchUpDue(config: BackupScheduleConfig, lastRunAt: number | null, now: Date): boolean {
  if (!config.enabled) return false;
  const next = computeNextRun(config, now, lastRunAt);
  if (lastRunAt === null) {
    // 从未备份：只有当"今天的触发点已过"才算漏（避免装机当天立即触发）
    const todayRun = atTimeOfDay(now, config.timeOfDay);
    return now.getTime() >= todayRun.getTime();
  }
  void next;
  // 以 lastRunAt 为锚：下一次应跑时间已过 = 漏跑
  const nextAfterLast = computeNextRun(config, new Date(lastRunAt), lastRunAt);
  return now.getTime() >= nextAfterLast.getTime();
}

/** 两次备份之间的最小间隔（防重复触发的去抖） */
export const MIN_BACKUP_INTERVAL_MS = 60_000;

/**
 * 备份调度器：客户端内运行，不依赖系统任务计划。
 *
 * 用法：外壳启动时 `catchUpIfNeeded()`（补偿执行）→ `start()`（排下一次）→
 * 配置变更时 `restart()`。
 */
export class BackupScheduler {
  private timerHandle: unknown = null;
  private running = false;
  private readonly optionsRef: {
    getConfig: () => BackupScheduleConfig;
    /** 实际执行备份（外壳接 export 流水线）；返回是否成功 */
    runBackup: () => Promise<boolean>;
    /** 最近一次成功备份时间（外壳持久化） */
    getLastRunAt: () => number | null;
    /** 备份成功后记录时间（外壳持久化） */
    recordRun: (at: number) => void;
    log?: ((message: string) => void) | undefined;
  };
  private clock: () => Date;
  private timer: TimerPort;

  constructor(options: {
    getConfig: () => BackupScheduleConfig;
    /** 实际执行备份（外壳接 export 流水线）；返回是否成功 */
    runBackup: () => Promise<boolean>;
    /** 最近一次成功备份时间（外壳持久化） */
    getLastRunAt: () => number | null;
    /** 备份成功后记录时间（外壳持久化） */
    recordRun: (at: number) => void;
    clock?: (() => Date) | undefined;
    timer?: TimerPort | undefined;
    /** 日志（结构化，供 UI 回显） */
    log?: ((message: string) => void) | undefined;
  }) {
    this.optionsRef = {
      getConfig: options.getConfig,
      runBackup: options.runBackup,
      getLastRunAt: options.getLastRunAt,
      recordRun: options.recordRun,
      ...(options.log !== undefined ? { log: options.log } : {}),
    };
    this.clock = options.clock ?? (() => new Date());
    this.timer = options.timer ?? {
      setTimeout: (handler, ms) => setTimeout(handler, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }

  /** 排下一次定时执行（重复调用会先清掉旧定时器） */
  start(): void {
    this.stop();
    const config = this.optionsRef.getConfig();
    if (!config.enabled) {
      this.optionsRef.log?.('定时备份未启用');
      return;
    }
    const now = this.clock();
    const lastRunAt = this.optionsRef.getLastRunAt();
    const next = computeNextRun(config, now, lastRunAt);
    const delay = Math.max(next.getTime() - now.getTime(), 1000);
    this.optionsRef.log?.(`下一次备份：${next.toLocaleString()}（${(delay / 60000).toFixed(1)} 分钟后）`);
    this.timerHandle = this.timer.setTimeout(() => {
      void this.tick();
    }, delay);
  }

  stop(): void {
    if (this.timerHandle !== null) {
      this.timer.clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
  }

  /** 到点执行：跑备份 → 记录时间 → 排下一次 */
  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const ok = await this.optionsRef.runBackup();
      if (ok) {
        this.optionsRef.recordRun(this.clock().getTime());
      }
    } finally {
      this.running = false;
      this.start();
    }
  }

  /** 启动补偿：漏跑立即补一次，然后正常排程 */
  async catchUpIfNeeded(): Promise<{ caughtUp: boolean; message: string }> {
    const config = this.optionsRef.getConfig();
    const now = this.clock();
    const lastRunAt = this.optionsRef.getLastRunAt();
    if (!isCatchUpDue(config, lastRunAt, now)) {
      return { caughtUp: false, message: '无漏跑，按计划执行' };
    }
    const ok = await this.optionsRef.runBackup();
    if (ok) {
      this.optionsRef.recordRun(now.getTime());
    }
    this.start();
    return {
      caughtUp: ok,
      message: ok ? '检测到错过的备份，已在启动时补跑' : '补跑失败（详见备份日志）',
    };
  }

  /** 手动立即备份（UI"立即备份"按钮） */
  async runNow(): Promise<boolean> {
    const ok = await this.optionsRef.runBackup();
    if (ok) {
      this.optionsRef.recordRun(this.clock().getTime());
    }
    return ok;
  }
}
