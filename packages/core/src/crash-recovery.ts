import type { ShellHost } from '@ec/shell-api';

/**
 * 崩溃恢复（NFR-R-01：数据丢失窗口 ≤ 30s）。
 *
 * 机制：
 * - 对标记为可恢复的 store 域，每 20s 写一次快照（原子写）
 * - 快照含 `dirty` 标记：正常退出时重写为 false（或直接清除）
 * - 启动时若发现 dirty 快照，说明上次异常退出，交由 UI 询问是否恢复
 * - 丢失窗口 = 快照间隔(20s) + 写盘耗时，满足 ≤30s
 */

export const DEFAULT_SNAPSHOT_INTERVAL_MS = 20_000;
export const MAX_RECOVERY_WINDOW_MS = 30_000;

export interface SnapshotEnvelope<T = unknown> {
  domain: string;
  savedAt: number;
  /** true 表示本次会话尚未正常结束 */
  dirty: boolean;
  state: T;
}

export interface RecoverableDomain<T> {
  domain: string;
  getState: () => T;
  applyState: (state: T) => void;
}

export interface CrashRecoveryOptions {
  shell: ShellHost;
  /** 快照目录（位于数据目录下） */
  dir: string;
  intervalMs?: number;
  /** 自定义计时器，测试用 */
  schedule?: (task: () => void, intervalMs: number) => () => void;
}

export class CrashRecovery {
  private readonly shell: ShellHost;
  private readonly dir: string;
  private readonly intervalMs: number;
  private readonly scheduleFn: (task: () => void, intervalMs: number) => () => void;
  private readonly domains = new Map<string, RecoverableDomain<unknown>>();
  private stopTimer: (() => void) | null = null;

  constructor(options: CrashRecoveryOptions) {
    this.shell = options.shell;
    this.dir = options.dir;
    this.intervalMs = options.intervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
    this.scheduleFn =
      options.schedule ??
      ((task, interval) => {
        const timer = setInterval(() => task(), interval);
        return () => clearInterval(timer);
      });
    if (this.intervalMs > MAX_RECOVERY_WINDOW_MS) {
      throw new RangeError(
        `快照间隔 ${this.intervalMs}ms 超过最大恢复窗口 ${MAX_RECOVERY_WINDOW_MS}ms`,
      );
    }
  }

  register<T>(domain: RecoverableDomain<T>): void {
    this.domains.set(domain.domain, domain as RecoverableDomain<unknown>);
  }

  unregister(domain: string): void {
    this.domains.delete(domain);
  }

  private snapshotPath(domain: string): string {
    return this.shell.path.join(this.dir, `${domain}.snapshot.json`);
  }

  /** 立即为全部域写一次快照（原子写） */
  async snapshotNow(): Promise<string[]> {
    await this.shell.fs.mkdir(this.dir, { recursive: true });
    const written: string[] = [];
    for (const [name, entry] of this.domains) {
      const envelope: SnapshotEnvelope = {
        domain: name,
        savedAt: Date.now(),
        dirty: true,
        state: entry.getState(),
      };
      await this.shell.fs.writeAtomic(this.snapshotPath(name), JSON.stringify(envelope));
      written.push(name);
    }
    return written;
  }

  start(): void {
    if (this.stopTimer) return;
    this.stopTimer = this.scheduleFn(() => {
      void this.snapshotNow();
    }, this.intervalMs);
  }

  stop(): void {
    this.stopTimer?.();
    this.stopTimer = null;
  }

  /** 正常退出：把快照标记为干净（或直接清除） */
  async markClean(clear = false): Promise<void> {
    for (const name of this.domains.keys()) {
      const file = this.snapshotPath(name);
      if (clear) {
        await this.shell.fs.remove(file);
        continue;
      }
      if (!(await this.shell.fs.exists(file))) continue;
      const raw = await this.shell.fs.readText(file);
      try {
        const envelope = JSON.parse(raw) as SnapshotEnvelope;
        envelope.dirty = false;
        await this.shell.fs.writeAtomic(file, JSON.stringify(envelope));
      } catch {
        await this.shell.fs.remove(file);
      }
    }
  }

  /** 启动检测：返回所有 dirty 快照（即上次崩溃遗留） */
  async detectPending(): Promise<SnapshotEnvelope[]> {
    const pending: SnapshotEnvelope[] = [];
    if (!(await this.shell.fs.exists(this.dir))) return pending;
    const entries = await this.shell.fs.readdir(this.dir);
    for (const entry of entries) {
      if (!entry.isFile || !entry.path.endsWith('.snapshot.json')) continue;
      try {
        const envelope = JSON.parse(await this.shell.fs.readText(entry.path)) as SnapshotEnvelope;
        if (envelope.dirty) pending.push(envelope);
      } catch {
        // 损坏的快照忽略，不阻塞启动
      }
    }
    return pending;
  }

  /** 恢复指定域 */
  async restore(domain: string): Promise<boolean> {
    const entry = this.domains.get(domain);
    const file = this.snapshotPath(domain);
    if (!entry || !(await this.shell.fs.exists(file))) return false;
    const envelope = JSON.parse(await this.shell.fs.readText(file)) as SnapshotEnvelope;
    entry.applyState(envelope.state);
    return true;
  }

  /** 丢弃指定域的快照 */
  async discard(domain: string): Promise<void> {
    await this.shell.fs.remove(this.snapshotPath(domain));
  }

  /** 快照数据年龄（毫秒），用于验证恢复窗口 */
  async snapshotAge(domain: string): Promise<number | null> {
    const file = this.snapshotPath(domain);
    if (!(await this.shell.fs.exists(file))) return null;
    const envelope = JSON.parse(await this.shell.fs.readText(file)) as SnapshotEnvelope;
    return Date.now() - envelope.savedAt;
  }
}
