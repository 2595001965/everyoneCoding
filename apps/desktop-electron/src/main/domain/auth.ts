import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createServer, type Server } from 'node:http';

import {
  AuthClient,
  OfflineController,
  isNetworkError,
  type AuthProvider,
  type AuthSession,
  type OAuthHandshake,
  type OAuthProvider,
  type SecureStorePort,
  type SystemPort,
  type TransportPort,
} from '@ec/account';
import { ShellError, type ShellErrorCode } from '@ec/shell-api';

import type { DomainRouter } from './runtime';

/**
 * auth 域运行时（账号，14 个方法全部可用）。
 *
 * 全部复用 `@ec/account` 的 `AuthClient`，本文件只做**外壳装配**：
 * - `TransportPort` → Node `fetch`（主进程无 CORS，直连账号服务）
 * - `SecureStorePort` → Electron `safeStorage`（DPAPI）加密落盘，键即文件名
 * - `SystemPort` → 回环监听（OAuth 主通道）+ 注入的系统浏览器与剪贴板
 * - `OfflineController` → 云端不可达时进入离线模式（`isOffline` / `tryRecover` 由它承载）
 *
 * 两个**必须由外壳持有的状态**（`AuthClient` 把它们留给调用方）：
 * - **待完成的 OAuth 握手**：`beginOAuth` 产出的 `codeVerifier` / `stop` 只在进程内有效，
 *   渲染层只会回传 `callbackUrl`，故这里按 provider 暂存，`completeOAuth` 时取用；
 * - **当前会话令牌**：`listBindings` / `bind` / `unbind` 在端口契约里不带 token，
 *   令牌必须从已恢复的会话里取。
 *
 * 如实说明：
 * - OAuth 的自定义协议辅通道（`everyonecoding://oauth`）**未接线**，`registerProtocol` 如实返回
 *   `false`；主通道（本地回环监听）可用；
 * - 邮箱验证与重置密码依赖**服务端投递邮件**，PRD §8 的最小服务端不含该能力——
 *   客户端这一侧是真实实现，调用会得到服务端的真实响应（含"未实现"的业务错误），
 *   不在本域伪造成功。
 */

/**
 * Electron `safeStorage` 的最小形状（便于测试注入假实现）。
 *
 * 统一走 `main/secure-storage.ts` 的定义，不再本地复制一份——两份声明一旦漂移，
 * 「同步 / 异步原语」这条差异就会在某一种形态上被静默吞掉。
 */
export type { SafeStorageLike } from '../secure-storage';
import type { SafeStorageLike } from '../secure-storage';

/**
 * DPAPI 加密的键值存储（`SecureStorePort`）。
 *
 * 为什么不复用 `main/ai/runtime.ts` 的 `createDpapiStore`：那份实现按 AI 的命名空间与
 * 键名正则约束键，且会把 auth 域耦合到 AI 模块上——auth 必须能在 AI 栈装配失败的环境里独立工作。
 * 这里用最朴素的"一键一文件"，文件名即键名（base64 规避文件系统非法字符）。
 */
function createDpapiSecureStore(safeStorage: SafeStorageLike, root: string): SecureStorePort {
  const fileOf = (key: string): string =>
    join(root, `${Buffer.from(key, 'utf8').toString('base64url')}.dat`);

  return {
    async set(key: string, value: string): Promise<void> {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new ShellError('ENCRYPT_FAILED', '系统加密能力不可用，无法安全保存登录凭据。');
      }
      const file = fileOf(key);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, await safeStorage.encryptString(value));
    },
    async get(key: string): Promise<string | null> {
      const file = fileOf(key);
      if (!existsSync(file)) return null;
      try {
        return await safeStorage.decryptString(readFileSync(file));
      } catch {
        // 解不开（换了系统用户/密文损坏）按"没有凭据"处理，而不是让恢复流程炸掉
        return null;
      }
    },
    async delete(key: string): Promise<void> {
      rmSync(fileOf(key), { force: true });
    },
  };
}

