/**
 * 用量与费用。
 *
 * - Usage 是两协议归一化后的结构（Anthropic 的 cache_creation / cache_read 并入 promptTokens）
 * - 费用按「每百万 token 单价」计算，价格来自模型能力矩阵，可人工修正
 * - 无单价时费用为 null，绝不猜测价格（避免用量面板给出错误数字）
 */

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** 每百万 token 单价（美元） */
export interface ModelPrice {
  inputPricePerMTok: number | null;
  outputPricePerMTok: number | null;
}

export interface Cost {
  input: number;
  output: number;
  total: number;
  /** 单价缺失时为 false，消费方应显示为「—」而非 0 */
  complete: boolean;
}

export const ZERO_USAGE: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

export function usageOf(promptTokens: number, completionTokens: number): Usage {
  const prompt = Math.max(0, Math.round(promptTokens));
  const completion = Math.max(0, Math.round(completionTokens));
  return { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return usageOf(a.promptTokens + b.promptTokens, a.completionTokens + b.completionTokens);
}

/**
 * 合并流式过程中分段上报的用量。
 *
 * 各协议口径不同：OpenAI 末帧给全量；Anthropic 在 message_start 给输入、
 * message_delta 给输出。逐字段取最大既能兼容"分段上报"，也能兼容"末帧全量"，
 * 且不会把重复的 usage 帧累加成双倍。
 */
export function mergeUsage(current: Usage | null, incoming: Usage): Usage {
  if (!current) return incoming;
  return usageOf(
    Math.max(current.promptTokens, incoming.promptTokens),
    Math.max(current.completionTokens, incoming.completionTokens),
  );
}

/** 计算费用；任一侧单价缺失即返回 complete=false */
export function computeCost(usage: Usage, price: ModelPrice | null | undefined): Cost {
  const input = price?.inputPricePerMTok;
  const output = price?.outputPricePerMTok;
  if (input === null || input === undefined || output === null || output === undefined) {
    return { input: 0, output: 0, total: 0, complete: false };
  }
  const inputCost = (usage.promptTokens / 1_000_000) * input;
  const outputCost = (usage.completionTokens / 1_000_000) * output;
  return { input: inputCost, output: outputCost, total: inputCost + outputCost, complete: true };
}

/** 6 位小数足矣：单请求费用普遍远小于 1 美元 */
export function formatCost(cost: Cost): string {
  if (!cost.complete) return '—';
  return `$${cost.total.toFixed(6)}`;
}

/**
 * 启发式 token 估算（无 tokenizer 时使用）。
 *
 * 依据：英文约 4 字符/token，中文约 1.5 字符/token，JSON/代码偏多。
 * 返回值标注 `estimated`，UI 与预算统计需据实展示「估算」标记。
 */
export interface TokenEstimate {
  tokens: number;
  estimated: boolean;
  /** 估算误差区间（±） */
  margin: number;
}

export function estimateTokens(text: string): TokenEstimate {
  if (text.length === 0) return { tokens: 0, estimated: true, margin: 0 };
  const cjk = (text.match(/[㐀-䶿一-鿿぀-ヿ가-힯]/g) ?? []).length;
  const others = text.length - cjk;
  // 中文按 0.7 token/字，其余按 0.28 token/字符（≈3.6 字符/token）
  const tokens = cjk * 0.7 + others * 0.28;
  const rounded = Math.max(1, Math.round(tokens));
  return { tokens: rounded, estimated: true, margin: Math.max(1, Math.round(rounded * 0.15)) };
}
