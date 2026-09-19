import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import type { Socket } from 'node:net';

import {
  TransportError,
  toAsyncIterable,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
  type ProxyConfig,
} from './http';
import { openTunnel } from './tunnel';

/**
 * Node 环境的 HTTP 传输实现。
 *
 * 选择 `node:http` 而非全局 fetch 的原因见 `http.ts` 顶部说明。
 * 关键行为：
 * - 超时按「socket 空闲」计（SSE 长流不会被误杀）
 * - 中断走 AbortSignal，抛出的 TransportError 带 aborted 标记，由上层转为 partial 结果
 * - 代理隧道在发起请求前完成握手；HTTPS 目标在隧道之上再做 TLS（SNI 用真实目标域名）
 */

export interface NodeTransportOptions {
  /** 默认 60s 空闲超时 */
  timeoutMs?: number;
  /** 全局代理（可被单次请求的 proxy 覆盖） */
  proxy?: ProxyConfig | undefined;
  /** 自签名证书场景可关闭校验（默认开启） */
  rejectUnauthorized?: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export function createNodeHttpTransport(
  options: NodeTransportOptions = {},
): HttpTransport & { activeCount(): number } {
  let active = 0;
  const decrement = (): void => {
    active = Math.max(0, active - 1);
  };

  return {
    activeCount: () => active,

    request(req: HttpRequest): Promise<HttpResponse> {
      const target = new URL(req.url);
      const method = req.method ?? 'GET';
      const timeoutMs = req.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const proxy = req.proxy ?? options.proxy;
      const isTls = target.protocol === 'https:';
      const port = target.port ? Number(target.port) : isTls ? 443 : 80;

      const headers: Record<string, string> = { ...(req.headers ?? {}) };
      if (req.body !== undefined && headers['content-length'] === undefined) {
        headers['content-length'] = String(Buffer.byteLength(req.body, 'utf8'));
      }

      const transport = isTls ? https : http;

      return new Promise<HttpResponse>((resolve, reject) => {
        void (async () => {
          let tunnel: Socket | null = null;
          if (proxy) {
            try {
              tunnel = await openTunnel(proxy, target.hostname, port, timeoutMs);
            } catch (error) {
              reject(
                new TransportError(error instanceof Error ? error.message : String(error), {
                  cause: error,
                }),
              );
              return;
            }
          }

          const createConnection = tunnel
            ? (): Socket =>
                isTls
                  ? tls.connect({
                      socket: tunnel as Socket,
                      servername: target.hostname,
                      host: target.hostname,
                      port,
                      rejectUnauthorized: options.rejectUnauthorized ?? true,
                    })
                  : (tunnel as Socket)
            : undefined;

          active += 1;
          const request = transport.request(
            target,
            {
              method,
              headers,
              agent: false,
              ...(createConnection ? { createConnection } : {}),
            },
            (res) => {
              const iterable = toAsyncIterable(res);
              res.setTimeout(timeoutMs, () => {
                res.destroy(new TransportError('读取响应超时', { timedOut: true }));
              });
              res.once('close', decrement);

              resolve({
                status: res.statusCode ?? 0,
                statusText: res.statusMessage ?? '',
                headers: flattenHeaders(res.headers),
                body: iterable,
                async text(): Promise<string> {
                  const decoder = new TextDecoder('utf8');
                  let out = '';
                  for await (const chunk of iterable)
                    out += decoder.decode(chunk, { stream: true });
                  out += decoder.decode();
                  return out;
                },
              });
            },
          );

          request.setTimeout(timeoutMs, () => {
            request.destroy(new TransportError('请求超时', { timedOut: true }));
          });

          if (req.signal) {
            if (req.signal.aborted) {
              decrement();
              reject(new TransportError('请求已中断', { aborted: true }));
              return;
            }
            req.signal.addEventListener(
              'abort',
              () => {
                request.destroy(new TransportError('请求已中断', { aborted: true }));
              },
              { once: true },
            );
          }

          request.once('error', (error: NodeJS.ErrnoException) => {
            decrement();
            if (error instanceof TransportError) {
              reject(error);
              return;
            }
            if (req.signal?.aborted || error.code === 'ECONNRESET') {
              reject(new TransportError('请求已中断', { aborted: true, cause: error }));
              return;
            }
            reject(
              new TransportError(`网络请求失败：${error.message}`, {
                timedOut: error.code === 'ETIMEDOUT',
                cause: error,
              }),
            );
          });

          if (req.body !== undefined) request.write(req.body, 'utf8');
          request.end();
        })();
      });
    },
  };
}

function flattenHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}
