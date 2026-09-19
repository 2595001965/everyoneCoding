import {
  estimateTextTokens,
  unavailableBlock,
  type BlockBuildContext,
  type ContextBlock,
  type ContextBlockItem,
} from '../context-types';
import { CONTEXT_BLOCK_QUOTAS } from '../token-budget';

/**
 * ⑤ 元素及祖先链结构块（FR-AI-01 第 4 类，与备注共享 ≤8k，本块占 3k）。
 *
 * 为什么要祖先链：生成后端代码时，真正决定契约的往往不是选中元素本身，
 * 而是它所在表单 / 列表 / 容器的语义（例如"提交按钮在登录表单里" → 需要 captcha 校验）。
 *
 * 注入形式：从根到选中元素逐层缩进列出 `type[name]` + 关键属性（绑定 / 事件 / 条件 / 权限）。
 * 权重按深度递增 —— 越靠近选中元素的层级越重要。
 */
export function buildElementChainBlock(context: BlockBuildContext): ContextBlock {
  const quota = CONTEXT_BLOCK_QUOTAS.find((item) => item.id === 'element-chain');
  const base = {
    id: 'element-chain' as const,
    label: '元素及祖先链',
    priority: quota?.priority ?? 900,
    quota: quota?.quota ?? 3_000,
  };

  const elementId = context.request.elementId;
  if (elementId === null || elementId === undefined) {
    return unavailableBlock({ ...base, reason: '本次未选中元素（整页生成时无祖先链）' });
  }

  const source = context.sources.elements;
  if (source === undefined) {
    return unavailableBlock({
      ...base,
      reason: '未接入设计器端口（外壳需装配 PageDsl / editor store）',
    });
  }

  const chain = source.getElementChain({ projectId: context.request.projectId, elementId });
  if (chain.length === 0) {
    return unavailableBlock({ ...base, reason: `元素 ${elementId} 不在当前页面 DSL 中` });
  }

  const items: ContextBlockItem[] = chain.map((node, index) => {
    const depth = index + 1;
    const indent = '  '.repeat(Math.max(0, chain.length - depth));
    const title =
      node.name !== undefined && node.name.length > 0 ? `${node.type}「${node.name}」` : node.type;
    const lines = [`${indent}${depth}. ${title} (id=${node.id})`];
    if (node.bindings !== undefined && Object.keys(node.bindings).length > 0) {
      lines.push(
        `${indent}   绑定：${Object.entries(node.bindings)
          .map(([key, value]) => `${key}←${value}`)
          .join('，')}`,
      );
    }
    const props = summarizeRelevantProps(node.props);
    if (props !== null) lines.push(`${indent}   属性：${props}`);
    if (node.conditionSummary !== undefined && node.conditionSummary.length > 0) {
      lines.push(`${indent}   条件渲染：${node.conditionSummary}`);
    }
    if (node.permissionSummary !== undefined && node.permissionSummary.length > 0) {
      lines.push(`${indent}   权限：${node.permissionSummary}`);
    }
    const text = lines.join('\n');
    return {
      key: node.id,
      label: `${title}（第 ${depth} 层）`,
      tokens: estimateTextTokens(text),
      // 越靠近选中元素权重越高（叶子 6.0，逐级 -0.5，最低 1.0）
      weight: Math.max(1, 6 - (chain.length - depth) * 0.5),
      text,
    };
  });

  const selected = chain[chain.length - 1];
  const content = items.map((item) => item.text).join('\n');
  return {
    ...base,
    tokens: estimateTextTokens(content),
    content,
    source: `祖先链 ${chain.length} 层（选中 ${selected?.type ?? elementId}）`,
    editable: false,
    items,
  };
}

/** 只注入影响后端契约的属性（绑定 / 校验 / 事件 / 值），样式与布局一律丢弃 */
const RELEVANT_PROP_KEYS = [
  'name',
  'label',
  'placeholder',
  'type',
  'required',
  'rules',
  'validation',
  'disabled',
  'options',
  'value',
  'defaultValue',
  'action',
  'method',
  'url',
  'event',
  'onClick',
  'onSubmit',
  'text',
  'title',
];

function summarizeRelevantProps(props: Record<string, unknown> | undefined): string | null {
  if (props === undefined) return null;
  const picked: string[] = [];
  for (const key of RELEVANT_PROP_KEYS) {
    if (!(key in props)) continue;
    const value = props[key];
    if (value === undefined || value === null || value === '') continue;
    const rendered = typeof value === 'object' ? JSON.stringify(value) : String(value);
    picked.push(`${key}=${rendered.length > 120 ? `${rendered.slice(0, 120)}…` : rendered}`);
  }
  return picked.length === 0 ? null : picked.join('，');
}
