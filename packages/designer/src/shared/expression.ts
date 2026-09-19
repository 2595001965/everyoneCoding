/**
 * 路径表达式与模板解析（T3-05 绑定 / T3-08 状态绑定 / T3-09 赋值动作 / T3-11 参数映射共用契约）。
 *
 * 支持两种写法，均为**数据而非脚本**（不使用 eval）：
 * - 路径：`user.list[0].name`、`items[2].id`
 * - 模板：`${user.name}`、`你好 ${user.name}`（整串仅一个模板时返回原始类型）
 */

export type PathSegment = string | number;

/** 常量字面量字面量匹配（用于区分「字面量」与「路径」） */
const NUMBER_LITERAL = /^-?\d+(\.\d+)?$/;
const BOOLEAN_LITERAL = /^(true|false)$/;
const NULL_LITERAL = /^null$/;
const QUOTED_LITERAL = /^'(.*)'$|^"(.*)"$/;

/**
 * 解析路径表达式。
 * 非法（空串、以 `.` 或 `[` 开头等）返回 null。
 */
export function parsePath(text: string): PathSegment[] | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  // 字面量不作为路径
  if (isLiteralText(trimmed)) return null;
  const segments: PathSegment[] = [];
  let buffer = '';
  let index = 0;
  /** 上一个 token 是否来自下标（`[0]`），用于允许 `a[0].b` 这种紧跟点号的形态 */
  let afterBracket = false;

  const flushName = (): void => {
    if (buffer.length === 0) return;
    segments.push(buffer);
    buffer = '';
  };

  if (/^[.[]/.test(trimmed)) return null;

  while (index < trimmed.length) {
    const char = trimmed[index] as string;
    if (char === '.') {
      if (buffer.length > 0) {
        flushName();
        afterBracket = false;
      } else if (afterBracket) {
        afterBracket = false;
      } else {
        return null;
      }
      index += 1;
      if (index >= trimmed.length) return null;
      continue;
    }
    if (char === '[') {
      flushName();
      const close = trimmed.indexOf(']', index);
      if (close === -1) return null;
      const inner = trimmed.slice(index + 1, close).trim();
      if (inner.length === 0) return null;
      const quoted = QUOTED_LITERAL.exec(inner);
      if (quoted) {
        segments.push((quoted[1] ?? quoted[2] ?? '') as string);
      } else if (NUMBER_LITERAL.test(inner)) {
        segments.push(Number(inner));
      } else {
        segments.push(inner);
      }
      index = close + 1;
      if (index < trimmed.length && trimmed[index] !== '.' && trimmed[index] !== '[') return null;
      afterBracket = true;
      continue;
    }
    buffer += char;
    afterBracket = false;
    index += 1;
  }
  if (buffer.length === 0 && !afterBracket) return null;
  flushName();
  return segments;
}

/** 路径格式化：`['user','list',0,'name'] → 'user.list[0].name'` */
export function formatPath(segments: readonly PathSegment[]): string {
  return segments.reduce<string>((acc, segment) => {
    if (typeof segment === 'number') return `${acc}[${segment}]`;
    if (acc.length === 0) return segment;
    return `${acc}.${segment}`;
  }, '');
}

/** 从变量表按路径读值 */
export function readPath(
  scope: Record<string, unknown>,
  path: readonly PathSegment[] | string,
): unknown {
  const segments = typeof path === 'string' ? parsePath(path) : path;
  if (segments === null || segments.length === 0) return undefined;
  let current: unknown = scope;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** 按路径写值（运行时状态赋值；中间层缺失时返回 false） */
export function writePath(
  scope: Record<string, unknown>,
  path: readonly PathSegment[] | string,
  value: unknown,
): boolean {
  const segments = typeof path === 'string' ? parsePath(path) : path;
  if (segments === null || segments.length === 0) return false;
  let current: unknown = scope;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index] as PathSegment;
    if (current === null || typeof current !== 'object') return false;
    const next = Array.isArray(current)
      ? current[segment as number]
      : (current as Record<string, unknown>)[segment as string];
    if (next === undefined || next === null || typeof next !== 'object') return false;
    current = next;
  }
  const last = segments[segments.length - 1] as PathSegment;
  if (current === null || typeof current !== 'object') return false;
  if (Array.isArray(current) && typeof last === 'number') {
    current[last] = value;
    return true;
  }
  if (!Array.isArray(current)) {
    (current as Record<string, unknown>)[last as string] = value;
    return true;
  }
  return false;
}

