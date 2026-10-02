/**
 * 本地静态更新源（FR-SET-05 演练 / 测试共用）。
 *
 * 就是一个"够真"的静态文件服务器：electron-updater 的 generic provider 与 Tauri updater 的
 * 静态 `latest.json` 端点在它上面跑的行为，与挂在 GitHub Releases / 任意 CDN 上一致。
 *
 * 为什么不用现成的 `npx serve`：
 * - electron-updater 的**差分下载**一次请求多个区间（`Range: bytes=a-b,c-d`），
 *   服务端必须回 `multipart/byteranges`，常见的轻量静态服务器不支持；
 * - 测试要**注入故障**（半包、连接中断、内容被篡改、5xx），并记录请求（断言确实走了差分）。
 *
 * 命令行：
 *   node --experimental-strip-types ci/update-feed-server.mts --dir release-feed --port 18480
 *   （可加 --fault '<正则>=truncate|drop|corrupt|500'，可多次）
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * - `truncate`：内容只给一半、但 Content-Length 如实写一半（服务器上就是半包 → 校验失败）
 * - `drop`：Content-Length 写全量，发一半后掐断连接（下载中断）
 * - `stall`：Content-Length 写全量，发开头一小段后**不再给数据也不掐断**（连接静默挂着，
 *   只能靠客户端的停滞看门狗自救——`drop` 的错误会立即到达，看门狗来不及触发）
 * - `corrupt`：长度不变，整包响应翻转中间一个字节、区间响应翻转**每个区间**的首字节
 *   （差分下载只拉变化的块，只翻整包中间一个字节时那个块可能根本不会被下载——真实演练踩到）
 * - `500`：直接回 500
 */
export type FeedFault = 'truncate' | 'drop' | 'stall' | 'corrupt' | '500';

export interface FeedRequestRecord {
  method: string;
  path: string;
  range: string | null;
  status: number;
}

export interface FeedServer {
  url: string;
  port: number;
  requests: FeedRequestRecord[];
  setFault(pattern: RegExp, fault: FeedFault | null): void;
  clearFaults(): void;
  close(): Promise<void>;
}

export interface FeedServerOptions {
  dir: string;
  port?: number;
  host?: string;
}

function contentType(file: string): string {
  if (file.endsWith('.json')) return 'application/json';
  if (file.endsWith('.yml') || file.endsWith('.yaml')) return 'text/yaml; charset=utf-8';
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  return 'application/octet-stream';
}

function parseRanges(header: string, size: number): Array<[number, number]> | null {
  const match = /^bytes=(.+)$/.exec(header.trim());
  if (match === null || match[1] === undefined) return null;
  const ranges: Array<[number, number]> = [];
  for (const part of match[1].split(',')) {
    const [rawStart, rawEnd] = part.trim().split('-');
    let start: number;
    let end: number;
    if (rawStart === '' || rawStart === undefined) {
      const suffix = Number(rawEnd);
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = Number(rawStart);
      end = rawEnd === undefined || rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size)
      return null;
    ranges.push([start, end]);
  }
  return ranges;
}

