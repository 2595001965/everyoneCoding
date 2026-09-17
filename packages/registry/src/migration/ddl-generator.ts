/**
 * 迁移脚本生成（T7-05 要点 1，FR-UNI-07 / **D-08**）。
 *
 * D-08 的硬约束在这一层落地：
 * - 迁移脚本（前向 + 回滚）**只能由 AI 生成 / 修改**，因此本模块只做三件事：
 *   构造提示词 → 交给模型端口 → 解析并校验模型的输出；
 * - 生成的脚本**禁止用户手动编辑**（`editable: false`），需要改动只能让 AI 重生成；
 * - 模型端口不可用时**如实报错**并给出引导，绝不静默套用某个模板冒充 AI 产物。
 *
 * `ddlTemplate` 只用于提示词的"方言参考"，让模型对齐目标方言的语法要点；
 * 它**不会**被当作输出返回。
 */

import { analyzeSql, type SqlRisk } from './safety-check';

/** 目标数据库方言 */
export const SQL_DIALECTS = ['sqlite', 'mysql', 'postgres'] as const;
export type SqlDialect = (typeof SQL_DIALECTS)[number];

/** 各方言的语法要点（嵌入提示词，保证模型输出可直接执行） */
export const DIALECT_NOTES: Readonly<Record<SqlDialect, readonly string[]>> = {
  sqlite: [
    'SQLite 3.25+ 支持 `ALTER TABLE <t> RENAME COLUMN <old> TO <new>;`',
    'SQLite 不支持 ALTER COLUMN TYPE；类型变更需"新建表 → 迁移数据 → 删除旧表 → 重命名"四步走',
    '回滚脚本必须还原表结构、数据与索引，且可重复执行（幂等）',
  ],
  mysql: [
    'MySQL 8 支持 `ALTER TABLE <t> RENAME COLUMN <old> TO <new>;`（8.0 前用 CHANGE COLUMN 并重复列定义）',
    '类型变更用 `ALTER TABLE <t> MODIFY COLUMN <col> <type>;`',
    '回滚脚本需还原列名、类型、默认值、注释与索引',
  ],
  postgres: [
    'PostgreSQL 用 `ALTER TABLE <t> RENAME COLUMN <old> TO <new>;`',
    '类型变更用 `ALTER TABLE <t> ALTER COLUMN <col> TYPE <type> USING <col>::<type>;`',
    '回滚脚本需还原列名、类型、NOT NULL 与默认值',
  ],
};

/** 迁移生成请求（表结构上下文 + 旧 / 新字段名） */
export interface DdlRequest {
  dialect: SqlDialect;
  table: string;
  oldColumn: string;
  newColumn: string;
  /** 列类型（用于回滚脚本与类型变更场景） */
  columnType: string | null;
  /** 是否 NOT NULL */
  nullable: boolean | null;
  /** 引用该列的其他对象（索引 / 视图 / 外键 / 触发器），AI 需一并迁移 */
  dependents: readonly string[];
  /** 表规模（用于提示模型"是否需要在线 DDL"） */
  estimatedRows: number | null;
}

/** 模型端口（外壳适配 `@ec/ai` 的 Provider Adapter） */
export interface MigrationModelPort {
  complete(prompt: string): Promise<string>;
  readonly modelId?: string | undefined;
}

/** 生成结果 */
export interface GeneratedMigration {
  id: string;
  dialect: SqlDialect;
  table: string;
  oldColumn: string;
  newColumn: string;
  /** 前向迁移脚本 */
  forward: string;
  /** 回滚脚本 */
  rollback: string;
  /** 生成来源：只允许 AI（D-08） */
  generatedBy: 'ai';
  /** 用户禁止手动编辑（D-08） */
  editable: false;
  /** 生成时使用的提示词（可追溯，便于"让 AI 重生成"） */
  prompt: string;
  /** 风险分析（由 `safety-check` 得出） */
  risks: readonly SqlRisk[];
  modelId: string | null;
}

/** 生成失败（如实上报，不降级造脚本） */
export interface MigrationGenerationError {
  ok: false;
  reason: string;
  prompt: string;
  /** 引导文案（UI 直接展示） */
  guidance: string;
}

