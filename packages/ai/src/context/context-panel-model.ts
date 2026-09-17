import {
  CONTEXT_BLOCK_IDS,
  type AssembledContext,
  type ContextAssemblyRequest,
  type ContextBlock,
  type ContextBlockId,
  type ContextBlockItem,
} from './context-types';
import { describeTruncation, type TruncateReport } from './truncate-report';

/**
 * 上下文面板视图模型（T4-02 要点 3：可视化"本次将提交什么"）。
 *
 * 面板与引擎之间的唯一契约：面板只读 {@link ContextPanelModel}，只写
 * {@link ContextPanelSelection}（勾选 / 就地编辑），再由 `applyPanelSelection`
 * 生成新的组装请求。三者分离的好处是面板组件零业务逻辑，可纯组件测试。
 */

export interface ContextPanelSelection {
  /** 取消勾选的块（含 instruction 时也允许，但引擎会在 UI 层提示后果） */
  disabledBlocks: ContextBlockId[];
  /** 就地编辑后的块内容（块 id → 文本） */
  overrides: Record<string, string>;
}

export interface ContextPanelItem {
  key: string;
  label: string;
  tokens: number;
  weight: number;
  /** 内容摘要（展开后查看；不返回全文以避免面板持有大对象） */
  preview: string;
  /** 备注条目：用它可以跳转 / 标注「已遵循备注 #id」（仅 note 块填写） */
  noteId?: string | undefined;
}

export interface ContextPanelBlock {
  id: ContextBlockId;
  label: string;
  tokens: number;
  quota: number;
  priority: number;
  source: string;
  editable: boolean;
  enabled: boolean;
  content: string;
  skipped?: string | undefined;
  omittedCount: number;
  /** 占本次总量的百分比（token 分布条宽度） */
  percent: number;
  items: ContextPanelItem[];
}

export interface ContextPanelModel {
  totalTokens: number;
  budget: number;
  usagePercent: number;
  /** 本次真正提交的块（tokens > 0） */
  blocks: ContextPanelBlock[];
  /** 所有块（含未提交 / 被跳过的，面板折叠区展示） */
  allBlocks: ContextPanelBlock[];
  truncation: TruncateReport | null;
  truncationSummary: string;
  noteIds: string[];
  memoryIds: string[];
  skipped: { block: ContextBlockId; reason: string }[];
  tookMs: number;
  aggressive: boolean;
  /** 面板顶部的告警条（超预算 / 有省略 / 块被禁用） */
  warnings: string[];
}

const PREVIEW_LIMIT = 160;

function preview(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > PREVIEW_LIMIT ? `${collapsed.slice(0, PREVIEW_LIMIT)}…` : collapsed;
}

function toPanelItem(item: ContextBlockItem, blockId: ContextBlockId): ContextPanelItem {
  const base: ContextPanelItem = {
    key: item.key,
    label: item.label,
    tokens: item.tokens,
    weight: Number(item.weight.toFixed(3)),
    preview: preview(item.text),
  };
  // 备注块条目带上 noteId，面板据此提供「跳到该备注」与生成结果页的溯源标注
  return blockId === 'note' ? { ...base, noteId: item.key } : base;
}

export function toContextPanelBlock(
  block: ContextBlock,
  totalTokens: number,
  selection: ContextPanelSelection,
): ContextPanelBlock {
  const disabled = selection.disabledBlocks.includes(block.id);
  const override = selection.overrides[block.id];
  const percent = totalTokens <= 0 ? 0 : Math.round((block.tokens / totalTokens) * 1000) / 10;
  return {
    id: block.id,
    label: block.label,
    tokens: block.tokens,
    quota: block.quota,
    priority: block.priority,
    source: override !== undefined ? `${block.source} · 已手动编辑` : block.source,
    editable: block.editable,
    enabled: !disabled,
    content: override ?? block.content,
    // 面板回答的是"本次将提交什么"：取消勾选后必须明确写出它不会提交，
    // 而不是沿用引擎里"有内容"的状态。
    skipped: disabled ? '已被手动取消勾选，本次不会提交' : block.skipped,
    omittedCount: block.omittedCount ?? 0,
    percent,
    items: block.items.map((item) => toPanelItem(item, block.id)),
  };
}