function isLiteralText(text: string): boolean {
  return (
    NUMBER_LITERAL.test(text) ||
    BOOLEAN_LITERAL.test(text) ||
    NULL_LITERAL.test(text) ||
    QUOTED_LITERAL.test(text)
  );
}

/** 解析字面量文本 */
export function parseLiteral(text: string): { matched: boolean; value?: unknown } {
  const trimmed = text.trim();
  if (NUMBER_LITERAL.test(trimmed)) return { matched: true, value: Number(trimmed) };
  if (BOOLEAN_LITERAL.test(trimmed)) return { matched: true, value: trimmed === 'true' };
  if (NULL_LITERAL.test(trimmed)) return { matched: true, value: null };
  const quoted = QUOTED_LITERAL.exec(trimmed);
  if (quoted) return { matched: true, value: quoted[1] ?? quoted[2] ?? '' };
  return { matched: false };
}

const TEMPLATE_PATTERN = /\$\{([^}]*)\}/g;

/** 是否为整串模板（`${a.b}`，不含其它字符） */
export function isPureTemplate(text: string): boolean {
  const trimmed = text.trim();
  const match = /^\$\{([^}]*)\}$/.exec(trimmed);
  return match !== null;
}

/**
 * 解析表达式：
 * - 整串模板 `${a.b}` → 返回原始类型值（不做字符串化）
 * - 混合模板 `你好 ${a.b}` → 返回插值后的字符串
 * - 纯路径 `a.b` → 读值
 * - 字面量 `123` / `'x'` → 对应字面量
 * - 其余 → 原样返回
 */
export function resolveExpression(text: string, scope: Record<string, unknown> = {}): unknown {
  const trimmed = text.trim();
  const pure = /^\$\{([^}]*)\}$/.exec(trimmed);
  if (pure) {
    const inner = (pure[1] ?? '').trim();
    const literal = parseLiteral(inner);
    if (literal.matched) return literal.value;
    const segments = parsePath(inner);
    return segments === null ? undefined : readPath(scope, segments);
  }
  if (trimmed.includes('${')) return resolveTemplate(trimmed, scope);
  const literal = parseLiteral(trimmed);
  if (literal.matched) return literal.value;
  const segments = parsePath(trimmed);
  if (segments !== null) {
    const value = readPath(scope, segments);
    return value === undefined ? trimmed : value;
  }
  return trimmed;
}

/** 模板插值：`${a.b}` 与 `{{a.b}}` 均支持 */
export function resolveTemplate(text: string, scope: Record<string, unknown> = {}): string {
  return text
    .replace(TEMPLATE_PATTERN, (_match, inner: string) =>
      stringify(resolveExpression(inner, scope)),
    )
    .replace(/\{\{\s*([^}]*?)\s*\}\}/g, (_match, inner: string) =>
      stringify(resolveExpression(inner, scope)),
    );
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** 把字面量或路径渲染为表达式文本（写入 DSL 时使用） */
export function toExpression(
  input: { kind: 'path'; value: string } | { kind: 'literal'; value: unknown },
): string {
  if (input.kind === 'path') return input.value;
  const value = input.value;
  if (typeof value === 'string') return `'${value.replace(/'/g, "\\'")}'`;
  if (value === null || value === undefined) return 'null';
  return String(value);
}

/** 收集文本中引用的全部路径（引用检查用） */
export function collectExpressionPaths(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(TEMPLATE_PATTERN)) {
    const inner = (match[1] ?? '').trim();
    if (parsePath(inner) !== null) out.push(inner);
  }
  // 非模板文本：仅在形态像标识符路径（以 ASCII 字母 / 下划线开头）时按路径处理，
  // 避免把「纯中文文案」误判成路径引用。
  const trimmed = text.trim();
  if (out.length === 0 && /^[A-Za-z_]/.test(trimmed) && parsePath(trimmed) !== null)
    out.push(trimmed);
  return out;
}
