import type { ChatMessage } from '../core/message';
import type { AiPurpose } from '../domain/purpose-binding';

/**
 * 上下文引擎的共享类型（T4-02 / T4-03）。
 *
 * 为什么单独一个文件：block 实现（`context/blocks/*`）与引擎（`context-engine`）互相引用，
 * 把契约放在第三方文件可避免循环导入；同时本文件是**浏览器安全的纯类型 + 常量**，
 * 不引入 Node IO / SQLite / React。
 *
 * 与 `@ec/memory`、`@ec/designer` 的关系：一律走端口（{@link ContextSources}）。
 * 上下文引擎**不 import 它们的根入口** —— 记忆包会传递依赖 better-sqlite3，
 * 设计器包会传递依赖 React，任何一侧被静态引入都会污染另一侧的构建产物。
 */

/* ------------------------------ 块标识 ------------------------------ */

export const CONTEXT_BLOCK_IDS = [
  'instruction',
  'longterm',
  'project',
  'feature',
  'page',
  'element-chain',
  'note',
  'issue',
  'document',
  'code',
  'dependency-contract',
] as const;

export type ContextBlockId = (typeof CONTEXT_BLOCK_IDS)[number];

/** 单条块内条目（裁剪、面板展开、省略报告都以它为最小单位） */
export interface ContextBlockItem {
  /** 稳定键（记忆 id / 锚点 id / 文档章节键 / 备注 id） */
  key: string;
  /** 面向用户的条目名 */
  label: string;
  /** 该条目的估算 token */
  tokens: number;
  /**
   * 块内排序权重（越大越先保留）：
   * - 记忆：`importance × confidence`（并叠加时间衰减）
   * - 代码：Code Anchor 命中度
   * - 文档：标题匹配 + 关键词命中
   * - 备注：禁止事项置顶 + priority
   */
  weight: number;
  /** 渲染后的片段文本（块内裁剪后用剩余条目重建 content） */
  text: string;
}

/** 一类上下文块（严格对齐 FR-AI-01 的八类 + 指令 / 依赖契约两类工程块） */
export interface ContextBlock {
  id: ContextBlockId;
  /** 中文标签（面板展示） */
  label: string;
  /** 组装优先级：越大越先保留（T4-03 裁剪顺序由它决定） */
  priority: number;
  /** 建议配额（token 上限，非硬预算） */
  quota: number;
  /** 实际估算 token */
  tokens: number;
  /** 已渲染的提示词片段 */
  content: string;
  /** 来源描述（"项目记忆 12 条 / 双路召回"） */
  source: string;
  /** 面板是否可勾选 / 可编辑 */
  editable: boolean;
  /** 被省略的条目数（T4-03 填写） */
  omittedCount?: number | undefined;
  /** 优雅跳过的原因（端口未接入 / 无数据） */
  skipped?: string | undefined;
  /** 块内条目（面板展开与块内裁剪的依据） */
  items: ContextBlockItem[];
}

/* ------------------------------ 数据端口 ------------------------------ */

/** 与 @ec/memory 的 MemoryScope 对齐（此处重复声明以避免跨包依赖） */
export const CONTEXT_MEMORY_SCOPES = [
  'longterm',
  'project',
  'feature',
  'page',
  'element',
  'issue',
] as const;
export type ContextMemoryScope = (typeof CONTEXT_MEMORY_SCOPES)[number];

/** 记忆命中（外壳适配 @ec/memory 的 HybridHit / MemoryItem） */
export interface ContextMemoryHit {
  id: string;
  scope: ContextMemoryScope;
  title: string;
  content: string;
  /** 结构化摘要（接口清单、路由表等），面板可折叠展示 */
  structured?: unknown;
  /** 1–5 */
  importance: number;
  /** 0–1 */
  confidence: number;
  tags?: readonly string[];
  updatedAt: number;
}

