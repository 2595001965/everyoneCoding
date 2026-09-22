import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION, SIDECAR_OPS } from '../protocol';

/**
 * 侧车**真实进程**端到端：起 `node dist/sidecar/*.cjs`，用 stdin/stdout 说话。
 *
 * 与 `sidecar-service.test.ts` 的分工：那边用内存管道验证**协议语义与业务等价**，
 * 这边验证**只有真起进程才会暴露的三件事**：
 *
 * 1. stdout 是否真的只有协议帧 —— 领域代码里的 `console.info` / 第三方库的
 *    `console.warn` 都会把 NDJSON 弄脏，而污染后的表现是"宿主随机解析失败"；
 * 2. 宿主消失（stdin 关闭）侧车是否自行退出 —— 不退就是孤儿进程，
 *    占住 SQLite 的 WAL 锁与工程目录（Windows 上表现为"删不掉数据目录"）；
 * 3. 协议不兼容时是否**拒绝服务**并以非 0 退出码收尾。
 *
 * 产物缺失时会现场构建（`scripts/build-sidecar.mjs`），因此本文件不依赖
 * "跑测试前先构建"这种隐含前提。
 */

const packageRoot = resolve(__dirname, '..', '..', '..');
const repoRoot = resolve(packageRoot, '..', '..');
const sidecarDir = join(packageRoot, 'dist', 'sidecar');
const bundle = join(sidecarDir, 'everyone-coding-sidecar.cjs');
const manifestPath = join(sidecarDir, 'sidecar-manifest.json');

function ensureBuilt(): void {
  const sources = [
    join(packageRoot, 'src', 'sidecar', 'index.ts'),
    join(packageRoot, 'src', 'sidecar', 'protocol.ts'),
    join(packageRoot, 'src', 'sidecar', 'service.ts'),
    join(packageRoot, 'src', 'main', 'runtime', 'bootstrap.ts'),
  ];
  const fresh =
    existsSync(bundle) &&
    existsSync(manifestPath) &&
    statSync(bundle).mtimeMs >= Math.max(...sources.map((file) => statSync(file).mtimeMs));
  if (fresh) return;

  const result = spawnSync(process.execPath, [join(packageRoot, 'scripts', 'build-sidecar.mjs')], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`侧车构建失败：${result.stdout}\n${result.stderr}`);
  }
}

interface SessionOptions {
  /** 本次会话的数据目录（各用例用不同子目录，避免互相污染 SQLite 与工程目录） */
  dataDir: string;
  /** 宿主声明的 DPAPI 可用性 */
  secureStore?: boolean;
  /** 宿主声明的协议版本（升级兼容用例会故意报错版本） */
  protocol?: number;
}

interface Session {
  child: ChildProcess;
  /** stdout 上收到的每一行（含无法解析的，供纯净性断言） */
  frames: string[];
  /** stderr 全文（侧车的 console 输出都在这儿） */
  readonly stderr: string;
  exits: Promise<{ code: number | null; signal: string | null }>;
  send(frame: unknown): void;
  /** 完成 hello → welcome → ready 握手；返回 ready 帧 */
  handshake(): Promise<Record<string, unknown>>;
  waitFor(
    predicate: (frame: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
  dispose(): Promise<void>;
}

function startSession(options: SessionOptions): Session {
  const child = spawn(process.execPath, [bundle], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      EC_SIDECAR_MIGRATIONS_DIR: join(repoRoot, 'packages', 'data', 'migrations'),
    },
  });

  const frames: string[] = [];
  const parsed: Array<Record<string, unknown>> = [];
  const waiters: Array<{
    predicate: (frame: Record<string, unknown>) => boolean;
    resolve(frame: Record<string, unknown>): void;
  }> = [];
  let stderr = '';
  let pending = '';
  let exited = false;

