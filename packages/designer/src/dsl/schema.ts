import { z } from 'zod';

import type { DslIssue, PageDsl } from './types';
import { ACTION_KINDS, ANCHOR_KINDS, NOTE_KINDS, PLATFORMS, STATE_TYPES } from './types';
import { walkElements } from './traverse';

/**
 * PageDSL 的 zod 校验 + 结构不变量（T3-01 要点 3）。
 *
 * 分工：
 * - zod 负责**形状**（类型、必填、枚举、递归 children）；
 * - `checkDslInvariants()` 负责**跨字段不变量**（id 唯一、嵌套深度 ≤8、锚点/备注引用有效）。
 *
 * 注意：受 TS `exactOptionalPropertyTypes` 限制，zod 推导出的可选字段类型为 `T | undefined`，
 * 无法直接等价到领域类型的 `key?: T`，因此解析出口处做一次显式断言（见 `parsePageDsl`）。
 */

export const MAX_NESTING_DEPTH = 8;

const platformSchema = z.enum(PLATFORMS);
const stateTypeSchema = z.enum(STATE_TYPES);
const actionKindSchema = z.enum(ACTION_KINDS);
const noteKindSchema = z.enum(NOTE_KINDS);
const anchorKindSchema = z.enum(ANCHOR_KINDS);

export const actionNodeSchema = z.object({
  id: z.string().min(1),
  kind: actionKindSchema,
  target: z.string().optional(),
  value: z.unknown().optional(),
  params: z.record(z.unknown()).optional(),
  async: z.boolean().optional(),
  next: z.string().nullable().optional(),
  branchTrue: z.string().nullable().optional(),
  branchFalse: z.string().nullable().optional(),
  label: z.string().optional(),
});

/** 结构化条件表达式（与 `shared/condition` 的 ConditionExpr 对齐；不使用 eval） */
export const conditionExprSchema: z.ZodTypeAny = z.lazy(() =>
  z.union([
    z.object({ op: z.enum(['and', 'or']), items: z.array(conditionExprSchema) }),
    z.object({ op: z.literal('not'), item: conditionExprSchema }),
    z.object({
      op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'startsWith', 'endsWith']),
      left: z.string(),
      right: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    }),
    z.object({ op: z.enum(['truthy', 'falsy', 'empty']), left: z.string() }),
    z.object({
      op: z.literal('in'),
      left: z.string(),
      right: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
    }),
  ]),
);

/** 权限规则（FR-DSG-04） */
export const permissionRuleSchema = z.object({
  mode: z.enum(['visible', 'editable']),
  roles: z.array(z.string()),
  condition: conditionExprSchema.nullable().optional(),
});

export const eventDefSchema = z.object({
  id: z.string().min(1),
  trigger: z.string().min(1),
  elementId: z.string().nullable().optional(),
  entry: z.string().nullable().optional(),
  actions: z.array(actionNodeSchema),
});

export const pageStateVarSchema = z.object({
  name: z.string().min(1),
  type: stateTypeSchema,
  initial: z.unknown().optional(),
  source: z.enum(['local', 'api']).optional(),
  apiRef: z.string().nullable().optional(),
  description: z.string().optional(),
});

export const masterRefSchema = z.object({
  masterId: z.string().min(1),
  detached: z.boolean().optional(),
  overrides: z
    .object({
      props: z.record(z.unknown()).optional(),
      style: z.record(z.unknown()).optional(),
    })
    .optional(),
});

/** 组件树（递归）：children 自引用 */
export const elementNodeSchema: z.ZodTypeAny = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    type: z.string().min(1),
    name: z.string().optional(),
    props: z.record(z.unknown()).optional(),
    style: z.record(z.unknown()).optional(),
    bindings: z.record(z.string()).optional(),
    children: z.array(elementNodeSchema).optional(),
    noteId: z.string().nullable().optional(),
    featureRef: z.string().nullable().optional(),
    locked: z.boolean().optional(),
    hidden: z.boolean().optional(),
    masterRef: masterRefSchema.nullable().optional(),
    responsive: z.record(z.record(z.unknown())).optional(),
    condition: conditionExprSchema.nullable().optional(),
    permission: permissionRuleSchema.nullable().optional(),
  }),
);

export const pageNoteSchema = z.object({
  id: z.string().min(1),
  target: z.enum(['element', 'page', 'feature']),
  targetId: z.string().min(1),
  kind: noteKindSchema,
  content: z.string(),
  resolved: z.boolean().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const codeAnchorSchema = z.object({
  id: z.string().min(1),
  elementId: z.string().min(1),
  pageId: z.string().min(1),
  featureId: z.string().nullable().optional(),
  filePath: z.string().min(1),
  symbol: z.string().min(1),
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
  kind: anchorKindSchema,
  commitSha: z.string().nullable().optional(),
});

export const viewportSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  presetId: z.string().optional(),
});

