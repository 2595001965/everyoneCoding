import type { Logger, SecureStore } from '@ec/core';
import type { Database } from 'better-sqlite3';

import { ApiKeyStore } from '../secure/api-key-store';
import { ProviderRepo } from '../repo/provider-repo';
import { ModelRepo } from '../repo/model-repo';
import { PurposeBindingRepo } from '../repo/purpose-binding-repo';
import { UsageRepo } from '../repo/usage-repo';
import { RemoteConfigRepo } from '../repo/remote-config-repo';
import { createNodeHttpTransport } from '../core/node-transport';
import { OpenAiAdapter } from '../adapters/openai/client';
import { AnthropicAdapter } from '../adapters/anthropic/client';
import { PlatformGatewayAdapter, isHostedGatewayProvider } from '../adapters/platform-gateway';
import type { HttpTransport, ProxyConfig } from '../core/http';
import type { ProviderAdapter } from '../core/adapter';
import type { Protocol, Provider } from '../domain/provider';
import { BudgetGuard, type BudgetConfig } from '../gateway/budget';
import { UsageTracker } from '../gateway/usage-tracker';
import { RequestQueue } from '../gateway/queue';
import { FailoverController, type FailoverPolicy } from '../gateway/failover';
import { AiEventLog, type AiEventRecord } from '../gateway/event-log';
import { AiGateway, type AiGatewayDeps } from '../gateway/client';
import { parseProxyUrl } from '../gateway/proxy';
import type { RetryPolicy } from '../gateway/retry';
import { AiControlService } from './ai-control-api';
import type { AgentStore } from '../agent/store';
import { AgentGatewayControl } from '../agent/gateway-control';

/**
 * AI 层装配。
 *
 * 所有依赖在此一次性构建，业务侧只拿 `gateway`（对话出口）与 `control`（设置页门面）。
 * 传输层默认 Node HTTP 实现；测试可注入脚本化实现。
 */

export interface AiStackOptions {
  agentStore?: AgentStore;
  refreshSharedConfig?: (budget: BudgetGuard, queue: RequestQueue) => void;
  db: Database;
  secureStore: SecureStore;
  userId: string;
  transport?: HttpTransport;
  logger?: Logger | null;
  proxy?: ProxyConfig | string | null;
  budget?: Partial<BudgetConfig>;
  /** 各 Provider 的限流配置 */
  limits?: Record<string, { qps?: number; concurrency?: number }>;
  /** 重试策略（缺省：指数退避最多 3 次，FR-AI-10）；测试可压到 0 */
  retry?: Partial<RetryPolicy>;
  /** 容灾策略（开关 / 连续失败阈值 / 自动恢复时间） */
  failover?: Partial<FailoverPolicy>;
  /** 每个 attempt 固定版本化的价格快照；测试与后续 D10 装配可注入。 */
  priceFor?: AiGatewayDeps['priceFor'];
  /** 运维事件落点（已脱敏）；Electron 用它写主进程日志 */
  onAiEvent?: (record: AiEventRecord) => void;
  /** Account service address and main-process-only session token callback. */
  platformGateway?: {
    accountBaseUrl: string;
    getAccessToken: () => Promise<string | null>;
  };
}

export interface AiStack {
  providers: ProviderRepo;
  models: ModelRepo;
  bindings: PurposeBindingRepo;
  usageRepo: UsageRepo;
  usage: UsageTracker;
  budget: BudgetGuard;
  queue: RequestQueue;
  failover: FailoverController;
  gateway: AiGateway;
  control: AiControlService;
  remoteConfig: RemoteConfigRepo;
  events: AiEventLog;
  dispose(): Promise<void>;
}

