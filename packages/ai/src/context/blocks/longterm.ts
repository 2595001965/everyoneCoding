import type { BlockBuildContext, ContextBlock } from '../context-types';
import { buildMemoryBlock } from './shared';

/**
 * ① 长期记忆块（FR-AI-01 第 1 类，配额 ≤8k）。
 *
 * 内容：跨项目的用户偏好与规范（"以后都用 TypeScript"、命名惯例、技术栈倾向）。
 * 特点：条数少、单条短，但**跨项目通用**，因此即使项目记忆很多也不应被裁掉。
 */
export function buildLongtermBlock(context: BlockBuildContext): Promise<ContextBlock> {
  return buildMemoryBlock(context, {
    id: 'longterm',
    scope: 'longterm',
    label: '长期记忆（用户偏好与规范）',
    limit: 25,
    prefix: '- ',
    reportEmpty: false,
  });
}
