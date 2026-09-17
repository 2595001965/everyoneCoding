import { describe, expect, it } from 'vitest';
import { type PreviewMode, PreviewServer, PREVIEW_MODES } from '../preview-server';
import type { StaticHostPort } from '../static-server';

class FakeHost implements StaticHostPort {
  startedPort = 0;
  url: string | null = null;
  port: number | null = null;
  stopped = false;
  start(port: number, _root: string): Promise<{ port: number; url: string }> {
    this.startedPort = port;
    this.port = port;
    this.url = `http://localhost:${port}`;
    return Promise.resolve({ port, url: this.url });
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
}

const YAML = `openapi: 3.0.0
info:
  title: Y
  version: "1"
paths:
  /ping:
    get:
      operationId: ping
      responses:
        "200":
          description: ok
`;

describe('PreviewServer 装配', () => {
  it('loadOpenApi(null) 使用兜底 spec', () => {
    const ps = new PreviewServer({ host: new FakeHost() });
    const spec = ps.loadOpenApi(null);
    expect(spec.routes).toHaveLength(2);
  });

  it('loadOpenApi 解析 YAML', () => {
    const ps = new PreviewServer({ host: new FakeHost() });
    const spec = ps.loadOpenApi(YAML);
    expect(spec.title).toBe('Y');
    expect(spec.routes.some((r) => r.path === '/ping')).toBe(true);
  });

  it('模式切换与 PREVIEW_MODES', () => {
    const ps = new PreviewServer({ host: new FakeHost() });
    ps.setMode('linked');
    expect(ps.mode()).toBe('linked');
    expect(PREVIEW_MODES.map((m) => m.key)).toEqual(['static', 'linked', 'device']);
  });

  it('start 返回端口与 url', async () => {
    const ps = new PreviewServer({ host: new FakeHost() });
    const r = await ps.start('static');
    expect(r.ok).toBe(true);
    expect(r.data?.port).toBe(4173);
    expect(r.data?.url).toBe('http://localhost:4173');
    expect(r.data?.mode).toBe('static');
  });

  it('热更新耗时记录（注入 clock）', () => {
    let t = 0;
    const ps = new PreviewServer({
      host: new FakeHost(),
      clock: () => {
        t += 1000;
        return t;
      },
    });
    ps.requestRefresh('edit');
    const rec = ps.requestRefresh('save');
    expect(rec.elapsedMs).toBe(1000);
    expect(ps.refreshHistory()).toHaveLength(2);
    expect(ps.refreshHistory()[0]!.elapsedMs).toBeNull();
  });

  it('resolveBinding 走 mock 数据源', async () => {
    const ps = new PreviewServer({ host: new FakeHost() });
    ps.loadOpenApi(null);
    const r = await ps.resolveBinding({ url: '/health', method: 'GET' });
    expect(r.source).toBe('mock');
    expect(r.status).toBe(200);
  });

  it('stop 调用宿主 stop', async () => {
    const host = new FakeHost();
    const ps = new PreviewServer({ host });
    await ps.start('static');
    await ps.stop();
    expect(host.stopped).toBe(true);
  });

  it('未提供 process 时日志流可用', () => {
    const ps = new PreviewServer({ host: new FakeHost() });
    ps.setMode('device' as PreviewMode);
    expect(ps.logs()).toBeDefined();
  });
});
