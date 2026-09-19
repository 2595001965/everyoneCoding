import { topoSort } from './topo-sort';

/**
 * S5 逐个生成队列（T5-06 要点 1 / FR-PIPE-09）。
 *
 * - 按 T5-05 的拓扑序串行生成；节点状态 pending|running|success|failed|skipped；
 * - 单节点失败默认不阻塞队列（可配置 failFast 失败即暂停）；
 * - 支持单节点 重试 / 跳过 / 单独回退（回退由调用方注入的 rollbackNode 实现）；
 * - 节点级进度可序列化（recovery.ts 断点续生成复用：跳过已完成节点继续执行）；
 * - 队列实时状态经 onStateChange 回调（UI 进度面板直接消费）。
 *
 * 本文件不依赖 Node IO（纯逻辑 + 注入回调），浏览器安全。
 */

export const QUEUE_NODE_STATUSES = ['pending', 'running', 'success', 'failed', 'skipped'] as const;
export type QueueNodeStatus = (typeof QUEUE_NODE_STATUSES)[number];

export interface QueueNode<T = unknown> {
  id: string;
  name: string;
  kind: 'feature' | 'page';
  /** 上游依赖节点 id */
  dependsOn: readonly string[];
  status: QueueNodeStatus;
  attempts: number;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  /** 调用方附加数据（节点上下文等） */
  data?: T | undefined;
}

export interface QueueState {
  nodes: QueueNode[];
  /** 当前正在执行的节点；空闲为 null */
  currentId: string | null;
  paused: boolean;
  /** 全部执行完毕（无 running / 无 pending 可执行） */
  finished: boolean;
  /** 本次执行的拓扑序 */
  order: string[];
  /** 汇总统计 */
  stats: {
    total: number;
    success: number;
    failed: number;
    skipped: number;
    pending: number;
    running: number;
  };
}

export interface GenerationQueueDeps<T> {
  /** 单节点执行器（契约注入等上下文由调用方在闭包里完成） */
  executor: (node: QueueNode<T>, context: { contracts: string }) => Promise<void>;
  /** 单独回退：恢复该节点生成前的状态（Git 回退或代码快照）；缺省时回退抛错 */
  rollbackNode?: ((node: QueueNode<T>) => Promise<void>) | undefined;
  /** 状态变更回调（UI 面板订阅） */
  onStateChange?: ((state: QueueState) => void) | undefined;
  /** 单节点失败是否暂停队列（默认 false：失败不阻塞） */
  failFast?: boolean | undefined;
  clock?: (() => number) | undefined;
}

export class GenerationQueue<T> {
  private readonly deps: GenerationQueueDeps<T>;
  private readonly clock: () => number;
  private executor: GenerationQueueDeps<T>['executor'];
  private nodes = new Map<string, QueueNode<T>>();
  private order: string[] = [];
  private currentId: string | null = null;
  private paused = false;
  private finished = false;
  private running = false;

  constructor(deps: GenerationQueueDeps<T>) {
    this.deps = deps;
    this.clock = deps.clock ?? (() => Date.now());
    this.executor = deps.executor;
  }

  /**
   * 运行时替换执行器（S5 编排等场景：执行器闭包依赖运行期的输入）。
   * 在 run() 之前调用有效；运行中替换立即对后续节点生效。
   */
  setExecutor(executor: GenerationQueueDeps<T>['executor']): void {
    this.executor = executor;
  }

  /** 装载节点并计算拓扑序（环存在时只执行无环部分，blocked 记录） */
  load(nodes: readonly QueueNode<T>[]): { order: string[]; blocked: string[] } {
    this.nodes.clear();
    for (const raw of nodes) {
      const node: QueueNode<T> = {
        id: raw.id,
        name: raw.name,
        kind: raw.kind,
        dependsOn: [...raw.dependsOn],
        status: raw.status,
        attempts: raw.attempts,
        error: raw.error,
        startedAt: raw.startedAt,
        finishedAt: raw.finishedAt,
        durationMs: raw.durationMs,
        ...(raw.data !== undefined ? { data: raw.data } : {}),
      };
      this.nodes.set(node.id, node);
    }
    const sorted = topoSort(
      [...this.nodes.values()].map((node) => ({ id: node.id, dependsOn: node.dependsOn })),
    );
    this.order = sorted.order;
    this.finished = false;
    return { order: [...sorted.order], blocked: [...sorted.blocked] };
  }

  state(): QueueState {
    return this.toState();
  }

  /**
   * 串行执行（断点续生成：已完成节点直接跳过）。
   * 返回终态；执行途中抛出的异常不会中断队列（单节点失败记入节点），
   * 仅当 failFast=true 且失败时返回暂停态。
   */
  async run(): Promise<QueueState> {
    if (this.running) throw new Error('队列已在运行中');
    this.running = true;
    this.paused = false;
    try {
      for (const id of this.order) {
        if (this.paused) break;
        const node = this.nodes.get(id);
        if (node === undefined) continue;
        if (node.status === 'success' || node.status === 'skipped') continue;
        if (node.status === 'failed') {
          if (this.deps.failFast !== true) continue; // 失败不阻塞：跳过，队列继续
          // failFast：首次失败即暂停；resume 后允许重试该失败节点
          if (node.attempts > 0) {
            node.status = 'pending';
            node.attempts = 0;
            node.error = null;
          }
        }
        await this.executeNode(node);
      }
    } finally {
      this.running = false;
    }
    this.finished = this.remaining() === 0 || this.paused;
    this.currentId = null;
    this.notify();
    return this.toState();
  }

