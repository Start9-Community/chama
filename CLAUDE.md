# CLAUDE.md — start-here memory for AI agents on Chama

**Read this first.** It's the durable context so a new chat doesn't restart from zero.
If something here is stale, fix it here. Maintainer: Jetty. Style: concise + direct;
leave changes **uncommitted** unless told (Jetty does the git split); confirm-first on
big/irreversible moves.

## What Chama is
Local-money / P2P Bitcoin marketplace: **Fedimint** (ecash), **Nostr** (identity, chat,
escrow coordination), **Lightning** (funding). Platforms: web (getchama.app /
chama.community), **Tauri** desktop, **Android APK** (Zapstore + GitHub). Version: see
`package.json` (**v3.7.0** as of 2026-06-23). Targeting a **Nairobi launch**; Benin/Cameroon
francophone framing.

## Doc set (read, don't duplicate)
`PHILOSOPHY.md` ethos · `DECISIONS.md` decision log · `BACKLOG.md` backlog ·
`INVARIANTS.md` must-holds · `BRAND.md` · `PRE-LAUNCH-QA-GATE.md` go/no-go ·
`native/fedimint-bridge/FRESH-JOIN-SMOKE.md` mobile smoke ·
`design/mockups/chama-fedimint-freshjoin-CC-brief.md` iroh brief + live status.

## ⭐ RELEASE WORKFLOW (the one Jetty shouldn't have to re-explain)
After a fix, decide scope, then **one gated command**:

```
npm run ship -- --patch|--minor|--major     # patch is default
```

`ship.sh` then: bumps `package.json` → `git add -A` + commit (`-F` the notes file) → push
`main` → `npm run release:all` (GitHub release + Zapstore). Fully gated: it computes the
target version up front and **refuses to start if the required notes file is missing**, so a
typo can't half-bump the tree.

**Claude's job before that command — produce TWO files for the TARGET version** (= version
*after* the bump, e.g. 3.7.0 + patch → `3.7.1`), placed in `/tmp` (`CHAMA_COMMIT_DIR` default):
- `/tmp/chama-v<TARGET>_release_notes` — **REQUIRED**. Doubles as the commit message AND the
  GitHub release body.
- `/tmp/chama-v<TARGET>_zapstore_notes` — optional, short Zapstore card text.

Template: `scripts/release-notes-template.txt`. Bump sizing: patch = small fix, minor =
features, major = breaking/big. Handy flags: `--dry-run` (print plan, run nothing),
`--no-release` (bump+commit+push only), `--set-version X.Y.Z`. Signing/Zapstore env
(`SIGN_WITH`, `CHAMA_ZSP_BIN`, `CHAMA_GPG_KEY`) is defaulted in `ship.sh`.
> Note: Claude writes these from the sandbox; if it can't write the user's `/tmp` directly,
> it delivers the two files and Jetty drops them in `/tmp` (or sets `CHAMA_COMMIT_DIR`).

## DEV / TEST WORKFLOW
- **3-instance dev** (seller/buyer/arbiter), fixed ports = stable origins = persistent sessions:
  ```
  npm run tauri:sidecar               # ONCE first — builds the Rust bridge binary
  ./scripts/dev-instance.sh 3001 seller
  ./scripts/dev-instance.sh 3002 buyer
  ./scripts/dev-instance.sh 3003 arbiter
  ```
  Quit with **Cmd+Q** (not just close) so ports free.
- **The native Fedimint bridge is a compiled Rust sidecar** — editing
  `native/fedimint-bridge/src/main.rs` is **NOT hot-applied**. Rebuild + relaunch:
  `npm run tauri:sidecar` (desktop) / `scripts/build-android-fedimint-bridge.sh` (Android).
  Confirm the new binary is live via `/health` (below), not by assuming.
- **Bridge port = frontend port + 15000** (3001→18001, 3002→18002, 3003→18003). Live probes:
  ```
  curl -s 127.0.0.1:18002/health | jq          # resolver/discovery + confirms new binary
  curl -s 127.0.0.1:18002/gateways | jq
  curl -s 127.0.0.1:18002/probe-gateways | jq
  ```
- Pre-ship gate: `npm run predeploy` (typecheck + tests; ~2660 tests as of 2026-06-23).

