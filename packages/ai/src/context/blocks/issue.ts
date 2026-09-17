import type { BlockBuildContext, ContextBlock } from '../context-types';
import { buildMemoryBlock } from './shared';

/**
 * ⑦ 关联问题记忆块（FR-AI-01 第 6 类的一半，与文档片段共享 ≤8k，本块占 4k）。
 *
 * 内容：该页面 / 元素曾经踩过的坑（未解决与已规避的问题记忆），让模型不要重犯。
 * 未解决的问题会额外标注，提示模型主动规避而不是复制既有错误实现。
 */
export async function buildIssueBlock(context: BlockBuildContext): Promise<ContextBlock> {
  const block = await buildMemoryBlock(context, {
    id: 'issue',
    scope: 'issue',
    label: '关联问题记忆（历史踩坑）',
    limit: 12,
    prefix: '- ',
    reportEmpty: true,
  });

  if (block.items.length === 0) return block;

  // 未解决 / 已规避的问题用不同前缀重新渲染，语义更明确
  const items = block.items.map((item) => ({
    ...item,
    text: /未解决/.test(item.text) ? item.text : `[历史问题] ${item.text}`,
  }));
  return {
    ...block,
    items,
    content: items.map((item) => item.text).join('\n\n'),
    tokens: items.reduce((sum, item) => sum + item.tokens, 0),
  };
}
