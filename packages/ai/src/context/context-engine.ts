import { ContextLengthError } from '../core/error';
import { systemMessage, userMessage, type ChatMessage } from '../core/message';
import {
  estimateTextTokens,
  type AssembledContext,
  type BlockBuildContext,
  type ContextAssemblyRequest,
  type ContextBlock,
  type ContextBlockBuilder,
  type ContextBlockId,
  type ContextSources,
  type DependencyContract,
} from './context-types';
import { buildCodeBlock } from './blocks/code';
import { buildDependencyContractBlock } from './blocks/dependency-contract';
import { buildDocumentBlock } from './blocks/document';
import { buildElementChainBlock } from './blocks/element-chain';
import { buildFeatureBlock } from './blocks/feature';
import { buildIssueBlock } from './blocks/issue';
import { buildLongtermBlock } from './blocks/longterm';
import { buildNoteBlock } from './blocks/note';
import { buildPageBlock } from './blocks/page';
import { buildProjectBlock } from './blocks/project';
import { createTokenBudget, type TokenBudget } from './token-budget';
import { aggressiveTrim, assembledTokens, trimToBudget } from './trimmer';
import type { TruncateReport } from './truncate-report';

/**
 * 上下文组装引擎（T4-02）。
 *
 * 输入：一次生成请求（选中元素 + 用途 + 指令）与一组数据端口；
 * 输出：可直接投喂模型的 system / user 消息 + 每块 token 分布 + 省略报告 + 引用溯源。
 *
 * 三条设计约束：
 * 1. **八类块按 FR-AI-01 逐一实现，缺失时优雅跳过并记录原因**，绝不因为
 *    "端口没接"或"这一层没数据"而整体失败 —— 首次生成时几乎所有块都是空的；
 * 2. **配额与总预算分离**：先按块配额裁，再按优先级让位（T4-03 的 trimmer）；
 * 3. **提示词顺序遵循 PRD §13.2**：角色与输出契约前置 → 记忆由抽象到具体
 *    （长期 → 项目 → 功能 → 页面 → 元素链 → 备注）→ 代码与文档殿后；
 *    禁止事项单独抽成"必须遵守"小节前置强调（强约束句式）。
 */

/** 渲染顺序：越具体越靠后（PRD §13.2），与裁剪优先级是两个概念 */
export const CONTEXT_RENDER_ORDER: readonly ContextBlockId[] = [
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
];

/** 默认块构建器表（十类块 → 实现函数） */
export const DEFAULT_BLOCK_BUILDERS: Readonly<Record<ContextBlockId, ContextBlockBuilder>> = {
  instruction: (context) => buildInstructionBlock(context.request, context.contracts),
  longterm: buildLongtermBlock,
  project: buildProjectBlock,
  feature: buildFeatureBlock,
  page: buildPageBlock,
  'element-chain': buildElementChainBlock,
  note: buildNoteBlock,
  issue: buildIssueBlock,
  document: buildDocumentBlock,
  code: buildCodeBlock,
  'dependency-contract': buildDependencyContractBlock,
};

/* ------------------------------ 指令块 ------------------------------ */

const TARGET_LABELS: Record<string, string> = {
  requirement: '需求文档',
  interface: '界面 DSL',
  techdoc: '技术文档',
  'backend-code': '后端代码',
  'frontend-code': 'Web 前端代码',
  'mobile-code': '移动端代码',
  'harmony-code': '鸿蒙端代码',
  'desktop-code': '桌面端代码',
  'commit-msg': '提交信息',
};

/** 指令块：任务目标 + 用户补充指令 + 输出契约提醒（永不被裁剪） */
export function buildInstructionBlock(
  request: ContextAssemblyRequest,
  contracts: readonly DependencyContract[],
): ContextBlock {
  const lines: string[] = [];
  const target = request.target ?? request.purpose;
  lines.push(`本次生成目标：${TARGET_LABELS[target] ?? target}`);
  if (request.elementId !== null && request.elementId !== undefined)
    lines.push(`作用元素：${request.elementId}`);
  if (request.pageId !== null && request.pageId !== undefined)
    lines.push(`所属页面：${request.pageId}`);
  if (contracts.length > 0) {
    lines.push(
      `必须复用以下已生成依赖的接口签名，禁止臆造：${contracts.map((contract) => contract.name).join('、')}`,
    );
  }
  if (request.instruction !== undefined && request.instruction.trim().length > 0) {
    lines.push(`用户补充指令（优先级高于默认推断）：${request.instruction.trim()}`);
  }
  const text = lines.join('\n');

  return {
    id: 'instruction',
    label: '任务指令与输出契约',
    priority: 1_000,
    quota: 16_000,
    tokens: estimateTextTokens(text),
    content: text,
    source: '会话上下文',
    editable: true,
    items: [
      { key: 'task', label: '任务指令', tokens: estimateTextTokens(text), weight: 1_000, text },
    ],
  };
}

