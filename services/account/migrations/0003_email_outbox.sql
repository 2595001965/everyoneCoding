-- migration: 0003_email_outbox
-- up

-- 邮件 outbox（默认投递方式）：开发/运维可查，测试可断言
CREATE TABLE IF NOT EXISTS account_email_outbox (
  id         TEXT PRIMARY KEY NOT NULL,
  to_addr    TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_email_outbox_created ON account_email_outbox (created_at);

-- down

DROP TABLE IF EXISTS account_email_outbox;