export async function startFeedServer(options: FeedServerOptions): Promise<FeedServer> {
  const root = path.resolve(options.dir);
  const faults: Array<[RegExp, FeedFault]> = [];
  const requests: FeedRequestRecord[] = [];
  const sockets = new Set<Socket>();

  const faultFor = (urlPath: string): FeedFault | null => {
    for (const [pattern, fault] of faults) if (pattern.test(urlPath)) return fault;
    return null;
  };

  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://feed.local').pathname);
    const record: FeedRequestRecord = {
      method: req.method ?? 'GET',
      path: urlPath,
      range: typeof req.headers.range === 'string' ? req.headers.range : null,
      status: 0,
    };
    requests.push(record);
    const reply = (status: number, body?: string): void => {
      record.status = status;
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(body ?? '');
    };

    const file = path.resolve(root, `.${urlPath}`);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      reply(404, 'not found');
      return;
    }
    const fault = faultFor(urlPath);
    if (fault === '500') {
      reply(500, 'injected failure');
      return;
    }

    let data = fs.readFileSync(file);
    if (fault === 'truncate') data = data.subarray(0, Math.floor(data.length / 2));
    /** 取区间；corrupt 时翻转指定位置的字节（在副本上改，不动磁盘文件） */
    const slice = (start: number, end: number, flipAt: number): Buffer => {
      const part = data.subarray(start, end + 1);
      if (fault !== 'corrupt' || part.length === 0) return part;
      const copy = Buffer.from(part);
      copy[flipAt] = (copy[flipAt] ?? 0) ^ 0xff;
      return copy;
    };

    const size = data.length;
    const base = { 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    const ranges = record.range === null ? null : parseRanges(record.range, size);

    if (record.range !== null && ranges === null) {
      record.status = 416;
      res.writeHead(416, { ...base, 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }

    if (ranges === null || ranges.length === 0) {
      record.status = 200;
      res.writeHead(200, { ...base, 'Content-Type': contentType(file), 'Content-Length': size });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      if (fault === 'drop') {
        res.write(data.subarray(0, Math.floor(size / 2)), () => req.socket.destroy());
        return;
      }
      if (fault === 'stall') {
        res.write(data.subarray(0, Math.min(size, 64 * 1024)));
        // 故意不 end、不 destroy：让连接挂着，停滞看门狗（而非服务端错误）来中止下载。
        // 客户端取消后销毁的 socket 会在服务端触发 ECONNRESET，吞掉避免砸掉进程。
        req.socket.on('error', () => undefined);
        return;
      }
      res.end(slice(0, size - 1, Math.floor(size / 2)));
      return;
    }

    if (ranges.length === 1) {
      const [start, end] = ranges[0] as [number, number];
      record.status = 206;
      res.writeHead(206, {
        ...base,
        'Content-Type': contentType(file),
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${size}`,
      });
      res.end(req.method === 'HEAD' ? undefined : slice(start, end, 0));
      return;
    }

    const boundary = `ecfeed${Date.now().toString(16)}`;
    const chunks: Buffer[] = [];
    for (const [start, end] of ranges) {
      chunks.push(
        Buffer.from(
          `\r\n--${boundary}\r\nContent-Type: ${contentType(file)}\r\nContent-Range: bytes ${start}-${end}/${size}\r\n\r\n`,
        ),
        slice(start, end, 0),
      );
    }
    chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(chunks);
    record.status = 206;
    res.writeHead(206, {
      ...base,
      'Content-Type': `multipart/byteranges; boundary=${boundary}`,
      'Content-Length': body.length,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://${options.host ?? '127.0.0.1'}:${port}`,
    port,
    requests,
    setFault(pattern, fault) {
      const index = faults.findIndex(([existing]) => existing.source === pattern.source);
      if (index >= 0) faults.splice(index, 1);
      if (fault !== null) faults.push([pattern, fault]);
    },
    clearFaults() {
      faults.length = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/* ------------------------------- 命令行 ------------------------------- */

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const get = (flag: string, fallback: string): string => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] !== undefined ? (argv[index + 1] as string) : fallback;
  };
  const server = await startFeedServer({
    dir: get('--dir', 'release-feed'),
    port: Number(get('--port', '18480')),
  });
  argv.forEach((arg, index) => {
    if (arg !== '--fault') return;
    const spec = argv[index + 1] ?? '';
    const split = spec.lastIndexOf('=');
    server.setFault(new RegExp(spec.slice(0, split)), spec.slice(split + 1) as FeedFault);
  });
  console.log(
    `更新源已启动：${server.url}/  （目录 ${path.resolve(get('--dir', 'release-feed'))}）`,
  );
  process.on('SIGINT', () => void server.close().then(() => process.exit(0)));
}
