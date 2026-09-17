import type { GeneratedFile } from '../../generate/output-schema';
import type { WritePlanEntry, WorkspaceFileSystem } from '../write-types';
import { planCreate } from './patch';

/**
 * 新建文件策略（T4-05 要点 1：create）。
 *
 * 与 patch 的分工：
 * - `create` 只负责"项目里还没有这个文件"的情况；
 * - 文件已存在时**拒绝**（`blocked = true`），提示改用 patch 或先删除 —— 这是
 *   防"AI 把别人写好的实现整体覆盖掉"的第一道闸门；第二道闸门是 apply 前的冲突检测。
 */

export async function planCreateEntry(
  fs: WorkspaceFileSystem,
  file: GeneratedFile,
  selected: boolean,
): Promise<WritePlanEntry> {
  return planCreate(fs, file, selected);
}

export { planCreate };
