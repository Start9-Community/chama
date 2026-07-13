# LUD-16 offramp provider requirements (how to work like Tando)

**Purpose.** The checklist a fiat-offramp provider's endpoint MUST meet to be a **native
one-tap offramp** in Chama (the way Tando / `bitcoin.co.ke` and ChapSmart / `chapsmart.com`
are), plus how Chama wires it. Written after a real incident: ChapSmart's endpoint was
perfectly valid LUD-16 but shipped **without a CORS header**, so it worked from a node
(Alby Hub) and from `curl` but failed in-app with "Couldn't reach…" — because a browser/
webview `fetch()` enforces CORS and a server-side payer doesn't. **CORS is the #1 gotcha —
put it first.**

---

## Part A — what the PROVIDER's endpoint must do (forward this to them)

**1. ⭐ CORS — the thing that's invisible until it isn't.**
Every response under `/.well-known/lnurlp/*` (the metadata GET, the `?amount=` callback,
and any `verify` URL) MUST send:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, OPTIONS
```

It has to be `*`, **not** an origin allowlist — a wallet's origin is unpredictable
(`tauri://localhost` native, `localhost:<port>` in dev, `https://getchama.app` on web). A
public Lightning-Address payRequest is public data anyway, so `*` is standard and safe.
This is exactly what `bitcoin.co.ke` does and what the `chapsmart-lnurl` reference server
sets (`server.ts`). **Self-test (a GET, because some servers only set CORS on GET):**

```
curl -s -D - -o /dev/null -H "Origin: https://example.com" \
  "https://<domain>/.well-known/lnurlp/<test-localpart>" | grep -i access-control
```

Expect `access-control-allow-origin: *`. Empty output = not set = will fail in-app. If it's
set at the origin but still empty here, a CDN/proxy in front is stripping or caching it —
purge the cache.

**2. LUD-16 / LUD-06 payRequest.** `GET https://<domain>/.well-known/lnurlp/<localpart>`
returns JSON with: `callback` (string), `minSendable` + `maxSendable` (**millisats**,
numbers), `metadata` (a LUD-06 JSON-array string containing at least a `text/plain` entry;
`text/identifier` recommended), and `tag: "payRequest"`. HTTPS, valid cert, no auth wall.

**3. Callback → BOLT11.** `GET <callback>?amount=<millisats>` returns `{ "pr": "lnbc…" }`.
**Chama sends the amount in millisatoshis** (the standard LNURL path) — a provider does NOT
need the fiat/`currency` amount path for Chama to work.

**4. Amount range.** Chama validates the claim against `minSendable`/`maxSendable` (msats)
and fails safe if out of range. Set them to cover realistic payout sizes.

**5. Optional (nice, not required — Chama tolerates their absence).** LUD-21 `verify`
(settlement confirmation on the callback response); the `currency`/`multiplier` object for
fiat display (this is the unratified proposal #207/#251, **not** LUD-21 — Chama ignores it);
a `successAction` receipt URL.

---

## Part B — how Chama wires a native offramp (internal)

1. **A pure `<provider>-offramp.ts` module** in `src/payments/`, mirroring
   `tando-offramp.ts` / `chapsmart-offramp.ts`: the domain constant, phone/username
   normalization + validation (fail fast client-side), `build<Provider>LightningAddress`,
   address round-trip, and an `is<Country>PayoutContext` gate (community slug + fiat code).
2. **A card + picker in `ClaimPayoutModal.tsx`**, mirroring the Tando/ChapSmart pair: a
   `{ kind: "<provider>" }` payout method, an `<eligible>` flag, the chooser card, a
   `<Provider>MpesaPicker` (phone → `<addr>` → `resolveLightningAddressToInvoice`), and the
   running/terminal status copy. Keep it a separate component from Tando's so the proven
   path stays untouched (DRY it in a later UI pass if desired).
3. **Graduate it out of the redirect registry.** If the provider was a guided redirect in
   `external-swap-registry.ts`, REMOVE that entry when it becomes native — otherwise it
   double-lists (native card + redirect card). Add a `!providerIds.has("<id>")` test, mirror
   of the Tando/ChapSmart assertions. (This is why ChapSmart's registry entry was removed.)
4. **Tests** in `tests.ts`: the pure phone↔address block (mirror the Tando/ChapSmart blocks)
   + the registry-graduation asserts.

The client path (`resolveLightningAddressToInvoice`, `lnurl.ts`) is shared and already
proven — a native offramp is "just a Lightning Address" once the provider meets Part A.
