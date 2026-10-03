-- migration: 0005_wallet_ledger
-- up

-- Platform wallet balances are materialized under an append-only ledger.
-- available_micros is derived as posted_micros - held_micros.
CREATE TABLE wallet_account (
  account_id     TEXT NOT NULL REFERENCES account_user(id) ON DELETE RESTRICT,
  currency       TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  posted_micros  INTEGER NOT NULL DEFAULT 0 CHECK (posted_micros >= 0),
  held_micros    INTEGER NOT NULL DEFAULT 0 CHECK (held_micros >= 0 AND held_micros <= posted_micros),
  revision       INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (account_id, currency)
);

-- Limits are optional until an operator configures them. Null means no cap.
CREATE TABLE wallet_budget_policy (
  account_id          TEXT NOT NULL,
  currency            TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  daily_limit_micros  INTEGER NULL CHECK (daily_limit_micros IS NULL OR daily_limit_micros >= 0),
  monthly_limit_micros INTEGER NULL CHECK (monthly_limit_micros IS NULL OR monthly_limit_micros >= 0),
  updated_by          TEXT NOT NULL REFERENCES account_user(id) ON DELETE RESTRICT,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (account_id, currency),
  FOREIGN KEY (account_id, currency) REFERENCES wallet_account(account_id, currency) ON DELETE RESTRICT
);

-- One row per trusted gateway attempt. Price snapshot and request fingerprint
-- are immutable; state/usage fields only advance through WalletLedger methods.
CREATE TABLE billing_attempt (
  attempt_id               TEXT PRIMARY KEY NOT NULL,
  account_id               TEXT NOT NULL REFERENCES account_user(id) ON DELETE RESTRICT,
  logical_request_id       TEXT NOT NULL,
  request_idempotency_key  TEXT NOT NULL,
  request_fingerprint      TEXT NOT NULL,
  currency                 TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  price_version_id         TEXT NOT NULL,
  provider_model_key       TEXT NOT NULL,
  price_snapshot_json      TEXT NOT NULL,
  reserve_micros           INTEGER NOT NULL CHECK (reserve_micros >= 0),
  final_micros             INTEGER NULL CHECK (final_micros IS NULL OR final_micros >= 0),
  status                   TEXT NOT NULL CHECK (status IN ('reserved', 'unknown_pending_reconciliation', 'reconciliation_required', 'settled', 'released', 'reversed')),
  dispatch_state           TEXT NOT NULL DEFAULT 'not_dispatched' CHECK (dispatch_state IN ('not_dispatched', 'dispatched')),
  usage_json               TEXT NULL,
  cost_lines_json          TEXT NULL,
  settlement_fingerprint   TEXT NULL,
  lease_expires_at         INTEGER NULL,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  settled_at               INTEGER NULL,
  UNIQUE (account_id, request_idempotency_key),
  FOREIGN KEY (account_id, currency) REFERENCES wallet_account(account_id, currency) ON DELETE RESTRICT
);
CREATE INDEX idx_billing_attempt_account_created ON billing_attempt(account_id, created_at DESC);
CREATE INDEX idx_billing_attempt_recovery ON billing_attempt(status, lease_expires_at);

