import { mask, type Logger, type PriceVersion, type V2EventEnvelope } from '@ec/core';
import { newUlid } from '@ec/data';

import type { AdapterContext, ProviderAdapter } from '../core/adapter';
import type { ChatMessage } from '../core/message';
import type { FinishReason, StreamChunk } from '../core/stream';
import type { ToolDefinition } from '../core/tool';
import type { Usage } from '../core/usage';
import { estimateTokens } from '../core/usage';
import {
  ContextLengthError,
  ProviderUnavailableError,
  toAiError,
  type AiError,
} from '../core/error';
import type { HttpTransport, ProxyConfig } from '../core/http';
import { runConnectionTest } from '../core/connection-test';
import type { ConnectionTestResult } from '../core/adapter';
import { embeddingUnavailable, type EmbeddingOutcome } from '../core/embedding';
import type { Model, ModelDiscovery } from '../domain/model';
import type { Protocol, Provider } from '../domain/provider';
import {
  normalizePurpose,
  normalizeUsagePurpose,
  resolveModelId,
  type AiPurpose,
} from '../domain/purpose-binding';
import { AttemptRuntime } from './attempt-runtime';
import type { AttemptContext } from './metering-record';
import { DEFAULT_MAX_TOKENS } from '../adapters/anthropic/request-map';
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
import type { GatewayExecutionControl } from '../agent/gateway-control';

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
  adapterFor: (protocol: Protocol, provider?: Provider) => ProviderAdapter;
  /** Hosted platform Providers use the account access token, never a BYOK key reference. */
  resolveApiKey?: (provider: Provider) => Promise<string | null>;
  proxy?: ProxyConfig | null;
  logger?: Logger | null;
  retry?: Partial<RetryPolicy>;
  budgetConfig?: Partial<BudgetConfig>;
  failoverPolicy?: Partial<FailoverPolicy>;
  /** D10 可注入版本化价格；每次真正尝试受理时固定快照。 */
  priceFor?: (model: Model, at: number) => PriceVersion | null;
  execution?: GatewayExecutionControl;
}

export interface GatewayChatRequest {
  userId: string;
  /** 标准用途；业务侧别名（如 `commit-message`）在入口经 `normalizePurpose` 归一 */
  purpose: string;
  messages: ChatMessage[];
  projectId?: string | null;
  tools?: ToolDefinition[];
  /** 覆盖用途绑定的模型（调试与一次性切换用） */
  modelId?: string | null;
  providerId?: string | null;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  logicalRequestId?: string;
  sessionId?: string | null;
  taskId?: string | null;
  contextSafetyMarginTokens?: number;
  stream?: boolean;
  /** Created inside the gateway for each real attempt; never supplied by the renderer. */
  attemptIdempotencyKey?: string;
}

/** The assembled next payload and route overrides needed for a transient preview. */
export type GatewayContextPreviewRequest = Pick<
  GatewayChatRequest,
  | 'purpose'
  | 'messages'
  | 'tools'
  | 'modelId'
  | 'providerId'
  | 'maxTokens'
  | 'contextSafetyMarginTokens'
>;

export interface GatewayEmbeddingRequest {
  userId: string;
  inputs: readonly string[];
  projectId?: string | null;
  /** 覆盖「向量检索」用途绑定 */
  modelId?: string | null;
  providerId?: string | null;
  dimensions?: number | null;
  logicalRequestId?: string;
  sessionId?: string | null;
  taskId?: string | null;
}

