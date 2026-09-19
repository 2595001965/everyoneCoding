import type { AddressInfo } from 'node:net';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Database } from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockShell } from '@ec/shell-api';
import { DataClient, Migrator } from '@ec/data';
import { SecureStore } from '@ec/core';

/**
 * 测试脚手架（不属于产品代码，仅供单测使用）。
 *
 * 提供：
 * - 内存 SQLite（已跑到最新迁移）
 * - 内存密钥环（MockShell）
 * - 本地 HTTP 服务（跑真实请求，覆盖 SSE 粘包等字节级场景）
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', '..', '..', 'data', 'migrations');

export function openTestDb(): Database {
  const client = DataClient.open({ filePath: ':memory:' });
  const db = client.raw;
  Migrator.fromDirectory(db, MIGRATIONS_DIR).up();
  return db;
}

export function testSecureStore(): SecureStore {
  return new SecureStore(new MockShell());
}

export function insertUser(db: Database, id = 'USER0000000000000000000000'): string {
  const now = Date.now();
  db.prepare(
    `INSERT INTO user (id, login, display_name, role, created_at, updated_at)
     VALUES (?, ?, ?, 'owner', ?, ?)`,
  ).run(id, `user-${id}`, '测试用户', now, now);
  return id;
}

/* --------------------------- 本地 HTTP 服务 --------------------------- */

export interface MockRoute {
  method: 'GET' | 'POST';
  path: string;
  status?: number;
  headers?: Record<string, string>;
  /** 直接返回文本（JSON / SSE 均可） */
  body?: string;
  /** 分块下发（模拟真实 SSE 分片与粘包） */
  chunks?: string[];
  chunkDelayMs?: number;
  handler?: (req: IncomingMessage, res: ServerResponse) => void;
  /** 记录收到的请求体，便于断言报文结构 */
  capture?: (body: string, req: IncomingMessage) => void;
}

export interface MockServerHandle {
  url: string;
  requests: Array<{ method: string; url: string; headers: Record<string, string>; body: string }>;
  close(): Promise<void>;
}

export async function startMockServer(routes: MockRoute[]): Promise<MockServerHandle> {
  const requests: MockServerHandle['requests'] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = req.url ?? '/';
      requests.push({
        method: req.method ?? 'GET',
        url,
        headers: req.headers as Record<string, string>,
        body,
      });

      const route = routes.find((item) => item.method === req.method && matchPath(item.path, url));
      if (!route) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'no route' } }));
        return;
      }
      route.capture?.(body, req);

      if (route.handler) {
        route.handler(req, res);
        return;
      }

      const status = route.status ?? 200;
      res.writeHead(status, { 'content-type': 'application/json', ...(route.headers ?? {}) });
      if (route.chunks) {
        let index = 0;
        const tick = (): void => {
          if (index >= (route.chunks as string[]).length) {
            res.end();
            return;
          }
          res.write((route.chunks as string[])[index] as string);
          index += 1;
          if (route.chunkDelayMs && route.chunkDelayMs > 0) setTimeout(tick, route.chunkDelayMs);
          else setImmediate(tick);
        };
        tick();
        return;
      }
      res.end(route.body ?? '');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function matchPath(pattern: string, url: string): boolean {
  const [path] = url.split('?');
  return (
    pattern === '*' ||
    pattern === path ||
    (pattern.endsWith('*') && (path ?? '').startsWith(pattern.slice(0, -1)))
  );
}

/** SSE 文本构造器：把若干事件拼成一条流（可指定分片边界） */
export function sse(events: string[]): string {
  return events.map((data) => `data: ${data}\n\n`).join('');
}

export async function collectBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
