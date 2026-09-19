/**
 * 数据绑定解析：把页面上的元素绑定（list/form/detail/action）解析为真实响应。
 *
 * 优先级（FR-PRV-02）：真实运行中的后端 > 内置 Mock Server > 静态假数据。
 * 各数据源能力通过端口注入，领域层不做实际网络/HTTP 请求。
 */

import { type HttpMethodName, PreviewLogCollector } from './models';
import type { LoadedOpenApi } from './mock/openapi-loader';
import { matchRoute } from './mock/openapi-loader';
import type { MockResponseGenerator } from './mock/response-generator';

export interface DataBinding {
  elementId: string;
  kind: 'list' | 'form' | 'detail' | 'action';
  api: string; // 形如 /users
  method?: HttpMethodName;
  body?: unknown;
}

export interface ResolveInput {
  url: string;
  method?: HttpMethodName;
  headers?: Record<string, string>;
  body?: unknown;
  binding?: DataBinding | null;
}

export interface ResolvedResponse {
  status: number;
  data: unknown;
  source: 'backend' | 'mock' | 'static';
  latencyMs: number;
  url: string;
  method: HttpMethodName;
  errorMessage: string | null;
}

export interface BackendRequesterPort {
  readonly available: boolean;
  request(input: {
    url: string;
    method: HttpMethodName;
    headers?: Record<string, string>;
    body?: unknown;
  }): Promise<{ status: number; data: unknown }>;
}

export interface StaticFixturePort {
  get(url: string, method: HttpMethodName): unknown | null;
}

export class BindingResolver {
  private openapi: LoadedOpenApi;
  private readonly mock: MockResponseGenerator;
  private readonly backend: BackendRequesterPort;
  private readonly fixture: StaticFixturePort;
  private readonly logs: PreviewLogCollector;
  private readonly clock: () => number;

  constructor(opts: {
    openapi: LoadedOpenApi;
    mock: MockResponseGenerator;
    backend: BackendRequesterPort;
    fixture: StaticFixturePort;
    logs?: PreviewLogCollector;
    clock?: () => number;
  }) {
    this.openapi = opts.openapi;
    this.mock = opts.mock;
    this.backend = opts.backend;
    this.fixture = opts.fixture;
    this.logs = opts.logs ?? new PreviewLogCollector();
    this.clock = opts.clock ?? (() => Date.now());
  }

  setOpenApi(spec: LoadedOpenApi): void {
    this.openapi = spec;
    this.logs.info(
      `已加载 OpenAPI：${spec.title} v${spec.version}（${spec.routes.length} 条路由）`,
    );
  }

  /** 优先级：真实运行中的后端 > 内置 Mock Server > 静态假数据（FR-PRV-02）。 */
  async resolve(input: ResolveInput): Promise<ResolvedResponse> {
    const method: HttpMethodName = input.method ?? 'GET';
    const start = this.clock();
    const finish = (
      partial: Omit<ResolvedResponse, 'latencyMs' | 'url' | 'method'>,
    ): ResolvedResponse => ({
      ...partial,
      latencyMs: this.clock() - start,
      url: input.url,
      method,
    });

    // 1) 真实后端
    if (this.backend.available) {
      this.logs.debug(`走后端数据源：${method} ${input.url}`);
      const r = await this.backend.request({
        url: input.url,
        method,
        ...(input.headers !== undefined ? { headers: input.headers } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
      });
      return finish({ status: r.status, data: r.data, source: 'backend', errorMessage: null });
    }

    // 2) 内置 Mock Server
    const matched = matchRoute(this.openapi.routes, method, input.url);
    if (matched) {
      this.logs.debug(
        `走 Mock 数据源：${method} ${input.url} -> ${matched.route.operationId ?? matched.route.path}`,
      );
      const mock = this.mock.generate({
        route: matched.route,
        ...(matched.params !== undefined ? { params: matched.params } : {}),
      });
      return finish({
        status: mock.status,
        data: mock.body,
        source: 'mock',
        errorMessage: mock.status >= 400 ? `Mock 返回错误状态 ${mock.status}` : null,
      });
    }

    // 3) 静态假数据
    const fixture = this.fixture.get(input.url, method);
    if (fixture !== null) {
      this.logs.debug(`走静态假数据：${method} ${input.url}`);
      return finish({ status: 200, data: fixture, source: 'static', errorMessage: null });
    }

    this.logs.warn(`未匹配任何数据源：${method} ${input.url}`);
    return finish({
      status: 404,
      data: null,
      source: 'static',
      errorMessage: '未找到匹配的后端、Mock 或静态假数据',
    });
  }

  /** 页面级绑定批量解析（列表/表单/详情）。 */
  async resolveBindings(input: {
    bindings: readonly DataBinding[];
    urlOf: (api: string, method: HttpMethodName) => string;
  }): Promise<ResolvedResponse[]> {
    const results: ResolvedResponse[] = [];
    for (const binding of input.bindings) {
      const method = binding.method ?? 'GET';
      const url = input.urlOf(binding.api, method);
      const r = await this.resolve({
        url,
        method,
        ...(binding.body !== undefined ? { body: binding.body } : {}),
        binding,
      });
      results.push(r);
    }
    return results;
  }
}