/* ------------------------------ 引擎 ------------------------------ */

export interface ContextEngineOptions {
  sources: ContextSources;
  /** 覆盖默认总预算 */
  budget?: number;
  /** 覆盖块构建器（测试注入假实现 / 后续任务替换） */
  builders?: Partial<Record<ContextBlockId, ContextBlockBuilder>>;
  /** 是否为某块禁用（返回 true 即跳过该块） */
  disabledBlocks?: readonly ContextBlockId[];
}

/** 从备注块中抽取「禁止事项」条目，作为硬约束前置注入 */
export function extractHardConstraints(blocks: readonly ContextBlock[]): string[] {
  const noteBlock = blocks.find((block) => block.id === 'note');
  if (noteBlock === undefined) return [];
  const lines: string[] = [];
  for (const item of noteBlock.items) {
    const forbidden = item.text.split('\n').find((line) => line.trim().startsWith('【禁止】'));
    if (forbidden !== undefined && !lines.includes(forbidden.trim())) lines.push(forbidden.trim());
  }
  return lines;
}

export interface AssembleWithRetryResult<T> {
  result: T;
  context: AssembledContext;
  /** 0 = 一次成功；1 = 触发激进裁剪后成功 */
  retries: number;
  aggressive: boolean;
}

export class ContextEngine {
  private readonly sources: ContextSources;
  private readonly budgetOverride: number | undefined;
  private readonly builders: Record<ContextBlockId, ContextBlockBuilder>;
  private contracts: DependencyContract[] = [];

  constructor(options: ContextEngineOptions) {
    this.sources = options.sources;
    this.budgetOverride = options.budget;
    this.builders = { ...DEFAULT_BLOCK_BUILDERS, ...(options.builders ?? {}) };
  }

  /** 注入已生成依赖的接口契约摘要（T5-06 逐个生成时调用） */
  setDependencyContracts(contracts: readonly DependencyContract[]): void {
    this.contracts = contracts.map((contract) => ({ ...contract }));
  }

  getDependencyContracts(): readonly DependencyContract[] {
    return this.contracts.map((contract) => ({ ...contract }));
  }

  /** 组装上下文（同步 + 异步端口统一 await） */
  async assemble(request: ContextAssemblyRequest): Promise<AssembledContext> {
    const started = Date.now();
    const budget = this.budgetFor(request);
    const buildContext: BlockBuildContext = {
      request,
      sources: this.sources,
      query: buildQuery(request, this.sources),
      contracts: this.contracts,
      clock: this.sources.clock ?? (() => Date.now()),
    };

    const ids = Object.keys(this.builders) as ContextBlockId[];
    const built = await Promise.all(ids.map(async (id) => this.buildOne(id, buildContext)));

    const prepared = built.map((block) => applyPanelEdits(block, request));
    // 硬约束在裁剪前抽取：预算可以砍掉备注块，但不能砍掉禁止事项
    const hardConstraints = extractHardConstraints(prepared);
    const trimmed = trimToBudget(prepared, budget);
    const { system, user } = renderPrompt(trimmed.blocks, request, { hardConstraints });

    const skipped: { block: ContextBlockId; reason: string }[] = [];
    for (const block of trimmed.blocks) {
      if (block.skipped !== undefined) skipped.push({ block: block.id, reason: block.skipped });
      if (block.omittedCount !== undefined && block.omittedCount > 0) {
        skipped.push({ block: block.id, reason: `已省略 ${block.omittedCount} 项` });
      }
    }

    return this.finalize({
      blocks: trimmed.blocks,
      system,
      user,
      request,
      budget,
      report: trimmed.report,
      totalTokens: trimmed.totalTokens,
      tookMs: Date.now() - started,
      aggressive: false,
      skipped,
    });
  }

