-- migration: 0010_usage_attempt
-- up
-- 历史 usage_record 保留；只有新 attempt 的兼容投影带 attempt_id。
CREATE TABLE usage_attempt (
  attempt_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id),
  logical_request_id TEXT NOT NULL,
  provider_id TEXT,
  model_id TEXT,
  project_id TEXT,
  session_id TEXT,
  task_id TEXT,
  purpose TEXT NOT NULL,
  route TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL CHECK(status IN ('pending','streaming','succeeded','failed','cancelled','unknown_pending_reconciliation')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  payload_json TEXT NOT NULL,
  CHECK((status IN ('pending','streaming') AND ended_at IS NULL) OR
        (status NOT IN ('pending','streaming') AND ended_at IS NOT NULL))
);
CREATE INDEX usage_attempt_scope ON usage_attempt(user_id, started_at);
CREATE INDEX usage_attempt_request ON usage_attempt(user_id, logical_request_id);
CREATE INDEX usage_attempt_session ON usage_attempt(user_id, session_id, task_id);
CREATE TABLE usage_event (
  sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES user(id),
  attempt_id TEXT NOT NULL REFERENCES usage_attempt(attempt_id),
  dedup_key TEXT NOT NULL UNIQUE,
  envelope_json TEXT NOT NULL,
  UNIQUE(user_id, sequence)
);
CREATE INDEX usage_event_cursor ON usage_event(user_id, sequence);
ALTER TABLE usage_record ADD COLUMN attempt_id TEXT REFERENCES usage_attempt(attempt_id);
CREATE UNIQUE INDEX usage_record_attempt ON usage_record(attempt_id) WHERE attempt_id IS NOT NULL;
-- down
DROP INDEX usage_record_attempt;
ALTER TABLE usage_record DROP COLUMN attempt_id;
DROP TABLE usage_event;
DROP TABLE usage_attempt;
