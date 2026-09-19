import { renderItems, type ContextBlock, type ContextBlockItem } from './context-types';
import { createAggressiveBudget, cutItemsByLimit, type TokenBudget } from './token-budget';
import {
  buildTruncateReport,
  summarizePreview,
  type OmitReason,
  type OmittedItem,
  type TruncateReport,
} from './truncate-report';

/**
 * 上下文裁剪（T4-03 要点 2）。
 *
 * 三段式流程：
 * 1. **块内配额裁剪**：任何一块超过自身配额，先按块内权重（记忆 importance×confidence、
 *    代码锚点命中度、文档相关度）截断，理由记为 `block-over-quota`；
 * 2. **总预算裁剪**：仍超预算时，按 `priority` **从低到高**整块让位；
 *    高优先级块在自己的配额内**永不因总预算被裁**；
 * 3. **激进裁剪**：模型返回 ContextLengthError 时，只保留元素链 + 备注 + 页面摘要，
 *    并压缩总预算到 32k 后重试一次（见 `aggressiveTrim`）。
 */

export interface TrimResult {
  /** 仍是组装顺序的块数组（内容已裁剪） */
  blocks: ContextBlock[];
  report: TruncateReport | null;
  totalTokens: number;
}

export function assembledTokens(blocks: readonly ContextBlock[]): number {
  return blocks.reduce((sum, block) => sum + block.tokens, 0);
}

function rebuild(
  block: ContextBlock,
  kept: ContextBlockItem[],
  extraOmitted: OmittedItem[],
): {
  block: ContextBlock;
  omitted: OmittedItem[];
} {
  const content = renderItems(kept);
  // tokens 一律由保留内容重新估算，绝不沿用裁剪前的数字（否则报告与预算会对不上）
  const estimated = kept.reduce((sum, item) => sum + item.tokens, 0);
  return {
    block: {
      ...block,
      items: kept,
      content,
      tokens: estimated,
      omittedCount: (block.omittedCount ?? 0) + extraOmitted.length,
    },
    omitted: extraOmitted,
  };
}

function omit(
  block: ContextBlock,
  items: readonly ContextBlockItem[],
  reason: OmitReason,
): OmittedItem[] {
  return items.map((item) => ({
    block: block.id,
    blockLabel: block.label,
    label: item.label,
    tokens: item.tokens,
    reason,
    preview: summarizePreview(item.text),
  }));
}

/** 第 1 段：块内配额裁剪 */
function enforceQuotas(
  blocks: readonly ContextBlock[],
  budget: TokenBudget,
): { blocks: ContextBlock[]; omitted: OmittedItem[] } {
  const omitted: OmittedItem[] = [];
  const next = blocks.map((block) => {
    // 未接入 / 无数据的块（tokens 为 0）无需裁剪
    if (block.tokens === 0) return block;
    const quota = budget.quotas[block.id];
    if (quota === undefined || quota.quota <= 0) {
      const dropped = omit(
        block,
        block.items,
        quota?.quota === 0 ? 'block-disabled' : 'block-over-quota',
      );
      omitted.push(...dropped);
      return { ...block, items: [], content: '', tokens: 0, omittedCount: block.items.length };
    }
    if (block.tokens <= quota.quota) return block;
    const { kept, omitted: droppedItems } = cutItemsByLimit(block.items, quota.quota);
    omitted.push(...omit(block, droppedItems, 'block-over-quota'));
    return rebuild(block, kept, []).block;
  });
  return { blocks: next, omitted };
}

/** 第 2 段：总预算裁剪（低优先级先让位） */
function enforceBudget(
  blocks: readonly ContextBlock[],
  budget: TokenBudget,
  omitted: OmittedItem[],
): ContextBlock[] {
  const next = [...blocks];
  let total = assembledTokens(next);
  if (total <= budget.total) return next;

  const candidates = next
    .map((block, index) => ({ block, index }))
    .filter((entry) => entry.block.tokens > 0 && budget.quotas[entry.block.id]?.trimmable !== false)
    .sort((a, b) => a.block.priority - b.block.priority);

  for (const entry of candidates) {
    if (total <= budget.total) break;
    const current = next[entry.index];
    if (current === undefined || current.tokens === 0) continue;
    omitted.push(...omit(current, current.items, 'block-over-budget'));
    total -= current.tokens;
    next[entry.index] = {
      ...current,
      items: [],
      content: '',
      tokens: 0,
      omittedCount: (current.omittedCount ?? 0) + current.items.length,
    };
  }
  return next;
}

export function trimToBudget(blocks: readonly ContextBlock[], budget: TokenBudget): TrimResult {
  const beforeTokens = assembledTokens(blocks);
  const phase1 = enforceQuotas(blocks, budget);
  const phase2 = enforceBudget(phase1.blocks, budget, phase1.omitted);
  const totalTokens = assembledTokens(phase2);
  const report =
    phase1.omitted.length === 0
      ? null
      : buildTruncateReport({
          items: phase1.omitted,
          beforeTokens,
          afterTokens: totalTokens,
          aggressive: false,
        });
  return { blocks: phase2, report, totalTokens };
}

/**
 * 激进裁剪：上下文超限后的兜底。
 * 严格按 T4-03 要点 3 只保留「元素链 + 备注 + 页面记忆」，其余整块丢弃。
 */
export function aggressiveTrim(
  blocks: readonly ContextBlock[],
  baseBudget: TokenBudget,
): TrimResult {
  const beforeTokens = assembledTokens(blocks);
  const kept: ContextBlock[] = [];
  const omitted: OmittedItem[] = [];

  for (const block of blocks) {
    if (
      block.id === 'instruction' ||
      block.id === 'element-chain' ||
      block.id === 'note' ||
      block.id === 'page'
    ) {
      kept.push(block);
      continue;
    }
    omitted.push(...omit(block, block.items, 'aggressive-trim'));
    kept.push({
      ...block,
      items: [],
      content: '',
      tokens: 0,
      omittedCount: (block.omittedCount ?? 0) + block.items.length,
    });
  }

  const budget = createAggressiveBudget(baseBudget);
  const phase1 = enforceQuotas(kept, budget);
  omitted.push(...phase1.omitted);
  const phase2 = enforceBudget(phase1.blocks, budget, []);
  const totalTokens = assembledTokens(phase2);

  return {
    blocks: phase2,
    report: buildTruncateReport({
      items: omitted,
      beforeTokens,
      afterTokens: totalTokens,
      aggressive: true,
    }),
    totalTokens,
  };
}
