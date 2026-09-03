PRAGMA foreign_keys = ON;

CREATE TABLE identity_verifications (
  id TEXT PRIMARY KEY,
  telegram_user_id INTEGER NOT NULL UNIQUE REFERENCES telegram_users(telegram_id),
  external_user_id TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL DEFAULT 'sumsub' CHECK (provider = 'sumsub'),
  provider_applicant_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'unverified' CHECK (status IN (
    'unverified', 'pending', 'approved', 'review', 'retry', 'declined', 'expired', 'error'
  )),
  aml_status TEXT NOT NULL DEFAULT 'unknown' CHECK (aml_status IN ('unknown', 'clear', 'review', 'blocked')),
  review_reason_code TEXT,
  document_expires_at TEXT,
  verified_at TEXT,
  last_event_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE verification_events (
  id TEXT PRIMARY KEY,
  verification_id TEXT NOT NULL REFERENCES identity_verifications(id),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('provider', 'admin', 'system')),
  actor_id TEXT,
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  reason_code TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER verification_events_no_update BEFORE UPDATE ON verification_events
BEGIN SELECT RAISE(ABORT, 'verification_events are immutable'); END;
CREATE TRIGGER verification_events_no_delete BEFORE DELETE ON verification_events
BEGIN SELECT RAISE(ABORT, 'verification_events are immutable'); END;

CREATE TABLE verification_webhook_events (
  id TEXT PRIMARY KEY,
  provider_event_key TEXT NOT NULL UNIQUE,
  provider_applicant_id TEXT,
  event_type TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  outcome TEXT NOT NULL,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER verification_webhook_events_no_update BEFORE UPDATE ON verification_webhook_events
BEGIN SELECT RAISE(ABORT, 'verification_webhook_events are immutable'); END;
CREATE TRIGGER verification_webhook_events_no_delete BEFORE DELETE ON verification_webhook_events
BEGIN SELECT RAISE(ABORT, 'verification_webhook_events are immutable'); END;

ALTER TABLE deals ADD COLUMN verification_id TEXT REFERENCES identity_verifications(id);
ALTER TABLE deals ADD COLUMN verification_status_snapshot TEXT;

CREATE INDEX identity_verifications_status_idx ON identity_verifications(status, updated_at DESC);
CREATE INDEX verification_events_verification_idx ON verification_events(verification_id, created_at DESC);
CREATE INDEX verification_webhooks_applicant_idx ON verification_webhook_events(provider_applicant_id, processed_at DESC);
