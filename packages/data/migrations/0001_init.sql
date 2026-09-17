-- migration: 0001_init
-- up

-- 用户
CREATE TABLE user (
  id            TEXT PRIMARY KEY NOT NULL,
  login         TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  avatar_ref    TEXT NULL,
  role          TEXT NOT NULL DEFAULT 'owner',
  settings_json TEXT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (login)
);
CREATE INDEX idx_user_login ON user (login);

-- 工作区
CREATE TABLE workspace (
  id         TEXT PRIMARY KEY NOT NULL,
  user_id    TEXT NOT NULL REFERENCES user (id),
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'personal',
  config_json TEXT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_workspace_user ON workspace (user_id);

-- 项目
CREATE TABLE project (
  id           TEXT PRIMARY KEY NOT NULL,
  user_id      TEXT NOT NULL REFERENCES user (id),
  workspace_id TEXT NULL REFERENCES workspace (id),
  name         TEXT NOT NULL,
  description  TEXT NULL,
  tech_stack_json TEXT NULL,
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_project_user ON project (user_id);
CREATE INDEX idx_project_workspace ON project (workspace_id);

-- 功能
CREATE TABLE feature (
  id          TEXT PRIMARY KEY NOT NULL,
  project_id  TEXT NOT NULL REFERENCES project (id),
  name        TEXT NOT NULL,
  description TEXT NULL,
  status      TEXT NOT NULL DEFAULT 'planned',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_feature_project ON feature (project_id);

-- 页面
CREATE TABLE page (
  id          TEXT PRIMARY KEY NOT NULL,
  project_id  TEXT NOT NULL REFERENCES project (id),
  feature_id  TEXT NULL REFERENCES feature (id),
  name        TEXT NOT NULL,
  route       TEXT NULL,
  dsl_ref     TEXT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_page_project ON page (project_id);
CREATE INDEX idx_page_feature ON page (feature_id);

-- 笔记 / 注释
CREATE TABLE note (
  id          TEXT PRIMARY KEY NOT NULL,
  project_id  TEXT NOT NULL REFERENCES project (id),
  page_id     TEXT NULL REFERENCES page (id),
  title       TEXT NULL,
  content     TEXT NULL,
  kind        TEXT NOT NULL DEFAULT 'note',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_note_project ON note (project_id);
CREATE INDEX idx_note_page ON note (page_id);

-- 设计器元素
CREATE TABLE element (
  id           TEXT PRIMARY KEY NOT NULL,
  page_id      TEXT NOT NULL REFERENCES page (id),
  parent_id    TEXT NULL REFERENCES element (id),
  type         TEXT NOT NULL,
  name         TEXT NOT NULL,
  props_json   TEXT NULL,
  style_json   TEXT NULL,
  feature_ref  TEXT NULL REFERENCES feature (id),
  note_id      TEXT NULL REFERENCES note (id),
  order_index  INTEGER NOT NULL DEFAULT 0,
  anchor_json  TEXT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_element_page ON element (page_id);
CREATE INDEX idx_element_parent ON element (parent_id);
CREATE INDEX idx_element_feature ON element (feature_ref);
CREATE INDEX idx_element_note ON element (note_id);

-- 文档
CREATE TABLE document (
  id           TEXT PRIMARY KEY NOT NULL,
  project_id   TEXT NOT NULL REFERENCES project (id),
  kind         TEXT NOT NULL DEFAULT 'requirement',
  title        TEXT NOT NULL,
  content_ref  TEXT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_document_project ON document (project_id);

-- 记忆条目
CREATE TABLE memory_item (
  id           TEXT PRIMARY KEY NOT NULL,
  user_id      TEXT NOT NULL REFERENCES user (id),
  scope        TEXT NOT NULL,
  project_id   TEXT NULL REFERENCES project (id),
  feature_id   TEXT NULL REFERENCES feature (id),
  page_id      TEXT NULL REFERENCES page (id),
  element_id   TEXT NULL REFERENCES element (id),
  issue_id     TEXT NULL,
  title        TEXT NOT NULL,
  content      TEXT NOT NULL DEFAULT '',
  structured   TEXT NULL,
  tags         TEXT NOT NULL DEFAULT '[]',
  source_type  TEXT NOT NULL,
  source_ref   TEXT NULL,
  confidence   REAL NOT NULL DEFAULT 1.0,
  importance   INTEGER NOT NULL DEFAULT 3,
  status       TEXT NOT NULL DEFAULT 'active',
  pinned       INTEGER NOT NULL DEFAULT 0,
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  embedding    BLOB NULL
);
CREATE INDEX idx_memory_user ON memory_item (user_id);
CREATE INDEX idx_memory_scope_project ON memory_item (scope, project_id);
CREATE INDEX idx_memory_feature ON memory_item (feature_id);
CREATE INDEX idx_memory_page ON memory_item (page_id);
CREATE INDEX idx_memory_element ON memory_item (element_id);

-- 文档-记忆关联
CREATE TABLE memory_doc_link (
  id          TEXT PRIMARY KEY NOT NULL,
  memory_id   TEXT NOT NULL REFERENCES memory_item (id),
  document_id TEXT NOT NULL REFERENCES document (id),
  link_type   TEXT NOT NULL DEFAULT 'related',
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_mdl_memory ON memory_doc_link (memory_id);
CREATE INDEX idx_mdl_doc ON memory_doc_link (document_id);

-- 代码锚点
CREATE TABLE code_anchor (
  id          TEXT PRIMARY KEY NOT NULL,
  project_id  TEXT NOT NULL REFERENCES project (id),
  element_id  TEXT NULL REFERENCES element (id),
  page_id     TEXT NULL REFERENCES page (id),
  feature_id  TEXT NULL REFERENCES feature (id),
  file_path   TEXT NOT NULL,
  symbol      TEXT NULL,
  start_line  INTEGER NULL,
  end_line    INTEGER NULL,
  kind        TEXT NOT NULL,
  commit_sha  TEXT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_ca_project ON code_anchor (project_id);
CREATE INDEX idx_ca_element ON code_anchor (element_id);
CREATE INDEX idx_ca_page ON code_anchor (page_id);
CREATE INDEX idx_ca_feature ON code_anchor (feature_id);
CREATE INDEX idx_ca_file ON code_anchor (file_path);

-- 流水线运行
CREATE TABLE pipeline_run (
  id            TEXT PRIMARY KEY NOT NULL,
  project_id    TEXT NOT NULL REFERENCES project (id),
  stage         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  artifact_type TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  content_ref   TEXT NULL,
  diff_ref      TEXT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_pr_project ON pipeline_run (project_id);
CREATE INDEX idx_pr_stage ON pipeline_run (stage);

-- 阶段产物
CREATE TABLE stage_artifact (
  id            TEXT PRIMARY KEY NOT NULL,
  run_id        TEXT NOT NULL REFERENCES pipeline_run (id),
  project_id    TEXT NOT NULL REFERENCES project (id),
  stage         TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  content_ref   TEXT NULL,
  diff_ref      TEXT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_sa_run ON stage_artifact (run_id);
CREATE INDEX idx_sa_project ON stage_artifact (project_id);

-- 模型供应商
CREATE TABLE provider (
  id               TEXT PRIMARY KEY NOT NULL,
  user_id          TEXT NOT NULL REFERENCES user (id),
  name             TEXT NOT NULL,
  protocol         TEXT NOT NULL DEFAULT 'openai',
  base_url         TEXT NOT NULL,
  api_key_ref      TEXT NULL REFERENCES secure_ref (id),
  headers_json     TEXT NULL,
  default_timeout  INTEGER NOT NULL DEFAULT 30000,
  supports_stream  INTEGER NOT NULL DEFAULT 0,
  supports_tools   INTEGER NOT NULL DEFAULT 0,
  supports_vision  INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX idx_provider_user ON provider (user_id);

-- 模型
CREATE TABLE model (
  id              TEXT PRIMARY KEY NOT NULL,
  provider_id     TEXT NOT NULL REFERENCES provider (id),
  name            TEXT NOT NULL,
  context_window  INTEGER NULL,
  max_output      INTEGER NULL,
  capabilities_json TEXT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_model_provider ON model (provider_id);

-- 用量记录
CREATE TABLE usage_record (
  id              TEXT PRIMARY KEY NOT NULL,
  user_id         TEXT NOT NULL REFERENCES user (id),
  provider_id     TEXT NULL REFERENCES provider (id),
  model_id        TEXT NULL REFERENCES model (id),
  project_id      TEXT NULL REFERENCES project (id),
  prompt_tokens   INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens    INTEGER NOT NULL DEFAULT 0,
  cost            REAL NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_ur_user ON usage_record (user_id);
CREATE INDEX idx_ur_project ON usage_record (project_id);
CREATE INDEX idx_ur_model ON usage_record (model_id);

-- 统一标识注册表（M15）
CREATE TABLE registry_entry (
  id                TEXT PRIMARY KEY NOT NULL,
  project_id        TEXT NOT NULL REFERENCES project (id),
  entity_type       TEXT NOT NULL,
  entity_id         TEXT NOT NULL,
  canonical_name    TEXT NOT NULL,
  projections_json  TEXT NULL,
  aliases_json      TEXT NULL,
  naming_rule_id    TEXT NULL,
  name_history_json TEXT NULL,
  sync_state        TEXT NOT NULL DEFAULT 'synced',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX idx_reg_project ON registry_entry (project_id);
CREATE INDEX idx_reg_entity ON registry_entry (entity_type, project_id);

-- 出现位置索引（M15）
CREATE TABLE occurrence (
  id              TEXT PRIMARY KEY NOT NULL,
  registry_id     TEXT NOT NULL REFERENCES registry_entry (id),
  kind            TEXT NOT NULL,
  ref_path        TEXT NOT NULL,
  locator         TEXT NULL,
  matched_symbol  TEXT NULL,
  confidence      REAL NOT NULL DEFAULT 1.0,
  risk_level      TEXT NOT NULL DEFAULT 'auto',
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_occ_registry ON occurrence (registry_id);
CREATE INDEX idx_occ_ref ON occurrence (ref_path);

-- 重命名事件（M15）
CREATE TABLE rename_event (
  id          TEXT PRIMARY KEY NOT NULL,
  project_id  TEXT NOT NULL REFERENCES project (id),
  registry_id TEXT NOT NULL REFERENCES registry_entry (id),
  old_name    TEXT NOT NULL,
  new_name    TEXT NOT NULL,
  changeset_json TEXT NULL,
  scope       TEXT NOT NULL DEFAULT 'project',
  commit_sha  TEXT NULL,
  undone      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_re_project ON rename_event (project_id);
CREATE INDEX idx_re_registry ON rename_event (registry_id);

-- 归档/迁移任务（M14）
CREATE TABLE package_job (
  id              TEXT PRIMARY KEY NOT NULL,
  direction       TEXT NOT NULL,
  scope           TEXT NULL,
  includes_json   TEXT NULL,
  excludes_json   TEXT NULL,
  file_path       TEXT NULL,
  format_version  TEXT NULL,
  encryption      TEXT NULL,
  redacted        INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'running',
  counts_json     TEXT NULL,
  error_log_ref   TEXT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_pj_status ON package_job (status);

-- 设置
CREATE TABLE setting (
  id          TEXT PRIMARY KEY NOT NULL,
  user_id     TEXT NOT NULL REFERENCES user (id),
  key         TEXT NOT NULL,
  value_json  TEXT NULL,
  value_text  TEXT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (user_id, key)
);
CREATE INDEX idx_setting_user_key ON setting (user_id, key);

-- 敏感引用（DPAPI 加密后的引用）
CREATE TABLE secure_ref (
  id          TEXT PRIMARY KEY NOT NULL,
  user_id     TEXT NOT NULL REFERENCES user (id),
  kind        TEXT NOT NULL,
  ref_path    TEXT NOT NULL,
  digest      TEXT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_secure_user ON secure_ref (user_id);

-- down

DROP TABLE secure_ref;
DROP TABLE setting;
DROP TABLE package_job;
DROP TABLE rename_event;
DROP TABLE occurrence;
DROP TABLE registry_entry;
DROP TABLE usage_record;
DROP TABLE model;
DROP TABLE provider;
DROP TABLE stage_artifact;
DROP TABLE pipeline_run;
DROP TABLE code_anchor;
DROP TABLE memory_doc_link;
DROP TABLE memory_item;
DROP TABLE document;
DROP TABLE element;
DROP TABLE note;
DROP TABLE page;
DROP TABLE feature;
DROP TABLE project;
DROP TABLE workspace;
DROP TABLE user;
