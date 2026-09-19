import type { MemoryRepo } from '../repo/memory-repo';
import { newUlid } from '@ec/data';

import type { IssueStatus, MemoryItem } from '../domain/memory-item';
import { upsertMemory, type UpsertOptions, type UpsertOutcome } from './upsert';

/**
 * 问题记忆（FR-MEM-05 / FR-MEM-13 ~ FR-MEM-16）。
 *
 * 结构化字段：现象 / 复现步骤 / 环境 / 已尝试方案及结论 / 最终解法 / 关联代码位置。
 * 处置状态：unsolved → solved | mitigated；重开必须显式声明（见 MemoryRepo.setIssueStatus）。
 */

export const ISSUE_SECTIONS = [
  'phenomenon',
  'reproduce',
  'environment',
  'attempts',
  'conclusion',
  'codeLocations',
] as const;
export type IssueSection = (typeof ISSUE_SECTIONS)[number];

export const ISSUE_SECTION_LABELS: Record<IssueSection, string> = {
  phenomenon: '现象',
  reproduce: '复现步骤',
  environment: '环境',
  attempts: '已尝试方案',
  conclusion: '结论',
  codeLocations: '关联代码位置',
};

export interface AttemptEntry {
  /** 尝试的方案 */
  action: string;
  /** 结果（无效 / 有效 / 部分有效） */
  result: string;
  at?: number;
}

export interface CodeLocation {
  filePath: string;
  symbol?: string | null;
  startLine?: number | null;
  endLine?: number | null;
}

export interface CreateIssueInput {
  projectId: string;
  featureId?: string | null;
  pageId?: string | null;
  elementId?: string | null;
  title: string;
  phenomenon: string;
  reproduce?: readonly string[];
  environment?: Record<string, unknown>;
  attempts?: readonly AttemptEntry[];
  conclusion?: string;
  codeLocations?: readonly CodeLocation[];
  commitSha?: string | null;
  tags?: readonly string[];
  importance?: number;
  confidence?: number;
  sourceType?: UpsertOptions['sourceType'];
  sourceRef?: string | null;
  /** 外部已存在的问题标识；缺省自动生成 ISSUE-<ULID 后 6 位> */
  issueId?: string;
}

export class IssueMemoryService {
  constructor(
    private readonly repo: MemoryRepo,
    private readonly userId: string,
  ) {}

  /** 建立问题记忆（默认 unsolved），并返回条目 */
  create(input: CreateIssueInput): UpsertOutcome {
    const issueId = input.issueId ?? `ISSUE-${newUlid().slice(-6)}`;
    const structured: Record<string, unknown> = {
      phenomenon: input.phenomenon,
      reproduce: [...(input.reproduce ?? [])],
      environment: input.environment ?? {},
      attempts: [...(input.attempts ?? [])],
      conclusion: input.conclusion ?? '',
      codeLocations: [...(input.codeLocations ?? [])],
    };
    if (input.commitSha) structured['commitSha'] = input.commitSha;

    return upsertMemory(
      this.repo,
      {
        userId: this.userId,
        scope: 'issue',
        projectId: input.projectId,
        featureId: input.featureId ?? null,
        pageId: input.pageId ?? null,
        elementId: input.elementId ?? null,
        issueId,
        title: input.title,
        content: input.phenomenon,
        structured,
        tags: ['issue', ...(input.tags ?? [])],
        sourceType: input.sourceType ?? 'manual',
        sourceRef: input.sourceRef ?? null,
        importance: input.importance ?? 4,
        confidence: input.confidence ?? 1,
        issueStatus: 'unsolved',
      },
      { onExisting: 'merge' },
    );
  }

  /** 追加一次尝试（去重：同 action + result 不重复写入） */
  appendAttempt(
    issueMemoryId: string,
    attempt: AttemptEntry,
    options: UpsertOptions = {},
  ): MemoryItem {
    const current = this.require(issueMemoryId);
    const attempts = readAttempts(current);
    const duplicated = attempts.some(
      (item) => item.action === attempt.action && item.result === attempt.result,
    );
    if (duplicated) return current;
    const structured = {
      ...(current.structured ?? {}),
      attempts: [...attempts, { ...attempt, at: attempt.at ?? Date.now() }],
    };
    return this.repo.update(issueMemoryId, { structured }, this.versionOf(current, options));
  }

  /** 写下结论并（可选）标记状态 */
  conclude(
    issueMemoryId: string,
    conclusion: string,
    options: {
      status?: IssueStatus;
      commitSha?: string | null;
      archive?: boolean;
      expectedVersion?: number;
    } = {},
  ): MemoryItem {
    const current = this.require(issueMemoryId);
    const structured: Record<string, unknown> = { ...(current.structured ?? {}), conclusion };
    if (options.commitSha) structured['commitSha'] = options.commitSha;
    const expectedVersion = options.expectedVersion ?? current.version;
    this.repo.update(issueMemoryId, { structured }, expectedVersion);

    if (!options.status) return this.require(issueMemoryId);
    return this.repo.resolveIssue(issueMemoryId, options.status, {
      ...(options.archive !== undefined ? { archive: options.archive } : {}),
    });
  }

