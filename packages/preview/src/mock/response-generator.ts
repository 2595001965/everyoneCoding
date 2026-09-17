/**
 * 响应生成器：依据路由 schema 生成示例响应体，再叠加字段规则；并支持"纯示例"生成。
 */

import type { JsonSchemaLike, OpenApiRoute } from './openapi-loader';
import { type MockSettings, applyFieldRules, countRuleHits, randomString } from './rules';
import { planFault } from './fault-injection';

export interface MockResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  delayMs: number;
  ruleHits: number;
}

export interface MockGenerateInput {
  route: OpenApiRoute;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  path?: string;
}

function genUuid(rng: () => number): string {
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 32; i++) s += hex[Math.floor(rng() * 16)]!;
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

function genString(schema: JsonSchemaLike, rng: () => number): string {
  const fmt = schema.format;
  if (fmt === 'date-time') {
    const t = Date.parse('2023-01-01') + rng() * (Date.parse('2025-01-01') - Date.parse('2023-01-01'));
    return new Date(t).toISOString();
  }
  if (fmt === 'date') return new Date(Date.parse('2023-01-01') + rng() * 86400000 * 30).toISOString().slice(0, 10);
  if (fmt === 'email') return `user${Math.floor(rng() * 100000)}@example.com`;
  if (fmt === 'uuid') return genUuid(rng);
  const len = typeof schema.maxLength === 'number' ? schema.maxLength : 8;
  return randomString(rng, Math.min(64, Math.max(1, len)));
}

function genNumber(schema: JsonSchemaLike, rng: () => number): number {
  const min = typeof schema.minimum === 'number' ? schema.minimum : 0;
  const max = typeof schema.maximum === 'number' ? schema.maximum : 100;
  let v = min + rng() * (max - min);
  if (schema.type === 'integer' || schema.integer === true) v = Math.floor(v);
  return v;
}

/** 依据 schema 生成值：object/array/string/number/boolean/enum/format/const/default/nullable */
export function generateFromSchema(
  schema: JsonSchemaLike,
  rng: () => number,
  _refs: Map<string, JsonSchemaLike>,
  depth = 0,
): unknown {
  if (depth > 8) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[Math.floor(rng() * schema.enum.length)]!;
  }
  const type = schema.type;
  if (type === 'object' || (schema.properties && !type)) {
    const out: Record<string, unknown> = {};
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(props)) out[k] = generateFromSchema(v, rng, _refs, depth + 1);
    return out;
  }
  if (type === 'array' || schema.items) {
    const arr: unknown[] = [];
    for (let i = 0; i < 2; i++) arr.push(generateFromSchema(schema.items ?? {}, rng, _refs, depth + 1));
    return arr;
  }
  if (type === 'string') return genString(schema, rng);
  if (type === 'number' || type === 'integer' || schema.integer === true) return genNumber(schema, rng);
  if (type === 'boolean') return rng() > 0.5;
  if (schema.nullable === true && rng() < 0.3) return null;
  return null;
}

export class MockResponseGenerator {
  private settingsValue: MockSettings;
  private readonly rng: () => number;

  constructor(opts?: { settings?: MockSettings; clock?: () => number; rng?: () => number }) {
    this.settingsValue = opts?.settings ?? { rules: [], delayMs: 0, errorRate: 0, errorStatus: 500 };
    this.rng = opts?.rng ?? Math.random;
  }

  updateSettings(patch: Partial<MockSettings>): void {
    this.settingsValue = { ...this.settingsValue, ...patch };
  }

  settings(): MockSettings {
    return this.settingsValue;
  }

  generate(input: MockGenerateInput): MockResponse {
    const settings = this.settingsValue;
    const fault = planFault(settings, this.rng);
    const delayMs = fault.delayMs;
    if (fault.status !== null) {
      return {
        status: fault.status,
        headers: { 'content-type': 'application/json' },
        body: fault.body,
        delayMs,
        ruleHits: 0,
      };
    }
    const base = generateFromSchema(input.route.responseSchema ?? {}, this.rng, new Map());
    const body = applyFieldRules(base, settings.rules, this.rng);
    const ruleHits = countRuleHits(base, settings.rules);
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body,
      delayMs,
      ruleHits,
    };
  }

  /** 依据 schema 生成示例体（不含规则/延迟/错误率），供"示例响应"展示 */
  sample(schema: JsonSchemaLike | null): unknown {
    if (!schema) return null;
    return generateFromSchema(schema, this.rng, new Map());
  }
}
