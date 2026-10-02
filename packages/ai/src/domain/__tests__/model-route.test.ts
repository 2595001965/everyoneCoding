import { parseProviderModelKey } from '@ec/core';
import { describe, expect, it } from 'vitest';

import {
  coreRouteOfModelRoute,
  modelRouteOfCoreRoute,
  parseProviderModelId,
  persistentRouteKeyOf,
  routeOfModel,
} from '../model-route';

/**
 * V2-D00：core v2 公共路由（本地行 ULID + slash 键）与 ai 生产路由（上游模型名 +
 * colon 句柄）的单点转换契约。真实 model 行必须能无歧义转换到公共用量/价格路由；
 * 两个键空间不得互相解析（V2-MDL-02，V2-E2E-12：同名模型跨渠道不得串路由）。
 */

const PROVIDER_A = '01JD8W3G5X9Q7Z4K2M6T8YV0RA';
const PROVIDER_B = '01JD8W3G5X9Q7Z4K2M6T8YV0RB';
const ROW_A = '01JD8W3G5X9Q7Z4K2M6T8YV0RC';
const ROW_B = '01JD8W3G5X9Q7Z4K2M6T8YV0RD';

describe('ai 生产路由 ↔ core v2 公共路由的单点转换（V2-D00）', () => {
  it('真实 model 行 → ai 路由 → core 路由 → slash 路由键，可无歧义解析往返', () => {
    const routeA = routeOfModel({ id: ROW_A, providerId: PROVIDER_A, name: 'shared-model' });
    const keyA = persistentRouteKeyOf(routeA);

    // slash 键绑本地行 ULID：providerId/modelRowId，解析回同一条路由
    expect(keyA).toBe(`${PROVIDER_A}/${ROW_A}`);
    expect(parseProviderModelKey(keyA)).toEqual({ providerId: PROVIDER_A, modelId: ROW_A });

    // 模型名不进入公共路由键（改名不漂移），上游名只在 ai 侧 modelId 字段
    expect(keyA).not.toContain('shared-model');
    expect(routeA.modelId).toBe('shared-model');
    expect(routeA.providerModelId).toBe(`${PROVIDER_A}:shared-model`);
  });

  it('同名模型在 A/B 两渠道各自成键，转换后仍不串渠道', () => {
    const routeA = routeOfModel({ id: ROW_A, providerId: PROVIDER_A, name: 'shared-model' });
    const routeB = routeOfModel({ id: ROW_B, providerId: PROVIDER_B, name: 'shared-model' });

    const keyA = persistentRouteKeyOf(routeA);
    const keyB = persistentRouteKeyOf(routeB);
    expect(keyA).not.toBe(keyB);
    expect(parseProviderModelKey(keyB)).toEqual({ providerId: PROVIDER_B, modelId: ROW_B });

    // colon 句柄同理按渠道隔离
    expect(routeA.providerModelId).not.toBe(routeB.providerModelId);
  });

  it('core 路由 + 上游名 → ai 路由：往返一致；ai → core 无损', () => {
    const coreRoute = { providerId: PROVIDER_A, modelId: ROW_A };
    const restored = modelRouteOfCoreRoute(coreRoute, 'shared-model');

    expect(restored).not.toBeNull();
    expect(restored).toMatchObject({
      modelRowId: ROW_A,
      providerId: PROVIDER_A,
      modelId: 'shared-model',
      providerModelId: `${PROVIDER_A}:shared-model`,
    });
    expect(coreRouteOfModelRoute(restored!)).toEqual(coreRoute);
  });

  it('两个键空间不得互相解析：colon 键不是 slash 键，slash 键不是 colon 键', () => {
    expect(parseProviderModelKey(`${PROVIDER_A}:shared-model`)).toBeNull();
    expect(parseProviderModelId(`${PROVIDER_A}/${ROW_A}`)).toBeNull();
  });

  it('core 路由非法或上游名为空时返回 null，不猜、不造路由', () => {
    expect(
      modelRouteOfCoreRoute({ providerId: PROVIDER_A, modelId: 'not-a-ulid' }, 'gpt-4o'),
    ).toBeNull();
    expect(modelRouteOfCoreRoute({ providerId: 'bad', modelId: ROW_A }, 'gpt-4o')).toBeNull();
    expect(modelRouteOfCoreRoute({ providerId: PROVIDER_A, modelId: ROW_A }, '  ')).toBeNull();
  });
});
