import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { WorkspaceFileSystem } from '@ec/ai';
import { createProjectPaths } from './paths';

/** D07：文件安全与原子替换复用宿主路径守卫，CAS 的读/替换之间没有 await。 */
export function taskFileSystem(
  root: string,
  owner?: { write<T>(action: () => T): T },
): WorkspaceFileSystem {
  const paths = createProjectPaths({ projectsDir: root });
  const full = (path: string): string => paths.inside(root, path);
  const read = (path: string): string | null => {
    const target = full(path);
    return existsSync(target) ? readFileSync(target, 'utf8') : null;
  };
  const swapUnlocked = (path: string, before: string | null, after: string | null): boolean => {
    const target = full(path);
    if (read(path) !== before) return false;
    if (after === null) {
      if (existsSync(target)) rmSync(target);
      return true;
    }
    const tmp = `${target}.ec-tmp-${randomUUID()}`;
    mkdirSync(dirname(target), { recursive: true });
    try {
      durableWrite(tmp, after);
      // 临时文件准备期间也可能收到外部修改；最后一步再次比对。
      if (read(path) !== before) return false;
      renameSync(tmp, target);
      return true;
    } finally {
      if (existsSync(tmp)) rmSync(tmp);
    }
  };
  const swap = (path: string, before: string | null, after: string | null): boolean =>
    owner === undefined
      ? swapUnlocked(path, before, after)
      : owner.write(() => swapUnlocked(path, before, after));
  return {
    readText: async (path) => read(path),
    exists: async (path) => existsSync(full(path)),
    stat: async (path) => {
      if (!existsSync(full(path))) return null;
      const stat = statSync(full(path));
      return { size: stat.size, mtimeMs: stat.mtimeMs };
    },
    mkdir: async (path) => {
      mkdirSync(full(path), { recursive: true });
    },
    remove: async (path) => {
      rmSync(full(path), { force: true });
    },
    writeAtomic: async (path, text) => {
      if (!swap(path, read(path), text)) throw new Error(`${path} 已被外部修改`);
    },
    compareAndSwap: async (path, before, after) => swap(path, before, after),
  };
}

export function durableWrite(path: string, text: string | Uint8Array): void {
  const fd = openSync(path, 'wx');
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function saveTaskJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    durableWrite(tmp, JSON.stringify(value));
    renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) rmSync(tmp);
  }
}

export function contentHash(value: string | Uint8Array | null): string | null {
  return value === null ? null : createHash('sha256').update(value).digest('hex');
}

const EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'target', '.ec-task-data']);
export function taskInventory(root: string): Record<string, string> {
  const paths = createProjectPaths({ projectsDir: root });
  const result: Record<string, string> = {};
  const visit = (directory: string, prefix: string): void => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('源码含链接，不能创建隔离工作副本');
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      // 不复制本机密钥、环境值及运行中的数据库；任务有自己的空数据目录。
      if (
        /^(?:\.env(?!\.example$)|\.npmrc$|\.pypirc$)/i.test(entry.name) ||
        /\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm))?$/i.test(entry.name)
      )
        continue;
      const rel = prefix + entry.name;
      const file = paths.inside(root, rel);
      if (entry.isDirectory()) visit(file, `${rel}/`);
      else if (entry.isFile()) result[rel] = contentHash(readFileSync(file)) as string;
    }
  };
  visit(root, '');
  return result;
}
