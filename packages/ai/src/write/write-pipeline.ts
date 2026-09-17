import type { AnchorDeclaration } from '../anchors/anchor-model';
import type { GenerationOutput } from '../generate/output-schema';
import { planCreate } from './apply-strategy/create';
import { planDelete, planPatch } from './apply-strategy/patch';
import { buildPreviews, previewsToSummaries, type FilePreview } from './apply-strategy/preview';
import type {
  PlanWriteInput,
  WriteEvent,
  WriteEventListener,
  WriteMode,
  WritePlan,
  WritePlanEntry,
  WriteResult,
  WorkspaceFileSystem,
} from './write-types';

/**
 * 代码写入管线（T4-05 要点 1、5、6）。
 *
 * 三段式：
 * ```
 * GenerationOutput ──plan()──▶ WritePlan（读现状 + 冲突检测 + 计算 after，不落盘）
 *                                  │
 *                    buildPreviews()├──▶ FilePreview[]（DiffView 展示 / 按文件选择）
 *                                  ▼
 *                              apply() ──▶ 事务写（全成则提交，任一失败整体回滚）
 * ```
 *
 * 三条不可协商的约束：
 * 1. **不存在用户手动编辑模式**（D-04）：apply 只接受 AI 产出的计划，
 *    且写入的是 `after`（由 create/patch 策略计算），不接受调用方塞入任意文本；
 * 2. **冲突检测**：计划生成时记录 `before`，apply 前重新读取比对，
 *    被外部改过就拒绝并提示重新生成（避免覆盖他人的修改）；
 * 3. **原子性**：任一步失败，已写入的文件全部还原成写入前的快照，删除本次新建的文件
 *    （NFR-R-01/02：不留中间态）。
 */
export interface WritePipelineDeps {
  fs: WorkspaceFileSystem;
  clock?: (() => number) | undefined;
  idFactory?: ((sequence: number) => string) | undefined;
  logger?: { warn(message: string, detail?: unknown): void } | undefined;
}

export class WritePipeline {
  private readonly fs: WorkspaceFileSystem;
  private readonly clock: () => number;
  private readonly idFactory: (sequence: number) => string;
  private readonly logger: { warn(message: string, detail?: unknown): void } | undefined;
  private readonly listeners = new Set<WriteEventListener>();
  private sequence = 0;

  constructor(deps: WritePipelineDeps) {
    this.fs = deps.fs;
    this.clock = deps.clock ?? (() => Date.now());
    this.idFactory = deps.idFactory ?? ((sequence) => `plan-${sequence}`);
    this.logger = deps.logger;
  }

