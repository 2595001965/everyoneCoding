import { readPath, resolveExpression, parsePath, type PathSegment } from './expression';

/**
 * 结构化条件表达式（T3-05 条件渲染面板 / T3-09 条件分支节点 / T3-11 权限规则共用契约）。
 *
 * 硬约束：**不使用 `eval` / `new Function`**（PRD 硬约束 + 安全要求）。
 * 表达式一律为可序列化的 JSON 结构，左侧为路径表达式（经 `shared/expression` 解析）。
 */

export type ConditionLiteral = string | number | boolean | null;

export type ConditionComparisonOp =
  'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'startsWith' | 'endsWith';

export type ConditionOp =
  ConditionComparisonOp | 'and' | 'or' | 'not' | 'truthy' | 'falsy' | 'in' | 'empty';

/** 条件表达式（递归结构） */
export type ConditionExpr =
  | { op: 'and' | 'or'; items: ConditionExpr[] }
  | { op: 'not'; item: ConditionExpr }
  | { op: ConditionComparisonOp; left: string; right: ConditionLiteral }
  | { op: 'truthy' | 'falsy' | 'empty'; left: string }
  | { op: 'in'; left: string; right: ConditionLiteral[] };

export const CONDITION_OPS: readonly ConditionOp[] = [
  'and',
  'or',
  'not',
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'startsWith',
  'endsWith',
  'in',
  'truthy',
  'falsy',
  'empty',
];

export const CONDITION_OPERATOR_LABELS: Readonly<Record<ConditionOp, string>> = {
  and: '并且（全部满足）',
  or: '或者（任一满足）',
  not: '取反',
  eq: '等于',
  neq: '不等于',
  gt: '大于',
  gte: '大于等于',
  lt: '小于',
  lte: '小于等于',
  contains: '包含',
  startsWith: '以…开头',
  endsWith: '以…结尾',
  in: '属于集合',
  truthy: '为真',
  falsy: '为假',
  empty: '为空',
};

