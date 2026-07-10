# Chama — ChapSmart fiat-funded escrow ("Fund with M-Pesa") — design brief

**Status:** ✅ BUILT end-to-end 2026-07-08 (flag-dormant: `CHAPSMART_ONRAMP_ENABLED=false` until the proxy + API key
exist; suite 3013/3013 green). Note the build DIVERGED from step 2 below, for the better: no `fundingMethod ===
"chapsmart"` / `autoPayInvoice` wiring at all — ChapSmart is an alternate payer of the invoice the AtomicFundingModal
already displays (`ChapsmartMpesaPanel` inside `awaiting-payment`), so `fund-and-lock`/`useEscrow` are untouched.
Originally (2026-07-07): design brief + starter client module. Jetty's intent: NOT a standalone "buy
sats" page — a **funding method inside the lock step** so a fiat-only user can fund an escrow directly
with M-Pesa. Removes the biggest onboarding barrier ("you need sats before you can do anything").
Depends on Jetty's ChapSmart server proxy + CORS, and ChapSmart's mpesaId handoff (v2 auto-pickup coming).

## The idea (reframed from "buy sats")
ChapSmart is an **alternate payer of the funding invoice**. The normal atomic fund-and-lock generates a
BOLT11 for the exact trade amount and waits for it to be paid (from the user's Lightning wallet, or NWC).
"Fund with M-Pesa" makes **ChapSmart** pay that invoice: quote the fiat → user pays M-Pesa → ChapSmart
pays the BOLT11 → sats mint into the user's OWN Fedimint wallet → the LOCK spends them into escrow.

Non-custodial from Chama's side: the sats land in the user's wallet on the way through; Chama never holds
them. ChapSmart is a licensed ramp the user trusts for the fiat→sats leg (spread + delivery), exactly like
they trust it for the existing off-ramp.

## ⭐ Where it applies — "who locks the sats"
It's a funding method, so it lights up wherever the USER funds the escrow — build once, no per-vertical work:
- **Marketplace** (buyer funds to pay for goods) — the killer case: a fiat-only buyer can buy.
- **Work** (client funds the worker), **Community Bill Pay**, **Chip In**, **Stack** — same shape.
- **Exchange — deliberately NOT.** In Exchange the buyer doesn't lock: they pay fiat **P2P to the seller**,
  who already holds the sats. Exchange *is* the on-ramp. A ChapSmart ramp there would be a custodial ramp
  competing with Chama's own P2P ramp. Excluding it is correct, not a gap.

## Integration points (all traced)
1. **Funding-method abstraction already exists.** `fund-and-lock.ts` takes an optional `autoPayInvoice(bolt11)`;
   `useEscrow.ts:~3156` wires it for `fundingMethod === "nwc"`. Add `fundingMethod === "chapsmart"` alongside
   it → `autoPayInvoice` = "get ChapSmart to pay this BOLT11 via M-Pesa". The receive-watcher + pollForFunding
   then detect the payment and the LOCK fires — **no lock-path changes**, it reuses the whole flow.
2. **New client module** `src/payments/chapsmart-onramp.ts` (this brief ships a starter) — thin, typed calls
   to Jetty's proxy: `getBuyQuote({ amountSats | amountTZS, accountNumber })` → quote (rate, TZS, quoteId),
   and `sendBuySats({ quoteId, mpesaId, bolt11 })` → ChapSmart pays the invoice. Mirrors the `/buy-sats/*`
   routes already in Jetty's `chapsmart.ts` router. Base URL from an env/config const (the proxy origin).
3. **AtomicFundingModal sub-flow.** When the user picks "Fund with M-Pesa" instead of the QR: show the quote
   ("Pay ~X TZS for Y sats"), guide the M-Pesa payment, then submit. On success ChapSmart pays the BOLT11 →
   the modal's existing "waiting for payment" → "locked" states carry the rest. The QR path is unchanged.
4. **Fee/amount surfacing.** ChapSmart's quote includes the spread; show "You pay X TZS (rate R)" up front so
   there's no surprise. The escrow amount (sats) is unchanged — ChapSmart just funds it.

## ⚠ The one gap: the M-Pesa handoff (needs ChapSmart-side detail)
The `/buy-sats/send` route takes `{ quoteId, mpesaId, bolt11 }` — so today the user must pay M-Pesa
out-of-band and return an **mpesaId**. Jetty: **ChapSmart v2 will auto-pick up the mpesaId** (confirm the
exact mechanism with them). Draft assumes:
- **v1 (interim):** the modal collects the mpesaId (user pastes their M-Pesa confirmation ref) → `sendBuySats`.
- **v2 (target):** ChapSmart correlates the payment automatically; the modal just polls `sendBuySats`/status
  until ChapSmart reports paid, no manual mpesaId. The client module leaves `mpesaId` optional for this.
Also unknown until confirmed: the ChapSmart response shapes (quote fields, status enum) and the auth/CORS
(the proxy holds the API key/secret; CORS must allow Chama's origin — getchama.app + localhost + the Tauri
origin). The starter module types these loosely and marks the TODOs.

## Proxy + CORS (Jetty's infra)
Jetty's `chapsmart.ts` Express router already exposes the needed routes (`buy-sats/quote`, `buy-sats/send`,
`status`, and the `nostr/*` auth). It runs server-side so the API key/secret never reach the client. To use
it from Chama's client, deploy it (satoshimarket.app backend) with **CORS opened for Chama's origins** —
same move as the existing off-ramp. Optionally use `nostr/signup|login|link` so the user's npub binds to a
ChapSmart account with no separate signup (a nice-to-have, not required for funding).