/** 构造提示词（纯函数，可测试） */
export function buildDdlPrompt(request: DdlRequest): string {
  const notes = DIALECT_NOTES[request.dialect]
    .map((note, index) => `${index + 1}. ${note}`)
    .join('\n');
  const dependents =
    request.dependents.length === 0 ? '（无）' : request.dependents.map((item) => `- ${item}`).join('\n');
  return [
    '你是数据库迁移专家。请为下面的字段改名生成**可直接执行**的迁移脚本。',
    '',
    '【必须遵守】',
    `- 目标方言：${request.dialect}`,
    '- 输出两个 sql 代码块，**第一个是前向迁移脚本，第二个是回滚脚本**，不要输出解释文字',
    '- 两个脚本都必须幂等（重复执行不报错、不丢数据）',
    '- 回滚脚本必须能把结构、数据与索引完整还原到改名前的状态',
    '- 保留原有列类型、NOT NULL、默认值与注释',
    '',
    '【方言要点】',
    notes,
    '',
    '【目标】',
    `- 表：${request.table}`,
    `- 旧列名：${request.oldColumn}`,
    `- 新列名：${request.newColumn}`,
    `- 列类型：${request.columnType ?? '（未提供，请保持现状）'}`,
    `- 是否 NOT NULL：${request.nullable === null ? '（未提供）' : request.nullable ? '否' : '是'}`,
    `- 预计行数：${request.estimatedRows === null ? '未知' : String(request.estimatedRows)}`,
    '',
    '【引用该列、需一并迁移的对象】',
    dependents,
  ].join('\n');
}

/** 从模型输出中提取两个 sql 代码块（前向 / 回滚） */
export function parseGeneratedMigration(text: string): { forward: string; rollback: string } | null {
  const blocks: string[] = [];
  const fence = /```(?:sql)?\s*\n([\s\S]*?)```/g;
  let match = fence.exec(text);
  while (match !== null) {
    const body = (match[1] ?? '').trim();
    if (body.length > 0) blocks.push(body);
    match = fence.exec(text);
  }
  if (blocks.length >= 2) return { forward: blocks[0]!, rollback: blocks[1]! };
  if (blocks.length === 1) return { forward: blocks[0]!, rollback: '' };
  return null;
}

export interface GenerateMigrationInput {
  request: DdlRequest;
  model: MigrationModelPort | null;
  id: string;
}

/**
 * 生成迁移脚本。
 *
 * 失败（无模型 / 输出无 SQL / 回滚脚本缺失）时返回 `MigrationGenerationError`，
 * 由 UI 提示用户"配置模型后重试"——**不会**用内置模板顶替 AI 产物（D-08）。
 */
export async function generateMigration(
  input: GenerateMigrationInput,
): Promise<GeneratedMigration | MigrationGenerationError> {
  const prompt = buildDdlPrompt(input.request);
  if (input.model === null) {
    return {
      ok: false,
      reason: '未配置可用的 AI 模型，无法生成迁移脚本',
      prompt,
      guidance: '请在「设置 → 模型接入」中配置一个可用模型后重试；D-08 规定迁移脚本只能由 AI 生成，本产品不提供手写迁移脚本的入口。',
    };
  }

  let raw: string;
  try {
    raw = await input.model.complete(prompt);
  } catch (error) {
    return {
      ok: false,
      reason: `模型调用失败：${String(error)}`,
      prompt,
      guidance: '请检查模型连通性（设置 → 模型接入 → 连通性测试）后重试。',
    };
  }

  const parsed = parseGeneratedMigration(raw);
  if (parsed === null) {
    return {
      ok: false,
      reason: '模型输出中未找到 SQL 代码块',
      prompt,
      guidance: '已保留本次提示词，可点击「让 AI 重新生成」重试。',
    };
  }
  if (parsed.rollback.trim().length === 0) {
    return {
      ok: false,
      reason: '模型输出缺少回滚脚本（无法保证可撤销，拒绝采纳）',
      prompt,
      guidance: '回滚脚本是 NFR-R-04 的硬要求，请点击「让 AI 重新生成」。',
    };
  }

  const risks = [...analyzeSql(parsed.forward), ...analyzeSql(parsed.rollback)];
  return {
    id: input.id,
    dialect: input.request.dialect,
    table: input.request.table,
    oldColumn: input.request.oldColumn,
    newColumn: input.request.newColumn,
    forward: parsed.forward,
    rollback: parsed.rollback,
    generatedBy: 'ai',
    editable: false,
    prompt,
    risks,
    modelId: input.model.modelId ?? null,
  };
}

/** 类型守卫：生成失败 */
export function isGenerationError(
  value: GeneratedMigration | MigrationGenerationError,
): value is MigrationGenerationError {
  return (value as MigrationGenerationError).ok === false;
}

/** 迁移脚本的提交信息（Conventional Commits） */
export function buildMigrationCommitMessage(table: string, oldColumn: string, newColumn: string): string {
  return `refactor(rename-db): ${table}.${oldColumn} → ${newColumn}`;
}