export function toContextPanelModel(
  context: AssembledContext,
  selection: ContextPanelSelection = { disabledBlocks: [], overrides: {} },
): ContextPanelModel {
  const allBlocks = context.blocks.map((block) => toContextPanelBlock(block, context.totalTokens, selection));
  const blocks = allBlocks.filter((block) => block.tokens > 0);

  const warnings: string[] = [];
  if (context.truncation !== null && context.truncation.omittedCount > 0) {
    warnings.push(describeTruncation(context.truncation));
  }
  if (context.totalTokens > context.budget) {
    warnings.push(`上下文 ${context.totalTokens} token 仍超出预算 ${context.budget}（请减少勾选或缩短指令）`);
  }
  const disabled = selection.disabledBlocks;
  if (disabled.length > 0) warnings.push(`已手动取消勾选 ${disabled.length} 个上下文块`);
  if (context.aggressive) warnings.push('本次为超限重试后的激进裁剪结果（仅保留元素链 + 备注 + 页面记忆）');

  return {
    totalTokens: context.totalTokens,
    budget: context.budget,
    usagePercent: context.budget <= 0 ? 0 : Math.round((context.totalTokens / context.budget) * 1000) / 10,
    blocks,
    allBlocks,
    truncation: context.truncation,
    truncationSummary: describeTruncation(context.truncation),
    noteIds: [...context.noteIds],
    memoryIds: [...context.memoryIds],
    skipped: context.skipped.map((entry) => ({ ...entry })),
    tookMs: context.tookMs,
    aggressive: context.aggressive,
    warnings,
  };
}

/** 空选择（面板初次渲染） */
export function emptySelection(): ContextPanelSelection {
  return { disabledBlocks: [], overrides: {} };
}

/** 面板勾选变化 → 新选择（不可变） */
export function toggleBlock(selection: ContextPanelSelection, id: ContextBlockId): ContextPanelSelection {
  const disabled = selection.disabledBlocks.includes(id)
    ? selection.disabledBlocks.filter((item) => item !== id)
    : [...selection.disabledBlocks, id];
  return { ...selection, disabledBlocks: disabled };
}

/** 面板就地编辑 → 新选择；文本与块原文一致时视为取消编辑 */
export function setBlockOverride(
  selection: ContextPanelSelection,
  id: ContextBlockId,
  text: string,
  original: string,
): ContextPanelSelection {
  const overrides = { ...selection.overrides };
  if (text === original) delete overrides[id];
  else overrides[id] = text;
  return { ...selection, overrides };
}

/** 选择 → 组装请求（供「重新组装」/「提交」） */
export function applyPanelSelection(
  request: ContextAssemblyRequest,
  selection: ContextPanelSelection,
): ContextAssemblyRequest {
  const hasOverrides = Object.keys(selection.overrides).length > 0;
  return {
    ...request,
    ...(selection.disabledBlocks.length > 0 ? { disabledBlocks: [...selection.disabledBlocks] } : {}),
    ...(hasOverrides ? { overrides: { ...selection.overrides } } : {}),
  };
}

/** token 分布行（面板柱状条 / 基准报告共用同一份数据） */
export interface TokenDistributionRow {
  id: ContextBlockId;
  label: string;
  tokens: number;
  percent: number;
  quota: number;
  overQuota: boolean;
}

export function tokenDistributionRows(model: ContextPanelModel): TokenDistributionRow[] {
  return model.allBlocks
    .map((block) => ({
      id: block.id,
      label: block.label,
      tokens: block.tokens,
      percent: model.totalTokens <= 0 ? 0 : Math.round((block.tokens / model.totalTokens) * 1000) / 10,
      quota: block.quota,
      overQuota: block.quota > 0 && block.tokens > block.quota,
    }))
    .sort((a, b) => b.tokens - a.tokens);
}

/** 块 id → 中文标签（面板里未参与本次组装的块也要能显示名字） */
export const CONTEXT_BLOCK_LABELS: Record<ContextBlockId, string> = {
  instruction: '任务指令与输出契约',
  longterm: '长期记忆',
  project: '项目记忆',
  feature: '功能记忆',
  page: '页面记忆',
  'element-chain': '元素及祖先链',
  note: '元素备注',
  issue: '关联问题记忆',
  document: '文档相关章节',
  code: '已有代码与锚点',
  'dependency-contract': '依赖接口契约',
};

/** 面板初始化：把「引擎里存在但本次没构建出内容」的块补齐为占位行 */
export function withPlaceholders(model: ContextPanelModel): ContextPanelModel {
  const known = new Set(model.allBlocks.map((block) => block.id));
  const missing = CONTEXT_BLOCK_IDS.filter((id) => !known.has(id));
  if (missing.length === 0) return model;
  const placeholders: ContextPanelBlock[] = missing.map((id) => ({
    id,
    label: CONTEXT_BLOCK_LABELS[id],
    tokens: 0,
    quota: 0,
    priority: 0,
    source: '—',
    editable: false,
    enabled: false,
    content: '',
    omittedCount: 0,
    percent: 0,
    items: [],
    skipped: '本次未构建',
  }));
  return { ...model, allBlocks: [...model.allBlocks, ...placeholders] };
}
