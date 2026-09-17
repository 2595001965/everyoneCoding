import type { Database } from 'better-sqlite3';

/**
 * 工作单元：让多个 Repository 共享同一事务。
 *
 * 用法：
 * ```ts
 * const uow = new UnitOfWork(client.raw);
 * uow.run(() => {
 *   projectRepo.insert(project);
 *   memoryRepo.insert(memory);
 * });
 * ```
 * 回调内抛错则整体回滚（NFR-R-02 / NFR-R-04）。
 */

export interface UnitOfWorkContext {
  /** 主动回滚并抛出错误 */
  rollback(reason: string): never;
}

export class UnitOfWork {
  constructor(private readonly db: Database) {}

  /** 在事务中执行，成功提交、抛错回滚 */
  run<T>(fn: (ctx: UnitOfWorkContext) => T): T {
    const transaction = this.db.transaction((ctx: UnitOfWorkContext) => fn(ctx));
    return transaction({
      rollback(reason: string): never {
        throw new UnitOfWorkRollback(reason);
      },
    });
  }

  get inTransaction(): boolean {
    return this.db.inTransaction;
  }
}

/** 事务内主动回滚信号 */
export class UnitOfWorkRollback extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'UnitOfWorkRollback';
    Object.setPrototypeOf(this, UnitOfWorkRollback.prototype);
  }
}

/** 便捷函数：在单个事务里执行一批写操作 */
export function inTransaction<T>(db: Database, fn: () => T): T {
  return new UnitOfWork(db).run(() => fn());
}
