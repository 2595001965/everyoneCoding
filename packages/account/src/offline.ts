/**
 * 离线本地模式（T9-05 / FR-ACC-05 保障）。
 *
 * 语义：云端账号服务不可达时进入离线模式——**本地项目与记忆可继续使用**，
 * 登录相关入口置灰并提示"当前离线，本地功能可用"；恢复后自动尝试重新鉴权。
 */

import { OfflineError } from './auth-types';

/** 判断是否网络层失败（区别于服务端返回的业务错误） */
export function isNetworkError(error: unknown): boolean {
  if (error instanceof OfflineError) return true;
  if (error instanceof Error) {
    return (
      error.name === 'TypeError' || // fetch 在断网/不可达时抛 TypeError: Failed to fetch
      /fetch failed|network|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|socket hang up|无法解析|网络/i.test(
        error.message,
      )
    );
  }
  return false;
}

export class OfflineController {
  private offline = false;
  private readonly listeners = new Set<(offline: boolean) => void>();
  /** 服务端可达性探测（恢复后自动重试鉴权用） */
  private readonly probe?: (() => Promise<boolean>) | undefined;

  constructor(probe?: (() => Promise<boolean>) | undefined) {
    this.probe = probe;
  }

  isOffline(): boolean {
    return this.offline;
  }

  setOffline(value: boolean): void {
    if (this.offline === value) return;
    this.offline = value;
    for (const listener of this.listeners) listener(value);
  }

  onChange(listener: (offline: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 操作包装：离线直接拒绝；网络错误标记离线并转成可读的 OfflineError */
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.offline) throw new OfflineError();
    try {
      const result = await operation();
      return result;
    } catch (error: unknown) {
      if (isNetworkError(error)) {
        this.setOffline(true);
        throw new OfflineError();
      }
      throw error;
    }
  }

  /** 尝试恢复：探测可达则标记在线（供"重试"按钮与定时器调用） */
  async tryRecover(): Promise<boolean> {
    if (!this.offline) return true;
    if (!this.probe) return false;
    try {
      if (await this.probe()) {
        this.setOffline(false);
        return true;
      }
    } catch {
      /* 仍然不可达 */
    }
    return false;
  }
}
