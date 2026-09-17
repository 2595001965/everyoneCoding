import type { IpcMainLike } from '../types';
import { CHANNELS } from '../channels';

/**
 * net IPC：受限 fetch。
 * 默认拒绝全部主机；AI 请求 / OAuth / 版本检查由上层显式放行。
 * 这是「AI 请求内容不经任何平台服务端转发」约束的技术落点之一。
 */

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export class HostAllowlist {
  private mode: 'all' | 'list' = 'list';
  private hosts = new Set<string>();

  setAllowedHosts(hosts: string[] | '*'): void {
    if (hosts === '*') {
      this.mode = 'all';
      return;
    }
    this.mode = 'list';
    this.hosts = new Set(hosts.map((host) => host.toLowerCase()));
  }

  isHostAllowed(host: string): boolean {
    if (this.mode === 'all') return true;
    return this.hosts.has(host.toLowerCase());
  }

  list(): string[] | '*' {
    return this.mode === 'all' ? '*' : [...this.hosts];
  }
}

const allowlist = new HostAllowlist();

function extractHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export function registerNetIpc(ipc: IpcMainLike): void {
  ipc.handle(CHANNELS.net.setAllowedHosts, (_e, payload) => {
    allowlist.setAllowedHosts((payload as { hosts: string[] | '*' }).hosts);
    return undefined;
  });

  ipc.handle(CHANNELS.net.isHostAllowed, (_e, payload) =>
    allowlist.isHostAllowed((payload as { host: string }).host),
  );

  ipc.handle(CHANNELS.net.fetch, async (_e, payload) => {
    const request = payload as {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string | number[];
      timeoutMs?: number;
    };

    const host = extractHost(request.url);
    if (!host) {
      throw new Error(JSON.stringify({ code: 'INVALID_ARGUMENT', message: `非法 URL: ${request.url}` }));
    }
    if (!allowlist.isHostAllowed(host)) {
      throw new Error(JSON.stringify({ code: 'NET_BLOCKED', message: `主机未放行: ${host}` }));
    }

    const method = request.method ?? 'GET';
    if (!ALLOWED_METHODS.has(method)) {
      throw new Error(JSON.stringify({ code: 'INVALID_ARGUMENT', message: `不支持的 HTTP 方法: ${method}` }));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? 60_000);
    try {
      const init: RequestInit = { method, signal: controller.signal };
      if (request.headers !== undefined) init.headers = request.headers;
      if (request.body !== undefined) {
        init.body = typeof request.body === 'string' ? request.body : Uint8Array.from(request.body);
      }
      const response = await fetch(request.url, init);
      const body = await response.text();
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      return {
        status: response.status,
        statusText: response.statusText,
        headers,
        body,
      };
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      throw new Error(
        JSON.stringify({
          code: aborted ? 'TIMEOUT' : 'NET_ERROR',
          message: aborted ? '请求超时' : error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      clearTimeout(timeout);
    }
  });
}

/** 供测试注入白名单状态 */
export function netAllowlist(): HostAllowlist {
  return allowlist;
}
