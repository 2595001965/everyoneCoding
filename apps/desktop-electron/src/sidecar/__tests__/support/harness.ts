import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SafeStorageLike } from '../../../main/secure-storage';
import type { SidecarTransport } from '../../link';
import { createSidecarService, type SidecarDeps } from '../../service';
import { HOST_CAPABILITIES, SIDECAR_OPS, type ReadyFrame, type WelcomeFrame } from '../../protocol';

/**
 * 侧车测试台：**用内存管道跑真实协议 + 真实运行时**。
 *
 * 与 `bridge.test.ts` 那类"打桩外壳"的测试不同，这里不替换任何领域实现：
 * `createHeadlessRuntime` 会真的开 SQLite、真的跑迁移、真的读写工程目录。
 * 唯一的替身是**外壳端口**（DPAPI / 打开外链 / 剪贴板）——它们本来就在另一个进程里，
 * 这里用假实现回答，正是宿主（Rust）该做的事。
 *
 * 这样既能覆盖协议层（握手段、帧、宿主能力调用），又能覆盖业务层（每个域方法），
 * 且不需要真的起 Tauri。
 */

/** 单向内存管道：可被两侧并发读写，支持"读到尾部阻塞等待直到有数据或被关闭" */
class MemoryChannel {
  private readonly queue: string[] = [];
  private waiter: (() => void) | null = null;
  private ended = false;

  push(line: string): void {
    if (this.ended) return;
    this.queue.push(line);
    this.wake();
  }

