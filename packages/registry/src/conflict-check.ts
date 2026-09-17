/**
 * 冲突与非法检测（T7-01 要点 3，FR-UNI-11）。
 *
 * 四类阻断：**保留字 / 与已有标识符冲突 / 超长 / 非法字符**；
 * 命中时返回 **3 个建议名**（加后缀 / 换近义词 / 缩写，按违规类型排序）。
 *
 * 检测覆盖**前端与后端两张符号表**（PRD FR-UNI-11 验收要点）：前端符号表（组件名、
 * 变量名、CSS 类、i18n key）与后端符号表（API 字段、DTO 字段、Service 方法名）分别比对，
 * 命中时给出该符号归属哪一侧，便于 UI 提示。
 *
 * 硬约束：本模块只做检测与建议，**不写任何文件**（写入口在 `rename-transaction`）。
 */

import { deriveProjections, allReservedWords, validateProjectionFormat, type ProjectionFormatIssue } from './naming/rule-engine';
import { applyStyle, segmentWords } from './naming/identifier';
import {
  PROJECTION_KINDS,
  PROJECTION_LABELS,
  type ProjectionKind,
  type ResolvedNamingRule,
} from './naming/presets';
import type { ProjectionSet, RegistryEntityType } from './registry-model';

/** 违规类型 */
export const VIOLATION_KINDS = ['empty', 'reserved_word', 'conflict', 'too_long', 'illegal_char'] as const;
export type ViolationKind = (typeof VIOLATION_KINDS)[number];

/** 一次违规 */
export interface NameViolation {
  kind: ViolationKind;
  /** 命中的投影类型（`empty` 时为 null） */
  projection: ProjectionKind | null;
  /** 触发违规的具体符号 */
  symbol: string | null;
  /** 中文说明（UI 直接展示） */
  detail: string;
}

/** 符号表（前端 / 后端 / 数据库三张；数据库命中只做提示，属 warn 级） */
export interface SymbolTable {
  frontend?: readonly string[] | undefined;
  backend?: readonly string[] | undefined;
  database?: readonly string[] | undefined;
}

/**
 * 已归一化的符号表（三张表必然存在）。
 *
 * 注意不能用 `Required<SymbolTable>`：`Required` 只去掉可选标记，不会剥掉类型里的
 * `| undefined`，展开运算符（`...table.frontend`）会因联合类型报 TS2488。
 */
export interface ResolvedSymbolTable {
  frontend: readonly string[];
  backend: readonly string[];
  database: readonly string[];
}

export interface CheckNameInput {
  canonicalName: string;
  entityType: RegistryEntityType;
  rule: ResolvedNamingRule;
  scope?: string | undefined;
  symbols?: SymbolTable | undefined;
  /** 排除项（重命名时旧名不与自己冲突） */
  exclude?: readonly string[] | undefined;
}

export interface ConflictCheckResult {
  ok: boolean;
  canonicalName: string;
  projections: ProjectionSet;
  violations: readonly NameViolation[];
  formatIssues: readonly ProjectionFormatIssue[];
  /** 恰好 3 个建议规范名（`ok` 时为互补项，仍返回空数组） */
  suggestions: readonly string[];
}

interface CheckContext {
  entityType: RegistryEntityType;
  rule: ResolvedNamingRule;
  scope: string | undefined;
  frontend: ReadonlySet<string>;
  backend: ReadonlySet<string>;
  database: ReadonlySet<string>;
  exclude: ReadonlySet<string>;
  reserved: ReadonlySet<string>;
}

const FRONTEND_KINDS: readonly ProjectionKind[] = ['component', 'variable', 'cssClass', 'i18nKey', 'routeSegment', 'testName'];
const BACKEND_KINDS: readonly ProjectionKind[] = ['apiField', 'methodName'];

