-- migration: 0001_init
-- up

-- 用户：邮箱注册用户含 password_hash；OAuth 建号用户 password_hash 为 NULL
CREATE TABLE account_user (
  id            TEXT PRIMARY KEY NOT NULL,
  email         TEXT NULL,
  password_hash TEXT NULL,
  display_name  TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (email)
);
CREATE INDEX idx_account_user_email ON account_user (email);

-- 工作区：自注册即开通一个默认「个人工作区」，绑定免费权益包(free)
CREATE TABLE account_workspace (
  id         TEXT PRIMARY KEY NOT NULL,
  owner_id   TEXT NOT NULL REFERENCES account_user (id),
  name       TEXT NOT NULL,
  plan_id    TEXT NOT NULL DEFAULT 'free',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_account_workspace_owner ON account_workspace (owner_id);

-- 第三方身份绑定
CREATE TABLE account_binding (
  id                TEXT PRIMARY KEY NOT NULL,
  user_id           TEXT NOT NULL REFERENCES account_user (id),
  provider          TEXT NOT NULL,
  provider_user_id  TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  UNIQUE (provider, provider_user_id)
);
CREATE INDEX idx_account_binding_user ON account_binding (user_id);

-- 刷新令牌：用于轮换，revoked=1 表示已失效
CREATE TABLE account_refresh_token (
  jti        TEXT PRIMARY KEY NOT NULL,
  user_id    TEXT NOT NULL REFERENCES account_user (id),
  revoked    INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_account_refresh_user ON account_refresh_token (user_id);

-- 幂等键记录：写接口重复提交返回首次响应
CREATE TABLE account_idempotency (
  key          TEXT PRIMARY KEY NOT NULL,
  status_code  INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

-- 匿名用量上报（仅聚合信息，不含内容）
CREATE TABLE account_usage_report (
  id           TEXT PRIMARY KEY NOT NULL,
  user_id      TEXT NOT NULL REFERENCES account_user (id),
  payload_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_account_usage_user ON account_usage_report (user_id);

-- 审计日志（脱敏后写入）
CREATE TABLE account_audit_log (
  id         TEXT PRIMARY KEY NOT NULL,
  action     TEXT NOT NULL,
  detail     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_account_audit_created ON account_audit_log (created_at);

-- down

DROP TABLE account_audit_log;
DROP TABLE account_usage_report;
DROP TABLE account_idempotency;
DROP TABLE account_refresh_token;
DROP TABLE account_binding;
DROP TABLE account_workspace;
DROP TABLE account_user;
