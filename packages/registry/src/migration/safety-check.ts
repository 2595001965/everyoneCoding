/**
 * SQL 高危操作检测（T7-05 要点 2，FR-UNI-07 / D-08）。
 *
 * 迁移执行前的安全闸门：
 * - 高危（DROP、类型变更、NOT NULL 收紧）→ **强制二次确认**并建议先备份；
 * - 默认策略 **只生成脚本不自动执行**（D-08）；
 * - 检测在**语句级**进行（按 `;` 切分，跳过字符串 / 注释），因此能精确指出是哪一条危险。
 */

/** SQL 风险类别 */
export const SQL_RISK_KINDS = [
  'drop',
  'type_change',
  'not_null_tighten',
  'rename_column',
  'add_column',
  'index',
  'other',
] as const;
export type SqlRiskKind = (typeof SQL_RISK_KINDS)[number];

/** 一条语句的风险描述 */
export interface SqlRisk {
  kind: SqlRiskKind;
  /** 语句原文（去掉首尾空白，保留原始大小写便于人工核对） */
  statement: string;
  /** 是否强制二次确认 */
  requiresSecondConfirm: boolean;
  /** 是否建议先备份 */
  backupRecommended: boolean;
  detail: string;
}

const HIGH_RISK: readonly SqlRiskKind[] = ['drop', 'type_change', 'not_null_tighten'];

/** 语句的中文标签 */
export const SQL_RISK_LABELS: Readonly<Record<SqlRiskKind, string>> = {
  drop: '删除对象（DROP）',
  type_change: '变更列类型',
  not_null_tighten: 'NOT NULL 收紧',
  rename_column: '列改名',
  add_column: '新增列',
  index: '索引变更',
  other: '其他语句',
};

/** 按 `;` 切分 SQL，跳过字符串字面量与注释 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let index = 0;
  while (index < sql.length) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', index);
      index = end < 0 ? sql.length : end;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      index = end < 0 ? sql.length : end + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      let cursor = index + 1;
      while (cursor < sql.length) {
        if (sql[cursor] === '\\') {
          cursor += 2;
          continue;
        }
        if (sql[cursor] === quote) break;
        cursor += 1;
      }
      current += sql.slice(index, Math.min(cursor + 1, sql.length));
      index = cursor + 1;
      continue;
    }
    if (char === ';') {
      statements.push(current);
      current = '';
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }
  statements.push(current);
  return statements
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** 单条语句的风险判定（无风险返回 null） */
export function classifyStatement(statement: string): SqlRisk | null {
  const upper = statement.toUpperCase();
  const compact = upper.replace(/\s+/g, ' ');

  const make = (kind: SqlRiskKind, detail: string): SqlRisk => ({
    kind,
    statement,
    requiresSecondConfirm: HIGH_RISK.includes(kind),
    backupRecommended: HIGH_RISK.includes(kind),
    detail,
  });

  if (/\bDROP\s+(TABLE|COLUMN|INDEX|VIEW|CONSTRAINT)\b/.test(compact)) {
    return make('drop', 'DROP 会永久删除对象与数据，必须二次确认并建议先备份');
  }
  if (
    /\bALTER\s+COLUMN\b[^,]*\b(TYPE|SET\s+DATA\s+TYPE)\b/.test(compact) ||
    /\bMODIFY\s+(COLUMN\s+)?\w+/.test(compact) ||
    /\bCHANGE\s+COLUMN\b/.test(compact)
  ) {
    return make('type_change', '列类型变更可能导致数据截断或重写整表，必须二次确认');
  }
  if (/\bSET\s+NOT\s+NULL\b/.test(compact) && !/\bDEFAULT\b/.test(compact)) {
    return make('not_null_tighten', 'NOT NULL 收紧会让存量 NULL 行写入失败，必须二次确认');
  }
  if (/\bADD\s+COLUMN\b[^;]*\bNOT\s+NULL\b/.test(compact) && !/\bDEFAULT\b/.test(compact)) {
    return make('not_null_tighten', '新增 NOT NULL 列且无默认值，存量行会失败，必须二次确认');
  }
  if (/\bRENAME\s+COLUMN\b/.test(compact) || /\bRENAME\s+TO\b/.test(compact)) {
    return make('rename_column', '改名语句（默认不改数据库列名；如确需执行请确认影响面）');
  }
  if (/\bADD\s+COLUMN\b/.test(compact)) return make('add_column', '新增列（低危）');
  if (/\b(CREATE|DROP)\s+(UNIQUE\s+)?INDEX\b/.test(compact))
    return make('index', '索引变更（低危，可能锁表）');
  return null;
}

/** 全脚本风险分析（按语句顺序） */
export function analyzeSql(sql: string): SqlRisk[] {
  const risks: SqlRisk[] = [];
  for (const statement of splitStatements(sql)) {
    const risk = classifyStatement(statement);
    if (risk !== null) risks.push(risk);
  }
  return risks;
}

/** 是否命中任何强制二次确认的高危项 */
export function requiresSecondConfirm(risks: readonly SqlRisk[]): boolean {
  return risks.some((risk) => risk.requiresSecondConfirm);
}

/** 是否建议先备份 */
export function suggestsBackup(risks: readonly SqlRisk[]): boolean {
  return risks.some((risk) => risk.backupRecommended);
}

/** 锁表 / 耗时风险（供预览面板提示） */
export function lockRiskOf(risks: readonly SqlRisk[]): {
  level: 'low' | 'medium' | 'high';
  detail: string;
} {
  if (risks.some((risk) => risk.kind === 'type_change' || risk.kind === 'drop')) {
    return {
      level: 'high',
      detail: '包含类型变更或删除，可能重写整表 / 长时间持锁，建议在低峰期执行',
    };
  }
  if (risks.some((risk) => risk.kind === 'not_null_tighten' || risk.kind === 'index')) {
    return { level: 'medium', detail: '包含约束或索引变更，可能短暂锁表' };
  }
  return { level: 'low', detail: '仅元数据变更（如列改名），耗时与锁风险都很低' };
}