export interface AuthDomainOptions {
  /** 账号服务基址（本机自建服务默认 `http://127.0.0.1:3000`） */
  baseUrl: string;
  safeStorage: SafeStorageLike;
  /** 加密文件根目录（`<userData>/secure`） */
  secureDir: string;
  openExternal: (url: string) => Promise<void>;
  writeClipboard: (text: string) => void;
  /** 测试注入：替换默认的 Node fetch 传输（默认按 baseUrl 直连） */
  transport?: TransportPort | undefined;
  /**
   * 注册自定义协议回调处理器（Electron 侧接 `everyonecoding://oauth` 单实例转发）。
   * 返回 false = 该外壳不支持协议注册（辅通道如实不可用）。
   */
  registerProtocolHandler?: ((handler: (url: string) => void) => boolean) | undefined;
  /**
   * 强制 OAuth 通道。缺省（`undefined`）= 按可用性自动选择：先试回环，失败才回退协议。
   *
   * `'protocol'` 是一个**真实运维需要**而非测试专用的开关：部分企业终端管控
   * 直接禁止进程 `listen` 本机端口，回环每次都会失败。强制协议通道可以跳过
   * 每次都失败的尝试，让授权直接走 `everyonecoding://oauth`。
   */
  forceOAuthChannel?: 'loopback' | 'protocol' | undefined;
}

