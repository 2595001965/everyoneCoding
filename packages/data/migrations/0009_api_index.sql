-- migration: 0009_api_index
-- up
CREATE TABLE api_endpoint (
  endpoint_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL,
  method TEXT NOT NULL,
  normalized_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','pending_confirmation','removed')),
  revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE UNIQUE INDEX api_endpoint_route ON api_endpoint(project_id, service_id, method, normalized_path) WHERE status != 'removed';
CREATE TABLE api_call (
  call_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE(project_id, source_key)
);
CREATE TABLE api_relation (
  relation_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  endpoint_id TEXT NOT NULL REFERENCES api_endpoint(endpoint_id) ON DELETE CASCADE,
  caller_ref TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE(endpoint_id, caller_ref)
);
CREATE TABLE api_scan (
  project_id TEXT PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  scanned_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);

-- down
DROP TABLE IF EXISTS api_scan;
DROP TABLE IF EXISTS api_relation;
DROP TABLE IF EXISTS api_call;
DROP TABLE IF EXISTS api_endpoint;
