import type { AssembledContext } from '../context/context-types';
import { assistantMessage, systemMessage, userMessage, type ChatMessage } from '../core/message';
import { collect, type FinishReason } from '../core/stream';
import type { StreamChunk } from '../core/stream';
import type { Usage } from '../core/usage';
import { buildParseFeedback, type GenerationOutput } from './output-schema';
import { parseModelOutput, type ParseResult } from './parser';
import { buildPromptFor, templateFor, type GenerationTarget, type PromptTemplateInput } from './prompt-templates';

/**
 * 流式生成器（T4-04 要点 3 / FR-AI-06）。
 *
 * 四件事，各自边界清晰：
 * 1. **流式**：把 provider 的 chunk 流转发给 UI（`onDelta`），同时保留完整文本；
 * 2. **中断**：`AbortSignal` 触发后已生成的 delta 全部保留，`partial = true`，
 *    并可通过 {@link Generator.continueGeneration} 以"已生成内容"为前缀续写；
 * 3. **解析**：交给 `parser.ts`（纯函数），失败时把契约违规明细反馈给模型重试 **1 次**；
 * 4. **降级**：重试仍失败则返回降级结果（Markdown 代码块提取或原样文本），
 *    由 UI 提示用户，绝不抛错把已生成的内容丢掉。
 *
 * 不依赖任何具体协议：只要注入的 `GenerationRunner` 返回 `AsyncIterable<StreamChunk>`，
 * 就能对接 OpenAI / Anthropic / 假实现（测试即用 `streamOf` 构造）。
 */

export interface GenerationRunRequest {
  messages: ChatMessage[];
  signal?: AbortSignal | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
}

export type GenerationRunner = (request: GenerationRunRequest) => AsyncIterable<StreamChunk>;

export interface GenerateOptions {
  target: GenerationTarget;
  /** T4-02 组装好的上下文；给出时复用其 system（角色 + 契约 + 上下文正文） */
  context?: AssembledContext | null | undefined;
  /** 直接给出提示词（与 context 二选一，优先级最高） */
  prompt?: { system: string; user: string } | undefined;
  /** 模板入参（项目名 / 技术选型 / 记忆约束 / 用户补充指令） */
  templateInput?: PromptTemplateInput | undefined;
  signal?: AbortSignal | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  /** 流式增量回调（UI 逐字展示） */
  onDelta?: ((text: string) => void) | undefined;
  /** 只取文本、不做结构化解析（生成长文档等场景） */
  rawText?: boolean | undefined;
  /** 解析失败的重试次数（默认 1，与任务卡一致） */
  maxRetries?: number | undefined;
}

export interface GenerationResult {
  /** 结构化结果；rawText 或彻底降级失败时为 null */
  output: GenerationOutput | null;
  /** 模型原始文本（原样展示 / 续写 / 审计都用它） */
  raw: string;
  partial: boolean;
  usage: Usage | null;
  finishReason: FinishReason;
  parse: ParseResult;
  /** 实际调用模型的次数（1 或 2） */
  attempts: number;
  degraded: boolean;
  system: string;
  user: string;
  target: GenerationTarget;
  /** 续写时的来源片段（便于 UI 标注"已续写"） */
  continuedFrom?: string | undefined;
}

/** 生成阶段的终态错误（重试与降级都走完仍然无法交付时抛出） */
export class GenerationError extends Error {
  readonly userMessage: string;
  readonly action: string;

  constructor(message: string, options: { userMessage?: string; action?: string; raw?: string } = {}) {
    super(message);
    this.name = 'GenerationError';
    this.userMessage = options.userMessage ?? '生成失败。';
    this.action = options.action ?? '请检查模型连通性与用量配额后重试。';
    Object.setPrototypeOf(this, GenerationError.prototype);
  }
}

export interface GeneratorDeps {
  /** 执行一次模型调用（外壳适配 AiGateway.stream 或测试用假流） */
  run: GenerationRunner;
  /** 解析失败重试次数（默认 1） */
  maxRetries?: number;
}

export class Generator {
  private readonly deps: GeneratorDeps;
  private readonly maxRetries: number;

  constructor(deps: GeneratorDeps) {
    this.deps = deps;
    this.maxRetries = deps.maxRetries ?? 1;
  }

  /** 组装最终提示词：有上下文时以其为主，仅追加端专用约束（避免与契约重复） */
  buildPrompts(options: GenerateOptions): { system: string; user: string } {
    if (options.prompt !== undefined) return options.prompt;
    const template = templateFor(options.target);
    const rendered = buildPromptFor(options.target, options.templateInput ?? {});

    if (options.context === null || options.context === undefined) return rendered;

    const system = [
      options.context.system,
      '',
      `## 端专用约束（${template.label}）`,
      ...template.constraints.map((constraint, index) => `${index + 1}. ${constraint}`),
    ].join('\n');
    return { system, user: options.context.user };
  }

