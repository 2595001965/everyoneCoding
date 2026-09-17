/**
 * 静态预览服务门面。
 *
 * 不自行起 HTTP：通过注入的 StaticHostPort 把本地文件服务能力交给外壳（Shell API）提供，
 * 这样本模块在浏览器/渲染层也能安全引用（无 node:* 依赖）。测试可注入内存假实现。
 */

import { DEFAULT_PREVIEW_PORT, type PortProbe, allocatePort } from './port-manager';
import { PreviewLogCollector, type PreviewResult, fail, ok } from './models';

/** 通过端口注入的本地 HTTP 服务能力（生产由外壳 Shell API 提供；测试注入内存假实现）。 */
export interface StaticHostPort {
  start(port: number, root: string): Promise<{ port: number; url: string }>;
  stop(): Promise<void>;
  readonly url: string | null;
  readonly port: number | null;
}

export class StaticPreviewServer {
  private readonly host: StaticHostPort;
  private readonly startPort: number;
  private readonly probe: PortProbe;
  private readonly staticRoot: (path: string) => string | null;
  private readonly logs: PreviewLogCollector;
  private running = false;

  constructor(opts: {
    host: StaticHostPort;
    startPort?: number;
    probe?: PortProbe;
    staticRoot?: (path: string) => string | null;
  }) {
    this.host = opts.host;
    this.startPort = opts.startPort ?? DEFAULT_PREVIEW_PORT;
    this.probe = opts.probe ?? (async () => true);
    this.staticRoot = opts.staticRoot ?? (() => null);
    this.logs = new PreviewLogCollector();
  }

  async start(): Promise<PreviewResult<{ port: number; url: string }>> {
    const alloc = await allocatePort({ start: this.startPort, probe: this.probe });
    if (alloc.log) this.logs.info(alloc.log);
    const started = await this.host.start(alloc.port, '');
    this.running = true;
    this.logs.info(`静态预览已启动：${started.url}`);
    return ok({ port: started.port, url: started.url }, this.logs.entries());
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    await this.host.stop();
    this.running = false;
    this.logs.info('静态预览已停止');
  }

  /** 返回托管内容（缺资源返回 fail）。 */
  async serve(path: string): Promise<PreviewResult<string>> {
    const content = this.staticRoot(path);
    if (content === null) {
      this.logs.warn(`静态资源缺失：${path}`);
      return fail('STATIC_MISSING', `未找到静态资源：${path}`, this.logs.entries());
    }
    return ok(content, this.logs.entries());
  }
}
