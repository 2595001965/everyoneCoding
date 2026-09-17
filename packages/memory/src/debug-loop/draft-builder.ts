/**
 * 问题记忆草稿构建器（领域层，绝不调用网络、绝不写数据库）。
 *
 * 输入一个 DetectionResult，从事件队列（WindowQueue）中汇总：
 * - 现象（窗口内 error 事件的 rawError，按指纹去重、按时间）
 * - 复现步骤（generate/run/error/negative-feedback 序列归纳，不凭空编造）
 * - 已尝试方案（来自可选的 ConversationSnippetPort）
 * - 关联页面/元素/功能、commit sha、来源对话
 *
 * 另提供 `draftToCreateIssueInput`（纯转换）与 `materializeIssueDraft`（一键落库入口）。
 */

import type { MemoryItem } from '../domain/memory-item';
import type {
  AttemptEntry,
  CodeLocation,
  CreateIssueInput,
  IssueMemoryService,
} from '../service/issue-memory';
import { readableTarget, type DebugEvent, type WindowQueue } from './window-queue';
import type { DetectionResult } from './detector';

/** 取最近一次 commit 的端口（实现由上层注入，通常是 git 命令封装） */
export interface GitCommitPort {
  /** 返回最新 commit sha，无则 null */
  latestSha(): string | null;
}

/** 取对话尝试描述的端口（实现由上层注入，通常是对话历史检索） */
export interface ConversationSnippetPort {
  /** 取该 target 最近的尝试描述（"试过什么"） */
  attemptsFor(targetKey: string, limit?: number): string[];
}

/** 问题记忆草稿（落库前的纯数据） */
export interface IssueDraft {
  title: string;
  /** 现象（Markdown 文本） */
  phenomenon: string;
  /** 复现步骤 */
  reproduce: string[];
  /** 已尝试方案 */
  attempts: AttemptEntry[];
  /** 关联代码位置 */
  codeLocations: CodeLocation[];
  relatedPageId: string | null;
  relatedElementId: string | null;
  relatedFeatureId: string | null;
  /** 最近 commit sha */
  commitSha: string | null;
  /** 来源对话 id */
  conversationId: string | null;
}

/** IssueDraftBuilder 构造依赖 */
export interface IssueDraftBuilderDeps {
  queue: WindowQueue;
  /** 可选：提供则取 commitSha，否则为 null */
  commits?: GitCommitPort | null;
  /** 可选：提供则取已尝试方案，否则为空数组 */
  conversations?: ConversationSnippetPort | null;
  /** 时钟注入（默认 Date.now） */
  clock?: () => number;
}

/** 把一行尝试描述转为 AttemptEntry（结果未知，留待用户补充） */
function toAttempt(text: string): AttemptEntry {
  return { action: text, result: '待确认' };
}

/** 由窗口内该 target 的事件归纳复现步骤（不超出事件数，不凭空编造） */
function buildReproduce(events: readonly DebugEvent[]): string[] {
  const steps: string[] = [];
  for (const event of events) {
    switch (event.type) {
      case 'generate':
        steps.push(`生成「${event.attemptSummary || readableTarget(event)}」`);
        break;
      case 'run':
        steps.push('运行');
        break;
      case 'error':
        steps.push(`报错：${event.errorSignature || event.rawError || '未知错误'}`);
        break;
      case 'negative-feedback':
        steps.push('收到否定反馈');
        break;
      default:
        break;
    }
  }
  return steps;
}

export class IssueDraftBuilder {
  private readonly queue: WindowQueue;
  private readonly commits: GitCommitPort | null;
  private readonly conversations: ConversationSnippetPort | null;
  private readonly clock: () => number;

  constructor(deps: IssueDraftBuilderDeps) {
    this.queue = deps.queue;
    this.commits = deps.commits ?? null;
    this.conversations = deps.conversations ?? null;
    this.clock = deps.clock ?? (() => Date.now());
  }

  /** 基于检测结果构建问题记忆草稿 */
  build(result: DetectionResult, options?: { relatedCode?: readonly CodeLocation[] }): IssueDraft {
    const events = this.queue
      .within(this.clock())
      .filter((e) => e.targetKey === result.targetKey)
      .sort((a, b) => a.at - b.at);

    // 现象：error 事件的 rawError，按指纹去重、保持时间顺序
    const phenomenonLines: string[] = [];
    const seen = new Set<string>();
    for (const event of events) {
      if (event.type !== 'error' || !event.rawError) continue;
      const key = event.errorSignature || event.rawError;
      if (seen.has(key)) continue;
      seen.add(key);
      phenomenonLines.push(event.rawError);
    }

    // 关联对话：取最近的 conversationId（优先末尾，即最近一次）
    let conversationId: string | null = null;
    for (let i = events.length - 1; i >= 0; i--) {
      const id = events[i]!.conversationId;
      if (id) {
        conversationId = id;
        break;
      }
    }

    const attempts = this.conversations
      ? this.conversations.attemptsFor(result.targetKey).map(toAttempt)
      : [];

    const readable = readableTarget({
      pageId: result.pageId,
      elementId: result.elementId,
      featureId: result.featureId,
    });

    return {
      title: `反复调试「${readable}」`,
      phenomenon: phenomenonLines.join('\n\n'),
      reproduce: buildReproduce(events),
      attempts,
      codeLocations: [...(options?.relatedCode ?? [])],
      relatedPageId: result.pageId,
      relatedElementId: result.elementId,
      relatedFeatureId: result.featureId,
      commitSha: this.commits ? this.commits.latestSha() : null,
      conversationId,
    };
  }
}

/**
 * 便捷转换：把 IssueDraft 转成可直接喂给 IssueMemoryService.create 的入参。
 * 固定 sourceType='auto_chat'、tags=['debug-loop']；issueStatus 不填（由服务置 unsolved）。
 */
export function draftToCreateIssueInput(
  draft: IssueDraft,
  ctx: { userId: string; projectId: string; issueId?: string },
): CreateIssueInput {
  const input: CreateIssueInput = {
    projectId: ctx.projectId,
    featureId: draft.relatedFeatureId,
    pageId: draft.relatedPageId,
    elementId: draft.relatedElementId,
    title: draft.title,
    phenomenon: draft.phenomenon,
    reproduce: draft.reproduce,
    attempts: draft.attempts,
    codeLocations: draft.codeLocations,
    commitSha: draft.commitSha,
    tags: ['debug-loop'],
    sourceType: 'auto_chat',
    sourceRef: draft.conversationId,
  };
  if (ctx.issueId !== undefined) input.issueId = ctx.issueId;
  return input;
}

/**
 * 一键建立：把草稿落库为一条问题记忆（scope=issue, status=unsolved）。
 * 通过 IssueMemoryService.create 写入，codeLocations 与 commitSha 一并进入结构化字段。
 */
export async function materializeIssueDraft(
  service: IssueMemoryService,
  draft: IssueDraft,
  ctx: { userId: string; projectId: string },
): Promise<MemoryItem> {
  const input = draftToCreateIssueInput(draft, ctx);
  return service.create(input).item;
}