  pause(): void {
    this.paused = true;
    this.notify();
  }

  resume(): void {
    this.paused = false;
    this.notify();
  }

  /** 重试指定节点（failed / success 均可；成功节点重试 = 重新生成） */
  async retry(nodeId: string): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (node === undefined) throw new Error(`未知节点：${nodeId}`);
    node.status = 'pending';
    await this.executeNode(node);
    this.finished = this.remaining() === 0;
    this.notify();
  }

  /** 跳过指定节点（pending / failed） */
  skip(nodeId: string): void {
    const node = this.nodes.get(nodeId);
    if (node === undefined) throw new Error(`未知节点：${nodeId}`);
    if (node.status === 'success') return;
    node.status = 'skipped';
    node.finishedAt = this.clock();
    this.notify();
  }

  /** 单独回退：调用方注入的 rollbackNode；回退后节点回到 pending（可重新生成） */
  async rollback(nodeId: string): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (node === undefined) throw new Error(`未知节点：${nodeId}`);
    if (this.deps.rollbackNode === undefined)
      throw new Error(`节点 ${nodeId} 的回退能力未注入（rollbackNode 缺失）`);
    await this.deps.rollbackNode(node);
    node.status = 'pending';
    node.attempts = 0;
    node.error = null;
    node.finishedAt = null;
    this.notify();
  }

  /* ------------------------------ 内部 ------------------------------ */

  private async executeNode(node: QueueNode<T>): Promise<void> {
    this.currentId = node.id;
    node.status = 'running';
    node.startedAt = this.clock();
    node.error = null;
    this.notify();

    const started = this.clock();
    try {
      // 契约块由调用方在 executor 内组装（依赖已生成的接口契约）
      await this.executor(node, { contracts: '' });
      node.status = 'success';
      node.attempts += 1;
    } catch (cause) {
      node.status = 'failed';
      node.attempts += 1;
      node.error = cause instanceof Error ? cause.message : String(cause);
      if (this.deps.failFast === true) this.paused = true;
    } finally {
      node.finishedAt = this.clock();
      node.durationMs = node.finishedAt - started;
      this.currentId = null;
      this.notify();
    }
  }

  private remaining(): number {
    let count = 0;
    for (const node of this.nodes.values()) {
      if (node.status === 'pending' || node.status === 'running' || node.status === 'failed')
        count += 1;
    }
    return count;
  }

  private toState(): QueueState {
    const list = this.order
      .map((id) => this.nodes.get(id))
      .filter((node) => node !== undefined) as QueueNode<T>[];
    const stats = {
      total: list.length,
      success: list.filter((node) => node.status === 'success').length,
      failed: list.filter((node) => node.status === 'failed').length,
      skipped: list.filter((node) => node.status === 'skipped').length,
      pending: list.filter((node) => node.status === 'pending').length,
      running: list.filter((node) => node.status === 'running').length,
    };
    return {
      nodes: list.map((node) => ({ ...node })),
      currentId: this.currentId,
      paused: this.paused,
      finished: this.finished,
      order: [...this.order],
      stats,
    };
  }

  private notify(): void {
    this.deps.onStateChange?.(this.toState());
  }
}

/* ------------------------------ 序列化（断点续生成） ------------------------------ */

export interface QueueProgressSnapshot {
  version: 1;
  nodes: Array<{ id: string; status: QueueNodeStatus; attempts: number; error: string | null }>;
}

/** 节点级进度序列化：recovery.ts 恢复时跳过已完成节点 */
export function serializeProgress(state: QueueState): QueueProgressSnapshot {
  return {
    version: 1,
    nodes: state.nodes.map((node) => ({
      id: node.id,
      status: node.status,
      attempts: node.attempts,
      error: node.error,
    })),
  };
}

export function deserializeProgress<T>(
  raw: string | null,
  fallback: readonly QueueNode<T>[],
): QueueNode<T>[] {
  if (raw === null || raw.length === 0) return fallback.map((node) => ({ ...node }));
  try {
    const parsed = JSON.parse(raw) as QueueProgressSnapshot;
    if (parsed.version !== 1 || !Array.isArray(parsed.nodes))
      return fallback.map((node) => ({ ...node }));
    const progress = new Map(parsed.nodes.map((node) => [node.id, node]));
    return fallback.map((node) => {
      const saved = progress.get(node.id);
      if (saved === undefined) return { ...node };
      return {
        ...node,
        status: saved.status,
        attempts: saved.attempts,
        error: saved.error,
        // 已完成的节点保留原时间
        ...(saved.status === 'success' || saved.status === 'skipped'
          ? { finishedAt: node.finishedAt ?? Date.now() }
          : {}),
      };
    });
  } catch {
    return fallback.map((node) => ({ ...node }));
  }
}

/** 统计展示文本（UI 面板复用） */
export function describeQueueStats(stats: QueueState['stats']): string {
  return `共 ${stats.total} 个节点：成功 ${stats.success} / 失败 ${stats.failed} / 跳过 ${stats.skipped} / 剩余 ${stats.pending + stats.running}`;
}
