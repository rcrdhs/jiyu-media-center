-- Saved (watchlist) rows, parallel to Continue watching `progress`.
-- Apply: npx wrangler d1 migrations apply jiyu-sync --remote
ALTER TABLE users ADD COLUMN saved_rev INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS saved (
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  rev INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL,
  PRIMARY KEY (user_id, item_id)
);
CREATE INDEX IF NOT EXISTS saved_user_rev ON saved (user_id, rev);
