-- migration: 0006_billing_filters
-- Add opaque project/session labels so account holders can filter their own bills.
-- up
ALTER TABLE billing_attempt
  ADD COLUMN project_id TEXT NULL CHECK (project_id IS NULL OR (length(project_id) BETWEEN 1 AND 200));
ALTER TABLE billing_attempt
  ADD COLUMN session_id TEXT NULL CHECK (session_id IS NULL OR (length(session_id) BETWEEN 1 AND 200));

DROP TRIGGER billing_attempt_price_snapshot_immutable;
CREATE TRIGGER billing_attempt_price_snapshot_immutable
BEFORE UPDATE OF account_id, logical_request_id, request_idempotency_key, request_fingerprint,
                 currency, price_version_id, provider_model_key, price_snapshot_json, reserve_micros,
                 project_id, session_id
ON billing_attempt
BEGIN
  SELECT RAISE(ABORT, 'billing attempt acceptance snapshot is immutable');
END;

CREATE INDEX idx_billing_attempt_account_project_created
  ON billing_attempt(account_id, project_id, created_at DESC, attempt_id DESC);
CREATE INDEX idx_billing_attempt_account_session_created
  ON billing_attempt(account_id, session_id, created_at DESC, attempt_id DESC);

-- down
DROP INDEX idx_billing_attempt_account_session_created;
DROP INDEX idx_billing_attempt_account_project_created;
DROP TRIGGER billing_attempt_price_snapshot_immutable;
ALTER TABLE billing_attempt DROP COLUMN session_id;
ALTER TABLE billing_attempt DROP COLUMN project_id;
CREATE TRIGGER billing_attempt_price_snapshot_immutable
BEFORE UPDATE OF account_id, logical_request_id, request_idempotency_key, request_fingerprint,
                 currency, price_version_id, provider_model_key, price_snapshot_json, reserve_micros
ON billing_attempt
BEGIN
  SELECT RAISE(ABORT, 'billing attempt acceptance snapshot is immutable');
END;
