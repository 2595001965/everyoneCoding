-- migration: 0004_platform_catalog
-- up

CREATE TABLE platform_provider (
  provider_id            TEXT PRIMARY KEY NOT NULL,
  display_name           TEXT NOT NULL,
  protocol               TEXT NOT NULL CHECK (protocol IN ('openai', 'anthropic')),
  base_url               TEXT NOT NULL,
  credential_ref         TEXT NULL,
  credential_rotated_at  INTEGER NULL,
  status                 TEXT NOT NULL CHECK (status IN ('active', 'maintenance', 'disabled')),
  status_reason          TEXT NULL,
  revision               INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

CREATE TABLE platform_model (
  model_id              TEXT PRIMARY KEY NOT NULL,
  provider_id           TEXT NOT NULL REFERENCES platform_provider(provider_id) ON DELETE RESTRICT,
  upstream_model_name   TEXT NOT NULL,
  display_name          TEXT NOT NULL,
  canonical_vendor      TEXT NULL,
  canonical_model       TEXT NULL,
  context_window_tokens INTEGER NULL CHECK (context_window_tokens IS NULL OR context_window_tokens > 0),
  context_window_source TEXT NULL CHECK (context_window_source IS NULL OR context_window_source IN ('measured', 'reported', 'estimated', 'inferred', 'unknown')),
  capabilities_json     TEXT NULL,
  status                TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  revision              INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  UNIQUE (provider_id, model_id),
  UNIQUE (provider_id, upstream_model_name),
  CHECK ((canonical_vendor IS NULL) = (canonical_model IS NULL)),
  CHECK ((context_window_tokens IS NULL) = (context_window_source IS NULL))
);
CREATE INDEX idx_platform_model_provider_status ON platform_model(provider_id, status);

-- PriceVersion rows are append-only. effectiveTo is derived from the next release,
-- so publishing a new price never edits or deletes the historical version.
CREATE TABLE platform_price_version (
  price_version_id             TEXT PRIMARY KEY NOT NULL,
  provider_id                  TEXT NOT NULL,
  model_id                     TEXT NOT NULL,
  provider_model_key           TEXT NOT NULL,
  billing_mode                 TEXT NOT NULL CHECK (billing_mode = 'per_million_tokens'),
  currency                     TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  rates_json                   TEXT NOT NULL,
  cache_write_rate_semantics   TEXT NOT NULL CHECK (cache_write_rate_semantics = 'full_rate'),
  source_json                  TEXT NOT NULL,
  effective_from               INTEGER NOT NULL CHECK (effective_from >= 0),
  published_at                 INTEGER NOT NULL,
  version                      INTEGER NOT NULL CHECK (version > 0),
  FOREIGN KEY (provider_id, model_id) REFERENCES platform_model(provider_id, model_id) ON DELETE RESTRICT,
  UNIQUE (provider_model_key, version),
  UNIQUE (provider_model_key, effective_from)
);
CREATE INDEX idx_platform_price_route_effective ON platform_price_version(provider_model_key, effective_from);
CREATE TRIGGER platform_price_version_no_update
BEFORE UPDATE ON platform_price_version
BEGIN
  SELECT RAISE(ABORT, 'platform price versions are immutable');
END;
CREATE TRIGGER platform_price_version_no_delete
BEFORE DELETE ON platform_price_version
BEGIN
  SELECT RAISE(ABORT, 'platform price versions are immutable');
END;

-- Official pricing evidence is a separately versioned, exact canonical identity.
CREATE TABLE platform_official_price_snapshot (
  snapshot_id          TEXT PRIMARY KEY NOT NULL,
  canonical_vendor     TEXT NOT NULL,
  canonical_model      TEXT NOT NULL,
  billing_mode         TEXT NOT NULL CHECK (billing_mode = 'per_million_tokens'),
  currency             TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  rates_json           TEXT NOT NULL,
  source_url           TEXT NOT NULL,
  verified_at          INTEGER NOT NULL CHECK (verified_at >= 0),
  evidence_version     TEXT NOT NULL,
  evidence_sha256      TEXT NOT NULL,
  evidence_snapshot    TEXT NOT NULL,
  conditions           TEXT NOT NULL,
  effective_from       INTEGER NOT NULL CHECK (effective_from >= 0),
  published_at         INTEGER NOT NULL,
  version              INTEGER NOT NULL CHECK (version > 0),
  verified_by          TEXT NOT NULL,
  UNIQUE (canonical_vendor, canonical_model, version),
  UNIQUE (canonical_vendor, canonical_model, effective_from)
);
CREATE INDEX idx_platform_official_price_identity_effective
  ON platform_official_price_snapshot(canonical_vendor, canonical_model, effective_from);
CREATE TRIGGER platform_official_price_no_update
BEFORE UPDATE ON platform_official_price_snapshot
BEGIN
  SELECT RAISE(ABORT, 'official price evidence snapshots are immutable');
END;
CREATE TRIGGER platform_official_price_no_delete
BEFORE DELETE ON platform_official_price_snapshot
BEGIN
  SELECT RAISE(ABORT, 'official price evidence snapshots are immutable');
END;

-- down

DROP TRIGGER IF EXISTS platform_official_price_no_delete;
DROP TRIGGER IF EXISTS platform_official_price_no_update;
DROP TABLE IF EXISTS platform_official_price_snapshot;
DROP TRIGGER IF EXISTS platform_price_version_no_delete;
DROP TRIGGER IF EXISTS platform_price_version_no_update;
DROP TABLE IF EXISTS platform_price_version;
DROP TABLE IF EXISTS platform_model;
DROP TABLE IF EXISTS platform_provider;
