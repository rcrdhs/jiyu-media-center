# Payments for Jiyu: research, design, recommendation

Status: **scaffold only, test mode, OFF everywhere.** Nothing in this repo can take real money:
billing is disabled in `workers/jiyu-sync/wrangler.toml`, the paywall flag is off in every
build, the Stripe adapter refuses live keys and live-mode events, no provider account exists,
no secrets are set, the `0002_entitlements` migration has not been applied to the production
D1, and nothing was deployed. Research checked October 2026; policies change, so re-read
the linked pages before acting on any of it.

## 1. Recommendation (plain words)

**Do not charge money for Jiyu as it is today, and do not try to find a processor that will
look the other way.**

Jiyu's catalog streams content nobody here has a licence for: Movy/Bilibili reuploads, YTS
torrents, mirror sites, live sports embeds and IPTV relays. Every mainstream payment provider
and donation platform we checked prohibits taking money for that, and card-network rules
make it a fast route to a frozen balance, a terminated account and a blacklist entry. Charging
for it also changes the legal picture: a free hobby app that links to other sites is a very
different target from a business that sells subscriptions to pirated content (anti-piracy
groups specifically go after operators who make money; see the ACE cases below).

Realistic paths, in order:

1. **Stay free.** Keep the scaffold in the repo, switched off. No change for users.
2. **Ship a separate product you can legally charge for** and put payments only on that.
   Example: a "bring your own sources" player (the user's own files, their own Jellyfin/Plex/
   IPTV subscription they already pay for, legal free sources like public-domain archives,
   official free-with-ads services via their own apps or links), with the unlicensed providers
   removed from that build. That product can use this scaffold unchanged.
3. **License content** (realistic only for small catalogs: indie film, public-domain packs,
   creators who agree to it). Expensive and slow, but then everything below is easy.

Donations do not get around this (section 4.4).

## 2. What was built (all behind config, all off)

### Server: `workers/jiyu-sync`

- `migrations/0002_entitlements.sql`: `entitlements` (one row per sync account: plan, status,
  trial window, period end, provider ids) and `billing_events` (webhook idempotency log).
- `src/billing.js`: provider-agnostic billing module wired into `src/index.js` in three
  places (public routes, authenticated routes, last-device cleanup). With
  `BILLING_ENABLED != "true"` every billing route returns 404 and the sync code paths are
  byte-for-byte the old behaviour.
- Routes: `GET /v1/entitlement` (lazy 7-day trial on first check), `GET /v1/billing/plans`,
  `POST /v1/billing/checkout`, `POST /v1/billing/portal`, `POST /v1/billing/webhook/:provider`,
  `GET /v1/billing/return`, and a dev-only `POST /v1/billing/dev/entitlement` (needs
  `BILLING_DEV_TOOLS=true` and a loopback request).
- Provider adapters, selected by `BILLING_PROVIDER`:
  - `none` (default): refuses everything.
  - `test`: local HMAC-signed webhooks (`Jiyu-Test-Signature`, `BILLING_TEST_WEBHOOK_SECRET`),
    fake checkout/portal URLs. For development only.
  - `stripe`: hosted Checkout + Billing Portal, `Stripe-Signature` verification (HMAC-SHA256,
    5-minute tolerance, constant-time compare), refuses `livemode` events, refuses any key not
    starting with `sk_test_`/`rk_test_`, and only talks to `api.stripe.com` (or loopback for the
    mock in tests).
- Entitlement rules: `trialing` until trial end; `active` until period end + 2 days slack
  (late webhooks); `past_due` keeps access for `BILLING_PAST_DUE_GRACE_DAYS` (3); `canceled`
  until period end; `comp` (free) until its end or forever; otherwise `expired`.
- Webhooks are idempotent (`billing_events` primary key), out-of-order safe (older events
  than the last applied are recorded but not applied) and unknown customers are recorded only.
- Account deletion: when the last device signs out, the account is still deleted as before,
  unless billing is on and the account has a paid, currently valid entitlement (then the
  account row and entitlement are kept so the payment is not lost; see decision D3).

### Client

- `src/lib/billing/flag.ts`: paywall flag. On only if the build sets `VITE_JIYU_PAYWALL=1`, or
  in `npm run dev` with `localStorage['jiyu.billing.devPaywall'] = '1'`. Off: no requests, no
  timers, no UI change.
- `src/lib/billing/access.ts`: pure decision function (unit tested). Server answer is cached;
  offline, a renewing paid plan keeps working for `offlineGraceMs` (72 h) after its access end;
  trials and canceled plans get no extension; server/device clock skew is corrected; rolling
  the device clock back does not extend access; a cache from another account is ignored. If
  the server says billing is off (404) or has never answered, access is allowed (fail open).
- `src/lib/billing/client.ts`: talks to jiyu-sync with the existing sync token; opens
  checkout/portal in the system browser (never the in-app browser).
