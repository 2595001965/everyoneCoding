import { z } from 'zod';
import { providerModelKeyOf, providerModelRouteSchema, type ProviderModelRoute } from '@ec/core';

/**
 * 模型复合路由身份（V2-MDL-02，PRD §11.1 Provider/ProviderModel）。
 *
 * 一条「路由」= 确定的一次上游请求落点，由 Provider 身份 + 模型标识共同决定：
 * - `modelId` 是发给上游的模型标识字符串（`model.name`，如 `gpt-4o`）；
 * - 相同 `modelId` 允许同时存在于 A/B 多个 Provider，各自独立价格、能力、Key、限流与账单；
 * - `providerModelId` 是把两者拼成的唯一字符串句柄（`<providerId>:<modelId>`），
 *   供远程目录（T17）、价格版本与跨系统引用使用；本地存储主键仍是 model 行 ULID。
 *
 * 与 core v2 公共契约（`@ec/core` 的 `ProviderModelRoute`）的分层口径——**两个键空间不等价、
 * 不得互相解析**（V2-D00 收口；转换只经本文件的两个函数，别处不得再拼路由字符串）：
 *
 * | 语义槽位         | 本文件（ai 生产路由）                          | core v2 公共契约                            |
 * | ---------------- | ---------------------------------------------- | ------------------------------------------- |
 * | 本地模型行主键   | `ModelRoute.modelRowId`（ULID）                | `ProviderModelRoute.modelId`（同一 ULID）   |
 * | 上游模型名       | `ModelRoute.modelId`（`model.name`）           | 不出现（core 路由不含名字）                 |
 * | Provider ID      | `providerId`（ULID）                           | `providerId`（ULID）                        |
 * | 持久化路由键     | `providerModelId` = `providerId:模型名`（colon，DB `model.provider_model_id` 列 / 远程目录引用；模型改名则句柄随之改） | `providerModelKeyOf` = `providerId/modelRowId`（slash，usage_attempt / price_version / 账单行引用；绑 ULID，与改名无关） |
 *
 * 硬规则（V2 冲突表 / V2-MDL-01）：
 * - 同名 Provider / 同名 Model 不因显示名或模型名相同而合并；路由键不同即不同路由。
 * - `canonicalVendor/canonicalModel` 是模型官方身份，只用于查能力与官方价格参考（T17），
 *   绝不参与路由解析；没有可靠证据时保持 null，不做字符串相似度猜测。
 */

export const PROVIDER_SOURCES = ['platform', 'custom'] as const;

export type ProviderSource = (typeof PROVIDER_SOURCES)[number];

export const providerSourceSchema = z.enum(PROVIDER_SOURCES);

export const PROVIDER_SOURCE_LABELS: Record<ProviderSource, string> = {
  platform: '目录',
  custom: '自建',
};

/** providerModelId 的分段符：providerId 是 ULID（不含 `:`），取第一段即 Provider */
export const MODEL_ROUTE_SEPARATOR = ':';

/** 复合路由键；两段都必须非空 */
export function providerModelIdOf(providerId: string, modelId: string): string {
  if (!providerId || !modelId) throw new Error('复合路由键需要 providerId 与 modelId');
  return `${providerId}${MODEL_ROUTE_SEPARATOR}${modelId}`;
}

/** 解析复合路由键；格式非法返回 null，不猜 */
export function parseProviderModelId(
  value: string,
): { providerId: string; modelId: string } | null {
  const index = value.indexOf(MODEL_ROUTE_SEPARATOR);
  if (index <= 0 || index === value.length - 1) return null;
  return { providerId: value.slice(0, index), modelId: value.slice(index + 1) };
}

/* ------------- core v2 公共契约的单点转换（V2-D00；两键空间不互换） ------------- */

/**
 * ai 生产路由 → core v2 公共路由（usage、价格版本、账务的持久化口径）。
 *
 * 无损：core 路由只取 `providerId` + 本地 `modelRowId`，上游名不进入 core 路由。
 * 后续写 usage / 价格记录时用 [`persistentRouteKeyOf`] 产出路由键。
 */
export function coreRouteOfModelRoute(route: ModelRoute): ProviderModelRoute {
  return { providerId: route.providerId, modelId: route.modelRowId };
}

/**
 * core v2 公共路由 → ai 生产路由；发上游请求时调用。
 *
 * `upstreamName` 必须来自该路由 `modelId`（本地 model 行 ULID）对应 model 行的 `name`
 * ——调用方查行回填，本函数不按名字反查（避免同名跨渠道猜路由）。
 * 路由 ULID 非法或上游名为空返回 null，不猜。
 */
export function modelRouteOfCoreRoute(
  route: ProviderModelRoute,
  upstreamName: string,
): ModelRoute | null {
  const parsed = providerModelRouteSchema.safeParse(route);
  if (!parsed.success || upstreamName.trim().length === 0) return null;
  return {
    modelRowId: parsed.data.modelId,
    providerId: parsed.data.providerId,
    modelId: upstreamName,
    providerModelId: providerModelIdOf(parsed.data.providerId, upstreamName),
  };
}

/** 本地 model 行的公共用量/价格路由键（`providerId/modelRowId`）；不随模型改名漂移 */
export function persistentRouteKeyOf(route: Pick<ModelRoute, 'providerId' | 'modelRowId'>): string {
  return providerModelKeyOf({ providerId: route.providerId, modelId: route.modelRowId });
}

/** 一条可发起请求的路由引用（模型行 + 其复合身份） */
export interface ModelRoute {
  /** 本地 model 行 ID（ULID，存储主键） */
  modelRowId: string;
  providerId: string;
  /** 上游模型标识（model.name） */
  modelId: string;
  /** 唯一复合路由键 */
  providerModelId: string;
}

export function routeOfModel(model: {
  id: string;
  providerId: string;
  name: string;
  providerModelId?: string | null;
}): ModelRoute {
  return {
    modelRowId: model.id,
    providerId: model.providerId,
    modelId: model.name,
    providerModelId: model.providerModelId ?? providerModelIdOf(model.providerId, model.name),
  };
}

/** 路由归属校验：providerModelId 与 (providerId, modelId) 必须指向同一条路由 */
export function routeMatches(
  route: { providerId: string; modelId: string; providerModelId: string | null },
  providerId: string,
  modelId: string,
): boolean {
  return route.providerId === providerId && route.modelId === modelId;
}