  /**
   * 生成一次（含一次解析重试）。
   *
   * 中断不抛错：返回 `partial = true` 的结果，`raw` 即已生成部分。
   */
  async generate(options: GenerateOptions): Promise<GenerationResult> {
    const { system, user } = this.buildPrompts(options);
    const baseMessages: ChatMessage[] = [systemMessage(system), userMessage(user)];
    const maxRetries = options.maxRetries ?? this.maxRetries;

    let messages = baseMessages;
    let attempt = 0;
    let last: { raw: string; partial: boolean; usage: Usage | null; finishReason: FinishReason; parse: ParseResult } | null =
      null;

    while (attempt <= maxRetries) {
      attempt += 1;
      const collected = await this.runOnce(messages, options);
      const parse = options.rawText === true
        ? ({
            success: false,
            output: null,
            mode: 'raw',
            degraded: true,
            raw: collected.raw,
            issues: ['按调用方要求不做结构化解析'],
          } satisfies ParseResult)
        : parseModelOutput(collected.raw);

      last = { ...collected, parse };

      // 中断或解析成功：直接返回（中断时保留部分内容，不重试）
      if (collected.partial) break;
      if (parse.success || options.rawText === true) break;
      if (attempt > maxRetries) break;

      // 失败重试：把契约违规明细与上次输出开头反馈给模型
      messages = [
        ...baseMessages,
        assistantMessage(collected.raw),
        userMessage(buildParseFeedback(parse.issues, collected.raw)),
      ];
    }

    const final = last;
    if (final === null) {
      throw new GenerationError('生成未产生任何结果', { userMessage: '模型没有返回内容。', action: '请稍后重试或更换模型。' });
    }

    return {
      output: final.parse.output,
      raw: final.raw,
      partial: final.partial,
      usage: final.usage,
      finishReason: final.finishReason,
      parse: final.parse,
      attempts: attempt,
      degraded: final.parse.degraded,
      system,
      user,
      target: options.target,
    };
  }

  /**
   * 继续生成（FR-AI-06：中断后保留部分内容并支持续写）。
   * 把上次输出作为 assistant 前缀重新投喂，要求模型"接着写"，不重复已完成部分。
   */
  async continueGeneration(
    previous: GenerationResult,
    options: Omit<GenerateOptions, 'target' | 'context' | 'prompt' | 'templateInput'> & { instruction?: string } = {},
  ): Promise<GenerationResult> {
    const tail = previous.raw.slice(-400);
    const messages: ChatMessage[] = [
      systemMessage(previous.system),
      userMessage(previous.user),
      assistantMessage(previous.raw),
      userMessage(
        [
          '上面的输出被中断/未完成，请**从中断处继续**，不要重复已经写过的内容。',
          options.instruction !== undefined && options.instruction.trim().length > 0
            ? `补充要求：${options.instruction.trim()}`
            : '',
          '如果你认为已经写完整，请补一个完整的合法 JSON 输出（可只包含剩余文件）。',
          `中断处附近的上下文（供你定位）：\n…${tail}`,
        ]
          .filter((line) => line.length > 0)
          .join('\n'),
      ),
    ];

    const collected = await this.runOnce(messages, {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options.onDelta !== undefined ? { onDelta: options.onDelta } : {}),
    });

    const parse = parseModelOutput(collected.raw);
    return {
      output: parse.output,
      raw: collected.raw,
      partial: collected.partial,
      usage: collected.usage,
      finishReason: collected.finishReason,
      parse,
      attempts: 1,
      degraded: parse.degraded,
      system: previous.system,
      user: previous.user,
      target: previous.target,
      continuedFrom: tail,
    };
  }

  /** 单次模型调用：转发 delta + 收口为完整文本 */
  private async runOnce(
    messages: ChatMessage[],
    options: {
      signal?: AbortSignal | undefined;
      temperature?: number | undefined;
      maxTokens?: number | undefined;
      onDelta?: ((text: string) => void) | undefined;
    },
  ): Promise<{ raw: string; partial: boolean; usage: Usage | null; finishReason: FinishReason }> {
    const stream = this.deps.run({
      messages,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    });

    if (options.onDelta === undefined) {
      const collected = await collect(stream);
      return {
        raw: collected.text,
        partial: collected.partial,
        usage: collected.usage,
        finishReason: collected.finishReason,
      };
    }

    // 需要逐字回调时自己消费流（不能既转发又 collect 同一个迭代器）
    let raw = '';
    let usage: Usage | null = null;
    let finishReason: FinishReason = 'stop';
    let partial = false;
    for await (const chunk of stream) {
      if (chunk.type === 'delta') {
        raw += chunk.text;
        options.onDelta(chunk.text);
      } else if (chunk.type === 'usage') {
        usage = chunk.usage;
      } else if (chunk.type === 'done') {
        finishReason = chunk.finishReason;
        partial = chunk.partial;
        break;
      } else if (chunk.type === 'error') {
        partial = true;
        finishReason = 'error';
        break;
      }
    }
    return { raw, partial, usage, finishReason };
  }
}

export function createGenerator(deps: GeneratorDeps): Generator {
  return new Generator(deps);
}