  end(): void {
    this.ended = true;
    this.wake();
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  async *drain(): AsyncIterable<string> {
    for (;;) {
      while (this.queue.length > 0) {
        yield this.queue.shift() as string;
      }
      if (this.ended) return;
      await new Promise<void>((resolvePromise) => {
        this.waiter = resolvePromise;
      });
    }
  }
}

export interface FakeDpapiOptions {
  available?: boolean;
  /** 让加密/解密失败，用于验证"不伪造成功" */
  failEncrypt?: boolean;
}

export interface HarnessOptions {
  /** 假 DPAPI（宿主侧能力）。默认可用，用可逆的 XOR 变换模拟 DPAPI 的往返语义。 */
  dpapi?: FakeDpapiOptions;
  /** 覆盖运行时装配（默认用真实的 `createHeadlessRuntime`） */
  deps?: Partial<SidecarDeps>;
  /** 数据目录；不传则建临时目录 */
  dataDir?: string;
  /**
   * 账号服务基址。传入后 auth 域会真的走 HTTP 打到这个地址——
   * 测试里通常指向一个临时的本地假账号服务，从而把「auth 域完整链路」
   * （协议帧 → 域路由 → AuthClient → 真实 HTTP → DPAPI 落盘）全部跑通。
   */
  accountBaseUrl?: string;
  /** `welcome` 里声明的协议版本（默认 1；用于升级兼容测试） */
  protocol?: number;
  /** 是否在 welcome 前就关掉管道（用于"宿主过早退出"的用例） */
  dropBeforeWelcome?: boolean;
}

export interface Harness {
  /** 侧车进程收到的完整帧序列（依原样保存，便于断言 stdout 纯净性） */
  readonly received: string[];
  /** 侧车实际使用的目录（测试断言落盘位置用） */
  readonly paths: {
    dataDir: string;
    cacheDir: string;
    secureDir: string;
    workspaceRoot: string;
    projectsDir: string;
  };
  /** 宿主能力调用记录 */
  readonly hostCalls: Array<{ capability: string; payload: unknown }>;
  /** 打开外链的记录 */
  readonly openedExternal: string[];
  /** 剪贴板写入的记录 */
  readonly clipboard: string[];
  ready: Promise<ReadyFrame>;
  done: Promise<{ code: number; reason: string }>;
  /** 发一次调用并等应答 */
  request(
    op: string,
    payload?: unknown,
  ): Promise<{
    ok: boolean;
    result?: unknown;
    error?: { code: string; message: string };
  }>;
  /** 等一条指定 op 的事件 */
  nextEvent(op: string, timeoutMs?: number): Promise<unknown>;
  /** 收集到当前为止的全部事件 */
  eventsOf(op: string): unknown[];
  welcome(frame?: Partial<WelcomeFrame>): void;
  shutdown(): Promise<void>;
  /** 模拟宿主进程消失 */
  closeHost(): void;
  /** 关掉侧车侧读端（模拟侧车崩溃后宿主看到的现象） */
  killSidecar(): void;
  dispose(): Promise<void>;
}

function xorCipher(plain: Buffer): Buffer {
  // 可逆的假 DPAPI：真实 DPAPI 的可观测语义是"往返一致、密文不等于明文"，
  // 这里保留这两条即可，不需要密码学强度。
  return Buffer.from(plain.map((byte) => byte ^ 0x5a));
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'ec-sidecar-'));
  const ownedTemp = options.dataDir === undefined;
  const dpapiAvailable = options.dpapi?.available ?? true;

  const toSidecar = new MemoryChannel();
  const fromSidecar = new MemoryChannel();

  const received: string[] = [];
  const hostCalls: Array<{ capability: string; payload: unknown }> = [];
  const openedExternal: string[] = [];
  const clipboard: string[] = [];
  const events: Array<{ op: string; payload: unknown }> = [];
  const eventWaiters: Array<{ op: string; resolve(value: unknown): void }> = [];

  const transport: SidecarTransport = {
    lines: () => toSidecar.drain(),
    write(line: string): void {
      // 侧车写出的每一行都先落到 received，供"stdout 只能有协议帧"的断言使用
      received.push(line);
      const frame = JSON.parse(line) as { t: string; op?: string; payload?: unknown; id?: string };
      if (frame.t === 'evt') {
        events.push({ op: frame.op ?? '', payload: frame.payload });
        for (const waiter of [...eventWaiters]) {
          if (waiter.op !== frame.op) continue;
          eventWaiters.splice(eventWaiters.indexOf(waiter), 1);
          waiter.resolve(frame.payload);
        }
      }
      fromSidecar.push(line);
    },
  };

  // ---- 宿主侧读循环：应答 host 帧、收集 ready/bye、兑现 request ----
  const pending = new Map<
    string,
    {
      resolve(value: {
        ok: boolean;
        result?: unknown;
        error?: { code: string; message: string };
      }): void;
    }
  >();
  let resolveReady!: (frame: ReadyFrame) => void;
  let rejectReady!: (error: Error) => void;
  let readySettled = false;
  /** 侧车提前结束的原因（`bye.reason` 或"连接静默关闭"） */
  let failReason: string | null = null;
  const ready = new Promise<ReadyFrame>((resolvePromise, rejectPromise) => {
    resolveReady = (frame) => {
      readySettled = true;
      resolvePromise(frame);
    };
    rejectReady = (error) => {
      readySettled = true;
      rejectPromise(error);
    };
  });
  let resolveDone!: (value: { code: number; reason: string }) => void;
  const done = new Promise<{ code: number; reason: string }>((resolvePromise) => {
    resolveDone = resolvePromise;
  });

  const failAllPending = (reason: string): void => {
    if (failReason === null) failReason = reason;
    for (const [id, entry] of pending) {
      pending.delete(id);
      entry.resolve({ ok: false, error: { code: 'CANCELLED', message: reason } });
    }
  };

  /** 侧车收尾：兑现 done，并在 ready 尚未发出时**立刻**让 ready 失败（带原因） */
  const finishWith = (code: number, reason: string): void => {
    if (failReason === null) failReason = reason;
    resolveDone({ code, reason });
    if (!readySettled) {
      rejectReady(new Error(`侧车未就绪即退出：[${code}] ${reason}${logDigest()}`));
    }
  };

  /** 把侧车自己报的日志并进错误信息：否则失败时只剩一句"没有 ready"，无从下手 */
  const logDigest = (): string => {
    const lines = events
      .filter((item) => item.op === 'log')
      .map((item) => (item.payload as { message?: string }).message ?? '')
      .filter((text) => text.length > 0);
    return lines.length > 0 ? `\n侧车日志：\n  ${lines.join('\n  ')}` : '';
  };

  const answerHostCall = (id: string, capability: string, payload: unknown): void => {
    hostCalls.push({ capability, payload });
    const reply = (result?: unknown): void => {
      toSidecar.push(JSON.stringify({ t: 'hostres', id, ok: true, result }));
    };
    const fail = (code: string, message: string): void => {
      toSidecar.push(JSON.stringify({ t: 'hostres', id, ok: false, error: { code, message } }));
    };

    switch (capability) {
      case HOST_CAPABILITIES.secureAvailable:
        reply({ available: dpapiAvailable });
        return;
      case HOST_CAPABILITIES.secureEncrypt: {
        if (options.dpapi?.failEncrypt === true) {
          fail('ENCRYPT_FAILED', 'DPAPI 加密失败（测试注入）');
          return;
        }
        const { plainText } = payload as { plainText: string };
        reply({ cipherBase64: xorCipher(Buffer.from(plainText, 'utf8')).toString('base64') });
        return;
      }
      case HOST_CAPABILITIES.secureDecrypt: {
        const { cipherBase64 } = payload as { cipherBase64: string };
        reply({ plainText: xorCipher(Buffer.from(cipherBase64, 'base64')).toString('utf8') });
        return;
      }
      case HOST_CAPABILITIES.shellOpenExternal: {
        openedExternal.push((payload as { url: string }).url);
        reply(undefined);
        return;
      }
      case HOST_CAPABILITIES.clipboardWriteText: {
        clipboard.push((payload as { text: string }).text);
        reply(undefined);
        return;
      }
      default:
        fail('NOT_SUPPORTED', `宿主未登记该能力：${capability}`);
    }
  };

  void (async () => {
    try {
      for await (const line of fromSidecar.drain()) {
        const frame = JSON.parse(line) as Record<string, unknown>;
        switch (frame['t']) {
          case 'ready':
            readySettled = true;
            resolveReady(frame as unknown as ReadyFrame);
            break;
          case 'res': {
            const entry = pending.get(frame['id'] as string);
            if (entry !== undefined) {
              pending.delete(frame['id'] as string);
              entry.resolve({
                ok: frame['ok'] === true,
                ...(frame['result'] !== undefined ? { result: frame['result'] } : {}),
                ...(frame['error'] !== undefined
                  ? { error: frame['error'] as { code: string; message: string } }
                  : {}),
              });
            }
            break;
          }
          case 'bye':
            finishWith(frame['code'] as number, frame['reason'] as string);
            break;
          case 'host':
            answerHostCall(frame['id'] as string, frame['capability'] as string, frame['payload']);
            break;
          default:
            break;
        }
      }
      failAllPending('侧车在应答前关闭了连接');
    } catch {
      failAllPending('宿主读循环异常结束');
    } finally {
      // 侧车在 `ready` 之前就结束 = 装配失败。此处必须**立刻**让 ready 失败并带上原因，
      // 否则测试会挂到 hookTimeout 才失败，而超时信息里没有任何线索。
      if (!readySettled) {
        rejectReady(new Error(`侧车未能就绪：${failReason ?? '未收到 ready 帧'}${logDigest()}`));
      }
    }
  })();

  const service = createSidecarService(transport, options.deps ?? {});
  service.done.then(resolveDone, () => {
    /* ready 失败路径已经在 done 上体现 */
  });
  // 服务侧的 `ready` 可能拒绝（装配失败 / 协议不兼容）。这里必须消费掉：
  // 否则会成为 unhandledRejection，被测试框架记成"用例外的错误"，
  // 掩盖真正失败的那条断言。测试要判读就 await 本 harness 的 `ready`。
  service.ready.catch(() => undefined);
  // 同理：并非每条用例都会 await `ready`（例如"未就绪就发请求"的用例），
  // 挂一个空 catch 让未消费的拒绝不再算作未处理异常；真正 await 它的用例
  // 依旧会拿到拒绝。
  ready.catch(() => undefined);

  let requestSeq = 0;

  const harness: Harness = {
    received,
    hostCalls,
    openedExternal,
    clipboard,
    paths: {
      dataDir,
      cacheDir: join(dataDir, 'cache'),
      secureDir: join(dataDir, 'secure'),
      workspaceRoot: join(dataDir, 'workspace'),
      projectsDir: join(dataDir, 'workspace', 'projects'),
    },
    ready,
    done,

    request(op, payload) {
      const id = `h${(requestSeq += 1)}`;
      return new Promise((resolvePromise) => {
        pending.set(id, { resolve: resolvePromise });
        toSidecar.push(JSON.stringify({ t: 'req', id, op, payload }));
      });
    },

    nextEvent(op, timeoutMs = 5_000) {
      const existing = events.filter((item) => item.op === op);
      if (existing.length > 0) {
        const { payload } = existing[0] as { payload: unknown };
        events.splice(events.indexOf(existing[0] as { op: string; payload: unknown }), 1);
        return Promise.resolve(payload);
      }
      return new Promise<unknown>((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => rejectPromise(new Error(`等待事件超时：${op}`)), timeoutMs);
        eventWaiters.push({
          op,
          resolve(value) {
            clearTimeout(timer);
            resolvePromise(value);
          },
        });
      });
    },

    eventsOf(op) {
      return events.filter((item) => item.op === op).map((item) => item.payload);
    },

    welcome(overrides = {}) {
      const frame: WelcomeFrame = {
        t: 'welcome',
        protocol: options.protocol ?? 1,
        secureStore: dpapiAvailable,
        config: {
          dataDir,
          cacheDir: join(dataDir, 'cache'),
          secureDir: join(dataDir, 'secure'),
          workspaceRoot: join(dataDir, 'workspace'),
          userId: 'local-user',
          ...(options.accountBaseUrl !== undefined
            ? { accountBaseUrl: options.accountBaseUrl }
            : {}),
        },
        ...overrides,
      };
      if (options.dropBeforeWelcome !== true) toSidecar.push(JSON.stringify(frame));
      // 刻意**不关闭**宿主 → 侧车的入站管道：真实宿主在整个会话期间都不关 stdin，
      // 而"关闭 stdin"在协议里等于「宿主已死」（侧车会立即收尾并拒发后续帧）。
      // 需要模拟宿主消失的用例请用 `closeHost()`。
      if (options.dropBeforeWelcome === true) toSidecar.end();
    },

    async shutdown() {
      await harness.request(SIDECAR_OPS.shutdown);
    },

    closeHost() {
      toSidecar.end();
    },

    killSidecar() {
      // 宿主侧读端断开：侧车再写就是写进空管道
      fromSidecar.end();
    },

    async dispose() {
      toSidecar.end();
      fromSidecar.end();
      await service.done.catch(() => undefined);
      if (!ownedTemp) return;
      // 临时目录清理失败（SQLite 句柄尚未释放 / 杀软扫描）不该让用例失败，
      // 但要重试一次：Windows 上文件句柄释放有一拍延迟。
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          rmSync(dataDir, { recursive: true, force: true });
          return;
        } catch {
          await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 120));
        }
      }
    },
  };

  return harness;
}

/** 便于测试构造一个"永远可用"的假 DPAPI（用于不走协议层、直接装配运行时的场景） */
export function fakeSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plainText: string) => xorCipher(Buffer.from(plainText, 'utf8')),
    decryptString: (encrypted: Buffer) => xorCipher(encrypted).toString('utf8'),
  };
}
