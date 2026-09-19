/**
 * 事务临时区备份（T7-04 要点 2 的"NFR-R-04 原子性"支撑）。
 *
 * 所有文件写操作前，先把原文写进事务临时区（`backupDir`），并把备份路径记进
 * `FileSnapshot.backupPath`。这样：
 * - 本次会话内的回滚 / 撤销靠内存快照（最快）；
 * - 跨会话的撤销（历史里的"撤销"按钮）靠临时区备份文件（`rename_event.changeset_json` 里有路径）；
 * - 临时区目录不可用时**不阻断执行**，只是把 `backupPath` 置 `null` 并记一条警告。
 */

import type { ExecutionContext, FileSnapshot, FileSystemPort } from './types';

/** 备份文件名（路径安全：把 `/` `\` `:` 换成 `_`） */
export function backupFileName(index: number, refPath: string): string {
  const safe = refPath.replace(/[\\/:*?"<>|]/g, '_');
  return `${String(index).padStart(4, '0')}__${safe}.bak`;
}

/** 计数器（同一个事务内多份备份按顺序编号） */
let backupSequence = 0;

/** 重置编号（测试用；事务开始时调用） */
export function resetBackupSequence(): void {
  backupSequence = 0;
}

/**
 * 还原备份内容（跨会话撤销用）。
 *
 * 内存快照优先（`before !== null`）；只有 `before` 缺失时才回读临时区备份。
 * 两者都没有则原样返回（调用方据此跳过该条）。
 */
export function hydrateSnapshot(snapshot: FileSnapshot, files: FileSystemPort): FileSnapshot {
  if (snapshot.before !== null || snapshot.backupPath === null) return snapshot;
  const content = files.read(snapshot.backupPath);
  return content === null ? snapshot : { ...snapshot, before: content };
}

/**
 * 写备份。
 *
 * 返回备份路径；`backupDir` 为 null 或写入失败时返回 null（不阻断执行）。
 */
export function writeBackup(
  context: ExecutionContext,
  refPath: string,
  content: string,
): string | null {
  if (context.backupDir === null) return null;
  const relative = backupFileName(backupSequence, refPath);
  backupSequence += 1;
  const backupPath = `${context.backupDir.replace(/[/\\]+$/, '')}/${relative}`;
  try {
    context.files.write(backupPath, content);
    return backupPath;
  } catch {
    return null;
  }
}
