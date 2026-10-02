import type { PriceVersion } from '@ec/core';
import { UsageAccumulator, type MeteringUpdate } from '../core/metering';
import { estimateTokens, type Usage } from '../core/usage';
import type { FinishReason } from '../core/stream';
import type { AiError } from '../core/error';
import type { Model } from '../domain/model';
import { persistentRouteKeyOf, routeOfModel } from '../domain/model-route';
import { capturePrice, type AttemptContext, type MeteredAttempt } from './metering-record';
import type { UsageTracker } from './usage-tracker';

export interface AttemptInput {
  userId: string;
  logicalRequestId: string;
  providerId: string | null;
  model: Model | null;
  upstreamModelName: string;
  protocol: 'openai' | 'anthropic';
  purpose: string;
  sessionId?: string | null;
  taskId?: string | null;
  projectId?: string | null;
  queuedMs?: number;
  context: AttemptContext;
  price?: PriceVersion | null;
}

/** chat、连接测试、embedding 共用的生命周期；每次真正发送创建一个实例。 */
export class AttemptRuntime {
  private readonly accumulator: UsageAccumulator;
  private attempt: MeteredAttempt;
  private readonly samples: Array<{ at: number; tokens: number }> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private outputText = '';
  private firstOutputAt: number | null = null;

  constructor(
    private readonly tracker: UsageTracker,
    input: AttemptInput,
  ) {
    const startedAt = Date.now();
    const route = input.model ? persistentRouteKeyOf(routeOfModel(input.model)) : null;
    const priceSnapshot = capturePrice(route, input.model, startedAt, input.price);
    this.accumulator = new UsageAccumulator(input.context.estimatedNextInputTokens);
    this.attempt = tracker.beginAttempt({
      userId: input.userId,
      logicalRequestId: input.logicalRequestId,
      providerId: input.providerId,
      modelRowId: input.model?.id ?? null,
      upstreamModelName: input.upstreamModelName,
      protocol: input.protocol,
      route,
      routeUnavailableReason: route
        ? null
        : input.providerId
          ? 'missing_model_row'
          : 'unsaved_draft',
      sessionId: input.sessionId ?? null,
      taskId: input.taskId ?? null,
      projectId: input.projectId ?? null,
      purpose: input.purpose,
      startedAt,
      endedAt: null,
      status: 'streaming',
      usageSource: 'unknown',
      rawUsage: null,
      normalized: null,
      providerRequestId: null,
      context: input.context,
      priceSnapshotRef: priceSnapshot?.snapshotId ?? null,
      priceSnapshot,
      metrics: {
        queuedMs: input.queuedMs ?? 0,
        firstOutputAt: null,
        ttftMs: null,
        outputTokensPerSecond: null,
        averageOutputTokensPerSecond: null,
        rateSource: 'unknown',
        toolExecutionMs: null,
      },
      billingState: 'unknown_pending_reconciliation',
    });
    this.samples.push({ at: startedAt, tokens: 0 });
    this.timer = setInterval(() => {
      if (this.closed) return;
      try {
        this.publish();
      } catch {
        if (this.timer) clearInterval(this.timer);
      }
    }, 1000);
    this.timer.unref?.();
  }

  output(text: string): void {
    if (!text || this.closed) return;
    this.firstOutputAt ??= Date.now();
    this.outputText += text;
    this.accumulator.output(text);
  }

  usage(update: MeteringUpdate | undefined, legacy: Usage): void {
    if (this.closed) return;
    if (update ? this.accumulator.accept(update) : (this.accumulator.acceptLegacy(legacy), true))
      this.publish();
  }

  finish(reason: FinishReason, partial: boolean, error?: AiError): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    const normalized = this.accumulator.snapshot();
    const uncertain =
      !this.accumulator.hasFinal() &&
      (partial ||
        reason === 'aborted' ||
        reason === 'error' ||
        !this.accumulator.hasMeasuredUsage());
    const status =
      reason === 'aborted'
        ? 'cancelled'
        : uncertain && (!error?.status || this.accumulator.hasMeasuredUsage())
          ? 'unknown_pending_reconciliation'
          : reason === 'error'
            ? 'failed'
            : 'succeeded';
    this.publish({
      endedAt: Date.now(),
      status,
      normalized: this.accumulator.hasMeasuredUsage() || this.outputText.length ? normalized : null,
      billingState:
        uncertain || normalized.totalInput === null || normalized.totalOutput === null
          ? 'unknown_pending_reconciliation'
          : 'estimated',
    });
  }

  current(): MeteredAttempt {
    return this.attempt;
  }

  private publish(patch: Partial<MeteredAttempt> = {}): void {
    const now = Date.now();
    const normalized = this.accumulator.snapshot();
    const tokens =
      normalized.totalOutput ??
      (this.outputText.length ? estimateTokens(this.outputText).tokens : null);
    if (tokens !== null) this.samples.push({ at: now, tokens });
    while (this.samples.length > 1 && this.samples[1]!.at < now - 5000) this.samples.shift();
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const elapsed = last && first ? last.at - Math.max(first.at, now - 5000) : 0;
    const avgElapsed = this.firstOutputAt === null ? 0 : now - this.firstOutputAt;
    const metrics = {
      ...this.attempt.metrics,
      firstOutputAt: this.firstOutputAt,
      ttftMs: this.firstOutputAt === null ? null : this.firstOutputAt - this.attempt.startedAt,
      outputTokensPerSecond:
        first && last && elapsed > 0 && tokens !== null
          ? Math.max(0, last.tokens - first.tokens) / (elapsed / 1000)
          : null,
      averageOutputTokensPerSecond:
        tokens !== null && avgElapsed > 0 ? tokens / (avgElapsed / 1000) : null,
      rateSource:
        tokens === null
          ? ('unknown' as const)
          : this.accumulator.hasReportedOutput()
            ? ('reported' as const)
            : ('estimated' as const),
    };
    const next = {
      ...this.attempt,
      normalized,
      usageSource: normalized.quality,
      rawUsage: this.accumulator.rawUsage(),
      providerRequestId: this.accumulator.providerRequestId,
      context: {
        ...this.attempt.context,
        measuredSentInputTokens:
          normalized.quality === 'upstream_final' ? normalized.totalInput : null,
      },
      metrics,
      ...patch,
    };
    if (next.normalized === null) next.usageSource = 'unknown';
    this.attempt = this.tracker.updateAttempt(next);
  }
}
