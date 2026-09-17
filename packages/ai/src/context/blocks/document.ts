import {
  estimateTextTokens,
  unavailableBlock,
  type BlockBuildContext,
  type ContextBlock,
  type ContextBlockItem,
  type ContextDocumentSnippet,
} from '../context-types';
import { CONTEXT_BLOCK_QUOTAS } from '../token-budget';

/**
 * ⑧ 文档相关章节块（FR-AI-01 第 7 类，与问题记忆共享 ≤8k，本块占 4k）。
 *
 * 内容：需求文档（S1 产物）与技术文档（S3 产物）中与本次生成相关的章节。
 *
 * 排序权重 = 文档相关度（端口给的 score，缺省 0.5）+ 关键词命中加成，
 * 保证块内裁剪时优先保留"真正被问到的章节"（T4-03 要点 4：文档按相关段落截断）。
 */
const SNIPPET_TOKEN_CAP = 1_200;

export async function buildDocumentBlock(context: BlockBuildContext): Promise<ContextBlock> {
  const quota = CONTEXT_BLOCK_QUOTAS.find((item) => item.id === 'document');
  const base = {
    id: 'document' as const,
    label: '文档相关章节（需求 / 技术文档）',
    priority: quota?.priority ?? 300,
    quota: quota?.quota ?? 4_000,
  };

  const port = context.sources.documents;
  if (port === undefined) {
    return unavailableBlock({ ...base, reason: '未接入文档端口（外壳需装配 @ec/docs 或项目文档索引）' });
  }

  let snippets: readonly ContextDocumentSnippet[] = [];
  try {
    snippets = await port.searchRelevant({
      projectId: context.request.projectId,
      query: context.query,
      limit: 12,
    });
  } catch (error) {
    return unavailableBlock({
      ...base,
      reason: `文档检索失败：${error instanceof Error ? error.message : String(error)}`,
    });
  }

  if (snippets.length === 0) {
    return unavailableBlock({ ...base, reason: '需求 / 技术文档中未检索到相关章节' });
  }

  const items: ContextBlockItem[] = snippets.map((snippet) => {
    const heading = snippet.heading !== undefined && snippet.heading.length > 0 ? ` · ${snippet.heading}` : '';
    const body =
      snippet.content.length > SNIPPET_TOKEN_CAP * 3 ? `${snippet.content.slice(0, SNIPPET_TOKEN_CAP * 3)}…` : snippet.content;
    const text = `[${KIND_LABELS[snippet.kind]}《${snippet.title}》${heading}]\n${body}`;
    return {
      key: snippet.id,
      label: `${snippet.title}${heading}`,
      tokens: estimateTextTokens(text),
      weight: documentWeight(snippet, context.query),
      text,
    };
  });

  const content = items.map((item) => item.text).join('\n\n');
  return {
    ...base,
    tokens: estimateTextTokens(content),
    content,
    source: `相关章节 ${items.length} 段`,
    editable: false,
    items,
  };
}

const KIND_LABELS: Record<ContextDocumentSnippet['kind'], string> = {
  requirement: '需求文档',
  techdoc: '技术文档',
  other: '文档',
};

/** 相关度（0–1）+ 标题/章节名命中加成（0–0.5）+ 正文关键词命中加成（0–0.3） */
export function documentWeight(snippet: ContextDocumentSnippet, query: string): number {
  const base = snippet.score ?? 0.5;
  const keywords = tokenize(query);
  const headingText = `${snippet.title}${snippet.heading ?? ''}`.toLowerCase();
  const bodyText = snippet.content.toLowerCase();
  let bonus = 0;
  for (const keyword of keywords) {
    if (headingText.includes(keyword)) bonus += 0.25;
    else if (bodyText.includes(keyword)) bonus += 0.05;
  }
  return Number((base + Math.min(0.5, bonus)).toFixed(4));
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .slice(0, 20);
}
