import { describe, expect, it } from 'vitest';
import { PreviewLogCollector } from '../models';
import { createFallbackOpenApi, type LoadedOpenApi } from '../mock/openapi-loader';
import { MockResponseGenerator } from '../mock/response-generator';
import {
  type BackendRequesterPort,
  type BindingResolver,
  type DataBinding,
  type StaticFixturePort,
  BindingResolver as _BR,
} from '../binding-resolver';

function makeResolver(opts: {
  backendAvailable: boolean;
  fixtureData?: unknown;
}): { resolver: BindingResolver; logs: PreviewLogCollector } {
  const logs = new PreviewLogCollector();
  const backend: BackendRequesterPort = {
    available: opts.backendAvailable,
    async request() {
      return { status: 200, data: { fromBackend: true } };
    },
  };
  const fixture: StaticFixturePort = {
    get: (url) => (opts.fixtureData !== undefined && url === '/unknown' ? opts.fixtureData : null),
  };
  const resolver = new _BR({
    openapi: createFallbackOpenApi(),
    mock: new MockResponseGenerator(),
    backend,
    fixture,
    logs,
  });
  return { resolver, logs };
}

describe('绑定解析来源优先级', () => {
  it('后端可用 → 走 backend', async () => {
    const { resolver } = makeResolver({ backendAvailable: true });
    const r = await resolver.resolve({ url: '/health', method: 'GET' });
    expect(r.source).toBe('backend');
    expect(r.data).toEqual({ fromBackend: true });
    expect(r.errorMessage).toBeNull();
  });

  it('后端不可用但路由存在 → 走 mock', async () => {
    const { resolver } = makeResolver({ backendAvailable: false });
    const r = await resolver.resolve({ url: '/health', method: 'GET' });
    expect(r.source).toBe('mock');
    expect(r.status).toBe(200);
  });

  it('后端不可用且路由不存在但有静态假数据 → 走 static', async () => {
    const { resolver } = makeResolver({ backendAvailable: false, fixtureData: { static: true } });
    const r = await resolver.resolve({ url: '/unknown', method: 'GET' });
    expect(r.source).toBe('static');
    expect(r.data).toEqual({ static: true });
  });

  it('三者皆无 → 返回 404 与错误说明', async () => {
    const { resolver } = makeResolver({ backendAvailable: false });
    const r = await resolver.resolve({ url: '/unknown', method: 'GET' });
    expect(r.source).toBe('static');
    expect(r.status).toBe(404);
    expect(r.errorMessage).not.toBeNull();
  });
});

describe('批量绑定解析', () => {
  it('解析多个绑定并返回对应数据源', async () => {
    const { resolver } = makeResolver({ backendAvailable: false, fixtureData: { static: true } });
    const bindings: DataBinding[] = [
      { elementId: 'list', kind: 'list', api: '/health', method: 'GET' },
      { elementId: 'detail', kind: 'detail', api: '/unknown', method: 'GET' },
    ];
    const results = await resolver.resolveBindings({
      bindings,
      urlOf: (api) => api,
    });
    expect(results).toHaveLength(2);
    expect(results[0]!.source).toBe('mock');
    expect(results[1]!.source).toBe('static');
  });
});

describe('setOpenApi 替换规格', () => {
  it('替换后路由来自新规格', async () => {
    const { resolver } = makeResolver({ backendAvailable: false });
    const spec: LoadedOpenApi = {
      title: 'T',
      version: '0.0.1',
      routes: [
        {
          method: 'GET',
          path: '/custom',
          operationId: 'custom',
          summary: null,
          requestSchema: null,
          responseSchema: { type: 'object', properties: { ok: { type: 'string' } } },
          tags: [],
        },
      ],
      warnings: [],
    };
    resolver.setOpenApi(spec);
    const r = await resolver.resolve({ url: '/custom', method: 'GET' });
    expect(r.source).toBe('mock');
    expect(r.status).toBe(200);
  });
});
