/**
 * 执行器：文档替换（T7-04 要点 4，FR-UNI-09）。
 *
 * 需求文档 / 技术文档 / 关联文档中对旧名的提及**逐处同步**修改，并保留修订记录：
 * - `showRevisionMarks = true` → 写入 `新名〔原：旧名〕`，用户可切换显示 / 隐藏；
 * - `showRevisionMarks = false` → 写入"干净"的新名。
 *
 * 与代码侧不同，文档是自然语言，**不能**用标识符作用域约束（中文提及往往紧贴上下文，
 * 例如「点击用户登录按钮提交」）；因此这里对**中文与整串符号**做子串替换，
 * 对**纯 ASCII 标识符**加词边界保护（避免 `userLoginButtonX` 被误改）。
 *
 * 替换范围仍严格限定在"索引已确认提及该符号的文档 + 文档内该符号的文本"，
 * 不做跨文档 / 跨项目的全局替换（D-07）。
 */

import type {
  ExecutionContext,
  ExecutorInput,
  ExecutorResult,
  RenameExecutor,
  UndoPatch,
} from './types';
import { emptyResult } from './types';
import { writeBackup } from './backup';

const ASCII_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** 渲染修订标记（FR-UNI-09 的"显示 / 隐藏修订标记"） */
export function renderDocReplacement(
  oldText: string,
  newText: string,
  showRevisionMarks: boolean,
): string {
  return showRevisionMarks ? `${newText}〔原：${oldText}〕` : newText;
}

/**
 * 在文本中替换符号。
 *
 * - 纯 ASCII 标识符：要求两侧不是标识符字符（词边界保护）；
 * - 其他（中文 / 含点号的路由与 i18n key）：直接子串替换。
 */
export function replaceSymbol(
  content: string,
  target: string,
  replacement: string,
): { content: string; count: number } {
  if (target.length === 0) return { content, count: 0 };
  const boundary = ASCII_IDENTIFIER.test(target);
  let out = '';
  let cursor = 0;
  let count = 0;
  while (cursor < content.length) {
    const index = content.indexOf(target, cursor);
    if (index < 0) break;
    const before = index > 0 ? content[index - 1] : undefined;
    const after = content[index + target.length];
    if (
      boundary &&
      ((before !== undefined && /[A-Za-z0-9_$]/.test(before)) ||
        (after !== undefined && /[A-Za-z0-9_$]/.test(after)))
    ) {
      out += content.slice(cursor, index + target.length);
      cursor = index + target.length;
      continue;
    }
    out += `${content.slice(cursor, index)}${replacement}`;
    cursor = index + target.length;
    count += 1;
  }
  out += content.slice(cursor);
  return { content: out, count };
}

export function createDocReplaceExecutor(): RenameExecutor {
  return {
    id: 'doc-replace',
    column: 'doc',
    label: '文档（需求 / 技术 / 关联文档）',
    apply(input: ExecutorInput, context: ExecutionContext): ExecutorResult {
      const result = emptyResult('doc');
      const changes = input.changes.filter((change) => change.column === 'doc');
      if (changes.length === 0) return result;

      if (context.signal?.aborted === true) {
        result.failures.push('执行被用户中断（未做任何写入）');
        return result;
      }

      const byDocument = new Map<string, typeof changes>();
      for (const change of changes) {
        const bucket = byDocument.get(change.refPath);
        if (bucket === undefined) byDocument.set(change.refPath, [change]);
        else bucket.push(change);
      }

      for (const [documentId, documentChanges] of byDocument) {
        let content: string | null;
        try {
          content = context.docs.read(documentId);
        } catch (error) {
          result.failures.push(`读取文档 ${documentId} 失败：${String(error)}`);
          continue;
        }
        if (content === null) {
          result.skipped += documentChanges.length;
          result.warnings.push(`文档不存在，已跳过：${documentId}`);
          continue;
        }

        let next = content;
        const undo: UndoPatch[] = [];
        let applied = 0;
        // 同一符号在文档内只做一次整篇替换（索引可能给出多个段落命中）
        const seen = new Set<string>();
        for (const change of documentChanges) {
          if (seen.has(change.target)) continue;
          seen.add(change.target);
          const replacement = renderDocReplacement(
            change.target,
            change.replacement,
            context.showRevisionMarks,
          );
          const replaced = replaceSymbol(next, change.target, replacement);
          if (replaced.count === 0) {
            result.skipped += 1;
            result.warnings.push(
              `文档 ${documentId} 中未再找到「${change.target}」（索引可能已过期）`,
            );
            continue;
          }
          next = replaced.content;
          applied += replaced.count;
          undo.push({
            column: 'doc',
            refPath: documentId,
            locator: change.locator,
            from: replacement,
            to: change.target,
            carrier: `occurrences=${replaced.count}`,
          });
        }

        if (applied === 0) continue;
        const backupPath = writeBackup(context, `docs/${documentId}`, content);
        try {
          context.docs.write(documentId, next);
        } catch (error) {
          result.failures.push(`写入文档 ${documentId} 失败：${String(error)}`);
          return result;
        }
        result.snapshots.push({ column: 'doc', refPath: documentId, before: content, backupPath });
        result.undo.push(...undo);
        result.applied += applied;
      }

      return result;
    },
    revert(result: ExecutorResult, context: ExecutionContext): void {
      for (const snapshot of [...result.snapshots].reverse()) {
        if (snapshot.before === null) continue;
        context.docs.write(snapshot.refPath, snapshot.before);
      }
    },
  };
}