## Trust / safety notes
- **Non-custodial**: sats arrive via the user's own Fedimint receive invoice; Chama never custodies.
- **No new money-path risk in Chama**: ChapSmart just pays the funding invoice; the lock/escrow logic is
  byte-identical. If ChapSmart fails to pay, the funding times out exactly like an unpaid QR — no sats moved.
- **Sim**: gate the ChapSmart method off in sim (no real M-Pesa); the sim funding stays the LN auto-settle.
- **Fees/limits**: surface ChapSmart's spread + any M-Pesa per-transfer cap in the quote step.

## Build order (when Jetty green-lights + ChapSmart v2 lands)
1. `chapsmart-onramp.ts` client module (starter shipped) — finalize response shapes + base URL once confirmed.
2. `fundingMethod === "chapsmart"` in `fund-and-lock` + `useEscrow` (mirror the NWC wiring).
3. AtomicFundingModal "Fund with M-Pesa" sub-flow (quote → pay → submit), gated to non-Exchange verticals + off in sim.
4. Config: proxy base URL const + CORS on the server.

## ✅ CONFIRMED 2026-07-08 (ChapSmart API v6 doc + Jetty) — kills most of the TODOs above
Source: `ChapSmart_API_v6_Public` (March 2026, Chama-Vault/ChapSmart; PDF in ~/Documents) + Jetty's answers.
The Buy Sats API is **already built end-to-end** — nothing for ChapSmart to build except (optionally) v2 auto-pickup.

- **Real endpoints + shapes** (base `https://backend.chapsmart.com`, auth `X-API-Key`/`X-API-Secret` headers on
  every call — the whole reason the proxy exists):
  - `POST /api/v1/buy/quote` `{ amountTZS, accountNumber }` → `{ success, quoteId, amountTZS, calculatedSats,
    btcPrice, message }`. **TZS-driven, 30-min TTL, single-use.** Quote is NOT sats-driven — for an exact-sats
    escrow invoice, estimate TZS from `btcPrice`, re-quote once, land inside the ±2% tolerance (workable today;
    an `amountSats` input is a nice-to-have ask).
  - `GET /api/v1/buy/quote/:id` — poll/refresh a quote.
  - `POST /api/v1/buy/mpesa-lookup` `{ mpesaId }` → `{ found, amount, phoneNumber, senderName }` (read-only) —
    use to PRE-VALIDATE the pasted code before send-sats (much more forgiving v1 UX).
  - `POST /api/v1/buy/send-sats` `{ quoteId, bolt11, mpesaId }` — server verifies: quote exists/unexpired/unused ·
    M-Pesa amount == quote TZS · **BOLT11 amount within ±2% of quoted sats** · mpesaId never used (replay
    protection, `used_mpesa_ids`). Errors: 409 = reuse/mismatch, 410 = quote expired, 429 = rate limited.
  - Nostr auth is native: `POST /api/v1/auth/nostr/signup|login|link` (NIP-98 signed event, one pubkey ↔ one
    16-digit accountNumber) — Chama users need no ChapSmart signup; sign with their existing nostr key.
- **How the user pays (the modal copy — was the biggest unknown):** M-Pesa **agent-withdrawal** flow (Kutoa
  Pesa), NOT a paybill: dial `*150*00#` → option 2 (Kutoa Pesa) → **agent/wakala number 1228685** → amount →
  name reads **BRIAN** (Brian Mbosha, ChapSmart) → PIN. The M-Pesa SMS confirmation code the user receives
  **is the `mpesaId`**. Modal: numbered steps (SW+EN), copy button on 1228685, "name should read BRIAN" check,
  then the code field (pre-validated via mpesa-lookup).
- **TZ-only (policy, NOT enforced):** ChapSmart enabled buy-sats for Tanzania-local users only. Chama-side
  implementation = gate the funding method to TZ context (mirror `isTanzaniaPayoutContext`) + a soft "requires
  a Tanzanian M-Pesa line" note. ⚠ **Proxy IP subtlety:** ChapSmart sees the VPS IP (IncogNET), never the
  user's — tell ChapSmart when requesting the key ("traffic comes from my VPS, whitelist it") so future geo-IP
  enforcement doesn't silently kill the integration; forward `X-Forwarded-For` if they ever want user-level geo.
- **API key:** Jetty requesting from ChapSmart (their `POST /api/admin/generate-key`; supports IP-scoping —
  scope to the VPS 23.137.251.242). ⚠ **Keys expire after 1 YEAR** — calendar the renewal.
