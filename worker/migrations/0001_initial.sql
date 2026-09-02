PRAGMA foreign_keys = ON;

CREATE TABLE telegram_users (
  telegram_id INTEGER PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  language_code TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE admins (
  telegram_id INTEGER PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'viewer')),
  display_name TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT
);

CREATE TABLE admin_sessions (
  id TEXT PRIMARY KEY,
  telegram_id INTEGER NOT NULL REFERENCES admins(telegram_id),
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE deals (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  telegram_user_id INTEGER NOT NULL REFERENCES telegram_users(telegram_id),
  client_request_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'new', 'reviewing', 'rate_offered', 'rate_accepted', 'awaiting_payment',
    'payment_review', 'exchange_in_progress', 'completed', 'cancelled', 'dispute'
  )),
  give_currency TEXT NOT NULL,
  give_amount TEXT NOT NULL,
  receive_currency TEXT NOT NULL,
  receive_amount TEXT,
  payment_method TEXT NOT NULL,
  quoted_rate TEXT,
  market_rate_snapshot TEXT,
  markup_snapshot TEXT,
  quote_updated_at TEXT,
  quote_stale INTEGER NOT NULL DEFAULT 0 CHECK (quote_stale IN (0, 1)),
  assigned_admin_id INTEGER REFERENCES admins(telegram_id),
  rate_accepted_at TEXT,
  payment_confirmed_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (telegram_user_id, client_request_id)
);

CREATE TABLE deal_events (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL REFERENCES deals(id),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('client', 'admin', 'system')),
  actor_id TEXT,
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  payload TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER deal_events_no_update BEFORE UPDATE ON deal_events
BEGIN SELECT RAISE(ABORT, 'deal_events are immutable'); END;
CREATE TRIGGER deal_events_no_delete BEFORE DELETE ON deal_events
BEGIN SELECT RAISE(ABORT, 'deal_events are immutable'); END;

CREATE TABLE rate_locks (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL REFERENCES deals(id),
  rate TEXT NOT NULL,
  receive_amount TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  rejected_at TEXT,
  created_by INTEGER NOT NULL REFERENCES admins(telegram_id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE payment_instructions (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL REFERENCES deals(id),
  instructions TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES admins(telegram_id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT
);

CREATE TABLE notification_outbox (
  id TEXT PRIMARY KEY,
  deal_id TEXT REFERENCES deals(id),
  telegram_user_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE execution_attempts (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL REFERENCES deals(id),
  idempotency_key TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('manual', 'provider')),
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  provider_reference TEXT,
  error_code TEXT,
  created_by INTEGER NOT NULL REFERENCES admins(telegram_id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  UNIQUE (deal_id, idempotency_key)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by INTEGER REFERENCES admins(telegram_id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  actor_id INTEGER,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  old_value TEXT,
  new_value TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events are immutable'); END;
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events are immutable'); END;

INSERT INTO settings (key, value) VALUES
  ('sell_markup_bps', '300'),
  ('buy_markup_bps', '-300'),
  ('minimum_amount', '"1"'),
  ('maximum_amount', '"100000000"'),
  ('supported_currencies', '["RUB","USDT","BTC","ETH","KZT","AED","USD"]'),
  ('automatic_currencies', '["RUB","USDT","BTC","ETH"]'),
  ('rate_lock_minutes', '10'),
  ('maximum_stale_seconds', '120'),
  ('maintenance_mode', 'false'),
  ('execution_mode', '"manual"');

CREATE INDEX deals_status_created_idx ON deals(status, created_at DESC);
CREATE INDEX deals_user_created_idx ON deals(telegram_user_id, created_at DESC);
CREATE INDEX deal_events_deal_created_idx ON deal_events(deal_id, created_at ASC);
CREATE INDEX outbox_status_next_idx ON notification_outbox(status, next_attempt_at);
CREATE INDEX sessions_user_expiry_idx ON admin_sessions(telegram_id, expires_at);