export interface ContextMemoryQuery {
  userId: string;
  projectId: string;
  scope: ContextMemoryScope;
  query: string;
  limit: number;
  /**
   * 目标归属（可选）：页面 / 元素 / 功能。
   *
   * 为什么必须有：`scope='page'` 的记忆条目是**每页一条**（`memory_item.page_id` 区分），
   * 只给 `projectId` 会让「页面记忆」块把整个项目的页面记忆全塞进来 —— 既超配额，
   * 也让模型拿到别的页面的骨架。外壳据此把查询收敛到当前页面。
   * 缺省（undefined / null）表示「该层级不限归属」，由外壳实现自行决定是列举还是忽略。
   */
  pageId?: string | null | undefined;
  elementId?: string | null | undefined;
  featureId?: string | null | undefined;
}

/** 记忆端口（外壳适配 @ec/memory 的双路召回与分层列举） */
export interface ContextMemoryPort {
  /** 双路召回：相关度排序 */
  search(
    input: ContextMemoryQuery,
  ): readonly ContextMemoryHit[] | Promise<readonly ContextMemoryHit[]>;
  /** 无检索能力时的兜底列举（按重要度） */
  listByScope?(
    input: Omit<ContextMemoryQuery, 'query'>,
  ): readonly ContextMemoryHit[] | Promise<readonly ContextMemoryHit[]>;
  /**
   * 检索能力自述（块面板的"来源"文案）。
   *
   * 存在的理由：默认文案是「双路召回」，而当外壳只装配了关键词检索（未配置
   * embedding / sqlite-vec）时，面板仍写「双路召回」就是**把降级伪装成完整能力**。
   * 外壳如实回答自己实际用了哪条路，块来源才可信。
   */
  describe?(): string;
}

/** 备注（结构对齐 @ec/designer 的 `ContextNote`，鸭子类型即可赋值） */
export interface ContextNoteLike {
  id: string;
  targetType: 'element' | 'page' | 'feature';
  targetId: string;
  type: string;
  typeLabel: string;
  mustFollow: boolean;
  priority: number;
  text: string;
  version: number;
  updatedAt: number;
}

export interface ContextNoteTargetRef {
  projectId: string;
  elementId?: string | null;
  pageId?: string | null;
  featureId?: string | null;
}

/** 备注端口（外壳适配 `NoteRepository.getNotesForContext`） */
export interface ContextNoteSource {
  getNotesForContext(target: ContextNoteTargetRef): readonly ContextNoteLike[];
  /** 生成前判断「备注是否已更新」 */
  noteIdsUpdatedSince?(target: ContextNoteTargetRef, since: number): readonly string[];
}

/** 元素链上的一个节点（根 → 选中元素） */
export interface ContextElementNode {
  id: string;
  type: string;
  name?: string | undefined;
  /** 已裁剪的属性（只保留影响后端契约的字段：绑定 / 校验 / 事件） */
  props?: Record<string, unknown> | undefined;
  bindings?: Record<string, string> | undefined;
  /** 条件渲染 / 权限规则的结构化摘要 */
  conditionSummary?: string | undefined;
  permissionSummary?: string | undefined;
}

export interface ContextPageSummary {
  pageId: string;
  name: string;
  route: string;
  platform: string;
  /** 页面状态变量摘要 */
  state?: readonly { name: string; type: string; description?: string }[];
  /** 页面依赖的接口 id */
  apiDeps?: readonly string[];
}

/** 设计器端口（外壳适配 PageDsl / editor store） */
export interface ContextElementSource {
  /** 从根到选中元素的祖先链（含自身），顺序为根在前 */
  getElementChain(input: { projectId: string; elementId: string }): readonly ContextElementNode[];
  getPageSummary?(input: { projectId: string; pageId: string }): ContextPageSummary | null;
}

/** 文档片段（FR-AI-01 第 ⑦ 类：需求 / 技术文档相关章节） */
export interface ContextDocumentSnippet {
  id: string;
  documentId: string;
  title: string;
  kind: 'requirement' | 'techdoc' | 'other';
  /** 命中的章节标题 */
  heading?: string;
  content: string;
  /** 相关度 0–1 */
  score?: number;
}

