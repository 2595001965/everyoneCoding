/**
 * 执行器：逻辑结构重算（T7-04 要点 6）。
 *
 * 由逻辑结构扫描器（`occurrence/logic-scanner`）产出的命中还原为 DSL 承载点改写：
 * 节点名 / 变量名 / 绑定路径 / 事件动作目标（`carrierField`）。
 *
 * 每份 DSL 文档处理完节点改名后，调用 `LogicWritePort.recalcSummary` 触发
 * **结构精简与摘要重算**（T2-06），使页面 / 功能记忆里的逻辑结构 JSON 与 DSL 保持一致。
 *
 * 撤销：`stateSnapshots` 保存整份 DSL 改写前快照（DSL 是自有格式，整份还原最稳）。
 */

import type { ExecutionContext, ExecutorInput, ExecutorResult, RenameExecutor, UndoPatch } from './types';
import { emptyResult } from './types';

/** DSL 承载字段（与 `logic-scanner` 的 `carrierField` 对齐） */
export const LOGIC_FIELDS = ['name', 'identifier', 'binding', 'action'] as const;
export type LogicField = (typeof LOGIC_FIELDS)[number];

function asLogicField(value: string | null): LogicField {
  return value !== null && (LOGIC_FIELDS as readonly string[]).includes(value)
    ? (value as LogicField)
    : 'name';
}

export function createLogicRecalcExecutor(): RenameExecutor {
  return {
    id: 'logic-recalc',
    column: 'logic',
    label: '逻辑结构（DSL 节点名 / 绑定 / 动作）',
    apply(input: ExecutorInput, context: ExecutionContext): ExecutorResult {
      const result = emptyResult('logic');
      const changes = input.changes.filter((change) => change.column === 'logic');
      if (changes.length === 0) return result;

      if (context.signal?.aborted === true) {
        result.failures.push('执行被用户中断（未做任何写入）');
        return result;
      }

      const snapshotted = new Map<string, unknown>();
      for (const change of changes) {
        const documentId = change.refPath;
        if (!snapshotted.has(documentId)) {
          let document: unknown;
          try {
            document = context.logic.readDocument(documentId);
          } catch (error) {
            result.failures.push(`读取 DSL 文档 ${documentId} 失败：${String(error)}`);
            return result;
          }
          snapshotted.set(documentId, document);
          result.stateSnapshots.push({ kind: 'logic', id: documentId, payload: document });
        }

        const nodeId = change.carrierId ?? change.refPath;
        const field = asLogicField(change.carrierField);
        try {
          context.logic.rename({
            documentId,
            nodeId,
            field,
            from: change.target,
            to: change.replacement,
          });
        } catch (error) {
          result.failures.push(`重命名 DSL 节点 ${nodeId}（${field}）失败：${String(error)}`);
          return result;
        }

        const undo: UndoPatch = {
          column: 'logic',
          refPath: documentId,
          locator: change.locator,
          from: change.replacement,
          to: change.target,
          carrier: `${nodeId}.${field}`,
        };
        result.undo.push(undo);
        result.applied += 1;
      }

      // 逐文档重算逻辑结构摘要（调用 T2-06 的结构精简）
      for (const documentId of snapshotted.keys()) {
        try {
          context.logic.recalcSummary(documentId);
        } catch (error) {
          result.failures.push(`重算 DSL 文档 ${documentId} 逻辑结构摘要失败：${String(error)}`);
          return result;
        }
      }

      return result;
    },
    revert(result: ExecutorResult, context: ExecutionContext): void {
      for (const snapshot of [...result.stateSnapshots].reverse()) {
        if (snapshot.kind !== 'logic') continue;
        context.logic.restore(snapshot.id, snapshot.payload);
      }
    },
  };
}
