/**
 * 按 Provider 限流（FR-MDL-12）。
 *
 * 两个维度：
 * - 并发上限：同时进行的请求数
 * - QPS：1 秒滑动窗口内允许启动的请求数
 *
 * 超限请求**排队**而不是丢弃，并通过事件暴露队列位次，UI 可展示"第 N 位"。
 */

export interface ProviderLimits {
  /** 每秒请求数上限；0 或负数表示不限 */
  qps: number;
  /** 并发上限；0 或负数表示不限 */
  concurrency: number;
}

export const UNLIMITED: ProviderLimits = { qps: 0, concurrency: 0 };

export interface QueueRelease {
  (): void;
}

export type QueueEvent =
  | { type: 'enqueued'; providerId: string; position: number; waiting: number }
  | { type: 'started'; providerId: string; waiting: number; running: number }
  | { type: 'released'; providerId: string; running: number };

interface QueueWaiter {
  resolve: (value: QueueRelease) => void;
  reject: (reason?: unknown) => void;
}

interface QueueEntry {
  ticket: symbol;
  resolve: (value: QueueRelease) => void;
  reject: (reason?: unknown) => void;
  waiters: QueueWaiter[];
  timer: NodeJS.Timeout | null;
  settled: boolean;
  abortCleanup: (() => void) | null;
}

interface ProviderState {
  limits: ProviderLimits;
  running: number;
  waiting: QueueEntry[];
  recentStarts: number[];
}

const WINDOW_MS = 1000;

function abortError(): Error {
  const error = new Error('请求已中断');
  error.name = 'AbortError';
  return error;
}

export class RequestQueue {
  private readonly states = new Map<string, ProviderState>();
  private readonly listeners = new Set<(event: QueueEvent) => void>();
  private readonly activeTickets = new Map<symbol, QueueRelease>();

  configure(providerId: string, limits: Partial<ProviderLimits>): void {
    const state = this.ensure(providerId);
    state.limits = {
      qps: limits.qps ?? state.limits.qps,
      concurrency: limits.concurrency ?? state.limits.concurrency,
    };
    this.pump(providerId);
  }

  limitsOf(providerId: string): ProviderLimits {
    return { ...this.ensure(providerId).limits };
  }

  /** 当前排队人数 */
  waiting(providerId: string): number {
    return this.ensure(providerId).waiting.length;
  }

  running(providerId: string): number {
    return this.ensure(providerId).running;
  }

  /** 某个请求在队列中的位置（1 起；0 表示未排队） */
  positionOf(providerId: string, ticket: symbol): number {
    const state = this.ensure(providerId);
    const index = state.waiting.findIndex((entry) => entry.ticket === ticket);
    return index < 0 ? 0 : index + 1;
  }

  /** 获取一个执行槽位；超限则排队等待 */
  acquire(
    providerId: string,
    ticket: symbol = Symbol('queue'),
    signal?: AbortSignal,
  ): Promise<QueueRelease> {
    const state = this.ensure(providerId);
    const existing = this.activeTickets.get(ticket);
    if (existing) return Promise.resolve(existing);
    const queued = state.waiting.find((entry) => entry.ticket === ticket);
    if (queued) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(abortError());
          return;
        }
        const waiter: QueueWaiter = { resolve, reject };
        queued.waiters.push(waiter);
        const onAbort = (): void => {
          const index = queued.waiters.indexOf(waiter);
          if (index >= 0) queued.waiters.splice(index, 1);
          reject(abortError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    return new Promise<QueueRelease>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const entry: QueueEntry = {
        ticket,
        resolve,
        reject,
        waiters: [],
        timer: null,
        settled: false,
        abortCleanup: null,
      };
      if (signal) {
        const onAbort = (): void => {
          if (entry.settled) return;
          const index = state.waiting.indexOf(entry);
          if (index >= 0) state.waiting.splice(index, 1);
          entry.settled = true;
          entry.abortCleanup = null;
          if (entry.timer) clearTimeout(entry.timer);
          reject(abortError());
          this.pump(providerId);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        entry.abortCleanup = () => signal.removeEventListener('abort', onAbort);
      }
      state.waiting.push(entry);
      this.emit({
        type: 'enqueued',
        providerId,
        position: state.waiting.length,
        waiting: state.waiting.length,
      });
      this.pump(providerId);
    });
  }

  onEvent(listener: (event: QueueEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 清空排队（应用退出 / Provider 删除） */
  clear(providerId?: string): void {
    if (providerId === undefined) {
      for (const id of [...this.states.keys()]) this.clear(id);
      return;
    }
    const state = this.states.get(providerId);
    if (!state) return;
    for (const entry of state.waiting) {
      if (entry.timer) clearTimeout(entry.timer);
      // 放弃排队的请求：给一个空释放，调用方应立即检查中断状态
      entry.settled = true;
      entry.abortCleanup?.();
      entry.abortCleanup = null;
      entry.reject(abortError());
      for (const waiter of entry.waiters) waiter.reject(abortError());
    }
    state.waiting = [];
  }

  private ensure(providerId: string): ProviderState {
    const existing = this.states.get(providerId);
    if (existing) return existing;
    const created: ProviderState = {
      limits: { ...UNLIMITED },
      running: 0,
      waiting: [],
      recentStarts: [],
    };
    this.states.set(providerId, created);
    return created;
  }

  private canStart(state: ProviderState): boolean {
    if (state.limits.concurrency > 0 && state.running >= state.limits.concurrency) return false;
    if (state.limits.qps > 0) {
      const now = Date.now();
      state.recentStarts = state.recentStarts.filter((time) => now - time < WINDOW_MS);
      if (state.recentStarts.length >= state.limits.qps) return false;
    }
    return true;
  }

  private nextDelay(state: ProviderState): number {
    if (state.limits.qps > 0 && state.recentStarts.length >= state.limits.qps) {
      const oldest = state.recentStarts[0];
      return oldest === undefined ? 0 : Math.max(1, WINDOW_MS - (Date.now() - oldest));
    }
    return 0;
  }

  private pump(providerId: string): void {
    const state = this.ensure(providerId);
    while (state.waiting.length > 0 && this.canStart(state)) {
      const entry = state.waiting.shift();
      if (!entry) break;
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      const release = this.makeRelease(providerId, entry.ticket);
      this.activeTickets.set(entry.ticket, release);
      state.running += 1;
      state.recentStarts.push(Date.now());
      entry.settled = true;
      entry.abortCleanup?.();
      entry.abortCleanup = null;
      this.emit({
        type: 'started',
        providerId,
        waiting: state.waiting.length,
        running: state.running,
      });
      entry.resolve(release);
      for (const waiter of entry.waiters) waiter.resolve(release);
    }

    if (state.waiting.length > 0 && state.limits.qps > 0) {
      const head = state.waiting[0];
      if (head && head.timer === null) {
        const delay = this.nextDelay(state);
        head.timer = setTimeout(() => {
          head.timer = null;
          this.pump(providerId);
        }, delay);
        head.timer.unref?.();
      }
    }
  }

  private release(providerId: string): void {
    const state = this.ensure(providerId);
    state.running = Math.max(0, state.running - 1);
    this.emit({ type: 'released', providerId, running: state.running });
    this.pump(providerId);
  }

  private makeRelease(providerId: string, ticket: symbol): QueueRelease {
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      this.activeTickets.delete(ticket);
      this.release(providerId);
    };
  }

  private emit(event: QueueEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
