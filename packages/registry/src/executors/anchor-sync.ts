/**
 * 执行器：Code Anchor 同步（T7-04 要点 6 末段 / FR-NAV-04）。
 *
 * 重命名后若不同步锚点，Ctrl + 点击跳转就会指向已不存在的符号。锚点按**符号文本**索引
 * （`AnchorSyncPort.findBySymbol`），因此本执行器消费的是符号替换对而不是出现位置：
 *
 * ```
 * for each (from → to) in symbolPairs:
 *   for each anchorId in anchors.findBySymbol(from):
 *     校验锚点当前符号确实等于 from（漂移则跳过并告警），然后 update(anchorId, to)
 * ```
 *
 * 撤销：`stateSnapshots` 保存每个锚点的旧符号，`revert` 时逐个还原。
 */

import type {
  ExecutionContext,
  ExecutorInput,
  ExecutorResult,
  RenameExecutor,
  UndoPatch,
} from './types';
import { emptyResult } from './types';

export function createAnchorSyncExecutor(): RenameExecutor {
  return {
    id: 'anchor-sync',
    column: 'logic',
    label: '注册表与 Code Anchor 同步',
    apply(input: ExecutorInput, context: ExecutionContext): ExecutorResult {
      const result = emptyResult('logic');
      if (input.symbolPairs.length === 0) return result;

      if (context.signal?.aborted === true) {
        result.failures.push('执行被用户中断（未做任何写入）');
        return result;
      }

      const handled = new Set<string>();
      for (const pair of input.symbolPairs) {
        if (pair.from === pair.to || pair.from.length === 0) continue;
        let anchorIds: readonly string[];
        try {
          anchorIds = context.anchors.findBySymbol(pair.from);
        } catch (error) {
          result.failures.push(`查询锚点（符号「${pair.from}」）失败：${String(error)}`);
          return result;
        }
        for (const anchorId of anchorIds) {
          if (handled.has(anchorId)) continue;
          let current: string | null;
          try {
            current = context.anchors.read(anchorId);
          } catch (error) {
            result.failures.push(`读取锚点 ${anchorId} 失败：${String(error)}`);
            return result;
          }
          if (current === null) {
            result.skipped += 1;
            result.warnings.push(`锚点不存在，已跳过：${anchorId}`);
            continue;
          }
          if (current !== pair.from) {
            result.skipped += 1;
            result.warnings.push(
              `锚点 ${anchorId} 当前符号为「${current}」而非「${pair.from}」（锚点漂移，未改动）`,
            );
            continue;
          }
          try {
            context.anchors.update(anchorId, pair.to);
          } catch (error) {
            result.failures.push(`更新锚点 ${anchorId} 失败：${String(error)}`);
            return result;
          }
          handled.add(anchorId);
          result.stateSnapshots.push({ kind: 'anchor', id: anchorId, payload: current });
          const undo: UndoPatch = {
            column: 'logic',
            refPath: anchorId,
            locator: null,
            from: pair.to,
            to: pair.from,
            carrier: anchorId,
          };
          result.undo.push(undo);
          result.applied += 1;
        }
      }

      return result;
    },
    revert(result: ExecutorResult, context: ExecutionContext): void {
      for (const snapshot of [...result.stateSnapshots].reverse()) {
        if (snapshot.kind !== 'anchor') continue;
        const payload = snapshot.payload;
        if (typeof payload !== 'string') continue;
        context.anchors.restore(snapshot.id, payload);
      }
    },
  };
}
