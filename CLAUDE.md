# CLAUDE.md — start-here memory for AI agents on Chama

**Read this first.** It's the durable context so a new chat doesn't restart from zero.
If something here is stale, fix it here. Maintainer: Jetty. Style: concise + direct;
leave changes **uncommitted** unless told (Jetty does the git split); confirm-first on
big/irreversible moves.

## What Chama is
Local-money / P2P Bitcoin marketplace: **Fedimint** (ecash), **Nostr** (identity, chat,
escrow coordination), **Lightning** (funding). Platforms: web (getchama.app /
chama.community), **Tauri** desktop, **Android APK** (Zapstore + GitHub). Version: see
`package.json` (**v4.0.0** shipped 2026-06-24). Targeting a **Nairobi launch**; Benin/Cameroon
francophone framing.

## Doc set (read, don't duplicate)
`PHILOSOPHY.md` ethos · `DECISIONS.md` decision log · `BACKLOG.md` backlog ·
`INVARIANTS.md` must-holds · `BRAND.md` · `PRE-LAUNCH-QA-GATE.md` go/no-go ·
`native/fedimint-bridge/FRESH-JOIN-SMOKE.md` mobile smoke ·
`design/mockups/chama-fedimint-freshjoin-CC-brief.md` iroh brief + live status.
**4.1 / bond briefs (2026-06-24):** `chama-arbiter-bond-phase2-brief.md` (finish-the-bond, staged) ·
`chama-inapp-help-brief.md` (E) · `chama-4.1-newbie-polish-brief.md` (ratings-in-chat · TradeView
rect + default-pane · CBP picker · unread badge) · `chama-notifications-fix-brief.md`.

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
- `/tmp/chama-v<TARGET>_zapstore_notes` — optional, short Zapstore card text. **Style = match the
  PREVIOUS card** (`zapstore/release-notes.md`): a `# Theme` title, a one-line ⚡ tagline,
  **emoji-led benefit bullets** (🇰🇪/⚡/🛡️/🌍…), and a `·`-separated proof closer (e.g. tests-green
  count). Spice it — don't just list features. **Until board #20 ships, always include a "your
  country's coming Live" signal** — global demand is real (US: 846k Zapstore impressions / month) but
  capped by the "is it even live here?" perception.

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

## TASK BOARD (reconciled 2026-06-24 — v4.0.0 SHIPPED to Zapstore; keep in sync)
**SHIPPED in v4.0.0 (live):** #9 funding fund-safety (gateway Part1/2 + double-pay Part3 + V8 journal
fail-closed) · #17 native fresh-join pkarr · relay resilience + chat-wipe · claim-credit reconcile ·
UI pass (unified vote/mark-done, refund-reason picker, calm refund bubbles, DM Sans, TradeDetail
one-block) · #10 fiat ramps offramp-only registry + **Tando LUD-16 M-Pesa** · release notes + Zapstore
publish · launch announcements (EN+FR) · newbie FAQ (EN+FR, 0.5% fee). Live-verified in Kenya (real
trade → M-Pesa in minutes). **Earlier:** storyboard demo · Obsidian vault · French Nairobi deck · QA gate.

