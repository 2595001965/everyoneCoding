import type { Logger } from '@ec/core';

import type { AdapterContext, ProviderAdapter } from '../core/adapter';
import type { ChatMessage } from '../core/message';
import type { FinishReason, StreamChunk } from '../core/stream';
import type { ToolDefinition } from '../core/tool';
import type { Usage } from '../core/usage';
import { mergeUsage } from '../core/usage';
import { ProviderUnavailableError, toAiError, type AiError } from '../core/error';
import type { HttpTransport, ProxyConfig } from '../core/http';
import { runConnectionTest } from '../core/connection-test';
import type { ConnectionTestResult } from '../core/adapter';
import { embeddingUnavailable, type EmbeddingOutcome } from '../core/embedding';
import type { Model, ModelDiscovery } from '../domain/model';
import type { Protocol, Provider } from '../domain/provider';
import { resolveModelId, type AiPurpose } from '../domain/purpose-binding';
import type { ModelRepo } from '../repo/model-repo';
import type { ProviderRepo } from '../repo/provider-repo';
import type { PurposeBindingRepo } from '../repo/purpose-binding-repo';
import { embedWithOpenAi } from '../adapters/openai/embeddings';
import { DEFAULT_RETRY_POLICY, delayFor, shouldRetry, type RetryPolicy } from './retry';
import type { RequestQueue } from './queue';
import { type QueueRelease } from './queue';
import type { BudgetGuard } from './budget';
import { describeBudget, type BudgetConfig } from './budget';
import type { UsageTracker } from './usage-tracker';
import type { FailoverController } from './failover';
import { type FailoverPolicy } from './failover';
import { testProxyConnectivity, type ProxyTestResult } from './proxy';

/**
 * AI Gateway：全部 AI 调用的唯一出口（FR-AI-06 / 09 / 10，FR-MDL-10 / 11 / 12）。
 *
 * 一次 chat 的完整链路：
 * 用途 → 绑定 → 选模型 → 选 Provider（含容灾） → 预算校验 → 限流排队
 *   → 适配器流式返回 → 用量落库 → 事件上报
 *
 * 中断语义：AbortSignal 触发后立刻停止，已产出的 delta 全部保留（done.partial = true）。
 */

export interface AiGatewayDeps {
  providers: ProviderRepo;
  models: ModelRepo;
  bindings: PurposeBindingRepo;
  usage: UsageTracker;
  budget: BudgetGuard;
  queue: RequestQueue;
  failover: FailoverController;
  transport: HttpTransport;
  adapterFor: (protocol: Protocol) => ProviderAdapter;
  proxy?: ProxyConfig | null;
  logger?: Logger | null;
  retry?: Partial<RetryPolicy>;
  budgetConfig?: Partial<BudgetConfig>;
  failoverPolicy?: Partial<FailoverPolicy>;
}

export interface GatewayChatRequest {
  userId: string;
  purpose: AiPurpose;
  messages: ChatMessage[];
  projectId?: string | null;
  tools?: ToolDefinition[];
  /** 覆盖用途绑定的模型（调试与一次性切换用） */
  modelId?: string | null;
  providerId?: string | null;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface GatewayEmbeddingRequest {
  userId: string;
  inputs: readonly string[];
  projectId?: string | null;
  /** 覆盖「向量检索」用途绑定 */
  modelId?: string | null;
  providerId?: string | null;
  dimensions?: number | null;
}

export type GatewayEvent =
  | {
      type: 'provider-selected';
      providerId: string;
      providerName: string;
      modelName: string;
      purpose: AiPurpose;
    }
  | { type: 'queued'; providerId: string; position: number }
  | { type: 'retry'; providerId: string; attempt: number; delayMs: number; reason: string }
  | { type: 'failover'; fromProviderId: string; toProviderId: string; reason: string }
  | { type: 'budget-exceeded'; message: string }
  | { type: 'budget-warning'; message: string }
  | {
      type: 'usage';
      providerId: string;
      modelId: string | null;
      usage: Usage;
      cost: number | null;
      latencyMs: number;
    }
  | { type: 'error'; error: AiError }
  | { type: 'done'; finishReason: FinishReason; partial: boolean };

export class AiGateway {
  private readonly retryPolicy: RetryPolicy;
  private readonly listeners = new Set<(event: GatewayEvent) => void>();
  private proxy: ProxyConfig | null;

