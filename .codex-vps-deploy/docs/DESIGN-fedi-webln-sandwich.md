# Design — Fedi WebLN sandwich (cross-federation trading) · #52

Status: SPIKE (2026-06-06). One unknown gates the whole build; an on-device
probe (Me › Advanced › "FEDI WEBLN PROBE") answers it. Funding leg already
field-confirmed. Money-path lineage: extends the Fedi ecash rails
(`fedi-internal.ts`) and the escrow funding/claim model.

## The limit we're lifting

In the Fedi mini-app, Chama borrows the **host Fedi wallet's** ecash —
funding a trade with `window.fediInternal.generateEcash`, claiming with
`receiveEcash`. That wallet is joined to **one** federation, so the hard rule
in `federation-config.ts` ("all participants must use the same federation for
the ecash") locks a Fedi user inside their own fed. They can't take a BLF
listing, or any trade whose escrow lives on a different federation.

## What's already true (no longer assumptions)

- **Fedi's `window.webln` pays arbitrary invoices.** Field-confirmed by the
  maintainer (zaps, ppq.ai top-ups, gift-card mini-apps, websites). So
  `webln.sendPayment(bolt11)` is a usable funding primitive inside Fedi.
- **The host wallet is single-federation.** Funding/claims go through it; there
  is no second-fed wallet in the mini-app today.

## The sandwich

To lock a trade whose escrow is on **fed B** while the user's Fedi sits on
**fed A**, bridge with one Lightning hop:

```
host ecash (fed A)
   │  melt → Lightning            (host pays an invoice via window.webln.sendPayment)
   ▼
Lightning invoice issued by fed B's gateway, minting into …
   ▼
Chama's OWN Fedimint WASM client on fed B   ← the open question
   │  ecash on fed B
   ▼
SSS-split into the escrow (the normal LOCK path)
```

Claim is the mirror: reconstruct ecash on fed B → melt to LN via fed B's
gateway → `webln` receive into the host wallet (or export per #56).

So the funding leg (host → LN) is solved. The piece that does NOT exist yet is
**Chama running its own WASM Fedimint client for fed B inside the Fedi
WebView**, which is needed to (a) generate the receive invoice and (b) hold the
minted fed-B ecash before it's locked.

## The one unknown — and the probe that answers it

Chama already ships a WASM Fedimint client (it's what browser/Tauri/APK use).
In Fedi it currently uses `fediInternal` *instead* — but is that a product
choice or a hard constraint of the Fedi WebView? Fedimint's WASM client
typically needs:

- **WebAssembly** (a given), **OPFS** for persistence, and crucially
- **SharedArrayBuffer** for worker threading, which requires the page to be
  **cross-origin isolated** (COOP/COEP headers). A WebView that isn't
  cross-origin-isolated has no `SharedArrayBuffer` → the threaded WASM client
  can't start.

The probe (`FediWeblnProbeCard`, power-user, run inside Fedi) reports exactly
these: `crossOriginIsolated`, `typeof SharedArrayBuffer`, OPFS availability,
WebAssembly, plus the `webln` / `fediInternal` method surfaces and an optional
`webln.enable()` round-trip.

### Decision branches from the readout

- **crossOriginIsolated = YES, SharedArrayBuffer = YES, OPFS = YES** → the WASM
  client can run. Build the sandwich: spin up a fed-B WASM client, fund it via
  `webln.sendPayment`, lock, settle. The cleanest outcome.
- **SharedArrayBuffer = no / crossOriginIsolated = no** → the threaded client
  can't run in the Fedi WebView as-is. Options, in order: (1) a single-threaded
  Fedimint WASM build if one exists; (2) ask Fedi to set COOP/COEP for
  mini-apps; (3) a thinner bridge that avoids holding fed-B ecash locally
  (research) — punt #52 until one lands.
- **webln present but `enable()`/`sendPayment` missing** → re-confirm the
  funding leg before anything else (contradicts the field report; worth a
  second look at the exact method names Fedi injects).

## Invariants (unchanged)

1. No new custody: the user's funds only ever sit in their host wallet, the
   fed-B WASM client they control, or the SSS escrow. No third party.
2. The cross-fed trade is still a normal Chama escrow on fed B — same 2-of-3,
   same holder-only shares, same arbiter rules. Only the *funding source*
   changes (host LN instead of native LN).
3. Honest fees: each Lightning hop costs gateway fees. The sandwich is for
   *reach* (trading cross-fed at all), not the fee-free promise of same-fed
   ecash. Surface the hop fee before the user commits.

## Probe results — iOS Fedi, 2026-06-06 (Bitcrazy-ios, iPhone iOS 18.7)

```
fediInternal: YES — version, generateEcash, receiveEcash, joinCommunity,
  setSelectedCommunity, listCreatedCommunities, createCommunity, sendMessage, …
webln: YES — isEnabled, enable, getInfo, sendPayment, keysend, makeInvoice,
  signMessage, verifyMessage, ensureEnabled
WebAssembly: YES
OPFS: YES
SharedArrayBuffer: NO          ← the wall
crossOriginIsolated: NO        ← the cause
isSecureContext: YES
webln.enable() OK; getInfo → { node: { alias: "Bitcrazy-ios" } }
```

### Verdict: the in-WebView WASM client is OUT (as-is)

`crossOriginIsolated: false` ⇒ no `SharedArrayBuffer` ⇒ Chama's threaded
Fedimint WASM client cannot start in the Fedi WKWebView. OPFS being present is
necessary but not sufficient. So **Chama cannot run its own fed-B client inside
Fedi** — the original sandwich (§"The sandwich") is dead on this platform.

### The silver lining: a WASM-FREE, host-orchestrated path

The probe surfaced a richer toolkit than we assumed. The host Fedi app runs
Fedimint **natively** (outside the WebView, so SharedArrayBuffer is irrelevant
to it), and exposes enough to drive it across federations from Chama:

- `fediInternal.joinCommunity` / `setSelectedCommunity` / `listCreatedCommunities`
  — the host can hold **multiple** federations and switch the active one.
- `fediInternal.generateEcash` / `receiveEcash` — mint/redeem on the selected fed.
- `webln.makeInvoice` **and** `sendPayment` — make a receive invoice on one fed
  and pay it from another, i.e. the Lightning melt→mint, entirely inside the
  host wallet.

So the revised flow keeps ALL Fedimint work in the host (no WebView WASM):

```
1. host.joinCommunity(fedB)              (if not already joined)
2. host.setSelectedCommunity(fedB); webln.makeInvoice(amount)   → fed-B invoice
3. host.setSelectedCommunity(fedA); webln.sendPayment(invoice)  → melt A → mint B
4. host.setSelectedCommunity(fedB); fediInternal.generateEcash(amount) → fed-B ecash
5. SSS-split that into the escrow (normal LOCK). Claim mirrors it.
```

Chama orchestrates; the host does the cryptography. This is arguably CLEANER
than running a second WASM client.

### Open semantics to verify on-device (follow-up probe)

The primitives exist; their exact scoping needs confirming before building:
- Does `generateEcash` / `webln.makeInvoice` / `sendPayment` operate on the
  **currently selected** community (so the switch-then-act dance works)?
- Does `setSelectedCommunity` round-trip cleanly mid-flow without yanking the
  user's Fedi UI (use `navigateHome` to restore)? Any confirm prompts?
- Per-hop gateway fees for the A→B Lightning payment.

### Side avenue (cheaper, uncertain): flip crossOriginIsolated

`crossOriginIsolated` is `false` partly because Chama's VPS doesn't serve
COOP/COEP headers. Serving `Cross-Origin-Opener-Policy: same-origin` +
`Cross-Origin-Embedder-Policy: credentialless` and re-running the probe would
tell us whether the WKWebView even HONORS isolation. If it flips to `true`,
the clean WASM sandwich reopens. Risks: COEP can break cross-origin
subresources (e.g. Google Fonts → self-host them), and iOS WKWebView support
for cross-origin isolation inside a mini-app is unproven. Worth one cheap
experiment before committing to the host-orchestrated build.

## Probe v2 — community map (read-only), iOS Fedi 2026-06-06

```
getAuthenticatedMember: { id: "@npub1vksv0…:m1.8fa.in", username: "Bitcrazy-ios" }
getCurrencyCode: USD
getLanguageCode: en
listCreatedCommunities: ERROR "Permission requesting not available in production"
getInstalledMiniApps:   ERROR "Permission requesting not available in production"
```
Fedi also surfaced a toast: *"getchama.app is missing the following
permissions: manageInstalledMiniApps."*

### Second wall: the Fedi mini-app PERMISSION model

The community/multi-fed methods are **permission-gated**, the Chama mini-app
doesn't hold the grant, and **runtime permission requests are disabled in
production** Fedi. So `listCreatedCommunities`, and by extension
`setSelectedCommunity` / `joinCommunity`, are unavailable to Chama in prod —
which kills the host-orchestrated switch-and-act flow too. The host's identity
is the npub (`@npub1…:homeserver`) and the selected fed's currency reads
cleanly (USD), but Chama cannot enumerate or switch the host's federations.

### Net verdict on #52: NOT unilaterally possible in production iOS Fedi

Both paths are walled, by two different gatekeepers:

| Path | Wall | Owner |
|------|------|-------|
| Chama runs its own WASM client on fed B | no SharedArrayBuffer / crossOriginIsolated | the WKWebView |
| Host-orchestrated multi-fed (switch + generate) | community-management permission not granted; can't request in prod | Fedi's mini-app permission model |

What DOES work today (granted, unilateral): `generateEcash` / `receiveEcash`
on the host's **currently selected** fed, all of `webln` (make/pay invoice),
`getAuthenticatedMember`, `getCurrencyCode`. So Chama-in-Fedi is fully
functional **within one federation** — it is specifically the *cross-fed reach*
that's blocked.

### Path forward: a Fedi partnership ask, not a Chama build

Lifting the limit needs Fedi to grant one of:
1. **(preferred) the community-management / multi-fed mini-app permissions** for
   the Chama app — then the host-orchestrated melt→mint flow (already designed
   above) works as-is. Lower effort for Fedi; pure grant.
2. **cross-origin isolation for mini-app WebViews** (COOP/COEP) — then Chama's
   WASM client could run. Heavier, and the WASM path carries its own browser
   reliability baggage.

Recommended: raise (1) with the Fedi team (the maintainer already has a thread
open in the fedimint-sdk discussions, #300). Optionally prove the flow first in
a Fedi **nightly/dev** build, where permission *requesting* is available, then
ask for the production grant. Until then #52 is design-complete and **parked**;
ship v2.5 with what's built (nsec reveal + sign-in declutter).

## Build order (once Fedi grants the permission)

1. Fed-B WASM client lifecycle inside Fedi (init/join/teardown alongside the
   host wallet).
2. `webln.sendPayment` funding of a fed-B receive invoice → minted ecash.
3. Wire that ecash into the existing LOCK path; mirror on claim.
4. Fee preview + the cross-fed educational beat (TradeDetail already has a
   "CROSS-FEDERATION" card to extend).
