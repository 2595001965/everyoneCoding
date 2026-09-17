import { clamp01, normalizeTitleKey } from '../domain/memory-item';
import type { MemoryRepo } from '../repo/memory-repo';
import { detectImperatives } from './signal-strength';

/**
 * 长期记忆自动抽取（FR-MEM-08）。
 *
 * 设计要点：
 * 1. 不阻塞主对话：抽取在"事件驱动 + 队列 + 微任务/后台"里跑。
 *    {@link MemoryExtractor.notify} 同步返回（只把本轮挂到 Promise 链上），
 *    不做 await，主流程耗时不受影响。
 * 2. 失败静默重试 1 次：{@link ExtractionModelPort.complete} 返回 `ok:false`
 *    或抛错时重试一次；仍失败则 `logger?.warn(...)` 并丢弃该轮，主流程无感、绝不抛错。
 * 3. AI 能力经端口注入：本包不得依赖 `@ec/ai`。
 *    上层（渲染层/主进程）用 `gateway.chat({ purpose: 'memory-extract', ... })`
 *    配合 `collect()` 适配成 {@link ExtractionModelPort} 后注入。
 */

/* --------------------------- 类别 --------------------------- */

/** 长期记忆类别（技术栈/命名规范/目录结构/UI 风格/语言/禁止与强制事项/交付习惯） */
export const MEMORY_CATEGORIES = [
  'tech-stack',
  'naming',
  'directory',
  'ui-style',
  'language',
  'constraint',
  'delivery',
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const MEMORY_CATEGORY_LABELS: Record<MemoryCategory, string> = {
  'tech-stack': '技术栈',
  naming: '命名规范',
  directory: '目录结构',
  'ui-style': 'UI 风格',
  language: '语言',
  constraint: '禁止与强制事项',
  delivery: '交付习惯',
};

/* --------------------------- 端口与输入 --------------------------- */

/**
 * 抽取模型端口（由上层注入，@ec/memory 不直接依赖 @ec/ai）。
 *
 * 上层用 `gateway.chat({ purpose: 'memory-extract', ... }) + collect()` 适配后传入。
 */
export interface ExtractionModelPort {
  readonly name: string;
  /** 一次轻量模型调用，返回完整文本；失败返回 ok:false（不抛错） */
  complete(request: { system: string; user: string; signal?: AbortSignal }): Promise<
    { ok: true; text: string } | { ok: false; reason: string }
  >;
}

/** 一轮对话的输入（用户消息 + AI 回复）。 */
export interface TurnInput {
  conversationId: string;
  projectId: string | null;
  userId: string;
  /** 本轮用户消息 + AI 回复（用于抽取） */
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** 本轮涉及的对话片段（用于变更日志的 sourceSnippet） */
  snippet?: string;
}

/* --------------------------- 候选 --------------------------- */

/**
 * 一条抽取出的长期记忆候选。
 *
 * `signalCount` 统计口径：在同一 userId 的既有长期记忆 + 本次队列内候选中，
 * 按 `normalizeTitleKey(title)` 同标题命中，或「同类别 且 共享至少一个标签」近似匹配，
 * 累计出现次数（含本次）。近似规则旨在低成本地判断"这是不是反复出现的偏好"。
 */
export interface MemoryCandidate {
  title: string;
  content: string;
  category: MemoryCategory;
  structured: Record<string, unknown> | null;
  tags: string[];
  /** 该偏好历史上出现次数（含本次），由抽取器统计 */
  signalCount: number;
  /** 是否命中明确指令词 */
  hasImperative: boolean;
  /** 模型基础置信度 0–1（抽取器结合指令词/重复度估算） */
  baseConfidence: number;
  sourceConversationId: string;
  snippet: string;
  /** 抽取时命中的原文片段 */
  evidence: string;
}

/* --------------------------- 提示词 --------------------------- */

/**
 * 构造抽取提示词。要求模型**只输出 JSON 数组**，元素形如
 * `{ "title": string, "content": string, "category": "...", "tags": string[] }`，
 * 并明确"只抽取稳定偏好，不抽取一次性需求"。
 *
 * @param knownPreferences 该用户已有的长期偏好标题（避免重复抽取）
 */
export function buildExtractionPrompt(
  turn: TurnInput,
  knownPreferences: readonly string[] = [],
): { system: string; user: string } {
  const categoryLines = MEMORY_CATEGORIES.map((c) => `- ${c}（${MEMORY_CATEGORY_LABELS[c]}）`).join('\n');
  const knownBlock =
    knownPreferences.length > 0
      ? `\n# 该用户已有的长期偏好（请勿重复抽取，除非有补充或冲突）\n${knownPreferences.map((p) => `- ${p}`).join('\n')}`
      : '';

  const system =
    '你是长期记忆抽取器。请从一轮对话中抽取"稳定、可复用的用户偏好/约定"，用于自动沉淀为长期记忆。\n' +
    '只抽取稳定偏好，不抽取一次性需求（如"这次改一下这个按钮颜色"属于一次性需求，不要抽取）。\n\n' +
    '# 可抽取的类别\n' +
    categoryLines +
    '\n\n# 输出格式\n' +
    '只输出一个 JSON 数组，不要任何解释文字、不要代码围栏。每个元素形如：\n' +
    '[{"title":"...","content":"...","category":"naming","tags":["..."]}]\n' +
    '- title：简短的偏好标题（如"统一用 TypeScript"）\n' +
    '- content：偏好的具体描述（Markdown）\n' +
    '- category：必须是上述类别之一\n' +
    '- tags：相关标签数组\n' +
    '如果没有稳定偏好，输出空数组 []。';

  const userMessages = turn.messages
    .map((m) => `${m.role === 'user' ? '用户' : 'AI'}：${m.content}`)
    .join('\n');
  const user = `项目：${turn.projectId ?? '跨项目'}\n\n# 本轮对话\n${userMessages}${knownBlock}`;

  return { system, user };
}

/* --------------------------- 容错解析 --------------------------- */

/**
 * 把模型返回的文本容错解析为候选数组。
 *
 * 容错策略：
 * - 允许 ```json 围栏与前后解释文字（截取第一个 `[` 到最后一个 `]`）；
 * - 单条元素非法（缺 title / category 非法）则跳过该条；
 * - **绝不抛错**，解析不到或非法时返回 `[]`。
 */
export function parseCandidates(raw: string, turn: TurnInput): MemoryCandidate[] {
  if (!raw || raw.trim().length === 0) return [];
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const results: MemoryCandidate[] = [];
  for (const element of parsed) {
    const candidate = parseOne(element, turn);
    if (candidate) results.push(candidate);
  }
  return results;
}

function parseOne(element: unknown, turn: TurnInput): MemoryCandidate | null {
  if (!element || typeof element !== 'object') return null;
  const obj = element as Record<string, unknown>;
  const title = typeof obj['title'] === 'string' ? (obj['title'] as string).trim() : '';
  if (title.length === 0) return null;

  const rawCategory = obj['category'];
  if (typeof rawCategory !== 'string' || !MEMORY_CATEGORIES.includes(rawCategory as MemoryCategory)) return null;
  const category = rawCategory as MemoryCategory;

  const content = typeof obj['content'] === 'string' ? (obj['content'] as string) : '';
  const tags = Array.isArray(obj['tags'])
    ? (obj['tags'] as unknown[]).filter((t): t is string => typeof t === 'string')
    : [];

  const evidence = locateEvidence(turn, title, content);
  const snippet = turn.snippet ?? turn.messages.map((m) => m.content).join('\n').slice(0, 500);
  const hasImperative = detectImperatives(`${title} ${content} ${evidence}`).length > 0;
  const baseConfidence = clamp01((hasImperative ? 0.75 : 0.6) + (tags.length > 0 ? 0.05 : 0));

  return {
    title,
    content,
    category,
    structured: null,
    tags,
    signalCount: 1,
    hasImperative,
    baseConfidence,
    sourceConversationId: turn.conversationId,
    snippet,
    evidence,
  };
}

/** 在对话原文里定位候选偏好的证据片段（优先用户消息中出现标题/正文关键词处）。 */
function locateEvidence(turn: TurnInput, title: string, content: string): string {
  const haystacks = turn.messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .concat(turn.messages.filter((m) => m.role === 'assistant').map((m) => m.content));
  const keywords = [title, ...content.split(/[\s，。,.!?；;]+/).filter((w) => w.length >= 2)].filter(Boolean);

  for (const text of haystacks) {
    for (const keyword of keywords) {
      const idx = text.indexOf(keyword);
      if (idx >= 0) {
        const start = Math.max(0, idx - 20);
        const end = Math.min(text.length, idx + keyword.length + 80);
        return text.slice(start, end).trim();
      }
    }
  }
  return turn.snippet ?? title;
}

/* --------------------------- 抽取器 --------------------------- */

type CandidateListener = (candidates: MemoryCandidate[], turn: TurnInput) => void | Promise<void>;

const DEFAULT_RETRY_DELAY_MS = 0;

/**
 * 事件驱动的异步抽取器。
 *
 * 用法：
 * ```ts
 * extractor.notify(turn); // 同步返回，主对话无感
 * // 应用关闭时（或测试里）：await extractor.drain();
 * ```
 *
 * 失败处理：`model.complete` 返回 `ok:false` 或抛错 → 静默重试 1 次
 * （间隔 {@link MemoryExtractor} 构造的 `retryDelayMs`，默认 0 便于测试）→
 * 仍失败则 `logger?.warn(...)` 并丢弃该轮，主流程无感。
 */
export class MemoryExtractor {
  private readonly model: ExtractionModelPort;
  private readonly repo: MemoryRepo;
  private readonly clock: () => number;
  private readonly retryDelayMs: number;
  private readonly logger: { warn(message: string, data?: Record<string, unknown>): void } | null;
  private readonly listeners = new Set<CandidateListener>();
  /** 串行的抽取链：每轮 notify 都追加到尾部，drain 等它排空 */
  private tail: Promise<void> = Promise.resolve();

  constructor(deps: {
    model: ExtractionModelPort;
    repo: MemoryRepo;
    clock?: () => number;
    retryDelayMs?: number;
    logger?: { warn(message: string, data?: Record<string, unknown>): void } | null;
  }) {
    this.model = deps.model;
    this.repo = deps.repo;
    this.clock = deps.clock ?? (() => Date.now());
    this.retryDelayMs = deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.logger = deps.logger ?? null;
  }

  /**
   * 同步返回：把本轮加入后台队列，主流程耗时不受影响。
   * 实现上仅把本轮挂到 Promise 链尾，不做 await。
   */
  notify(turn: TurnInput): void {
    this.tail = this.tail
      .then(() => this.runExtraction(turn))
      .catch((err: unknown) => {
        this.warn('抽取流程异常（已忽略）', { error: String(err) });
      });
  }

  /** 等待队列排空（仅测试与关闭应用时使用）。 */
  async drain(): Promise<void> {
    for (;;) {
      const current = this.tail;
      await current;
      if (current === this.tail) return;
    }
  }

  /** 直接同步抽取一次（测试与"重新抽取"入口用）。返回候选数组，绝不抛错。 */
  async extractOnce(turn: TurnInput): Promise<MemoryCandidate[]> {
    const known = this.knownPreferences(turn.userId);
    const prompt = buildExtractionPrompt(turn, known);
    const text = await this.callModel(prompt.system, prompt.user);
    if (text === null) return [];
    const parsed = parseCandidates(text, turn);
    return this.enrichSignal(parsed, turn);
  }

  /** 订阅候选结果（抽取完成、重试后仍失败时以空数组回调）。返回取消订阅函数。 */
  onCandidates(listener: CandidateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async runExtraction(turn: TurnInput): Promise<void> {
    // clock 用于抽取时序埋点（预留给上层观测/调试，此处读取一次以满足接口约定）
    void this.clock();
    const candidates = await this.extractOnce(turn);
    for (const listener of [...this.listeners]) {
      await listener(candidates, turn);
    }
  }

  /** 带一次重试的模型调用；全部失败返回 null 并 warn 一次。 */
  private async callModel(system: string, user: string): Promise<string | null> {
    let lastReason = 'unknown';
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await this.model.complete({ system, user });
        if (res.ok) return res.text;
        lastReason = res.reason;
      } catch (err) {
        lastReason = String(err);
      }
      if (attempt < 2 && this.retryDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, this.retryDelayMs));
      }
    }
    this.warn('抽取模型调用失败，已静默放弃本轮', { reason: lastReason });
    return null;
  }

  /** 统计信号强度：结合既有长期记忆与本次批次内的近似匹配累计出现次数。 */
  private enrichSignal(candidates: MemoryCandidate[], turn: TurnInput): MemoryCandidate[] {
    const existing = this.repo.list({ userId: turn.userId, scopes: ['longterm'], status: 'active' });
    return candidates.map((candidate) => {
      const key = normalizeTitleKey(candidate.title);
      let count = 1;
      if (existing.some((e) => normalizeTitleKey(e.title) === key)) count += 1;
      const overlap = existing.filter(
        (e) => e.tags.includes(candidate.category) && e.tags.some((t) => candidate.tags.includes(t)),
      );
      count += overlap.length;
      count += candidates.filter((c) => c !== candidate && normalizeTitleKey(c.title) === key).length;

      const hasImperative = detectImperatives(
        `${candidate.title} ${candidate.content} ${candidate.evidence}`,
      ).length > 0;
      const baseConfidence = clamp01(candidate.baseConfidence + (count >= 2 ? 0.1 : 0));
      return { ...candidate, signalCount: count, hasImperative, baseConfidence };
    });
  }

  private knownPreferences(userId: string): string[] {
    return this.repo.list({ userId, scopes: ['longterm'], status: 'active' }).map((m) => m.title);
  }

  private warn(message: string, data?: Record<string, unknown>): void {
    this.logger?.warn(message, data);
  }
}