  const offer = (frame: Record<string, unknown>): void => {
    parsed.push(frame);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(frame)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(frame);
    }
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8');
    let index = pending.indexOf('\n');
    while (index >= 0) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      frames.push(line);
      try {
        offer(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // 保留在 frames 里：纯净性断言会把它抓出来
      }
      index = pending.indexOf('\n');
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  const exits = new Promise<{ code: number | null; signal: string | null }>((resolveExit) => {
    child.on('exit', (code, signal) => {
      exited = true;
      resolveExit({ code, signal });
    });
  });

  const waitFor = (
    predicate: (frame: Record<string, unknown>) => boolean,
    timeoutMs = 20_000,
  ): Promise<Record<string, unknown>> => {
    const found = parsed.find(predicate);
    if (found !== undefined) return Promise.resolve(found);
    return new Promise<Record<string, unknown>>((resolveWait, rejectWait) => {
      const timer = setTimeout(() => {
        rejectWait(new Error(`等待帧超时（stderr 尾部：${stderr.slice(-400)}）`));
      }, timeoutMs);
      waiters.push({
        predicate,
        resolve(frame) {
          clearTimeout(timer);
          resolveWait(frame);
        },
      });
    });
  };

  const session: Session = {
    child,
    frames,
    get stderr() {
      return stderr;
    },
    exits,
    send(frame) {
      child.stdin?.write(`${JSON.stringify(frame)}\n`);
    },
    waitFor,
    async handshake() {
      const hello = await waitFor((frame) => frame['t'] === 'hello');
      expect(hello['protocol']).toBe(PROTOCOL_VERSION);
      session.send({
        t: 'welcome',
        protocol: options.protocol ?? PROTOCOL_VERSION,
        secureStore: options.secureStore ?? false,
        config: {
          dataDir: options.dataDir,
          cacheDir: join(options.dataDir, 'cache'),
          secureDir: join(options.dataDir, 'secure'),
          workspaceRoot: join(options.dataDir, 'workspace'),
          userId: 'local-user',
        },
      });
      return await waitFor((frame) => frame['t'] === 'ready', 90_000);
    },
    async dispose() {
      if (!exited) child.kill('SIGKILL');
      await exits.catch(() => undefined);
    },
  };
  return session;
}

describe('侧车真实进程 E2E', () => {
  let dataRoot: string;

  beforeAll(() => {
    ensureBuilt();
    expect(existsSync(bundle), '侧车产物必须存在').toBe(true);
  }, 300_000);

  beforeAll(() => {
    dataRoot = join(repoRoot, '.tmp-sidecar-process-test');
    rmSync(dataRoot, { recursive: true, force: true });
    mkdirSync(dataRoot, { recursive: true });
    return () => rmSync(dataRoot, { recursive: true, force: true });
  });

  it('产物 manifest 的协议版本与 TS 常量一致（防漂移）', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      protocol: number;
      runtime: string;
      hostCapabilities: string[];
    };
    expect(manifest.protocol).toBe(PROTOCOL_VERSION);
    expect(manifest.runtime).toBe('everyone-coding-sidecar');
    // 宿主必须实现的能力清单：Rust 侧少了任何一项，auth/AI 都会在运行时才炸
    expect(manifest.hostCapabilities).toContain('secure.encrypt');
    expect(manifest.hostCapabilities).toContain('secure.decrypt');
  });

  it('真起进程：握手 → ready（15 域）→ 真实域调用 → shutdown → bye（退出码 0）', async () => {
    const session = startSession({ dataDir: join(dataRoot, 'normal') });
    try {
      const ready = await session.handshake();
      const domains = ready['domains'] as Array<{ kind: string; available: boolean }>;
      expect(domains).toHaveLength(15);
      expect(domains.filter((item) => !item.available).map((item) => item.kind)).toEqual(['auth']);
      expect((ready['ai'] as { available: boolean }).available).toBe(false);

      session.send({
        t: 'req',
        id: 'p1',
        op: SIDECAR_OPS.domainInvoke,
        payload: { requestId: 'r1', domain: 'workspace', method: 'listProjects', params: {} },
      });
      const response = await session.waitFor(
        (frame) => frame['t'] === 'res' && frame['id'] === 'p1',
      );
      expect(response['ok']).toBe(true);
      const result = response['result'] as { ok: boolean; result: unknown };
      expect(result.ok).toBe(true);
      expect(Array.isArray(result.result)).toBe(true);

      session.send({ t: 'req', id: 'p2', op: SIDECAR_OPS.shutdown });
      const bye = await session.waitFor((frame) => frame['t'] === 'bye');
      expect(bye['reason']).toMatch(/请求关闭/);
      const exit = await session.exits;
      expect(exit.code).toBe(0);
    } finally {
      await session.dispose();
    }
  }, 120_000);

