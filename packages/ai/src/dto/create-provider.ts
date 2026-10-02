import { z } from 'zod';

import { providerBaseSchema } from '../domain/provider';
import { providerSourceSchema } from '../domain/model-route';

/**
 * 新建 Provider 入参。
 *
 * `apiKey` 仅在内存中传递：校验通过后立即写入密钥环，DB 只保存 keyRef。
 * 该字段不出现在任何持久化结构与日志里（NFR-S-01）。
 * `source` 是目录来源（V2-MDL-01）：缺省 custom（用户手建）；远程目录/配置源创建传 platform。
 */
export const createProviderSchema = providerBaseSchema.extend({
  userId: z.string().min(1, '缺少用户标识'),
  source: providerSourceSchema.default('custom'),
  /**
   * 已写入本机密钥环的引用名；明文 Key 永不跨进程传递（NFR-S-01）。
   * 保存流程：渲染层先把 Key 写入 secureStore，再把引用名交给本接口。
   */
  keyRef: z.string().trim().min(1).nullish(),
});

/** 调用方可传的原始入参（缺省字段由 zod 补齐） */
export type CreateProviderInput = z.input<typeof createProviderSchema>;
/** 校验并补默认值之后的结果 */
export type ParsedCreateProvider = z.output<typeof createProviderSchema>;

export function parseCreateProvider(input: unknown): ParsedCreateProvider {
  return createProviderSchema.parse(input);
}
