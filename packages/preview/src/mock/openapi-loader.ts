/**
 * OpenAPI 文档加载：自动识别 JSON / YAML，解析 #/components/schemas/X 本地 $ref
 * （含 allOf 合并），路径参数归一，并对外提供路由匹配与兜底 spec。
 *
 * 不引入任何第三方 YAML 依赖：内置一个够用的 YAML 子集解析器（parseYamlSubset），
 * 支持缩进映射、`key: value`、`- item` 序列、引号字符串、内联 [] / {} 流集合。
 */

import type { HttpMethodName } from '../models';

export interface JsonSchemaLike {
  type?: string;
  properties?: Record<string, JsonSchemaLike>;
  items?: JsonSchemaLike;
  enum?: unknown[];
  format?: string;
  required?: string[];
  example?: unknown;
  $ref?: string;
  default?: unknown;
  allOf?: JsonSchemaLike[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  nullable?: boolean;
  integer?: boolean;
}

export interface OpenApiRoute {
  method: HttpMethodName;
  path: string;
  operationId: string | null;
  summary: string | null;
  requestSchema: JsonSchemaLike | null;
  responseSchema: JsonSchemaLike | null;
  tags: string[];
}

export interface LoadedOpenApi {
  title: string;
  version: string;
  routes: OpenApiRoute[];
  warnings: string[];
}

export class OpenApiParseError extends Error {}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/* ----------------------------- YAML 子集解析 ----------------------------- */

interface YNode {
  indent: number;
  text: string;
}

function stripComment(s: string): string {
  let inStr = false;
  let q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (c === q) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      q = c;
      continue;
    }
    if (c === '#' && (i === 0 || s[i - 1] === ' ' || s[i - 1] === '\t')) {
      return s.slice(0, i);
    }
  }
  return s;
}

function isItem(text: string): boolean {
  const t = text.trimStart();
  return t === '-' || t.startsWith('- ');
}

function isMapStart(content: string): boolean {
  if (content.length === 0) return false;
  if (content.startsWith('"') || content.startsWith("'")) return false;
  if (content.startsWith('[') || content.startsWith('{')) return false;
  return /^[A-Za-z0-9_$.-]+:\s/.test(content);
}

function unquoteKey(key: string): string {
  if (key.length >= 2 && key.startsWith('"') && key.endsWith('"')) return key.slice(1, -1);
  if (key.length >= 2 && key.startsWith("'") && key.endsWith("'")) return key.slice(1, -1);
  return key;
}

function splitKey(text: string): { key: string; rest: string } {
  const m = text.match(/^([^:]+):(\s|$)/);
  if (m) {
    const g = m[1] ?? '';
    const key = unquoteKey(text.slice(0, g.length).trim());
    const rest = text.slice(g.length + 1).trim();
    return { key, rest };
  }
  const idx = text.indexOf(':');
  if (idx >= 0)
    return { key: unquoteKey(text.slice(0, idx).trim()), rest: text.slice(idx + 1).trim() };
  return { key: unquoteKey(text.trim()), rest: '' };
}

function unquote(s: string, q: string): string {
  if (q === '"') return s.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  return s.replace(/''/g, "'");
}

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let quote = '';
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      cur += c;
      if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
      cur += c;
      continue;
    }
    if (c === '[' || c === '{') depth += 1;
    if (c === ']' || c === '}') depth -= 1;
    if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim() !== '') out.push(cur);
  return out;
}

function parseValue(token: string): unknown {
  const t = token.trim();
  if (t === '' || t === '~' || t === 'null') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) return unquote(t.slice(1, -1), '"');
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) return unquote(t.slice(1, -1), "'");
  if (t.startsWith('[') && t.endsWith(']')) return parseFlowSeq(t);
  if (t.startsWith('{') && t.endsWith('}')) return parseFlowMap(t);
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) return Number(t);
  return t;
}

function parseFlowSeq(t: string): unknown[] {
  const inner = t.slice(1, -1).trim();
  if (inner === '') return [];
  return splitTop(inner).map((part) => parseValue(part));
}

