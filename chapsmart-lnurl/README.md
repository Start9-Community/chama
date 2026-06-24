# chapsmart-lnurl

A minimal, correct **LUD-16 (Lightning Address)** server for Chapsmart, backed by
[ACINQ **phoenixd**](https://github.com/ACINQ/phoenixd). It lets anyone pay
`username@your-domain` from any Lightning wallet.

LUD-16 is just the *addressing* layer on top of **LUD-06** (`payRequest`). This
server implements exactly those two specs, plus optional **LUD-12** comments and
a **LUD-09** success message. That's all a wallet needs.

```
wallet                         this server                      phoenixd
  │   GET /.well-known/lnurlp/alice  │                              │
  │ ───────────────────────────────►│  (LUD-16 + LUD-06 step 1)     │
  │   payRequest { callback,         │                              │
  │ ◄─────────────  metadata, … }    │                              │
  │                                  │                              │
  │   GET <callback>?amount=<msat>   │                              │
  │ ───────────────────────────────►│  sha256(metadata) ──────────►│ POST /createinvoice
  │                                  │                              │   (descriptionHash)
  │            { pr: <bolt11> }      │ ◄───────────── serialized ───│
  │ ◄────────────────────────────── │                              │
  │   pay the bolt11 ───────────────────────────────────────────► (phoenixd receives)
```

## Why phoenixd

phoenixd is a self-custodial Lightning node with a tiny HTTP API and automatic
channel/liquidity management — ideal for "just receive payments to an address."
Its `/createinvoice` supports `descriptionHash`, which LUD-06 **requires**.

## ⚠️ Custodial model — read this before going to production

A single phoenixd instance is **one wallet**. Every `username` this server
exposes resolves to that same node, so **all incoming funds pool together**.
This server tags each invoice with `externalId = username@host` so you can tell
*who a payment was for*, but **you** must keep the ledger that credits the right
internal account. phoenixd does not do per-user balances.

If Chapsmart needs true per-user custody or non-custodial routing, this server
is the addressing layer only — pair it with your own accounting (recommended) or
a multi-tenant Lightning backend.

## Setup

### 1. Run phoenixd

Install from the [phoenixd releases](https://github.com/ACINQ/phoenixd/releases),
then start it once to generate `~/.phoenix/phoenix.conf` (which contains an
auto-generated `http-password`). API listens on `127.0.0.1:9740` by default.

### 2. Configure and run this server

```bash
cp .env.example .env
#   edit .env: set LNURL_HOSTNAME and the phoenixd http-password
npm install
npm test         # verifies the metadata/description-hash invariants (no node needed)
npm run dev      # or: npm start
```

### 3. Put TLS in front

Wallets require **HTTPS** on clearnet. Terminate TLS at nginx/Caddy/Traefik and
proxy to this server. Your address domain (`LNURL_HOSTNAME`) must match the
public HTTPS host.

## Endpoints

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/.well-known/lnurlp/:username` | LUD-16 payRequest |
| GET | `/lnurlp/:username` | LUD-06 payRequest (direct) |
| GET | `/lnurlp/:username/callback?amount=<msat>&comment=<text>` | Returns `{ pr: <bolt11> }` |
| GET | `/healthz` | Liveness |

Quick check (after setting up phoenixd + .env):

```bash
curl https://pay.chapsmart.com/.well-known/lnurlp/alice
curl "https://pay.chapsmart.com/lnurlp/alice/callback?amount=21000"   # 21 sats
```

## The one rule people get wrong

The bolt11 invoice's **description hash** must equal `sha256(` the exact
`metadata` string returned in step 1 `)`. This server builds that string in a
single place (`buildMetadata` in `src/lnurl.ts`) and re-derives the identical
bytes in the callback before hashing. If you change the metadata, change it in
that one function only. `npm test` guards this invariant.

## Configuration

All via environment variables — see `.env.example`. Highlights:

- `LNURL_HOSTNAME` — public address domain (no scheme).
- `PHOENIXD_URL` — e.g. `http://_:PASSWORD@127.0.0.1:9740` (password = phoenixd `http-password`; the limited-access password is enough).
- `MIN_SENDABLE_SAT` / `MAX_SENDABLE_SAT` — amount bounds.
- `COMMENT_ALLOWED` — LUD-12 max comment length (0 disables).
- `ALLOWED_USERNAMES` — optional lowercase allowlist; empty = accept any.

## Extending

- **Payment verification (LUD-21 `verify`)** — add a `verify` URL to the
  payRequest and an endpoint that checks `GET /payments/incoming/{paymentHash}`
  on phoenixd. Lets payers confirm settlement without watching the chain.
- **Nostr zaps (NIP-57)** — add `allowsNostr: true` + `nostrPubkey`, and accept
  a zap request in the callback. (phoenixd has a webhook you can bridge.)
- **Fiat-denominated amounts** — the `currency`/`multiplier` object some services
  (e.g. bitcoin.co.ke) return is **not** part of ratified LNURL; it comes from
  open proposals ([PR #207](https://github.com/lnurl/luds/pull/207),
  [PR #251](https://github.com/lnurl/luds/pull/251)). Standard wallets ignore
  unknown fields, so you can add it later for KES display without breaking
  compatibility. Don't block a LUD-16 launch on it.

## File map

```
src/config.ts     env parsing + validation
src/lnurl.ts      pure helpers: metadata, payRequest, sha256, validation
src/phoenixd.ts   phoenixd HTTP client (the only Lightning-node coupling)
src/server.ts     Express routes (payRequest + callback)
src/selftest.ts   invariant checks (npm test)
```

## Specs

[LUD-06](https://github.com/lnurl/luds/blob/luds/06.md) ·
[LUD-09](https://github.com/lnurl/luds/blob/luds/09.md) ·
[LUD-12](https://github.com/lnurl/luds/blob/luds/12.md) ·
[LUD-16](https://github.com/lnurl/luds/blob/luds/16.md) ·
[phoenixd API](https://phoenix.acinq.co/server/api)
