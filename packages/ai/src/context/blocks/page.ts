import type { BlockBuildContext, ContextBlock, ContextBlockItem } from '../context-types';
import { estimateTextTokens } from '../context-types';
import { CONTEXT_BLOCK_QUOTAS } from '../token-budget';
import { buildMemoryBlock } from './shared';

/**
 * ④ 页面记忆块（FR-AI-01 第 3 类中的页面层，PRD 配额 ≤16k）。
 *
 * 内容：当前页面的职责、路由、状态变量、交互流程、以及 T2-06 沉淀的结构摘要。
 * 除了记忆条目，还会把设计器端口给出的**页面摘要**（路由 / 状态 / 接口依赖）作为
 * 一条高权重的结构化条目并入 —— 它是页面事实来源，比自然语言记忆更可靠。
 */
export async function buildPageBlock(context: BlockBuildContext): Promise<ContextBlock> {
  const quota = CONTEXT_BLOCK_QUOTAS.find((item) => item.id === 'page');
  const memory = await buildMemoryBlock(context, {
    id: 'page',
    scope: 'page',
    label: '页面记忆（当前页面）',
    limit: 30,
    prefix: '- ',
    reportEmpty: true,
  });

  const pageId = context.request.pageId;
  const summary =
    pageId !== null && pageId !== undefined
      ? (context.sources.elements?.getPageSummary?.({
          projectId: context.request.projectId,
          pageId,
        }) ?? null)
      : null;

  if (summary === null) return memory;

  const lines = [`页面「${summary.name}」路由 ${summary.route}（${summary.platform}）`];
  if (summary.state !== undefined && summary.state.length > 0) {
    lines.push(`状态变量：${summary.state.map((item) => `${item.name}:${item.type}`).join('、')}`);
  }
  if (summary.apiDeps !== undefined && summary.apiDeps.length > 0) {
    lines.push(`依赖接口：${summary.apiDeps.join('、')}`);
  }
  const text = lines.join('\n');
  const facts: ContextBlockItem = {
    key: `page-facts:${summary.pageId}`,
    label: `页面摘要 ${summary.name}`,
    tokens: estimateTextTokens(text),
    // 结构化事实：按「importance 5 × confidence 1 × 满衰减」计权，再加 0.5 保底，
    // 保证它在块内裁剪时排在所有自然语言记忆之前。
    weight: 5.5,
    text,
  };

  const items = [facts, ...memory.items];
  const content = items.map((item) => item.text).join('\n\n');
  return {
    ...memory,
    items,
    content,
    tokens: estimateTextTokens(content),
    quota: quota?.quota ?? memory.quota,
    source: `${memory.source} + 页面摘要`,
    ...(memory.skipped !== undefined ? { skipped: memory.skipped } : {}),
  };
}
