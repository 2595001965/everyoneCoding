/**
 * 迁移执行（T7-05 要点 3，FR-UNI-07 / E2E-20 后半段）。
 *
 * 流程与硬约束：
 * 1. **默认只生成不执行**（D-08）：`confirmed` 未显式为 true 时直接拒绝执行；
 * 2. 命中高危操作时，必须 `secondConfirmed = true` 才允许执行；
 * 3. 通过项目配置的数据源连接执行（连接串由外壳从 `secure-store` 取，本模块只见端口）；
 * 4. 执行过程**流式输出日志**（`onLog` 回调，UI 逐行回显）；
 * 5. 成功后记录 rename 事件（含 commit sha）与 `refactor(rename-db)` Git 提交；
 * 6. 任一语句失败 → **自动尝试回滚脚本**并告警（如实上报回滚是否成功）。
 */

import { buildMigrationCommitMessage, type GeneratedMigration } from './ddl-generator';
import { splitStatements } from './safety-check';
import { createRenameEvent, type RenameEvent, type RenameEventStore, type ChangeSet } from '../rename-event';
import { newUlid } from '../ids';

/** 数据源连接端口（外壳绑定项目数据源；连接串走 `secure-store`，本模块不接触明文） */
export interface MigrationConnectionPort {
  /** 执行一条语句（不含分号；驱动负责事务与错误抛出） */
  execute(statement: string): Promise<void>;
}

/** Git 提交端口（与 T7-04 同形） */
export interface MigrationGitPort {
  commit(input: { message: string; paths: readonly string[] }): Promise<string | null> | string | null;
}

export const MIGRATION_LOG_LEVELS = ['info', 'success', 'warn', 'error'] as const;
export type MigrationLogLevel = (typeof MIGRATION_LOG_LEVELS)[number];

/** 一行执行日志（UI 流式回显） */
export interface MigrationLogLine {
  level: MigrationLogLevel;
  message: string;
  at: number;
  index: number;
  total: number;
}

export interface ExecuteMigrationInput {
  migration: GeneratedMigration;
  connection: MigrationConnectionPort;
  /** 是否已由用户确认执行（默认 false → 只生成不执行） */
  confirmed?: boolean | undefined;
  /** 高危操作是否已二次确认 */
  secondConfirmed?: boolean | undefined;
  /** 高危操作存在时必须为 true，否则拒绝执行 */
  requiresSecondConfirm?: boolean | undefined;
  events?: RenameEventStore | null | undefined;
  git?: MigrationGitPort | null | undefined;
  /** 迁移归属（用于 rename 事件） */
  projectId?: string | undefined;
  registryId?: string | undefined;
  /** 流式日志回调 */
  onLog?: ((line: MigrationLogLine) => void) | undefined;
  now?: number | undefined;
  random?: (() => number) | undefined;
}

export interface MigrationExecutionResult {
  ok: boolean;
  executed: string[];
  failedStatement: string | null;
  failure: string | null;
  rolledBack: boolean;
  rollbackFailure: string | null;
  log: MigrationLogLine[];
  event: RenameEvent | null;
  commitSha: string | null;
  /** 拒绝执行时的原因（`confirmed === false` / 缺二次确认） */
  refused: string | null;
}

/**
 * 执行迁移。
 *
 * 拒绝执行的两种情况（返回 `refused`，**不做任何写入**）：
 * - `confirmed !== true`：D-08 默认只生成脚本；
 * - `requiresSecondConfirm === true && secondConfirmed !== true`：高危操作缺二次确认。
 */
