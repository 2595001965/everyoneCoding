import {
  DOMAIN_SYNC_METHODS,
  isDomainKind,
  type DomainRpcRequest,
  type DomainRpcResponse,
  type AiRpcRequest,
  type AiStreamRequest,
} from '@ec/shell-api';

import {
  createHeadlessRuntime,
  type HeadlessRuntime,
  type HeadlessRuntimeOptions,
  type HeadlessRuntimePorts,
} from '../main/runtime/bootstrap';
import type { SafeStorageLike } from '../main/secure-storage';
import { createLink, HostCallError, type SidecarLink, type SidecarTransport } from './link';
import { resolveSidecarMigrationsDir } from './paths';
import {
  HOST_CAPABILITIES,
  isProtocolCompatible,
  PROTOCOL_VERSION,
  SIDECAR_EVENTS,
  SIDECAR_OPS,
  SIDECAR_RUNTIME_ID,
  type ReadyFrame,
  type RequestFrame,
  type ResponseFrame,
  type WelcomeFrame,
  type WireDomainDescriptor,
} from './protocol';

/**
 * 侧车服务：握手 → 装配业务运行时 → 服务宿主的调用。
 *
 * ## 与 Electron 形态的等价性靠什么保证
 *
 * 侧车**不重新实现任何领域逻辑**：它调用 `createHeadlessRuntime()`，
 * 而那份装配与 Electron 主进程用的是同一份（见 `main/runtime/bootstrap.ts`）。
 * 本文件只做三件外壳层的事：
 *
 * 1. **把「外壳端口」接到宿主**：DPAPI 加解密、打开外链、剪贴板经协议回传宿主执行；
 * 2. **把「请求内事件」按 requestId 注册回传** —— 与 Electron 的 `ipc/domain.ts`
 *    一字不差：`events.register(requestId, send)` → `finally` 注销。
 *    少了这一步，流水线的阶段事件、导入进度就会静默丢失（静默丢失正是最难的故障）；
 * 3. **如实降级**：运行时未就绪 / AI 未装配 / 宿主能力不可用，一律回结构化错误，
 *    绝不返回一个看起来成功的空结果。
 *
 * ## 同步签名端口（memory / pipeline）
 *
 * 侧车**不提供**同步口，宿主也不暴露（Tauri 的渲染层没有同步 IPC 原语）。
 * 这不是偷懒：用异步往返假装同步会读到上一拍的数据，等于伪造。因此这里如实
 * 把「哪些域本来有同步口」报给宿主，让宿主在能力矩阵里写清原因。
 */

/** 侧车自身能力声明（`hello` 帧携带；宿主的可用性门槛另经 `welcome` 协商） */
export const SIDECAR_FEATURES = [
  'domain.rpc',
  'ai.rpc',
  'ai.stream',
  'storage.sqlite',
  'process.controlled',
] as const;

export interface SidecarDeps {
  createRuntime(options: HeadlessRuntimeOptions): Promise<HeadlessRuntime>;
  /** SQLite 迁移目录定位（打包后与仓库布局不同，故做成可替换点） */
  resolveMigrationsDir(): string;
  pid: number;
  nodeVersion: string;
  runtimeVersion: string;
}

export interface SidecarServiceHandle {
  /** `ready` 帧发出后兑现（宿主持此判定侧车可用） */
  ready: Promise<ReadyFrame>;
  /** 服务结束（`bye` 已发出 / 宿主关闭管道）后兑现 */
  done: Promise<{ code: number; reason: string }>;
  /**
   * 主动收尾（信号处理 / 宿主强杀前的最后机会）。
   *
   * 存在的意义是**把子进程杀干净**：预览后端、依赖安装这类外部进程挂在运行时里，
   * 直接 `process.exit()` 会把它们变成孤儿（占端口、占工程目录）。
   */
  shutdown(reason?: string): Promise<void>;
}

/**
 * 从宿主能力应答里取字段。
 *
 * 能力应答刻意用**结构化对象**（`{ cipherBase64 }` / `{ plainText }`）而不是裸值：
 * 裸值一旦将来需要附带元信息（算法标识、密钥版本）就得改协议语义，
 * 而结构化对象加字段是向后兼容的。取不到字段时**抛错**，绝不返回空串——
 * 空串会被当成"加密成功但密文为空"，那是比失败更糟的静默损坏。
 */
