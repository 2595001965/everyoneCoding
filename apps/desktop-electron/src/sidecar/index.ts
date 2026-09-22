import readline from 'node:readline';

import { SIDECAR_RUNTIME_ID } from './protocol';
import { createSidecarService } from './service';
import type { SidecarTransport } from './link';

/**
 * 侧车进程入口（Tauri 形态的业务运行时宿主）。
 *
 * ## 为什么需要一个独立的 Node 进程
 *
 * Tauri 外壳是 Rust + 系统 WebView2，**没有 Node 运行时**；而本仓库的业务逻辑
 * （15 个域 + AI 栈 + `@ec/*` 领域内核 + better-sqlite3）全部是 Node 侧 TS 实现。
 * 把业务运行时迁进 Rust 意味着把这套内核**重写第二遍**——两份实现必然漂移，
 * 直接违背 D-01「两版功能等价」与「同一套领域包」。
 * 因此采用**受控侧车**：Rust 只做生命周期与协议搬运，业务仍然只有一份实现。
 *
 * ## 三条硬约束（都在本文件里落实）
 *
 * 1. **stdout 只能是协议流**。任何 `console.log` 都会把 NDJSON 弄脏，
 *    而污染后的表现是"宿主随机解析失败"，极难定位。故此处先把 console 全部
 *    重定向到 stderr（`@ec/*` 领域代码里有 `console.info` / `console.warn`）。
 * 2. **宿主死了侧车必须死**。`stdin` 结束即收尾退出，避免孤儿进程占住
 *    SQLite（WAL 锁）与工程目录——Windows 上表现为"卸载不掉数据目录"。
 * 3. **退出前杀干净外部进程**。预览后端是侧车 spawn 的子进程，
 *    直接 `process.exit()` 会让它们活下来占端口。
 */

/** 把 console 全部改道 stderr：stdout 留给协议帧 */
function redirectConsoleToStderr(): void {
  const write = (prefix: string, args: unknown[]): void => {
    const text = args
      .map((value) => {
        if (typeof value === 'string') return value;
        if (value instanceof Error) return value.stack ?? value.message;
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      })
      .join(' ');
    process.stderr.write(`[${SIDECAR_RUNTIME_ID}]${prefix} ${text}\n`);
  };
  console.log = (...args: unknown[]) => write('', args);
  console.info = (...args: unknown[]) => write('', args);
  console.warn = (...args: unknown[]) => write(' warn:', args);
  console.error = (...args: unknown[]) => write(' error:', args);
  console.debug = (...args: unknown[]) => write(' debug:', args);
}

/** 逐行读 stdin（readline 会正确处理跨块被劈开的行与 CRLF） */
function stdinLines(): AsyncIterable<string> {
  return readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });
}

function createProcessTransport(): SidecarTransport {
  return {
    lines: stdinLines,
    write(line: string): void {
      // 与协议帧同一条流：Node 保证单流写入不被交错，宿主侧逐行读取即可。
      process.stdout.write(`${line}\n`);
    },
  };
}

/** 等 stdout 排空后再退出，避免最后一帧 `bye` 被截断 */
async function flushStdout(): Promise<void> {
  if (process.stdout.writableLength === 0) return;
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(resolvePromise, 250);
    timer.unref?.();
    process.stdout.once('drain', () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

async function main(): Promise<void> {
  redirectConsoleToStderr();

  // 启动留痕：宿主会把本进程的 stderr 归档进诊断日志，这一行是"侧车到底起没起、
  // 起的哪个 node"的唯一证据。刻意走 `console`（= stderr）而不是协议帧——
  // 它属于运维信息，不该占用渲染层能看到的事件通道。
  console.info(`侧车启动：pid=${process.pid} node=${process.versions.node} cwd=${process.cwd()}`);

  const service = createSidecarService(createProcessTransport());

  /**
   * 信号处理。
   *
   * **Windows 上这条路径基本不会走到**：`TerminateProcess` 是硬杀，进程没有机会跑
   * handler（Node 的 `kill('SIGTERM')` 在 Windows 上就是 TerminateProcess）。
   * 因此正常收尾**一律靠协议的 `shutdown` op**（宿主先礼后兵：先发 op，超时才强杀），
   * 这里的 handler 只服务于 POSIX 形态与手动调试。
   */
  const onSignal = (signal: NodeJS.Signals): void => {
    console.warn(`收到 ${signal}，正在收尾（会一并终止预览后端等子进程）`);
    void service.shutdown(`侧车收到 ${signal}`).then(() => {
      void flushStdout().then(() => process.exit(0));
    });
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  // 未捕获异常下进程状态已不可信：记账后让宿主重启侧车，而不是带病继续服务
  process.on('uncaughtException', (error: Error) => {
    console.error('未捕获异常，侧车即将退出：', error);
    void service.shutdown('侧车未捕获异常').then(() => {
      void flushStdout().then(() => process.exit(5));
    });
  });
  // 未处理的 Promise 拒绝不退出：领域调用内部已各自兜错，这里只留痕
  process.on('unhandledRejection', (reason: unknown) => {
    console.error('未处理的 Promise 拒绝：', reason);
  });

  service.ready.catch(() => {
    // 装配失败已在 service 内记日志；此处只避免 unhandledRejection 噪音
  });

  const result = await service.done;
  await flushStdout();
  process.exit(result.code);
}

void main();