function buildContext(input: CheckNameInput): CheckContext {
  return {
    entityType: input.entityType,
    rule: input.rule,
    scope: input.scope,
    frontend: new Set(input.symbols?.frontend ?? []),
    backend: new Set(input.symbols?.backend ?? []),
    database: new Set(input.symbols?.database ?? []),
    exclude: new Set(input.exclude ?? []),
    reserved: allReservedWords(),
  };
}

/** 只做评估、不生成建议（建议器需要复用它验证候选名） */
function evaluate(
  canonicalName: string,
  context: CheckContext,
): { projections: ProjectionSet; violations: NameViolation[]; formatIssues: ProjectionFormatIssue[] } {
  const derived = deriveProjections(canonicalName, {
    entityType: context.entityType,
    rule: context.rule,
    scope: context.scope,
  });
  const violations: NameViolation[] = [];
  const trimmed = canonicalName.trim();
  if (trimmed.length === 0) {
    violations.push({ kind: 'empty', projection: null, symbol: null, detail: '名称不能为空' });
    return { projections: derived.projections, violations, formatIssues: [] };
  }

  const formatIssues = validateProjectionFormat(derived.projections, context.rule);
  for (const issue of formatIssues) {
    violations.push({
      kind: issue.reason === 'too_long' ? 'too_long' : 'illegal_char',
      projection: issue.kind,
      symbol: issue.value,
      detail: issue.detail,
    });
  }

  for (const kind of PROJECTION_KINDS) {
    const value = derived.projections[kind];
    const isReserved = context.reserved.has(value) || context.reserved.has(value.toLowerCase());
    if (isReserved) {
      violations.push({
        kind: 'reserved_word',
        projection: kind,
        symbol: value,
        detail: `${PROJECTION_LABELS[kind]} \`${value}\` 是语言保留字`,
      });
    }
    const side = FRONTEND_KINDS.includes(kind) ? '前端' : BACKEND_KINDS.includes(kind) ? '后端' : null;
    const inFrontend = context.frontend.has(value);
    const inBackend = context.backend.has(value);
    if ((inFrontend || inBackend) && !context.exclude.has(value)) {
      violations.push({
        kind: 'conflict',
        projection: kind,
        symbol: value,
        detail: `${PROJECTION_LABELS[kind]} \`${value}\` 与已有${
          inFrontend && inBackend ? '前端/后端' : inFrontend ? '前端' : '后端'
        }标识符冲突${side === null ? '' : `（该投影属${side}）`}`,
      });
    }
    if (context.database.has(value)) {
      violations.push({
        kind: 'conflict',
        projection: kind,
        symbol: value,
        detail: `${PROJECTION_LABELS[kind]} \`${value}\` 命中数据库列名（warn 级，默认不改）`,
      });
    }
  }

  return { projections: derived.projections, violations, formatIssues };
}

/** 近义词表（换近义词策略） */
const SYNONYMS: Readonly<Record<string, string>> = {
  button: 'control',
  input: 'field',
  按钮: '控件',
  输入框: '字段',
  提交: '发送',
  新建: '创建',
  删除: '移除',
  查询: '检索',
  列表: '清单',
  详情: '明细',
  确认: '确定',
  首页: '主页',
  用户: '账户',
  登录: '登陆',
  submit: 'send',
  create: 'add',
  remove: 'delete',
  login: 'signin',
  user: 'account',
  list: 'items',
  detail: 'info',
};

/** 缩写：取英文投影各词首字母（`UserLoginButton` → `ULB`），拼回规范名 */
function abbreviate(canonicalName: string, context: CheckContext): string {
  const primary = context.rule.preset.rules.component.template === undefined
    ? deriveProjections(canonicalName, context).projections.component
    : deriveProjections(canonicalName, context).projections.variable;
  const letters = (primary.match(/[A-Z]/g) ?? []).join('');
  if (letters.length >= 2) return `${canonicalName}${letters}`;
  const tail = canonicalName.slice(-2);
  return `${canonicalName}${tail.length > 0 ? tail : 'A'}`;
}