function fieldOf(result: unknown, field: string): string {
  if (result !== null && typeof result === 'object') {
    const value = (result as Record<string, unknown>)[field];
    if (typeof value === 'string') return value;
  }
  throw new HostCallError('UNKNOWN', `宿主能力应答缺少字符串字段 ${field}`);
}

/**
 * 用宿主（Rust 侧）的 DPAPI 原语构造 `SafeStorageLike`。
 *
 * `available` 在**握手时一次性确定**并保持常量：装配期必须能同步回答
 * 「要不要装 auth 域」，而 `isEncryptionAvailable()` 在接口上是同步签名。
 * 之后每次加解密才跨进程——单次调用毫秒级，且只发生在保存/读取凭据时。
 *
 * 明文经本机父子进程管道传递：它本来就在侧车内存里（`@ec/account` 必须持有它），
 * 不引入新的暴露面；磁盘上**只出现密文**这一条不因此放松。
 */
export function createHostCipher(link: SidecarLink, available: boolean): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    async encryptString(plainText: string): Promise<Buffer> {
      const result = await link.callHost(HOST_CAPABILITIES.secureEncrypt, { plainText });
      return Buffer.from(fieldOf(result, 'cipherBase64'), 'base64');
    },
    async decryptString(encrypted: Buffer): Promise<string> {
      const result = await link.callHost(HOST_CAPABILITIES.secureDecrypt, {
        cipherBase64: encrypted.toString('base64'),
      });
      return fieldOf(result, 'plainText');
    },
  };
}

/** 把需要外壳的能力接到宿主上 */
export function createHostPorts(link: SidecarLink): HeadlessRuntimePorts {
  return {
    openExternal: async (url: string): Promise<void> => {
      await link.callHost(HOST_CAPABILITIES.shellOpenExternal, { url });
    },
    // 同步签名：只用于把授权码放进剪贴板，发出去即完成，不等人确认。
    // 失败**不伪造成功**——记一条日志，用户看到的是"剪贴板没变"而不是假成功。
    writeClipboard: (text: string): void => {
      void link
        .callHost(HOST_CAPABILITIES.clipboardWriteText, { text })
        .catch((error: unknown) =>
          link.log(
            'warn',
            `剪贴板写入失败：${error instanceof Error ? error.message : String(error)}`,
          ),
        );
    },
    onNotice: (message: string): void => {
      link.log('warn', message);
    },
  };
}

