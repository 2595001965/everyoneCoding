import {
  DOMAIN_KINDS,
  createDomainEventSink,
  domainErrorFromUnknown,
  domainUnavailableError,
  isDomainKind,
  isDomainRpcMethod,
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

export interface DomainRuntimeOptions {
  routers: Partial<Record<DomainKind, DomainRouter>>;
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
  const { routers, unavailableReasons, disposers } = options;
  const events = options.events ?? createDomainEventSink();

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
        return {
          requestId,
          ok: false,
          error: { code: 'INVALID_ARGUMENT', message: `方法不在 ${domain} 域的调用白名单内：${method}` },
        };
      }

      const router = routers[domain];
      if (!router) {
        return { requestId, ok: false, error: domainUnavailableError(domain, unavailableReasons?.[domain]) };
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