export function createAiStack(options: AiStackOptions): AiStack {
  const transport = options.transport ?? createNodeHttpTransport();
  const keys = new ApiKeyStore(options.secureStore);
  const providers = new ProviderRepo(options.db, keys);
  const models = new ModelRepo(options.db);
  const bindings = new PurposeBindingRepo(options.db);
  const usageRepo = new UsageRepo(options.db);
  const budget = new BudgetGuard(usageRepo, options.userId, options.budget ?? {});
  const rawUsage = new UsageTracker(usageRepo, budget, options.logger ?? null);
  const mutations = new Set([
    'beginAttempt',
    'updateAttempt',
    'correctFinal',
    'recoverInterrupted',
    'record',
  ]);
  const usage = options.agentStore
    ? new Proxy(rawUsage, {
        get(target, property) {
          const value: unknown = Reflect.get(target, property);
          if (typeof value !== 'function') return value;
          if (!mutations.has(String(property))) return value.bind(target);
          return (...args: unknown[]) => options.agentStore!.write(() => value.apply(target, args));
        },
      })
    : rawUsage;
  if (!options.agentStore) usage.recoverInterrupted(options.userId);
  const queue = new RequestQueue();
  let recoveredToken: number | null = null;
  const execution = options.agentStore
    ? new AgentGatewayControl(
        options.agentStore,
        budget,
        () => {
          options.refreshSharedConfig?.(budget, queue);
          if (recoveredToken !== options.agentStore!.token) {
            usage.recoverInterrupted(options.userId);
            recoveredToken = options.agentStore!.token;
          }
        },
        queue,
      )
    : undefined;
  const failover = new FailoverController(options.failover ?? {});
  const events = new AiEventLog(200, options.onAiEvent ?? null);
  failover.onEvent((event) => events.fromFailover(event));
  const remoteConfig = new RemoteConfigRepo(options.db);

  for (const [providerId, limit] of Object.entries(options.limits ?? {})) {
    queue.configure(providerId, { qps: limit.qps ?? 0, concurrency: limit.concurrency ?? 0 });
  }

  const adapters = new Map<Protocol, ProviderAdapter>([
    ['openai', new OpenAiAdapter()],
    ['anthropic', new AnthropicAdapter()],
  ]);
  const hostedAdapters = new Map<Protocol, ProviderAdapter>(
    options.platformGateway
      ? [
          [
            'openai',
            new PlatformGatewayAdapter('openai', options.platformGateway.accountBaseUrl),
          ],
          [
            'anthropic',
            new PlatformGatewayAdapter('anthropic', options.platformGateway.accountBaseUrl),
          ],
        ]
      : [],
  );

  const proxy =
    typeof options.proxy === 'string' ? parseProxyUrl(options.proxy) : (options.proxy ?? null);

  const gateway = new AiGateway({
    providers,
    models,
    bindings,
    usage,
    budget,
    queue,
    failover,
    transport,
    adapterFor: (protocol, provider) => {
      if (
        provider &&
        options.platformGateway &&
        isHostedGatewayProvider(provider, options.platformGateway.accountBaseUrl)
      ) {
        const hosted = hostedAdapters.get(protocol);
        if (hosted) return hosted;
      }
      const adapter = adapters.get(protocol);
      if (!adapter) throw new Error(`不支持的协议：${protocol}`);
      return adapter;
    },
    ...(options.platformGateway
      ? {
          resolveApiKey: async (provider: Provider) =>
            isHostedGatewayProvider(provider, options.platformGateway!.accountBaseUrl)
              ? options.platformGateway!.getAccessToken()
              : providers.getApiKey(provider.id),
        }
      : {}),
    ...(execution ? { execution } : {}),
    ...(proxy ? { proxy } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.retry ? { retry: options.retry } : {}),
    ...(options.priceFor ? { priceFor: options.priceFor } : {}),
  });

  gateway.onEvent((event) => events.fromGateway(event));

  return {
    events,
    providers,
    models,
    bindings,
    usageRepo,
    usage,
    budget,
    queue,
    failover,
    gateway,
    remoteConfig,
    control: new AiControlService({
      userId: options.userId,
      providers,
      models,
      bindings,
      usage,
      budget,
      queue,
      gateway,
      remoteConfig,
      transport,
      failover,
      events,
      ...(options.platformGateway ? { platformGateway: options.platformGateway } : {}),
    }),
    async dispose(): Promise<void> {
      execution?.dispose();
      queue.clear();
      await transport.close?.();
      try {
        options.agentStore?.release();
      } catch {
        /* a successor already owns the lease */
      }
    },
  };
}
