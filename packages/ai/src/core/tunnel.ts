import { connect, type Socket } from 'node:net';

/**
 * 代理隧道（AI 请求专用，与系统代理分离 —— FR-MDL-11）。
 *
 * 支持两类：
 * - HTTP / HTTPS 代理：标准 CONNECT 方法建隧道（HTTPS 目标在其上再做 TLS）
 * - SOCKS5 代理：无认证与用户名密码两种子协商，域名 / IPv4 两种地址类型
 *
 * 返回的 Socket 由调用方交给 `http.request({ createConnection })` 或 TLS 层使用。
 */

import type { ProxyConfig } from './http';

export class ProxyTunnelError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ProxyTunnelError';
    if (cause !== undefined) Object.defineProperty(this, 'cause', { value: cause, enumerable: false });
    Object.setPrototypeOf(this, ProxyTunnelError.prototype);
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;

function isIpv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function basicAuth(proxy: ProxyConfig): string | null {
  if (!proxy.username) return null;
  const raw = `${proxy.username}:${proxy.password ?? ''}`;
  return Buffer.from(raw, 'utf8').toString('base64');
}

/** 建立到目标主机的隧道；失败一律抛 ProxyTunnelError */
export function openTunnel(
  proxy: ProxyConfig,
  targetHost: string,
  targetPort: number,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Socket> {
  return proxy.kind === 'socks5'
    ? openSocks5(proxy, targetHost, targetPort, timeoutMs)
    : openHttpConnect(proxy, targetHost, targetPort, timeoutMs);
}

function withTimeout(socket: Socket, timeoutMs: number): () => void {
  socket.setTimeout(timeoutMs);
  return () => socket.setTimeout(0);
}

function openHttpConnect(
  proxy: ProxyConfig,
  targetHost: string,
  targetPort: number,
  timeoutMs: number,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: proxy.host, port: proxy.port });
    let settled = false;

    const fail = (message: string, cause?: unknown): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new ProxyTunnelError(message, cause));
    };

    socket.once('error', (error) => fail(`连接代理服务器失败：${error.message}`, error));
    socket.once('timeout', () => fail('连接代理服务器超时'));
    withTimeout(socket, timeoutMs);

    socket.once('connect', () => {
      const auth = basicAuth(proxy);
      const lines = [
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
        `Host: ${targetHost}:${targetPort}`,
        ...(auth ? [`Proxy-Authorization: Basic ${auth}`] : []),
        '',
        '',
      ];
      socket.write(lines.join('\r\n'));

      let buffer = '';
      const onData = (chunk: Buffer): void => {
        buffer += chunk.toString('latin1');
        const idx = buffer.indexOf('\r\n\r\n');
        if (idx < 0) return;
        socket.off('data', onData);
        const statusLine = buffer.split('\r\n')[0] ?? '';
        const code = Number.parseInt(statusLine.split(' ')[1] ?? '', 10);
        if (code >= 200 && code < 300) {
          settled = true;
          socket.setTimeout(0);
          resolve(socket);
        } else {
          fail(`代理拒绝建立隧道（${statusLine.trim()}）`);
        }
      };
      socket.on('data', onData);
    });
  });
}

function openSocks5(proxy: ProxyConfig, targetHost: string, targetPort: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: proxy.host, port: proxy.port });
    let settled = false;
    let stage: 'greeting' | 'auth' | 'connect' = 'greeting';

    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new ProxyTunnelError(message));
    };

    socket.once('error', (error) => fail(`连接 SOCKS5 代理失败：${error.message}`));
    socket.once('timeout', () => fail('连接 SOCKS5 代理超时'));
    withTimeout(socket, timeoutMs);

    socket.once('connect', () => {
      const hasAuth = Boolean(proxy.username);
      socket.write(Buffer.from([0x05, hasAuth ? 0x02 : 0x01, 0x00, ...(hasAuth ? [0x02] : [])]));
    });

    socket.on('data', (chunk: Buffer) => {
      void (async () => {
        try {
          if (stage === 'greeting') {
            if (chunk.length < 2 || chunk[0] !== 0x05) throw new Error('SOCKS5 协商响应非法');
            const method = chunk[1];
            if (method === 0xff) throw new Error('SOCKS5 无可用的认证方式');
            if (method === 0x02) {
              stage = 'auth';
              const user = Buffer.from(proxy.username ?? '', 'utf8');
              const pass = Buffer.from(proxy.password ?? '', 'utf8');
              socket.write(Buffer.from([0x01, user.length, ...user, pass.length, ...pass]));
              return;
            }
            stage = 'connect';
            socket.write(buildSocks5Request(targetHost, targetPort));
            return;
          }
          if (stage === 'auth') {
            if (chunk.length < 2 || chunk[1] !== 0x00) throw new Error('SOCKS5 用户名密码认证失败');
            stage = 'connect';
            socket.write(buildSocks5Request(targetHost, targetPort));
            return;
          }
          if (chunk.length < 4 || chunk[0] !== 0x05) throw new Error('SOCKS5 连接响应非法');
          const rep = chunk[1];
          if (rep !== 0x00) throw new Error(`SOCKS5 连接被拒绝（REP=${rep}）`);
          settled = true;
          socket.setTimeout(0);
          socket.off('data', () => undefined);
          resolve(socket);
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
      })();
    });
  });
}

function buildSocks5Request(host: string, port: number): Buffer {
  const portBuf = Buffer.from([(port >> 8) & 0xff, port & 0xff]);
  if (isIpv4(host)) {
    const addr = Buffer.from(host.split('.').map((part) => Number.parseInt(part, 10)));
    return Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x01]), addr, portBuf]);
  }
  const domain = Buffer.from(host, 'utf8');
  return Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, domain.length]), domain, portBuf]);
}
