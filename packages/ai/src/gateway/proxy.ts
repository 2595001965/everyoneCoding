import { z } from 'zod';

import type { ProxyConfig } from '../core/http';
import { openTunnel } from '../core/tunnel';

/**
 * AI 请求独立代理（FR-MDL-11）。
 *
 * 与系统代理分离：用户可只为 AI 请求配一个出口，不影响 Git / 依赖安装。
 * 支持 http / https / socks5 三种形态，字符串与结构化配置双向转换（配置页用字符串，内部用结构）。
 */

const PORT_MAX = 65535;

export const proxyUrlSchema = z
  .string()
  .trim()
  .min(1)
  .superRefine((value, ctx) => {
    try {
      parseProxyUrl(value);
    } catch (error) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : '代理地址非法' });
    }
  });

export const proxyConfigSchema = z.object({
  kind: z.enum(['http', 'https', 'socks5']),
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(PORT_MAX),
  username: z.string().optional(),
  password: z.string().optional(),
});

/** 解析 `socks5://user:pass@host:1080` 形式的代理地址 */
export function parseProxyUrl(input: string): ProxyConfig {
  const raw = input.trim();
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error('代理地址不是合法 URL');
  }

  const scheme = url.protocol.replace(':', '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https' && scheme !== 'socks5') {
    throw new Error(`不支持的代理类型：${scheme}（仅支持 http / https / socks5）`);
  }
  const host = url.hostname;
  if (host.length === 0) throw new Error('代理地址缺少主机');
  const port = url.port ? Number.parseInt(url.port, 10) : defaultPort(scheme);
  if (!Number.isInteger(port) || port <= 0 || port > PORT_MAX) throw new Error('代理端口非法');

  return {
    kind: scheme,
    host,
    port,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  };
}

export function formatProxyUrl(config: ProxyConfig): string {
  const auth =
    config.username !== undefined
      ? `${encodeURIComponent(config.username)}${config.password !== undefined ? `:${encodeURIComponent(config.password)}` : ''}@`
      : '';
  return `${config.kind}://${auth}${config.host}:${config.port}`;
}

export function describeProxy(config: ProxyConfig | null | undefined): string {
  if (!config) return '未配置（直连）';
  const label = config.kind === 'socks5' ? 'SOCKS5' : config.kind.toUpperCase();
  const auth = config.username ? '（含认证）' : '';
  return `${label} ${config.host}:${config.port}${auth}`;
}

function defaultPort(scheme: string): number {
  if (scheme === 'socks5') return 1080;
  if (scheme === 'https') return 443;
  return 80;
}

export interface ProxyTestResult {
  ok: boolean;
  latencyMs: number;
  message: string;
}

/** 连通性测试：与探测目标建立一次隧道，成功即视为代理可用 */
export async function testProxyConnectivity(
  config: ProxyConfig,
  target: { host: string; port?: number } = { host: 'www.cloudflare.com', port: 443 },
  timeoutMs = 10_000,
): Promise<ProxyTestResult> {
  const started = Date.now();
  try {
    const socket = await openTunnel(config, target.host, target.port ?? 443, timeoutMs);
    socket.destroy();
    return { ok: true, latencyMs: Date.now() - started, message: '代理可用' };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