- `src/components/BillingGate.tsx`: wraps the routes in `App.tsx`. When not allowed it shows
  a paywall instead of the page; Library and `/account` stay reachable.
- `src/pages/AccountPage.tsx` (route `/account`) and `src/components/AccountPlanLink.tsx`
  (Library entry, flag-gated): status, trial end, create account + start trial, plans,
  subscribe, manage subscription, refresh.

This is a convenience gate, not DRM: a modified client can skip it, and Jiyu's content is not
served by our servers anyway. Real enforcement would only be possible for features the server
itself provides (sync, hosted catalogs, relays).

## 3. How to test (no accounts, no network to Stripe)

```powershell
# Worker: unit checks + billing ON (Stripe test mode against a local mock) + billing OFF regression
cd workers\jiyu-sync
node test\billing-local.mjs          # 61 checks; uses wrangler dev --local and a temp D1 dir

# Client decision logic
cd ..\..
npx tsx scripts/test-billing-access.mts   # 17 checks
```

Manual UI check: run the worker locally with billing on (test provider), point the app at it
and turn the dev flag on:

```powershell
cd workers\jiyu-sync
npx wrangler d1 migrations apply jiyu-sync --local
npx wrangler dev --local --ip 127.0.0.1 --port 8787 --var BILLING_ENABLED:true --var BILLING_PROVIDER:test --var BILLING_DEV_TOOLS:true --var BILLING_TRIAL_DAYS:1
# app: npm run dev, Library -> Sync server URL = http://127.0.0.1:8787, then in devtools:
#   localStorage.setItem('jiyu.billing.devPaywall', '1'); location.reload()
# force states: POST /v1/billing/dev/entitlement {status:'trialing', trialEndsInMs:-1} etc.
```

Do **not** run `wrangler d1 migrations apply --remote` or `wrangler deploy` for billing until
the decisions below are made. (The README's normal deploy steps apply all migrations; 0002
only adds two empty tables and changes nothing while `BILLING_ENABLED` is false, but there is
no reason to apply it early.)

## 4. Provider research

### 4.1 Card networks set the floor

Visa and Mastercard both run brand-protection programs (Mastercard BRAM, Visa's Integrity Risk
Program / VIRP) that make the acquiring bank liable for merchants selling copyright-infringing
goods or services. Consequences flow down: fines to the acquirer, immediate termination of
the merchant, a reserve or hold on funds (commonly 90-180 days), and listing on Mastercard's
MATCH list, which makes it very hard to get any merchant account for years. Any processor
that does accept this business is either unaware (and will freeze funds when it finds out)
or is a high-risk/offshore operator that charges for the risk and still terminates under
network pressure.

### 4.2 Mainstream processors and merchants of record

