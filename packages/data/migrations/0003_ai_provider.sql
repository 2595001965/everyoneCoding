-- migration: 0003_ai_provider
-- up

-- Provider（FR-MDL-01）：启用状态、排序、乐观锁版本号、用户手填模型列表。
-- 手填列表是 listModels() 不可用时的回退来源（多数中转不实现 /models 鉴权）。
ALTER TABLE provider ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE provider ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE provider ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE provider ADD COLUMN manual_models_json TEXT NULL;
CREATE INDEX idx_provider_user_enabled ON provider (user_id, enabled);

-- Model（FR-MDL-04）：展示名与乐观锁版本号。
-- 能力矩阵（工具 / 视觉 / 单价 / 人工修正标记）存 capabilities_json，避免列膨胀。
ALTER TABLE model ADD COLUMN display_name TEXT NULL;
ALTER TABLE model ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

-- 用量记录（FR-AI-09）：补充用途与耗时维度，供月度汇总与预算告警。
ALTER TABLE usage_record ADD COLUMN purpose TEXT NULL;
ALTER TABLE usage_record ADD COLUMN latency_ms INTEGER NULL;
CREATE INDEX idx_ur_created ON usage_record (created_at);

-- 用途化模型绑定（FR-MDL-05）：每用户一行，六类用途到 modelId 的映射 + "全部使用默认模型"开关。
CREATE TABLE ai_model_config (
  id                    TEXT PRIMARY KEY NOT NULL,
  user_id               TEXT NOT NULL REFERENCES user (id),
  purpose_bindings_json TEXT NOT NULL DEFAULT '{}',
  use_default_for_all   INTEGER NOT NULL DEFAULT 1,
  default_model_id      TEXT NULL REFERENCES model (id),
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  UNIQUE (user_id)
);
CREATE INDEX idx_amc_user ON ai_model_config (user_id);

-- 用户自配远程配置源（FR-MDL-06 / FR-MDL-13）。
-- 直连用户填写的 URL，不经过任何平台服务端（D-02 / D-06）。
CREATE TABLE remote_config_source (
  id                  TEXT PRIMARY KEY NOT NULL,
  user_id             TEXT NOT NULL REFERENCES user (id),
  name                TEXT NOT NULL,
  url                 TEXT NOT NULL,
  public_key          TEXT NULL,
  enabled             INTEGER NOT NULL DEFAULT 0,
  update_interval_min INTEGER NOT NULL DEFAULT 1440,
  last_fetch_at       INTEGER NULL,
  last_status         TEXT NULL,
  last_error          TEXT NULL,
  last_payload_json   TEXT NULL,
  applied_revision    TEXT NULL,
  acked_revision      TEXT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX idx_rcs_user ON remote_config_source (user_id);

-- down

DROP INDEX idx_rcs_user;
DROP TABLE remote_config_source;
DROP INDEX idx_amc_user;
DROP TABLE ai_model_config;
DROP INDEX idx_ur_created;
ALTER TABLE usage_record DROP COLUMN latency_ms;
ALTER TABLE usage_record DROP COLUMN purpose;
ALTER TABLE model DROP COLUMN version;
ALTER TABLE model DROP COLUMN display_name;
DROP INDEX idx_provider_user_enabled;
ALTER TABLE provider DROP COLUMN manual_models_json;
ALTER TABLE provider DROP COLUMN version;
ALTER TABLE provider DROP COLUMN sort_order;
ALTER TABLE provider DROP COLUMN enabled;