export const LOGICAL_OPS: readonly ConditionOp[] = ['and', 'or', 'not'];
export const UNARY_OPS: readonly ConditionOp[] = ['truthy', 'falsy', 'empty'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 校验任意输入是否为合法条件表达式（不抛异常） */
export function isConditionExpr(value: unknown): value is ConditionExpr {
  return parseCondition(value) !== null;
}

/** 宽松解析：非法返回 null */
export function parseCondition(value: unknown): ConditionExpr | null {
  if (!isRecord(value)) return null;
  const op = value['op'];
  if (typeof op !== 'string' || !(CONDITION_OPS as readonly string[]).includes(op)) return null;
  const typed = op as ConditionOp;

  if (typed === 'and' || typed === 'or') {
    const items = value['items'];
    if (!Array.isArray(items)) return null;
    const parsedItems: ConditionExpr[] = [];
    for (const item of items) {
      const parsed = parseCondition(item);
      if (parsed === null) return null;
      parsedItems.push(parsed);
    }
    return { op: typed, items: parsedItems };
  }
  if (typed === 'not') {
    const parsed = parseCondition(value['item']);
    return parsed === null ? null : { op: 'not', item: parsed };
  }
  if (typed === 'in') {
    const left = value['left'];
    const right = value['right'];
    if (typeof left !== 'string' || !Array.isArray(right)) return null;
    return { op: 'in', left, right: right as ConditionLiteral[] };
  }
  const left = value['left'];
  if (typeof left !== 'string') return null;
  if (typed === 'truthy' || typed === 'falsy' || typed === 'empty') return { op: typed, left };
  const right = value['right'];
  if (
    right !== null &&
    typeof right !== 'string' &&
    typeof right !== 'number' &&
    typeof right !== 'boolean'
  )
    return null;
  return { op: typed, left, right: right as ConditionLiteral };
}

/** 新建一个条件节点（默认「等于」，便于面板直接编辑） */
export function createCondition(op: ConditionOp = 'eq'): ConditionExpr {
  switch (op) {
    case 'and':
    case 'or':
      return { op, items: [] };
    case 'not':
      return { op: 'not', item: { op: 'truthy', left: '' } };
    case 'truthy':
    case 'falsy':
    case 'empty':
      return { op, left: '' };
    case 'in':
      return { op: 'in', left: '', right: [] };
    default:
      return { op, left: '', right: '' };
  }
}

/** 比较辅助：统一按「数字可比则比数字，否则按字符串」处理 */
function compare(left: unknown, right: ConditionLiteral, op: ConditionComparisonOp): boolean {
  if (op === 'eq') return looseEquals(left, right);
  if (op === 'neq') return !looseEquals(left, right);
  if (op === 'contains')
    return Array.isArray(left)
      ? left.includes(right)
      : String(left ?? '').includes(String(right ?? ''));
  if (op === 'startsWith') return String(left ?? '').startsWith(String(right ?? ''));
  if (op === 'endsWith') return String(left ?? '').endsWith(String(right ?? ''));
  const a = typeof left === 'number' ? left : Number(left);
  const b = typeof right === 'number' ? right : Number(right);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  switch (op) {
    case 'gt':
      return a > b;
    case 'gte':
      return a >= b;
    case 'lt':
      return a < b;
    default:
      return a <= b;
  }
}

function looseEquals(left: unknown, right: ConditionLiteral): boolean {
  if (left === right) return true;
  if (left === null || left === undefined) return right === null || right === '';
  if (typeof left === 'number' || typeof right === 'number') return Number(left) === Number(right);
  if (typeof left === 'boolean' || typeof right === 'boolean')
    return String(left) === String(right);
  return String(left) === String(right);
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

/** 求值：scope 为运行时变量表（页面状态、接口响应等） */
export function evaluateCondition(
  expr: ConditionExpr | null | undefined,
  scope: Record<string, unknown> = {},
): boolean {
  if (expr === null || expr === undefined) return true;
  switch (expr.op) {
    case 'and':
      return expr.items.every((item) => evaluateCondition(item, scope));
    case 'or':
      return expr.items.some((item) => evaluateCondition(item, scope));
    case 'not':
      return !evaluateCondition(expr.item, scope);
    case 'truthy':
      return Boolean(resolveOperand(expr.left, scope));
    case 'falsy':
      return !resolveOperand(expr.left, scope);
    case 'empty':
      return isEmptyValue(resolveOperand(expr.left, scope));
    case 'in':
      return expr.right.some((item) => looseEquals(resolveOperand(expr.left, scope), item));
    default:
      return compare(resolveOperand(expr.left, scope), expr.right, expr.op);
  }
}

/** 左侧操作数解析：支持 `a.b[0]` 路径与 `${a.b}` 模板，两者都解析不到时按字面量处理 */
function resolveOperand(text: string, scope: Record<string, unknown>): unknown {
  if (text.length === 0) return undefined;
  const trimmed = text.trim();
  if (/^['"].*['"]$/.test(trimmed)) return trimmed.slice(1, -1);
  const segments: PathSegment[] | null = parsePath(trimmed);
  if (segments !== null) {
    const value = readPath(scope, segments);
    if (value !== undefined) return value;
  }
  return resolveExpression(trimmed, scope);
}

/** 生成可读描述，供面板与校验报告使用 */
export function describeCondition(expr: ConditionExpr | null | undefined): string {
  if (expr === null || expr === undefined) return '始终渲染';
  switch (expr.op) {
    case 'and':
      return expr.items.length === 0
        ? '（空条件）'
        : expr.items.map((item) => `(${describeCondition(item)})`).join(' 并且 ');
    case 'or':
      return expr.items.length === 0
        ? '（空条件）'
        : expr.items.map((item) => `(${describeCondition(item)})`).join(' 或者 ');
    case 'not':
      return `非(${describeCondition(expr.item)})`;
    case 'truthy':
      return `${expr.left} 为真`;
    case 'falsy':
      return `${expr.left} 为假`;
    case 'empty':
      return `${expr.left} 为空`;
    case 'in':
      return `${expr.left} 属于 [${expr.right.map((item) => String(item)).join(', ')}]`;
    default:
      return `${expr.left} ${CONDITION_OPERATOR_LABELS[expr.op]} ${String(expr.right)}`;
  }
}

/** 收集条件里引用的路径（引用检查 / 影响面分析） */
export function collectConditionPaths(expr: ConditionExpr | null | undefined): string[] {
  if (expr === null || expr === undefined) return [];
  switch (expr.op) {
    case 'and':
    case 'or':
      return expr.items.flatMap((item) => collectConditionPaths(item));
    case 'not':
      return collectConditionPaths(expr.item);
    default:
      return [expr.left];
  }
}

/** 权限规则（FR-DSG-04 的「权限」分区）：可见 / 可编辑 + 角色条件 */
export interface PermissionRule {
  mode: 'visible' | 'editable';
  /** 允许的角色；空数组表示不限制角色 */
  roles: string[];
  condition?: ConditionExpr | null;
}

export const DEFAULT_PERMISSION_RULE: PermissionRule = { mode: 'visible', roles: [] };

/** 求值权限规则 */
export function evaluatePermission(
  rule: PermissionRule | null | undefined,
  context: { roles?: readonly string[]; scope?: Record<string, unknown> } = {},
): boolean {
  if (rule === null || rule === undefined) return true;
  const roles = context.roles ?? [];
  if (rule.roles.length > 0 && !rule.roles.some((role) => roles.includes(role))) return false;
  return evaluateCondition(rule.condition ?? null, context.scope ?? {});
}

/** 校验：返回问题列表（空数组表示通过），供 ConditionPanel / flow-validator 复用 */
export function validateCondition(
  expr: ConditionExpr | null | undefined,
  path: string[] = [],
): string[] {
  if (expr === null || expr === undefined) return [];
  const issues: string[] = [];
  switch (expr.op) {
    case 'and':
    case 'or':
      if (expr.items.length === 0)
        issues.push(`${path.join('.') || '条件'}：逻辑组至少需要一个子条件`);
      expr.items.forEach((item, index) =>
        issues.push(...validateCondition(item, [...path, `${expr.op}[${index}]`])),
      );
      break;
    case 'not':
      issues.push(...validateCondition(expr.item, [...path, 'not']));
      break;
    default:
      if (expr.left.trim().length === 0) issues.push(`${path.join('.') || '条件'}：左侧字段未填写`);
      break;
  }
  return issues;
}
