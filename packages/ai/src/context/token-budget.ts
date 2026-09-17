import type { AiPurpose } from '../domain/purpose-binding';
import {
  CONTEXT_BLOCK_IDS,
  estimateTextTokens,
  type ContextBlockId,
  type ContextBlockItem,
} from './context-types';

/**
 * Token 预算与分块配额（T4-03 要点 1）。
 *
 * 两条设计原则：
 * 1. **配额（quota）与总预算（budget）是两件事**：配额是单块上限，总预算才是硬约束。
 *    PRD 建议的分块配额之和（136k）本就大于默认总预算（128k），
 *    所以「按配额装满」不等于「超预算」，超预算时才按优先级裁剪。
 * 2. **保留顺序不是装饰**：`priority` 直接决定裁剪取舍，且必须满足 T4-03 的硬性要求
 *    —— 元素链 > 备注 > 页面记忆 > 功能记忆 > 项目记忆 > 长期记忆 > 文档片段。
 *    代码块与依赖契约块未出现在该列表里，这里放在「备注之后、页面之前」：
 *    补丁式生成没有既有代码就无从下手，但它不属于「越具体越靠后」的记忆层级。
 */

export interface BlockQuota {
  id: ContextBlockId;
  label: string;
  /** 单块 token 上限（PRD §M6 建议值） */
  quota: number;
  /** 裁剪时的保留优先级（越大越先保留） */
  priority: number;
  /** 是否允许被裁剪（指令 / 输出契约永不被裁） */
  trimmable: boolean;
}

export const CONTEXT_BLOCK_QUOTAS: readonly BlockQuota[] = [
  { id: 'instruction', label: '任务指令与输出契约', quota: 16_000, priority: 1_000, trimmable: false },
  { id: 'element-chain', label: '元素及祖先链', quota: 3_000, priority: 900, trimmable: true },
  { id: 'note', label: '元素备注', quota: 5_000, priority: 880, trimmable: true },
  { id: 'code', label: '已有代码与锚点', quota: 40_000, priority: 860, trimmable: true },
  { id: 'dependency-contract', label: '依赖接口契约', quota: 8_000, priority: 850, trimmable: true },
  { id: 'page', label: '页面记忆', quota: 16_000, priority: 700, trimmable: true },
  { id: 'feature', label: '功能记忆', quota: 16_000, priority: 600, trimmable: true },
  { id: 'project', label: '项目记忆', quota: 24_000, priority: 500, trimmable: true },
  { id: 'issue', label: '关联问题记忆', quota: 4_000, priority: 450, trimmable: true },
  { id: 'longterm', label: '长期记忆', quota: 8_000, priority: 400, trimmable: true },
  { id: 'document', label: '文档相关章节', quota: 4_000, priority: 300, trimmable: true },
];

/** 默认总预算 128k（可配） */
export const DEFAULT_CONTEXT_BUDGET = 128_000;

/** 用途档位：文档 / 界面生成不需要全量代码，记忆抽取只需要最小上下文 */
export type ContextPurposeProfile =
  | 'code-generation'
  | 'document-generation'
  | 'interface-generation'
  | 'memory-extraction'
  | 'commit-message';

export const PURPOSE_PROFILE_BUDGETS: Record<ContextPurposeProfile, number> = {
  'code-generation': 128_000,
  'document-generation': 64_000,
  'interface-generation': 64_000,
  'memory-extraction': 32_000,
  'commit-message': 8_000,
};

/** AiPurpose → 档位（不引入新的用途枚举，保持与 Wave 1 一致） */
export function profileForPurpose(purpose: AiPurpose): ContextPurposeProfile {
  switch (purpose) {
    case 'code':
      return 'code-generation';
    case 'requirement':
    case 'techdoc':
      return 'document-generation';
    case 'interface':
      return 'interface-generation';
    case 'memory-extract':
      return 'memory-extraction';
    case 'commit-msg':
      return 'commit-message';
    default:
      // embedding 不走上下文引擎；保底给最小档位而不是抛错
      return 'memory-extraction';
  }
}

export interface TokenBudget {
  /** 总预算（硬约束） */
  total: number;
  profile: ContextPurposeProfile;
  quotas: Record<ContextBlockId, BlockQuota>;
  /** 各块原始配额之和（用于诊断：配额和 > 总预算是正常的） */
  quotaSum: number;
}

export interface CreateBudgetOptions {
  /** 覆盖总预算 */
  total?: number;
  /** 指定档位（缺省由 purpose 推导） */
  profile?: ContextPurposeProfile;
  /** 单块配额覆盖（例如「只要元素链和备注」的激进裁剪） */
  overrides?: Partial<Record<ContextBlockId, number>>;
  /** 直接给出用途，自动选档位 */
  purpose?: AiPurpose;
}

export function createTokenBudget(options: CreateBudgetOptions = {}): TokenBudget {
  const profile = options.profile ?? (options.purpose !== undefined ? profileForPurpose(options.purpose) : 'code-generation');
  const total = options.total ?? PURPOSE_PROFILE_BUDGETS[profile];

  const quotas = {} as Record<ContextBlockId, BlockQuota>;
  for (const quota of CONTEXT_BLOCK_QUOTAS) {
    const override = options.overrides?.[quota.id];
    quotas[quota.id] = override === undefined ? quota : { ...quota, quota: override };
  }

  return {
    total,
    profile,
    quotas,
    quotaSum: CONTEXT_BLOCK_IDS.reduce((sum, id) => sum + quotas[id].quota, 0),
  };
}

/** 激进裁剪档位：只保留元素链 + 备注（+ 页面记忆的极简摘要），用于超限重试 */
export function createAggressiveBudget(base: TokenBudget, total?: number): TokenBudget {
  return createTokenBudget({
    total: total ?? Math.min(base.total, 32_000),
    profile: base.profile,
    overrides: {
      'element-chain': 1_500,
      note: 2_500,
      page: 2_000,
      feature: 0,
      project: 0,
      longterm: 0,
      issue: 0,
      document: 0,
      code: 0,
      'dependency-contract': 0,
    },
  });
}

/**
 * 块内裁剪：按 weight 降序保留条目，直到不超过 limit。
 *
 * 返回保留与省略两部分；`limit <= 0` 表示整块丢弃（激进裁剪里用于禁用块）。
 */
export function cutItemsByLimit(
  items: readonly ContextBlockItem[],
  limit: number,
): { kept: ContextBlockItem[]; omitted: ContextBlockItem[] } {
  if (limit <= 0) return { kept: [], omitted: [...items] };

  const ordered = [...items].sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  const kept: ContextBlockItem[] = [];
  const omitted: ContextBlockItem[] = [];
  let used = 0;
  for (const item of ordered) {
    if (used + item.tokens <= limit) {
      kept.push(item);
      used += item.tokens;
    } else {
      omitted.push(item);
    }
  }
  return { kept, omitted };
}

/** 便捷：估算一批文本的 token */
export function sumTokens(texts: readonly string[]): number {
  return texts.reduce((sum, text) => sum + estimateTextTokens(text), 0);
}
