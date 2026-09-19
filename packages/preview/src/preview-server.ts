/**
 * 预览总装门面：把静态服务、Mock 生成、绑定解析、后端托管拼成统一出口。
 *
 * 所有外部能力（HTTP 服务、子进程）都通过端口注入，领域层不引用 node:*，
 * 因此浏览器/渲染层也能安全引用本门面（preview-server 的纯部分）。
 *
 * 破坏性操作（停止进程、切换模式导致的服务重启）只在领域层暴露能力，二次确认由渲染层负责。
 */

import { PreviewLogCollector, type PreviewResult } from './models';
import { fail, ok } from './models';
import type { PortProbe } from './port-manager';
import { StaticPreviewServer } from './static-server';
import type { StaticHostPort } from './static-server';
import { LogStream } from './backend/log-stream';
import { BackendRunner, type ProcessHostPort } from './backend/runner';
import type { MockSettings } from './mock/rules';
import { MockResponseGenerator } from './mock/response-generator';
import {
  type BackendRequesterPort,
  type BindingResolver,
  type StaticFixturePort,
  BindingResolver as _BR,
} from './binding-resolver';
import type { ResolveInput } from './binding-resolver';
import {
  type LoadedOpenApi,
  createFallbackOpenApi,
  parseOpenApiDocument,
} from './mock/openapi-loader';

export type PreviewMode = 'static' | 'linked' | 'device';

export const PREVIEW_MODES: readonly { key: PreviewMode; label: string; description: string }[] = [
  { key: 'static', label: '静态预览', description: '仅托管静态产物，使用内置 Mock / 静态假数据' },
  { key: 'linked', label: '联动预览', description: '与运行中的后端联动，自动代理真实接口' },
  { key: 'device', label: '设备预览', description: '模拟目标设备视口与环境的预览' },
];

const NOOP_BACKEND: BackendRequesterPort = {
  available: false,
  async request() {
    return { status: 0, data: null };
  },
};

const NOOP_FIXTURE: StaticFixturePort = {
  get: () => null,
};

export interface RefreshRecord {
  at: number;
  elapsedMs: number | null;
  reason: string;
}

export class PreviewServer {
  private readonly logStream: LogStream;
  private readonly collector: PreviewLogCollector;
  private openapi: LoadedOpenApi;
  private readonly mock: MockResponseGenerator;
  private readonly staticServer: StaticPreviewServer;
  private readonly resolver: BindingResolver;
  private runner: BackendRunner | undefined;
  private currentMode: PreviewMode = 'static';
  private readonly clock: () => number;
  private refreshLog: RefreshRecord[] = [];
  private lastRefreshAt: number | null = null;

  constructor(opts: {
    host: StaticHostPort;
    process?: ProcessHostPort;
    openapi?: LoadedOpenApi;
    settings?: MockSettings;
    startPort?: number;
    probe?: PortProbe;
    clock?: () => number;
  }) {
    this.clock = opts.clock ?? (() => Date.now());
    this.logStream = new LogStream({ clock: this.clock });
    this.collector = new PreviewLogCollector({ clock: this.clock });
    this.openapi = opts.openapi ?? createFallbackOpenApi();
    this.mock = new MockResponseGenerator({
      ...(opts.settings !== undefined ? { settings: opts.settings } : {}),
      clock: this.clock,
    });
    this.staticServer = new StaticPreviewServer({
      host: opts.host,
      ...(opts.startPort !== undefined ? { startPort: opts.startPort } : {}),
      ...(opts.probe !== undefined ? { probe: opts.probe } : {}),
    });
    if (opts.process) {
      this.runner = new BackendRunner({
        process: opts.process,
        logs: this.logStream,
        ...(opts.startPort !== undefined ? { startPort: opts.startPort } : {}),
        ...(opts.probe !== undefined ? { probe: opts.probe } : {}),
        clock: this.clock,
      });
    }
    this.resolver = new _BR({
      openapi: this.openapi,
      mock: this.mock,
      backend: NOOP_BACKEND,
      fixture: NOOP_FIXTURE,
      logs: this.collector,
      clock: this.clock,
    });
  }

  /** 加载 OpenAPI 文档；null → createFallbackOpenApi()。 */
  loadOpenApi(text: string | null): LoadedOpenApi {
    const spec = text === null ? createFallbackOpenApi() : parseOpenApiDocument(text);
    this.openapi = spec;
    this.resolver.setOpenApi(spec);
    return spec;
  }

  resolverInstance(): BindingResolver {
    return this.resolver;
  }

  logs(): LogStream {
    return this.logStream;
  }

  setMode(mode: PreviewMode): void {
    this.currentMode = mode;
    this.logStream.info(`预览模式切换为：${mode}`);
  }

  mode(): PreviewMode {
    return this.currentMode;
  }

  /** 启动预览。破坏性操作（切换模式会重启服务），二次确认由渲染层负责。 */
  async start(
    mode: PreviewMode,
  ): Promise<PreviewResult<{ port: number; url: string; mode: PreviewMode }>> {
    this.setMode(mode);
    const r = await this.staticServer.start();
    if (!r.ok) return fail('PREVIEW_START_FAILED', '静态预览启动失败', r.logs);
    const data = r.data as { port: number; url: string };
    return ok({ port: data.port, url: data.url, mode }, r.logs);
  }

  async stop(): Promise<void> {
    await this.staticServer.stop();
    if (this.runner) await this.runner.stop();
    this.logStream.info('预览已停止');
  }

  /**
   * 热更新：记录一次刷新与耗时（ms），用于验收"变更后预览刷新 ≤3s"。
   * 领域层只记录 cadence，真实刷新由渲染层/外壳完成。
   */
  requestRefresh(reason: string): RefreshRecord {
    const at = this.clock();
    const elapsedMs = this.lastRefreshAt === null ? null : at - this.lastRefreshAt;
    const record: RefreshRecord = { at, elapsedMs, reason };
    this.refreshLog.push(record);
    this.lastRefreshAt = at;
    return record;
  }

  refreshHistory(): readonly RefreshRecord[] {
    return this.refreshLog.slice();
  }

  /** 便捷：用当前 openapi 解析一个绑定（供渲染层直接调用）。 */
  resolveBinding(input: ResolveInput) {
    return this.resolver.resolve(input);
  }
}