  constructor(private readonly deps: AiGatewayDeps) {
    this.retryPolicy = { ...DEFAULT_RETRY_POLICY, ...(deps.retry ?? {}) };
    this.proxy = deps.proxy ?? null;
    if (deps.budgetConfig) deps.budget.configure(deps.budgetConfig);
    if (deps.failoverPolicy) deps.failover.configure(deps.failoverPolicy);

    deps.usage.onEvent((event) => {
      if (event.type === 'budget-exceeded') {
        this.emit({ type: 'budget-exceeded', message: event.decision.message });
      } else if (event.type === 'budget-warning' && event.decision.warn) {
        this.emit({ type: 'budget-warning', message: describeBudget(event.decision) });
      }
    });
  }

  onEvent(listener: (event: GatewayEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setProxy(proxy: ProxyConfig | null): void {
    this.proxy = proxy;
  }

  currentProxy(): ProxyConfig | null {
    return this.proxy;
  }

  /* ------------------------------ 对话 ------------------------------ */

  async *chat(request: GatewayChatRequest): AsyncIterable<StreamChunk> {
    const model = this.resolveModel(request);
    if (!model) {
      const error = new ProviderUnavailableError(
        '尚未配置可用模型，请先在「设置 → 模型服务」中完成连接测试',
        {
          retryable: false,
        },
      );
      this.emit({ type: 'error', error });
      yield { type: 'error', error };
      yield { type: 'done', finishReason: 'error', partial: true };
      return;
    }

    const candidates = this.candidatesFor(model, request.userId, request.providerId ?? null);
    if (candidates.length === 0) {
      const error = new ProviderUnavailableError('没有可用的模型服务（全部被停用或已降级）', {
        retryable: false,
      });
      this.emit({ type: 'error', error });
      yield { type: 'error', error };
      yield { type: 'done', finishReason: 'error', partial: true };
      return;
    }

    const decision = this.deps.budget.check();
    if (!decision.ok) {
      const error = new ProviderUnavailableError(decision.message, { retryable: false });
      this.emit({ type: 'budget-exceeded', message: decision.message });
      yield { type: 'error', error };
      yield { type: 'done', finishReason: 'error', partial: true };
      return;
    }

    let lastFailure: AiError | null = null;
    for (const candidate of candidates) {
      const outcome = yield* this.attemptProvider(candidate.provider, candidate.model, request);
      // success / aborted 已由 attemptProvider 收尾，直接结束
      if (outcome.kind !== 'fatal') return;

      // 只有「可重试错误且尚未产生内容」才视为可切换的失败；
      // 已产生内容 / 不可重试错误（401、上下文超限、内容过滤…）不切备用，
      // 既避免重复输出，也避免对无效 Key / 坏输入做无意义容灾降级。
      lastFailure = outcome.error;
      if (!outcome.switchable) {
        // 401、上下文超限、内容过滤等不可重试错误必须原样返回。
        // 泛化成“所有服务不可用”会掩盖可操作建议，也会误导用户切换 Provider。
        this.emit({ type: 'error', error: outcome.error });
        yield { type: 'error', error: outcome.error };
        yield { type: 'done', finishReason: 'error', partial: true };
        return;
      }

      // 只有达到阈值后才允许切换；单次瞬时失败不应绕过容灾策略。
      const shouldSwitch = this.deps.failover.recordFailure(
        candidate.provider.id,
        outcome.error.message,
      );
      if (!shouldSwitch) break;

      const next = candidates.find(
        (item) =>
          item.provider.id !== candidate.provider.id &&
          !this.deps.failover.isDegraded(item.provider.id),
      );
      if (!next) break;
      this.deps.failover.notifySwitch(
        candidate.provider.id,
        next.provider.id,
        outcome.error.message,
      );
      this.deps.logger?.warn('模型服务故障，切换备用', {
        from: candidate.provider.name,
        to: next.provider.name,
        reason: outcome.error.message,
      });
      this.emit({
        type: 'failover',
        fromProviderId: candidate.provider.id,
        toProviderId: next.provider.id,
        reason: outcome.error.message,
      });
    }

    const exhausted = new ProviderUnavailableError(
      lastFailure
        ? `所有模型服务均不可用，最后一次失败原因：${lastFailure.userMessage}`
        : '所有模型服务均不可用，请检查配置或稍后重试',
      { retryable: false },
    );
    this.emit({ type: 'error', error: exhausted });
    yield { type: 'error', error: exhausted };
    yield { type: 'done', finishReason: 'error', partial: true };
  }

  private async *attemptProvider(
    provider: Provider,
    model: Model,
    request: GatewayChatRequest,
  ): AsyncGenerator<StreamChunk, AttemptOutcome, void> {
    const adapter = this.deps.adapterFor(provider.protocol);
    this.emit({
      type: 'provider-selected',
      providerId: provider.id,
      providerName: provider.name,
      modelName: model.name,
      purpose: request.purpose,
    });

    // 重试状态局部化：避免跨 Provider 共享（上一家的 retry-after / 失败原因泄漏到下一家）
    let lastErrorReason = '';
    let lastRetryAfterMs: number | undefined;

    for (let attempt = 0; attempt <= this.retryPolicy.maxRetries; attempt += 1) {
      if (request.signal?.aborted) return { kind: 'aborted' as const };
      if (attempt > 0) {
        const retryAfter = lastRetryAfterMs;
        const delayMs = delayFor(attempt, this.retryPolicy, retryAfter ?? undefined);
        lastRetryAfterMs = undefined;
        this.emit({
          type: 'retry',
          providerId: provider.id,
          attempt,
          delayMs,
          reason: lastErrorReason,
        });
        await sleep(delayMs, request.signal);
      }

      const ticket = Symbol('ai-request');
      let release: QueueRelease | null = null;
      try {
        release = await this.deps.queue.acquire(provider.id, ticket, request.signal);
      } catch (acquireError) {
        // 排队等待期间被中断：直接结束，已产出的部分内容由上层保留
        if (
          request.signal?.aborted ||
          (acquireError instanceof Error && acquireError.name === 'AbortError')
        ) {
          yield { type: 'done', finishReason: 'aborted', partial: true };
          return { kind: 'aborted' as const };
        }
        throw acquireError;
      }
      const position = this.deps.queue.positionOf(provider.id, ticket);
      if (position > 0) this.emit({ type: 'queued', providerId: provider.id, position });

      let emittedContent = false;
      try {
        const result = yield* this.streamOnce(adapter, provider, model, request, (chunk) => {
          if (chunk.type === 'delta' || chunk.type === 'tool_call') emittedContent = true;
        });
        return { kind: 'success' as const, result };
      } catch (error) {
        if (request.signal?.aborted) {
          yield { type: 'done', finishReason: 'aborted', partial: true };
          return { kind: 'aborted' as const };
        }
        const aiError = toAiError(error, { providerId: provider.id, modelId: model.id });
        lastErrorReason = aiError.message;
        lastRetryAfterMs =
          aiError instanceof Error && 'retryAfterMs' in aiError
            ? (aiError as { retryAfterMs?: number }).retryAfterMs
            : undefined;

        if (request.signal?.aborted || aiError.kind === 'aborted') {
          yield { type: 'done', finishReason: 'aborted', partial: true };
          return { kind: 'aborted' as const };
        }
        // 仅「可重试错误且尚未产生内容」才允许重试 / 触发容灾切换；
        // 已吐出内容再重试会造成重复输出；不可重试错误（401 / 上下文超限 / 内容过滤）重试无意义。
        const switchable = shouldRetry(aiError) && !emittedContent;
        if (!switchable || attempt === this.retryPolicy.maxRetries) {
          return { kind: 'fatal' as const, error: aiError, switchable };
        }
      } finally {
        release?.();
      }
    }
    return {
      kind: 'fatal' as const,
      error: toAiError(new Error('重试次数已用尽'), { providerId: provider.id }),
      switchable: true,
    };
  }

  private async *streamOnce(
    adapter: ProviderAdapter,
    provider: Provider,
    model: Model,
    request: GatewayChatRequest,
    onChunk: (chunk: StreamChunk) => void,
  ): AsyncGenerator<StreamChunk, { usage: Usage | null; latencyMs: number }, void> {
    const apiKey = await this.deps.providers.getApiKey(provider.id);
    const context: AdapterContext = {
      transport: this.deps.transport,
      apiKey,
      ...(this.proxy ? { proxy: this.proxy } : {}),
      timeoutMs: provider.timeoutMs,
    };

    const started = Date.now();
    let usage: Usage | null = null;

    const chunks = adapter.chat(
      {
        provider,
        model: model.name,
        messages: request.messages,
        ...(request.tools ? { tools: request.tools } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      },
      context,
    );

    let recorded = false;
    const recordUsage = (): void => {
      if (recorded) return;
      recorded = true;
      if (!usage) usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      this.deps.failover.recordSuccess(provider.id);
      this.deps.usage.record({
        userId: request.userId,
        providerId: provider.id,
        modelId: model.id,
        projectId: request.projectId ?? null,
        purpose: request.purpose,
        usage,
        price: {
          inputPricePerMTok: model.capability.inputPricePerMTok,
          outputPricePerMTok: model.capability.outputPricePerMTok,
        },
        latencyMs: Date.now() - started,
      });
    };

    for await (const chunk of chunks) {
      if (chunk.type === 'usage') usage = mergeUsage(usage, chunk.usage);
      if (chunk.type === 'done') {
        // 下游 collect() 会在 done 后立即关闭生成器；必须在让出终止帧前落库。
        recordUsage();
      }
      onChunk(chunk);
      if (chunk.type === 'done') recordUsage();
      yield chunk;
      if (chunk.type === 'error') throw chunk.error;
    }

    recordUsage();
    return { usage, latencyMs: Date.now() - started };
  }

  /**
   * 向量化（T2-03 双路召回的语义路来源）。
   *
   * 与 chat 的差异：**失败不是异常而是返回值**。
   * 记忆检索属于可降级能力，任何不可用情形都返回 `{ ok: false, reason }`，
   * 由调用方切换为纯关键词检索，绝不阻塞用户操作。
   */
  async embed(request: GatewayEmbeddingRequest): Promise<EmbeddingOutcome> {
    const inputs = request.inputs.filter((text) => text.trim().length > 0);
    if (inputs.length === 0) return embeddingUnavailable('failed', '没有需要向量化的文本');

    const model = this.resolveModelFor(request.userId, 'embedding', request.modelId ?? null);
    if (!model) {
      return embeddingUnavailable(
        'not-configured',
        '尚未配置向量化模型：请在「设置 → 模型服务」为「向量检索」用途绑定一个支持 /embeddings 的模型，否则检索将只用关键词',
      );
    }

    const provider = request.providerId
      ? this.deps.providers.findById(request.providerId)
      : this.deps.providers.findById(model.providerId);
    if (!provider || !provider.enabled) {
      return embeddingUnavailable(
        'not-configured',
        '向量化所用的模型服务已被停用，检索暂时只用关键词',
      );
    }
    if (provider.protocol !== 'openai') {
      return embeddingUnavailable(
        'unsupported-protocol',
        `${provider.name} 使用 Anthropic 协议，不提供向量化接口；请为「向量检索」绑定一个 OpenAI 兼容模型`,
      );
    }
    // 仅当用户显式标注「不支持」时才跳过尝试；默认（未标注）仍会探测一次
    if (model.capability.supportsEmbedding === false && model.capability.manualOverride) {
      return embeddingUnavailable(
        'unsupported-model',
        `模型 ${model.name} 已被标注为不支持向量化，检索只用关键词`,
      );
    }

    const decision = this.deps.budget.check();
    if (!decision.ok) {
      return embeddingUnavailable('failed', `已超出用量预算，向量化已跳过：${decision.message}`);
    }

    const apiKey = await this.deps.providers.getApiKey(provider.id);
    const context: AdapterContext = {
      transport: this.deps.transport,
      apiKey,
      ...(this.proxy ? { proxy: this.proxy } : {}),
      timeoutMs: provider.timeoutMs,
    };

    const started = Date.now();
    const outcome = await embedWithOpenAi({
      provider,
      model,
      inputs,
      context,
      ...(request.dimensions !== undefined ? { dimensions: request.dimensions } : {}),
    });
    if (!outcome.ok) return outcome;

    this.deps.usage.record({
      userId: request.userId,
      providerId: provider.id,
      modelId: model.id,
      projectId: request.projectId ?? null,
      purpose: 'embedding',
      usage: {
        promptTokens: outcome.usage?.promptTokens ?? 0,
        completionTokens: 0,
        totalTokens: outcome.usage?.totalTokens ?? 0,
      },
      price: {
        inputPricePerMTok: model.capability.inputPricePerMTok,
        outputPricePerMTok: model.capability.outputPricePerMTok,
      },
      latencyMs: Date.now() - started,
    });

    return { ...outcome, latencyMs: Date.now() - started };
  }

  /* --------------------------- 连接测试与模型 --------------------------- */
  async testConnection(providerId: string): Promise<ConnectionTestResult> {
    const provider = this.deps.providers.findById(providerId);
    if (!provider) {
      return {
        ok: false,
        models: { models: [], source: 'manual' },
        latencyMs: 0,
        error: new ProviderUnavailableError('Provider 不存在', { retryable: false }),
      };
    }
    const apiKey = await this.deps.providers.getApiKey(providerId);
    const context: AdapterContext = {
      transport: this.deps.transport,
      apiKey,
      ...(this.proxy ? { proxy: this.proxy } : {}),
      timeoutMs: provider.timeoutMs,
    };
    return runConnectionTest(this.deps.adapterFor(provider.protocol), provider, context);
  }

  /** 拉取远端模型并落库（保护人工修正项） */
  async refreshModels(providerId: string): Promise<ModelDiscovery> {
    const provider = this.deps.providers.findById(providerId);
    if (!provider) throw new ProviderUnavailableError('Provider 不存在', { retryable: false });
    const apiKey = await this.deps.providers.getApiKey(providerId);
    const context: AdapterContext = {
      transport: this.deps.transport,
      apiKey,
      ...(this.proxy ? { proxy: this.proxy } : {}),
      timeoutMs: provider.timeoutMs,
    };
    const discovery = await this.deps.adapterFor(provider.protocol).listModels(provider, context);
    this.deps.models.upsertDiscovered(providerId, discovery);
    return discovery;
  }

  async testProxy(target?: { host: string; port?: number }): Promise<ProxyTestResult> {
    if (!this.proxy) return { ok: false, latencyMs: 0, message: '未配置代理' };
    return testProxyConnectivity(this.proxy, target);
  }

  /* ------------------------------ 内部 ------------------------------ */

  private resolveModel(request: GatewayChatRequest): Model | null {
    return this.resolveModelFor(request.userId, request.purpose, request.modelId ?? null);
  }

  /**
   * 用途 → 绑定 → 模型的统一解析（chat 与 embed 共用）。
   * 兜底顺序：显式指定 → 用途绑定 → 默认模型 → 第一个启用 Provider 的第一个模型。
   */
  private resolveModelFor(
    userId: string,
    purpose: AiPurpose,
    explicitModelId: string | null,
  ): Model | null {
    if (explicitModelId) {
      const explicit = this.deps.models.findById(explicitModelId);
      if (explicit) return explicit;
    }
    const binding = this.deps.bindings.get(userId);
    const modelId = resolveModelId(binding, purpose);
    if (modelId) {
      const bound = this.deps.models.findById(modelId);
      if (bound) return bound;
    }
    // 兜底：第一个启用 Provider 的第一个模型
    const providers = this.deps.providers.list(userId, { enabledOnly: true });
    for (const provider of providers) {
      const models = this.deps.models.list(provider.id);
      if (models[0]) return models[0];
    }
    return null;
  }

  /** 候选 Provider：首选模型所属的，其余按 sort_order 兜底 */
  private candidatesFor(
    model: Model,
    userId: string,
    preferredId: string | null,
  ): Array<{ provider: Provider; model: Model }> {
    const owner = this.deps.providers.findById(model.providerId);
    const all = this.deps.providers.list(owner?.userId ?? userId, { enabledOnly: true });
    const preferred = preferredId ? all.find((provider) => provider.id === preferredId) : undefined;
    const ordered = [
      preferred,
      owner,
      ...all.filter((provider) => provider.id !== owner?.id && provider.id !== preferredId),
    ]
      .filter((provider): provider is Provider => Boolean(provider))
      .filter((provider) => !this.deps.failover.isDegraded(provider.id))
      .sort((a, b) => a.order - b.order);
    return ordered
      .map((provider) => {
        const selected =
          provider.id === model.providerId ? model : this.deps.models.list(provider.id)[0];
        return selected ? { provider, model: selected } : null;
      })
      .filter((item): item is { provider: Provider; model: Model } => Boolean(item));
  }

  private emit(event: GatewayEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

type AttemptOutcome =
  | { kind: 'success'; result: { usage: Usage | null; latencyMs: number } }
  | { kind: 'aborted' }
  | { kind: 'fatal'; error: AiError; switchable: boolean };

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('请求已中断'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('请求已中断'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
