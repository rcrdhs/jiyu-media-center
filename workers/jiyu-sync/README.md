# jiyu-sync

Cloudflare Worker + D1 that syncs the **Continue watching** shelf between Jiyu devices.
Separate from `jiyu-wyzie`; holds no API keys.

## Endpoints (all JSON, HTTPS only)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/v1/auth/register` `{label}` | – | New account + this device. Returns `token`, `userId`, `deviceId`, `pairCode`, `pairCodeExpiresAt`. |
| POST | `/v1/auth/pair` `{code,label}` | – | Redeem a single-use pair code (10 min) for a new device token. Rate limited. |
| POST | `/v1/auth/pair-code` | Bearer | Issue a fresh pair code (replaces the previous one). |
| POST | `/v1/auth/signout` | Bearer | Revoke this device. |
| GET | `/v1/devices` | Bearer | List devices on the account. |
| DELETE | `/v1/devices/:id` | Bearer | Revoke a device (its token stops working at once). |
| GET | `/v1/progress?since=REV` | Bearer | Rows changed after server revision `REV`, plus current `rev` and server `now`. |
| PUT | `/v1/progress` `{entries}` | Bearer | Upsert up to 100 rows. Each row carries `ageMs` (how long ago it was edited); the server stamps `updatedAt`/`rev`. Tombstones: `deleted: true`. |
| DELETE | `/v1/progress/:id` | Bearer | Compatibility alias for a tombstone PUT. |

Tokens are 32 random bytes; only SHA-256 hashes are stored. When the last device on an
account is removed the account and its rows are deleted.

## Deploy

```powershell
$env:CLOUDFLARE_ACCOUNT_ID = '<same account as jiyu-wyzie>'
npx wrangler d1 migrations apply jiyu-sync --remote
npx wrangler deploy
```

Free plan: Workers 100k requests/day, D1 5M row reads + 100k row writes/day. Exceeding a
limit returns errors; nothing is billed.

## Billing / entitlements (scaffold, OFF by default)

`src/billing.js` adds per-account entitlements and a provider-agnostic webhook interface.
It is inert unless `BILLING_ENABLED = "true"`; with the default `[vars]` every route below
returns 404 and register/pair/sync/sign-out behave exactly as before. Read
[docs/payments.md](../../docs/payments.md) before turning any of it on: it explains why no
mainstream payment provider will currently accept Jiyu as it is.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/v1/entitlement` | Bearer | `{entitled, status, plan, trialEndsAt, accessUntil, recheckAfterMs, offlineGraceMs, ...}`. Starts the trial lazily on first call. |
| GET | `/v1/billing/plans` | none | Configured plans (`BILLING_PLANS`). |
| POST | `/v1/billing/checkout` `{plan}` | Bearer | Hosted checkout URL from the active provider. |
| POST | `/v1/billing/portal` | Bearer | Hosted "manage subscription" URL. |
| POST | `/v1/billing/webhook/:provider` | signature | Provider events (`test` or `stripe`). Idempotent, out-of-order safe. |
| GET | `/v1/billing/return` | none | Small "you can close this tab" page after checkout. |
| POST | `/v1/billing/dev/entitlement` | Bearer + loopback + `BILLING_DEV_TOOLS` | Force a status locally (dev only). |

Config (`[vars]`): `BILLING_ENABLED`, `BILLING_PROVIDER` (`none` / `test` / `stripe`),
`BILLING_TRIAL_DAYS` (7), `BILLING_PAST_DUE_GRACE_DAYS` (3), `BILLING_OFFLINE_GRACE_HOURS` (72),
`BILLING_PLANS` (JSON), `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_YEARLY`.
Secrets (never in this file): `STRIPE_SECRET_KEY` (only `sk_test_`/`rk_test_` accepted; live
keys are refused in code), `STRIPE_WEBHOOK_SECRET`, `BILLING_TEST_WEBHOOK_SECRET`.
Live-mode Stripe events are refused too, so this build cannot take real money.

Migration `0002_entitlements.sql` only adds two tables (`entitlements`, `billing_events`);
it is safe to apply but there is no reason to apply it remotely until billing is decided.

Local test (no Cloudflare account, no network to Stripe; uses a mock Stripe API and
`wrangler dev --local` with a temp D1 directory):

```powershell
cd workers\jiyu-sync
node test\billing-local.mjs   # unit checks + billing ON (stripe test mode) + billing OFF regression
```