export function createAuthDomain(options: AuthDomainOptions): { router: DomainRouter } {
  const secureStore = createDpapiSecureStore(options.safeStorage, options.secureDir);

  const transport: TransportPort = options.transport ?? {
    async request(input) {
      try {
        const response = await fetch(input.url, {
          method: input.method,
          headers: {
            ...(input.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...(input.headers ?? {}),
          },
          ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
        });
        const text = await response.text();
        let json: unknown = null;
        try {
          json = text.length > 0 ? JSON.parse(text) : null;
        } catch {
          json = { raw: text };
        }
        return { status: response.status, json };
      } catch (error) {
        // 网络层失败交给 OfflineController 识别（它据此进入离线模式）
        if (!isNetworkError(error)) {
          throw new ShellError('NET_ERROR', error instanceof Error ? error.message : String(error));
        }
        throw error;
      }
    },
  };

  const system: SystemPort = {
    openExternal: (url) => options.openExternal(url),

    /**
     * OAuth 主通道：本机回环监听，随机端口，回调即 `http://127.0.0.1:<port>/...`。
     * 浏览器命中监听后，回调 URL **先交给 AuthClient**（ingestCallback → completeOAuth），
     * 不再丢弃——丢弃会让"回环回调"通道名存实亡（只能靠渲染层手动贴 URL）。
     */
    startLoopback(handler) {
      // 强制协议通道时直接拒绝：AuthClient 会据此回退到 `registerProtocol`。
      // 拒绝用 ShellError 而非普通 Error —— 与"端口被占 / 被策略阻断"走同一条回退路径。
      if (options.forceOAuthChannel === 'protocol') {
        return Promise.reject(
          new ShellError('IO_ERROR', '已按配置强制使用 everyonecoding:// 协议通道'),
        );
      }
      return new Promise((resolve, reject) => {
        const server: Server = createServer((request, response) => {
          const host = request.headers.host ?? '';
          const callbackUrl = `http://${host}${request.url ?? '/'}`;
          response.statusCode = 200;
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end(
            '<!doctype html><meta charset="utf-8"><title>授权完成</title>' +
              '<p style="font-family:system-ui">授权完成，请回到 EveryoneCoding 继续。</p>' +
              '<script>setTimeout(function(){window.close()},1200)</script>',
          );
          // 先应答浏览器，再把回调交给客户端（避免浏览器长时间转圈）
          setImmediate(() => handler(callbackUrl));
        });
        server.on('error', (error) => reject(error));
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          if (address === null || typeof address === 'string') {
            reject(new ShellError('IO_ERROR', '回环监听端口分配失败'));
            return;
          }
          resolve({
            redirectUri: `http://127.0.0.1:${address.port}/oauth/callback`,
            stop: () => server.close(),
          });
        });
      });
    },

    /**
     * 辅通道：`everyonecoding://oauth` 自定义协议。
     * 协议处理器的注册由外壳完成（Electron `setAsDefaultProtocolClient` +
     * 单实例锁 second-instance 转发），这里只挂"收到 URL 后交给谁"的回调。
     */
    registerProtocol: async (handler) => {
      if (options.registerProtocolHandler === undefined) return false;
      return options.registerProtocolHandler(handler);
    },

    writeClipboard: async (text) => options.writeClipboard(text),
  };

  const offline = new OfflineController(async () => {
    try {
      // 探测走同一传输口（测试注入的假传输才能控制可达性）
      const response = await transport.request({
        method: 'GET',
        url: `${options.baseUrl}/api/health`,
      });
      return response.status < 500;
    } catch {
      return false;
    }
  });

  const client = new AuthClient({
    transport,
    system,
    secure: secureStore,
    baseUrl: options.baseUrl,
    offline,
  });
  /** 待完成的 OAuth 握手（按 provider 暂存） */
  const pendingHandshakes = new Map<OAuthProvider, OAuthHandshake>();
  /** 当前会话（绑定操作要从中取令牌） */
  let currentSession: AuthSession | null = null;

  const keepSession = (session: AuthSession | null): AuthSession | null => {
    currentSession = session;
    return session;
  };

  const requireToken = (): string => {
    if (currentSession === null) {
      throw new ShellError('PERMISSION_DENIED', '当前未登录：请先登录后再管理第三方绑定。');
    }
    return currentSession.tokens.accessToken;
  };

  const router: DomainRouter = async (method, params) => {
    try {
      switch (method) {
        case 'register':
          return keepSession(
            await client.register(params['input'] as Parameters<AuthClient['register']>[0]),
          );

        case 'login':
          return keepSession(
            await client.login(params['input'] as Parameters<AuthClient['login']>[0]),
          );

        case 'logout':
          await client.logout();
          keepSession(null);
          return undefined;

        case 'restore':
          return keepSession(await client.restore());

        case 'beginOAuth': {
          const provider = params['provider'] as OAuthProvider;
          const handshake = await client.beginOAuth(provider);
          pendingHandshakes.set(provider, handshake);
          return { authorizeUrl: handshake.authorizeUrl, state: handshake.state };
        }

        case 'completeOAuth': {
          const provider = params['provider'] as OAuthProvider;
          const handshake = pendingHandshakes.get(provider);
          if (!handshake) {
            throw new ShellError(
              'INVALID_ARGUMENT',
              `没有待完成的 ${provider} 授权：请先调用 beginOAuth 发起授权，再完成回调。`,
            );
          }
          try {
            const session = await client.completeOAuth(handshake, String(params['callbackUrl']), {
              rememberMe: params['rememberMe'] === true,
            });
            return keepSession(session);
          } finally {
            // 握手是一次性的：无论成败都消费掉（codeVerifier 已暴露给一次回调，不可复用）
            pendingHandshakes.delete(provider);
          }
        }

        /**
         * 等待 OAuth 回调到达（回环命中 / 自定义协议拉起都会推到这里）。
         * 到达后由本域代为 completeOAuth（state 一次性消费），返回会话。
         * 渲染层 beginOAuth 之后轮询/订阅本方法即可，无需自己拿回调 URL。
         */
        case 'pollOAuthCallback': {
          const provider = params['provider'] as OAuthProvider;
          const handshake = pendingHandshakes.get(provider);
          if (!handshake) {
            throw new ShellError(
              'INVALID_ARGUMENT',
              `没有待完成的 ${provider} 授权：请先调用 beginOAuth 发起授权。`,
            );
          }
          const timeoutMs = Number(params['timeoutMs'] ?? 1500);
          const callbackUrl = await client.waitForCallback(handshake.state, timeoutMs);
          try {
            const session = await client.completeOAuth(handshake, callbackUrl, {
              rememberMe: params['rememberMe'] === true,
            });
            return { status: 'completed', session: keepSession(session) };
          } finally {
            pendingHandshakes.delete(provider);
          }
        }

        /** 渲染层主动上送一条回调 URL（如从浏览器复制 / 外部捕获），走同一条校验路径 */
        case 'submitOAuthCallback': {
          const provider = params['provider'] as OAuthProvider;
          const handshake = pendingHandshakes.get(provider);
          if (!handshake) {
            throw new ShellError(
              'INVALID_ARGUMENT',
              `没有待完成的 ${provider} 授权：请先调用 beginOAuth 发起授权。`,
            );
          }
          try {
            const session = await client.completeOAuth(handshake, String(params['callbackUrl']), {
              rememberMe: params['rememberMe'] === true,
            });
            return keepSession(session);
          } finally {
            pendingHandshakes.delete(provider);
          }
        }

        case 'pollWechatScan': {
          const result = await client.waitWechatScan(String(params['state']), {
            // 单次轮询一次：由渲染层控制节奏（端口契约就是"轮询状态"）
            intervalMs: 0,
            timeoutMs: 1500,
          });
          return result;
        }

        case 'listBindings':
          return await client.listBindings(requireToken());

        case 'bind':
          return await client.bind(params['provider'] as OAuthProvider, requireToken());

        case 'unbind':
          return await client.unbind(
            params['provider'] as AuthProvider,
            requireToken(),
            params['hasPassword'] === true,
          );

        case 'requestEmailVerification':
          await client.requestEmailVerification(String(params['email']));
          return undefined;

        /** 邮件链接里的 token 确认（注册 → 验证 → 登录闭环的"验证"一步） */
        case 'confirmEmailVerification':
          await client.confirmEmailVerification(String(params['token']));
          return undefined;

        /** 查询验证状态（验证链接在本机之外的浏览器里点开，故只能轮询） */
        case 'emailVerified':
          return await client.emailVerified(String(params['email']));

        case 'requestPasswordReset':
          await client.requestPasswordReset(String(params['email']));
          return undefined;

        case 'resetPassword':
          await client.resetPassword(
            params['input'] as { email: string; code: string; newPassword: string },
          );
          return undefined;

        case 'isOffline':
          return offline.isOffline();

        case 'tryRecover':
          return await offline.tryRecover();

        default:
          throw new ShellError('INVALID_ARGUMENT', `auth 域不支持的方法：${method}`);
      }
    } catch (error) {
      throw mapAuthError(error);
    }
  };

  return { router };
}

/** 服务端业务错误 / 网络错误 → 结构化错误码（message 保留，交给运行时统一脱敏） */
function mapAuthError(error: unknown): unknown {
  if (error instanceof ShellError) return error;
  if (isNetworkError(error)) {
    return new ShellError('NET_ERROR', '云端账号服务不可达：已进入离线模式，本地功能可继续使用。');
  }
  const code = (error as { code?: unknown } | null)?.['code'];
  const status = (error as { status?: unknown } | null)?.['status'];
  if (typeof status === 'number') {
    const map: Record<number, ShellErrorCode> = {
      400: 'INVALID_ARGUMENT',
      401: 'PERMISSION_DENIED',
      403: 'PERMISSION_DENIED',
      404: 'NOT_FOUND',
      409: 'ALREADY_EXISTS',
      408: 'TIMEOUT',
      429: 'TIMEOUT',
    };
    const mapped = map[status];
    if (mapped) {
      return new ShellError(mapped, error instanceof Error ? error.message : String(error));
    }
  }
  if (typeof code === 'string') {
    return new ShellError('UNKNOWN', error instanceof Error ? error.message : String(error));
  }
  return error;
}