  /**
   * 超限重试：模型返回 ContextLengthError 时自动做**激进裁剪**（仅元素链 + 备注 + 页面记忆）
   * 并重试一次；仍失败则抛出明确错误（T4-03 要点 4）。
   */
  async assembleWithRetry<T>(
    request: ContextAssemblyRequest,
    run: (context: AssembledContext) => Promise<T>,
  ): Promise<AssembleWithRetryResult<T>> {
    const context = await this.assemble(request);
    try {
      const result = await run(context);
      return { result, context, retries: 0, aggressive: false };
    } catch (error) {
      if (!(error instanceof ContextLengthError)) throw error;
    }

    const started = Date.now();
    const budget = this.budgetFor(request);
    const trimmed = aggressiveTrim(context.blocks, budget);
    const { system, user } = renderPrompt(trimmed.blocks, request, {
      hardConstraints: extractHardConstraints(context.blocks),
    });
    const aggressiveContext = this.finalize({
      blocks: trimmed.blocks,
      system,
      user,
      request,
      budget,
      report: trimmed.report,
      totalTokens: trimmed.totalTokens,
      tookMs: Date.now() - started,
      aggressive: true,
      skipped: context.skipped.filter((entry) => !entry.reason.startsWith('已省略')),
    });

    try {
      const result = await run(aggressiveContext);
      return { result, context: aggressiveContext, retries: 1, aggressive: true };
    } catch (error) {
      if (error instanceof ContextLengthError) {
        throw new ContextLengthError(
          `${error.message}（已完成激进裁剪仍超限：仅保留元素链与备注，建议缩短指令或改用上下文更长的模型）`,
          error.limit,
        );
      }
      throw error;
    }
  }

  private budgetFor(request: ContextAssemblyRequest): TokenBudget {
    const total = request.budget ?? this.budgetOverride;
    return createTokenBudget({
      purpose: request.purpose,
      ...(total !== undefined ? { total } : {}),
    });
  }

