import type { ShellHost } from '@ec/shell-api';
import { PathGuard } from './path-guard';

/**
 * 文件服务：所有写操作统一走「临时文件 → fsync → rename 替换」（NFR-R-02）。
 *
 * 额外保证：
 * - 路径必须先过 PathGuard，越界直接拒绝
 * - 同一文件的并发写用互斥队列串行化，避免交叉覆盖
 * - 大文件写入提供流式接口（按块累积后一次性原子替换）
 */

const TMP_SUFFIX = '.ec-tmp';

export interface WriteAtomicOptions {
  encoding?: 'utf8' | 'base64';
  /** 写入前先备份原文件（破坏性覆盖时使用） */
  backup?: boolean;
}

export interface FileServiceOptions {
  shell: ShellHost;
  /** 工作区根；提供后所有路径强制经过 PathGuard */
  guardRoot?: string;
}

export class FileService {
  private readonly shell: ShellHost;
  private readonly guard: PathGuard | null;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(options: FileServiceOptions) {
    this.shell = options.shell;
    this.guard = options.guardRoot ? new PathGuard(options.guardRoot) : null;
  }

  private safe(path: string): string {
    return this.guard ? this.guard.resolve(path) : path;
  }

  /** 串行化同一路径的写操作 */
  private withLock<T>(path: string, task: () => Promise<T>): Promise<T> {
    const key = this.safe(path);
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.locks.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  async writeAtomic(
    path: string,
    data: string | Uint8Array,
    options: WriteAtomicOptions = {},
  ): Promise<void> {
    return this.withLock(path, async () => {
      const target = this.safe(path);
      if (options.backup && (await this.shell.fs.exists(target))) {
        const backup = `${target}${TMP_SUFFIX}.bak`;
        await this.shell.fs.copy(target, backup);
      }
      await this.shell.fs.writeAtomic(target, data, {
        ...(options.encoding !== undefined ? { encoding: options.encoding } : {}),
      });
    });
  }

  /**
   * 流式写入：逐块累积后一次性原子替换。
   * 说明：底层外壳目前不提供 append，因此采用「累积 + 原子写」保证一致性；
   * 后续外壳支持 append 后可改为真正的分块落盘以降低内存占用。
   */
  async writeStream(
    path: string,
    chunks: AsyncIterable<string | Uint8Array> | Iterable<string | Uint8Array>,
  ): Promise<number> {
    const parts: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of chunks) {
      const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
      parts.push(bytes);
      total += bytes.byteLength;
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      merged.set(part, offset);
      offset += part.byteLength;
    }
    await this.writeAtomic(path, merged);
    return total;
  }

  async readText(path: string): Promise<string> {
    return this.shell.fs.readText(this.safe(path));
  }

  async readJson<T>(path: string, validate?: (value: unknown) => T): Promise<T> {
    const text = await this.readText(path);
    const parsed: unknown = JSON.parse(text);
    return validate ? validate(parsed) : (parsed as T);
  }

  async exists(path: string): Promise<boolean> {
    return this.shell.fs.exists(this.safe(path));
  }

  async remove(path: string): Promise<void> {
    return this.shell.fs.remove(this.safe(path), { recursive: true });
  }

  async list(path: string): Promise<string[]> {
    const entries = await this.shell.fs.readdir(this.safe(path));
    return entries.map((entry) => entry.path);
  }

  async copy(source: string, target: string): Promise<void> {
    await this.shell.fs.copy(this.safe(source), this.safe(target));
  }

  /** 等待当前所有排队写操作完成（退出前调用） */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.locks.values()]);
  }
}
