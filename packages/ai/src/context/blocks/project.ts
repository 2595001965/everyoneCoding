import type { BlockBuildContext, ContextBlock } from '../context-types';
import { buildMemoryBlock } from './shared';

/**
 * ② 项目记忆块（FR-AI-01 第 2 类，配额 ≤24k —— 全项目最大的一块）。
 *
 * 内容：技术选型、目录约定、命名规范、实体模型、路由总表、接口清单。
 * 为什么配额最大：项目记忆决定了"这个项目长什么样"，是代码能否编译通过的前提。
 */
export function buildProjectBlock(context: BlockBuildContext): Promise<ContextBlock> {
  return buildMemoryBlock(context, {
    id: 'project',
    scope: 'project',
    label: '项目记忆（技术选型与工程约定）',
    limit: 40,
    prefix: '## ',
    reportEmpty: false,
  });
}
