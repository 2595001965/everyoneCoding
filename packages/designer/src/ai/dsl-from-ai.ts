import type { ElementNode, PageDsl, Platform } from '../dsl/types';
import { PLATFORMS } from '../dsl/types';
import { walkElements } from '../dsl/traverse';
import { MAX_NESTING_DEPTH, validatePageDsl } from '../dsl/schema';
import { createElement, defaultViewportFor } from '../dsl/factory';
import { componentRegistry, type ComponentRegistry } from '../registry/component-registry';

/**
 * AI 生成结果 → 合法 PageDSL（T3-11 要点 2）。
 *
 * 职责：
 * 1. 从模型原始文本里稳健地抽出 JSON（容忍 ```json 代码块、前后寒暄）；
 * 2. 用组件白名单校验 —— 未知组件**降级为 Container 并提示**，而不是整份作废；
 * 3. 补齐 id / route / viewport 等必需字段，套用 zod + 结构不变量校验；
 * 4. 生成结果落到画布后**仍可自由编辑**（本函数只做校验与规整，不改动合法结构）。
 */

export type AiDslIssueKind = 'unknown-component' | 'depth-trimmed' | 'invalid-structure' | 'auto-filled';

export interface AiDslIssue {
  kind: AiDslIssueKind;
  message: string;
  elementId?: string;
}

export interface AiDslResult {
  dsl: PageDsl | null;
  issues: AiDslIssue[];
  /** 是否发生了降级处理（未知组件 / 深度裁剪） */
  degraded: boolean;
}

export interface DslFromAiContext {
  id: string;
  projectId: string;
  name: string;
  platform: Platform;
  route: string;
  /** 组件白名单来源；缺省用全局注册表（空注册表时不校验类型） */
  registry?: ComponentRegistry;
  /** 是否把未知组件降级为 Container（默认 true） */
  degradeUnknownComponents?: boolean;
}

