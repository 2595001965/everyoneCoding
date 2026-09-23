-- migration: 0002_email_verification
-- up

-- 邮箱验证状态（FR-ACC-08）：注册/OAuth 建号默认未验证；可配置为不强制验证即可使用
ALTER TABLE account_user ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;

-- 邮箱验证 / 重置密码令牌：kind = 'verify' | 'reset'，used_at 非空表示已消费（单次有效）
CREATE TABLE account_email_token (
  id          TEXT PRIMARY KEY NOT NULL,
  user_id     TEXT NOT NULL REFERENCES account_user (id),
  kind        TEXT NOT NULL,
  token_hash  TEXT NOT NULL,
  code        TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_account_email_token_user ON account_email_token (user_id, kind);
CREATE INDEX idx_account_email_token_hash ON account_email_token (token_hash);

-- down

DROP TABLE account_email_token;
-- SQLite 3.35+ 支持 DROP COLUMN；为兼容旧版本按重建方式回滚
ALTER TABLE account_user RENAME TO account_user_old;
CREATE TABLE account_user (
  id            TEXT PRIMARY KEY NOT NULL,
  email         TEXT NULL,
  password_hash TEXT NULL,
  display_name  TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (email)
);
INSERT INTO account_user (id, email, password_hash, display_name, created_at, updated_at)
  SELECT id, email, password_hash, display_name, created_at, updated_at FROM account_user_old;
DROP TABLE account_user_old;