- **Limits:** buy-sats min/max (§4.3) still unconfirmed — no LNURL leg to self-describe them (the AlbyGo
  ₿1.5k–61.2k range is the OFF-ramp's LUD-16 minSendable/maxSendable, a different rail). Ask, or probe the 400.
  If similar to the off-ramp cap, the UI must bound fundable trade size upfront. Buy-sats fee = flat rate
  (no tiers), spread baked into `btcPrice` — ask the effective % for honest "You pay X TZS" display.
- **Still open:** v2 mpesaId auto-pickup mechanism + timeline (they already ingest M-Pesa callbacks —
  `mpesa_transactions` — so phone+amount matching is plausible); send-sats → BOLT11 payment latency + their
  refund story when the LN payment fails (Chama is fund-safe either way; the copy needs THEIR answer).
- **Proxy deploy (Jetty-side):** the router source is `~/Downloads/chapsmart.ts` (the old satoshimarket backend
  died with the 1984 box). Stateless — mount on the IncogNET VPS behind Caddy, env the key/secret, CORS for
  getchama.app + chama.community + localhost dev ports + Tauri/APK webview origins. Reliance is contained:
  only this optional funding method rides it; escrow/QR/NWC funding stay serverless and fail-soft if it's down.

## ✅ CONFIRMED RESTRICTIONS 2026-07-09 (from ChapSmart — the anti-fraud limits)
Direct from ChapSmart (buy-sats pulls money from a phone via M-Pesa collection, so these are fraud controls):
- **Amount: 1,000 – 100,000 TZS per transaction** (≈ $0.40 – $40) — resolves the §4.3 unknown above. ⇒ Chama must
  **hard-bound the "Fund with M-Pesa" option to trades whose funding TZS lands in [1k, 100k]** — hide/disable it (with a
  reason) outside that band. Above 100k TZS: not fundable in one buy (DON'T split — fall back to QR/NWC).
- **Daily: max 10 buy transactions per account per day** (≈ $400/day ceiling). Friendly 429 copy ("daily M-Pesa limit
  reached — fund another way or try tomorrow").
- **Quotes: 30-min TTL, single-use** (already handled — re-quote on 410/expiry, never reuse a quoteId).
- **Phone binding: one phone ↔ one account, PERMANENT; one account ↔ one phone.** The Nostr-auth account (one npub ↔ one
  16-digit account) is now ALSO phone-locked. Normal single-user = fine; surface a clear error if a phone is already bound.
- **Location: Tanzania IP only; VPN/proxy BLOCKED.** (Already TZ-gated.) ⚠ Ethos tension: Tor/VPN users — a real slice of
  a privacy app — can't use it. Fine as an OPT-IN fallback (they have Lightning/NWC); just never present ChapSmart as the
  PRIMARY funding path.

### ⚠⚠ THE CRITICAL GOTCHA — device fingerprint × the proxy collide (Jetty ↔ ChapSmart, resolve BEFORE launch)
ChapSmart caps **2 accounts per device per day** using TWO fingerprints: **server-side** (IP + User-Agent hash) and
**client-side** (browser `visitorId`). But **all Chama traffic flows through your single VPS proxy** — so the
**server-side fingerprint is IDENTICAL for every Chama user** (the proxy's IP+UA). If ChapSmart keys the device limit on
that, your **entire userbase shares one "device" → only 2 Chama accounts can be created per day, globally.** That kills
the integration at scale. Resolution (BOTH required):
1. **Chama sends a distinct client-side `visitorId` per user/device** — a lightweight browser fingerprint (FingerprintJS
   or similar), generated ONLY when the user opts into "Fund with M-Pesa" (never ambiently), disclosed as *ChapSmart's*
   anti-fraud (not Chama's). Forward it through the proxy → ChapSmart.
2. **ChapSmart must key the 2-accounts/device/day limit on that client `visitorId`, NOT the proxy IP+UA.** Tell them
   explicitly (same convo as the geo-IP whitelist + `X-Forwarded-For`): "every Chama request shares my VPS IP+UA, so your
   server-side device fingerprint is useless for me — enforce the device limit on the client visitorId I send, or you cap
   my whole userbase at 2/day."
This is the ONE item that can silently break the integration; everything else is bounded error-handling.

### Net (for CC / the build)
Not a detour — a scoping tighten. ChapSmart stays exactly what it's best at: a **small-amount TZ fiat on-ramp for a
fiat-only newbie's first trade** (bills, small marketplace, chip-in — all inside the 100k-TZS band). CC's built module
needs: (a) the [1k, 100k] TZS trade-size bound on the option, (b) a client `visitorId` sent on account-create/quote,
(c) friendly 429/409/410 copy for the daily/device/reuse limits, (d) the opt-in fingerprint disclosure. Stays flag-
dormant (`CHAPSMART_ONRAMP_ENABLED=false`) until the key + proxy + the device-fingerprint agreement all land.