function parseFlowMap(t: string): Record<string, unknown> {
  const inner = t.slice(1, -1).trim();
  const out: Record<string, unknown> = {};
  if (inner === '') return out;
  for (const part of splitTop(inner)) {
    const { key, rest } = splitKey(part);
    out[key] = parseValue(rest);
  }
  return out;
}

function asObj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function normalizeNodes(lines: YNode[]): YNode[] {
  const out: YNode[] = [];
  for (const node of lines) {
    const trimmed = node.text.trimStart();
    if (trimmed === '-' || trimmed.startsWith('- ')) {
      const content = trimmed.slice(1).replace(/^\s+/, '');
      if (!isMapStart(content)) {
        out.push(node);
        continue;
      }
      // `- key: value` → 拆成 `-`（空）与缩进 +2 的 `key: value`
      out.push({ indent: node.indent, text: '-' });
      out.push({ indent: node.indent + 2, text: content });
      continue;
    }
    out.push(node);
  }
  return out;
}

function parseMap(
  nodes: YNode[],
  start: number,
  indent: number,
): [Record<string, unknown>, number] {
  const obj: Record<string, unknown> = {};
  let i = start;
  const n = nodes.length;
  while (i < n) {
    const line = nodes[i]!;
    if (line.indent < indent) break;
    if (line.indent > indent) {
      i += 1;
      continue;
    }
    if (isItem(line.text)) break;
    const { key, rest } = splitKey(line.text);
    if (rest === '') {
      const next = nodes[i + 1];
      if (next && next.indent > indent) {
        const [v, ni] = parseBlock(nodes, i + 1, next.indent);
        obj[key] = v;
        i = ni;
      } else {
        obj[key] = null;
        i += 1;
      }
    } else {
      obj[key] = parseValue(rest);
      i += 1;
    }
  }
  return [obj, i];
}

function parseSeq(nodes: YNode[], start: number, indent: number): [unknown[], number] {
  const arr: unknown[] = [];
  let i = start;
  const n = nodes.length;
  while (i < n) {
    const line = nodes[i]!;
    if (line.indent < indent) break;
    if (line.indent !== indent) break;
    if (!isItem(line.text)) break;
    const content = line.text.trimStart().slice(1).replace(/^\s+/, '');
    if (content === '') {
      const next = nodes[i + 1];
      if (next && next.indent > indent) {
        const [v, ni] = parseBlock(nodes, i + 1, next.indent);
        arr.push(v);
        i = ni;
      } else {
        arr.push(null);
        i += 1;
      }
    } else if (isMapStart(content)) {
      const combined: YNode[] = [{ indent: indent + 2, text: content }, ...nodes.slice(i + 1)];
      const [v, nextIdx] = parseMap(combined, 0, indent + 2);
      arr.push(v);
      i += nextIdx;
    } else {
      arr.push(parseValue(content));
      i += 1;
    }
  }
  return [arr, i];
}

function parseBlock(nodes: YNode[], start: number, indent: number): [unknown, number] {
  const first = nodes[start];
  if (!first) return [null, start];
  if (isItem(first.text)) return parseSeq(nodes, start, indent);
  return parseMap(nodes, start, indent);
}

/** 够用的 YAML 子集解析器，供单测与 OpenAPI YAML 文档使用。 */
export function parseYamlSubset(text: string): unknown {
  const nodes: YNode[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let indent = 0;
    while (indent < rawLine.length && rawLine[indent] === ' ') indent += 1;
    const content = stripComment(rawLine.slice(indent));
    if (content.trim() === '') continue;
    if (content.trimStart().startsWith('#')) continue;
    nodes.push({ indent, text: content });
  }
  const normalized = normalizeNodes(nodes);
  const [value] = parseBlock(normalized, 0, 0);
  return value;
}

/* ----------------------------- $ref / allOf ----------------------------- */

function decodeRefSeg(seg: string): string {
  return seg.replace(/~1/g, '/').replace(/~0/g, '~');
}

