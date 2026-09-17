/**
 * 记忆层级（Scope / Layer）定义与归属不变量。
 *
 * 数据库里 `scope` 只有五个值：longterm / project / feature / page / issue。
 * 但 PRD §2.1 的继承链是「长期 → 项目 → 功能 → 页面 → 元素备注」六级，
 * 其中「元素备注」不是独立 scope，而是 **scope=page 且 element_id 非空** 的条目。
 * 因此对外暴露两个概念：
 *
 * - `MemoryScope`：落库值，与 DDL 一致，用于 SQL 过滤；
 * - `MemoryLayer`：解析层级，用于继承排序与"下层覆盖上层"的判定。
 */

/* ------------------------------- Scope ------------------------------- */

export const MEMORY_SCOPES = ['longterm', 'project', 'feature', 'page', 'issue'] as const;

export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const SCOPE_LABELS: Record<MemoryScope, string> = {
  longterm: '长期记忆',
  project: '项目记忆',
  feature: '功能记忆',
  page: '页面记忆',
  issue: '问题记忆',
};

/* ------------------------------- Layer ------------------------------- */

/**
 * 继承层级：索引越大越具体、优先级越高（下层覆盖上层）。
 * issue 排在最后：问题记忆是"当前正在处理的具体缺陷"，上下文里应最后给出、优先级最高。
 */
export const MEMORY_LAYERS = ['longterm', 'project', 'feature', 'page', 'element', 'issue'] as const;

export type MemoryLayer = (typeof MEMORY_LAYERS)[number];

export const LAYER_ORDER: Record<MemoryLayer, number> = {
  longterm: 0,
  project: 1,
  feature: 2,
  page: 3,
  element: 4,
  issue: 5,
};

export const LAYER_LABELS: Record<MemoryLayer, string> = {
  longterm: '长期记忆',
  project: '项目记忆',
  feature: '功能记忆',
  page: '页面记忆',
  element: '元素备注',
  issue: '问题记忆',
};

/** 记忆条目的归属字段（与 memory_item 的五个归属列一一对应） */
export interface MemoryOwnership {
  project_id: string | null;
  feature_id: string | null;
  page_id: string | null;
  element_id: string | null;
  issue_id: string | null;
}

/**
 * 层级推导的入参形状。
 * 同时接受领域字段（elementId）与落库字段（element_id）：
 * 领域对象与数据行都会调用本函数，若只认一种命名，另一种会被静默当成 page 层——
 * 这类"看起来生效、实际串层"的缺陷极难排查，因此在类型层面就一并声明。
 */
export interface LayerInput {
  scope: MemoryScope;
  elementId?: string | null | undefined;
  element_id?: string | null | undefined;
}

/** 由条目落库字段 / 领域字段推导解析层级 */
export function layerOf(item: LayerInput): MemoryLayer {
  const element = item.elementId ?? item.element_id ?? null;
  if (item.scope === 'page' && element) return 'element';
  return item.scope;
}

/** 判断 layer a 是否为 layer b 的祖先（更靠上、更通用） */
export function isAncestorLayer(a: MemoryLayer, b: MemoryLayer): boolean {
  return LAYER_ORDER[a] < LAYER_ORDER[b];
}

/* --------------------------- 归属不变量 --------------------------- */

export type MemoryViolationCode = 'MISSING_OWNER' | 'UNEXPECTED_OWNER' | 'CROSS_PROJECT' | 'MISSING_ISSUE_ID';

export interface MemoryViolation {
  code: MemoryViolationCode;
  field: keyof MemoryOwnership;
  message: string;
}

const OWNER_FIELDS: readonly (keyof MemoryOwnership)[] = [
  'project_id',
  'feature_id',
  'page_id',
  'element_id',
  'issue_id',
];

/** 各 scope 允许出现的归属字段（未列出者必须为空） */
const ALLOWED_OWNERS: Record<MemoryScope, readonly (keyof MemoryOwnership)[]> = {
  longterm: [],
  project: ['project_id'],
  feature: ['project_id', 'feature_id'],
  page: ['project_id', 'feature_id', 'page_id', 'element_id'],
  issue: ['project_id', 'feature_id', 'page_id', 'element_id', 'issue_id'],
};

