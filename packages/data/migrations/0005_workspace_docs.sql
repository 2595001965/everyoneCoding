-- migration: 0005_workspace_docs
-- up

-- Wave 9：工作台（T9-01）与文档（T9-04）字段扩展

-- 项目表：目标端 / 技术栈指纹 / Git 远程 / 收藏与最近打开 / 回收站 / 来源
ALTER TABLE project ADD COLUMN target_platforms TEXT NOT NULL DEFAULT '[]';
ALTER TABLE project ADD COLUMN tech_stack_fingerprint TEXT NULL;
ALTER TABLE project ADD COLUMN git_remote TEXT NULL;
ALTER TABLE project ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE project ADD COLUMN last_opened_at INTEGER NULL;
ALTER TABLE project ADD COLUMN deleted_at INTEGER NULL;
ALTER TABLE project ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'blank';
ALTER TABLE project ADD COLUMN source_ref TEXT NULL;
CREATE INDEX idx_project_deleted ON project (deleted_at);

-- 文档表：格式 / 提取正文 / 标题层级 / 来源 / 回收站 / 已忽略的版本提示
ALTER TABLE document ADD COLUMN format TEXT NOT NULL DEFAULT 'markdown';
ALTER TABLE document ADD COLUMN content_text TEXT NULL;
ALTER TABLE document ADD COLUMN sections_json TEXT NULL;
ALTER TABLE document ADD COLUMN source_ref TEXT NULL;
ALTER TABLE document ADD COLUMN deleted_at INTEGER NULL;
ALTER TABLE document ADD COLUMN ignored_version INTEGER NULL;
CREATE INDEX idx_document_deleted ON document (deleted_at);

-- 文档版本（FR-DOC-05）：修改后保留历史版本，供关联记忆展示"文档已更新"
CREATE TABLE doc_version (
  id            TEXT PRIMARY KEY NOT NULL,
  document_id   TEXT NOT NULL REFERENCES document (id),
  version       INTEGER NOT NULL,
  title         TEXT NOT NULL,
  content_text  TEXT NULL,
  sections_json TEXT NULL,
  created_by    TEXT NOT NULL DEFAULT 'user',
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_doc_version_doc ON doc_version (document_id);

-- down
DROP INDEX IF EXISTS idx_doc_version_doc;
DROP TABLE IF EXISTS doc_version;
DROP INDEX IF EXISTS idx_document_deleted;
ALTER TABLE document DROP COLUMN ignored_version;
ALTER TABLE document DROP COLUMN deleted_at;
ALTER TABLE document DROP COLUMN source_ref;
ALTER TABLE document DROP COLUMN sections_json;
ALTER TABLE document DROP COLUMN content_text;
ALTER TABLE document DROP COLUMN format;
DROP INDEX IF EXISTS idx_project_deleted;
ALTER TABLE project DROP COLUMN source_ref;
ALTER TABLE project DROP COLUMN source_kind;
ALTER TABLE project DROP COLUMN deleted_at;
ALTER TABLE project DROP COLUMN last_opened_at;
ALTER TABLE project DROP COLUMN pinned;
ALTER TABLE project DROP COLUMN git_remote;
ALTER TABLE project DROP COLUMN tech_stack_fingerprint;
ALTER TABLE project DROP COLUMN target_platforms;
