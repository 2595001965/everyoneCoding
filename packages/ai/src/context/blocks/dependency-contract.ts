import {
  estimateTextTokens,
  unavailableBlock,
  type BlockBuildContext,
  type ContextBlock,
  type ContextBlockItem,
  type DependencyContract,
} from '../context-types';
import { CONTEXT_BLOCK_QUOTAS } from '../token-budget';

/**
 * ⑩ 依赖接口契约块（FR-PIPE-10 / T4-02 要点 4，与 T5-06 共用）。
 *
 * 核心决策：S5 逐个生成节点时，**注入已生成依赖的接口契约摘要，而不是它们的全部历史代码**。
 * 理由（PRD §13.2）：
 * - 全量注入会迅速吃满 128k 预算，且实现细节会把模型带偏（照抄错误实现）；
 * - 契约摘要（签名 + 关键类型）足以保证调用点编译通过，这正是 T5-05 拓扑排序的目的。
 *
 * 本块不检索任何端口，只用 `ContextEngine.setDependencyContracts()` 注入的契约；
 * 没有契约时优雅跳过（S5 的第一个节点就是这种情况）。
 */
const CONTRACT_TOKEN_CAP = 1_500;

export function buildDependencyContractBlock(context: BlockBuildContext): ContextBlock {
  const quota = CONTEXT_BLOCK_QUOTAS.find((item) => item.id === 'dependency-contract');
  const base = {
    id: 'dependency-contract' as const,
    label: '依赖接口契约（已生成节点）',
    priority: quota?.priority ?? 850,
    quota: quota?.quota ?? 8_000,
  };

  if (context.contracts.length === 0) {
    return unavailableBlock({
      ...base,
      reason: '本次没有已生成的依赖节点（S5 首个节点无需契约注入）',
    });
  }

  const items: ContextBlockItem[] = context.contracts.map((contract) => {
    const lines = [
      `// ${contract.name}（${contract.kind}）@ ${contract.filePath}`,
      contract.summary.trim(),
    ];
    if (contract.types !== undefined && contract.types.length > 0) {
      for (const type of contract.types) lines.push(type.trim());
    }
    let text = lines.join('\n');
    const tokens = estimateTextTokens(text);
    if (tokens > CONTRACT_TOKEN_CAP) text = `${text.slice(0, CONTRACT_TOKEN_CAP * 3)}…`;
    return {
      key: `${contract.filePath}:${contract.name}`,
      label: `${contract.name}（${contract.kind}）`,
      tokens: estimateTextTokens(text),
      // 契约按依赖顺序保留（调用方保证拓扑序），先出现的先保留
      weight: 100 - context.contracts.indexOf(contract) * 0.1,
      text,
    };
  });

  const content = items.map((item) => item.text).join('\n\n');
  return {
    ...base,
    tokens: estimateTextTokens(content),
    content,
    source: `契约 ${items.length} 个（拓扑序）`,
    editable: true,
    items,
  };
}

/** 从契约列表渲染为「禁止臆造接口」约束句，供提示词模板复用 */
export function describeContracts(contracts: readonly DependencyContract[]): string {
  if (contracts.length === 0) return '本次无已生成依赖。';
  return `必须严格使用以下已生成依赖的接口签名，禁止臆造不存在的方法或字段：${contracts
    .map((contract) => contract.name)
    .join('、')}。`;
}
