import {
  estimateTextTokens,
  unavailableBlock,
  type BlockBuildContext,
  type ContextBlock,
  type ContextBlockItem,
} from '../context-types';
import { CONTEXT_BLOCK_QUOTAS } from '../token-budget';

/**
 * ⑥ 元素备注块（FR-AI-01 第 5 类 / FR-ANN-06，与元素链共享 ≤8k，本块占 5k）。
 *
 * 三条硬性要求：
 * 1. **高优先级注入**：备注块优先级（880）仅次于元素链（900），高于所有记忆层级；
 * 2. **禁止事项置顶**：置顶排序由备注仓库保证（T4-01 的 `sortNotesForContext`），
 *    这里再做一次稳定排序，确保即便调用方传入乱序也能得到同样的结果；
 * 3. **禁止事项用强约束句式**：`【禁止】` 前缀由 T4-01 的 `toContextNote` 写入，
 *    本块额外补一句"违反即返工"，避免模型把它当成普通建议。
 */
export function buildNoteBlock(context: BlockBuildContext): ContextBlock {
  const quota = CONTEXT_BLOCK_QUOTAS.find((item) => item.id === 'note');
  const base = {
    id: 'note' as const,
    label: '元素备注（业务规则 / 校验 / 禁止事项）',
    priority: quota?.priority ?? 880,
    quota: quota?.quota ?? 5_000,
  };

  const notes = context.sources.notes?.getNotesForContext({
    projectId: context.request.projectId,
    elementId: context.request.elementId ?? null,
    pageId: context.request.pageId ?? null,
    featureId: context.request.featureId ?? null,
  });

  if (context.sources.notes === undefined) {
    return unavailableBlock({ ...base, reason: '未接入备注端口（外壳需装配 NoteRepository）' });
  }
  if (notes === undefined || notes.length === 0) {
    return unavailableBlock({ ...base, reason: '当前元素 / 页面 / 功能没有未解决的备注' });
  }

  const sorted = [...notes].sort((a, b) => {
    if (a.mustFollow !== b.mustFollow) return a.mustFollow ? -1 : 1;
    if (a.priority !== b.priority) return b.priority - a.priority;
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    return a.id < b.id ? -1 : 1;
  });

  const items: ContextBlockItem[] = sorted.map((note) => {
    const header = `[备注 #${note.id}] ${note.typeLabel}（${note.targetType}，P${note.priority}）`;
    const lines = [header, note.text];
    if (note.mustFollow) lines.push('^ 该条为硬约束：必须满足，违反视为返工。');
    const text = lines.join('\n');
    return {
      key: note.id,
      label: `${note.typeLabel}：${note.text.split('\n')[0] ?? note.id}`,
      tokens: estimateTextTokens(text),
      // 禁止事项权重远超普通备注，保证同一块内先于一切条目保留
      weight: note.mustFollow ? 100 : note.priority,
      text,
    };
  });

  const content = items.map((item) => item.text).join('\n\n');
  const mustFollowCount = sorted.filter((note) => note.mustFollow).length;
  return {
    ...base,
    tokens: estimateTextTokens(content),
    content,
    source: `备注 ${sorted.length} 条${mustFollowCount > 0 ? `（含禁止事项 ${mustFollowCount} 条）` : ''}`,
    editable: true,
    items,
  };
}
