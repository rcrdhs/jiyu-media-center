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