  onEvent(listener: WriteEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: WriteEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /**
   * 生成写入计划（不落盘）。
   * `preview` 模式与 `create`/`patch` 走同一套策略 —— 区别只在"谁触发 apply"。
   */
  async plan(input: PlanWriteInput): Promise<WritePlan> {
    const selected = input.selectedPaths === undefined ? null : new Set(input.selectedPaths);
    const entries: WritePlanEntry[] = [];

    for (const file of input.output.files) {
      const isSelected = selected === null || selected.has(file.path);
      const entry =
        file.action === 'create'
          ? await planCreate(this.fs, file, isSelected)
          : file.action === 'delete'
            ? await planDelete(this.fs, file, isSelected)
            : await planPatch(this.fs, file, isSelected);
      entries.push(entry);
    }

    const previews = buildPreviews({
      id: 'preview',
      mode: input.mode,
      entries,
      createdAt: this.clock(),
      summary: input.output.summary,
      anchors: input.output.anchors,
      noteIds: [...(input.noteIds ?? [])],
      addedLines: 0,
      removedLines: 0,
      blockedCount: 0,
    });
    const summaries = previewsToSummaries(previews);

    this.sequence += 1;
    return {
      id: this.idFactory(this.sequence),
      mode: input.mode,
      entries,
      createdAt: this.clock(),
      summary: input.output.summary,
      anchors: input.output.anchors.map((anchor) => ({ ...anchor })),
      noteIds: [...(input.noteIds ?? [])],
      addedLines: summaries.reduce((sum, item) => sum + item.addedLines, 0),
      removedLines: summaries.reduce((sum, item) => sum + item.removedLines, 0),
      blockedCount: entries.filter((entry) => entry.blocked).length,
    };
  }

  /** 预览模型（DiffView 直接消费） */
  previews(plan: WritePlan): FilePreview[] {
    return buildPreviews(plan);
  }

  /**
   * 执行计划（事务性）。
   *
   * 步骤：① 重新读取所有待写文件做冲突检测 → ② 逐个原子写 →
   * ③ 任一失败则用快照回滚（含删除本次新建的文件）→ ④ 成功后广播事件。
   */
  async apply(plan: WritePlan): Promise<WriteResult> {
    const targets = plan.entries.filter((entry) => entry.selected && !entry.blocked);
    const skipped = plan.entries.filter((entry) => !entry.selected).map((entry) => entry.path);

    if (targets.length === 0) {
      return { ok: true, planId: plan.id, applied: [], skipped, rolledBack: [], error: null };
    }

    // ① 冲突检测：计划生成时的 before 与当前磁盘必须一致
    for (const entry of targets) {
      const current = (await this.fs.exists(entry.path)) ? await this.fs.readText(entry.path) : null;
      if (current !== entry.before) {
        const reason = `${entry.path} 自上次读取后已被外部修改，已拒绝写入（建议重新生成或回滚到最近提交）`;
        this.logger?.warn('[write-pipeline] 冲突检测拒绝写入', { path: entry.path });
        return { ok: false, planId: plan.id, applied: [], skipped, rolledBack: [], error: reason };
      }
    }

    // ② 逐个写入，同时记录快照
    const applied: string[] = [];
    const snapshots: { path: string; before: string | null }[] = [];

    try {
      for (const entry of targets) {
        if (!entry.changed) continue;
        snapshots.push({ path: entry.path, before: entry.before });
        if (entry.action === 'delete') {
          await this.fs.remove(entry.path);
        } else {
          if (entry.after === null) throw new Error(`${entry.path} 缺少写入内容`);
          if (this.fs.mkdir !== undefined) {
            const directory = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '';
            if (directory.length > 0) await this.fs.mkdir(directory);
          }
          await this.fs.writeAtomic(entry.path, entry.after);
        }
        applied.push(entry.path);
        this.emit({ type: 'file-written', path: entry.path });
      }
    } catch (cause) {
      // ③ 回滚
      const rolledBack: string[] = [];
      for (const snapshot of [...snapshots].reverse()) {
        try {
          if (snapshot.before === null) await this.fs.remove(snapshot.path);
          else await this.fs.writeAtomic(snapshot.path, snapshot.before);
          rolledBack.push(snapshot.path);
        } catch (rollbackError) {
          this.logger?.warn('[write-pipeline] 回滚失败', { path: snapshot.path, error: rollbackError });
        }
      }
      const reason = cause instanceof Error ? cause.message : String(cause);
      this.emit({ type: 'rolled-back', planId: plan.id, paths: rolledBack, reason });
      return { ok: false, planId: plan.id, applied: [], skipped, rolledBack, error: reason };
    }

    // ④ 事件：Git 变更视图刷新 / 预览热更新 / Code Anchor 写回
    this.emit({ type: 'applied', planId: plan.id, paths: applied, anchors: plan.anchors.map((anchor) => ({ ...anchor })) });
    if (plan.anchors.length > 0) {
      this.emit({ type: 'anchors-written', anchors: plan.anchors.map((anchor) => ({ ...anchor })) });
    }

    return { ok: true, planId: plan.id, applied, skipped, rolledBack: [], error: null };
  }

  /** 「要求 AI 重改」：把选择范围与用户意见整理成下一轮生成指令（不落盘） */
  buildReworkInstruction(input: {
    previews: readonly FilePreview[];
    selectedPaths: readonly string[];
    comment: string;
  }): { instruction: string; context: string } {
    const picked = input.previews.filter((preview) => input.selectedPaths.includes(preview.path));
    const context = picked
      .map((preview) => {
        const lines = preview.lines
          .filter((line) => line.kind !== 'context')
          .map((line) => `${line.kind === 'add' ? '+' : '-'}${line.text}`)
          .join('\n');
        return `### ${preview.path}\n${lines.length > 0 ? lines : '（无内容差异）'}`;
      })
      .join('\n\n');

    const instruction = [
      '请针对以下已生成但我不满意的部分重新生成（仍按原输出契约返回完整 JSON）：',
      input.comment.trim().length > 0 ? `修改要求：${input.comment.trim()}` : '修改要求：（未填写，请按更简洁/更符合既有约定的方向调整）',
      `涉及文件：${input.selectedPaths.join('、')}`,
      '',
      '当前差异（供你定位）：',
      context,
    ].join('\n');

    return { instruction, context };
  }
}

export function createWritePipeline(deps: WritePipelineDeps): WritePipeline {
  return new WritePipeline(deps);
}

/** 便捷：从生成结果直接产出计划（外壳/测试常用） */
export async function planFromGeneration(
  pipeline: WritePipeline,
  output: GenerationOutput,
  mode: WriteMode,
  noteIds?: readonly string[],
): Promise<WritePlan> {
  return pipeline.plan({ output, mode, ...(noteIds !== undefined ? { noteIds } : {}) });
}

export type { AnchorDeclaration };
