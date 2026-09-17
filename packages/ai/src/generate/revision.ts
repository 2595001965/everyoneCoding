import type { FileAction, GeneratedFile, GenerationOutput } from './output-schema';
import type { GenerationTarget } from './prompt-templates';

/**
 * 多轮对话修正（T4-04 要点 4 / FR-AI-08）。
 *
 * 语义：对生成结果继续对话要求修改，**每轮作为一个 revision 记录**，
 * 任意一轮都可以单独回退。回退只切换"当前指针"，不删除后续轮次 ——
 * 这样才能"回退看一下再切回来"，而不是一条单向的时间线。
 */

export interface LineDelta {
  added: number;
  removed: number;
}

/** 行切分：末尾换行不算一行（否则每个文件都会凭空多出 1 行） */
export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** 逐行差异统计（不做完整 LCS：这里只需要"改了多少行"用于展示与风险评估） */
export function computeLineDelta(previous: string, next: string): LineDelta {
  if (previous === next) return { added: 0, removed: 0 };
  const before = splitLines(previous);
  const after = splitLines(next);
  const beforeSet = new Map<string, number>();
  for (const line of before) beforeSet.set(line, (beforeSet.get(line) ?? 0) + 1);
  let added = 0;
  let removed = 0;
  for (const line of after) {
    const count = beforeSet.get(line) ?? 0;
    if (count > 0) beforeSet.set(line, count - 1);
    else added += 1;
  }
  for (const count of beforeSet.values()) removed += count;
  return { added, removed };
}

/** 单文件差异摘要（结果页「本轮改了什么」） */
export interface FileDiffSummary {
  path: string;
  action: FileAction;
  addedLines: number;
  removedLines: number;
  /** 内容与上一轮完全一致 */
  unchanged: boolean;
}

export function summarizeFileDiff(
  previous: readonly GeneratedFile[],
  next: readonly GeneratedFile[],
): FileDiffSummary[] {
  const previousByPath = new Map(previous.map((file) => [file.path, file]));
  const summaries: FileDiffSummary[] = [];

  for (const file of next) {
    const before = previousByPath.get(file.path);
    if (before === undefined) {
      summaries.push({
        path: file.path,
        action: file.action,
        addedLines: splitLines(file.content).length,
        removedLines: 0,
        unchanged: false,
      });
      continue;
    }
    previousByPath.delete(file.path);
    const delta = computeLineDelta(before.content, file.content);
    summaries.push({
      path: file.path,
      action: file.action,
      addedLines: delta.added,
      removedLines: delta.removed,
      unchanged: delta.added === 0 && delta.removed === 0,
    });
  }

  // 上一轮有、本轮没有的文件：视为删除
  for (const file of previousByPath.values()) {
    summaries.push({
      path: file.path,
      action: 'delete',
      addedLines: 0,
      removedLines: splitLines(file.content).length,
      unchanged: false,
    });
  }

  return summaries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export interface RevisionRecord {
  id: string;
  /** 第几轮（从 1 开始） */
  index: number;
  /** 上一轮 id；首轮为 null */
  parentId: string | null;
  createdAt: number;
  /** 触发本轮的用户指令（首轮为初始任务） */
  instruction: string;
  /** 本轮使用的模型（可解释性） */
  model: string | null;
  target: GenerationTarget;
  output: GenerationOutput;
  /** 相对上一轮的逐文件差异 */
  diff: FileDiffSummary[];
  /** 本轮变更说明 */
  summary: string;
}

export interface AddRevisionInput {
  instruction: string;
  target: GenerationTarget;
  output: GenerationOutput;
  model?: string | null;
  parentId?: string | null;
}

export interface RevisionStoreOptions {
  clock?: () => number;
  idFactory?: (index: number) => string;
  /** 保留的最大轮次（超出丢弃最旧，但当前指针指向的轮次永不丢） */
  limit?: number;
}

export class RevisionStore {
  private readonly clock: () => number;
  private readonly idFactory: (index: number) => string;
  private readonly limit: number;
  private revisions: RevisionRecord[] = [];
  private currentId: string | null = null;

  constructor(options: RevisionStoreOptions = {}) {
    this.clock = options.clock ?? (() => Date.now());
    this.idFactory = options.idFactory ?? ((index) => `rev-${index}`);
    this.limit = options.limit ?? 50;
  }

  /** 追加一轮（自动与上一轮做差异） */
  add(input: AddRevisionInput): RevisionRecord {
    const parent = input.parentId === undefined ? this.current() : this.findById(input.parentId ?? null);
    const index = this.revisions.length + 1;
    const record: RevisionRecord = {
      id: this.idFactory(index),
      index,
      parentId: input.parentId !== undefined ? input.parentId : (parent?.id ?? null),
      createdAt: this.clock(),
      instruction: input.instruction,
      model: input.model ?? null,
      target: input.target,
      output: input.output,
      diff: summarizeFileDiff(parent?.output.files ?? [], input.output.files),
      summary: input.output.summary,
    };
    this.revisions = [...this.revisions, record];
    this.currentId = record.id;
    this.prune();
    return record;
  }

  list(): RevisionRecord[] {
    return this.revisions.map(cloneRevision);
  }

  get(id: string): RevisionRecord | null {
    const found = this.findById(id);
    return found === null ? null : cloneRevision(found);
  }

  current(): RevisionRecord | null {
    return this.currentId === null ? null : this.get(this.currentId);
  }

  /**
   * 回退到某一轮：只切换当前指针，**不删除**后续轮次。
   * 返回目标轮次（便于 UI 直接把该轮产物作为新的"当前结果"）。
   */
  revertTo(id: string): RevisionRecord | null {
    const target = this.findById(id);
    if (target === null) return null;
    this.currentId = target.id;
    return cloneRevision(target);
  }

  /** 与上一轮的差异（结果页/时间轴展示） */
  diffOf(id: string): FileDiffSummary[] {
    return this.get(id)?.diff ?? [];
  }

  /** 全部新增行 / 删除行合计（NFR-U-01 变更规模提示） */
  totalDelta(): LineDelta {
    return this.revisions.reduce(
      (sum, record) => ({
        added: sum.added + record.diff.reduce((inner, file) => inner + file.addedLines, 0),
        removed: sum.removed + record.diff.reduce((inner, file) => inner + file.removedLines, 0),
      }),
      { added: 0, removed: 0 },
    );
  }

  private findById(id: string | null): RevisionRecord | null {
    if (id === null) return null;
    return this.revisions.find((record) => record.id === id) ?? null;
  }

  private prune(): void {
    if (this.revisions.length <= this.limit) return;
    const kept = this.revisions.slice(this.revisions.length - this.limit);
    // 兜底：当前指针指向的轮次一旦被淘汰，revertTo 就会失效
    if (this.currentId !== null && !kept.some((record) => record.id === this.currentId)) {
      const current = this.revisions.find((record) => record.id === this.currentId);
      if (current !== undefined) kept.unshift(current);
    }
    this.revisions = kept;
  }
}

function cloneRevision(record: RevisionRecord): RevisionRecord {
  return {
    ...record,
    output: {
      files: record.output.files.map((file) => ({ ...file })),
      anchors: record.output.anchors.map((anchor) => ({ ...anchor })),
      summary: record.output.summary,
      notes: record.output.notes,
      decision: {
        referencedMemory: record.output.decision.referencedMemory.map((memory) => ({ ...memory })),
        rationale: record.output.decision.rationale,
        risks: [...record.output.decision.risks],
        uncovered: [...record.output.decision.uncovered],
      },
    },
    diff: record.diff.map((item) => ({ ...item })),
  };
}
