import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import type Database from 'better-sqlite3';

/** Files participate in the same synchronous unit of work as the SQLite savepoint.
 * Every write is journalled before it happens, including writes by undo/executor rollback.
 */
export function createRenameAtomic(db: Database.Database) {
  let journal: Map<string, Buffer | null> | null = null;
  return {
    beforeWrite(path: string): void {
      if (journal !== null && !journal.has(path)) {
        journal.set(path, existsSync(path) ? readFileSync(path) : null);
      }
    },
    run<T extends { ok: boolean }>(operation: () => T): T {
      if (journal !== null) throw new Error('重命名事务不能重入');
      const files = new Map<string, Buffer | null>();
      journal = files;
      let result: T | undefined;
      const rejected = new Error('重命名事务失败');
      try {
        return db.transaction(() => {
          result = operation();
          if (!result.ok) throw rejected;
          return result;
        })();
      } catch (error) {
        const failures: unknown[] = [];
        for (const [path, bytes] of [...files].reverse()) {
          try {
            if (bytes === null) { if (existsSync(path)) unlinkSync(path); }
            else writeFileSync(path, bytes);
          } catch (failure) { failures.push(failure); }
        }
        if (failures.length > 0) throw new AggregateError(failures, '重命名文件回滚失败，保留备份供恢复');
        if (error === rejected && result !== undefined) return result;
        throw error;
      } finally {
        journal = null;
      }
    },
  };
}
