/**
 * 文档版本与"已更新"提示（T9-04 / FR-DOC-05）。
 *
 * 语义（对齐迁移 `doc_version` 与 `document.ignored_version`）：
 * - `document.version` 为当前版本号，编辑后 +1 并写入一条 `doc_version` 快照；
 * - 关联记忆显示"文档已更新"当 `version > 1` 且用户尚未忽略该版本；
 * - 忽略（`ignoreVersion`）把 `ignored_version` 置为当前版本号，提示消失；
 *   之后若再产生更高版本，提示重新出现（忽略只针对"当时"的版本）。
 */

import type {
  DocSection,
  DocVersionAuthor,
  DocVersionRowSnapshot,
  DocumentRowSnapshot,
} from './doc-types';

/** "文档已更新"提示状态 */
export interface DocUpdateStatus {
  /** 相对关联记忆是否有更新（可提示） */
  updated: boolean;
  currentVersion: number;
  /** 已忽略的版本号（null 表示从未忽略） */
  ignoredVersion: number | null;
  ignored: boolean;
}

export function evaluateUpdateStatus(doc: {
  version: number;
  ignoredVersion: number | null;
}): DocUpdateStatus {
  const ignored = doc.ignoredVersion !== null && doc.ignoredVersion >= doc.version;
  const updated = doc.version > 1 && !ignored;
  return { updated, currentVersion: doc.version, ignoredVersion: doc.ignoredVersion, ignored };
}

/** 由当前文档行构建一条版本快照（写入 doc_version），created_by 标记来源 */
export function buildVersionSnapshot(params: {
  doc: DocumentRowSnapshot;
  sections: DocSection[];
  contentText: string | null;
  createdBy: DocVersionAuthor;
  id: string;
  createdAt: number;
}): DocVersionRowSnapshot {
  return {
    id: params.id,
    document_id: params.doc.id,
    version: params.doc.version,
    title: params.doc.title,
    content_text: params.contentText ?? params.doc.content_text,
    sections_json: JSON.stringify(params.sections),
    created_by: params.createdBy,
    created_at: params.createdAt,
  };
}

/** 编辑后计算下一版本号（当前 +1，最小为 2） */
export function nextVersion(current: number): number {
  return Math.max(2, current + 1);
}
