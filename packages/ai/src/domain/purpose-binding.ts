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

/**
 * 计量用途 = 可绑定用途 + 不参与绑定的后台用途（V2-USG：所有用途都计量）。
 * 连接测试是真实上游对话（可能消耗 Token），必须与生成用途分开归属，
 * 不得伪装成免费探测或并入某个业务用途。
 * 用途绑定 UI 仍只暴露 AI_PURPOSES；T11 统一升级 attempt 计量时在此扩展。
 */
export const NON_BINDING_PURPOSES = ['connection-test', 'summary', 'doc-summary', 'tool', 'background', 'api-classification', 'sub-agent'] as const;

export type UsagePurpose = AiPurpose | (typeof NON_BINDING_PURPOSES)[number];

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

/**
 * 业务侧用途别名 → 标准用途（FR-MDL-05）。
 *
 * 各域历史上各写各的用途字面量（git 写 `commit-message`、流水线写 `pipeline`、
 * 重命名写 `migration`…）。这些值不在 {@link AI_PURPOSES} 里，`resolveModelId`
 * 取不到绑定就静默回落默认模型——用户在设置页给「提交信息」绑的廉价模型永远不生效，
 * 用量统计里也出现设置页不认识的用途。网关入口统一归一，别名表是唯一口径。
 */
export const PURPOSE_ALIASES: Readonly<Record<string, AiPurpose>> = {
  'commit-message': 'commit-msg',
  commit: 'commit-msg',
  'merge-conflict': 'code',
  migration: 'code',
  rework: 'code',
  'backend-code': 'code',
  'frontend-code': 'code',
  'mobile-code': 'code',
  'harmony-code': 'code',
  'desktop-code': 'code',
  page: 'interface',
  designer: 'interface',
  memory: 'memory-extract',
  'doc-summary': 'memory-extract',
  pipeline: 'requirement',
  'tech-doc': 'techdoc',
};

/** 归一用途；未知值回落 `code`（最常见的生成用途），绝不抛错打断调用 */
export function normalizePurpose(input: string | null | undefined): AiPurpose {
  if (typeof input !== 'string') return 'code';
  const trimmed = input.trim();
  if ((AI_PURPOSES as readonly string[]).includes(trimmed)) return trimmed as AiPurpose;
  return PURPOSE_ALIASES[trimmed] ?? 'code';
}

/** 计量保存实际用途；模型绑定仍走 normalizePurpose，不把后台用途都压成 code。 */
export function normalizeUsagePurpose(input: string): string {
  const value = input.trim();
  if (!value) return 'code';
  if ((NON_BINDING_PURPOSES as readonly string[]).includes(value)) return value;
  return PURPOSE_ALIASES[value] ?? value;
}
