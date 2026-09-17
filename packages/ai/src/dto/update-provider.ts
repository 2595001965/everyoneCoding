import { z } from 'zod';

import { providerBaseSchema } from '../domain/provider';

/**
 * 更新 Provider 入参。
 *
 * - 全字段可选；`version` 用于乐观锁，传入时版本不符直接抛 ConflictError
 * - `apiKey` 为 undefined 表示不改；为 null 表示删除已保存的 Key
 */
export const updateProviderSchema = providerBaseSchema
  .partial()
  .extend({
    /** 密钥环引用名；null 表示删除已保存的 Key，明文永不跨进程传递 */
    keyRef: z.string().trim().min(1).nullish(),
    version: z.number().int().min(1).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '没有任何需要更新的字段' });

/** 调用方可传的原始补丁（全字段可选） */
export type UpdateProviderInput = z.input<typeof updateProviderSchema>;
/** 校验后的补丁 */
export type ParsedUpdateProvider = z.output<typeof updateProviderSchema>;

export function parseUpdateProvider(input: unknown): ParsedUpdateProvider {
  return updateProviderSchema.parse(input);
}
