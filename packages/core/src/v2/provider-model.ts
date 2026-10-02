/**
 * V2 公共契约 —— Provider+Model 复合路由身份（V2-T01；PRD V2-MDL-01/02、§11.1）。
 *
 * 现状（T01 核验）：库内 `model.id` 为全局 ULID 主键 + `provider_id` 外键，
 * 同名模型**已经**可以分属多个 Provider；但用途绑定、IPC 请求、usage 记录
 * 全部只引用 modelId 单键。本契约把"路由身份"固化为复合结构：
 *
 * - `ProviderModelRoute { providerId, modelId }` 是请求/绑定/计量/账单的唯一路由口径
 * - `providerModelKeyOf(route)` 产出可序列化字符串键（`{providerId}/{modelId}`），
 *   用于 usage、价格版本、账单等只存一个字符串的场景；**禁止用 model 名或
 *   canonicalModel 充当路由键**（V2-E2E-12：同 modelId 异 Provider 不得串渠道）
 * - `canonicalVendor/canonicalModel` 只用于查官方能力/价格参考，可空；不得据此合并路由
 *
 * 与 AI 域生产路由（`@ec/ai` 的 `ModelRoute`）的键空间分层（V2-D00）：ai 侧 `modelId`
 * 是**上游模型名**，句柄为 `providerId:模型名`（colon）；本契约的 `modelId` 是**本地
 * model 行 ULID**。两键不得互相解析，转换只走 ai 包 `coreRouteOfModelRoute` /
 * `modelRouteOfCoreRoute` 单点衔接，core 不反向依赖 ai。
 */
import { z } from 'zod';
import {
  epochMsSchema,
  provenanceKind,
  revisionSchema,
  ulidSchema,
  type ProvenanceKind,
} from './primitives';

export const providerSourceSchema = z.enum(['platform', 'custom']);
export type ProviderSource = z.infer<typeof providerSourceSchema>;

/** 与现有库内 provider.protocol 一致（V2-MDL-05：不强迫用户改协议） */
export const providerProtocolSchema = z.enum(['openai', 'anthropic']);
export type ProviderProtocol = z.infer<typeof providerProtocolSchema>;

/** 复合路由：请求、用途绑定、用量、价格、账单都必须引用这个二元组 */
export interface ProviderModelRoute {
  providerId: string;
  modelId: string;
}

export const providerModelRouteSchema = z.object({
  providerId: ulidSchema,
  modelId: ulidSchema,
});

/** 路由键序列化：`{providerId}/{modelId}`（usage_attempt / price_version / 账单行引用） */
export function providerModelKeyOf(route: ProviderModelRoute): string {
  return `${route.providerId}/${route.modelId}`;
}

/** 解析路由键；格式不符返回 null（不得猜测纠正） */
export function parseProviderModelKey(key: string): ProviderModelRoute | null {
  const idx = key.indexOf('/');
  if (idx <= 0 || idx !== key.lastIndexOf('/')) return null;
  const providerId = key.slice(0, idx);
  const modelId = key.slice(idx + 1);
  const parsed = providerModelRouteSchema.safeParse({ providerId, modelId });
  return parsed.success ? parsed.data : null;
}

/**
 * Provider+Model 档案。新增领域的存储目标位置：客户端复用现有 provider/model 表
 * （T02 迁移）；平台目录为服务端**拟新增**领域（T17 落位 services 端）。
 */
export interface ProviderModelInfo {
  providerId: string;
  modelId: string;
  /** 目录来源：platform=平台目录/远程配置源下发，custom=用户手建（与现有表枚举一致） */
  providerSource: ProviderSource;
  /** 展示名（可空）；同名显示名不因合并路由而冲突 */
  displayName: string | null;
  protocol: ProviderProtocol;
  /** 自定义 Provider 的 API 地址；平台路由不下发上游地址（V2-WEB-07） */
  baseUrl: string | null;
  /** 官方身份（只用于查能力/官方价格参考；可空，不得当路由键） */
  canonicalVendor: string | null;
  canonicalModel: string | null;
  /** 有效上下文窗口（token）；null = 未知，按 PRD FR-AI-02 替换规则不得硬编码 */
  contextWindowTokens: number | null;
  contextWindowSource: ProvenanceKind | null;
  /** 能力标签（如 tool_use / vision / cache）；null = 未知 */
  capabilities: string[] | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export const providerModelInfoSchema = z.object({
  providerId: ulidSchema,
  modelId: ulidSchema,
  providerSource: providerSourceSchema,
  displayName: z.string().min(1).nullable(),
  protocol: providerProtocolSchema,
  baseUrl: z.string().url().nullable(),
  canonicalVendor: z.string().min(1).nullable(),
  canonicalModel: z.string().min(1).nullable(),
  contextWindowTokens: z.number().int().positive().nullable(),
  contextWindowSource: provenanceKind.nullable(),
  capabilities: z.array(z.string().min(1)).nullable(),
  revision: revisionSchema,
  createdAt: epochMsSchema,
  updatedAt: epochMsSchema,
});
