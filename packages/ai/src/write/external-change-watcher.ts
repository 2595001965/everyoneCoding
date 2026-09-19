/**
 * 外部改动检测（T4-05 要点 3）。
 *
 * 背景：本项目的代码只能由 AI 写入（D-04），但工程目录就在用户磁盘上，
 * 用户完全可以用 VS Code 改文件。系统必须**检测到并明确提示**，
 * 而不是假装没发生 —— 否则下一次 AI 写入会基于过期的上下文把改动覆盖掉。
 *
 * 设计要点：
 * 1. **排除构建产物与版本库**：`.git`、`node_modules`、`dist`、`target` 等一律忽略，
 *    否则一次构建能刷出上千条"外部修改"；
 * 2. **抑制自身写入回响**：AI 写入路径调用 `suppress(path)`，在抑制窗口内的事件不上报
 *    （文件监听器会把自己刚写的文件也报成 modify）；
 * 3. **事件聚合**：同一路径在窗口内多次变更合并为一条（编辑器保存常常触发多帧）。
 */

export interface WatchHandleLike {
  close(): Promise<void>;
}

/** 关闭监听的等待上限（毫秒） */
export const CLOSE_TIMEOUT_MS = 2_000;

export interface FsWatchEventLike {
  type: 'create' | 'modify' | 'remove';
  path: string;
}

export interface ExternalChangeWatcherDeps {
  /** 外壳的文件监听（生产适配 shell-api `fs.watch`） */
  watch(path: string, listener: (event: FsWatchEventLike) => void): Promise<WatchHandleLike>;
  /** 自定义排除规则（与默认规则取并集） */
  ignorePatterns?: readonly string[] | undefined;
  clock?: (() => number) | undefined;
  /** AI 自身写入的抑制窗口（毫秒），默认 1500 */
  suppressWindowMs?: number | undefined;
  /** 同一路径的事件合并窗口（毫秒），默认 300 */
  coalesceWindowMs?: number | undefined;
}

export interface ExternalChange {
  path: string;
  type: FsWatchEventLike['type'];
  detectedAt: number;
  /** 是否已被合并（同路径的后续事件） */
  count: number;
}

/** 默认排除规则（目录名或路径片段命中即忽略） */ export const DEFAULT_IGNORE_PATTERNS: readonly string[] =
  [
    '.git',
    '.hg',
    '.svn',
    'node_modules',
    'dist',
    'build',
    'out',
    'target',
    'coverage',
    '.next',
    '.nuxt',
    '.vite',
    '.vitest',
    '.cache',
    '.ec-tmp',
    '.idea',
    '.vscode',
    '.DS_Store',
  ];

/** 路径是否需要忽略（大小写不敏感；面板分隔符统一成正斜杠） */
export function shouldIgnorePath(
  path: string,
  patterns: readonly string[] = DEFAULT_IGNORE_PATTERNS,
): boolean {
  const normalised = path.replace(/\\/g, '/');
  const segments = normalised.split('/').filter((segment) => segment.length > 0);
  return patterns.some((pattern) => {
    if (pattern.includes('/')) return normalised.includes(pattern);
    return segments.includes(pattern);
  });
}

export class ExternalChangeWatcher {
  private readonly deps: ExternalChangeWatcherDeps;
  private readonly clock: () => number;
  private readonly suppressWindowMs: number;
  private readonly coalesceWindowMs: number;
  private readonly ignored: readonly string[];
  private handle: WatchHandleLike | null = null;
  private readonly suppressed = new Map<string, number>();
  private readonly listeners = new Set<(change: ExternalChange) => void>();
  private readonly log: ExternalChange[] = [];
  private stopped = false;

  constructor(deps: ExternalChangeWatcherDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? (() => Date.now());
    this.suppressWindowMs = deps.suppressWindowMs ?? 1_500;
    this.coalesceWindowMs = deps.coalesceWindowMs ?? 300;
    this.ignored = [...DEFAULT_IGNORE_PATTERNS, ...(deps.ignorePatterns ?? [])];
  }

  /** 开始监听工程根目录 */
  async start(root: string): Promise<void> {
    await this.stop();
    this.stopped = false;
    this.handle = await this.deps.watch(root, (event) => this.handleEvent(event));
  }

  async stop(): Promise<void> {
    const handle = this.handle;
    this.handle = null;
    if (handle === null) return;
    // 兜底：某些平台/实现下 close 的回调不触发，不能让应用退出流程被挂住
    await Promise.race([
      handle.close(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, CLOSE_TIMEOUT_MS);
      }),
    ]);
  }

  /** 由 AI 写入路径调用：在抑制窗口内忽略该文件的事件（避免把自己写入当成外部改动） */
  suppress(path: string): void {
    this.suppressed.set(normalise(path), this.clock() + this.suppressWindowMs);
  }

  isSuppressed(path: string): boolean {
    const key = normalise(path);
    const until = this.suppressed.get(key);
    if (until === undefined) return false;
    if (until < this.clock()) {
      this.suppressed.delete(key);
      return false;
    }
    return true;
  }

  onDetected(listener: (change: ExternalChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 已检测到的外部改动（时间升序） */
  changes(): ExternalChange[] {
    return this.log.map((change) => ({ ...change }));
  }

  /** 取走并清空（UI 消费后再显示，避免重复弹窗） */
  drain(): ExternalChange[] {
    const drained = this.changes();
    this.log.length = 0;
    return drained;
  }

  /** 提示语（任务卡给定口径） */
  static describe(change: ExternalChange | null): string {
    if (change === null) return '';
    return `代码已被外部修改（${change.path}），建议回滚到最近提交或让 AI 重新生成。`;
  }

  static actions(): { key: 'rollback' | 'regenerate'; label: string }[] {
    return [
      { key: 'rollback', label: '回滚到最近提交' },
      { key: 'regenerate', label: '让 AI 重新生成' },
    ];
  }

  private handleEvent(event: FsWatchEventLike): void {
    if (this.stopped) return;
    const path = normalise(event.path);
    if (shouldIgnorePath(path, this.ignored)) return;
    if (this.isSuppressed(path)) return;

    const now = this.clock();
    const existing = [...this.log].reverse().find((change) => change.path === path);
    if (existing !== undefined && now - existing.detectedAt <= this.coalesceWindowMs) {
      existing.count += 1;
      return;
    }

    const change: ExternalChange = { path, type: event.type, detectedAt: now, count: 1 };
    this.log.push(change);
    for (const listener of this.listeners) listener({ ...change });
  }
}

function normalise(path: string): string {
  return path.replace(/\\/g, '/');
}

export function createExternalChangeWatcher(
  deps: ExternalChangeWatcherDeps,
): ExternalChangeWatcher {
  return new ExternalChangeWatcher(deps);
}
