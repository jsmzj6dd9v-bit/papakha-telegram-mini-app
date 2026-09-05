-- Each accepted operation and its side effects commit in one D1 batch.
CREATE TABLE admin_operations (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL REFERENCES deals(id),
  actor_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  valid INTEGER NOT NULL CHECK (valid = 1),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
