/**
 * 执行器出口（T7-04 要点 2）。
 *
 * 执行顺序即 PRD §15.2 ⑤ 的事务顺序：
 * `code-ast` → `doc-replace` → `memory-update` → `logic-recalc` → `anchor-sync`
 *
 * 顺序不可交换：
 * - 代码先行，若位置漂移立即中止（不改任何文档 / 记忆，回滚面最小）；
 * - 文档与记忆随后（纯文本层）；
 * - 逻辑结构重算需要 DSL 已改名；
 * - 锚点最后，因为它按"符号"工作，必须等所有符号落地后再对齐（FR-NAV-04）。
 */

import { createAnchorSyncExecutor } from './anchor-sync';
import { createCodeAstExecutor } from './code-ast';
import { createDocReplaceExecutor } from './doc-replace';
import { createLogicRecalcExecutor } from './logic-recalc';
import { createMemoryUpdateExecutor } from './memory-update';
import type { ExecutorId, RenameExecutor } from './types';

export * from './types';
export * from './backup';
export * from './code-ast';
export * from './doc-replace';
export * from './memory-update';
export * from './logic-recalc';
export * from './anchor-sync';

/** 事务执行顺序（固定） */
export const EXECUTION_ORDER: readonly ExecutorId[] = [
  'code-ast',
  'doc-replace',
  'memory-update',
  'logic-recalc',
  'anchor-sync',
];

/** 五个执行器的默认装配（顺序与 `EXECUTION_ORDER` 一致） */
export function createDefaultExecutors(): RenameExecutor[] {
  return [
    createCodeAstExecutor(),
    createDocReplaceExecutor(),
    createMemoryUpdateExecutor(),
    createLogicRecalcExecutor(),
    createAnchorSyncExecutor(),
  ];
}

/** 按 id 取名（UI 与测试断言用） */
export function findExecutor(
  executors: readonly RenameExecutor[],
  id: ExecutorId,
): RenameExecutor | null {
  return executors.find((executor) => executor.id === id) ?? null;
}
