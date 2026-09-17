import {
  estimateTextTokens,
  type BlockBuildContext,
  type ContextBlock,
  type ContextBlockId,
  type ContextBlockItem,
  type ContextMemoryHit,
  type ContextMemoryScope,
} from '../context-types';
import { CONTEXT_BLOCK_QUOTAS } from '../token-budget';

/**
 * 记忆类块的共用实现（长期 / 项目 / 功能 / 页面 / 问题五块形状完全一致，只有 scope 与配额不同）。
 *
 * 排序权重（T4-03 要点 4：记忆按重要度与置信度排序截断）：
 *   weight = importance × confidence × 时间衰减
 * 时间衰减取半衰期 30 天：新记忆权重更高，但不会把 5 分老记忆压到 1 分之下。
 */

export interface MemoryBlockConfig {
  id: ContextBlockId;
  scope: ContextMemoryScope;
  label: string;
  /** 检索条数上限（块内配额还会再裁一次） */
  limit: number;
  /** 条目文本前缀，便于模型分辨层级 */
  prefix: string;
  /** 检索无结果时是否标记「跳过」（长期记忆无内容属正常，不标跳过） */
  reportEmpty: boolean;
}

const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

export function memoryItemWeight(hit: ContextMemoryHit, now: number): number {
  const importance = Math.min(5, Math.max(1, hit.importance));
  const confidence = Math.min(1, Math.max(0, hit.confidence));
  const age = Math.max(0, now - hit.updatedAt);
  const decay = Math.pow(0.5, age / HALF_LIFE_MS);
  return importance * confidence * (0.5 + 0.5 * decay);
}

/** 结构化摘要只注入"契约性"字段，避免把整坨 JSON 塞进上下文 */
const STRUCTURED_KEYS = [
  'routes',
  'apis',
  'interfaces',
  'naming',
  'stack',
  'conventions',
  'entities',
  'fields',
  'flows',
];

export function formatMemoryItem(hit: ContextMemoryHit, prefix: string): string {
  const lines = [`${prefix}${hit.title}`];
  if (hit.content.trim().length > 0) lines.push(hit.content.trim());
  const structured = summarizeStructured(hit.structured);
  if (structured !== null) lines.push(structured);
  return lines.join('\n');
}

export function summarizeStructured(structured: unknown): string | null {
  if (structured === null || structured === undefined || typeof structured !== 'object') return null;
  const source = structured as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of STRUCTURED_KEYS) {
    if (key in source) picked[key] = source[key];
  }
  if (Object.keys(picked).length === 0) return null;
  const text = JSON.stringify(picked);
  // 超过 1200 token 的结构化内容截断（路由总表等大对象只保留前段）
  return text.length > 3600 ? `${text.slice(0, 3600)}…` : text;
}

/** 记忆块构建：端口缺失 → 跳过；端口报错 → 也跳过而不是让整次组装失败 */
export async function buildMemoryBlock(context: BlockBuildContext, config: MemoryBlockConfig): Promise<ContextBlock> {
  const quota = CONTEXT_BLOCK_QUOTAS.find((item) => item.id === config.id);
  const base = {
    id: config.id,
    label: config.label,
    priority: quota?.priority ?? 400,
    quota: quota?.quota ?? 8_000,
  };

  const port = context.sources.memory;
  if (port === undefined) {
    return {
      ...base,
      tokens: 0,
      content: '',
      source: '未接入',
      editable: true,
      items: [],
      skipped: '未接入记忆端口（外壳需装配 @ec/memory 的双路召回）',
    };
  }

  const now = context.clock();
  let hits: readonly ContextMemoryHit[] = [];
  let sourceLabel = '双路召回';
  try {
    hits = await port.search({
      userId: context.request.userId,
      projectId: context.request.projectId,
      scope: config.scope,
      query: context.query,
      limit: config.limit,
    });
  } catch (error) {
    return {
      ...base,
      tokens: 0,
      content: '',
      source: '检索失败',
      editable: true,
      items: [],
      skipped: `记忆检索失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (hits.length === 0 && port.listByScope !== undefined) {
    sourceLabel = '分层列举（检索无命中）';
    hits = await port.listByScope({
      userId: context.request.userId,
      projectId: context.request.projectId,
      scope: config.scope,
      limit: config.limit,
    });
  }

  const items: ContextBlockItem[] = hits.map((hit) => {
    const text = formatMemoryItem(hit, config.prefix);
    return {
      key: hit.id,
      label: hit.title,
      tokens: estimateTextTokens(text),
      weight: memoryItemWeight(hit, now),
      text,
    };
  });

  const block: ContextBlock = {
    ...base,
    tokens: items.reduce((sum, item) => sum + item.tokens, 0),
    content: items.map((item) => item.text).join('\n\n'),
    source: `${sourceLabel} ${items.length} 条`,
    editable: true,
    items,
  };
  if (items.length === 0 && config.reportEmpty) block.skipped = '该层级暂无记忆';
  return block;
}
