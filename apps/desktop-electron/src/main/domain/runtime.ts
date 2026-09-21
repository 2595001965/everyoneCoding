import {
  DOMAIN_KINDS,
  createDomainEventSink,
  domainErrorFromUnknown,
  domainUnavailableError,
  isDomainKind,
  isDomainRpcMethod,
  isDomainSyncMethod,
  type DomainControlServiceHost,
  type DomainDescriptor,
  type DomainEventSink,
  type DomainKind,
  type DomainRpcRequest,
  type DomainRpcResponse,
} from '@ec/shell-api';

/**
 * 域运行时聚合器：把各域的路由函数合成一个 `DomainControlServiceHost`，
 * 统一承担**白名单校验、错误脱敏、可用性如实上报、事件信封补齐**四件事。
 *
 * 关键纪律：
 * - 方法名先过 `isDomainRpcMethod` 再分发，未知域/未知方法一律拒绝，不做反射；
 * - `describe()` 只回答"这个域装配好了没"。**没装配的域必须报 false**——
 *   渲染层据此决定是否注入 `globalThis.__EC_*__`，谎报可用会让页面拿到
 *   一个"能打开但每个动作都失败"的端口，比保留装配引导更差；
 * - 错误一律经 `domainErrorFromUnknown` 脱敏后才回渲染层；
 * - 路由内推事件只给 `ctx.emit(payload)`，**requestId 与 domain 由本层补齐**：
 *   域实现不该关心信封格式，也就不会漏填关联字段。
 */

/** 路由可用的请求上下文（第三参数，向后兼容只写 `(method, params)` 的旧路由） */
export interface DomainRouterContext {
  /** 本次请求 id；事件信封据此与渲染层调用关联 */
  requestId: string;
  /** 推一条域事件（载荷须可结构化克隆）；无订阅目标时静默丢弃 */
  emit(payload: unknown): void;
}

export type DomainRouter = (
  method: string,
  params: Record<string, unknown>,
  ctx: DomainRouterContext,
) => Promise<unknown>;

/**
 * 同步域路由：只承载 `DOMAIN_SYNC_METHODS` 白名单内的方法。
 *
 * 约束：**不得** await、不得做网络/子进程 IO。它由渲染层的 `sendSync` 驱动，
 * 慢一点就是整个渲染进程卡住。
 *
 * 第三参数 `ctx` 与异步路由同形：同步方法同样会产生「阶段已推进」「下游置 stale」
 * 这类状态变化事件，丢掉它们会让 UI 在同步操作后停在旧状态。IPC 层在调用前
 * 已把 `requestId → sender` 注册进 sink，事件经 sink 直接送出去。
 * 只写 `(method, params)` 的实现仍然合法（少参数可赋值给多参数签名）。
 */
export type SyncDomainRouter = (
  method: string,
  params: Record<string, unknown>,
  ctx: DomainRouterContext,
) => unknown;