/** 换近义词：替换首个命中词 */
function applySynonym(canonicalName: string): string | null {
  for (const [from, to] of Object.entries(SYNONYMS)) {
    if (canonicalName.includes(from)) return canonicalName.replace(from, to);
  }
  return null;
}

/**
 * 生成 3 个建议名。
 *
 * 策略按违规类型排序：
 * - `too_long` → 缩短优先（截断 / 缩写 / 换近义词）
 * - `conflict` / `reserved_word` → 加后缀 / 换近义词 / 缩写
 * - `illegal_char` → 清理字符 / 换近义词 / 加后缀
 *
 * 每个候选都会**重新走一遍完整检测**，只保留能让检测通过的候选；
 * 候选不足 3 个时用编号兜底补齐（保证 UI 恒有 3 个可点选项）。
 */
export function suggestNames(canonicalName: string, context: CheckContext): string[] {
  // 空名称没有可派生的基础，直接给一组可读的占位建议
  if (canonicalName.trim().length === 0) {
    return ['未命名元素', '未命名元素_2', '未命名元素_3'];
  }
  const tooLong = evaluate(canonicalName, context).violations.some((item) => item.kind === 'too_long');
  const candidates: string[] = [];

  if (tooLong) {
    candidates.push(...shortenedCandidates(canonicalName, context));
    candidates.push(abbreviate(canonicalName, context));
  } else {
    candidates.push(`${canonicalName}V2`);
    const synonym = applySynonym(canonicalName);
    if (synonym !== null && synonym !== canonicalName) candidates.push(synonym);
    candidates.push(abbreviate(canonicalName, context));
    candidates.push(`${canonicalName}New`);
  }

  const accepted: string[] = [];
  for (const candidate of candidates) {
    if (candidate.length === 0 || candidate === canonicalName) continue;
    if (accepted.includes(candidate)) continue;
    if (evaluate(candidate, context).violations.length === 0) {
      accepted.push(candidate);
      if (accepted.length === 3) return accepted;
    }
  }
  // 兜底：编号后缀（仍不通过也照给，由用户在 UI 中继续调整）
  let index = 2;
  while (accepted.length < 3) {
    const candidate = `${canonicalName}${index}`;
    if (!accepted.includes(candidate)) accepted.push(candidate);
    index += 1;
  }
  return accepted;
}

/**
 * 超长场景的缩短候选：按"词"逐级截断后重建（英文投影拼写）。
 *
 * 例：`UserLoginSubmitHandler` + 组件名上限 12 → `UserLoginSubmit`、`UserLogin`、`User`。
 * 只做字符截断是无效的（截 3 个字符仍然超长），必须**按词**裁。
 */
function shortenedCandidates(canonicalName: string, context: CheckContext): string[] {
  const words = segmentWords(canonicalName, {
    mode: context.rule.mode,
    dictionary: context.rule.dictionary,
  });
  const out: string[] = [];
  for (let keep = words.length - 1; keep >= 1; keep -= 1) {
    const candidate = applyStyle(words.slice(0, keep), 'pascal');
    if (candidate.length > 0 && candidate !== canonicalName) out.push(candidate);
  }
  return out;
}

/** 主入口：合法性校验 + 建议名 */
export function checkName(input: CheckNameInput): ConflictCheckResult {
  const context = buildContext(input);
  const { projections, violations, formatIssues } = evaluate(input.canonicalName, context);
  const ok = violations.length === 0;
  return {
    ok,
    canonicalName: input.canonicalName,
    projections,
    violations,
    formatIssues,
    suggestions: ok ? [] : suggestNames(input.canonicalName, context),
  };
}

/** 供 UI 复用：违规类型的中文标签 */
export const VIOLATION_LABELS: Readonly<Record<ViolationKind, string>> = {
  empty: '名称为空',
  reserved_word: '语言保留字',
  conflict: '标识符冲突',
  too_long: '超出长度上限',
  illegal_char: '非法字符',
};