/** 各 scope 必须存在的归属字段 */
const REQUIRED_OWNERS: Record<MemoryScope, readonly (keyof MemoryOwnership)[]> = {
  longterm: [],
  project: ['project_id'],
  feature: ['project_id', 'feature_id'],
  page: ['project_id', 'page_id'],
  issue: ['project_id', 'issue_id'],
};

function has(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.length > 0;
}

/**
 * 校验归属字段是否合法。
 * 返回空数组表示合法；不抛错，便于 UI 就地标注违规项。
 */
export function validateOwnership(scope: MemoryScope, ownership: Partial<MemoryOwnership>): MemoryViolation[] {
  const violations: MemoryViolation[] = [];
  const allowed = ALLOWED_OWNERS[scope];

  for (const field of OWNER_FIELDS) {
    const filled = has(ownership[field]);
    // longterm 的 project_id 由下方专门给出更明确的提示，这里跳过避免重复报错
    if (filled && !allowed.includes(field) && !(scope === 'longterm' && field === 'project_id')) {
      violations.push({
        code: 'UNEXPECTED_OWNER',
        field,
        message: `${SCOPE_LABELS[scope]}不应携带 ${field}`,
      });
    }
  }

  for (const field of REQUIRED_OWNERS[scope]) {
    if (!has(ownership[field])) {
      violations.push({
        code: 'MISSING_OWNER',
        field,
        message: `${SCOPE_LABELS[scope]}必须指定 ${field}`,
      });
    }
  }

  // longterm 空 project_id 是硬要求（PRD §6.2 明确标注）
  if (scope === 'longterm' && has(ownership.project_id)) {
    violations.push({
      code: 'UNEXPECTED_OWNER',
      field: 'project_id',
      message: '长期记忆跨项目生效，project_id 必须为空',
    });
  }

  return violations;
}

/** 归属合法性（布尔便捷形式） */
export function isValidOwnership(scope: MemoryScope, ownership: Partial<MemoryOwnership>): boolean {
  return validateOwnership(scope, ownership).length === 0;
}

/**
 * 归属警告：不影响写入，但提示"这条记忆挂得太靠上，可能命中不了"。
 * 例：问题记忆没有关联页面/元素/功能时，无法在对应上下文自动生效（FR-MEM-16）。
 */
export function ownershipWarnings(scope: MemoryScope, ownership: Partial<MemoryOwnership>): string[] {
  if (scope !== 'issue') return [];
  if (has(ownership.page_id) || has(ownership.element_id) || has(ownership.feature_id)) return [];
  return ['问题记忆未关联页面/元素/功能，无法在具体上下文中自动生效，建议补充关联'];
}

/** 归属键：用于"同一上下文"判重与分组（空值统一为 '-'） */
export function ownershipKeyOf(ownership: Partial<MemoryOwnership>): string {
  return OWNER_FIELDS.map((field) => ownership[field] ?? '-').join('|');
}

/** 当前 scope 在继承链上需要一并携带的上层归属（用于查询候选集） */
export function ancestorOwnerships(ownership: Partial<MemoryOwnership>): Array<Partial<MemoryOwnership>> {
  const project = ownership.project_id ?? null;
  const feature = ownership.feature_id ?? null;
  const page = ownership.page_id ?? null;
  const element = ownership.element_id ?? null;

  const chain: Array<Partial<MemoryOwnership>> = [{ project_id: null, feature_id: null, page_id: null, element_id: null, issue_id: null }];
  if (project) chain.push({ project_id: project, feature_id: null, page_id: null, element_id: null, issue_id: null });
  if (project && feature)
    chain.push({ project_id: project, feature_id: feature, page_id: null, element_id: null, issue_id: null });
  if (project && page)
    chain.push({ project_id: project, feature_id: feature, page_id: page, element_id: null, issue_id: null });
  // 元素备注：页面记忆 + element_id；同时向上携带同页面的页面级记忆
  if (project && page && element)
    chain.push({ project_id: project, feature_id: feature, page_id: page, element_id: element, issue_id: null });
  return chain;
}
