/**
 * 执行器：记忆更新（T7-04 要点 5，FR-UNI-08）。
 *
 * 两路更新：
 * - `structured`（逻辑结构 JSON 的字符串叶）：**精确命中**，按 JSON 路径就地改写，置信度 1.0；
 * - `content`（正文提及）：按"第 N 次出现"逐处替换（`MemoryWritePort.replaceInContent` 的
 *   `occurrenceIndex`），**不做全局盲替换**；置信度 <0.8 的条目由影响面面板决定是否勾选，
 *   本执行器只执行传入的变更。
 *
 * 撤销：`stateSnapshots` 保存条目改写前的 `{structured, content}` 全量快照，
 * `revert` 时整条还原——比"反向文本替换"可靠（正文里同一符号可能出现多次）。
 *
 * 作用范围（D-07）：只处理传入的记忆条目（均属当前项目）；长期记忆的提及已在
 * `impact-analyzer.partitionScope` 阶段被剔除。
 */

import type { ExecutionContext, ExecutorInput, ExecutorResult, RenameExecutor, UndoPatch } from './types';
import { emptyResult } from './types';

/** 解析记忆 locator：`<itemId>#structured.<jsonPath>` 或 `<itemId>#content` */
export function parseMemoryLocator(
  itemId: string,
  locator: string | null,
): { field: 'structured' | 'content'; jsonPath: string | null } {
  const prefix = `${itemId}#`;
  const rest = locator !== null && locator.startsWith(prefix) ? locator.slice(prefix.length) : locator ?? '';
  if (rest.startsWith('structured.')) {
    return { field: 'structured', jsonPath: rest.slice('structured.'.length) };
  }
  return { field: 'content', jsonPath: null };
}

export function createMemoryUpdateExecutor(): RenameExecutor {
  return {
    id: 'memory-update',
    column: 'memory',
    label: '记忆（逻辑结构 JSON + 正文提及）',
    apply(input: ExecutorInput, context: ExecutionContext): ExecutorResult {
      const result = emptyResult('memory');
      const changes = input.changes.filter((change) => change.column === 'memory');
      if (changes.length === 0) return result;

      if (context.signal?.aborted === true) {
        result.failures.push('执行被用户中断（未做任何写入）');
        return result;
      }

      const snapshotted = new Set<string>();
      const contentCounter = new Map<string, number>();

      for (const change of changes) {
        const itemId = change.refPath;
        if (!snapshotted.has(itemId)) {
          let current: { structured: unknown; content: string } | null = null;
          try {
            current = context.memory.read(itemId);
          } catch (error) {
            result.failures.push(`读取记忆 ${itemId} 失败：${String(error)}`);
            return result;
          }
          if (current === null) {
            result.skipped += 1;
            result.warnings.push(`记忆条目不存在，已跳过：${itemId}`);
            continue;
          }
          snapshotted.add(itemId);
          result.stateSnapshots.push({ kind: 'memory', id: itemId, payload: current });
        }

        const parsed = parseMemoryLocator(itemId, change.locator);
        try {
          if (parsed.field === 'structured' && parsed.jsonPath !== null) {
            context.memory.setStructured(itemId, parsed.jsonPath, change.replacement);
          } else {
            const index = contentCounter.get(itemId) ?? 0;
            context.memory.replaceInContent(itemId, change.target, change.replacement, index);
            contentCounter.set(itemId, index + 1);
          }
        } catch (error) {
          result.failures.push(`更新记忆 ${itemId}（${change.locator ?? '正文'}）失败：${String(error)}`);
          return result;
        }

        const undo: UndoPatch = {
          column: 'memory',
          refPath: itemId,
          locator: change.locator,
          from: change.replacement,
          to: change.target,
          carrier: parsed.field === 'structured' ? `structured.${parsed.jsonPath ?? ''}` : 'content',
        };
        result.undo.push(undo);
        result.applied += 1;
      }

      return result;
    },
    revert(result: ExecutorResult, context: ExecutionContext): void {
      for (const snapshot of [...result.stateSnapshots].reverse()) {
        if (snapshot.kind !== 'memory') continue;
        const payload = snapshot.payload as { structured: unknown; content: string } | null;
        if (payload === null) continue;
        context.memory.restore(snapshot.id, payload);
      }
    },
  };
}