| Provider | Allows unlicensed streaming? | Notes |
| --- | --- | --- |
| Stripe | No | [Prohibited and restricted businesses](https://stripe.com/legal/restricted-businesses): IP infringement, unauthorized streaming. Also **not available to Colombian or Jamaican businesses** ([stripe.com/global](https://stripe.com/global)); only via a US entity (e.g. Stripe Atlas LLC), which adds US tax and legal exposure. |
| PayPal / Braintree | No | [Acceptable Use Policy](https://www.paypal.com/us/legalhub/paypal/acceptableuse-full): items that infringe IP. Known for 180-day holds. |
| Paddle (MoR) | No | [AUP](https://www.paddle.com/help/start/intro-to-paddle/what-am-i-not-allowed-to-sell-on-paddle) explicitly lists IPTV / illicit streaming and streaming downloaders. Paddle reviews the product before approval. |
| Lemon Squeezy (MoR, Stripe-owned) | No | [Prohibited products](https://docs.lemonsqueezy.com/help/getting-started/prohibited-products): IPTV, unlicensed products. |
| Google Play billing | No | Play's [Intellectual property policy](https://support.google.com/googleplay/android-developer/answer/9888072) bans apps that facilitate infringement; the app itself would be removed, not just billing. |
| Apple App Store | No | Guideline 5.2 (intellectual property). Same outcome. |
| Samsung / LG TV stores, Amazon Appstore | No | Same rule in each store's content policy. |
| Local Colombian gateways (Wompi, PayU, Mercado Pago, ePayco) | No | All sit on the same Visa/Mastercard rails and have equivalent prohibited-activity clauses. |
| "High-risk" merchant accounts, offshore processors | Some will onboard | High fees, rolling reserves, frequent shutdowns; the legal risk to the operator is unchanged. Not recommended. |
| Self-hosted crypto (BTCPay etc.) | No intermediary to refuse | Removes the processor, not the copyright law. Profiting is what turns a hobby project into a target, and crypto payments are traceable. Not recommended. |

### 4.3 Risks if Jiyu charged as-is

- **Termination and fund holds:** account closed when discovered (often after a rights-holder
  complaint or a chargeback spike), balance held for months, possible MATCH listing.
- **Chargebacks:** users of piracy services dispute charges at high rates; above ~1% the
  processor shuts you down regardless of content.
- **Legal exposure:** in Colombia, Law 23 of 1982 and Penal Code art. 271 (as amended by
  Law 1032 of 2006) make unauthorized public communication / making available of protected
  works a crime, with aggravation when done for profit; similar laws apply in Jamaica, the US
  and the EU. Rights holders and ACE pursue operators who monetize: e.g. ACE took down the
  AnimePlay app (5M users) in March 2026 and LiveNetTV after a police raid and settlement
  ([ACE](https://www.alliance4creativity.com/news/ace-dismantles-major-illicit-anime-application-animeplay-in-indonesia/),
  [TorrentFreak](https://torrentfreak.com/pirate-iptv-app-livenettv-shut-down-after-turkish-police-raid-operators-settle-with-ace/)).
  Sports leagues (LaLiga, Premier League, DAZN) are especially active against live-sports streams.
- **Personal liability:** without a company, all of the above lands on Ricardo personally.
  Even with one, misrepresentation to a processor can be fraud.
- **Store removal:** monetized piracy is the fastest way to get the Android/TV builds pulled
  and the GitHub repo hit with takedowns.

### 4.4 Donations

Donations are still payments for the project, and the platforms say so:

- [Buy Me a Coffee](https://buymeacoffee.com/community-guidelines): explicitly prohibits
  unauthorized streaming / IPTV and anything you lack rights to.
- Ko-fi and Patreon: their terms and community guidelines prohibit funding projects that
  infringe IP; both process through Stripe/PayPal, so Stripe's and PayPal's rules apply on top.
- GitHub Sponsors: GitHub's Acceptable Use Policies and DMCA process apply to the repo itself.

A donation button on Jiyu as it is would carry the same termination and holds risk, at a
smaller scale. It could be fine for a clean product (section 1, option 2).

### 4.5 Safe business models

- **BYO / user-provided content player** (user's own media, own servers, own paid IPTV, free
  legal sources). Charge for the app features: sync, multiview, TV builds, themes, no ads.
  This is how Plex, Infuse, Jellyfin clients, Kodi forks and IPTV players sell legally.
  It must genuinely ship without the unlicensed providers, and be described exactly as it is.
- **Licensed catalog**, even a small one.
- **Free app with optional paid sync/hosting** only once the app itself is clean; sync data is
  ours, the content is not.

What we will not do: describe the business to a processor as something it is not (for
example "video player software" while shipping the current catalog), split the paid app from
the piracy build only on paper, route payments through a friend's or unrelated business, or
use crypto to avoid scrutiny. Those are exactly the patterns processors and rights holders
look for, and they turn a policy problem into fraud.

## 5. Decisions for Ricardo

- **D1. Monetize at all?** Recommendation: not with the current catalog. If yes, which clean
  product (BYO player, licensed catalog) and how it is separated from the current app.
- **D2. Entity and provider.** Stripe does not support Colombian or Jamaican businesses
  directly. Options: Paddle or Lemon Squeezy as merchant of record (they handle VAT; strict
  product review), a US LLC + Stripe, or a Colombian gateway. Get legal and tax advice first.
- **D3. Paid accounts and device loss.** Today a sync account dies with its last device.
  The scaffold keeps a paid account's row when its last device signs out, but there is no
  recovery path (no email, no login). Before charging you need a real account (email or
  provider customer portal login) or users will lose what they paid for.
- **D4. Trial abuse.** Trials are per sync account, and accounts are free and anonymous, so a
  new account gets a new trial. Options: accept it, require payment method up front, or tie
  trials to something stronger (email, store purchase).
- **D5. Prices and plans** (`BILLING_PLANS`, Stripe price ids).
- **D6. Store rules.** Google Play, Apple, Samsung and LG require their own billing for
  digital features unlocked inside the app (with some regional exceptions). A web checkout
  linked from a store build can get it removed.
- **D7. Legal review** of whatever product is chosen, before any account is opened.

## 6. Turning it on later (only after D1-D7)

1. Create the provider account honestly describing the product; create test-mode prices.
2. `npx wrangler secret put STRIPE_SECRET_KEY` (test key), `STRIPE_WEBHOOK_SECRET`; set
   `STRIPE_PRICE_MONTHLY` / `STRIPE_PRICE_YEARLY`, `BILLING_PROVIDER = "stripe"`,
   `BILLING_ENABLED = "true"` on a **separate preview worker and D1**, never on `jiyu-sync`.
3. Register `https://<preview-worker>/v1/billing/webhook/stripe` for `checkout.session.completed`,
   `customer.subscription.*`, `invoice.payment_failed`.
4. Build the app with `VITE_JIYU_PAYWALL=1` pointed at the preview worker and test end to end.
5. Going live needs a code change on purpose: the adapter refuses `sk_live_` keys and
   `livemode` events, so that guard has to be removed in a reviewed commit.
