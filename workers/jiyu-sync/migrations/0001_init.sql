-- jiyu-sync schema (D1 / SQLite). Apply: npx wrangler d1 migrations apply jiyu-sync --remote
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS devices_user ON devices (user_id);

-- Single-use pairing codes; only a SHA-256 hash is stored.
CREATE TABLE IF NOT EXISTS pair_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pair_codes_user ON pair_codes (user_id);

-- One row per Continue-watching title. rev = per-user server revision (monotonic).
-- updated_at = server-clock edit time (client sends its edit age, never its clock).
CREATE TABLE IF NOT EXISTS progress (
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  rev INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL,
  PRIMARY KEY (user_id, item_id)
);
CREATE INDEX IF NOT EXISTS progress_user_rev ON progress (user_id, rev);