export interface ContextDocumentPort {
  searchRelevant(input: {
    projectId: string;
    query: string;
    kinds?: readonly ContextDocumentSnippet['kind'][];
    limit: number;
  }): readonly ContextDocumentSnippet[] | Promise<readonly ContextDocumentSnippet[]>;
}

/** 已有代码命中（含 Code Anchor） */
export interface ContextCodeHit {
  anchorId?: string;
  filePath: string;
  symbol: string;
  kind: string;
  startLine: number;
  endLine: number;
  language: string;
  snippet: string;
  /** Code Anchor 命中度 0–1（T4-03 按它排序截断） */
  score: number;
}

export interface ContextCodePort {
  findRelated(input: {
    projectId: string;
    elementId?: string | null;
    query: string;
    symbols?: readonly string[];
    limit: number;
  }): readonly ContextCodeHit[] | Promise<readonly ContextCodeHit[]>;
}

/** S5 逐个生成时注入的已生成依赖的**接口契约摘要**（T5-06 共用） */
export interface DependencyContract {
  /** 依赖节点名（如 'UserService'） */
  name: string;
  /** 契约种类 */
  kind: 'controller' | 'service' | 'dto' | 'repo' | 'sql' | 'test' | 'route';
  filePath: string;
  /** 接口签名摘要（只保留对外可调用面，不注入实现） */
  summary: string;
  /** 关键类型定义（可选） */
  types?: readonly string[];
}

/** 全部数据端口（缺谁就优雅跳过对应块） */
export interface ContextSources {
  memory?: ContextMemoryPort | undefined;
  notes?: ContextNoteSource | undefined;
  elements?: ContextElementSource | undefined;
  documents?: ContextDocumentPort | undefined;
  code?: ContextCodePort | undefined;
  /** 时钟注入（测试可控） */
  clock?: (() => number) | undefined;
}

/* ------------------------------ 组装请求 ------------------------------ */

export interface ContextAssemblyRequest {
  userId: string;
  projectId: string;
  /** 用途（决定预算档位与提示词模板） */
  purpose: AiPurpose;
  /** 本次生成目标，写入指令块（如 'backend-code'） */
  target?: string | undefined;
  elementId?: string | null | undefined;
  pageId?: string | null | undefined;
  featureId?: string | null | undefined;
  /** 用户补充指令（FR-PIPE-12） */
  instruction?: string | undefined;
  /** 多轮历史（指令 + 历史 ≤16k） */
  history?: readonly ChatMessage[] | undefined;
  /** 面板取消勾选的块 */
  disabledBlocks?: readonly ContextBlockId[] | undefined;
  /** 面板就地编辑后的块内容（块 id → 覆盖文本） */
  overrides?: Readonly<Record<string, string>> | undefined;
  /** 覆盖总预算 */
  budget?: number | undefined;
  /** 生成开始时间（与备注 updatedAt 对比，判断「备注已更新」） */
  since?: number | undefined;
}

/** 组装结果 */
export interface AssembledContext {
  blocks: ContextBlock[];
  /** 系统提示词（角色 + 输出契约 + 强约束 + 上下文正文） */
  system: string;
  /** 用户消息（任务指令 + 补充要求） */
  user: string;
  /** 可直接交给 Gateway 的消息数组（system → 历史 → user） */
  messages: ChatMessage[];
  totalTokens: number;
  budget: number;
  /** 组装耗时（毫秒） */
  tookMs: number;
  /** 省略报告（无省略时为 null） */
  truncation: TruncateReport | null;
  /** 已注入的备注 id（生成结果页标注「已遵循备注 #id」） */
  noteIds: string[];
  /** 已注入的记忆 id（decision.referencedMemory） */
  memoryIds: string[];
  /** 跳过的块与原因 */
  skipped: { block: ContextBlockId; reason: string }[];
  /** 是否使用了激进裁剪（超限重试路径） */
  aggressive: boolean;
}

