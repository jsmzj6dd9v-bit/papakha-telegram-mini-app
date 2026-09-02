CREATE TABLE admin_handoffs (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  telegram_id INTEGER NOT NULL REFERENCES admins(telegram_id),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX admin_handoffs_expiry_idx ON admin_handoffs(expires_at, consumed_at);
