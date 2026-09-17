import type { ContextBlockId, OmitReason, OmittedItemShape, TruncateReport } from './context-types';

/**
 * 省略报告（T4-03 要点 3）。
 *
 * 目标：任何一次裁剪都必须**可解释、可展开**。面板上显示
 * 「已省略 X 项（点击展开）」，展开后逐条说明：属于哪一块、条目名、多少 token、为什么被省略。
 *
 * 类型定义放在 `context-types`（`OmitReason` / `OmittedItemShape` / `TruncateReport`），
 * 这里只做再导出 + 「构造 / 描述」的实现，避免与 `AssembledContext` 形成循环导入。
 */

export type { OmitReason, TruncateReport } from './context-types';

/** 被省略的条目（别名，保持调用方可读性） */
export type OmittedItem = OmittedItemShape;

export const OMIT_REASON_LABELS: Record<OmitReason, string> = {
  'block-over-quota': '超出该块配额',
  'block-over-budget': '总预算不足，优先级较低',
  'aggressive-trim': '上下文超限后的激进裁剪',
  'block-disabled': '已被手动取消勾选',
};

export interface BuildReportInput {
  items: readonly OmittedItem[];
  beforeTokens: number;
  afterTokens: number;
  aggressive: boolean;
}

const PREVIEW_LIMIT = 200;

export function summarizePreview(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > PREVIEW_LIMIT ? `${collapsed.slice(0, PREVIEW_LIMIT)}…` : collapsed;
}

/** 「已省略 X 项（点击展开）」——面板与 toast 统一用这句 */
export function describeTruncation(report: TruncateReport | null): string {
  if (report === null || report.omittedCount === 0) return '上下文完整提交，无省略';
  return `已省略 ${report.omittedCount} 项（点击展开）`;
}

export function buildTruncateReport(input: BuildReportInput): TruncateReport {
  const byReason: Record<OmitReason, number> = {
    'block-over-quota': 0,
    'block-over-budget': 0,
    'aggressive-trim': 0,
    'block-disabled': 0,
  };
  let omittedTokens = 0;
  for (const item of input.items) {
    byReason[item.reason] += 1;
    omittedTokens += item.tokens;
  }

  return {
    omittedCount: input.items.length,
    omittedTokens,
    items: input.items.map((item) => ({ ...item })),
    beforeTokens: input.beforeTokens,
    afterTokens: input.afterTokens,
    aggressive: input.aggressive,
    byReason,
    summary:
      input.items.length === 0 ? '上下文完整提交，无省略' : `已省略 ${input.items.length} 项（点击展开）`,
  };
}

/** 按块分组展示（面板展开后的分组列表） */
export function groupOmittedByBlock(report: TruncateReport): { block: ContextBlockId; blockLabel: string; items: OmittedItem[] }[] {
  const groups = new Map<string, { block: ContextBlockId; blockLabel: string; items: OmittedItem[] }>();
  for (const item of report.items) {
    const existing = groups.get(item.block);
    if (existing === undefined) groups.set(item.block, { block: item.block, blockLabel: item.blockLabel, items: [item] });
    else existing.items.push(item);
  }
  return [...groups.values()];
}

/** 生成一条可读的省略说明（供日志与决策卡片使用） */
export function describeReportDetail(report: TruncateReport): string {
  if (report.omittedCount === 0) return '无省略';
  const parts = groupOmittedByBlock(report).map(
    (group) => `${group.blockLabel} ${group.items.length} 项（${OMIT_REASON_LABELS[group.items[0]?.reason ?? 'block-over-quota']}）`,
  );
  return `${describeTruncation(report)}：${parts.join('；')}`;
}
