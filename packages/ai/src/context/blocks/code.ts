import {
  estimateTextTokens,
  unavailableBlock,
  type BlockBuildContext,
  type ContextBlock,
  type ContextBlockItem,
  type ContextCodeHit,
} from '../context-types';
import { CONTEXT_BLOCK_QUOTAS } from '../token-budget';

/**
 * ⑨ 已有代码与 Code Anchor 块（FR-AI-01 第 8 类，PRD 配额 ≤40k —— 最大一块）。
 *
 * 为什么必须是最大一块：增量补丁（patch）要求模型看得见要改的真实代码，
 * 否则只能"凭空造一个文件"，与 D-04「AI 是唯一写入口」下的可审查性相悖。
 *
 * 排序权重 = Code Anchor 命中度（T4-03 要点 4：代码按锚点命中度排序截断）：
 * - 命中的锚点（`anchorId` 存在）在 score 基础上 +0.3；
 * - 与选中元素直接相关的锚点再加 +0.2，保证"这个按钮对应的那段后端代码"最后才被裁。
 */
const SNIPPET_CHAR_CAP = 6_000;

export async function buildCodeBlock(context: BlockBuildContext): Promise<ContextBlock> {
  const quota = CONTEXT_BLOCK_QUOTAS.find((item) => item.id === 'code');
  const base = {
    id: 'code' as const,
    label: '已有代码与 Code Anchor',
    priority: quota?.priority ?? 860,
    quota: quota?.quota ?? 40_000,
  };

  const port = context.sources.code;
  if (port === undefined) {
    return unavailableBlock({ ...base, reason: '未接入代码端口（外壳需装配工作区文件索引与锚点仓库）' });
  }

  let hits: readonly ContextCodeHit[] = [];
  try {
    hits = await port.findRelated({
      projectId: context.request.projectId,
      elementId: context.request.elementId ?? null,
      query: context.query,
      limit: 24,
    });
  } catch (error) {
    return unavailableBlock({
      ...base,
      reason: `代码检索失败：${error instanceof Error ? error.message : String(error)}`,
    });
  }

  if (hits.length === 0) {
    // 首次生成时项目里确实没有代码，这属于正常情况而非错误
    return unavailableBlock({ ...base, reason: '项目中尚无与本次生成相关的代码（首次生成）' });
  }

  const items: ContextBlockItem[] = hits.map((hit) => {
    const body = hit.snippet.length > SNIPPET_CHAR_CAP ? `${hit.snippet.slice(0, SNIPPET_CHAR_CAP)}…` : hit.snippet;
    const header = `// ${hit.filePath} · ${hit.symbol} (${hit.kind}, L${hit.startLine}-${hit.endLine})`;
    const text = `### ${hit.filePath}\n\`\`\`${hit.language}\n${header}\n${body}\n\`\`\``;
    return {
      key: hit.anchorId ?? `${hit.filePath}:${hit.symbol}`,
      label: `${hit.symbol} @ ${hit.filePath}`,
      tokens: estimateTextTokens(text),
      weight: codeWeight(hit, context.request.elementId ?? null),
      text,
    };
  });

  const content = items.map((item) => item.text).join('\n\n');
  const anchored = hits.filter((hit) => hit.anchorId !== undefined && hit.anchorId !== null).length;
  return {
    ...base,
    tokens: estimateTextTokens(content),
    content,
    source: `代码片段 ${items.length} 段（锚点命中 ${anchored} 段）`,
    editable: false,
    items,
  };
}

export function codeWeight(hit: ContextCodeHit, elementId: string | null): number {
  let weight = hit.score;
  if (hit.anchorId !== undefined && hit.anchorId !== null && hit.anchorId.length > 0) weight += 0.3;
  if (elementId !== null && elementId.length > 0 && hit.anchorId !== undefined && hit.anchorId.includes(elementId)) {
    weight += 0.2;
  }
  return Number(weight.toFixed(4));
}