export interface DomainRuntimeOptions {
  routers: Partial<Record<DomainKind, DomainRouter>>;
  /**
   * 同步路由（可选）。未提供的域在同步通道上如实返回 NOT_SUPPORTED，
   * 渲染层据此不注入同步签名的端口（记忆 / 流水线页面保留装配引导）。
   */
  syncRouters?: Partial<Record<DomainKind, SyncDomainRouter>> | undefined;
  /** 未装配域的原因（面向用户，不含路径与密钥） */
  unavailableReasons?: Partial<Record<DomainKind, string>> | undefined;
  /** 退出前释放资源（数据库连接、定时器等） */
  disposers?: ReadonlyArray<() => Promise<void>> | undefined;
  /** 事件下发注册表（缺省自建；测试可注入以断言投递） */
  events?: DomainEventSink | undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function createDomainRuntime(options: DomainRuntimeOptions): DomainControlServiceHost {
  const { routers, syncRouters, unavailableReasons, disposers } = options;
  const events = options.events ?? createDomainEventSink();

  /** 同步与异步共用的问题描述，避免两处措辞漂移 */
  const methodNotAllowed = (domain: DomainKind, method: string, sync: boolean): DomainRpcResponse => ({
    requestId: 'invalid',
    ok: false,
    error: {
      code: 'INVALID_ARGUMENT',
      message: sync
        ? `方法不在 ${domain} 域的同步白名单内：${method}（同步口只承载本地 SQLite / 文件方法）`
        : `方法不在 ${domain} 域的调用白名单内：${method}`,
    },
  });

  return {
    events,

    async invoke(request: DomainRpcRequest): Promise<DomainRpcResponse> {
      const requestId = typeof request?.requestId === 'string' ? request.requestId : 'invalid';
      const domain = request?.domain;
      const method = request?.method;

      if (!isDomainKind(domain) || typeof method !== 'string') {
        return {
          requestId,
          ok: false,
          error: { code: 'INVALID_ARGUMENT', message: '域请求缺少合法的 domain 或 method' },
        };
      }
      if (!isDomainRpcMethod(domain, method)) {
        return { ...methodNotAllowed(domain, method, false), requestId };
      }

      const router = routers[domain];
      if (!router) {
        return {
          requestId,
          ok: false,
          error: domainUnavailableError(domain, unavailableReasons?.[domain]),
        };
      }

      // 信封的 requestId / domain 在这里补齐：域实现只给载荷，无从漏填关联字段
      const ctx: DomainRouterContext = {
        requestId,
        emit: (payload: unknown) => events.send({ requestId, domain, payload }),
      };

      try {
        const result = await router(method, asRecord(request.params), ctx);
        // 注意：result 为 undefined 时不写该字段，避免 exactOptionalPropertyTypes 下带出 undefined
        return result === undefined ? { requestId, ok: true } : { requestId, ok: true, result };
      } catch (error) {
        return { requestId, ok: false, error: domainErrorFromUnknown(error) };
      }
    },

    /**
     * 同步调用（`DOMAIN_SYNC_METHODS` 白名单）。
     *
     * 与 `invoke` 的纪律完全一致：先过域成员判定、再过同步方法白名单、
     * 最后才分发；未装配同步口的域返回 NOT_SUPPORTED 而不是空数组之类的伪结果。
     */
    invokeSync(request: DomainRpcRequest): DomainRpcResponse {
      const requestId = typeof request?.requestId === 'string' ? request.requestId : 'invalid';
      const domain = request?.domain;
      const method = request?.method;

      if (!isDomainKind(domain) || typeof method !== 'string') {
        return {
          requestId,
          ok: false,
          error: { code: 'INVALID_ARGUMENT', message: '域请求缺少合法的 domain 或 method' },
        };
      }
      if (!isDomainSyncMethod(domain, method)) {
        return { ...methodNotAllowed(domain, method, true), requestId };
      }

      const syncRouter = syncRouters?.[domain];
      if (!syncRouter) {
        return {
          requestId,
          ok: false,
          error: domainUnavailableError(
            domain,
            unavailableReasons?.[domain] ??
              `域 ${domain} 未提供同步调用口（同步端口仅记忆与流水线域装配）`,
          ),
        };
      }

      try {
        // 同步路由同样拿到请求上下文：它产生的状态变化事件与异步路径共用同一信封补齐逻辑
        const ctx: DomainRouterContext = {
          requestId,
          emit: (payload: unknown) => events.send({ requestId, domain, payload }),
        };
        const result = syncRouter(method, asRecord(request.params), ctx);
        return result === undefined ? { requestId, ok: true } : { requestId, ok: true, result };
      } catch (error) {
        return { requestId, ok: false, error: domainErrorFromUnknown(error) };
      }
    },

    async describe(): Promise<DomainDescriptor[]> {
      return DOMAIN_KINDS.map((kind) =>
        routers[kind]
          ? { kind, available: true }
          : { kind, available: false, reason: unavailableReasons?.[kind] ?? '域运行时尚未装配' },
      );
    },

    async dispose(): Promise<void> {
      for (const dispose of disposers ?? []) {
        try {
          await dispose();
        } catch {
          // 单个域释放失败不应阻塞退出流程
        }
      }
    },
  };
}
