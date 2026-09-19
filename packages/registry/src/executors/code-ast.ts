/**
 * 执行器：AST 级代码重构（T7-04 要点 3，FR-UNI-06 / E2E-16）。
 *
 * **禁止纯文本替换**：待改位置来自 T7-02 的 AST 解析结果（`file:line:col`），本执行器做三件事：
 *
 * 1. **位置复核**：写入前检查 `content[offset .. offset+len]` 是否**恰好等于**旧符号。
 *    不相等说明索引已过期（位置漂移），此时**判失败并整体回滚**，绝不盲替换——
 *    这是"不误伤同名局部变量与字符串字面量"在写入侧的最后一道防线。
 * 2. **倒序替换**：按偏移量从大到小应用，保证前面的替换不会移动后面替换的坐标。
 * 3. **快照备份**：写入前把原文交给事务（内存快照 + 可选落盘到事务临时区），
 *    因此撤销与失败回滚都不依赖"反向文本替换"的运气。
 *
 * 语言无关：TS/JS 的 AST 由 TypeScript 编译器 API 提供，Python / Java 由内置作用域解析器
 * 提供（见 `occurrence/ast/`），本执行器只消费位置，因此天然支持三语言。
 */

import type {
  ChangeRecord,
  ExecutionContext,
  ExecutorInput,
  ExecutorResult,
  RenameExecutor,
  UndoPatch,
} from './types';
import { emptyResult } from './types';
import { writeBackup } from './backup';

/** 1 基行列 → 0 基偏移；越界返回 null */
export function offsetOf(content: string, line: number, column: number): number | null {
  if (line < 1 || column < 1) return null;
  let currentLine = 1;
  let index = 0;
  while (index < content.length && currentLine < line) {
    if (content[index] === '\n') currentLine += 1;
    index += 1;
  }
  if (currentLine !== line) return null;
  const offset = index + (column - 1);
  return offset > content.length ? null : offset;
}

function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = map.get(k);
    if (bucket === undefined) map.set(k, [item]);
    else bucket.push(item);
  }
  return map;
}

export function createCodeAstExecutor(): RenameExecutor {
  return {
    id: 'code-ast',
    column: 'code',
    label: '代码（AST 级重构）',
    apply(input: ExecutorInput, context: ExecutionContext): ExecutorResult {
      const result = emptyResult('code');
      const changes = input.changes.filter((change) => change.column === 'code');
      if (changes.length === 0) return result;

      if (context.signal?.aborted === true) {
        result.failures.push('执行被用户中断（未做任何写入）');
        return result;
      }

      for (const [refPath, fileChanges] of groupBy(changes, (change) => change.refPath)) {
        let content: string | null;
        try {
          content = context.files.read(refPath);
        } catch (error) {
          result.failures.push(`读取 ${refPath} 失败：${String(error)}`);
          continue;
        }
        if (content === null) {
          result.skipped += fileChanges.length;
          result.warnings.push(`文件不存在，已跳过：${refPath}`);
          continue;
        }

        const edits: { start: number; end: number; change: ChangeRecord }[] = [];
        for (const change of fileChanges) {
          if (change.line === null || change.columnNumber === null) {
            result.failures.push(`${refPath} 「${change.target}」缺少 AST 位置信息，索引需要重建`);
            continue;
          }
          const offset = offsetOf(content, change.line, change.columnNumber);
          if (offset === null) {
            result.failures.push(
              `${refPath}:${change.line}:${change.columnNumber} 位置越界，索引需要重建`,
            );
            continue;
          }
          const actual = content.slice(offset, offset + change.target.length);
          if (actual !== change.target) {
            result.failures.push(
              `${refPath}:${change.line}:${change.columnNumber} 位置漂移（期望「${change.target}」，实际「${actual}」），已终止并整体回滚`,
            );
            continue;
          }
          edits.push({ start: offset, end: offset + change.target.length, change });
        }
        if (result.failures.length > 0) return result;

        // 同一位置只替换一次（同名重复命中）
        const unique = [...new Map(edits.map((edit) => [edit.start, edit])).values()];
        unique.sort((a, b) => b.start - a.start);

        let next = content;
        for (const edit of unique) {
          next = `${next.slice(0, edit.start)}${edit.change.replacement}${next.slice(edit.end)}`;
        }

        const backupPath = writeBackup(context, refPath, content);
        try {
          context.files.write(refPath, next);
        } catch (error) {
          result.failures.push(`写入 ${refPath} 失败：${String(error)}`);
          return result;
        }

        result.snapshots.push({ column: 'code', refPath, before: content, backupPath });
        result.applied += unique.length;
        for (const edit of unique) {
          const undo: UndoPatch = {
            column: 'code',
            refPath,
            locator:
              edit.change.line === null
                ? null
                : `${refPath}:${edit.change.line}:${edit.change.columnNumber ?? 1}`,
            from: edit.change.replacement,
            to: edit.change.target,
            carrier: null,
          };
          result.undo.push(undo);
        }
      }

      return result;
    },
    revert(result: ExecutorResult, context: ExecutionContext): void {
      for (const snapshot of [...result.snapshots].reverse()) {
        if (snapshot.before === null) continue;
        context.files.write(snapshot.refPath, snapshot.before);
      }
    },
  };
}