**RELEASE PLAN (set 2026-06-24):**
- **4.1.0 "newbie-polish" — BUILT 2026-06-25 (uncommitted, predeploy green 2733, typecheck clean):** all 5 UI
  items landed, zero money-path/reducer touch except the additive `billType` field. (1) **ratings-in-chat** — 3rd
  `RatingTap` render site at the Chat feed end on COMPLETED (`ChatPanel.ratingCta` ← `TradeDetail.chatRatingCta`);
  Parties + Me copies kept. (2) **TradeView fixed-rectangle** — shell → `overflow:hidden` (App.tsx `.trade-detail-shell`),
  action card wrapped in an internal-scroll zone (`flex:0 1 auto`), `td-lower` keeps a min-height FLOOR + `flex:1 1 0`
  (pager floor moved off `td-pager`), timeline = pinned `flex:0 0 auto` footer; the outer wrapper already pinned 100dvh.
  Plus `defaultPaneFor` (CREATED/payer-at-LOCK → Details, else Chat) + bold **"You owe KES X"** / "You'll receive"
  checkout headline (final fiat: p2p folds premium, CBP premium-in-sats so base) + a "manual-swipe-wins-forever"
  auto-focus guard (`userMovedPaneRef`/`programmaticTargetRef`) + pre-lock storefront-menu compaction. (3) **#12 CBP
  bill-type picker** — `billType` wired EXACTLY like `country` (CreatePayload + EscrowState types + escrow-client
  payload + state-machine reducer; informational, never escrow logic); per-country registry `src/communities/bill-types.ts`
  (Kenya list + generic fallback); picker in CreateForm (single CBP, after desc); chip on TradeCard + Details. (4) **#15
  unread badge** — device-local `src/chat/unread.ts` (localStorage `chama_chat_last_read_v1`); Chat pager pill + TradeCard
  badges (Me-tab dot deferred — needs an App trade-scan). (5) **E in-app help** — `HelpScreen` off Me settings, `src/ui/content/faq.ts`
  hand-mirrored from `docs/FAQ.md`, reusable `HelpTip` "?" on the arbiter form header + fed-operator field (NO bond copy;
  `TODO(bond 2A)` seam left). **Live-verified in browser (port-pinned preview):** Help screen + accordion, CBP picker
  (Kenya list renders + selects), HelpTip popover — **caught + fixed a real bug**: the inline-absolute popover clipped
  inside the narrow arbiter card → rewrote `HelpTip` to a viewport-anchored `position:fixed` popover. Dark + light both
  legible (note: on a WIDE desktop viewport the body bg stays dark behind the centred phone-width column — PRE-EXISTING,
  invisible on mobile). ⏳ **Pending Jetty's authoritative 3-instance verify:** the TradeView lifecycle matrix
  (reserved→locked→marked→vote→2nd-vote→released→claim→settled × buyer/seller/arbiter; outer rect NEVER scrolls;
  timeline footer always visible; **Tauri AND APK separately** — Jetty suspects a Tauri-only webview dvh quirk) +
  ratings-CTA-at-settle + unread-badge-live. **Note:** `docs/FAQ.md` has NO "M-Pesa per-transfer limit" line the brief
  cited — mirrored the file faithfully; add it to the markdown first if wanted. Briefs: `chama-4.1-newbie-polish-brief.md`
  + `chama-inapp-help-brief.md`. Ships alongside the **notification firing fix** (already uncommitted).
  - **Punch-list fold-in (2026-06-25, uncommitted, predeploy green 2733):** Jetty's post-build live (Tauri
    sandbox) list. **DONE + browser-verified on a real CREATED CBP trade:** **#17 chat-closes-at-completion**
    (`ChatPanel`: on COMPLETED, composer muted + "💬 Chat is closed" line + the rating CTA gets a green glow) ·
    **#19 pager hard-snap** (`scroll-snap-stop:always` on `.td-pane` + jump-aware `goPane` — a programmatic
    >1-pane jump scrolls INSTANTLY so snap-stop can't trap it at an intermediate pane; verified Parties→Chat lands
    on Chat) · **FAQ 3-surface sync** (mirrored the new "Is there a limit on M-Pesa cash-out?" Q&A from `docs/FAQ.md`
    into `src/ui/content/faq.ts`). Live-confirmed: shell `overflow:hidden` never scrolls, panes hard-snap, default
    pane = Details pre-lock, bill-type chip + generic fallback (BLF=global) render, composer present pre-completion,
    FAQ Q&A renders+expands. **DEFERRED to 4.1.1 (Tauri-only, can't validate in browser):** **#16 offramp redirect**
    — root cause `openExternalSwap` uses `window.open` (`external-swap-registry.ts:292`), blocked in the Tauri
    webview (Tando works = LUD-16 invoice, not a redirect). Fix = add `@tauri-apps/plugin-opener` (JS dep + Rust
    plugin in src-tauri) + an `opener:allow-open-url` capability, then call it when `isTauriRuntime()`; the SAME gap
    breaks `HelpScreen`'s `<a target=_blank>` footer links + every redirect provider (Banxaas/Bitzed too), not just
    Bitika/Chapsmart. **#18 chat-input focus** — needs a Tauri device repro; the new layout keeps the input in the
    pager pane (already `overflow:auto`) so it doesn't obviously regress; candidate = WKWebView nested-scroll focus
    quirk or keyboard/dvh re-layout. **Still pending Jetty's 3-instance (LOCKED/COMPLETED-only):** checkout headline,
    ratings glow + "Chat is closed" at settle, unread badge live, manual-swipe-wins auto-focus.
  - **Help-screen readability pass (2026-06-25, pre-ship gate, uncommitted, predeploy green 2733, browser-verified
    dark+light):** Jetty gated 4.1.0 ship on the FAQ being learnable. (1) `FaqItem.a` widened to
    `string | {intro?,steps[],outro?}`; the 3 numbered answers (buy / sell / M-Pesa cash-out) converted to structured
    steps. (2) `HelpScreen` renders steps as a real hanging-indent `<ol>` (number column + text column — wrapped lines
    align under the step TEXT, not the "1."), and the open answer is now BIG + full-contrast (16px / `T.text` / 1.7 lh,
    was 12.5 / `T.muted`); questions 13.5→15. (3) **focus-on-expand** — while one answer is open, the intro, section
    labels, every OTHER row, glossary + footer recede (opacity .32 + blur 1.5px, .2s transition, still tappable) and the
    open row heroes (faint accent wash + z-lift); collapse restores all equal. Header stays full (it's nav). Live-verified
    on the real Help screen: aligned hanging-indent list, big high-contrast answer, dim+blur focus, restore-on-collapse.
- **4.2.0 "finish the bond" (D — FUND-CRITICAL, staged):** brief `chama-arbiter-bond-phase2-brief.md`.
  Decisions LOCKED 2026-06-24: **2A** custody + ceremony + heal/relock + loud-prompt FIRST (enforcement OFF;
  trio posts tiny/short SEED bonds on real BLF; **2-of-3 SSS reuse** = owner's 1 share + 2 cabinet custodians)
  → **2B** wire capacity context + flip `BONDS_ENFORCED`. ⚠ Reframe: flipping the cap on UNBACKED 38130
  declarations = security theater; the **SSS-lock custody (money path) is the keystone**, not the flip.

**DONE this session (2026-06-24 — briefs/verifications, uncommitted unless noted):**
- A FAQ on website — **LIVE** (`landing/faq.html` + `.fr.html` deployed; home links → `/` canonical root +
  nav parity; FR screenshots removed per Jetty).
- B Zapstore About — refreshed (M-Pesa/Tando one-tap line in `zapstore.yaml`).
- C Onboarding verify — ConnectScreen **ALIGNED** with locked arbiter/bond design; silent on bonds = correct
  while DORMANT; the "post a bond" on-ramp is a Phase-2A surface (in the bond brief), NOT a ConnectScreen change.
- #11 app font — **DONE/verified**: fully self-hosted (`public/fonts/*`, `index.html` preload + `/fonts/fonts.css`);
  Google-Fonts `@import` removed (`App.tsx:2726`). No CDN.
- #8 notification TAP — handler correct + wired (`deep-link.ts`, `App.tsx:1352`), BUT **firing REOPENED as
  broken**. ⚠ Brief's Bug-1 theories were WRONG (CC source-verified `tauri-plugin-notification@2.3.3`,
  2026-06-25): `extra` is valid, `sendNotification` returns void, desktop permission hard-codes Granted,
  `default` already grants `allow-notify`. **Real Tauri cause = macOS signing/identity:** dev posts as
  `com.apple.Terminal`; prod bundle **unsigned** (no `signingIdentity` in tauri.conf.json) → macOS suppresses.
  **macOS-specific; NOT a launch blocker** (Android-first). Fix = sign prod bundle (Apple Dev ID) + make path
  diagnosable. **APK resume-only:** `prev` is in-memory, only trade ids persisted (not status) → killed/cold-start
  (`prev=undefined`) never notifies even on relaunch → fix = **persist per-trade last-seen status** + synthesize
  `prev` on cold start (fired-tag dedup store must be persistent). True background push = separate effort. Brief:
  `chama-notifications-fix-brief.md` (see CORRECTION banner). **✅ ON-DEVICE CONFIRMED 2026-06-25:** filtered
  `[chama/notify]` logs show the app fires correctly (`permission=true` + `tauri notify IPC ok`) for the
  self-test AND locked/approved/completed — yet no buzz ⇒ **app-side DONE; silence is 100% macOS Terminal/
  signing**. Verify on APK (no identity gate there); macOS desktop fix = sign prod bundle (deferred).
  **FIX LANDED** (uncommitted, 2026-06-25, typecheck clean + 2733 tests green): (1) **Tauri diagnosable** —
  `deliver()` now AWAITs the notify IPC via `__TAURI_INTERNALS__.invoke("plugin:notification|notify")`
  (fallback `sendNotification`) so a capability/serialize failure surfaces (`console.warn`); opt-in debug seam
  `notifyDebug` (dev or `localStorage.chama_notify_debug=1`) logs platform/permission/IPC outcome; `notifySelfTest()`
  (opt-in `localStorage.chama_notify_selftest=1`, wired at `App.tsx` startup) fires one known-good notification
  through the real path so an on-device tester can prove the OS layer independent of any transition. `extra` kept
  (verified valid). **No signing chase** (deferred — prod-signing is the real macOS fix, needs Apple Dev ID).
  Cross-checked Linux (plain D-Bus, no identity gate) + Windows (WinRT toast, `app_id` only for installed builds) —
  same instrumentation applies. (2) **Bug-2 cold-start catch-up** — persistent per-trade last-seen store
  (`chama_notif_seen_status_v1`, bounded 500, no-churn) + pure `catchUpPrev` synthesizes a `prev` from last-seen
  status on a cold first-observation so a transition that advanced while the app was dead buzzes once; fresh
  installs (no record) stay silent; fired-tag dedup guards repeats. Recorded independent of the enable toggle.
  All in `notify-service.ts` (+7 unit tests). ⏳ Pending: Jetty's on-device verify (Tauri buzz with window open;
  APK foreground + killed-then-relaunch fires the missed moment once) + the deferred prod-signing decision.

**STILL OPEN / later:**
- F ~~Flash offramp~~ — DROPPED 2026-06-24 (KYC, region-locked, controls the flow — against ethos).
- #15 "pager cart-first landing" — unread badge briefed (4.1); the "cart-first" half = likely the **storefront
  menu eating too much vertical space in Details PRE-LOCK** (Jetty's recollection) → fold into the
  TradeView/default-pane work (compact the pre-lock menu pane). Needs a clean repro.
- **V7 + V6** payout-journal hardening (deferred leg; `design/mockups/chama-payout-journal-hardening-brief.md`).
- **Clean UI/UX pass** — Jetty: only AFTER the above.
- **Tutorial/walkthrough video** — Jetty recording 3-device snippets into a project folder for Claude to assemble.
- 16. [POST-NAIROBI] storefront/menu per-item quantity + persistence.

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
