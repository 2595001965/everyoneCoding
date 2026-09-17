import type { BlockBuildContext, ContextBlock } from '../context-types';
import { buildMemoryBlock } from './shared';

/**
 * ③ 功能记忆块（FR-AI-01 第 3 类，PRD 配额 ≤16k）。
 *
 * 内容：当前功能模块的职责、接口契约、状态流转、该功能的既有决策。
 * 注意：S5 逐个生成时，**已生成依赖的接口契约**走 `dependency-contract` 块单独注入，
 * 本块只放功能级的语义描述，避免与契约块重复占用预算。
 */
export function buildFeatureBlock(context: BlockBuildContext): Promise<ContextBlock> {
  return buildMemoryBlock(context, {
    id: 'feature',
    scope: 'feature',
    label: '功能记忆（当前功能模块）',
    limit: 30,
    prefix: '## ',
    reportEmpty: true,
  });
}
