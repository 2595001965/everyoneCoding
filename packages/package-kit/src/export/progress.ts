/**
 * 导出进度追踪（T8-02）。
 *
 * 维护 `ExportProgressSnapshot`：阶段推进、已处理/总数、当前文件、对象计数、
 * 失败清单、排除统计、脱敏命中、已用毫秒。每次状态变更通过 `onProgress` 回调给订阅方
 * （UI 进度条 / 计数 / 错误清单据此渲染）。
 */

import type { ExportFailure, ExportProgressSnapshot, ExportStage } from './export-types';

function emptySnapshot(): ExportProgressSnapshot {
  return {
    stage: 'enumerating',
    processed: 0,
    total: -1,
    currentFile: null,
    counts: {
      projects: 0,
      memoryItems: 0,
      documents: 0,
      pages: 0,
      codeFiles: 0,
      attachments: 0,
    },
    failures: [],
    excludeStats: null,
    redactionFindings: [],
    elapsedMs: 0,
  };
}

export type ProgressCallback = (snapshot: ExportProgressSnapshot) => void;

/** 导出进度追踪器 */
export class ExportProgressTracker {
  private readonly startedAt: number;
  private snapshot: ExportProgressSnapshot;
  private readonly callback: ProgressCallback | undefined;

  constructor(onProgress?: ProgressCallback | undefined) {
    this.startedAt = Date.now();
    this.snapshot = emptySnapshot();
    this.callback = onProgress;
  }

  /** 当前快照（只读副本） */
  getSnapshot(): ExportProgressSnapshot {
    return { ...this.snapshot, counts: { ...this.snapshot.counts }, failures: [...this.snapshot.failures] };
  }

  private elapsed(): number {
    return Date.now() - this.startedAt;
  }

  /** 切换阶段并发布 */
  setStage(stage: ExportStage): void {
    this.snapshot = { ...this.snapshot, stage, elapsedMs: this.elapsed() };
    this.publish();
  }

  /** 更新已处理 / 总数 / 当前文件并发布 */
  update(processed: number, total: number, currentFile: string | null): void {
    this.snapshot = {
      ...this.snapshot,
      processed,
      total,
      currentFile,
      elapsedMs: this.elapsed(),
    };
    this.publish();
  }

  /** 累加对象计数并发布（不重置其它字段） */
  bumpCount(key: keyof ExportProgressSnapshot['counts'], by = 1): void {
    this.snapshot = {
      ...this.snapshot,
      counts: { ...this.snapshot.counts, [key]: this.snapshot.counts[key] + by },
      elapsedMs: this.elapsed(),
    };
    this.publish();
  }

  /** 记录一次条目级失败并发布（整体不中断） */
  addFailure(failure: ExportFailure): void {
    this.snapshot = {
      ...this.snapshot,
      failures: [...this.snapshot.failures, failure],
      elapsedMs: this.elapsed(),
    };
    this.publish();
  }

  /** 回填排除统计（excluding 阶段后） */
  setExcludeStats(stats: ExportProgressSnapshot['excludeStats']): void {
    this.snapshot = { ...this.snapshot, excludeStats: stats, elapsedMs: this.elapsed() };
    this.publish();
  }

  /** 回填脱敏命中（redacting 阶段后） */
  setRedactionFindings(findings: ExportProgressSnapshot['redactionFindings']): void {
    this.snapshot = { ...this.snapshot, redactionFindings: findings, elapsedMs: this.elapsed() };
    this.publish();
  }

  /** 主动发布一次当前快照 */
  publish(): void {
    this.callback?.(this.getSnapshot());
  }
}
