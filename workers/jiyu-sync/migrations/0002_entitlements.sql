-- jiyu-sync billing scaffold (test mode only). Safe to apply: nothing reads these tables
-- unless BILLING_ENABLED = "true". Do not apply to the production database until the
-- payments decision in docs/payments.md has been made.
--
-- One row per sync account (users.id). Status values:
--   trialing   free trial, access until trial_ends_at
--   active     paid, access until current_period_end (plus a short webhook-delay slack)
--   past_due   payment failed, access for BILLING_PAST_DUE_GRACE_DAYS after the period end
--   canceled   will not renew, access until current_period_end
--   comp       granted manually (support / tester), access until current_period_end or forever
--   expired    no access
--   none       never had a trial (BILLING_TRIAL_DAYS = 0)
CREATE TABLE IF NOT EXISTS entitlements (
  user_id TEXT PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT 'trial',
  status TEXT NOT NULL,
  trial_started_at INTEGER,
  trial_ends_at INTEGER,
  current_period_end INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  provider TEXT,
  provider_customer_id TEXT,
  provider_subscription_id TEXT,
  -- Provider event time of the last applied webhook; older events are recorded but not applied.
  last_event_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS entitlements_customer ON entitlements (provider, provider_customer_id);

-- Webhook idempotency: providers retry, so each event id is applied at most once.
CREATE TABLE IF NOT EXISTS billing_events (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  user_id TEXT,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (provider, event_id)
);
