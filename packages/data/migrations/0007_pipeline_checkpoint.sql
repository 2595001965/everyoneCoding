-- migration: 0007_pipeline_checkpoint
-- up
CREATE TABLE pipeline_checkpoint (
  project_id TEXT PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
  transaction_id TEXT NOT NULL,
  envelope_json TEXT NOT NULL
);
CREATE TABLE pipeline_commit_receipt (
  transaction_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE
);

-- down
DROP TABLE IF EXISTS pipeline_commit_receipt;
DROP TABLE IF EXISTS pipeline_checkpoint;
