/**
 * PageDSL 领域模型（PRD §M3 的 PageDSL / ElementNode，T3-01）。
 *
 * 设计约束：
 * - 字段与 PRD §M3「页面 DSL 核心结构（示意）」严格一致，另按后续任务需要做**可选扩展**
 *   （扩展字段一律可选，保证 `@ec/designer` 的 PageDsl 可结构化赋值给 `@ec/memory` 精简器
 *   的同名类型，无需适配层）。
 * - 命名遵循 D-10：`name` 为中文显示名，`id`/`type`/`bindings` 键为英文或拼音。
 * - 本文件只放类型与常量，不放任何 IO 或 React 依赖，可在 node 环境直接测试。
 */

import type { ConditionExpr, PermissionRule } from '../shared/condition';

/** 条件与权限类型在本层再导出，调用方无需跨到 `shared` 取类型 */
export type {
  ConditionExpr,
  PermissionRule,
  ConditionOp,
  ConditionComparisonOp,
  ConditionLiteral,
} from '../shared/condition';

/** 产物目标端（七端矩阵，FR-AI-13 / FR-DSG-01） */
export const PLATFORMS = [
  'web',
  'android',
  'ios',
  'harmonyos',
  'windows',
  'linux',
  'macos',
] as const;
export type Platform = (typeof PLATFORMS)[number];

/** 移动端与鸿蒙端需要安全区参数；桌面端需要窗口占位；Web 端无安全区。 */
export const MOBILE_PLATFORMS: readonly Platform[] = ['android', 'ios', 'harmonyos'];
export const DESKTOP_PLATFORMS: readonly Platform[] = ['windows', 'linux', 'macos'];

/** 页面状态变量类型（FR-DSG-08 / T3-08） */
export const STATE_TYPES = ['string', 'number', 'boolean', 'object', 'array'] as const;
export type StateType = (typeof STATE_TYPES)[number];

/** 页面级状态变量 */
export interface PageStateVar {
  name: string;
  type: StateType;
  initial?: unknown;
  /** local = 页面内维护；api = 由接口响应写入 */
  source?: 'local' | 'api';
  /** source=api 时关联的接口 id */
  apiRef?: string | null;
  description?: string;
}

/**
 * 动作种类（规范化后的五类，FR-DSG-08）。
 *
 * 与 `@ec/memory` 精简器的 `PageDslAction.kind` 取值保持一致（navigate/request/assign/notify/branch），
 * 因此页面 DSL 可直接喂给精简器；编辑器面板上分别显示为「跳转/请求/赋值/提示/条件分支」，
 * 面板使用的 `setState` / `toast` 属于等价别名，由 `normalizeActionKind()` 归一化。
 */
