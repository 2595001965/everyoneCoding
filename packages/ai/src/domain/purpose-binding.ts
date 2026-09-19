import { z } from 'zod';

/**
 * 用途化模型绑定（FR-MDL-05）。
 *
 * 六类用途各自可绑定不同模型（例如"代码生成"用强模型、"提交信息"用廉价模型）。
 * `useDefaultForAll` 打开时全部用途走默认模型，绑定项保留但暂不生效。
 */

export const AI_PURPOSES = [
  'requirement',
  'interface',
  'techdoc',
  'code',
  'memory-extract',
  'commit-msg',
  'embedding',
] as const;

export type AiPurpose = (typeof AI_PURPOSES)[number];

export const PURPOSE_LABELS: Record<AiPurpose, string> = {
  requirement: '需求生成',
  interface: '界面生成',
  techdoc: '技术文档',
  code: '代码生成',
  'memory-extract': '记忆抽取',
  'commit-msg': '提交信息',
  embedding: '向量检索',
};

export const purposeSchema = z.enum(AI_PURPOSES);

export type PurposeModelMap = Partial<Record<AiPurpose, string>>;

export interface PurposeBinding {
  /** 用途 → modelId（本地 model.id） */
  bindings: PurposeModelMap;
  /** 全部使用默认模型 */
  useDefaultForAll: boolean;
  /** 默认模型（useDefaultForAll 或某用途未绑定时使用） */
  defaultModelId: string | null;
}

export const DEFAULT_PURPOSE_BINDING: PurposeBinding = {
  bindings: {},
  useDefaultForAll: true,
  defaultModelId: null,
};

export const purposeBindingSchema = z.object({
  bindings: z.record(purposeSchema, z.string().min(1)).default({}),
  useDefaultForAll: z.boolean().default(true),
  defaultModelId: z.string().min(1).nullable().default(null),
});

/** 解析某用途实际使用的模型；未绑定则回落到默认模型 */
export function resolveModelId(binding: PurposeBinding, purpose: AiPurpose): string | null {
  if (binding.useDefaultForAll) return binding.defaultModelId;
  return binding.bindings[purpose] ?? binding.defaultModelId;
}

/** 设置某用途的绑定；传入 null 表示回到默认模型 */
export function withBinding(
  binding: PurposeBinding,
  purpose: AiPurpose,
  modelId: string | null,
): PurposeBinding {
  const bindings: PurposeModelMap = { ...binding.bindings };
  if (modelId === null) delete bindings[purpose];
  else bindings[purpose] = modelId;
  return { ...binding, bindings };
}

/** 覆盖率：用于 UI 提示"还有 N 类用途未单独指定" */
export function boundCount(binding: PurposeBinding): number {
  return AI_PURPOSES.filter((purpose) => Boolean(binding.bindings[purpose])).length;
}
