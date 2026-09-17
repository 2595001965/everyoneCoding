import type { MemoryItem } from '../domain/memory-item';
import type { MemoryRepo } from '../repo/memory-repo';
import { exportJson, exportJsonl, type ExportMeta } from './export-json';
import { exportMarkdown, type ExportedMarkdownFile } from './export-markdown';

/**
 * 便捷门面：直接从仓库导出全量记忆。
 *
 * 用 `repo.list({ userId, projectId })` 取全量（**不按 `status` 筛选**，导出应包含
 * 归档条目），再按 `format` 转成对应产物。
 *
 * - `format: 'json'` / `'jsonl'` → `{ json: string }`；
 * - `format: 'markdown'` → `{ files: ExportedMarkdownFile[] }`（不写磁盘）。
 */
export function exportAll(
  repo: MemoryRepo,
  options: { userId: string; projectId?: string | null; format: 'json' | 'jsonl' | 'markdown' },
): { files: ExportedMarkdownFile[] } | { json: string } {
  const items: MemoryItem[] = repo.list({ userId: options.userId, projectId: options.projectId ?? null });
  const meta: ExportMeta = { userId: options.userId, projectId: options.projectId ?? null };

  switch (options.format) {
    case 'json':
      return { json: exportJson(items, meta) };
    case 'jsonl':
      return { json: exportJsonl(items) };
    case 'markdown':
      return { files: exportMarkdown(items) };
  }
}