/** 从模型输出文本里抽取 JSON 对象（容忍代码块包裹与前后说明文字） */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const body = fence?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(body);
  } catch {
    // 退回到「首个 { 到最后一个 }」
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 推断 AI 返回的原始形态：既支持完整 PageDsl，也支持「裸树」片段 */
export function normalizeCandidate(candidate: unknown, context: DslFromAiContext): Record<string, unknown> | null {
  if (!isRecord(candidate)) return null;
  // 兼容 { page: {...} } 信封
  if (isRecord(candidate['page'])) return normalizeCandidate(candidate['page'], context);

  const tree = isRecord(candidate['tree'])
    ? candidate['tree']
    : isRecord(candidate['root'])
      ? candidate['root']
      : null;
  // 显式给了 tree/root 但不是对象 → 视为模型输出不可用（调用方会重试 / 降级）
  const hasTreeKey = 'tree' in candidate || 'root' in candidate;
  if (hasTreeKey && tree === null) return null;

  const normalized: Record<string, unknown> = {
    id: typeof candidate['id'] === 'string' ? candidate['id'] : context.id,
    projectId: typeof candidate['projectId'] === 'string' ? candidate['projectId'] : context.projectId,
    name: typeof candidate['name'] === 'string' ? candidate['name'] : context.name,
    platform: typeof candidate['platform'] === 'string' ? candidate['platform'] : context.platform,
    route: typeof candidate['route'] === 'string' ? candidate['route'] : context.route,
    state: Array.isArray(candidate['state']) ? candidate['state'] : [],
    tree: tree ?? { id: `${context.id}-root`, type: 'Container', name: '页面', children: [] },
    events: Array.isArray(candidate['events']) ? candidate['events'] : [],
    apiDeps: Array.isArray(candidate['apiDeps']) ? candidate['apiDeps'] : [],
    notes: [],
    anchors: {},
  };
  // viewport 缺省时按平台推断，避免出现 `viewport: undefined` 把校验打挂
  normalized['viewport'] = isRecord(candidate['viewport'])
    ? candidate['viewport']
    : defaultViewportFor(
        typeof candidate['platform'] === 'string' && (PLATFORMS as readonly string[]).includes(candidate['platform'])
          ? (candidate['platform'] as Platform)
          : context.platform,
      );
  if (typeof candidate['featureId'] === 'string') normalized['featureId'] = candidate['featureId'];
  return normalized;
}

/** 递归规整组件树：未知类型降级、超深裁剪、字段类型纠正 */
function sanitizeTree(
  node: unknown,
  context: DslFromAiContext,
  issues: AiDslIssue[],
  allowedTypes: ReadonlySet<string> | null,
  depth: number,
): ElementNode | null {
  if (!isRecord(node)) return null;
  const rawType = typeof node['type'] === 'string' ? node['type'] : 'Container';
  let type = rawType;
  if (allowedTypes !== null && !allowedTypes.has(rawType)) {
    if (context.degradeUnknownComponents === false) {
      issues.push({ kind: 'unknown-component', message: `未知组件类型「${rawType}」，已跳过该节点` });
      return null;
    }
    type = 'Container';
    issues.push({ kind: 'unknown-component', message: `未知组件类型「${rawType}」已降级为容器（Container）` });
  }

  const id = typeof node['id'] === 'string' && node['id'].length > 0 ? node['id'] : `el-${Math.random().toString(36).slice(2, 8)}`;
  const element: ElementNode = { id, type };
  if (typeof node['name'] === 'string') element.name = node['name'];
  if (isRecord(node['props'])) element.props = node['props'];
  if (isRecord(node['style'])) element.style = node['style'];
  if (isRecord(node['bindings'])) {
    const bindings: Record<string, string> = {};
    for (const [key, value] of Object.entries(node['bindings'])) {
      if (typeof value === 'string') bindings[key] = value;
    }
    if (Object.keys(bindings).length > 0) element.bindings = bindings;
  }
  if (typeof node['featureRef'] === 'string') element.featureRef = node['featureRef'];

  const children = Array.isArray(node['children']) ? node['children'] : [];
  if (children.length > 0) {
    if (depth + 1 >= MAX_NESTING_DEPTH) {
      issues.push({
        kind: 'depth-trimmed',
        message: `嵌套超过 ${MAX_NESTING_DEPTH} 层，已裁剪 ${element.id} 的更深子节点`,
        elementId: element.id,
      });
    } else {
      const kept: ElementNode[] = [];
      for (const child of children) {
        const sanitized = sanitizeTree(child, context, issues, allowedTypes, depth + 1);
        if (sanitized !== null) kept.push(sanitized);
      }
      if (kept.length > 0) element.children = kept;
    }
  }
  return element;
}

/**
 * 把 AI 返回的候选结果校验/规整为合法 DSL。
 * 结构无法修复时返回 `dsl: null`（调用方据此走「重试一次 → 降级为文本生成」）。
 */
export function dslFromAi(candidate: unknown, context: DslFromAiContext): AiDslResult {
  const issues: AiDslIssue[] = [];

  if (candidate === null || candidate === undefined) {
    return { dsl: null, issues: [{ kind: 'invalid-structure', message: '模型返回内容为空或不是合法 JSON' }], degraded: false };
  }

  const registry = context.registry ?? componentRegistry;
  const types = registry.types();
  const allowedTypes = types.length > 0 ? new Set(types) : null;

  const normalized = normalizeCandidate(candidate, context);
  if (normalized === null) {
    return { dsl: null, issues: [{ kind: 'invalid-structure', message: '模型返回结构不可识别' }], degraded: false };
  }

  const tree = sanitizeTree(normalized['tree'], context, issues, allowedTypes, 0);
  if (tree === null) {
    return { dsl: null, issues: [...issues, { kind: 'invalid-structure', message: '组件树为空，无法落地' }], degraded: false };
  }

  const platform = normalized['platform'];
  const page = {
    ...normalized,
    tree,
    platform: typeof platform === 'string' && (PLATFORMS as readonly string[]).includes(platform) ? platform : context.platform,
  };

  const validation = validatePageDsl(page);
  if (!validation.ok) {
    return {
      dsl: null,
      issues: [
        ...issues,
        { kind: 'invalid-structure', message: `结构校验未通过：${validation.issues.slice(0, 5).join('；')}` },
      ],
      degraded: false,
    };
  }

  return {
    dsl: validation.value,
    issues,
    degraded: issues.some((issue) => issue.kind === 'unknown-component' || issue.kind === 'depth-trimmed'),
  };
}

/** 便捷：从模型原始文本一步得到结果 */
export function dslFromAiText(text: string, context: DslFromAiContext): AiDslResult {
  return dslFromAi(extractJson(text), context);
}

/** 统计生成结果规模（供 UI 展示"生成了 N 个元素"） */
export function countElements(dsl: PageDsl): number {
  return walkElements(dsl.tree).length;
}

/** 兜底：生成失败时新建一个空页，保证用户仍可继续手工设计 */
export function createFallbackDsl(context: DslFromAiContext): PageDsl {
  const root = createElement({ id: `${context.id}-root`, type: 'Container', name: '页面' });
  const result = dslFromAi(
    {
      id: context.id,
      projectId: context.projectId,
      name: context.name,
      platform: context.platform,
      route: context.route,
      tree: root,
    },
    context,
  );
  // 上面的输入必然合法，这里直接断言避免调用方再判空
  return result.dsl as PageDsl;
}