  it('stdout 只有协议帧；console 输出（启动留痕 / 告警）一律走 stderr', async () => {
    const session = startSession({ dataDir: join(dataRoot, 'purity') });
    try {
      await session.handshake();
      session.send({ t: 'req', id: 'stop', op: SIDECAR_OPS.shutdown });
      const exit = await session.exits;
      expect(exit.code).toBe(0);

      for (const line of session.frames) {
        const frame = JSON.parse(line) as { t?: unknown };
        expect(typeof frame.t, `stdout 出现非协议行：${line.slice(0, 160)}`).toBe('string');
      }
      // 反向确认：console 输出确实产生了（不是"什么都没输出"被误判成"很干净"）。
      // 这一行是 `index.ts` 里 `console.info` 写的启动留痕。
      expect(session.stderr).toMatch(/侧车启动：pid=/);
      expect(session.frames.some((line) => line.includes('侧车启动'))).toBe(false);
    } finally {
      await session.dispose();
    }
  }, 120_000);

  it('Windows 上 SIGTERM 是硬杀：进程必定终止，因此正常收尾必须走 shutdown op', async () => {
    const session = startSession({ dataDir: join(dataRoot, 'signal') });
    try {
      await session.waitFor((frame) => frame['t'] === 'hello');
      session.child.kill('SIGTERM');
      const exit = await session.exits;
      // Windows 无 POSIX 信号语义：要么被信号终止，要么已被回收，二者必居其一。
      // 关键结论是**进程一定会消失**（不会留下孤儿），而"优雅"由协议 op 保证。
      expect(exit.code !== null || exit.signal !== null).toBe(true);
    } finally {
      await session.dispose();
    }
  }, 120_000);

  it('宿主消失（关闭 stdin）：侧车自行退出，不留孤儿进程', async () => {
    const session = startSession({ dataDir: join(dataRoot, 'orphan') });
    try {
      await session.handshake();
      session.child.stdin?.end();
      const exit = await session.exits;
      expect(exit.code).toBe(0);
    } finally {
      await session.dispose();
    }
  }, 120_000);

  it('协议不兼容：拒绝服务，发出 bye 并以退出码 3 收尾', async () => {
    const session = startSession({
      dataDir: join(dataRoot, 'mismatch'),
      protocol: PROTOCOL_VERSION + 1,
    });
    try {
      const bye = await (async () => {
        await session.waitFor((frame) => frame['t'] === 'hello');
        session.send({
          t: 'welcome',
          protocol: PROTOCOL_VERSION + 1,
          secureStore: false,
          config: {
            dataDir: join(dataRoot, 'mismatch'),
            cacheDir: join(dataRoot, 'mismatch', 'cache'),
            secureDir: join(dataRoot, 'mismatch', 'secure'),
            workspaceRoot: join(dataRoot, 'mismatch', 'workspace'),
            userId: 'local-user',
          },
        });
        return await session.waitFor((frame) => frame['t'] === 'bye');
      })();
      expect(bye['code']).toBe(3);
      expect(bye['reason']).toMatch(/不兼容/);
      expect(session.frames.some((line) => line.includes('"ready"'))).toBe(false);
      const exit = await session.exits;
      expect(exit.code).toBe(3);
    } finally {
      await session.dispose();
    }
  }, 120_000);

  it('未知 op 回 INVALID_ARGUMENT 后连接仍可服务（不崩）', async () => {
    const session = startSession({ dataDir: join(dataRoot, 'unknown-op') });
    try {
      await session.handshake();

      session.send({ t: 'req', id: 'bad', op: 'runtime.execArbitrary', payload: {} });
      const response = await session.waitFor(
        (frame) => frame['t'] === 'res' && frame['id'] === 'bad',
      );
      expect(response['ok']).toBe(false);
      expect((response['error'] as { code: string }).code).toBe('INVALID_ARGUMENT');

      // 连接仍然健康
      session.send({ t: 'req', id: 'ping', op: SIDECAR_OPS.ping });
      const ping = await session.waitFor((frame) => frame['t'] === 'res' && frame['id'] === 'ping');
      expect(ping['ok']).toBe(true);

      session.send({ t: 'req', id: 'stop', op: SIDECAR_OPS.shutdown });
      await session.exits;
    } finally {
      await session.dispose();
    }
  }, 120_000);
});
