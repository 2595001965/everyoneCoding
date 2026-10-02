import {
  normalizeProtocolUsage,
  replaceEstimateWithFinal,
  type NormalizedUsage,
  type ProtocolUsageReport,
} from '@ec/core';
import { estimateTokens, type Usage } from './usage';

/** 协议适配器声明口径，不能用逐字段 max 把最终更正吞掉。 */
export interface MeteringUpdate {
  report: Partial<ProtocolUsageReport>;
  mode: 'snapshot' | 'delta';
  final: boolean;
  raw: unknown;
  providerRequestId?: string;
  /** 只有协议提供稳定事件身份时才填；request ID 不能充当事件 ID。 */
  eventId?: string;
}

export function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export const unknownUsage = (): NormalizedUsage => ({
  totalInput: null, uncachedInput: null, cacheReadInput: null, cacheWriteInputByTtl: null,
  totalOutput: null, reasoningOutput: null, quality: 'unknown',
});

/** 请求正文不进入计量记录；原始 usage 仅保留脱敏的计量字段。 */
export function safeRawUsage(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeRawUsage);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) =>
      !/(key|secret|authorization|cookie|password|header|prompt|content)/i.test(key),
    ).map(([key, child]) => [key, safeRawUsage(child)]));
  }
  return typeof value === 'string' ? '[redacted]' : value;
}

/** 一次实际上游尝试的流状态；估算按累计文本计算，绝不按 chunk 数计算。 */
export class UsageAccumulator {
  private report: ProtocolUsageReport = {
    inputIncludesCache: true, inputTokens: null, cacheReadTokens: null,
    cacheWriteTokensByTtl: null, outputTokens: null,
    reasoningTokensIncludedInOutput: true, reasoningTokens: null,
  };
  private readonly seen = new Set<string>();
  private outputText = '';
  private hasReport = false;
  private final = false;
  private raw: unknown[] = [];
  providerRequestId: string | null = null;

  constructor(private readonly inputEstimate: number | null = null) {}

  output(text: string): void { this.outputText += text; }

  accept(update: MeteringUpdate): boolean {
    if (update.eventId && this.seen.has(update.eventId)) return false;
    if (this.final && !update.final) return false;
    if (update.eventId) this.seen.add(update.eventId);
    const before = JSON.stringify(this.report);
    const wasFinal = this.final;
    const next = update.report;
    for (const field of ['inputTokens', 'cacheReadTokens', 'outputTokens', 'reasoningTokens'] as const) {
      if (!(field in next)) continue;
      const incoming = tokenCount(next[field]);
      const current = this.report[field];
      this.report[field] = update.mode === 'delta' && incoming !== null
        ? (current ?? 0) + incoming : incoming;
    }
    if (next.inputIncludesCache !== undefined) this.report.inputIncludesCache = next.inputIncludesCache;
    if (next.reasoningTokensIncludedInOutput !== undefined) {
      this.report.reasoningTokensIncludedInOutput = next.reasoningTokensIncludedInOutput;
    }
    if ('cacheWriteTokensByTtl' in next) {
      const buckets = next.cacheWriteTokensByTtl;
      if (buckets === null || buckets === undefined) this.report.cacheWriteTokensByTtl = null;
      else {
        const valid = Object.values(buckets).every((n) => tokenCount(n) !== null);
        if (!valid) this.report.cacheWriteTokensByTtl = null;
        else if (update.mode === 'snapshot') this.report.cacheWriteTokensByTtl = { ...buckets };
        else {
          const merged = { ...this.report.cacheWriteTokensByTtl };
          for (const [ttl, tokens] of Object.entries(buckets)) merged[ttl] = (merged[ttl] ?? 0) + tokens;
          this.report.cacheWriteTokensByTtl = merged;
        }
      }
    }
    this.hasReport = true;
    this.final = update.final;
    if (update.providerRequestId) this.providerRequestId = update.providerRequestId;
    const changed = before !== JSON.stringify(this.report) || wasFinal !== this.final;
    if (changed) this.raw.push(safeRawUsage(update.raw));
    return changed;
  }

  /** 旧第三方适配器只提供三字段时，缓存保持未知。 */
  acceptLegacy(usage: Usage): void {
    this.accept({ report: { inputIncludesCache: true, inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens }, mode: 'snapshot', final: true, raw: usage });
  }

  snapshot(): NormalizedUsage {
    if (!this.hasReport) return {
      ...unknownUsage(), totalInput: this.inputEstimate,
      totalOutput: this.outputText.length > 0 ? estimateTokens(this.outputText).tokens : null,
      quality: this.outputText.length > 0 ? 'stream_estimate' : 'unknown',
    };
    const usage = normalizeProtocolUsage(this.report);
    // input 不含缓存的协议：缺少任一缓存维度不能把缺失贡献压成 0。
    if (!this.report.inputIncludesCache &&
      (this.report.cacheReadTokens === null || this.report.cacheWriteTokensByTtl === null)) {
      usage.totalInput = null;
    }
    // 缓存拆分/推理子集自相矛盾时只保留可靠总量。
    if (usage.uncachedInput !== null && usage.uncachedInput < 0) {
      usage.uncachedInput = null; usage.cacheReadInput = null; usage.cacheWriteInputByTtl = null;
    }
    if (usage.reasoningOutput !== null && usage.totalOutput !== null && usage.reasoningOutput > usage.totalOutput) {
      usage.reasoningOutput = null;
    }
    usage.quality = this.final ? 'upstream_final' : 'stream_estimate';
    if (!this.final && usage.totalOutput === null && this.outputText.length > 0) {
      usage.totalOutput = estimateTokens(this.outputText).tokens;
    }
    return this.final ? replaceEstimateWithFinal(unknownUsage(), usage) : usage;
  }

  rawUsage(): unknown { return this.hasReport ? this.raw : null; }
  hasFinal(): boolean { return this.final; }
  hasMeasuredUsage(): boolean { return this.hasReport; }
  hasReportedOutput(): boolean { return this.report.outputTokens !== null; }
}
