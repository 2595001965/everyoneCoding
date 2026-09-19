import { z } from 'zod';

/**
 * 模型能力矩阵（FR-MDL-04）。
 *
 * - 落库在 `model.capabilities_json`，避免为每家厂商新增一列
 * - `manualOverride` 一旦为 true，远程拉取的 /models 结果不得覆盖该模型
 * - 单价缺失时费用统计给出「—」而不是 0（见 core/usage.ts）
 */

export interface ModelCapability {
  contextWindow: number | null;
  maxOutput: number | null;
  supportsStream: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  /**
   * 是否支持向量化（/embeddings）。
   * 可选：多数中转与 Anthropic 协议不提供，缺省视为不支持（T2-03 据此优雅降级为纯关键词检索）。
   */
  supportsEmbedding?: boolean;
  /** 每百万 token 输入单价（美元） */
  inputPricePerMTok: number | null;
  /** 每百万 token 输出单价（美元） */
  outputPricePerMTok: number | null;
  /** 人工修正标记：为 true 时拒绝自动覆盖 */
  manualOverride: boolean;
}

export const DEFAULT_CAPABILITY: ModelCapability = {
  contextWindow: null,
  maxOutput: null,
  supportsStream: true,
  supportsTools: false,
  supportsVision: false,
  supportsEmbedding: false,
  inputPricePerMTok: null,
  outputPricePerMTok: null,
  manualOverride: false,
};

const nonNegativeNumber = z.number().finite().min(0);

export const capabilitySchema = z.object({
  contextWindow: z.number().int().positive().nullable().default(null),
  maxOutput: z.number().int().positive().nullable().default(null),
  supportsStream: z.boolean().default(true),
  supportsTools: z.boolean().default(false),
  supportsVision: z.boolean().default(false),
  supportsEmbedding: z.boolean().default(false),
  inputPricePerMTok: nonNegativeNumber.nullable().default(null),
  outputPricePerMTok: nonNegativeNumber.nullable().default(null),
  manualOverride: z.boolean().default(false),
});

export type CapabilityPatch = Partial<ModelCapability>;

/** 解析能力矩阵；非法 JSON 回退默认值而不是抛错（避免一个坏模型拖垮整个列表） */
export function parseCapability(json: string | null | undefined): ModelCapability {
  if (!json) return { ...DEFAULT_CAPABILITY };
  try {
    const parsed = capabilitySchema.safeParse(JSON.parse(json) as unknown);
    return parsed.success ? parsed.data : { ...DEFAULT_CAPABILITY };
  } catch {
    return { ...DEFAULT_CAPABILITY };
  }
}

export function serializeCapability(capability: ModelCapability): string {
  return JSON.stringify(capability);
}

/**
 * 合并能力：任何显式传入的字段都会打上 manualOverride。
 * `overwrite=false` 且已人工修正时，直接返回原值（保护用户手改结果）。
 */
export function mergeCapability(
  current: ModelCapability,
  patch: CapabilityPatch,
  options: { overwrite?: boolean } = {},
): ModelCapability {
  if (!options.overwrite && current.manualOverride) return current;
  const hasPatch = Object.values(patch).some((value) => value !== undefined);
  return {
    ...current,
    ...stripUndefined(patch),
    manualOverride: current.manualOverride || hasPatch,
  };
}

function stripUndefined<T extends object>(input: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key as keyof T] = value as T[keyof T];
  }
  return out;
}