function resolveRef(ref: string, root: Record<string, unknown>): unknown {
  const m = ref.match(/^#\/(.+)$/);
  if (!m) return {};
  const parts = (m[1] ?? '').split('/').map(decodeRefSeg);
  let cur: unknown = root;
  for (const p of parts) {
    if (typeof cur !== 'object' || cur === null) return {};
    cur = (cur as Record<string, unknown>)[p];
  }
  return typeof cur === 'object' && cur !== null ? cur : {};
}

function mergeSchemas(a: JsonSchemaLike, b: JsonSchemaLike): JsonSchemaLike {
  const properties = { ...(a.properties ?? {}), ...(b.properties ?? {}) };
  const required = [...(a.required ?? []), ...(b.required ?? [])];
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function derefSchema(node: unknown, root: Record<string, unknown>): JsonSchemaLike {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return {};
  const obj = node as Record<string, unknown>;
  if (typeof obj['$ref'] === 'string') {
    return derefSchema(resolveRef(obj['$ref'], root), root);
  }
  if (Array.isArray(obj['allOf'])) {
    let merged: JsonSchemaLike = {};
    for (const part of obj['allOf'] as unknown[]) {
      merged = mergeSchemas(merged, derefSchema(part, root));
    }
    if (typeof obj['properties'] === 'object' && obj['properties'] !== null) {
      const props = obj['properties'] as Record<string, unknown>;
      const baseProps = merged.properties ?? {};
      const outProps: Record<string, JsonSchemaLike> = {};
      for (const [k, v] of Object.entries(props)) outProps[k] = derefSchema(v, root);
      merged = { ...merged, properties: { ...baseProps, ...outProps } };
    }
    if (Array.isArray(obj['required'])) {
      const extra = (obj['required'] as unknown[]).filter(
        (x): x is string => typeof x === 'string',
      );
      merged = { ...merged, required: [...(merged.required ?? []), ...extra] };
    }
    return merged;
  }
  const out: JsonSchemaLike = {};
  if (typeof obj['type'] === 'string') out.type = obj['type'];
  if (typeof obj['format'] === 'string') out.format = obj['format'];
  if (Array.isArray(obj['enum'])) out.enum = obj['enum'];
  if (typeof obj['properties'] === 'object' && obj['properties'] !== null) {
    const props = obj['properties'] as Record<string, unknown>;
    const outProps: Record<string, JsonSchemaLike> = {};
    for (const [k, v] of Object.entries(props)) outProps[k] = derefSchema(v, root);
    out.properties = outProps;
  }
  if (typeof obj['items'] === 'object' && obj['items'] !== null)
    out.items = derefSchema(obj['items'], root);
  if (Array.isArray(obj['required'])) {
    out.required = (obj['required'] as unknown[]).filter((x): x is string => typeof x === 'string');
  }
  if (obj['example'] !== undefined) out.example = obj['example'];
  if (obj['default'] !== undefined) out.default = obj['default'];
  if (typeof obj['nullable'] === 'boolean') out.nullable = obj['nullable'];
  if (typeof obj['minimum'] === 'number') out.minimum = obj['minimum'];
  if (typeof obj['maximum'] === 'number') out.maximum = obj['maximum'];
  if (typeof obj['maxLength'] === 'number') out.maxLength = obj['maxLength'];
  return out;
}

/* ----------------------------- 构建 LoadedOpenApi ----------------------------- */

function extractRequestSchema(
  op: Record<string, unknown>,
  root: Record<string, unknown>,
): JsonSchemaLike | null {
  const rb = asObj(op['requestBody']);
  const content = asObj(rb?.['content']);
  const json = asObj(content?.['application/json']);
  if (!json) return null;
  const schema = json['schema'];
  return schema ? derefSchema(schema, root) : null;
}

function extractResponseSchema(
  op: Record<string, unknown>,
  root: Record<string, unknown>,
): JsonSchemaLike | null {
  const responses = asObj(op['responses']);
  if (!responses) return null;
  const r = asObj(responses['200']) ?? asObj(responses['201']) ?? asObj(responses['default']);
  if (!r) return null;
  const content = asObj(r['content']);
  const json = asObj(content?.['application/json']);
  if (!json) return null;
  const schema = json['schema'];
  return schema ? derefSchema(schema, root) : null;
}

function buildRoute(
  method: HttpMethodName,
  pathKey: string,
  op: Record<string, unknown>,
  root: Record<string, unknown>,
): OpenApiRoute {
  const operationId = typeof op['operationId'] === 'string' ? (op['operationId'] as string) : null;
  const summary = typeof op['summary'] === 'string' ? (op['summary'] as string) : null;
  const tags = Array.isArray(op['tags'])
    ? (op['tags'] as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  return {
    method,
    path: pathKey,
    operationId,
    summary,
    requestSchema: extractRequestSchema(op, root),
    responseSchema: extractResponseSchema(op, root),
    tags,
  };
}

function buildOpenApi(doc: Record<string, unknown>): LoadedOpenApi {
  const info = asObj(doc['info']);
  const title = typeof info?.['title'] === 'string' ? (info['title'] as string) : '未命名 API';
  const version = typeof info?.['version'] === 'string' ? (info['version'] as string) : '0.0.0';
  const paths = asObj(doc['paths']);
  const routes: OpenApiRoute[] = [];
  const warnings: string[] = [];
  if (paths) {
    for (const [pathKey, pathItem] of Object.entries(paths)) {
      const item = asObj(pathItem);
      if (!item) {
        warnings.push(`路径 ${pathKey} 不是对象`);
        continue;
      }
      for (const method of HTTP_METHODS) {
        const op = asObj(item[method]);
        if (!op) continue;
        routes.push(buildRoute(method.toUpperCase() as HttpMethodName, pathKey, op, doc));
      }
    }
  }
  return { title, version, routes, warnings };
}

export function parseOpenApiDocument(text: string): LoadedOpenApi {
  const trimmed = text.trimStart();
  let doc: unknown;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      doc = JSON.parse(text);
    } catch (e) {
      throw new OpenApiParseError(`JSON 解析失败：${(e as Error).message}`);
    }
  } else {
    doc = parseYamlSubset(text);
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new OpenApiParseError('OpenAPI 文档顶层必须是对象');
  }
  return buildOpenApi(doc as Record<string, unknown>);
}

/* ----------------------------- 路由匹配 ----------------------------- */

function matchPath(pattern: string, url: string): Record<string, string> | null {
  const pSegs = pattern.split('/').filter((s) => s !== '');
  const uSegs = url.split('/').filter((s) => s !== '');
  if (pSegs.length !== uSegs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pSegs.length; i++) {
    const ps = pSegs[i]!;
    const us = uSegs[i]!;
    if (ps.startsWith('{') && ps.endsWith('}')) {
      params[ps.slice(1, -1)] = decodeURIComponent(us);
    } else if (ps !== us) {
      return null;
    }
  }
  return params;
}

export function matchRoute(
  routes: readonly OpenApiRoute[],
  method: string,
  urlPath: string,
): { route: OpenApiRoute; params: Record<string, string> } | null {
  const m = method.toUpperCase();
  for (const route of routes) {
    if (route.method !== m) continue;
    const params = matchPath(route.path, urlPath);
    if (params) return { route, params };
  }
  return null;
}

/* ----------------------------- 兜底 spec ----------------------------- */

export function createFallbackOpenApi(): LoadedOpenApi {
  const healthSchema: JsonSchemaLike = {
    type: 'object',
    properties: { status: { type: 'string' }, time: { type: 'string', format: 'date-time' } },
  };
  const loginReq: JsonSchemaLike = {
    type: 'object',
    properties: { username: { type: 'string' }, password: { type: 'string' } },
    required: ['username', 'password'],
  };
  const loginRes: JsonSchemaLike = {
    type: 'object',
    properties: { token: { type: 'string' }, user: { type: 'string' } },
  };
  return {
    title: '内置兜底预览',
    version: '0.0.0',
    routes: [
      {
        method: 'GET',
        path: '/health',
        operationId: 'health',
        summary: '健康检查',
        requestSchema: null,
        responseSchema: healthSchema,
        tags: ['system'],
      },
      {
        method: 'POST',
        path: '/login',
        operationId: 'login',
        summary: '登录',
        requestSchema: loginReq,
        responseSchema: loginRes,
        tags: ['auth'],
      },
    ],
    warnings: [],
  };
}
