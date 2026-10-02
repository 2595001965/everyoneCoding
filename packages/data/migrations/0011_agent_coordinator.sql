-- migration: 0011_agent_coordinator
-- up
CREATE TABLE agent_coordinator_lease (
  data_domain TEXT PRIMARY KEY, owner TEXT NOT NULL, fencing_token INTEGER NOT NULL,
  acquired_at INTEGER NOT NULL, expiry_at INTEGER NOT NULL
);
CREATE TABLE agent_session (
  session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE agent_task (
  task_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES agent_session(session_id),
  user_id TEXT NOT NULL, project_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL, request_json TEXT NOT NULL, payload_json TEXT NOT NULL,
  status TEXT NOT NULL, execution_state TEXT NOT NULL DEFAULT 'pending',
  checkpoint_json TEXT, result_json TEXT, error TEXT,
  owner_token INTEGER, created_at INTEGER NOT NULL,
  UNIQUE(user_id, session_id, idempotency_key)
);
CREATE INDEX agent_task_queue ON agent_task(status, created_at);
CREATE TABLE agent_command (
  command_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES agent_task(task_id),
  kind TEXT NOT NULL CHECK(kind IN ('cancel','pause','resume','reconcile')),
  payload_json TEXT NOT NULL, processed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE agent_event (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL, session_id TEXT NOT NULL, task_id TEXT NOT NULL,
  dedup_key TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL
);
CREATE INDEX agent_event_session ON agent_event(user_id, session_id, sequence);
-- Permits stay reserved when an upstream outcome is unknown. They are not a wallet.
CREATE TABLE agent_gateway_permit (
  permit_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, task_id TEXT,
  scopes_json TEXT NOT NULL, reserved_usd REAL NOT NULL, started_at INTEGER NOT NULL,
  owner_token INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','unknown','settled'))
);
-- down
DROP TABLE agent_gateway_permit;
DROP TABLE agent_event;
DROP TABLE agent_command;
DROP TABLE agent_task;
DROP TABLE agent_session;
DROP TABLE agent_coordinator_lease;
