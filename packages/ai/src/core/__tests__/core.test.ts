import { describe, it, expect } from 'vitest';

import { collect, collectText, deltasOf, streamOf, type StreamChunk } from '../stream';
import {
  AuthError,
  RateLimitError,
  TimeoutError,
  ContextLengthError,
  ContentFilterError,
  ProtocolError,
  ProviderUnavailableError,
  AbortedError,
  isAiError,
  toAiError,
} from '../error';
import { computeCost, estimateTokens, usageOf, addUsage, formatCost } from '../usage';
import { accumulateToolCalls, parseToolArguments } from '../tool';

describe('统一错误模型', () => {
  it('七类错误均可构造，并带中文说明与可操作建议', () => {
    const errors = [
      new AuthError(),
      new RateLimitError('限流', 1500),
      new TimeoutError(),
      new ContextLengthError('超长', 8192),
      new ContentFilterError(),
      new ProtocolError(),
      new ProviderUnavailableError(),
    ];
    for (const error of errors) {
      expect(isAiError(error)).toBe(true);
      expect(error.userMessage.length).toBeGreaterThan(0);
      expect(error.action.length).toBeGreaterThan(0);
      expect(error.toJSON().kind).toBeTruthy();
    }
    expect(errors).toHaveLength(7);
  });

  it('可重试性与 PRD §13.3 一致：限流/超时/不可用可重试，其余不可', () => {
    expect(new RateLimitError().retryable).toBe(true);
    expect(new TimeoutError().retryable).toBe(true);
    expect(new ProviderUnavailableError().retryable).toBe(true);
    expect(new AuthError().retryable).toBe(false);
    expect(new ContextLengthError().retryable).toBe(false);
    expect(new ContentFilterError().retryable).toBe(false);
    expect(new ProtocolError().retryable).toBe(false);
    // 余额不足：重试无意义
    expect(new ProviderUnavailableError('余额不足', { retryable: false }).retryable).toBe(false);
  });

  it('返回片段自动脱敏：明文 Key 不进入错误信息', () => {
    const error = new ProtocolError('格式错误', {
      snippet: '{"error":{"message":"invalid api key sk-abcdefghijklmnopqrstuvwx"}}',
    });
    expect(error.snippet).toBeDefined();
    expect(error.snippet ?? '').not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(error.snippet ?? '').toContain('***');
  });

  it('未知异常按语义归类：中断 / 超时 / 网络 / 其他', () => {
    const aborted = new Error('canceled');
    aborted.name = 'AbortError';
    expect(toAiError(aborted).kind).toBe('aborted');
    expect(toAiError(new Error('socket hang up')).kind).toBe('timeout');
    expect(toAiError(new Error('fetch failed')).kind).toBe('provider_unavailable');
    expect(toAiError(new Error('weird')).kind).toBe('protocol');
    expect(new AbortedError().retryable).toBe(false);
  });
});

describe('流式重组', () => {
  it('delta 序列无损重组为完整消息', async () => {
    const chunks: StreamChunk[] = [
      ...deltasOf('你好，这是', 2),
      ...deltasOf('一段流式输出。', 3),
      { type: 'usage', usage: usageOf(10, 5) },
      { type: 'done', finishReason: 'stop', partial: false },
    ];
    const result = await collect(streamOf(chunks));
    expect(result.text).toBe('你好，这是一段流式输出。');
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    expect(result.partial).toBe(false);
    expect(result.finishReason).toBe('stop');
  });

  it('工具调用增量可按 index 累积并解析参数', async () => {
    const chunks: StreamChunk[] = [
      { type: 'tool_call', delta: { index: 0, id: 'call_1', name: 'get_weather' } },
      { type: 'tool_call', delta: { index: 0, argumentsDelta: '{"city":' } },
      { type: 'tool_call', delta: { index: 0, argumentsDelta: '"上海"}' } },
      { type: 'done', finishReason: 'tool_use', partial: false },
    ];
    const result = await collect(streamOf(chunks));
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toEqual({
      id: 'call_1',
      name: 'get_weather',
      arguments: { city: '上海' },
    });
    expect(result.finishReason).toBe('tool_use');
  });

  it('中断保留已生成内容并标记 partial', async () => {
    const chunks: StreamChunk[] = [
      { type: 'delta', text: '已生成部分' },
      { type: 'done', finishReason: 'aborted', partial: true },
    ];
    const result = await collect(streamOf(chunks));
    expect(result.text).toBe('已生成部分');
    expect(result.partial).toBe(true);
    expect(result.finishReason).toBe('aborted');
  });

  it('错误 chunk 立即终止并记录错误', async () => {
    const error = new AuthError();
    const result = await collect(
      streamOf([
        { type: 'delta', text: 'x' },
        { type: 'error', error },
        { type: 'delta', text: '不应出现' },
      ]),
    );
    expect(result.error).toBe(error);
    expect(result.text).toBe('x');
    expect(result.partial).toBe(true);
  });

  it('collectText 只取文本', async () => {
    expect(await collectText(streamOf([{ type: 'delta', text: 'abc' }]))).toBe('abc');
  });

  it('工具参数解析失败时保留原文', () => {
    expect(parseToolArguments('{"a":1}')).toEqual({ a: 1 });
    expect(parseToolArguments('{broken')).toBe('{broken');
    expect(accumulateToolCalls([{ index: 0, id: 'a', name: 'f' }])[0]).toEqual({
      id: 'a',
      name: 'f',
      arguments: {},
    });
  });
});

describe('用量与费用', () => {
  it('费用按每百万 token 单价计算', () => {
    const cost = computeCost(usageOf(1_000_000, 500_000), {
      inputPricePerMTok: 2,
      outputPricePerMTok: 10,
    });
    expect(cost.input).toBeCloseTo(2, 6);
    expect(cost.output).toBeCloseTo(5, 6);
    expect(cost.total).toBeCloseTo(7, 6);
    expect(cost.complete).toBe(true);
  });

  it('单价缺失时标记 complete=false 且展示为 —', () => {
    const cost = computeCost(usageOf(100, 100), {
      inputPricePerMTok: null,
      outputPricePerMTok: null,
    });
    expect(cost.complete).toBe(false);
    expect(formatCost(cost)).toBe('—');
  });

  it('用量可累加', () => {
    expect(addUsage(usageOf(1, 2), usageOf(3, 4))).toEqual({
      promptTokens: 4,
      completionTokens: 6,
      totalTokens: 10,
    });
  });

  it('启发式 token 估算：中文与英文分别估算并标注误差', () => {
    const cn = estimateTokens('你好世界你好世界');
    const en = estimateTokens('hello world hello world');
    expect(cn.estimated).toBe(true);
    expect(cn.tokens).toBeGreaterThan(0);
    expect(cn.margin).toBeGreaterThan(0);
    expect(cn.tokens).toBeLessThan(en.tokens * 4);
    expect(estimateTokens('').tokens).toBe(0);
  });
});