export async function executeMigration(input: ExecuteMigrationInput): Promise<MigrationExecutionResult> {
  const now = input.now ?? Date.now();
  const random = input.random ?? Math.random;
  const log: MigrationLogLine[] = [];
  const statements = splitStatements(input.migration.forward);
  const rollbackStatements = splitStatements(input.migration.rollback);
  const total = statements.length;

  const record = (level: MigrationLogLevel, message: string, index: number): void => {
    const line: MigrationLogLine = { level, message, at: input.now ?? Date.now(), index, total };
    log.push(line);
    input.onLog?.(line);
  };

  const refusedResult = (refused: string): MigrationExecutionResult => {
    record('warn', refused, 0);
    return {
      ok: false,
      executed: [],
      failedStatement: null,
      failure: null,
      rolledBack: false,
      rollbackFailure: null,
      log,
      event: null,
      commitSha: null,
      refused,
    };
  };

  if (input.confirmed !== true) {
    return refusedResult('默认只生成脚本不执行（D-08）：请在预览面板点击「确认并执行」');
  }
  if (input.requiresSecondConfirm === true && input.secondConfirmed !== true) {
    return refusedResult('本次迁移命中高危操作（DROP / 类型变更 / NOT NULL 收紧），需要二次确认');
  }
  if (statements.length === 0) {
    return refusedResult('迁移脚本为空，无可执行语句');
  }

  const executed: string[] = [];
  let failedStatement: string | null = null;
  let failure: string | null = null;

  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index]!;
    record('info', `执行第 ${index + 1}/${total} 条：${firstLine(statement)}`, index + 1);
    try {
      await input.connection.execute(statement);
      executed.push(statement);
      record('success', `第 ${index + 1} 条执行成功`, index + 1);
    } catch (error) {
      failedStatement = statement;
      failure = String(error);
      record('error', `第 ${index + 1} 条执行失败：${failure}`, index + 1);
      break;
    }
  }

  let rolledBack = false;
  let rollbackFailure: string | null = null;
  if (failure !== null) {
    record('warn', '开始执行回滚脚本（逆序）', executed.length);
    const reversed = [...rollbackStatements].reverse();
    for (const statement of reversed) {
      try {
        await input.connection.execute(statement);
        record('success', `回滚语句执行成功：${firstLine(statement)}`, executed.length);
      } catch (error) {
        rollbackFailure = String(error);
        record('error', `回滚失败（需人工介入）：${rollbackFailure}`, executed.length);
        break;
      }
    }
    rolledBack = rollbackFailure === null;
    record(
      rolledBack ? 'info' : 'error',
      rolledBack ? '已回滚到迁移前状态' : '回滚未完全成功，请人工核对数据库状态',
      executed.length,
    );
    return {
      ok: false,
      executed,
      failedStatement,
      failure,
      rolledBack,
      rollbackFailure,
      log,
      event: null,
      commitSha: null,
      refused: null,
    };
  }

  /* ---------------------- 成功：rename 事件 + Git 提交 ---------------------- */
  record('success', `迁移完成，共执行 ${executed.length} 条语句`, total);
  const commitMessage = buildMigrationCommitMessage(
    input.migration.table,
    input.migration.oldColumn,
    input.migration.newColumn,
  );

  let commitSha: string | null = null;
  if (input.git != null) {
    try {
      commitSha = (await input.git.commit({ message: commitMessage, paths: [] })) ?? null;
    } catch (error) {
      record('warn', `Git 提交失败（迁移已生效，可稍后在 Git 面板手动提交）：${String(error)}`, total);
    }
  }

  let event: RenameEvent | null = null;
  if (input.events != null) {
    const changeset: ChangeSet = {
      registryId: input.registryId ?? '',
      projectId: input.projectId ?? '',
      oldName: `${input.migration.table}.${input.migration.oldColumn}`,
      newName: `${input.migration.table}.${input.migration.newColumn}`,
      scope: 'project',
      createdAt: now,
      segments: [
        {
          executorId: 'migration-executor',
          column: 'code',
          label: '数据库迁移',
          applied: executed.length,
          skipped: 0,
          failures: [],
          warnings: [],
          undo: [],
        },
      ],
      snapshots: [],
      stateSnapshots: [],
      projections: {
        before: emptyProjections(),
        after: emptyProjections(),
      },
      registryBefore: emptyRegistry(input.registryId ?? '', input.projectId ?? '', now),
      registryAfter: emptyRegistry(input.registryId ?? '', input.projectId ?? '', now),
      commitMessage,
    };
    event = createRenameEvent({
      projectId: input.projectId ?? '',
      registryId: input.registryId ?? '',
      oldName: `${input.migration.table}.${input.migration.oldColumn}`,
      newName: `${input.migration.table}.${input.migration.newColumn}`,
      changeset,
      commitSha,
      now,
      random,
    });
    try {
      input.events.append(event);
      record('info', `已记录 rename 事件 ${event.id}（commit ${commitSha ?? '无'}）`, total);
    } catch (error) {
      record('warn', `记录 rename 事件失败：${String(error)}`, total);
    }
  }

  return {
    ok: true,
    executed,
    failedStatement: null,
    failure: null,
    rolledBack: false,
    rollbackFailure: null,
    log,
    event,
    commitSha,
    refused: null,
  };
}

function firstLine(statement: string): string {
  const line = statement.split('\n')[0] ?? statement;
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

function emptyProjections(): ChangeSet['projections']['before'] {
  return {
    component: '',
    variable: '',
    cssClass: '',
    i18nKey: '',
    apiField: '',
    methodName: '',
    routeSegment: '',
    testName: '',
  };
}

function emptyRegistry(registryId: string, projectId: string, now: number): ChangeSet['registryBefore'] {
  return {
    id: registryId,
    projectId,
    entityType: 'element',
    entityId: newUlid(now, () => 0),
    canonicalName: '',
    projections: emptyProjections(),
    aliases: [],
    namingRuleId: 'web-default',
    nameHistory: [],
    syncState: 'synced',
    createdAt: now,
    updatedAt: now,
  };
}
