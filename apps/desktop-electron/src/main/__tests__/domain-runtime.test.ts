import { describe, expect, it, vi } from 'vitest';

import { DOMAIN_KINDS, createDomainEventSink, type DomainRpcRequest } from '@ec/shell-api';

import { createDomainRuntime, type DomainRouter } from '../domain/runtime';

/**
 * 域运行时聚合器测试。
 *
 * 四条纪律必须锁住：
 * 1. 白名单封闭（未登记域/未登记方法一律拒绝，不做反射）；
 * 2. `describe()` 如实（未装配报 false 并给原因，不谎报可用）；
 * 3. 错误脱敏后才回渲染层；
 * 4. 事件信封的 requestId/domain 由本层补齐（域实现只给载荷）。
 */

function request(overrides: Partial<DomainRpcRequest> = {}): DomainRpcRequest {
  return { requestId: 'r1', domain: 'settings', method: 'getAll', params: {}, ...overrides };
}

describe('createDomainRuntime 白名单与路由', () => {
  it('已装配域正常分发并把结果带回', async () => {
    const router: DomainRouter = vi.fn(async (method) => ({ echo: method }));
    const runtime = createDomainRuntime({ routers: { settings: router } });

    const response = await runtime.invoke(request({ method: 'update', params: { patch: { theme: 'dark' } } }));
    expect(response).toEqual({ requestId: 'r1', ok: true, result: { echo: 'update' } });
    // 第三参数为请求上下文（requestId + emit），断言前两项即可
    expect(router).toHaveBeenCalledWith('update', { patch: { theme: 'dark' } }, expect.anything());
  });

  it('白名单外的方法被拒，且不调用路由', async () => {
    const router: DomainRouter = vi.fn(async () => 'ok');
    const runtime = createDomainRuntime({ routers: { settings: router } });

    const response = await runtime.invoke(request({ method: '不存在的放法' }));
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('INVALID_ARGUMENT');
    expect(router).not.toHaveBeenCalled();
  });

  it('越域方法被拒：settings 域的 login 不在白名单内', async () => {
    const runtime = createDomainRuntime({ routers: { settings: vi.fn(async () => 'ok') } });
    const response = await runtime.invoke(request({ domain: 'settings', method: 'login' }));
    expect(response.error?.code).toBe('INVALID_ARGUMENT');
  });

  it('非法 domain 被拒', async () => {
    const runtime = createDomainRuntime({ routers: {} });
    const response = await runtime.invoke(request({ domain: 'database' as never }));
    expect(response.error?.code).toBe('INVALID_ARGUMENT');
  });

  it('未装配域返回 NOT_SUPPORTED 与登记的原因', async () => {
    const runtime = createDomainRuntime({
      routers: { settings: vi.fn(async () => undefined) },
      unavailableReasons: { docs: '缺 DocStore 装配' },
    });
    const response = await runtime.invoke(request({ domain: 'docs', method: 'listDocuments' }));
    expect(response.error?.code).toBe('NOT_SUPPORTED');
    expect(response.error?.message).toBe('缺 DocStore 装配');
  });

  it('params 非对象时退化为空对象，不抛错', async () => {
    const router = vi.fn<DomainRouter>(async () => 'ok');
    const runtime = createDomainRuntime({ routers: { settings: router } });
    await runtime.invoke(request({ params: 'not-an-object' }));
    expect(router).toHaveBeenCalledWith('getAll', {}, expect.anything());
  });

  it('路由返回 undefined 时不带 result 字段', async () => {
    const runtime = createDomainRuntime({ routers: { settings: async () => undefined } });
    const response = await runtime.invoke(request({ method: 'setTelemetry' }));
    expect(response).toEqual({ requestId: 'r1', ok: true });
    expect('result' in response).toBe(false);
  });

  it('ctx.emit 推事件时由本层补齐 requestId 与 domain（域实现只管载荷）', async () => {
    const sink = createDomainEventSink();
    const router: DomainRouter = async (_method, _params, ctx) => {
      ctx.emit({ stage: 'clone', ratio: 0.5 });
      return 'ok';
    };
    const runtime = createDomainRuntime({ routers: { workspace: router }, events: sink });

    const events: unknown[] = [];
    sink.register('r1', (event) => events.push(event));
    await runtime.invoke(request({ domain: 'workspace', method: 'importFromGit' }));

    expect(events).toEqual([
      { requestId: 'r1', domain: 'workspace', payload: { stage: 'clone', ratio: 0.5 } },
    ]);
  });

  it('ctx.emit 在无订阅者时静默丢弃，不影响路由结果', async () => {
    const router: DomainRouter = async (_method, _params, ctx) => {
      ctx.emit({ stage: 'clone' });
      return 'ok';
    };
    const runtime = createDomainRuntime({ routers: { workspace: router } });
    const response = await runtime.invoke(request({ domain: 'workspace', method: 'importFromGit' }));
    expect(response).toEqual({ requestId: 'r1', ok: true, result: 'ok' });
  });
});

describe('createDomainRuntime describe 如实上报', () => {
  it('覆盖四个域，已装配 true、未装配 false 且带原因', async () => {
    const runtime = createDomainRuntime({
      routers: { settings: async () => undefined },
      unavailableReasons: { workspace: '缺 ProjectStore' },
    });
    const descriptors = await runtime.describe();
    expect(descriptors.map((item) => item.kind)).toEqual([...DOMAIN_KINDS]);
    expect(descriptors.find((item) => item.kind === 'settings')).toEqual({ kind: 'settings', available: true });
    expect(descriptors.find((item) => item.kind === 'workspace')).toEqual({
      kind: 'workspace',
      available: false,
      reason: '缺 ProjectStore',
    });
    expect(descriptors.filter((item) => !item.available).every((item) => Boolean(item.reason))).toBe(true);
  });
});

describe('createDomainRuntime 错误处理', () => {
  it('路由抛出的结构化错误原样映射并脱敏', async () => {
    const runtime = createDomainRuntime({
      routers: {
        settings: async () => {
          throw { code: 'NOT_SUPPORTED', message: 'token=secret123 不可用' };
        },
      },
    });
    const response = await runtime.invoke(request());
    expect(response.error?.code).toBe('NOT_SUPPORTED');
    expect(response.error?.message).not.toContain('secret123');
  });

  it('普通异常归为 UNKNOWN，不把堆栈带回渲染层', async () => {
    const runtime = createDomainRuntime({
      routers: {
        settings: async () => {
          throw new Error('炸了');
        },
      },
    });
    const response = await runtime.invoke(request());
    expect(response.error?.code).toBe('UNKNOWN');
    expect(response.error?.message).toBe('炸了');
  });

  it('dispose 幂等且单域失败不阻断其余释放', async () => {
    const second = vi.fn(async () => undefined);
    const runtime = createDomainRuntime({
      routers: {},
      disposers: [
        async () => {
          throw new Error('第一个失败');
        },
        second,
      ],
    });
    await expect(runtime.dispose()).resolves.toBeUndefined();
    await expect(runtime.dispose()).resolves.toBeUndefined();
    expect(second).toHaveBeenCalledTimes(2);
  });
});