export const ACTION_KINDS = ['navigate', 'request', 'assign', 'notify', 'branch'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
/** 允许输入的别名（仅用于编辑器输入归一化） */
export type ActionKindInput = ActionKind | 'setState' | 'toast' | 'navigateTo' | 'call';

/** 动作节点：既可线性串联（next），也可条件分支（branchTrue/branchFalse，T3-09） */
export interface ActionNode {
  id: string;
  kind: ActionKind;
  /** 跳转目标路由 / 请求接口 id（与精简器的 target 对齐） */
  target?: string;
  /** 赋值内容或提示文案（与精简器的 value 对齐） */
  value?: unknown;
  /** 结构化参数：navigate 的路由参数、request 的入参映射、toast 的类型等 */
  params?: Record<string, unknown>;
  /** request 默认异步；其他动作默认同步 */
  async?: boolean;
  /** 顺序执行的下一个节点 */
  next?: string | null;
  /** kind=branch 时的真 / 假分支入口 */
  branchTrue?: string | null;
  branchFalse?: string | null;
  /** 节点图上显示的自定义标题 */
  label?: string;
}

/** 页面事件：触发器 + 动作流（T3-09 的节点图即 actions 数组 + next/branch 连线） */
export interface EventDef {
  id: string;
  /** 触发时机：click / dblclick / change / submit / mount / ... */
  trigger: string;
  /** 触发元素；页面级事件为空 */
  elementId?: string | null;
  /** 动作流入口节点 id（缺省为 actions[0]） */
  entry?: string | null;
  actions: ActionNode[];
}

/** 备注类型（正文由 T4-01 实现，设计器仅持有） */
export const NOTE_KINDS = ['todo', 'issue', 'idea', 'question'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

/** 页面 / 元素 / 功能级备注（FR-ANN，T4-01 落地） */
export interface PageNote {
  id: string;
  target: 'element' | 'page' | 'feature';
  targetId: string;
  kind: NoteKind;
  content: string;
  resolved?: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 代码锚点种类（PRD §6.2 `code_anchor.kind`） */
export const ANCHOR_KINDS = [
  'controller',
  'service',
  'dto',
  'repo',
  'sql',
  'test',
  'route',
] as const;
export type AnchorKind = (typeof ANCHOR_KINDS)[number];

/** 元素 → 后端代码位置映射（FR-NAV-04 / T4-06） */
export interface CodeAnchor {
  id: string;
  elementId: string;
  pageId: string;
  featureId?: string | null;
  filePath: string;
  symbol: string;
  startLine: number;
  endLine: number;
  kind: AnchorKind;
  commitSha?: string | null;
}

/** 母版引用（FR-DSG-10 / T3-11） */
export interface MasterRef {
  masterId: string;
  /** 已脱离的实例不再随母版同步 */
  detached?: boolean;
  /** 局部覆盖的属性 / 样式（脱离前允许差异） */
  overrides?: {
    props?: Record<string, unknown>;
    style?: Record<string, unknown>;
  };
}

/**
 * 组件树节点（PRD §M3 的 ElementNode）。
 *
 * 相对 PRD 示意的扩展字段全部可选：`name`（中文显示名，D-10）、
 * `featureRef`（分层沉淀用，T2-06）、`locked` / `hidden`（图层树，T3-06）、
 * `masterRef`（母版实例，T3-11）、`responsive`（断点差异属性，T3-11）。
 *
 * `responsive` 只存**与基线的差异属性**，不产生元素副本（FR-DSG-09）。
 */
export interface ElementNode {
  id: string;
  /** 组件类型，如 'Button' | 'Form'（在组件库中已注册） */
  type: string;
  /** 中文显示名（D-10） */
  name?: string;
  props?: Record<string, unknown>;
  style?: Record<string, unknown>;
  /** 属性 → 状态字段 / 接口字段 路径 */
  bindings?: Record<string, string>;
  children?: ElementNode[];
  noteId?: string | null;
  featureRef?: string | null;
  /** 锁定：画布不可选中，图层树显示锁标 */
  locked?: boolean;
  /** 隐藏：画布不渲染，但 DSL 保留节点 */
  hidden?: boolean;
  masterRef?: MasterRef | null;
  /** 断点 → 差异属性（key 为断点宽度字符串，如 '768'） */
  responsive?: Record<string, Record<string, unknown>>;
  /** 条件渲染表达式（FR-DSG-04：结构化条件树，不使用 eval） */
  condition?: ConditionExpr | null;
  /** 权限规则：可见 / 可编辑 + 角色条件（FR-DSG-04） */
  permission?: PermissionRule | null;
}

/** 视口预设（FR-DSG-01） */
export interface Viewport {
  width: number;
  height: number;
  /** 机型 / 断点预设 id，如 'ip15' / 'web-1440' */
  presetId?: string;
}

/** 页面 DSL 完整结构（PRD §M3） */
export interface PageDsl {
  id: string;
  projectId: string;
  name: string;
  platform: Platform;
  /** 路由路径，如 '/user/profile' */
  route: string;
  /** 归属功能 id（分层沉淀用） */
  featureId?: string | null;
  viewport: Viewport;
  state: PageStateVar[];
  tree: ElementNode;
  events: EventDef[];
  /** 依赖的接口 id 列表 */
  apiDeps: string[];
  notes: PageNote[];
  /** 元素 id → 代码锚点 */
  anchors: Record<string, CodeAnchor>;
}

/** 页面在内存中的完整记录（DSL + 文件位置与版本） */
export interface PageRecord {
  dsl: PageDsl;
  /** DSL 文件路径（相对工作区） */
  filePath: string;
  dslVersion: number;
}

/** 断点（响应式，FR-DSG-09 / T3-11） */
export const BREAKPOINTS = [1920, 1440, 768, 375] as const;
export type Breakpoint = (typeof BREAKPOINTS)[number];

/** DSL 中允许承载子节点的容器型组件（T3-04 的嵌套规则来源之一） */
export const CONTAINER_TYPES: readonly string[] = [
  'Container',
  'Form',
  'Modal',
  'Tabs',
  'Card',
  'Links',
  'NavBar',
  'Footer',
  'List',
  'Table',
];

/** 归一化动作种类：面板别名 → 规范值 */
export function normalizeActionKind(input: ActionKindInput): ActionKind {
  switch (input) {
    case 'setState':
      return 'assign';
    case 'toast':
      return 'notify';
    case 'navigateTo':
      return 'navigate';
    case 'call':
      return 'request';
    default:
      return input;
  }
}

/** 判断平台是否移动端 / 鸿蒙（需要安全区） */
export function isMobilePlatform(platform: Platform): boolean {
  return MOBILE_PLATFORMS.includes(platform);
}

/** 路由参数（FR-DSG-07） */
export interface RouteParam {
  name: string;
  type: 'string' | 'number' | 'boolean';
  required: boolean;
  /** 默认值（可选） */
  defaultValue?: unknown;
  description?: string;
}

/** 路由总表条目：由页面 DSL 自动生成，并写入项目记忆 `structured.routes` */
export interface RouteEntry {
  /** 规范化后的路由路径，如 '/user/profile' */
  path: string;
  pageId: string;
  pageName: string;
  platform: Platform;
  params: RouteParam[];
}

/** 路由表冲突 / 问题 */
export interface RouteIssue {
  code: 'DUPLICATE_PATH' | 'INVALID_PATH' | 'MISSING_PARAM';
  path: string;
  pageIds: string[];
  message: string;
  /** 冲突时的建议路径 */
  suggestion?: string;
}

/** DSL 结构不变量问题的编码（T3-01 要点 3） */ export type DslIssueCode =
  | 'DUPLICATE_ELEMENT_ID'
  | 'NESTING_TOO_DEEP'
  | 'DANGLING_NOTE'
  | 'DANGLING_ANCHOR'
  | 'DANGLING_EVENT_TARGET'
  | 'DANGLING_FLOW_ENTRY'
  | 'DANGLING_FLOW_LINK';

/** 结构不变量问题 */
export interface DslIssue {
  code: DslIssueCode;
  message: string;
  elementId?: string;
}