export function createSidecarService(
  transport: SidecarTransport,
  overrides: Partial<SidecarDeps> = {},
): SidecarServiceHandle {
  const deps: SidecarDeps = {
    createRuntime: overrides.createRuntime ?? createHeadlessRuntime,
    resolveMigrationsDir: overrides.resolveMigrationsDir ?? resolveSidecarMigrationsDir,
    pid: overrides.pid ?? process.pid,
    nodeVersion: overrides.nodeVersion ?? process.versions.node,
    runtimeVersion: overrides.runtimeVersion ?? '0.1.0',
  };

  const { link, run } = createLink(transport);

  let runtime: HeadlessRuntime | null = null;
  let welcome: WelcomeFrame | null = null;
  let settled = false;

  let resolveReady!: (frame: ReadyFrame) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<ReadyFrame>((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });

  let resolveDone!: (result: { code: number; reason: string }) => void;
  const done = new Promise<{ code: number; reason: string }>((resolvePromise) => {
    resolveDone = resolvePromise;
  });

  let resolveWelcome!: (frame: WelcomeFrame | null) => void;
  const welcomeSeen = new Promise<WelcomeFrame | null>((resolvePromise) => {
    resolveWelcome = resolvePromise;
  });

  const reply = (frame: ResponseFrame): void => {
    link.send(frame);
  };

  const replyOk = (id: string, result?: unknown): void => {
    reply(result === undefined ? { t: 'res', id, ok: true } : { t: 'res', id, ok: true, result });
  };

  const replyError = (id: string, error: unknown): void => {
    const wire =
      error instanceof HostCallError
        ? error.toWire()
        : {
            code: 'UNKNOWN',
            message: error instanceof Error ? error.message : String(error),
          };
    reply({ t: 'res', id, ok: false, error: wire });
  };

  /** 结束服务：释放运行时 → 发 `bye` → 兑现 done（幂等） */
  const finish = async (code: number, reason: string): Promise<void> => {
    if (settled) return;
    settled = true;
    try {
      await runtime?.dispose();
    } catch {
      // 释放失败不改变"已经结束"的事实：宿主仍应拿到 bye 并回收进程
    }
    runtime = null;
    if (!link.closed) link.send({ t: 'bye', reason, code });
    resolveDone({ code, reason });
  };

  const handleRequest = async (frame: RequestFrame): Promise<void> => {
    const { id, op } = frame;

    if (op === SIDECAR_OPS.shutdown) {
      replyOk(id);
      await finish(0, '宿主请求关闭侧车');
      return;
    }
    if (op === SIDECAR_OPS.ping) {
      replyOk(id, { pong: true, runtimeReady: runtime !== null });
      return;
    }
    if (runtime === null) {
      // 未就绪：如实拒绝。宿主会在 ready 之后才发业务请求，这里兜的是竞态与误用。
      replyError(
        id,
        new HostCallError('NOT_SUPPORTED', '侧车运行时尚未就绪（等待 handshake/装配）'),
      );
      return;
    }

    switch (op) {
      case SIDECAR_OPS.domainDescribe: {
        replyOk(id, await runtime.domain.describe());
        return;
      }
      case SIDECAR_OPS.domainInvoke: {
        const request = (frame.payload ?? {}) as DomainRpcRequest;
        const requestId = typeof request.requestId === 'string' ? request.requestId : '';
        // 与 Electron 的 ipc/domain.ts 同构：请求内事件按 requestId 精确回给发起者
        if (requestId.length > 0 && isDomainKind(request.domain)) {
          runtime.events.register(requestId, (event) => {
            link.emitEvent(SIDECAR_EVENTS.domainEvent, event);
          });
        }
        try {
          const response: DomainRpcResponse = await runtime.domain.invoke(request);
          replyOk(id, response);
        } finally {
          if (requestId.length > 0) runtime.events.unregister(requestId);
        }
        return;
      }
      case SIDECAR_OPS.aiInvoke: {
        const request = (frame.payload ?? {}) as AiRpcRequest;
        if (runtime.ai === null) {
          // AI 栈未装配：如实回结构化错误，让渲染层走"能力缺失"引导
          replyOk(id, {
            requestId: typeof request.requestId === 'string' ? request.requestId : 'invalid',
            ok: false,
            error: { code: 'NOT_SUPPORTED', message: runtime.aiError ?? 'AI 栈未装配' },
          });
          return;
        }
        replyOk(id, await runtime.ai.invoke(request));
        return;
      }
      case SIDECAR_OPS.aiStreamStart: {
        const request = (frame.payload ?? {}) as AiStreamRequest;
        const requestId = typeof request.requestId === 'string' ? request.requestId : '';
        if (runtime.ai === null) {
          // 不能回"已开始"然后什么都不发：那会让界面永远转圈。
          // 推一条 error 事件 + done，与 Electron 在 AI 未装配时的表现一致。
          link.emitEvent(SIDECAR_EVENTS.aiStream, {
            requestId,
            event: {
              type: 'error',
              error: { code: 'NOT_SUPPORTED', message: runtime.aiError ?? 'AI 栈未装配' },
            },
          });
          link.emitEvent(SIDECAR_EVENTS.aiStream, {
            requestId,
            event: { type: 'done', finishReason: 'error', partial: true },
          });
          replyOk(id, { accepted: false });
          return;
        }
        runtime.ai.stream(request, (event) => {
          link.emitEvent(SIDECAR_EVENTS.aiStream, { requestId, event });
        });
        replyOk(id, { accepted: true });
        return;
      }
      case SIDECAR_OPS.aiAbort: {
        const payload = (frame.payload ?? {}) as { requestId?: unknown };
        if (typeof payload.requestId === 'string') runtime.ai?.abort(payload.requestId);
        replyOk(id);
        return;
      }
      default:
        replyError(
          id,
          new HostCallError('INVALID_ARGUMENT', `未知的侧车 op：${op}（不做反射式分发）`),
        );
    }
  };

  const bootstrap = async (): Promise<void> => {
    link.send({
      t: 'hello',
      protocol: PROTOCOL_VERSION,
      minProtocol: PROTOCOL_VERSION,
      runtime: SIDECAR_RUNTIME_ID,
      pid: deps.pid,
      node: deps.nodeVersion,
      features: [...SIDECAR_FEATURES],
    });

    const welcomeFrame = await welcomeSeen;
    if (welcomeFrame === null) {
      // 宿主在握手完成前就关了管道：正常收尾，不是错误
      await finish(0, '宿主在握手完成前关闭了连接');
      return;
    }
    if (!isProtocolCompatible(welcomeFrame.protocol, PROTOCOL_VERSION)) {
      // 协议不兼容必须**拒绝服务**：半懂的协议会把"方法缺失"表现成随机业务错误
      await finish(3, `侧车协议不兼容：宿主 ${welcomeFrame.protocol}，侧车 ${PROTOCOL_VERSION}`);
      return;
    }

    try {
      const migrationsDir = deps.resolveMigrationsDir();
      runtime = await deps.createRuntime({
        dataDir: welcomeFrame.config.dataDir,
        cacheDir: welcomeFrame.config.cacheDir,
        secureDir: welcomeFrame.config.secureDir,
        defaultWorkspaceRoot: welcomeFrame.config.workspaceRoot,
        userId: welcomeFrame.config.userId,
        safeStorage: createHostCipher(link, welcomeFrame.secureStore),
        ports: createHostPorts(link),
        migrationsDir,
        ...(welcomeFrame.config.accountBaseUrl !== undefined
          ? { accountBaseUrl: welcomeFrame.config.accountBaseUrl }
          : {}),
      });
    } catch (error) {
      // 装配失败必须让宿主知道（否则宿主以为侧车可用，每个调用都超时）
      const reason = `侧车运行时装配失败：${error instanceof Error ? error.message : String(error)}`;
      link.log('error', reason);
      rejectReady(new Error(reason));
      await finish(4, reason);
      return;
    }

    // 装配期间宿主可能已经走了（关了 stdin）。此时 `finish` 已经跑过、`settled` 为真，
    // 而 `runtime` 是刚建出来的——**必须立刻释放**：否则它占着 SQLite 句柄与
    // 预览后端子进程，宿主重启侧车后会撞锁/撞端口（"重启一次就好了"的经典来源）。
    if (settled) {
      try {
        await runtime.dispose();
      } catch {
        /* 已在退出路径上，失败不改变结论 */
      }
      runtime = null;
      return;
    }

    // 无请求归属的事件（外部改动监视、预览后端日志、迁移流式日志）走常驻订阅
    runtime.events.subscribe((event) => {
      link.emitEvent(SIDECAR_EVENTS.domainEvent, event);
    });

    const domains = (await runtime.domain.describe()) as WireDomainDescriptor[];
    const available = new Set(domains.filter((item) => item.available).map((item) => item.kind));
    const frame: ReadyFrame = {
      t: 'ready',
      protocol: PROTOCOL_VERSION,
      domains,
      // 只用来说明"这些域在 Electron 形态下有同步口"——Tauri 形态无同步 IPC 原语，
      // 故宿主不会据此暴露同步通道（见文件头「同步签名端口」）。
      syncDomains: Object.keys(DOMAIN_SYNC_METHODS).filter((kind) => available.has(kind)),
      ai:
        runtime.ai !== null
          ? { available: true }
          : { available: false, reason: runtime.aiError ?? 'AI 栈未装配' },
    };
    link.send(frame);
    resolveReady(frame);
  };

  void run({
    onWelcome(frame) {
      if (welcome !== null) return; // 重复 welcome 忽略（幂等）
      welcome = frame;
      resolveWelcome(frame);
    },
    onRequest(frame) {
      void handleRequest(frame).catch((error: unknown) => {
        // handleRequest 内部已各自兜错；这里兜的是"回包本身失败"之类的意外，
        // 保证任何情况下宿主都能收到应答而不是挂到超时。
        replyError(frame.id, error);
      });
    },
    onEnd() {
      // 宿主死了 / 主动关了管道：侧车必须自行退出，否则会留下孤儿进程占住
      // SQLite 与工程目录（Windows 上表现为"重装前删不掉数据目录"）。
      resolveWelcome(null);
      void finish(0, '宿主关闭了管道');
    },
  });

  void bootstrap().catch((error: unknown) => {
    const reason = `侧车握手失败：${error instanceof Error ? error.message : String(error)}`;
    rejectReady(new Error(reason));
    void finish(4, reason);
  });

  return {
    ready,
    done,
    shutdown: (reason = '侧车收到终止信号') => finish(0, reason),
  };
}
