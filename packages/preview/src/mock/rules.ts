/**
 * 字段规则：基于路径的假数据字段改写。
 *
 * 路径语法：
 * - `a.b`            嵌套对象字段
 * - `a[].b`          数组每个元素的 b 字段（each 标记）
 *
 * 所有随机性都走注入的 rng()，配合 settings.seed 可复现。
 */

export type FieldRuleKind =
  'random-string' | 'random-number' | 'enum' | 'date' | 'reference' | 'array-length' | 'constant';

export interface FieldRule {
  /** 目标字段路径，支持 a.b 与 a[].b（数组元素） */
  path: string;
  kind: FieldRuleKind;
  /** random-string 用 */
  length?: number;
  /** random-number 用 */
  min?: number;
  max?: number;
  integer?: boolean;
  /** enum / constant 用 */
  values?: string[];
  constant?: unknown;
  /** date 用 */
  from?: string;
  to?: string;
  format?: 'iso' | 'date' | 'epoch';
  /** reference 用：引用同一响应内其它字段路径 */
  refPath?: string;
  transform?: 'upper' | 'lower' | 'none';
  /** array-length 用 */
  count?: number;
}

export interface MockSettings {
  rules: FieldRule[];
  /** 固定延迟（ms）或区间 */
  delayMs: number | { min: number; max: number };
  errorRate: number; // 0..1
  errorStatus: number; // 默认 500
  seed?: number; // 可复现随机
}

export const DEFAULT_MOCK_SETTINGS: MockSettings = {
  rules: [],
  delayMs: 0,
  errorRate: 0,
  errorStatus: 500,
};

const RANDOM_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export function randomString(rng: () => number, length: number): string {
  const len = Math.max(1, Math.floor(length));
  let out = '';
  for (let i = 0; i < len; i++) out += RANDOM_CHARS[Math.floor(rng() * RANDOM_CHARS.length)]!;
  return out;
}

function randomDate(
  rng: () => number,
  from?: string,
  to?: string,
  format?: 'iso' | 'date' | 'epoch',
): string | number {
  const loRaw = from !== undefined ? Date.parse(from) : Date.parse('2020-01-01');
  const hiRaw = to !== undefined ? Date.parse(to) : Date.parse('2030-01-01');
  const lo = Number.isNaN(loRaw) ? Date.parse('2020-01-01') : loRaw;
  const hi = Number.isNaN(hiRaw) ? Date.parse('2030-01-01') : hiRaw;
  const t = lo + rng() * (hi - lo);
  const d = new Date(t);
  if (format === 'date') return d.toISOString().slice(0, 10);
  if (format === 'epoch') return Math.floor(t);
  return d.toISOString();
}

export type PathSegment = { kind: 'key'; name: string } | { kind: 'each' };

export function parsePath(path: string): PathSegment[] {
  const parts = path.split('.');
  const segs: PathSegment[] = [];
  for (const part of parts) {
    if (part.endsWith('[]')) {
      segs.push({ kind: 'key', name: part.slice(0, -2) });
      segs.push({ kind: 'each' });
    } else {
      segs.push({ kind: 'key', name: part });
    }
  }
  return segs;
}

export function getPath(root: unknown, segments: readonly PathSegment[]): unknown {
  let cur: unknown = root;
  for (const seg of segments) {
    if (seg.kind === 'each') {
      if (!Array.isArray(cur) || cur.length === 0) return undefined;
      cur = cur[0];
      continue;
    }
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[seg.name];
  }
  return cur;
}

export function pathExists(root: unknown, segments: readonly PathSegment[]): boolean {
  let cur: unknown = root;
  for (const seg of segments) {
    if (seg.kind === 'each') {
      if (!Array.isArray(cur) || cur.length === 0) return false;
      cur = cur[0];
      continue;
    }
    if (typeof cur !== 'object' || cur === null) return false;
    cur = (cur as Record<string, unknown>)[seg.name];
  }
  return cur !== undefined;
}

function applyTransform(value: unknown, transform?: 'upper' | 'lower' | 'none'): unknown {
  if (transform === undefined || transform === 'none') return value;
  if (typeof value !== 'string') return value;
  return transform === 'upper' ? value.toUpperCase() : value.toLowerCase();
}

function pick(values: readonly string[], rng: () => number): string {
  if (values.length === 0) return '';
  return values[Math.floor(rng() * values.length)]!;
}

function generateArray(count: number, rng: () => number): unknown[] {
  const n = Math.max(0, Math.floor(count));
  const arr: unknown[] = [];
  for (let i = 0; i < n; i++) arr.push(randomString(rng, 8));
  return arr;
}

function makeValue(value: unknown, rule: FieldRule, rng: () => number): unknown {
  switch (rule.kind) {
    case 'random-string':
      return applyTransform(randomString(rng, rule.length ?? 8), rule.transform);
    case 'random-number': {
      const min = rule.min ?? 0;
      const max = rule.max ?? 100;
      let v = min + rng() * (max - min);
      if (rule.integer) v = Math.floor(v);
      return v;
    }
    case 'enum':
      return applyTransform(pick(rule.values ?? [], rng), rule.transform);
    case 'date':
      return randomDate(rng, rule.from, rule.to, rule.format);
    case 'reference': {
      const ref = getPath(value, parsePath(rule.refPath ?? ''));
      return applyTransform(ref, rule.transform);
    }
    case 'array-length':
      return generateArray(rule.count ?? 0, rng);
    case 'constant':
      return applyTransform(rule.constant, rule.transform);
    default:
      return undefined;
  }
}

function setInto(
  current: unknown,
  segments: readonly PathSegment[],
  index: number,
  make: () => unknown,
): void {
  if (index >= segments.length) return;
  const seg = segments[index]!;
  const last = index === segments.length - 1;
  if (seg.kind === 'each') {
    if (Array.isArray(current)) {
      const childSegs = segments.slice(index + 1);
      if (childSegs.length === 0) {
        for (let i = 0; i < current.length; i++) current[i] = make();
      } else {
        for (const item of current) setInto(item, segments, index + 1, make);
      }
    }
    return;
  }
  if (typeof current !== 'object' || current === null) return;
  const obj = current as Record<string, unknown>;
  if (last) {
    obj[seg.name] = make();
    return;
  }
  setInto(obj[seg.name], segments, index + 1, make);
}

/** 依次应用全部字段规则，返回（原地改写的）值。 */
export function applyFieldRules(
  value: unknown,
  rules: readonly FieldRule[],
  rng: () => number,
): unknown {
  const result = value;
  for (const rule of rules) {
    setInto(result, parsePath(rule.path), 0, () => makeValue(result, rule, rng));
  }
  return result;
}

/** 统计有多少条规则命中了目标（父路径存在），供 MockResponse.ruleHits 使用。 */
export function countRuleHits(value: unknown, rules: readonly FieldRule[]): number {
  let hits = 0;
  for (const rule of rules) {
    const segs = parsePath(rule.path);
    const parentSegs = segs.slice(0, -1);
    if (pathExists(value, parentSegs)) hits += 1;
  }
  return hits;
}