export const pageDslSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1),
  platform: platformSchema,
  route: z.string().startsWith('/'),
  featureId: z.string().nullable().optional(),
  viewport: viewportSchema,
  state: z.array(pageStateVarSchema),
  tree: elementNodeSchema,
  events: z.array(eventDefSchema),
  apiDeps: z.array(z.string()),
  notes: z.array(pageNoteSchema),
  anchors: z.record(codeAnchorSchema),
});

export class DslValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`PageDSL 校验失败：${issues.join('；')}`);
    this.name = 'DslValidationError';
    this.issues = issues;
  }
}

function formatPath(path: readonly (string | number)[]): string {
  if (path.length === 0) return '<root>';
  return path
    .map((segment) => (typeof segment === 'number' ? `[${segment}]` : `.${segment}`))
    .join('');
}

/** 形状校验：不抛异常，返回判定结果 */
export function validatePageDsl(
  input: unknown,
): { ok: true; value: PageDsl } | { ok: false; issues: string[] } {
  const parsed = pageDslSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${formatPath(issue.path)}: ${issue.message}`,
    );
    return { ok: false, issues };
  }
  const value = parsed.data as unknown as PageDsl;
  const invariantIssues = checkDslInvariants(value);
  if (invariantIssues.length > 0) {
    return { ok: false, issues: invariantIssues.map((issue) => issue.message) };
  }
  return { ok: true, value };
}

/** 形状 + 不变量校验，失败抛 `DslValidationError` */
export function parsePageDsl(input: unknown): PageDsl {
  const result = validatePageDsl(input);
  if (!result.ok) throw new DslValidationError(result.issues);
  return result.value;
}

/** 收集组件树中所有节点（前序）+ index 路径；实现见 `traverse.ts`，此处转发导出 */
export { walkElements } from './traverse';
export type { WalkedNode } from './traverse';

/**
 * 结构不变量检查（跨字段）：
 * 1. 元素 id 全局唯一
 * 2. 嵌套深度 ≤ `MAX_NESTING_DEPTH`（根为第 1 层）
 * 3. 悬空的 noteId / 锚点 elementId 引用
 * 4. 事件入口节点与连线指向必须存在
 * 5. 路由参数（view 层不校验，此处只做路径形态）
 */
export function checkDslInvariants(dsl: PageDsl): DslIssue[] {
  const issues: DslIssue[] = [];
  const walked = walkElements(dsl.tree);

  const seen = new Map<string, number>();
  for (const { node, indexPath, depth } of walked) {
    const count = (seen.get(node.id) ?? 0) + 1;
    seen.set(node.id, count);
    if (count === 2) {
      issues.push({
        code: 'DUPLICATE_ELEMENT_ID',
        message: `元素 id 重复：${node.id}（首处 ${formatPath(indexPath)}）`,
        elementId: node.id,
      });
    }
    if (depth + 1 > MAX_NESTING_DEPTH) {
      issues.push({
        code: 'NESTING_TOO_DEEP',
        message: `嵌套深度超过 ${MAX_NESTING_DEPTH} 层：${node.id} 位于第 ${depth + 1} 层`,
        elementId: node.id,
      });
    }
    if (
      node.noteId !== undefined &&
      node.noteId !== null &&
      !dsl.notes.some((note) => note.id === node.noteId)
    ) {
      issues.push({
        code: 'DANGLING_NOTE',
        message: `元素 ${node.id} 引用了不存在的备注 ${node.noteId}`,
        elementId: node.id,
      });
    }
  }

  for (const [elementId, anchor] of Object.entries(dsl.anchors)) {
    if (!seen.has(elementId)) {
      issues.push({
        code: 'DANGLING_ANCHOR',
        message: `锚点 ${anchor.id} 指向不存在的元素 ${elementId}`,
        elementId,
      });
    }
  }

  const elementIds = new Set(seen.keys());
  for (const event of dsl.events) {
    if (
      event.elementId !== undefined &&
      event.elementId !== null &&
      !elementIds.has(event.elementId)
    ) {
      issues.push({
        code: 'DANGLING_EVENT_TARGET',
        message: `事件 ${event.id} 绑定到不存在的元素 ${event.elementId}`,
      });
    }
    const actionIds = new Set(event.actions.map((action) => action.id));
    const entry = event.entry ?? event.actions[0]?.id;
    if (entry !== undefined && entry !== null && !actionIds.has(entry)) {
      issues.push({
        code: 'DANGLING_FLOW_ENTRY',
        message: `事件 ${event.id} 的入口节点 ${entry} 不存在`,
      });
    }
    for (const action of event.actions) {
      for (const link of [action.next, action.branchTrue, action.branchFalse]) {
        if (link !== undefined && link !== null && !actionIds.has(link)) {
          issues.push({
            code: 'DANGLING_FLOW_LINK',
            message: `事件 ${event.id} 的动作 ${action.id} 连向不存在的节点 ${link}`,
          });
        }
      }
    }
  }

  return issues;
}