/** 省略原因（与 truncate-report 的 OmitReason 同源，此处声明以避免循环依赖） */
export type OmitReason =
  'block-over-quota' | 'block-over-budget' | 'aggressive-trim' | 'block-disabled';

/** 被省略的条目（省略报告的最小单位） */
export interface OmittedItemShape {
  block: ContextBlockId;
  blockLabel: string;
  label: string;
  tokens: number;
  reason: OmitReason;
  /** 被省略内容摘要（点击展开查看） */
  preview: string;
}

/** 省略报告（实现在 truncate-report.ts） */
export interface TruncateReport {
  omittedCount: number;
  omittedTokens: number;
  items: OmittedItemShape[];
  beforeTokens: number;
  afterTokens: number;
  aggressive: boolean;
  summary: string;
  /** 按原因汇总，便于 UI 分组说明 */
  byReason: Record<OmitReason, number>;
}

/* ------------------------------ 工具 ------------------------------ */

/** 中文字符计 1、其他按 3 字符计 1 的轻量近似（与实际 tokenizer 误差 ≤15%，仅用于预算） */
export function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (/[\u2e80-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(char)) cjk += 1;
    else other += 1;
  }
  return Math.max(1, Math.round(cjk * 1.0 + other * 0.3));
}

/** 把条目数组渲染为块正文 */
export function renderItems(items: readonly ContextBlockItem[]): string {
  return items.map((item) => item.text).join('\n\n');
}

export function blockTokens(items: readonly ContextBlockItem[], header = ''): number {
  return estimateTextTokens(header) + items.reduce((sum, item) => sum + item.tokens, 0);
}

/* ------------------------------ 块构造 ------------------------------ */

/** 单个 block 构建器的入参（十类块共用同一签名） */
export interface BlockBuildContext {
  request: ContextAssemblyRequest;
  sources: ContextSources;
  /** 检索用查询串（由指令 + 元素名 + 页面名拼成） */
  query: string;
  /** 已注入的依赖接口契约（T5-06 逐个生成时注入） */
  contracts: readonly DependencyContract[];
  clock: () => number;
}

export type ContextBlockBuilder = (
  context: BlockBuildContext,
) => ContextBlock | Promise<ContextBlock>;

export interface ComposeBlockInput {
  id: ContextBlockId;
  label: string;
  priority: number;
  quota: number;
  /** 来源描述（面板展示） */
  source: string;
  items: ContextBlockItem[];
  /** 端口未接入 / 无数据时的跳过原因；给出时 items 应为空 */
  skipped?: string | undefined;
  /** 面板是否可编辑 */
  editable?: boolean;
}

/**
 * 组装一个块。
 *
 * 约定：`content` **只包含条目正文**，不含小节标题 ——
 * 小节标题由引擎在渲染系统提示词时统一用 `label` 生成（`## 元素备注`），
 * 这样块内裁剪重建 content 时不会丢失 / 重复标题。
 */
export function composeBlock(input: ComposeBlockInput): ContextBlock {
  const content = renderItems(input.items);
  const block: ContextBlock = {
    id: input.id,
    label: input.label,
    priority: input.priority,
    quota: input.quota,
    tokens: content.length === 0 ? 0 : estimateTextTokens(content),
    content,
    source: input.source,
    editable: input.editable ?? true,
    items: input.items,
  };
  if (input.skipped !== undefined) block.skipped = input.skipped;
  return block;
}

/** 端口缺失时的空块（source 仍如实说明「未接入」，面板据此显示引导） */
export function unavailableBlock(input: {
  id: ContextBlockId;
  label: string;
  priority: number;
  quota: number;
  reason: string;
}): ContextBlock {
  return composeBlock({
    id: input.id,
    label: input.label,
    priority: input.priority,
    quota: input.quota,
    source: '未接入',
    items: [],
    skipped: input.reason,
  });
}
