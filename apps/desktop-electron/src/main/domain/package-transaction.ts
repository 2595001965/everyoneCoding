import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type Database from 'better-sqlite3';

/** 同步写入期间不让出事件循环；SQLite 保存点与磁盘撤销副本一起提交。 */
export function createPackageTransaction(db: Database.Database, projectsDir: string) {
  const root = resolve(projectsDir);
  let undoDir: string | null = null;
  const touched = new Map<string, string | null>();
  const pathFor = (id: string): string => {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('归档项目标识非法');
    const path = resolve(root, id);
    if (!path.startsWith(root + sep)) throw new Error('归档路径越界');
    return path;
  };
  return {
    pathFor,
    begin() {
      if (undoDir) throw new Error('已有导入事务');
      mkdirSync(dirname(root), { recursive: true });
      undoDir = mkdtempSync(join(dirname(root), '.ec-import-undo-'));
      db.exec('SAVEPOINT package_import');
      db.pragma('defer_foreign_keys = ON');
    },
    touch(id: string) {
      const path = pathFor(id);
      if (!undoDir || touched.has(path)) return;
      const backup = existsSync(path) ? join(undoDir, id) : null;
      if (backup) cpSync(path, backup, { recursive: true });
      touched.set(path, backup);
    },
    commit() {
      db.exec('RELEASE SAVEPOINT package_import');
      if (undoDir) rmSync(undoDir, { recursive: true, force: true });
      undoDir = null;
      touched.clear();
    },
    rollback() {
      if (!undoDir) return;
      db.exec('ROLLBACK TO SAVEPOINT package_import; RELEASE SAVEPOINT package_import');
      for (const [path, backup] of touched) {
        if (!path.startsWith(root + sep)) throw new Error('撤销路径越界');
        rmSync(path, { recursive: true, force: true });
        if (backup) cpSync(backup, path, { recursive: true });
      }
      rmSync(undoDir, { recursive: true, force: true });
      undoDir = null;
      touched.clear();
    },
  };
}