  private async buildOne(id: ContextBlockId, context: BlockBuildContext): Promise<ContextBlock> {
    const builder = this.builders[id];
    try {
      return await builder(context);
    } catch (error) {
      // 单个块失败不能拖垮整次组装：降级为空块并如实记录
      return {
        id,
        label: id,
        priority: 0,
        quota: 0,
        tokens: 0,
        content: '',
        source: '构建失败',
        editable: false,
        items: [],
        skipped: `块构建失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private finalize(input: {
    blocks: ContextBlock[];
    system: string;
    user: string;
    request: ContextAssemblyRequest;
    budget: TokenBudget;
    report: TruncateReport | null;
    totalTokens: number;
    tookMs: number;
    aggressive: boolean;
    skipped: { block: ContextBlockId; reason: string }[];
  }): AssembledContext {
    const noteIds = collectItemKeys(input.blocks, 'note');
    const memoryIds = input.blocks
      .filter(
        (block) =>
          block.id === 'longterm' ||
          block.id === 'project' ||
          block.id === 'feature' ||
          block.id === 'page' ||
          block.id === 'issue',
      )
      .flatMap((block) => block.items.map((item) => item.key))
      .filter((key) => !key.startsWith('page-facts:'));

    return {
      blocks: input.blocks,
      system: input.system,
      user: input.user,
      messages: buildMessages(input.system, input.user, input.request),
      totalTokens: input.totalTokens,
      budget: input.budget.total,
      tookMs: input.tookMs,
      truncation: input.report,
      noteIds,
      memoryIds,
      skipped: input.skipped,
      aggressive: input.aggressive,
    };
  }
}

export function createContextEngine(options: ContextEngineOptions): ContextEngine {
  return new ContextEngine(options);
}

/* ------------------------------ 内部工具 ------------------------------ */

function collectItemKeys(blocks: readonly ContextBlock[], id: ContextBlockId): string[] {
  const block = blocks.find((item) => item.id === id);
  return block === undefined ? [] : block.items.map((item) => item.key);
}

/** 面板勾选 / 就地编辑：在裁剪之前应用，保证「所见即所提交」 */
function applyPanelEdits(block: ContextBlock, request: ContextAssemblyRequest): ContextBlock {
  const disabled = request.disabledBlocks?.includes(block.id) ?? false;
  const override = request.overrides?.[block.id];

  if (disabled) {
    return {
      ...block,
      items: [],
      content: '',
      tokens: 0,
      omittedCount: block.items.length,
      skipped: '已被手动取消勾选',
    };
  }
  if (override === undefined) return block;

  const tokens = estimateTextTokens(override);
  return {
    ...block,
    content: override,
    tokens,
    items: [
      {
        key: `${block.id}:override`,
        label: `${block.label}（手动编辑）`,
        tokens,
        weight: 999,
        text: override,
      },
    ],
    source: `${block.source} · 已手动编辑`,
    omittedCount: block.items.length,
  };
}

/** 检索查询串：元素名 / 页面名 + 用户指令 + 目标类型 */
function buildQuery(request: ContextAssemblyRequest, sources: ContextSources): string {
  const parts: string[] = [];
  if (request.instruction !== undefined && request.instruction.trim().length > 0)
    parts.push(request.instruction.trim());
  if (request.target !== undefined) parts.push(TARGET_LABELS[request.target] ?? request.target);

  const elementId = request.elementId;
  if (elementId !== null && elementId !== undefined && sources.elements !== undefined) {
    const chain = sources.elements.getElementChain({ projectId: request.projectId, elementId });
    for (const node of chain) {
      if (node.name !== undefined && node.name.length > 0) parts.push(node.name);
      parts.push(node.type);
    }
  }
  if (request.pageId !== null && request.pageId !== undefined) parts.push(request.pageId);
  return parts.join(' ').trim();
}

/**
 * 渲染提示词（PRD §13.2）。
 *
 * 结构：
 * ```
 * # 角色与输出契约        ← 角色 + 硬性输出要求（结构化输出契约由 T4-04 的模板补齐）
 * # 必须遵守（硬约束）     ← 禁止事项抽出来前置强调
 * # 上下文
 *   ## 长期记忆 …
 *   ## 元素备注 …
 * ```
 */
export function renderPrompt(
  blocks: readonly ContextBlock[],
  request: ContextAssemblyRequest,
  options: { hardConstraints?: readonly string[] } = {},
): { system: string; user: string } {
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const instruction = byId.get('instruction');

  // 硬约束来自「禁止事项」备注，由调用方在裁剪**之前**抽取传入 ——
  // 硬约束不允许因为预算裁剪而消失。
  const hardConstraints = [...(options.hardConstraints ?? [])];

  const sections: string[] = [];
  for (const id of CONTEXT_RENDER_ORDER) {
    const block = byId.get(id);
    if (block === undefined || block.content.trim().length === 0) continue;
    sections.push(`## ${block.label}\n${block.content}`);
  }

  const head: string[] = [
    '你是 EveryoneCoding 的全栈代码生成助手。所有代码与数据库脚本只能由你产出；用户界面中的代码视图是只读的，不存在人工编辑通道。',
    '输出必须严格遵循本次调用声明的结构化契约；契约解析失败将被视为生成失败。',
    '变更说明、风险与未覆盖点必须一并给出，不得省略。',
  ];
  if (instruction !== undefined && instruction.content.trim().length > 0)
    head.push(instruction.content.trim());

  const system = [
    '# 角色与输出契约',
    head.join('\n'),
    '',
    '# 必须遵守（硬约束）',
    hardConstraints.length > 0
      ? hardConstraints.map((line) => `- ${line}`).join('\n')
      : '- 本次没有硬约束备注。',
    '',
    '# 上下文',
    sections.length > 0 ? sections.join('\n\n') : '（本次无可用上下文）',
  ].join('\n');

  const user = [
    `请按前述契约完成「${TARGET_LABELS[request.target ?? request.purpose] ?? request.purpose}」的生成。`,
    request.instruction !== undefined && request.instruction.trim().length > 0
      ? `补充要求：${request.instruction.trim()}`
      : '',
  ]
    .filter((line) => line.length > 0)
    .join('\n');

  return { system, user };
}

function buildMessages(
  system: string,
  user: string,
  request: ContextAssemblyRequest,
): ChatMessage[] {
  const history = request.history ?? [];
  return [systemMessage(system), ...history, userMessage(user)];
}

/** 诊断辅助：块的 token 分布（供性能基准与面板使用） */
export function tokenDistribution(blocks: readonly ContextBlock[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const block of blocks) result[block.id] = block.tokens;
  return result;
}

export { assembledTokens };