CREATE TABLE wallet_hold (
  hold_id       TEXT PRIMARY KEY NOT NULL,
  attempt_id    TEXT NOT NULL UNIQUE REFERENCES billing_attempt(attempt_id) ON DELETE RESTRICT,
  account_id    TEXT NOT NULL,
  currency      TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  amount_micros INTEGER NOT NULL CHECK (amount_micros >= 0),
  status        TEXT NOT NULL CHECK (status IN ('active', 'settled', 'released')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  FOREIGN KEY (account_id, currency) REFERENCES wallet_account(account_id, currency) ON DELETE RESTRICT
);
CREATE INDEX idx_wallet_hold_active ON wallet_hold(account_id, currency, status, created_at);

-- Every balance change is represented by an immutable signed movement.
CREATE TABLE wallet_ledger_entry (
  entry_id          TEXT PRIMARY KEY NOT NULL,
  account_id        TEXT NOT NULL,
  currency          TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  entry_type        TEXT NOT NULL CHECK (entry_type IN ('adjustment', 'hold', 'release', 'settlement', 'reversal')),
  amount_micros     INTEGER NOT NULL CHECK (amount_micros >= 0),
  posted_delta      INTEGER NOT NULL,
  held_delta        INTEGER NOT NULL,
  idempotency_key   TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  attempt_id        TEXT NULL REFERENCES billing_attempt(attempt_id) ON DELETE RESTRICT,
  hold_id           TEXT NULL REFERENCES wallet_hold(hold_id) ON DELETE RESTRICT,
  reverses_entry_id TEXT NULL REFERENCES wallet_ledger_entry(entry_id) ON DELETE RESTRICT,
  reason            TEXT NULL,
  created_at        INTEGER NOT NULL,
  FOREIGN KEY (account_id, currency) REFERENCES wallet_account(account_id, currency) ON DELETE RESTRICT,
  UNIQUE (account_id, idempotency_key),
  CHECK ((entry_type = 'adjustment' AND reason IS NOT NULL) OR entry_type <> 'adjustment')
);
CREATE INDEX idx_wallet_ledger_account_created ON wallet_ledger_entry(account_id, currency, created_at DESC, entry_id DESC);
CREATE UNIQUE INDEX idx_wallet_ledger_one_reversal ON wallet_ledger_entry(reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;
CREATE UNIQUE INDEX idx_wallet_ledger_one_settlement_per_attempt ON wallet_ledger_entry(attempt_id) WHERE entry_type = 'settlement';

CREATE TRIGGER wallet_ledger_entry_no_update
BEFORE UPDATE ON wallet_ledger_entry
BEGIN
  SELECT RAISE(ABORT, 'wallet ledger entries are immutable');
END;
CREATE TRIGGER wallet_ledger_entry_no_delete
BEFORE DELETE ON wallet_ledger_entry
BEGIN
  SELECT RAISE(ABORT, 'wallet ledger entries are immutable');
END;

-- A materialized wallet balance can only move immediately after the matching
-- append-only ledger row is inserted by the same database transaction.
CREATE TRIGGER wallet_account_balance_requires_ledger
BEFORE UPDATE ON wallet_account
WHEN NEW.revision <> OLD.revision + 1
  OR NOT EXISTS (
    SELECT 1 FROM wallet_ledger_entry e
    WHERE e.entry_id = (
      SELECT latest.entry_id FROM wallet_ledger_entry latest
      WHERE latest.account_id = OLD.account_id AND latest.currency = OLD.currency
      ORDER BY latest.rowid DESC LIMIT 1
    )
      AND e.account_id = OLD.account_id
      AND e.currency = OLD.currency
      AND e.created_at = NEW.updated_at
      AND e.posted_delta = NEW.posted_micros - OLD.posted_micros
      AND e.held_delta = NEW.held_micros - OLD.held_micros
  )
BEGIN
  SELECT RAISE(ABORT, 'wallet balance changes require a matching ledger entry');
END;

CREATE TRIGGER billing_attempt_price_snapshot_immutable
BEFORE UPDATE OF account_id, logical_request_id, request_idempotency_key, request_fingerprint,
                 currency, price_version_id, provider_model_key, price_snapshot_json, reserve_micros
ON billing_attempt
BEGIN
  SELECT RAISE(ABORT, 'billing attempt acceptance snapshot is immutable');
END;
CREATE TRIGGER billing_attempt_no_delete
BEFORE DELETE ON billing_attempt
BEGIN
  SELECT RAISE(ABORT, 'billing attempts are immutable');
END;
CREATE TRIGGER billing_attempt_valid_transition
BEFORE UPDATE OF status ON billing_attempt
WHEN OLD.status <> NEW.status AND NOT (
  (OLD.status = 'reserved' AND NEW.status IN ('unknown_pending_reconciliation', 'reconciliation_required', 'settled', 'released'))
  OR (OLD.status = 'unknown_pending_reconciliation' AND NEW.status IN ('reconciliation_required', 'settled', 'released'))
  OR (OLD.status = 'reconciliation_required' AND NEW.status IN ('settled', 'released'))
  OR (OLD.status = 'settled' AND NEW.status = 'reversed')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid billing attempt state transition');
END;

CREATE TRIGGER wallet_hold_terms_immutable
BEFORE UPDATE OF attempt_id, account_id, currency, amount_micros, created_at ON wallet_hold
BEGIN
  SELECT RAISE(ABORT, 'wallet hold terms are immutable');
END;
CREATE TRIGGER wallet_hold_no_delete
BEFORE DELETE ON wallet_hold
BEGIN
  SELECT RAISE(ABORT, 'wallet holds are immutable');
END;
CREATE TRIGGER wallet_hold_valid_transition
BEFORE UPDATE OF status ON wallet_hold
WHEN OLD.status <> NEW.status AND NOT (OLD.status = 'active' AND NEW.status IN ('settled', 'released'))
BEGIN
  SELECT RAISE(ABORT, 'invalid wallet hold state transition');
END;
CREATE TRIGGER wallet_account_no_delete
BEFORE DELETE ON wallet_account
BEGIN
  SELECT RAISE(ABORT, 'wallet account history cannot be deleted');
END;

CREATE TABLE billing_reconciliation_case (
  case_id       TEXT PRIMARY KEY NOT NULL,
  attempt_id    TEXT NOT NULL UNIQUE REFERENCES billing_attempt(attempt_id) ON DELETE RESTRICT,
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  created_at    INTEGER NOT NULL,
  due_at        INTEGER NOT NULL,
  resolved_at   INTEGER NULL,
  resolved_by   TEXT NULL REFERENCES account_user(id) ON DELETE RESTRICT,
  resolution    TEXT NULL CHECK (resolution IS NULL OR resolution IN ('final_usage', 'no_upstream_execution')),
  resolution_note TEXT NULL,
  CHECK ((status = 'open' AND resolved_at IS NULL AND resolved_by IS NULL AND resolution IS NULL)
      OR (status = 'resolved' AND resolved_at IS NOT NULL AND resolution IS NOT NULL))
);
CREATE INDEX idx_billing_reconciliation_open ON billing_reconciliation_case(status, due_at, created_at);
CREATE TRIGGER billing_reconciliation_terms_immutable
BEFORE UPDATE OF attempt_id, reason, created_at, due_at ON billing_reconciliation_case
BEGIN
  SELECT RAISE(ABORT, 'billing reconciliation intake is immutable');
END;
CREATE TRIGGER billing_reconciliation_no_delete
BEFORE DELETE ON billing_reconciliation_case
BEGIN
  SELECT RAISE(ABORT, 'billing reconciliation history is immutable');
END;

CREATE TABLE billing_audit_event (
  event_id           TEXT PRIMARY KEY NOT NULL,
  action             TEXT NOT NULL,
  actor_account_id   TEXT NULL REFERENCES account_user(id) ON DELETE RESTRICT,
  target_account_id  TEXT NULL REFERENCES account_user(id) ON DELETE RESTRICT,
  attempt_id         TEXT NULL REFERENCES billing_attempt(attempt_id) ON DELETE RESTRICT,
  entry_id           TEXT NULL REFERENCES wallet_ledger_entry(entry_id) ON DELETE RESTRICT,
  reason             TEXT NULL,
  details_json       TEXT NOT NULL,
  created_at         INTEGER NOT NULL
);
CREATE INDEX idx_billing_audit_created ON billing_audit_event(created_at DESC);
CREATE INDEX idx_billing_audit_attempt ON billing_audit_event(attempt_id, created_at);
CREATE TRIGGER billing_audit_event_no_update
BEFORE UPDATE ON billing_audit_event
BEGIN
  SELECT RAISE(ABORT, 'billing audit events are immutable');
END;
CREATE TRIGGER billing_audit_event_no_delete
BEFORE DELETE ON billing_audit_event
BEGIN
  SELECT RAISE(ABORT, 'billing audit events are immutable');
END;

-- down

DROP TRIGGER IF EXISTS billing_audit_event_no_delete;
DROP TRIGGER IF EXISTS billing_audit_event_no_update;
DROP TABLE IF EXISTS billing_audit_event;
DROP TRIGGER IF EXISTS billing_reconciliation_no_delete;
DROP TRIGGER IF EXISTS billing_reconciliation_terms_immutable;
DROP TABLE IF EXISTS billing_reconciliation_case;
DROP TRIGGER IF EXISTS wallet_account_balance_requires_ledger;
DROP TRIGGER IF EXISTS wallet_hold_no_delete;
DROP TRIGGER IF EXISTS wallet_hold_terms_immutable;
DROP TRIGGER IF EXISTS wallet_hold_valid_transition;
DROP TRIGGER IF EXISTS wallet_account_no_delete;
DROP TRIGGER IF EXISTS billing_attempt_valid_transition;
DROP TRIGGER IF EXISTS billing_attempt_no_delete;
DROP TRIGGER IF EXISTS billing_attempt_price_snapshot_immutable;
DROP TRIGGER IF EXISTS wallet_ledger_entry_no_delete;
DROP TRIGGER IF EXISTS wallet_ledger_entry_no_update;
DROP TABLE IF EXISTS wallet_ledger_entry;
DROP TABLE IF EXISTS wallet_hold;
DROP TABLE IF EXISTS billing_attempt;
DROP TABLE IF EXISTS wallet_budget_policy;
DROP TABLE IF EXISTS wallet_account;