  /** 状态流转入口（solved / mitigated / unsolved） */
  transition(
    issueMemoryId: string,
    next: IssueStatus,
    options: { explicit?: boolean; expectedVersion?: number; archive?: boolean } = {},
  ): MemoryItem {
    if (options.archive && next !== 'unsolved') {
      return this.repo.resolveIssue(issueMemoryId, next, {
        archive: true,
        ...(options.explicit !== undefined ? { explicit: options.explicit } : {}),
      });
    }
    return this.repo.setIssueStatus(issueMemoryId, next, options);
  }

  /** 重开：唯一允许 solved/mitigated → unsolved 的显式入口 */
  reopen(issueMemoryId: string, reason?: string): MemoryItem {
    const current = this.require(issueMemoryId);
    const structured = reason
      ? { ...(current.structured ?? {}), reopenReason: reason, reopenedAt: Date.now() }
      : current.structured;
    if (reason) this.repo.update(issueMemoryId, { structured });
    return this.repo.setIssueStatus(issueMemoryId, 'unsolved', { explicit: true });
  }

  /** 关联代码位置（合并去重） */
  addCodeLocations(
    issueMemoryId: string,
    locations: readonly CodeLocation[],
    commitSha?: string | null,
  ): MemoryItem {
    const current = this.require(issueMemoryId);
    const existing = readCodeLocations(current);
    const merged = [...existing];
    for (const location of locations) {
      if (
        !merged.some(
          (item) => item.filePath === location.filePath && item.symbol === location.symbol,
        )
      ) {
        merged.push(location);
      }
    }
    const structured: Record<string, unknown> = {
      ...(current.structured ?? {}),
      codeLocations: merged,
    };
    if (commitSha) structured['commitSha'] = commitSha;
    return this.repo.update(issueMemoryId, { structured }, current.version);
  }

  /** 进行中的问题（记忆中心"进行中问题"高亮数据源） */
  listActive(projectId: string): MemoryItem[] {
    return this.repo
      .list({ userId: this.userId, scopes: ['issue'], projectId, status: 'active' })
      .filter((item) => (item.issueStatus ?? 'unsolved') === 'unsolved')
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 全部问题（含已解决），按处置状态过滤 */
  list(projectId: string, issueStatus?: IssueStatus): MemoryItem[] {
    const items = this.repo.list({
      userId: this.userId,
      scopes: ['issue'],
      projectId,
      ...(issueStatus ? { issueStatus } : {}),
    });
    return items.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  findById(id: string): MemoryItem | null {
    return this.repo.findById(id);
  }

  /** 解决后沉淀：把结论提升为项目级/长期级经验（FR-MEM-16 的可选归档） */
  distill(
    issueMemoryId: string,
    target: {
      scope: 'project' | 'longterm';
      title: string;
      projectId?: string | null;
      content?: string;
    },
  ): MemoryItem {
    const issue = this.require(issueMemoryId);
    const structured = issue.structured ?? {};
    const conclusion =
      typeof structured['conclusion'] === 'string' ? structured['conclusion'] : issue.content;
    return this.repo.create({
      userId: this.userId,
      scope: target.scope,
      projectId: target.scope === 'longterm' ? null : (target.projectId ?? issue.projectId),
      title: target.title,
      content: target.content ?? conclusion,
      structured: {
        distilledFrom: issue.id,
        issueId: issue.issueId,
        phenomenon: structured['phenomenon'] ?? null,
      },
      tags: ['distilled', ...issue.tags.filter((tag) => tag !== 'issue')],
      sourceType: 'ai_summary',
      sourceRef: `issue:${issue.id}`,
      importance: Math.max(3, issue.importance),
      confidence: 0.9,
    });
  }

  private require(id: string): MemoryItem {
    const item = this.repo.findById(id);
    if (!item) throw new Error(`问题记忆不存在：${id}`);
    return item;
  }

  private versionOf(current: MemoryItem, options: UpsertOptions): number | undefined {
    return (options.optimisticLock ?? true) ? current.version : undefined;
  }
}

function readAttempts(item: MemoryItem): AttemptEntry[] {
  const raw = item.structured?.['attempts'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is AttemptEntry => Boolean(entry) && typeof entry === 'object');
}

function readCodeLocations(item: MemoryItem): CodeLocation[] {
  const raw = item.structured?.['codeLocations'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is CodeLocation => Boolean(entry) && typeof entry === 'object');
}
