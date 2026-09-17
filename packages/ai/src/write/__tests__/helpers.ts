import type { WorkspaceFileSystem } from '../write-types';

/**
 * 写入管线测试夹具：内存文件系统。
 *
 * 刻意不用真实磁盘：写入管线的关键是「计划 → 冲突检测 → 事务写 → 回滚」这些**状态机**行为，
 * 用内存实现可以精确注入"第 N 次写入失败"，从而验证回滚不留中间态。
 * 真实磁盘相关的部分（外部改动检测）在 external-change-watcher.test.ts 里用真文件验证。
 */

export interface MemoryFs {
  fs: WorkspaceFileSystem;
  /** 当前磁盘内容（可直接断言） */
  files: Map<string, string>;
  /** 写入序列（含被回滚的写入） */
  writes: string[];
  snapshot(): Record<string, string>;
  /** 让指定路径的写入抛错（验证回滚） */
  failOn(path: string): void;
  clearFailure(): void;
}

export function memoryFs(initial: Record<string, string> = {}): MemoryFs {
  const files = new Map<string, string>(Object.entries(initial));
  const writes: string[] = [];
  let failing: string | null = null;

  const fs: WorkspaceFileSystem = {
    readText: async (path) => files.get(path) ?? null,
    writeAtomic: async (path, content) => {
      writes.push(path);
      if (failing === path) throw new Error(`模拟磁盘写入失败：${path}`);
      files.set(path, content);
    },
    exists: async (path) => files.has(path),
    remove: async (path) => {
      writes.push(`rm:${path}`);
      if (failing === path) throw new Error(`模拟删除失败：${path}`);
      files.delete(path);
    },
    stat: async (path) => {
      const content = files.get(path);
      return content === undefined ? null : { size: content.length, mtimeMs: 0 };
    },
  };

  return {
    fs,
    files,
    writes,
    snapshot: () => Object.fromEntries(files),
    failOn: (path: string) => {
      failing = path;
    },
    clearFailure: () => {
      failing = null;
    },
  };
}

/** 构造一个 unified diff（old 内容行数需与磁盘一致） */
export function unifiedDiff(input: { oldStart: number; oldLines: string[]; newLines: string[] }): string {
  const body = [
    ...input.oldLines.filter((line) => !input.newLines.includes(line)).map((line) => `-${line}`),
    ...input.newLines.filter((line) => !input.oldLines.includes(line)).map((line) => `+${line}`),
  ];
  return [
    `--- a/file`,
    `+++ b/file`,
    `@@ -${input.oldStart},${input.oldLines.length} +${input.oldStart},${input.newLines.length} @@`,
    ...body,
  ].join('\n');
}
