/**
 * 迁移预览（T7-05 要点 2，FR-UNI-07 / E2E-20 前半段）。
 *
 * 执行前必须展示：**SQL 预览 + 影响行数估算 + 锁表 / 耗时风险**，并且：
 * - 高危操作（DROP / 类型变更 / NOT NULL 收紧）→ `requiresSecondConfirm = true` 且建议备份；
 * - **默认只生成脚本不自动执行**（`defaultAction = 'generate_only'`，D-08）。
 *
 * 影响行数是**估算**：优先精确 `COUNT(*)`（端口支持时），否则用表统计信息，
 * 都拿不到就如实标 `unknown`——不编数字。
 */

import {
  analyzeSql,
  lockRiskOf,
  requiresSecondConfirm,
  splitStatements,
  suggestsBackup,
  type SqlRisk,
} from './safety-check';
import type { GeneratedMigration, SqlDialect } from './ddl-generator';

/** 表统计端口（外壳绑定项目数据源；连接串走 secure-store） */
export interface TableStatPort {
  /** 精确行数；不可用返回 null */
  countRows(table: string): Promise<number | null>;
  /** 统计信息估算行数；不可用返回 null */
  estimateRows(table: string): Promise<number | null>;
}

export interface RowsEstimate {
  estimate: number | null;
  method: 'exact' | 'statistics' | 'unknown';
  detail: string;
}

/** 预览中的单条语句 */
export interface PreviewStatement {
  sql: string;
  risk: SqlRisk['kind'] | null;
  requiresSecondConfirm: boolean;
  label: string;
}

export interface MigrationPreview {
  migrationId: string;
  dialect: SqlDialect;
  table: string;
  oldColumn: string;
  newColumn: string;
  forward: string;
  rollback: string;
  /** 语句级预览（前向 + 回滚分列，UI 分两栏展示） */
  statements: PreviewStatement[];
  rollbackStatements: PreviewStatement[];
  risks: readonly SqlRisk[];
  affectedRows: RowsEstimate;
  lockRisk: { level: 'low' | 'medium' | 'high'; detail: string };
  /** 估算执行耗时（毫秒） */
  estimatedMs: number;
  /** 是否强制二次确认 */
  requiresSecondConfirm: boolean;
  /** 是否建议先备份 */
  backupRecommended: boolean;
  /** 默认动作：只生成脚本（D-08） */
  defaultAction: 'generate_only';
  /** 引导文案 */
  guidance: string;
  warnings: string[];
}

/** 单条语句的基础耗时预算（毫秒） */
const MS_PER_STATEMENT = 40;
/** 每万行的数据重写预算（毫秒） */
const MS_PER_10K_ROWS = 900;

/** 影响行数估算 */
export async function estimateAffectedRows(
  table: string,
  stats: TableStatPort | null,
): Promise<RowsEstimate> {
  if (stats === null) {
    return { estimate: null, method: 'unknown', detail: '未连接数据源，无法估算影响行数' };
  }
  try {
    const exact = await stats.countRows(table);
    if (exact !== null) {
      return { estimate: exact, method: 'exact', detail: `COUNT(*) = ${exact} 行` };
    }
  } catch {
    // 继续尝试统计信息
  }
  try {
    const estimated = await stats.estimateRows(table);
    if (estimated !== null) {
      return { estimate: estimated, method: 'statistics', detail: `来自表统计信息，约 ${estimated} 行` };
    }
  } catch {
    // 落到 unknown
  }
  return { estimate: null, method: 'unknown', detail: '无法获取行数（表不存在或权限不足）' };
}

function toPreviewStatement(statement: string, risks: readonly SqlRisk[]): PreviewStatement {
  const risk = risks.find((item) => item.statement === statement);
  return {
    sql: statement,
    risk: risk?.kind ?? null,
    requiresSecondConfirm: risk?.requiresSecondConfirm ?? false,
    label: risk?.detail ?? '常规语句',
  };
}

export interface BuildPreviewInput {
  migration: GeneratedMigration;
  stats?: TableStatPort | null | undefined;
}

/** 构造迁移预览 */
export async function buildMigrationPreview(input: BuildPreviewInput): Promise<MigrationPreview> {
  const { migration } = input;
  const forwardRisks = analyzeSql(migration.forward);
  const rollbackRisks = analyzeSql(migration.rollback);
  const affectedRows = await estimateAffectedRows(migration.table, input.stats ?? null);
  const lockRisk = lockRiskOf(forwardRisks);
  const secondConfirm = requiresSecondConfirm(forwardRisks);
  const backup = suggestsBackup(forwardRisks);

  const warnings: string[] = [];
  if (affectedRows.method === 'unknown') {
    warnings.push('无法估算影响行数，执行前请自行确认表已备份');
  }
  if (lockRisk.level === 'high') warnings.push(lockRisk.detail);

  const dataRewrite =
    forwardRisks.some((risk) => risk.kind === 'type_change' || risk.kind === 'drop') &&
    affectedRows.estimate !== null
      ? (affectedRows.estimate / 10000) * MS_PER_10K_ROWS
      : 0;
  const estimatedMs = Number(
    ((forwardRisks.length + rollbackRisks.length) * MS_PER_STATEMENT + dataRewrite).toFixed(2),
  );

  return {
    migrationId: migration.id,
    dialect: migration.dialect,
    table: migration.table,
    oldColumn: migration.oldColumn,
    newColumn: migration.newColumn,
    forward: migration.forward,
    rollback: migration.rollback,
    statements: splitPreview(migration.forward, forwardRisks),
    rollbackStatements: splitPreview(migration.rollback, rollbackRisks),
    risks: forwardRisks,
    affectedRows,
    lockRisk,
    estimatedMs,
    requiresSecondConfirm: secondConfirm,
    backupRecommended: backup,
    defaultAction: 'generate_only',
    guidance:
      '默认只生成脚本不自动执行（D-08）。确认 SQL 与影响行数后，可点击「确认并执行」；' +
      (secondConfirm ? '本次命中高危操作，需要二次确认。' : '本次未命中高危操作。'),
    warnings,
  };
}

/** 用 safety-check 的切分口径拆语句，保证预览与风险分析逐条对齐 */
function splitPreview(sql: string, risks: readonly SqlRisk[]): PreviewStatement[] {
  return splitStatements(sql).map((statement) => toPreviewStatement(statement, risks));
}
