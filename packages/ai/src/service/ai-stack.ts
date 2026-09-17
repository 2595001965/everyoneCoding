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
import type { HttpTransport, ProxyConfig } from '../core/http';
import type { ProviderAdapter } from '../core/adapter';
import type { Protocol } from '../domain/provider';
import { BudgetGuard, type BudgetConfig } from '../gateway/budget';
import { UsageTracker } from '../gateway/usage-tracker';
import { RequestQueue } from '../gateway/queue';
import { FailoverController } from '../gateway/failover';
import { AiGateway } from '../gateway/client';
import { parseProxyUrl } from '../gateway/proxy';
import { AiControlService } from './ai-control-api';

/**
 * AI 层装配。
 *
 * 所有依赖在此一次性构建，业务侧只拿 `gateway`（对话出口）与 `control`（设置页门面）。
 * 传输层默认 Node HTTP 实现；测试可注入脚本化实现。
 */

export interface AiStackOptions {
  db: Database;
  secureStore: SecureStore;
  userId: string;
  transport?: HttpTransport;
  logger?: Logger | null;
  proxy?: ProxyConfig | string | null;
  budget?: Partial<BudgetConfig>;
  /** 各 Provider 的限流配置 */
  limits?: Record<string, { qps?: number; concurrency?: number }>;
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
  const usage = new UsageTracker(usageRepo, budget, options.logger ?? null);
  const queue = new RequestQueue();
  const failover = new FailoverController();
  const remoteConfig = new RemoteConfigRepo(options.db);

  for (const [providerId, limit] of Object.entries(options.limits ?? {})) {
    queue.configure(providerId, { qps: limit.qps ?? 0, concurrency: limit.concurrency ?? 0 });
  }

  const adapters = new Map<Protocol, ProviderAdapter>([
    ['openai', new OpenAiAdapter()],
    ['anthropic', new AnthropicAdapter()],
  ]);

  const proxy = typeof options.proxy === 'string' ? parseProxyUrl(options.proxy) : (options.proxy ?? null);

  const gateway = new AiGateway({
    providers,
    models,
    bindings,
    usage,
    budget,
    queue,
    failover,
    transport,
    adapterFor: (protocol) => {
      const adapter = adapters.get(protocol);
      if (!adapter) throw new Error(`不支持的协议：${protocol}`);
      return adapter;
    },
    ...(proxy ? { proxy } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });

  return {
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
    }),
    async dispose(): Promise<void> {
      queue.clear();
      await transport.close?.();
    },
  };
}
