import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

import { Migrator } from '@ec/data';
import { ShellError } from '@ec/shell-api';

import { sqliteFilePath } from './settings-file';

/**
 * 业务库（SQLite）打开与迁移。
 *
 * 与 AI 栈**各自持有连接**：AI 栈依赖 `safeStorage`（DPAPI），无加密可用性时整体装配失败，
 * 而工作台 / 文档 / 设置这些域不该被它连坐。WAL 模式下多连接并存是 SQLite 的正常用法。
 */

/** 默认本地用户 id（与 AI 栈 `ensureUser` 的取值保持一致） */
export const LOCAL_USER_ID = 'local-user';

// esbuild 的 CJS 产物里 `__dirname` 是原生注入的全局；纯 ESM（vitest）下未定义，
// 故这里按"可能不存在"处理，并额外用 cwd / execPath 作为探测起点。
declare const __dirname: string | undefined;

/**
 * 定位 SQLite 迁移目录。
 *
 * 与 `main/ai/runtime.ts` 同一策略：多起点逐级向上探测，不写死层数——
 * 源码（src/main/…）与 esbuild 产物（dist/main/…）深度不同，打包进 asar 后又不同，
 * 单测环境（vitest）则只剩 cwd 可用。
 */
export function resolveMigrationsDir(): string {
  const rel = ['packages', 'data', 'migrations'];
  const starts: string[] = [];
  if (typeof __dirname === 'string') starts.push(__dirname);
  starts.push(process.cwd(), dirname(process.execPath));

  for (const start of starts) {
    let dir = start;
    for (let depth = 0; depth < 8; depth += 1) {
      const candidate = join(dir, ...rel);
      if (existsSync(join(candidate, '0001_init.sql'))) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new ShellError('IO_ERROR', '找不到 SQLite 迁移目录');
}

export interface OpenBusinessDbOptions {
  dataDir: string;
  userId?: string;
}

/** 打开业务库并保证迁移与本地用户就绪（幂等，可重复调用） */
export function openBusinessDb(options: OpenBusinessDbOptions): Database.Database {
  const userId = options.userId ?? LOCAL_USER_ID;
  const file = sqliteFilePath(options.dataDir);
  // better-sqlite3 不会自动创建父目录，目录不存在时 open 会直接 SQLITE_CANTOPEN
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  Migrator.fromDirectory(db, resolveMigrationsDir()).up();
  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO user (id, login, display_name, role, created_at, updated_at)
     VALUES (?, ?, ?, 'owner', ?, ?)`,
  ).run(userId, userId, '本地用户', now, now);
  return db;
}
