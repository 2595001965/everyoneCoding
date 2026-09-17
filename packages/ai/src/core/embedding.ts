/**
 * 向量化（embedding）调用的公共类型。
 *
 * 定位：`@ec/memory` 的双路召回（T2-03）需要把记忆条目与查询串转向量，
 * 但向量化能力取决于用户是否配置了支持 `/embeddings` 的 Provider。
 * 因此这里统一表达「成功」与「不可用」两种结果：
 * **不可用是一种正常返回，而不是异常** —— 上层据此降级为纯关键词检索，绝不阻塞主流程。
 */

export interface EmbeddingRequest {
  /** 待向量化文本（批量） */
  inputs: readonly string[];
  /** 覆盖用途绑定的模型；缺省走 `embedding` 用途绑定 */
  modelId?: string | null;
  providerId?: string | null;
  /** 目标维度（部分 Provider 支持降维） */
  dimensions?: number | null;
  signal?: AbortSignal;
}

export interface EmbeddingUsage {
  promptTokens: number;
  totalTokens: number;
}

export interface EmbeddingSuccess {
  ok: true;
  /** 与 inputs 顺序一一对应 */
  vectors: number[][];
  /** 实际使用的模型名（非本地 model.id） */
  model: string;
  dimensions: number;
  usage: EmbeddingUsage | null;
  latencyMs: number;
}

export interface EmbeddingUnavailable {
  ok: false;
  /** 面向用户的原因说明（用于「已降级为关键词检索」提示） */
  reason: string;
  /** 机器可判别的降级码 */
  code: 'not-configured' | 'unsupported-protocol' | 'unsupported-model' | 'failed';
}

export type EmbeddingOutcome = EmbeddingSuccess | EmbeddingUnavailable;

export function embeddingUnavailable(
  code: EmbeddingUnavailable['code'],
  reason: string,
): EmbeddingUnavailable {
  return { ok: false, code, reason };
}

/** 向量维度变化时的提示文案（换模型会导致旧向量失效，需要重建索引） */
export function describeDimensionChange(previous: number, next: number): string {
  return `向量维度由 ${previous} 变为 ${next}，旧向量已失效，检索将暂时退化为关键词模式，建议重建记忆索引`;
}