export type GatewayEvent =
  | { type: 'metering'; event: V2EventEnvelope }
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
      if (event.type === 'attempt-updated') this.emit({ type: 'metering', event: event.event });
      else if (event.type === 'budget-exceeded') {
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

  /** Draft connection tests have no persisted model route, but their writes still use the coordinator fence. */
  withExecutionOwner<T>(operation: () => Promise<T>): Promise<T> {
    return this.deps.execution ? this.deps.execution.withOwner(operation) : operation();
  }

  /* ------------------------------ 对话 ------------------------------ */

  async *chat(input: GatewayChatRequest): AsyncIterable<StreamChunk> {
    // 用途归一：绑定解析、用量落库、事件上报都用同一个标准用途
    const request: GatewayChatRequest = {
      ...input,
      purpose: normalizeUsagePurpose(input.purpose),
      logicalRequestId: input.logicalRequestId ?? newUlid(),
    };
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
      // 容灾关闭时照常计数（UI 仍能看到连续失败），但不切备用。
      const shouldSwitch = this.deps.failover.recordFailure(
        candidate.provider.id,
        mask(outcome.error.message),
      );
      if (!shouldSwitch || !this.deps.failover.enabled()) break;

      const next = candidates.find(
        (item) =>
          item.provider.id !== candidate.provider.id &&
          !this.deps.failover.isDegraded(item.provider.id),
      );
      if (!next) break;
      const reason = mask(outcome.error.message);
      this.deps.failover.notifySwitch(candidate.provider.id, next.provider.id, reason);
      this.deps.logger?.warn('模型服务故障，切换备用', {
        from: candidate.provider.name,
        to: next.provider.name,
        reason,
      });
      this.emit({
        type: 'failover',
        fromProviderId: candidate.provider.id,
        toProviderId: next.provider.id,
        reason,
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
    const adapter = this.deps.adapterFor(provider.protocol, provider);
    this.emit({
      type: 'provider-selected',
      providerId: provider.id,
      providerName: provider.name,
      modelName: model.name,
      purpose: normalizePurpose(request.purpose),
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
        try {
          await sleep(delayMs, request.signal);
        } catch {
          yield { type: 'done', finishReason: 'aborted', partial: true };
          return { kind: 'aborted' as const };
        }
      }

      const ticket = Symbol('ai-request');
      const queuedAt = Date.now();
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
        const currentBudget = this.deps.budget.check();
        if (!currentBudget.ok) {
          this.emit({ type: 'budget-exceeded', message: currentBudget.message });
          throw new ProviderUnavailableError(currentBudget.message, { retryable: false });
        }
        const attemptRequest = { ...request, attemptIdempotencyKey: newUlid() };
        const result = yield* this.streamOnce(
          adapter,
          provider,
          model,
          attemptRequest,
          Date.now() - queuedAt,
          (chunk) => {
            if (chunk.type === 'delta' || chunk.type === 'tool_call') emittedContent = true;
          },
        );
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
        // 无 HTTP 拒绝证据的超时/断流可能已经执行，禁止自动重发。
        const switchable = shouldRetry(aiError) && !emittedContent && aiError.status !== undefined;
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
    queuedMs: number,
    onChunk: (chunk: StreamChunk) => void,
  ): AsyncGenerator<StreamChunk, { usage: Usage | null; latencyMs: number }, void> {
    const permit = await this.deps.execution?.acquire(request, provider, model);
    let known = false;
    try {
      const result = yield* this.streamMetered(
        adapter,
        provider,
        model,
        permit ? { ...request, signal: permit.signal } : request,
        queuedMs,
        (chunk) => {
          permit?.assertOwner();
          if (chunk.type === 'done' && !chunk.partial) known = true;
          onChunk(chunk);
        },
      );
      return result;
    } catch (error) {
      // A definite HTTP rejection can release the allowance; a lost stream cannot.
      const mapped = toAiError(error);
      if (mapped.status !== undefined && mapped.status < 500) known = true;
      throw error;
    } finally {
      permit?.finish(known);
    }
  }

  private async *streamMetered(
    adapter: ProviderAdapter,
    provider: Provider,
    model: Model,
    request: GatewayChatRequest,
    queuedMs: number,
    onChunk: (chunk: StreamChunk) => void,
  ): AsyncGenerator<StreamChunk, { usage: Usage | null; latencyMs: number }, void> {
    const apiKey = this.deps.resolveApiKey
      ? await this.deps.resolveApiKey(provider)
      : await this.deps.providers.getApiKey(provider.id);
    const context: AdapterContext = {
      transport: this.deps.transport,
      apiKey,
      ...(this.proxy ? { proxy: this.proxy } : {}),
      timeoutMs: provider.timeoutMs,
    };

    const started = Date.now();
    const contextSnapshot = this.estimateContext(adapter, provider, model, request);
    if (
      contextSnapshot.routeWindowTokens !== null &&
      contextSnapshot.estimatedNextInputTokens !== null &&
      contextSnapshot.estimatedNextInputTokens +
        (contextSnapshot.reservedOutputTokens ?? 0) +
        (contextSnapshot.safetyMarginTokens ?? 0) >
        contextSnapshot.routeWindowTokens
    ) {
      throw new ContextLengthError(
        '有效输入、预留输出和安全余量超出该路由窗口',
        contextSnapshot.routeWindowTokens,
      );
    }
    if (request.signal?.aborted) {
      yield { type: 'done', finishReason: 'aborted', partial: true };
      return { usage: null, latencyMs: 0 };
    }
    const metering = new AttemptRuntime(this.deps.usage, {
      userId: request.userId,
      logicalRequestId: request.logicalRequestId!,
      providerId: provider.id,
      model,
      upstreamModelName: model.name,
      protocol: provider.protocol,
      purpose: request.purpose,
      projectId: request.projectId ?? null,
      sessionId: request.sessionId ?? null,
      taskId: request.taskId ?? null,
      queuedMs,
      context: contextSnapshot,
      price: this.deps.priceFor?.(model, started) ?? null,
    });

    const chunks = adapter.chat(
      {
        provider,
        model: model.name,
        messages: request.messages,
        ...(request.tools ? { tools: request.tools } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
        ...(request.stream !== undefined ? { stream: request.stream } : {}),
        ...(request.attemptIdempotencyKey ? { idempotencyKey: request.attemptIdempotencyKey } : {}),
        ...(request.logicalRequestId ? { logicalRequestId: request.logicalRequestId } : {}),
      },
      context,
    );

    let finished = false;
    try {
      for await (const chunk of chunks) {
        if (chunk.type === 'delta') metering.output(chunk.text);
        if (chunk.type === 'tool_call')
          metering.output((chunk.delta.name ?? '') + (chunk.delta.argumentsDelta ?? ''));
        if (chunk.type === 'usage') metering.usage(chunk.metering, chunk.usage);
        if (chunk.type === 'error') throw chunk.error;
        if (chunk.type === 'done') {
          metering.finish(chunk.finishReason, chunk.partial);
          finished = true;
          if (!chunk.partial) this.deps.failover.recordSuccess(provider.id);
        }
        onChunk(chunk);
        yield chunk;
        if (chunk.type === 'done') break;
      }
    } catch (error) {
      const mapped = toAiError(error, { providerId: provider.id, modelId: model.id });
      metering.finish(
        request.signal?.aborted || mapped.kind === 'aborted' ? 'aborted' : 'error',
        true,
        mapped,
      );
      finished = true;
      throw mapped;
    } finally {
      if (!finished) metering.finish(request.signal?.aborted ? 'aborted' : 'stop', true);
    }
    const usage = metering.current().normalized;
    return {
      usage:
        usage?.totalInput != null && usage.totalOutput != null
          ? {
              promptTokens: usage.totalInput,
              completionTokens: usage.totalOutput,
              totalTokens: usage.totalInput + usage.totalOutput,
            }
          : null,
      latencyMs: Date.now() - started,
    };
  }

  private estimateContext(
    adapter: ProviderAdapter,
    provider: Provider,
    model: Model,
    request: GatewayChatRequest,
  ): AttemptContext {
    const estimate = adapter.countTokens(request.messages, model);
    const tools = request.tools?.length
      ? estimateTokens(JSON.stringify(request.tools))
      : { tokens: 0, margin: 0 };
    const hasImage = request.messages.some(
      (message) =>
        Array.isArray(message.content) && message.content.some((block) => block.type === 'image'),
    );
    return {
      kind: 'sent_estimate',
      computedAt: Date.now(),
      estimatedNextInputTokens: hasImage ? null : estimate.tokens + tools.tokens,
      routeWindowTokens: model.capability.contextWindow,
      reservedOutputTokens:
        request.maxTokens ?? (provider.protocol === 'anthropic' ? DEFAULT_MAX_TOKENS : null),
      safetyMarginTokens: request.contextSafetyMarginTokens ?? estimate.margin + tools.margin,
      measuredSentInputTokens: null,
    };
  }

  /** 下一请求按当前载荷和当前实际候选路由重算，不复用上一轮实测输入。 */
  previewContext(
    request: GatewayContextPreviewRequest & Pick<GatewayChatRequest, 'userId'>,
  ): AttemptContext | null {
    const model = this.resolveModel(request);
    if (!model) return null;
    const candidate = this.candidatesFor(model, request.userId, request.providerId ?? null)[0];
    if (!candidate) return null;
    return {
      ...this.estimateContext(
        this.deps.adapterFor(candidate.provider.protocol, candidate.provider),
        candidate.provider,
        candidate.model,
        request,
      ),
      kind: 'next_request_estimate',
    };
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
    const estimate = estimateTokens(inputs.join('\n'));
    const metering = new AttemptRuntime(this.deps.usage, {
      userId: request.userId,
      logicalRequestId: request.logicalRequestId ?? newUlid(),
      providerId: provider.id,
      model,
      upstreamModelName: model.name,
      protocol: provider.protocol,
      purpose: 'embedding',
      projectId: request.projectId ?? null,
      sessionId: request.sessionId ?? null,
      taskId: request.taskId ?? null,
      context: {
        kind: 'sent_estimate',
        computedAt: started,
        estimatedNextInputTokens: estimate.tokens,
        routeWindowTokens: model.capability.contextWindow,
        reservedOutputTokens: 0,
        safetyMarginTokens: estimate.margin,
        measuredSentInputTokens: null,
      },
      price: this.deps.priceFor?.(model, started) ?? null,
    });
    let outcome: EmbeddingOutcome;
    try {
      outcome = await embedWithOpenAi({
        provider,
        model,
        inputs,
        context,
        ...(request.dimensions !== undefined ? { dimensions: request.dimensions } : {}),
        onUsage: (update) =>
          metering.usage(update, { promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
      });
    } catch (error) {
      metering.finish('error', true, toAiError(error));
      return embeddingUnavailable('failed', '向量化响应读取失败');
    }
    metering.finish(outcome.ok ? 'stop' : 'error', !outcome.ok);
    if (!outcome.ok) return outcome;

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
    const adapter = this.deps.adapterFor(provider.protocol, provider);
    return runConnectionTest(adapter, provider, context, (chat, discovery) => {
      this.deps.models.upsertDiscovered(provider.id, discovery);
      const target =
        this.deps.models.findByName(provider.id, chat.model) ??
        this.deps.models.create(provider.id, chat.model);
      return this.streamOnce(
        adapter,
        provider,
        target,
        {
          ...chat,
          userId: provider.userId,
          providerId: provider.id,
          purpose: 'connection-test',
          logicalRequestId: newUlid(),
        },
        0,
        () => {},
      );
    });
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
    const discovery = await this.deps
      .adapterFor(provider.protocol, provider)
      .listModels(provider, context);
    this.deps.models.upsertDiscovered(providerId, discovery);
    return discovery;
  }

  async testProxy(target?: { host: string; port?: number }): Promise<ProxyTestResult> {
    if (!this.proxy) return { ok: false, latencyMs: 0, message: '未配置代理' };
    return testProxyConnectivity(this.proxy, target);
  }

  /**
   * 某用途实际会用到的模型（与 chat 同一条解析链）。
   *
   * 上下文组装据此取「绑定模型的上下文窗口」作 token 预算，UI 据此判断
   * 「是否已配置可用模型」并给出引导——两处都不能自己再写一套选模型逻辑。
   */
  describeModel(
    userId: string,
    purpose: string,
    explicitModelId: string | null = null,
  ): {
    modelId: string;
    modelName: string;
    providerId: string;
    providerName: string;
    contextWindow: number | null;
  } | null {
    const model = this.resolveModelFor(userId, normalizePurpose(purpose), explicitModelId);
    if (!model) return null;
    const provider = this.deps.providers.findById(model.providerId);
    if (!provider) return null;
    return {
      modelId: model.id,
      modelName: model.name,
      providerId: provider.id,
      providerName: provider.name,
      contextWindow: model.capability.contextWindow ?? null,
    };
  }

  /* ------------------------------ 内部 ------------------------------ */

  private resolveModel(request: GatewayChatRequest): Model | null {
    return this.resolveModelFor(
      request.userId,
      normalizePurpose(request.purpose),
      request.modelId ?? null,
    );
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
    // 顺序＝显式指定 → 绑定模型所属 → 其余按 sort_order。
    // 只对「其余」排序：此前对整个列表排序，绑定模型所在的 Provider 只要不是
    // order 最小的那个，就会被排到后面——用途绑定形同虚设，首发请求打到别家的第一个模型。
    const head = [preferred, owner].filter((provider): provider is Provider =>
      Boolean(provider && provider.enabled),
    );
    const rest = all
      .filter((provider) => !head.some((item) => item.id === provider.id))
      .sort((a, b) => a.order - b.order);
    const ordered = [...new Map([...head, ...rest].map((p) => [p.id, p])).values()].filter(
      (provider) => !this.deps.failover.isDegraded(provider.id),
    );
    return ordered
      .map((provider) => {
        const selected =
          provider.id === model.providerId ? model : this.deps.models.list(provider.id)[0];
        return selected ? { provider, model: selected } : null;
      })
      .filter((item): item is { provider: Provider; model: Model } => Boolean(item));
  }

  /** 事件出口统一脱敏：原因文本可能回显服务端报文（含 Key），监听方拿到的一律是打码后的 */
  private emit(event: GatewayEvent): void {
    const safe = sanitizeEvent(event);
    for (const listener of this.listeners) listener(safe);
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

function sanitizeEvent(event: GatewayEvent): GatewayEvent {
  switch (event.type) {
    case 'retry':
    case 'failover':
      return { ...event, reason: mask(event.reason) };
    case 'budget-exceeded':
    case 'budget-warning':
      return { ...event, message: mask(event.message) };
    default:
      return event;
  }
}