## ⚠ CRITICAL GOTCHA — two DIFFERENT "can't reach the federation" failures, don't conflate
1. **JOIN / fresh-join hang** (guardian discovery). Native resolves guardians via DNS(:53) +
   mainline DHT(UDP) — throttled/blocked on mobile/CGNAT; the browser uses Pkarr-over-HTTPS.
   Fix landed: bridge `iroh_dns` defaults to n0 pkarr (`https://dns.iroh.link/pkarr`),
   **additive** (stacks on DNS+DHT; `set_iroh_dns` verified additive in
   `fedimint-connectors 0.11.1`). **Only reproduces on real mobile — localhost is always fine,
   so localhost CANNOT validate this fix.** (board item #17). If pkarr resolves but join still
   hangs on mobile → connectivity, not resolution → `FM_IROH_CONNECT_OVERRIDES`/upstream relay
   (no Chama-side relay toggle exists).
2. **FUNDING / gateway selection** — `/invoice` "no reachable Lightning gateway… timed out
   after 12s". Fires **after** the gateway cache refresh *succeeded* (guardians were reachable),
   so it is **NOT the join bug**: the Lightning **gateway** is unreachable/absent. Rebuilding
   the iroh fix does **not** fix this. (board item #9 — "Funding fund-loss fix", LAUNCH BLOCKER,
   gates Fedi live). Triage with `/gateways` + `/probe-gateways`: empty = no gateway; listed but
   unreachable = gateway offline; reachable but `vetted=false` = selection filters it (native
   doesn't filter vetted, so unlikely). **No native funding workaround:** NWC (Jetty's default) only *pays* the
   invoice — the fed must still *generate* the receive invoice via this same broken gateway
   step, so NWC is equally blocked; sim mode isn't available on Tauri/APK. ⇒ #9 blocks ALL
   native funding testing until fixed.

Federations are multi (BP, Afribit Kibera, Bitsacco, BLF [iroh-only, browser default], GBF) —
never break fed-switching.

## TASK BOARD (mirror of Jetty's Progress list, 2026-06-23 — keep in sync)
**Done:** storyboard end-to-end demo video · Obsidian vault sweep · French Nairobi deck
(Benin/Cameroon).
**Open:**
- 7. Ship live: Tauri/APK now, Fedi after funding fix
- 8. Verify native notification taps on real Tauri + APK (pre-demo)
- 9. **Funding fund-loss fix** — CC build + native verify (LAUNCH BLOCKER, gates Fedi live)
- 10. Fiat ramps (pre-Nairobi) — **DECIDED 2026-06-24 (revised):** all external swaps are
  **OFFRAMP-only, post-CLAIM, country-matched** (`EXTERNAL_SWAPS_ENABLED=true`, redirect model +
  honesty copy). **No pre-LOCK CTA** (removed — nobody onramps in-app). **Minmo dropped** (friction);
  **Banxaas offramp-only** (no bidirectional). EXCEPT **Tando = LUD-16 native offramp** (claim to
  `<phone>@bitcoin.co.ke` via existing `resolveLightningAddressToInvoice` — one-tap M-Pesa, no
  redirect; the star). Final set: Banxaas (SN), Chapsmart (TZ), Bitika+Tando (KE), Bitzed (ZM).
  OFFRAMP works; ONRAMP/"lock with fiat" does NOT (LUD-16 pay-only). Brief:
  `design/mockups/chama-fiat-ramps-tando-brief.md`. (`chapsmart-lnurl/` separate; not needed for Tando.)
- 11. Enforce app font — bundle DM Sans + JetBrains Mono
- 12. CBP per-country bill-type picker (Kenya-first)
- 15. Brief CC: pager cart-first landing + Chat unread badge
- 16. [POST-NAIROBI] storefront/menu per-item quantity + persistence
- 17. **CRITICAL** wire iroh-dns lever into bridge spawn (fresh-join) — pkarr default landed;
  needs real-mobile verify
- (queued w/ Jetty) release notes + changelog · pre-launch QA gate (done) · tutorial/walkthrough video

## KNOWN ISSUES being worked
- **#9 funding/gateway** — PINNED (2026-06-23): federation has 3 LN gateways; 2 reachable
  (clearnet HTTPS), 1 dead (`iroh://` Banco Bitcoin, times out). Frontend `/invoice` sends no
  `gatewayId` → bridge's blind `select_available_gateway(None)` chokes on the dead iroh gateway
  and burns the 12s budget before reaching the working ones. **Chama-side fix** (select a reachable
  gateway explicitly) — see `design/mockups/chama-funding-gateway-fix-brief.md`. Fails safe (no sats moved).
  **FIX LANDED** (uncommitted, 2026-06-23): `pick_reachable_gateway` (main.rs) — clearnet-first,
  4s/gateway probe, last-good cache, fails safe; verified blind `/invoice` 12.1s→1.29s, predeploy
  green (2660). Pending UI lock→fund verify (Cmd+Q buyer → relaunch). ⚠ Caveat: a fed with
  ALL-`iroh://` gateways (possibly BLF) still has no reachable native gateway → that fed's funding
  is gated on #17. Per-fed check: run `/gateways`+`/probe-gateways` while joined to the launch fed.
  **SIBLING BUG (claim/payout, 2026-06-23):** Part 1 fixed only `/invoice` (receive). The outgoing
  `/pay` path (`pay()`, main.rs:1090) still uses blind `ln.get_gateway(None)` → same dead-iroh failure
  ("/pay failed (500): Failed to connect to gateway") on CLAIM. Fix = apply `pick_reachable_gateway`
  to `pay()`'s auto path too (brief Part 2). Fails safe (released ecash retained; payout pending).
  **⚠ DOUBLE-PAY (Part 3, verified 2026-06-23):** Part 2 makes native `/pay` actually *send* for the
  first time → exposes a latent double-pay. The v3.5.1 journal guard only protects when the error has
  `code === "LN_PAY_INFLIGHT"` (claim-and-payout.ts:763), which is produced ONLY in browser
  `sdk-adapter.ts`; native throws a plain Error (no code) + has no `awaitPayOutcome` → ambiguous
  payouts misclassified re-payable → retry pays TWICE. Also: refund returned as 200 `{"Failure":…}`
  mis-read as settled. Fix = native submitted→reconcile guard (brief Part 3). **Ship Part 2 + Part 3
  together; never Part 2 alone on native.**
- **Payout-journal residuals (2026-06-23 adversarial sweep)** — Part 2/3 + a caught classifier
  double-pay + a lost-`/pay`-response double-pay are all closed (native at browser parity). Two
  PRE-EXISTING, cross-platform journal gaps remain. **V8** (`saveJournal` payout-journal.ts:96 swallows
  a localStorage write error → guard lost → double-pay, no crash needed) — **DONE + adversarially verified, uncommitted (v4.0.0)**:
  fail-closed — `saveJournal` re-throws; `assertPayoutJournalWritable` probe refuses *before* `payInvoice`;
  a post-send persist failure forces `payout-confirming`; applied to claim + recovery paths (2696 tests green). **V7** (journal
  written AFTER `/pay`; app-death mid-pay → empty journal → double-pay) **+ V6** (stuck
  payout-confirming) — **deferred to next leg**, brief:
  `design/mockups/chama-payout-journal-hardening-brief.md` (pre-send journaling + reconcile-by-escrow).
- **Relay-connect fragility (2026-06-24)** — "Not connected — call connect() first" / "Connect to
  relays before initializing Fedimint" blocked join/init when the relay pool was degraded. Root: 3 of 5
  `DEFAULT_RELAYS` (damus, primal, offchain.pub) down → only 2 connected, + a connect→init→join race.
  **NOT a #9 regression** (verified via diff). Brief: `design/mockups/chama-relay-connect-resilience-brief.md`.
  **FIX LANDED** (uncommitted, 2026-06-24, predeploy green 2706, +10 relay-manager tests):
  (1) broadened `DEFAULT_RELAYS` 5→7 (+snort.social, +nostr.land — **margin URLs, confirm in smoke
  tests / swap**) + adaptive fetch quorum `min(3, relayCount-1)` (relay-manager `effectiveQuorum`);
  (2) reconnect now fires on `ws.onerror` (not just onclose) + a dedupe guard so error+close arm one
  retry; (3) `forceReconnectAll()` clears the MAX_RETRY_COUNT=8 permanent give-up and re-probes — wired
  into the in-app Reconnect (was init-only) via `actions.recoverRelays`; (4) auto-init re-arms on relay
  growth (latch on success, not on dispatch; hard-stop only for reconcile-refused); (5) soft-gate —
  Create/Join `await ensureRelayReady` (forceReconnectAll + bounded retry, no dead-end throw; guards
  tagged `RELAYS_CONNECTING`/`NOT_CONNECTED`/`SIGNER_NOT_READY`), Fund `ensureFedimintReady` (bounded
  in-window wait, **never queues a deferred payment — fresh tap on timeout**). ⏳ Pending: Jetty's
  authoritative 3-instance verify (point 3 default relays at dead URLs → connect/init/join/fund stay
  graceful; pool auto-recovers w/o manual Reconnect). NOTE: damus/primal/offchain are normally
  high-uptime — all-3-down lines up with the brief's local-OOM amplifier; rule that out too.
  Launch-grade follow-up (not built): a Chama-run relay.
- **Chat wipe on restart** — after a full instance restart, trade chat rehydrated only the first seller
  message: partial Nostr-relay rehydration (a relay was down). Same family as ↑. **Addressed together**
  (uncommitted): broadened pool + adaptive quorum restore complete first-load rehydration, and Part 6
  adds a throttled relay-recovery backfill (escrow-client: on a relay reconnect, re-`loadEscrow` watched
  non-terminal trades — loadEscrow merges + never shrinks chat). Confirm in the 3-instance restart test.
- **Claim "credit unconfirmed" over-alarm (2026-06-24)** — a *successful* claim ends in loud red "CLAIM
  NEEDS ATTENTION" (MeScreen.tsx:256) for both parties. `markUnresolvedCredit` fires on mint
  `ALREADY_SPENT_UNCONFIRMED` (escrow-bridge.ts:677) = note confirmed spent but wallet-credit
  unconfirmed; the `unresolved-credit` variant gets the same loud "save the bearer note" treatment as a
  live note. **Fund-SAFE** (spent note can't double-spend) — UX bug, common on native. Fix =
  **balance-reconcile** (auto-resolve silently when balance confirms; calm dismissible alert only when it
  can't), scope to `unresolved-credit` only (keep loud red for retries-exhausted/poisoned = maybe-live),
  archive not delete. Brief: `design/mockups/chama-claim-credit-reconcile-brief.md`. Pre-launch.
