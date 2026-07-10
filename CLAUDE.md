# CLAUDE.md — start-here memory for AI agents on Chama

**Read this first.** It's the durable context so a new chat doesn't restart from zero.
If something here is stale, fix it here. Maintainer: Jetty. Style: concise + direct;
leave changes **uncommitted** unless told (Jetty does the git split); confirm-first on
big/irreversible moves.

## What Chama is
Local-money / P2P Bitcoin marketplace: **Fedimint** (ecash), **Nostr** (identity, chat,
escrow coordination), **Lightning** (funding). Platforms: web (getchama.app /
chama.community), **Tauri** desktop, **Android APK** (Zapstore + GitHub). Version: see
`package.json` (**v4.2.1** "Going Global" shipped 2026-06-26). **NEXT: v5.0** — the ultra-major "finish the bond"
release (the bond IS the headline). **Phase: post-announcement** (the Nairobi conference is long past — drop that
framing). The app is announced + live, but arbiter recruitment isn't wired end-to-end yet, so users may be waiting or
unsure their country is supported. v5.0's job: finish the bond + the arbiter enrollment that makes any chama go live,
while hardening fund-safety. Benin/Cameroon francophone framing still applies.

## Doc set (read, don't duplicate)
`PHILOSOPHY.md` ethos · `DECISIONS.md` decision log · `BACKLOG.md` backlog ·
`INVARIANTS.md` must-holds · `BRAND.md` · `PRE-LAUNCH-QA-GATE.md` go/no-go ·
`native/fedimint-bridge/FRESH-JOIN-SMOKE.md` mobile smoke ·
`design/mockups/chama-fedimint-freshjoin-CC-brief.md` iroh brief + live status.
**4.1 / bond briefs (2026-06-24):** `chama-arbiter-bond-phase2-brief.md` (finish-the-bond, staged) ·
`chama-inapp-help-brief.md` (E) · `chama-4.1-newbie-polish-brief.md` (ratings-in-chat · TradeView
rect + default-pane · CBP picker · unread badge) · `chama-notifications-fix-brief.md`.
**4.2 briefs (2026-06-26):** `chama-onboarding-picker-tiers-brief.md` (two-green tiers + locale +
N-chama drill-down) · `chama-post-4.1-batch-brief.md` (A–E queue) · `chama-4.2.1-dashboard-nav-brief.md`
(Dashboard rename + arbiter-FAB hide + tour trim) · `chama-help-readability-brief.md`.

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

**⚠ Ship gotchas (every one hit in the 2026-06-26 "Going Global" ship — read before shipping):**
- **Keep the tree QUIET.** `release:all` runs the **web deploy FIRST** (`release.sh`: `scp dist/* →
  satoshimarket.app:~/chama-dist/`) then the **Android+Zapstore lane** (`android-release.sh`), both under
  `set -e`. A background build/watch (Tauri, vite, an editor) rewriting `dist/` mid-`scp` makes the upload a
  **partial set** ("No such file" on freshly-built chunks) → live web app breaks AND the lane **aborts before
  Android/Zapstore runs**. Don't rebuild / launch Tauri / open a git GUI until it prints `✅ Shipped vX.Y.Z`.
- **Stale `.git/index.lock`** (a concurrent git process — editor source-control, GUI) makes ship's `git add`
  fail *after* the bump. Recover: `rm -f .git/index.lock` → `git checkout -- package.json package-lock.json`
  (undo the half-bump) → re-run `npm run ship`.
- **A ship that aborted mid-lane → re-run `release:all`, NOT `ship`** (ship re-bumps + refuses on missing
  next-version notes). Export what ship.sh sets: `SIGN_WITH=browser CHAMA_RELEASE=1 CHAMA_ZSP_BIN=/private/tmp/zsp`
  (`CHAMA_RELEASE=1` ⇒ clean version chip, not the amber dev stamp). Split fallback: `release.sh --deploy-live`
  (web only) + `release:all --no-web` (Android/Zapstore only).
- **Tether / quiet network for the Zapstore APK upload** to `cdn.zapstore.dev` (~59 MB; stalls on a saturated
  link). `zsp`'s "Publish now" prompt needs an interactive Enter.

## DEV / TEST WORKFLOW
- **⚠⚠ NEVER edit `src/**` or run `npm test`/`npm run typecheck`/a vite preview WHILE Jetty's `dev-instance.sh`
  Tauri instances are LIVE (2026-07-08 — Jetty hit this hard, repeatedly).** WHY: `dev-instance.sh` runs
  `tauri dev` whose `beforeDevCommand` is vite; vite watches `src/**`, so ANY source edit fires **HMR across all
  3 running instances simultaneously** → each reloads mid-use → **Nostr relays disconnect, fed re-inits, state
  resets, session churns** ("nostr disconnected instantly, nothing works while I click around"). On top of that,
  `npm test` (full ~90s suite) + `tsc` + an extra vite preview pile CPU/RAM onto a machine ALSO running 3 Tauri
  instances + a local **Alby Hub Lightning node** + many browser windows → the whole box strains and Alby Hub
  transiently shows **฿0 / loses sync** (a node-sync artifact under load — NOT lost sats; nothing Claude does
  touches Alby, real sats, or moves money). **PROTOCOL:** (1) Jetty **Cmd+Q all dev instances before Claude does
  a coding/test pass**, OR (2) Claude batches ALL edits with NO `npm test`/preview, then Jetty relaunches to test.
  (3) Claude should **NOT auto-start vite preview servers** during a session where dev instances are live — they
  compete for ports (3000→3001→3002→3003, i.e. the instances' own ports) and add churn. Editing docs like
  CLAUDE.md is SAFE (not in vite's module graph → no HMR). `src-tauri/**` edits trigger a Rust RECOMPILE in
  every instance (even heavier) — same rule.
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

## TASK BOARD (reconciled 2026-06-26 — v4.2.1 SHIPPED to Zapstore; keep in sync)
**SHIPPED in v4.0.0 (live):** #9 funding fund-safety (gateway Part1/2 + double-pay Part3 + V8 journal
fail-closed) · #17 native fresh-join pkarr · relay resilience + chat-wipe · claim-credit reconcile ·
UI pass (unified vote/mark-done, refund-reason picker, calm refund bubbles, DM Sans, TradeDetail
one-block) · #10 fiat ramps offramp-only registry + **Tando LUD-16 M-Pesa** · release notes + Zapstore
publish · launch announcements (EN+FR) · newbie FAQ (EN+FR, 0.5% fee). Live-verified in Kenya (real
trade → M-Pesa in minutes). **Earlier:** storyboard demo · Obsidian vault · French Nairobi deck · QA gate.

**SHIPPED in v4.1.0 → v4.2.1 (LIVE on Zapstore + GitHub + web, 2026-06-26):**
- **"newbie-polish" (4.1.0):** ratings-in-chat + close-at-completion + green glow + centered CTA · TradeView
  fixed-rectangle + default-pane + "You owe KES X" checkout headline · #12 CBP bill-type picker · #15 unread
  badge · E in-app Help + HelpTip + help-readability pass · #19 pager hard-snap · notification firing fix.
- **"Going Global" (4.2.1):** two-tier country picker (⚡ Live now / ✓ Available now + device-locale featuring
  + N-chama drill-down) · welcome **coach tour** · **Strike USD** off-ramp (`strike-offramp.ts`; paste-path
  live, one-tap ClaimPayoutModal picker still deferred) · **#16** redirect-open-on-native helper (`open-url.ts`)
  · registry **native-verified** flip · **Dashboard nav:** bottom `Create` tab → **Dashboard** "coming soon"
  placeholder, **arbiter FAB hidden** (`SHOW_ARBITER_FAB=false`, BrowseView — one-line revive with 2A), coach
  tour trimmed 5→4 (Browse→Create→Dashboard→Me), "Back home **in** {x}" toast.
- ⚠ **v4.2.0 = phantom tag** (pushed, never published — the web `scp` race aborted the lane; **4.2.1 is the
  real public debut**). **Dead code:** legacy `view === "create"` branch in App.tsx is now unreachable
  (`TAB_FOR_VIEW.create → browse`) — harmless, delete in a later cleanup.
- ⏳ **STILL OWED: Jetty's authoritative device pass** (3-instance Tauri + APK) over this whole pile — TradeView
  lifecycle matrix, ratings-at-settle, unread badge, #16 redirect + #18 chat-focus on native, notification buzz.

**NEXT (the big track):** ~~Phase 2A (SSS-lock custody)~~ **DEAD** (the single-key commitment bond replaced it;
2-of-3 vestige deleted). Jetty reframed **2A = the real Dashboard** (built below). Remaining bond track: **2B**
(flip `BONDS_ENFORCED` + prefer-bonded, task #33) — later.

**DONE 2026-07-09 (v5 device-pass fixes + validation — uncommitted, typecheck CLEAN, suite 2932/2932 asserts green [0 fails]):**
Jetty's v5 device pass (3-instance Tauri + fresh browser npub). ⭐ **2B prefer-bonded + provenance DEVICE-VERIFIED:** a
4th bonded arbiter seated on a real trade, and the Parties panel now reads green **"Community-verified arbiters — every
name here is in Tanzania's known pool"** (replacing the live build's "⚠ UNRECOGNIZED ARBITER"). Capacity stays **STRICT**
(Jetty's call — bond must cover the trade; the 10k-sat floor already lets sub-floor trades seat any funded bond).
- **Bond ceremony — expired bond → RENEW (`BondCeremonyModal.tsx`):** an expired bond (`tip ≥ lockUntil`) no longer
  shows the announce section (announcing a dead bond was a no-op that lied "counts toward liveness" — an expired bond
  reads active=false). Now: ⏳ header "Your bond's term ended" (accent), duties hidden, a renew line ("reclaim + post a
  fresh bond"), the **Reclaim button glows** as primary ("Not now" secondary), and the reclaimed screen's primary CTA is
  **"Post a fresh bond"** (→ describe) — closing the reclaim→renew loop (no in-place extend: the CLTV is fixed, so renew
  = reclaim + re-lock). Auto-announce-on-lock also skips expired bonds (never publishes a dead signal).
- **Payment methods fold (`SavedHandlesPanel.tsx`):** phone-shaped rails (M-Pesa/Tigo Pesa/Airtel) were double-listed —
  as phone network-tags up top AND in the bottom method search. Fixed: bottom section excludes phone-shaped rails (same
  `phoneNetworksForCommunity` predicate that fills the top → can't overlap) and is now a **collapsed "Banks & apps"**
  accordion (default closed, Western-leaning, tap to expand).
- **⭐ Offramp country-scoping FIX (M-Pesa-in-Cameroon):** `isKenyaPayoutContext`/`isTanzaniaPayoutContext`
  (tando/chapsmart-offramp.ts) keyed off the claimant's HOME → a Kenyan/TZ home leaked M-Pesa onto ANY trade (aggravated
  by the stale-legacy-`chama_community` home artifact). Now the **TRADE context is authoritative**: trade community/
  currency decides; home is only a context-less fallback. Same fix in `getExternalSwapsForContext` (redirect resolver —
  home + currency only fall back when the trade has no community of its own, so Bitika/Kenya can't leak onto a Cameroon
  trade either). +3 regression test blocks (all green). ⚠ Tradeoff: a genuine cross-border user sees the trade's country
  offramp, not their home one (minor — sats payout + Lightning/onchain default; matches "offramps in their respective
  country"). **External links = ALREADY WIRED** (openExternalSwap → openExternalUrl → Tauri opener plugin + Cargo dep +
  npm dep + `opener:allow-open-url` capability all present, Help links too) — dead links ⇒ STALE Tauri build (opener is
  Rust, needs a recompile/relaunch) or a runtime opener failure (`[chama] tauri opener failed` warning). No code gap.
- **Briefs (design/mockups/):** `chama-own-fed-sovereignty-ladder-brief.md` (#51, the positive-pull to your own fed:
  guardians = your bonded arbiters, walkable turnkey spin-up, portable Nostr reputation) · `chama-ratings-farming-sybil-resistance-brief.md`
  (#52 — the load-bearing rule: **gate privileges on the BOND, ratings only modulate, never unlock on ratings alone**;
  directly constrains #49 store-permanence) · ChapSmart restrictions folded into `chama-chapsmart-fiat-funding-brief.md`
  (1k–100k TZS/tx, 10/day, phone-bound; ⚠ the device-fingerprint × single-VPS-proxy collision — ChapSmart must key the
  2-accounts/device/day on the CLIENT visitorId Chama sends, else the whole userbase caps at 2/day).
- **Validation:** `tsc --noEmit` exit 0. Suite ran 2932 asserts green / 0 fails in-sandbox incl. ALL touched sections
  (offramp scoping 2975/3039/3070, 2B block 2059+); sandbox reaps at the pre-existing `loadEscrow` relay-timeout section
  (~150 asserts short) → the last leg is Jetty's `npm run predeploy` on Mac (no reaper). UI-only changes (bond-expiry,
  payment fold, create-form) aren't in the test graph but typecheck clean. **⭐ MAINNET FLIP DONE 2026-07-09 (v5.0 real-money — uncommitted, typecheck clean, +15 asserts green, 0 fails):**
`BOND_NETWORK` SIGNET→**MAINNET** (single alias in useEscrow → bc1 addresses, mempool.space Esplora, BIP86 coin 0,
mainnet verify — all cascade from the one import) · **`SHOW_BOND_CEREMONY = true`** (ceremony LIVE for ALL users —
Jetty's call: anyone posts a real mainnet bond) · **1-conf mainnet funding** (`defaultMinConfs` 6→1, Jetty's call) ·
block-time recomputed for ~10-min blocks: term presets **1d-min / 1wk / 1mo / 3mo**, `humanTime` ×0.5→×10,
`BOND_LIVENESS_BLOCKS_PER_DAY` 2880→**144**, `MIN_COMMITMENT_TERM_BLOCKS` 30→**144** · **dynamic reclaim fee**
(`esploraRecommendedFeeRate` — live mempool `/v1/fees/recommended` ~1h tier, floored at 2 sat/vB, capped 100, fail-safe
to floor so it NEVER blocks a reclaim; wired into the reclaim action). **New guard tests** (+15): MAINNET-config block
(bc1 addr / coin 0 / mempool.space / 1-conf / 144-min, distinct from signet) + reclaim-fee dynamic block. `new MAINNET`
export in multisig.ts. Reclaim fee ceremony-preview + `SEED_AMOUNT_SATS` (21k default) left as-is. ⏳ Jetty: re-run
`npm run predeploy` (expect **3104/0**) → `npm run ship -- --major`. Notes updated to 3,104.

**DONE 2026-07-07 (2A = the real Dashboard — uncommitted, typecheck clean, 2823 asserts green):** replaced the v4.2.1
"coming soon" Dashboard placeholder with **`src/ui/screens/DashboardScreen.tsx`** — the home the bond + ratings have
waited for, composed from data the app already has (read-only, no new money path). Four sections: (1) **STANDING** —
the hero: the user's trade-verified public rating (positive %, 👍/👎, count) or a "build your standing" invite for
newcomers; (2) **YOUR BOND** (dev-gated behind `SHOW_BOND_CEREMONY`) — active commitment bonds (amount + 🔒 LOCKED /
awaiting-funding) with a Manage/Post CTA → the ceremony; the "become a bonded arbiter" home; (3) **CHAMA LIVENESS** —
the `LivenessSignal` for the user's community (auto-refreshed via `useLiveness`, 90s poll); (4) **STATS** — trade tiles
(total / completed / live) + an "arbitrated N trades" line. Wired at App's `view === "dashboard"` (passes ratings,
myTrades, browseCommunity, `actions.getChamaLiveness`, `onOpenBondCeremony`). The Dashboard bottom-tab is now real, not
a placeholder. ⏳ Jetty device-verifies (3-instance/APK): the tab renders standing/bond/liveness/stats; the bond card
shows his 2 funded bonds; STANDING shows a %; Post-a-bond opens the ceremony.

**DONE 2026-07-07 (#36 landing page — Lending dropped, Work/Chip In/Stack added, uncommitted):** `landing/index.html`
product grid reframed "Four products" → **"Six flows"** across all 3 locales (EN/FR/ES): the 3 LIVE cards
(Bill Pay/P2P/Stores) kept, the **Lending card removed**, and **Work · Chip In · Stack** added as honest **"Soon"**
cards — new `.soon` badge + `.ph-soon` accent-glow placeholder thumb (glyph only, no broken `<img>`) + muted
"Coming soon" CTA, cool-tone accents (blue/teal/teal-m) that read distinct from the warm live trio. Full FR
(Travail/Cagnotte/Épargne) + ES (Trabajo/Aporta/Ahorro) parity (name/tag/desc + `soon`/`soon.cta` keys). Kept the
"same 2-of-3 escrow" sub-line (still accurate for the TRADE escrow). `p-lend-v2.jpg` now unreferenced (left on disk
for the git split); FAQ pages carry no product-count/Lending refs (the "tontine" hit is the chama etymology). ⏳ Jetty
owns the 3 photoreal thumbs (560×380, same Midjourney lens: warm amber+purple night scene, neon-contour object +
phone showing the amber ₿ lock) — placeholders + paste-ready `<img>` comments are in place; MJ prompts delivered in
chat. Flip Soon→Live per vertical when each ships. (No image generator wired in this env — the raster/neon skills
assume a model that isn't connected here, so photoreal art stays Jetty's MJ pipeline.)

**DONE 2026-07-08 (device-pass batch — items 2/3/4 from Jetty's browser pass, uncommitted, typecheck clean):**
- **Item 4 — buyer's FIAT confirm (`TradeDetail.tsx`):** the fiat payer's (BUYER in p2p-trade + bill-pay) armed RELEASE
  confirm now reads **"Tap again — confirm you sent {checkoutFiatLabel}"** (real fiat — premium folded for p2p, base
  for CBP) instead of echoing the seller's release-the-sats copy; falls back to the sats copy when no fiat. Gated by
  `fiatPayerSending = voteRole === fiatPayerRole && !!checkoutFiatLabel` (both already computed in the component). Seller
  copy unchanged. Applies to `releaseConfirm` (aria) + `releaseArmedAction` (visible).
- **Item 3 — sim banner clipped the header (FIXED + browser-verified via Chrome MCP):** root-caused in the LIVE DOM —
  the app shell's inline `paddingTop: shellPaddingTop` (an `env()` calc) was being **dropped by React's style
  reconciliation** on the frequently-re-rendering main shell (React props carried the calc; the DOM node never received
  padding-top; the "Chama" header rendered at `top:0` under the 26px fixed pill; setting `padding-top:30px` by hand stuck
  → nothing was clearing it, React just never wrote it). Fix = stop relying on the flaky inline padding: **`SimModePill`
  now renders an in-flow spacer** (`height:SIM_PILL_HEIGHT`, aria-hidden) that reserves the pill's height reliably;
  `shellPaddingTop` drops the sim-30 (safe-area only now); the TradeDetail height calc (`App.tsx`) subtracts
  `SIM_PILL_HEIGHT` when `simOn` to stay consistent. **Verified in-browser:** header now at `top:30`, 4px clear of the
  26px banner (was `top:0`). One spacer covers connect/gate/main shells uniformly.
- **Item 2 — persistent Recover banner = stranded CLAIM/PAYOUT, NOT #37 (brief handed to CC):** deep-traced (subagent,
  file:line) → **`design/mockups/chama-stranded-payout-recovery-brief.md`**. In Exchange the BUYER never locks (seller
  locks; buyer pays fiat + CLAIMS), so a buyer-side stranded balance is a claim residue by construction — the seller
  shows DONE because settlement completed; only the buyer's outbound-LN payout leg stalled, leaving claimed ecash in the
  wallet. `committedMsats` excludes CLAIMED/COMPLETED (`decisions.ts:641`) → banner fires; #37's stash is lock-only
  (`escrow-bridge.ts:433/450/468`) → can't suppress it (my earlier "fresh build ⇒ #37 gap" framing was wrong — corrected).
  **Recover is SAFE on this balance** (own claimed ecash, both sides settled, no live escrow). Real fix = claim-side
  reconcile (payout-journal V6/V7 + the claim-credit-reconcile brief) + fix the mis-attribution (shows a ₿1,570 trade
  while sweeping ₿2,462 = full wallet balance vs single most-recent CLAIM). **Jetty routes this to CC.**
- **#39 sim cross-trade lock** — Jetty confirmed no longer reproduces; closed.

**DONE 2026-07-08 (#33 / 2B prefer-bonded arbiter — STAGED pass, uncommitted, typecheck clean, +20 asserts green):**
prefer a FUNDED bonded arbiter for the seat, consensus-SAFELY. Brief: `design/mockups/chama-prefer-bonded-2b-brief.md`.
Jetty chose STAGED (prefer-bonded now; flip `BONDS_ENFORCED` capacity in a later pass). The trap: the seat is
reducer-ENFORCED at JOIN (`state-machine.ts:527`) via the deterministic `pickArbiterFromPool`, so changing the pick
would fork the chain across mixed-version clients (JOIN accepted by some, `ARBITER_NOT_ASSIGNED` by others). Solution
= the accept-any-of-N doctrine `pool.ts` already uses for C1, anchored to a value **stamped into CREATE**:
- `CreatePayload.bondedArbiters` + `EscrowState.bondedArbiters` (types.ts, optional, read `?? []`); CreateForm stamps
  the funded bonded subset (∩ pool) at publish; round-trips via wholesale JSON CREATE content + `...params` spread
  (App.handleCreate → useEscrow.createEscrow → escrow-client); reducer sets it, cloneState copies it.
- **`pickPreferredArbiter`** (pool.ts): bonded∩pool pick, else legacy `pickArbiterFromPool`. Pure/replay-identical.
- **JOIN gate widened** (state-machine.ts): accepts EITHER the bonded-preferred OR the legacy pick — never rejects a
  valid arbiter ⇒ no fork/strand. Empty bonded ⇒ picks coincide ⇒ byte-identical to pre-2B. Front-run still blocked.
- **C1** adds bonded-preferred as a 4th accepted basis; **previews + lock-builder** prefer bonded.
- ⚠ **ONE line is in CC's `escrow-bridge.ts`** (~200, lock-builder pick → `pickPreferredArbiter`) — orthogonal to
  #37's spend/publish/stash; FLAG for the git split so CC's #37 and this reconcile.
- Adversarial: tests.ts block **31d-3b** (+20) — units, accept-both, DETERMINISTIC divergent case (bonded≠legacy ⇒
  both JOINs accepted ⇒ no fork), front-run blocked, backward-compat, C1. All green; tsc clean. ⏳ Jetty device-verify
  (3-instance): bonded arbiter preferred as the seat; excluded/absent ⇒ OG fallback (never strands); reads green.
- **NEXT (2B part 2):** flip `BONDS_ENFORCED` — capacity-filter communityArbiters at the CREATE stamp, keep the
  never-empty OG fallback. Separate gated pass. Then release.

**DONE 2026-07-08 (CBP create-form pass + refund-reason fix — uncommitted, typecheck clean):**
- **CBP create-form:** the free-text description field is REMOVED for single bills (`descriptionRequired` false for
  bill-pay non-menu — mirrors Exchange; no-KYC private bill pay, nothing to leak). The **bill-type is now the listing
  identity**: `buildListingDescription` falls back to the bill-type label ("Airtime & data") or "Bill payment" — which
  ALSO fixes the publish gate (step-3 `ready` requires `listingDescription.length > 0`; hiding the desc had blanked it →
  couldn't publish). TradeCard drops the redundant bill-type chip when it just echoes the title (the card already
  renders it as a nice icon+label pill). Premium copy humanized: label **"SERVICE PREMIUM" → "VOLUNTEER BONUS"**,
  checkout line → "You lock ₿1,283 — a volunteer pays your MXN 10 bill and keeps the sats (its value + 40% bonus)",
  hint reworded.
- **Refund reason = INITIATOR-only (`TradeDetail`):** the reason picker now shows only when you INITIATE a refund (or a
  genuine dispute — counterparty voted RELEASE). When your counterparty has ALREADY voted refund, you get the plain
  double-tap "refund X to you" confirm — NO redundant "why?" (it asked the wrong person; the funder just wants their
  sats back). One-line gate: `counterpartyAlreadyRefunded = state.votes[otherPrincipal] === REFUND` → empty reasonList →
  `refundPickerOpen` closes → falls through to the double-tap confirm. Vertical-independent (Exchange/Marketplace too).
- ⏳ Section-popout across verticals DEFERRED (task #50 — careful pass; some sections have nested bordered sub-boxes,
  two render paths, a 2-col amount row → don't blanket-wrap).
- **Create-form polish batch 2 (2026-07-08, uncommitted, typecheck clean):** (a) CBP leads with **fiat** —
  `fiatPrimary` forced for bill-pay (a bill IS a fiat amount), shows "PRICE" (fiat) then "SATS", regardless of the
  global sats/fiat toggle (default = sats). (b) **"AMOUNT (SATS)" → "PRICE"** everywhere (secondary field reads "SATS"
  in the fiat-first layout so there's never a double "PRICE"); dropped the redundant `{cur}` from the fiat label
  (currency already on the input chip). (c) **"Physical" → "Shipping"** on both fulfillment selects (value stays
  `physical`). (d) **CBP bill-type is now MANDATORY** (`billTypeOk` in both step-2 + step-3 `ready`; label "· pick one")
  — closes the "publish a bare Bill-payment with no type" hole. (e) **Menu "+ add" follows the list down** — a
  full-width dashed add button below the last item (Exchange options + Market items), so building a store doesn't force
  a scroll back to the header "+". Marketplace type-chips NOT added (open-ended vertical; better served by a
  fulfillment-aware placeholder — offered, not yet built).

**DONE 2026-07-08 (stranded claim/payout recovery — the buyer-side RecoveryBanner strand, uncommitted, typecheck
clean, FULL suite 2983/2983 green [+29 asserts, new block 31e2]):** built from
`design/mockups/chama-stranded-payout-recovery-brief.md`; Jetty Go'd all 3 recon recommendations (client-only scope ·
card opens the trade · card-only-when-consistent attribution). **Recon finding — half the brief's recommended fix
already existed:** the payout journal persists `operationId` durably; `reattachPayout` (R3-1b) already resolves
`submitted` records without re-paying (fired post-claim + on trade open); TradeDetail is already honest on CLAIMED
(RETRY CLAIM / payout-confirming); claim-credit-reconcile shipped v4.0.0. The REAL gaps were: home surfaces
claim-blind, no boot sweep, mis-attribution. Built:
- **`summarizePendingPayoutsForUi`** (decisions.ts, pure) — the claim-side analog of #37's native-lock summary. A
  CLAIMED-not-COMPLETED trade the user won (CLAIM event signed by them) explains the balance: `finish` (no journal
  record — payout never sent / definitively failed; balance-gated `balance ≥ amount`) or `confirming` (`submitted`
  record; no balance gate). Settled records + COMPLETED trades + other-fed trades (CREATE payload `fed` vs current)
  skip; suppression BOUNDED by `PENDING_PAYOUT_SUPPRESS_MAX_MS` (7d, mirrors #37) — after that the banner returns,
  which is SAFE escalation here (settled claim residue, the drain just completes the payout — opposite of the #37
  harmful case). Suppressor threaded through `shouldShowRecoveryBanner` + `decideChamaBarLabel` (new optional
  `hasPendingClaimPayout`) + MeScreen recover card + `hasTraceableIdleBalance` (stops persisting the wrong
  inferred-from-claim-history sats-trace). Sim/testnet render nothing (mirror #37 F4).
- **`PendingPayoutCard`** (mirror of PendingLockCard, calm, above Browse/Create): "⚡ Finish your payout" → opens the
  trade (TradeDetail's RETRY CLAIM is the double-pay-guarded money path — zero new money wiring) / "⏳ Payout
  confirming" (reattach owns it; never invites a re-pay).
- **Boot sweep (closes V6 for surviving records):** once-per-session App effect — every CLAIMED trade the user won
  that holds a journal record → background `reattachPayout` (structurally re-pay-free: settled ⇒ COMPLETE publishes
  both sides; refunded ⇒ record cleared ⇒ RETRY CLAIM goes live) so stuck payout-confirming resolves WITHOUT
  re-opening the trade. V6's "operationId lost across restart" premise was stale — the journal persists it. ⚠ **V7
  residue is the ONLY remaining double-pay window** (crash in the gap between bridge-commit and journal write ⇒ NO
  record): needs the Rust op↔escrow reconcile (`/pay` escrowId + lookup endpoint) — stays its own scheduled
  adversarial leg per `chama-payout-journal-hardening-brief.md`; a client-only intent record was deliberately
  rejected (unknown⇒refuse would strand retries with no resolver; unknown⇒allow prevents nothing).
- **Attribution honesty:** `strandedSourceExplainsBalance` (balance ≤ amount×1.02 + 50k-msats dust) — when the sweep
  exceeds the named claim (the ₿1,570-card-on-₿2,462-sweep case) the banner drops the trade card and headlines
  "You have leftover sats from earlier trades" (`genericResidue`). One-sided by design: balance SMALLER than the
  claim is still honestly "from this trade".
- Boot-verified in browser (typecheck + full suite + clean boot, no console errors). ⏳ **Jetty device-verifies (the
  :3002 buyer repro):** amber banner REPLACED by the calm "Finish your payout" card naming the right trade → tap →
  RETRY CLAIM completes the payout → any leftover residue then surfaces as an honest generic-residue banner (no
  trade card); ChamaBar shows no stranded pill while the card is up; a `submitted` journal record auto-resolves on
  relaunch without opening the trade.

**DONE 2026-07-08 (Recover false-green no-op loop — stale journal key, uncommitted, typecheck clean, 2990/2990 green
[+7 asserts]):** Jetty's :3002 device pass hit Recover → green "Recovered to your wallet" → banner returns, forever.
**Root cause (traced, NOT introduced by the stranded-payout leg — pre-existing R3-1 interaction):** the recovery
drain's double-pay journal key is INHERITED from the most-recent-CLAIM / sats-trace inference
(`recoveryTraceContext`, App.tsx) — in Jetty's state that named the OLD ₿1,570 exchange trade whose payout REALLY
settled 2 days ago (+₿1,559 in his Alby history; settled records persist forever by design). `runRecoveryPayout`'s
top guard (`balance-recovery.ts`) saw `settled` ⇒ returned `done` WITHOUT SENDING ⇒ false green, balance untouched,
banner back. Fixed both ends:
- **Call-site key gate (App.tsx):** `recoveryTraceContext.escrowId` only carries a key when the candidate's amount
  passes `strandedSourceExplainsBalance` against the live balance (same rule as the banner card). Unexplained residue
  ⇒ KEYLESS drain — the module's own doctrine ("a drained balance is its own guard"). Also stops stamping the stale
  escrow id into the `/pay` operation meta.
- **Orchestrator belt-and-braces (balance-recovery.ts):** a `settled` record (direct or via reattach-settled) while
  `getBalance` still shows ≥ `MATERIAL_RECOVERY_MIN_SATS` is a stale key BY CONSTRUCTION (that payout's sats left the
  wallet) ⇒ warn + drop to keyless and actually pay; sub-material or unreadable balance keeps the fund-safe
  short-circuit (genuine retry-after-success race unchanged). The post-success `recovery-leftover` sats-trace records
  `guardKey` (not the raw context) so a stale key is never re-persisted.
- **Origin story decoded from Jetty's Alby history (corrects the verifier brief's "claim residue" framing):** the
  stranded ₿2,462 is FUNDING residue — 4× "Sent −₿2,462 · Pay for Item" = four marketplace funding attempts on
  07-06 (pre-#37, no crash-stash), one of which locked (seller's DONE is real); one mint never locked = today's
  balance. The +₿1,559 "Chama claim payout" = the separate ₿1,570 exchange trade completing — the settled record the
  drain then tripped on. ⚠ **OPEN FORENSICS (Jetty):** open the 4 Alby sends — if all 4 settled with preimage,
  ~4,900 sats are unaccounted (its own investigation); if 2 failed, books close. ⏳ Device verify: Recover now
  actually sends ₿2,447 to the destination (Alby shows the receive), balance → dust, banner gone. NOT V7: V7 stays
  the crash-mid-claim-pay bridge-reconcile leg; unrelated to this loop.
  ✅ **Recover loop DEVICE-VERIFIED by Jetty same day:** Alby shows "+₿2,447 Chama payout · a few seconds ago",
  Chama balance → dust, ChamaBar "Chama: ready", banner gone.

**DONE 2026-07-08 (V7 payout-journal hardening — pre-send intent + reconcile-by-escrow, uncommitted, typecheck clean,
cargo check + sidecar release build clean, FULL suite 3057/3057 green [+67 asserts, new block 40c]):** the LAST
double-pay window closed, per `chama-payout-journal-hardening-brief.md` (V6 closed as a side effect). Jetty Go'd the
leg; defaults taken: full-meta stamping · claim-path-only scope (recovery drains stay keyless/self-guarding).
- **⭐ ARCHITECTURE FINDING (recon):** NO new bridge storage — fedimint's own client DB is the durable op↔escrow map.
  `pay_bolt11_invoice(gateway, invoice, extra_meta)` persists arbitrary JSON in the operation log forever, and the
  browser SDK was ALREADY stamping our ChamaOperationMeta (`chama_escrow_id`) there; only native threw it away (`()`).
- **Bridge (main.rs, api_version 2→3 + `pay_outcome_by_escrow` capability in /health):** `/pay` gains `extraMeta`
  passthrough → stamped into the op log. New **`/pay-outcome-by-escrow`** `{escrowId, sinceMs}`: scans
  `operation_log().paginate_operations_rev` newest-first (LN + variant Pay + `extra_meta.chama_escrow_id` match),
  bounded by TIME not count — reaching ops older than `sinceMs` (journal record createdAt − 1h skew margin) proves a
  "none" verdict complete; cap-hit-without-since ⇒ "unknown" (never a false none ⇒ never a licensed re-pay).
  Aggregation fund-safest: any settled ⇒ settled · else any non-terminal ⇒ inflight (opId carried) · else refunded.
  Outcome classification reuses `watch_outgoing_pay` (UnexpectedError stays ambiguous ⇒ inflight).
- **Journal:** new `"intent"` status + `recordPayoutIntent` (upgrade-only — a retry's pre-send write NEVER downgrades
  submitted/settled). Written in `runClaimAndPayout` AFTER the V8 writability probe, BEFORE `payInvoice`; success ⇒
  settled, LN_PAY_INFLIGHT ⇒ submitted, definite failure ⇒ cleared. Reader audit: TradeDetail `payoutConfirming`
  excludes intent (RETRY CLAIM stays live); `summarizePendingPayoutsForUi` treats intent like no-record (balance-gated
  "finish" card); `runRecoveryPayout` drops an intent-keyed drain to keyless (never touches the claim flow's record).
- **Top guard learns two cases** (claim-and-payout.ts `reconcileByEscrow`): `intent`, and `submitted`-WITHOUT-
  operationId (the V6 residue) — settled ⇒ COMPLETE + done (no re-pay) · inflight ⇒ adopt found opId as submitted +
  payout-confirming · refunded ⇒ clear + pay fresh · unknown ⇒ refuse-for-now (record kept; boot sweep + trade-open
  reattach RETRY the reconcile — refusal with a resolver, never a dead end). ⚠ **FUND-SAFETY ASYMMETRY (load-bearing):**
  "none" clears + pays fresh ONLY for `intent` (new records ⇒ their payments always meta-stamped ⇒ absence provable);
  for `submitted` the gateway accepted a payment, so an empty scan is pre-upgrade blindness ⇒ stays unknown⇒refuse.
- **Lanes:** native adapter forwards `extraMeta` on `/pay` (old bridge binaries ignore it) + `payOutcomeByEscrow`
  (transport error / old-bridge 404 ⇒ unknown); browser lane implements the same scan via
  `listTransactions`+`getOperation`+`getPayOperationOutcome` (sub-limit page ⇒ scan-complete; any unreadable op ⇒
  scan-blind ⇒ unknown); `fedimint-client.payOutcomeByEscrow` (absent adapter ⇒ unknown) + escrow-bridge passthrough;
  sim ⇒ `none` at the useEscrow binding (sim pay auto-settles; keeps sim retries unstranded). `reattachPayoutAction`
  extended for intent/opId-less records — the existing boot sweep now resolves V7 leftovers hands-free.
- Tests: block 40c (V7 load-bearing unit: intent PERSISTED before payInvoice dispatches; all reconcile verdicts; the
  none-asymmetry; no-dep fund-safe refuse; real-journal upgrade semantics) + recovery intent-keyless + summarize
  intent-as-finish. Browser boot clean. **Sidecar binary BUILT** (`src-tauri/binaries/…-aarch64-apple-darwin`) — next
  Tauri relaunch picks it up; ⏳ Android bridge rebuild (`scripts/build-android-fedimint-bridge.sh`) = Jetty's device
  pass. ⏳ **Jetty device-verifies:** relaunch → `curl -s 127.0.0.1:18001/health | jq .api_version` = **3**; a claim
  payout on the new bridge → journal record carries intent→settled; the brief's kill-test (kill between bridge-commit
  and journal write → relaunch → RETRY CLAIM reconciles by escrow → **exactly one payment** in Alby). NOTE: reconcile
  only covers payments made AFTER this ships (older native ops carry no stamp — the submitted-asymmetry handles them).
- ✅ **DEV-BRIDGE STALENESS GOTCHA (found during V7 device test):** `dev-instance.sh` spawns the bridge from
  `src-tauri/target/debug/chama-fedimint-bridge`, but `npm run tauri:sidecar` only builds the RELEASE binary to
  `src-tauri/binaries/` — two different files. Tauri copies binaries/→target/debug ONLY when it rebuilds the app, and
  dev-instance.sh overrides `beforeDevCommand` to skip the sidecar step, so a bridge edit + `tauri:sidecar` left the
  dev instances on the STALE debug copy (rebuild, relaunch, `/health` STILL reports the old api_version — Jetty hit
  exactly this: got `2`, not `3`). FIXED: `build-tauri-fedimint-bridge.sh` now ALSO refreshes
  `target/debug/chama-fedimint-bridge` when it exists, so `npm run tauri:sidecar` is the single "get my bridge changes
  live" command for BOTH dev + packaged (Cmd+Q + relaunch to pick up). Manually copied v3 into the dev path this
  session too. So: after ANY bridge edit → `npm run tauri:sidecar` → Cmd+Q + relaunch → `/health` api_version=3.

**DONE 2026-07-08 (re-absorb story-loss fix — funding→lock-failed banner amnesia, uncommitted, typecheck clean, FULL
suite 3066/3066 green [+9 asserts]):** Jetty's 2nd ₿2,000 repro (fund → publish fails on relay flap → trade EXPIRES →
reload → boot drain re-absorbs the notes to wallet + CLEARS the stash entry → story lost → scary generic banner on an
"unexplained" balance). Both Go'd defaults (full calm reframe · offer Finish-locking). Built:
- **Reabsorb keeps the breadcrumb (`pending-native-locks.ts`):** on a successful re-absorb, `reabsorb()` now (1) ALWAYS
  records a `lock-reabsorbed` funding sats-trace (new optional dep `recordReabsorbedResidue`, bound to `recordSatsTrace`
  in escrow-bridge; merges with fund-and-lock's existing `lock-failed-after-funding` trace), and (2) if the trade is
  still lockable (`tradeStillLockable`: status===CREATED && not past `expiresAt`) DOWNGRADES the entry to a FRESH intent
  (drops oobNotes, resets attempts/createdAt) via `downgradeReabsorbedToIntent` so the calm "Finish locking your trade"
  card persists (re-lock spends fresh from the restored balance) — else clears (terminal/expired ⇒ nothing to re-lock).
  Identity-guarded (never clobbers a successor attempt). `state` now threaded into `reabsorb`.
- **Suppression tightened (App.tsx):** `hasPendingNativeLock = nativeLockResume !== null` (was raw
  `summarizeNativeLocksForUi.suppressRecovery`). Closes the gap where a downgraded-intent trade that LATER expires kept
  the banner suppressed (safe balance invisible for up to the 48h intent TTL). summarize couples suppress↔resume, so
  this only ever RELEASES suppression the display filter already dropped — strictly more honest, also fixes a latent
  #37 case (a spent entry on an expired trade now surfaces recovery instead of hiding it).
- **Honest calm banner (`RecoveryBanner` + App):** new `fundsReturned` mode — swaps the pulsing amber "⚠ TRADE NEEDS
  ATTENTION" for a calm accent "↩ Funds returned / Your funding came back to your wallet — safe and yours. Send … or
  just leave them here." Keeps the Recover CTA. No red pulse, soft surface.
- **⭐ ATTRIBUTION PRIORITY FIX (Jetty's 3rd-screenshot finding, same day):** a FUNDING trace now WINS over
  `identifyStrandedEcashSource` (the claim-history WALK). Jetty saw the banner name trade `sm_mqu6l7bv` "role Buyer
  ₿6,463" for a ₿2,000 FUNDING residue — the claim walk mis-attributed the funding balance to an unrelated old claim,
  and it FLIPPED to generic-residue after a few seconds (glitchy) as a more-recent-but-smaller claim loaded async and
  broke `strandedSourceExplainsBalance`. Fix (App.tsx): scan `listOpenSatsTraces()` for a `funding` trace whose amount
  explains the balance (persisted + SYNC ⇒ stable from first render, no flip) → `fundingReturned` takes PRECEDENCE;
  `strandedSource`/`strandedGenericResidue` now gate on `!fundingReturned`. The banner shows a **FUNDED TRADE** card
  built from the funding trace's OWN escrowId (the actually-funded trade, `fundingTrade` prop) — Jetty preferred the
  card ("the tradeid explains more") but the old one named the WRONG trade; this names the right one, no role line
  (funds-returned framing is just "you funded this, it came back"). Direct record beats heuristic walk.
- **⭐ FULL ALBY-LEDGER FORENSICS (Jetty's "I lost sats" — reconciled 2026-07-08, MAINNET real sats):** exported 1764-txn
  Alby CSV. The wallet is Jetty's PERSONAL LN wallet (years of gift cards/VPNs/swaps/zaps/channel liquidity) — top-line
  net -733k is his whole LN life, NOT Chama. Isolated Chama round-trip descriptions (Fund Escrow/Lock Sats/Pay for Item
  OUT vs Chama payout/Chama claim payout IN): **212,678 out / 149,652 in / 121 fundings, total LN fees just 308 sats
  (~2.5 sat/funding)**. The -63k gap = sats correctly paid to COUNTERPARTIES in completed DONE trades (Jetty sold sats,
  got fiat) — NOT loss. The "-2000→+1987" is the fee RESERVE held back (lands as recoverable fed-wallet dust), not a
  fee. Fed wallets currently EMPTY (verified via /info: Orange Club 1 sat, LatNet 0, Harlem 0) — nothing trapped.
  **TWO real anomalies found:** (1) **4× identical -2462 "Pay for Item" within 2 SECONDS (07-07)** = one trade whose
  funding QUAD-FIRED (Jetty confirmed: same trade, not 4) → ~2 excess fundings (~5k sats) stranded, only +2447 clearly
  recovered — the pre-#37 multi-funding hole; ~5k is the genuinely-unreconciled chunk. (2) **196-sat double-payout 78s
  apart (2026-06-02)** = textbook pre-guard double-pay (retry just after the old 60s watch window), from BEFORE the
  v3.5.1 journal guard; tiny + incoming (Jetty gained), guard since prevents it. Preimage 06640e…→hash d43d51… verified
  genuine. ⚠ Jetty CAN'T audit the 2462s in-app: a funding that never LOCKED leaves NO discoverable trade record (npub
  only tied to an escrow at LOCK) — that's why they don't appear in My Trades. Post-#37 this is closed (never-locked
  funding now leaves the pending-native-lock intent + funding trace + the calm "funds returned" banner, recoverable);
  the 2462s predate it.
- **UI (Jetty's ask): created date+time now on every TradeCard** (`TradeTimeLine`, under the ID line — Me history +
  Browse). NOTE on "show older trades": the Me list already renders ALL loaded trades (filterMeTrades doesn't cap;
  boot loads saved pointers slice(0,50); MAX_SAVED_ESCROW_IDS=50) — seeing only 3 = only 3 are LOADABLE, not a display
  cap, so a load-more toggle is a no-op. Older real trades don't show when their events aged off the queried relays /
  local cache; never-locked fundings have no record at all.

**DONE 2026-07-08 (loss-proof trade history — durable local trade index, Jetty Go'd "local index" scope, uncommitted,
typecheck clean, FULL suite 3075/3075 green [+9 asserts]):** the root of "I only see 3": My Trades is rebuilt every
session from relay discovery + `loadEscrow` chain-replay, so a trade whose full chain can't be re-fetched (public-relay
eviction · events predating the community relay ~07-01 · a funding that never LOCKED = no chain at all) silently drops
off the list. Chama never durably remembered "I did this trade" on-device. Built **`src/escrow-engine/trade-index.ts`**
(`chama_trade_index_v1`, user-scoped): a compact per-trade record `{id, category, amountMsats, community, role,
counterparty, description, lastStatus, createdAt, updatedAt}` written from the central `updateEscrow` chokepoint
(recordTradeToIndex — no-op for non-parties; never blocks the state update; recorded BEFORE the expired-unfunded hide
so expired listings still show). `statusRank` never regresses lastStatus on a stale partial replay; original createdAt
preserved; cap 500 evict-oldest. `forgetEscrow` drops it (`removeTradeFromIndex`). **UI:** the Me "All" view renders
`archivedTradeEntries(escrows.keys())` (index-minus-loaded) as compact **"Earlier trades"** rows (date · category ·
status · id · amount) below the live list; tapping reuses `onOpenTrade`→`openEscrow` which already background-loads by
id → rehydrates the full chain from the community relay when available. Loss-proof going FORWARD (device-local); can't
resurrect trades already gone everywhere (the pre-#37 2462s). Tests: new "DURABLE TRADE INDEX" block (parties-only,
no status-regress, createdAt-preserved, terminal-from-early, archived=index-minus-loaded, forget-drops, eviction).
⏳ **Jetty device-verify:** do a trade → reload → it stays in Me history (with date) even if the chain doesn't
rehydrate; tapping an "Earlier trades" row attempts a reload from relay.chama.community. NOTE: cross-device history
still rides the community relay (the index is per-device); a durable-event-cache (full offline chain rebuild) was the
heavier option Jetty deferred.
- **Follow-up fixes (Jetty's device pass on the index):** (1) **tap-to-Browse BUG fixed** — tapping an archived row
  whose chain can't rehydrate used to dump the user on Browse (openEscrow sets view=detail + background-loads; a null
  load → `selected` stays null → the `view==="detail" && selected` render falls through to Browse). New
  `openArchivedTrade` (App) AWAITS `loadEscrow` and only navigates on a non-null result — else stays put + toasts "its
  full history isn't on the relay anymore; summary is remembered on your device." Threaded App→MeScreen→MeTradeHistory→
  ArchivedTradeRow as `onOpenArchivedTrade`. (2) **date/time made PROMINENT** (Jetty: "most-regarded field besides
  price") — `TradeTimeLine` 9px-whisper → 12px bold `T.text` + added year; archived row date on its own 12px-bold line.
  (3) The buyer instance showing NO "Earlier trades" = EXPECTED: the index is per-device and only lists indexed trades
  NOT currently loaded — the buyer's trades are all live-loaded, the seller had 2 expired-CBP listings recorded then
  hidden. ⭐ **ROOT of the tap bug = the escrow event cache (`escrow-client.rawEvents`) is IN-MEMORY only** — nothing
  persists escrow events across reload, so an archived chain returns null. **That is exactly what the deferred durable
  event cache (persist rawEvents to OPFS/IndexedDB + eviction) would fix — it'd make tapping an archived trade actually
  REBUILD the full detail offline. Recommended as the next build; Jetty leaning yes.**

**DONE 2026-07-08 (durable escrow-event cache — IndexedDB, Jetty Go'd it, uncommitted, typecheck clean, FULL suite
3083/3083 green [+8 asserts], IndexedDB backend live-verified in browser):** the completion of the trade-index —
list-durable → trade-durable. Built **`src/escrow-engine/escrow-event-cache.ts`** (IndexedDB `chama_escrow_events_v1`,
store keyed by escrowId; escrow events are PUBLIC Nostr kinds 38100-38105 so no user-scoping/no privacy concern).
Persists each escrow's full raw event chain so `loadEscrow` rebuilds a COMPLETE chain offline / relay-down (the fix for
the tap-to-Browse null-load). Pure logic (unit-tested): `dedupEventsById` (first-wins, order-preserved, skips
malformed) + `selectEvictions` (evict-OLDEST-TERMINAL-first, then oldest-live only if forced; cap
`EVENT_CACHE_MAX_ESCROWS=1000`). IDB layer degrades to NO-OP when `indexedDB` unavailable (Node tests / private mode) —
never blocks a load. **Wired into `escrow-client.loadEscrow`:** seed `this.rawEvents` from the durable cache on first
touch (before the relay fetch) → merges with relay events → after a successful replay, `void putCachedEvents(id,
rawEvents, state.status)` (fire-and-forget; status drives evict priority). NOT wired into `resetLocalWallet` by design
(money reset ≠ history wipe; escrow events are public + re-fetchable; `clearEventCache` exported for a future explicit
"clear history"). ⏳ **Jetty device-verify:** do a trade → hard-reload with relays unreachable (or after the events age
off) → the trade still opens with FULL detail (chat/timeline) rebuilt from IndexedDB, and tapping an "Earlier trades"
row now rebuilds instead of toasting "not on the relay". NOTE: only helps trades loaded AFTER this ships (nothing was
persisted before); older ones still depend on the relay having the chain.

**DONE 2026-07-08 (⚠ TAURI LAUNCH FREEZE from the event cache — TRACED + fixed, uncommitted, 3083 green, browser-verified):**
Jetty: "the entire fix froze tauri each time I launch it, period." **Trace:** the durable event cache's IndexedDB
`openDb()` (escrow-event-cache.ts) is memoized in `dbPromise` and had NO timeout / NO `onblocked` handler. On launch,
`discoverAndLoadMyTrades` → `mapPool` → every `loadEscrow` `await`ed `getCachedEvents` → `await openDb()`. WKWebView
(Tauri) can STALL `indexedDB.open` on first launch with no event ever firing → the memoized promise never resolves →
EVERY loadEscrow hangs → discovery never completes → app frozen on launch, deterministically. (A synchronous THROW like
SecurityError was already caught → null; the freeze was specifically the silent HANG.) **Fix, two layers:** (1)
`openDb` now races a **3s timeout** (`OPEN_DB_TIMEOUT_MS`) → resolves null on hang (memoized null ⇒ cache off for the
session, all subsequent reads instant), + an `onblocked` handler; `getCachedEvents` wraps its transaction in the same
timeout (`TXN_TIMEOUT_MS`). (2) ⭐ moved the cache read OFF the hot launch path: `loadEscrow` now only falls back to
IndexedDB when **relays + memory produced ZERO events** (the archived case) — a normal launch loads relay-present
trades without ever touching IndexedDB. Browser-verified: a never-resolving open resolves null at ~3001ms (deadlock
broken); healthy IndexedDB still round-trips. ⏳ Jetty relaunch Tauri → should NOT freeze.

**DONE 2026-07-08 (archived-tap "Reloading…" hang — fixed, uncommitted, typecheck clean):** Jetty stuck on the
"⚡ Reloading trade…" toast after tapping an "Earlier trades" row. Cause: `openArchivedTrade` awaited `loadEscrow`
RAW — `fetchEscrowEvents` runs to a **15s** timeout + up to 2 completeness retries (~45s worst case), while the Toast
auto-dismisses at 4s → long silent hang, and these Jun trades PREDATE the community relay (06-28/07-01) so the reload
fails anyway. Fix: `Promise.race` the load against a **10s cap** — a reloadable trade (events on relay / durable cache)
resolves in ~2s; an aged-off one yields the honest "not on your Chama relay anymore — summary is what's saved on this
device" faster. A late loadEscrow still lands in the live list next render (no double-load). NOTE: the pre-relay Jun
trades will always fail to reload (data gone before both the relay + the event cache existed) — expected.

**DONE 2026-07-08 (Browse fiat decimals — small win):** `formatFiatAmount` (amount-display.ts, the single fiat
formatter) now drops decimals for every non-USD currency (USD keeps cents) — `maximumFractionDigits = USD ? 2 : 0`.
Reclaims width on small devices; no one prices a trade to the fractional shilling (TZS/KES/ARS…). Global (all fiat
surfaces), no test depended on the old 2-decimal behavior.
- Tests: block 29g case 9b (reabsorb→fresh-intent when lockable, →clear+breadcrumb when past-deadline/EXPIRED, the
  downgraded intent drives the resume via summarize, identity guard). Uses the REAL uppercase `EscrowStatus.CREATED` —
  the old `createdState()` helper's lowercase never matched the new lockable check, proving no regression in the
  existing decision-table cases. Browser boot clean.
- ⏳ **Jetty device-verifies (3-instance):** fund → force a lock/publish fail → let the trade expire → reload the seller
  → the balance now shows the calm "↩ Funds returned" banner (not the scary alarm); if the drain runs while still
  CREATED → the "Finish locking your trade" card offers a re-lock instead. ⚠ **Publish-failure ROOT CAUSE still
  unidentified** (relay flaps suspected — the console showed `nostr.mom`/`nos.lol` dropping; window was reloaded before
  capture). This fix makes the AFTERMATH honest + safe; a separate pass should harden lock-publish against relay flaps
  (relay-resilience territory) so the lock succeeds first try more often.

**DONE 2026-07-05 (commitment-bond on-chain verify + ceremony consolidation — uncommitted, predeploy green 2872):**
the sealed v1 bond (single-key CLTV commitment, DECISIONS 2026-07-03) independently consensus-proven on Mutinynet via
the new adversarial harness `scripts/mutinynet-commitment-verify.ts`: early spend rejected by the **CLTV opcode itself**
(`nLockTime = tip < T` → "Locktime requirement not satisfied") AND as non-final; a wrong-key witness rejected
("Invalid Schnorr signature"); the owner's REAL **3-input sweep** confirmed (txid `1dbdd00c…eede0`, byte-exact
vsize). Money-path fixes: **size-based reclaim fees** (`estimateReclaimFeeSats`, flat-300 underpaid ≥4-input sweeps),
funding **re-scan-every-check** (late deposits were strandable), **outspend recovery** (broadcast-then-lost-state → adopt
the on-chain spend), dust guard, min-term 30 blocks, BIP86 derivation golden-pinned. Ceremony REBUILT: "Your bonds"
list (multi-bond) → auto-polled funding (live-verified: a real 2 500-sat deposit auto-detected hands-free) → locked
(monotonic tip, Done-primary + confirmed reclaim) → reclaimed. **CopyButton swept app-wide** (all raw
`navigator.clipboard` button sites; robust webview fallback moved into `CopyButton.tsx`). **2-of-3 vestige deleted**
(attestation/lifecycle/custody-store/bond-transport/BondCustodyInboxModal/mutinynet-bond-harness/sim-bond-rig + dead
test blocks + 6 dead hook actions; `deriveBondSigningKey`→commitment-bond.ts, `newBondId`→commitment-store.ts;
kinds 38132–38134 documented RETIRED in `arbiters/bonds.ts` — never reuse). Findings for the verifier chat to hash:
`design/mockups/chama-bond-commitment-verify-findings.md`.

**DONE 2026-07-05 (live-chama liveness + announce — uncommitted, typecheck clean, 2759/2759 standalone asserts green):**
the arbiter-bond announcement kind (**38135**, chain-verifiable) + the **live-chama liveness score** are wired
end-to-end. Per-bond address fix first: each bond derives a UNIQUE BIP86 key (`keyIndex`, `m/86'/coin'/0'/0/index`,
persisted in `commitment-store.ts` + `deriveBondSigningKey({index})`) so no two bonds ever share an address —
default-wallet behavior, and reclaim re-derives the right key or fails loud. **`bond-announcement.ts`** (kind 38135,
addressable `d=community`): `buildBondAnnouncementEvent` / `parseBondAnnouncementEvent` (signer-authoritative) /
`verifyBondAnnouncement` (recompute-address + on-chain funded check, rejects network mismatch) / `selectLatestAnnouncements`.
**`arbiters/live-chama.ts`** — pure `computeChamaLiveness(community, bonds, ratingsByNpub, tip)` → coverage × commitment ×
reputation composite (only FUNDED+ACTIVE bonds count, per-npub dedup, log-scaled "how much × how long", Bayesian ratings);
`formatLivenessReadout` shows a bare COUNT (never names a single OG arbiter — scarcity reads as *opportunity*). Hook: **`getChamaLiveness(community)`**
composes fetchCommunityBonds + trade-verified ratings + the score. UI: **"Announce to your community"** on the ceremony
locked screen (`BondCeremonyModal` — community picker defaulting to the arbiter's own, publishes 38135, re-announce = refresh).
Kinds doc: **38135** allocated in `arbiters/bonds.ts` (38132–34 stay RETIRED). Briefs: `chama-live-chama-signal-brief.md`
(has a "Future — v1 vs v2 gold-star + participants redesign" section per Jetty).

**DONE 2026-07-05 (liveness signal UI + picker detail wiring — uncommitted, typecheck clean):** reusable
**`ui/components/LivenessSignal.tsx`** — the graduated signal (NOT a binary badge): a 5-segment "battery" meter
(thin=amber/opportunity, healthy=green, never red), the honest `formatLivenessReadout` line ("N arbiters · X% ·
~D-day bonds"), a HelpTip **"?" explainer** ("what makes a chama live…"), and a **soft thin-coverage nudge**
("needs arbiters — an opening for whoever bonds first"; becomes a real CTA only if `onBecomeArbiter` is passed).
Wired into **`GlobeCountryPicker`** single-community detail landing via an OPTIONAL `loadLiveness(slug)` prop +
`livenessBlocksPerDay` — fetch-once-on-open, fails soft. Jetty's calls (asked): **replace** the hardcoded greens with
pure computed liveness · load **detail-screen only** · arbiter nudge **soft/thin-only**. ⚠ **KEY FINDING:**
`GlobeCountryPicker` runs **PRE-SIGNER** (ConnectScreen, before Nostr connect) → `getChamaLiveness` (needs a
connected client) can't run in onboarding. So the picker is now *capable* (renders the real signal wherever a caller
passes `loadLiveness`) but onboarding still shows the trade-today reassurance (never dark). The list's hardcoded
green tiers were LEFT intact (ripping them pre-signer = dark launch, no computed replacement available there). ⏳ TO
LIGHT IT UP: a pre-signer read path (kind-38135 relay read + esplora verify; bonds+commitment only, ratings need the
post-connect client) OR reuse the picker post-connect. Recommend Jetty greenlight the read path before touching the
list tiers. Component + `getChamaLiveness` untouched by the 2759-green suite (UI not in the test graph).

**DONE 2026-07-05 (liveness on the Me screen — own chama, uncommitted, typecheck clean):** the LivenessSignal now
renders in **`YourChamaCard`** (MeScreen) for the user's OWN community — a single `actions.getChamaLiveness(slug)`
fetch, which works because Me is **post-auth** (client connected). Churn-safe: the effect keys off `communitySlug`
only (actions.* is a fresh identity each render but reads the live client internally, so a stale closure is fine —
`eslint-disable exhaustive-deps`), fails soft (null/throw → signal omitted, card never blocked). Wired
`loadLiveness={actions.getChamaLiveness}` in App's MeScreen render. This is the always-works home Jetty pointed at —
no onboarding reorder needed. ⏳ NEXT DECISION (Jetty leaning): **connect Nostr early** (explicit auth-first reorder
OR silent background keygen+relay-connect during onboarding) so `getChamaLiveness` also works in the GlobeCountryPicker
detail — then the picker `loadLiveness` prop lights up too. Arbiter-count "challenge" is only hard for the whole
190-country LIST at once (fan-out); for ONE community (Me, or a tapped country) it's a single call — trivial. A
list-wide count is also tractable via ONE batched kind-38135 read (no #d filter) grouped by community + esplora-verify
the few that have bonds.

**DONE 2026-07-05 (AUTH-FIRST onboarding reorder — uncommitted, typecheck clean):** sign-in is now the first gate;
the market picker moved OUT of the pre-signer `ConnectScreen` to a **post-connect gate in App**. Flow now:
WelcomeIntro → **sign-in** → (fresh npub only) **GlobeCountryPicker** → app. Mechanics: `ConnectScreen` dropped its
picker branch + the pre-connect community pill's "Change" (pill is now read-only "welcome back" reassurance from the
unscoped `lastHomeHint`; intro CTA "Choose my market" → "Get started"); App gained `needsHomePick` state (set in the
connected effect: `getUserCommunitySlugRaw() === null`) and renders `GlobeCountryPicker` before the main app when a
connected npub has no home — `onSelect={handleSelectCommunity}` (persists + resolves fed; already handled the
first-timer null-previous case) then re-checks the gate (a failed first switch clears the pick → picker stays to
retry). ⭐ **Because the picker is now post-connect, its country-detail liveness signal LIGHTS UP** (client connected →
`actions.getChamaLiveness` works) — `loadLiveness` + `livenessBlocksPerDay={BOND_LIVENESS_BLOCKS_PER_DAY=2880}` (signet;
→144 at mainnet) wired at both the picker gate and the Me render. **Sign-out behavior unchanged** (remembered chama via
lastHomeHint; land on logon, re-auth → straight in) — Jetty confirmed keep-remembered. Side effects: (1)+(2) RESOLVED
next day (see 2026-07-05 follow-up below); (3) the ConnectScreen `pendingReport` reframe is likely unreachable now
(reports queue post-signer). ⏳ Jetty's 3-instance/APK verify: fresh-keygen → picker → pick → app; auto-connect returning
npub glides straight in; sign-out → logon w/ remembered chama → re-auth → app; first-time switch failure keeps the picker up.

**DONE 2026-07-05 (bond-ceremony polish + liveness auto-refresh — uncommitted, typecheck clean, 2753 asserts green):**
Jetty's device-pass feedback batch. (1) **Auto-announce on lock** — `autoAnnounceOnLock` fires the kind-38135
announcement to the arbiter's HOME community the instant a bond's funding is detected (both the funding-poll and
"Check now" paths), once per bond (`autoAnnouncedRef` — opening a locked bond from the list won't re-fire); the manual
picker + "Announce again" stays for re-announcing / announcing to ANOTHER community. Fails soft (retry re-arms).
(2) **Arbiter duties listed** (`ArbiterDuties`) on the locked screen — "while it's locked, you arbiter": step in on
disputes · stay reachable · judge honestly. Makes "place your sats here while you perform your duties" literal.
(3) **Sats-recovery card hides when insignificant** (MeScreen: `showLocalRecovery && !isSmallLeftover`) — below the
dust line it read as "losing sats in limbo" vs the no-wallet promise; now silently accumulates and the card (+ its
fee-free ecash exit) reappears once it crosses `MAIN_SURFACE_RECOVERY_MIN_SATS`. A pending minted ecash note still
shows regardless. (4) **Liveness auto-refresh** — new shared `useLiveness(slug, loader, {intervalMs})` hook
(LivenessSignal.tsx): refetch on mount + window focus + gentle poll; the Me card now polls every 90s so a bond/rating
shows without a reload. ⚠ **CC PARALLEL WORK** in the same tree: CC shipped **#8** (light up the picker LIST) —
`fetchBondedArbiterCounts` (batched no-#d kind-38135 read → `groupLatestAnnouncementsByCommunity` → esplora-verify) +
`loadBondedCounts` prop + a "🛡 N bonded" country note, ADDITIVE over the registry tiers; App wires it at the picker
gate; tests green. Left the picker's detail-liveness to CC (didn't refactor it to `useLiveness` to avoid clobbering).

**OPEN QUESTIONS surfaced by the device pass (answers, not yet built):**
- **Bonding ≠ becoming a rostered arbiter** (Jetty saw no arbiter dashboard for his 2 bonded npubs) — CORRECT, unbuilt
  connective tissue: a bond publishes the 38135 liveness signal but does NOT add the npub to a community's arbiter
  roster (38120) / cabinet pool, so they aren't assigned trades and get no arbiter dashboard. The bond→roster
  enrollment is the key next integration (rides with Phase 2A + the real Dashboard).
- **Multi-chama bonding is NOT capacity-restricted yet** — nothing caps concurrent arbitration against bond size
  ("can't arbiter for more than their bond at any time"). That's exactly Phase 2B (wire capacity context + flip
  `BONDS_ENFORCED`); today it's free.
- **Auto-reclaim: recommend NO** — auto-reclaiming at term-end would auto-KILL the liveness signal (opposite of the
  renew-and-stay-bonded goal) and means the app signs+broadcasts a sweep unprompted (against the deliberate/confirmed
  design + extra key-use surface). Better: an "expired — re-commit?" renew nudge; keep-locked stays the default.
- **Custom bond term: premature** (Jetty's own read — "need data"). Presets cover it; a custom long-horizon term as a
  "here for the long haul" vision signal is a later, data-informed add.
- **% on Me but not onboarding** — the % is the ratings positiveRate, shown only when the client can TRADE-VERIFY the
  ratings (`aggregateVerifiedRatings` needs the settling trades loaded). A participating arbiter (Me) has them → %
  shows; a fresh newbie hasn't synced any trades → count 0 → % omitted. Trust-minimized by design; could show an
  unverified count in onboarding if wanted (trades away verification). Jetty: "doesn't matter too much."

**DONE 2026-07-05 (announce picker → 190-country search + enrollment brief/S1 — uncommitted, typecheck clean, 2755
asserts green):** (1) **Announce-to-community is now a full-world search** — the `AnnounceBond` `<select>` (curated
`getPickerCommunities`, ~dozen feds, African-skewed) → a search box over ALL 190 `getAllPickerCountries`, resolving any
country (fed or generated shell) to a community slug. New shared **`communities/country-resolve.ts`**
(`resolveCountryCommunitySlug` + `countryMatchesSearch` + `countrySubline`); MeScreen's 3 local copies deleted +
imported from there (dedupe). A "Chama" = any community inside any country, with or without a G-Bot fed.
(2) **Bond → arbiter enrollment brief** (`chama-bond-arbiter-enrollment-brief.md`): the gap Jetty's device pass found —
a 38135 bond announces liveness but does NOT enroll the npub in the assignable pool (roster 38120 + cabinet), so a
bonded npub is never seated + gets no dashboard. Design: bonded arbiters = a THIRD chain-verified, PERMISSIONLESS pool
source (∪ the elected roster). Integration points mapped (pool.ts injected `bondedPool`, CREATE `communityArbiters`
injection, provenance recognition, dashboard gate, + the capacity mismatch: `exposure.ts` reads legacy **38130**, must
bridge to **38135**). Staged S1→S4. **S1 built:** pure `bondedArbitersForCommunity(verifiedBonds)` → distinct
funded+active npubs (+2 tests). ⭐ **GOVERNANCE DECISIONS pending Jetty before S3** (recommendations in brief):
permissionless enrollment (YES) · announcement = opt-in (YES) · one union pool (YES) · prefer-bonded on assignment
(later, rides 2B). S2 (dashboard gate) + S3 (CREATE injection — bonded npubs actually get seated) are the next build.

**DONE 2026-07-05 (enrollment model LOCKED + S3 foundation — uncommitted, typecheck clean, 2758 asserts green):**
Jetty chose the **PERMISSIONLESS** model (a funded chain-verified 38135 bond auto-makes the npub an assignable
arbiter, ∪ the elected roster; announcement = opt-in). Built the safe, ADDITIVE, DORMANT foundation: `pool.ts`
`getTrustedArbiterPool`/`getTrustedArbiterPoolSources` gained a `bondedPool?: readonly string[]` option +
`bondedArbiters` source, unioned into the pool (normalized, dedup, still honors excludePubkeys). Zero behavior change
until a caller passes it (no prod caller yet) → provenance recognition comes for free wherever bondedPool is supplied
(bonded arbiters flow into `getTrustedArbiterPool`, which `classifyArbiterProvenance` compares against). +3 pool tests.
⏳ **REMAINING LIVE SLICE (money-path — must land together, then Jetty device-verifies):** (a) **CreateForm** —
`bondedArbitersForCommunity(await fetchCommunityBonds(effectiveCommunity))` → pass as `bondedPool` at
CreateForm.tsx:1068 (makes bonded npubs assignable in NEW trades); (b) **provenance recognition** — the counterparty's
classify path must ALSO fetch + pass bonded, else a seated bonded arbiter reads "unrecognized" (footgun) — land with
(a); (c) **S2 dashboard gate** — show the arbiter dashboard for a bonded npub. (d) later: **S4** capacity bridge
`exposure.ts` 38130→38135 + flip BONDS_ENFORCED.

**DONE 2026-07-05 (picker cleanup — uncommitted, typecheck clean, 2758 asserts green):** Jetty's two side notes.
(1) **`getPickerCommunities()` DELETED** (never reference again — naming hierarchy is communities < countries <
federations < world): the curated-feds helper is gone; `getCommunitiesByCountry` inlines
`COMMUNITY_REGISTRY.filter(!hiddenFromPicker)`, `decisions.ts` uses `communityForInvite`, tests use the inline filter.
(2) **"Live" tier REMOVED from the GlobeCountryPicker** — no more "⚡ Live now" section / `LiveDot` / "live local
Chama" label that blessed Kenya as special ("not true at all"). Every covered country now reads a calm green "✓ ·
available now" (never-dark rule kept), live countries fold into the normal list, and REAL liveness is only the computed
"🛡 N bonded" count (CC's `loadBondedCounts`). Kenya lists like any country; its 🛡 count is earned. `homeCountry`
featuring now covers any tier (locale head-start, not a live-badge). (3) **Onboarding splash rewritten** (Jetty's call:
show all 6, tag unbuilt "Soon"; "Split" = "Chip In", keep Chip In): `INTRO_USE_CASES` (ConnectScreen WelcomeIntro) now
lists **Exchange · Community Bill Pay · Marketplace** (built) + **Work · Chip In · Stack** (each dimmed + a "SOON" pill).
Lending retired from the splash (still a live Create vertical in code — the splash is now aspirational-honest, ahead of
the Create wizard). Intro subline "…sell, and lend" → "…sell, and more". ⚠ The verticals themselves are still BACKLOG
`[ ]` — the splash previews them; building Work/Chip-In/Stack as real Create options is separate downstream work.

**DONE 2026-07-06 (Create form matches splash + S4 capacity bridge — uncommitted, typecheck clean):** (1) **Create
wizard `VERTICALS`** now mirrors the splash: Exchange · Community Bill Pay · Marketplace (creatable) + **Work · Chip In ·
Stack** (disabled, amber "SOON" pill). Lending RETIRED from the picker (Work replaces it); the `"lending"` Vertical +
all its logic stay in code for back-compat (existing lending listings still render). `VERTICALS.id` loosened to `string`
(coming-soon cards never reach `setVertical`, which stays `Vertical`-typed; `readAllDrafts` filters !comingSoon).
(2) **S4 capacity bridge** — `exposure.ts` `assignableBondedArbiters({bonds, tradeMsats, allTrades, excludeTradeId})`:
Jetty's "auto-select by bond amount" rule applied to the **38135 commitment bond** (`actualSats`, not the legacy 38130),
enforcing BOTH §8 caps — per-trade (trade ≤ bond) AND aggregate (Σ other open bonded trades + trade ≤ bond); sub-floor
trades need no bond. Pure; +4 asserts (they sit past the sandbox 40s test horizon so they didn't run in-sandbox, but the
logic was verified directly via a throwaway script: 4/4 ok). ⏳ **The bond→arbiter enrollment now has BOTH foundations**
(S3 `bondedPool` pool source + S4 `assignableBondedArbiters`). Remaining LIVE slice (money-path, land together, Jetty
device-verifies): CreateForm fetches community bonds → `assignableBondedArbiters(...)` → pass as `bondedPool` at
CreateForm.tsx:1068 (bonded npubs that FIT the trade get seated); provenance path fetches+recognizes bonded (avoid the
"unrecognized arbiter" footgun); S2 dashboard gate; then flip `BONDS_ENFORCED`.

**DONE 2026-07-06 (bond→arbiter LIVE WIRING — the money-path unit, uncommitted, typecheck clean, 2758 asserts green):**
bonded arbiters now actually get SEATED + recognized. **(Part 1 — seat)** `CreateForm.handlePublish` (async) fetches
`fetchCommunityBonds(effectiveCommunity)` → filters funded+active → `assignableBondedArbiters({bonds, tradeMsats:
amountMsats, allTrades: []})` (per-trade cap; aggregate needs assignment-time data the creator lacks, so per-trade is
the create-time filter) → passes as `bondedPool` to `getTrustedArbiterPool`. Fail-soft (any hiccup ⇒ OG pool only). New
`fetchCommunityBonds?` prop, wired at BOTH App CreateForm renders. **(Part 2 — recognize, the footgun-closer)**
`TradeDetail` fetches the trade community's bonds (fetch-once effect keyed on `state.community`, fail-soft) →
`bondedArbitersForCommunity` → folded into the provenance `trusted` set via `getTrustedArbiterPoolSources({community,
bondedPool})` + `sources.bondedArbiters`, so a seated bonded arbiter reads GREEN not "unrecognized". New
`fetchCommunityBonds?` prop wired in App. **(Part 3 — dashboard)** NO change needed: `arbiterVisible`/the
ArbiterDashboardPanel are data-driven off `communityArbiters.includes(me)`, so once Part 1 seats a bonded npub they see
the arbiter dashboard automatically (Jetty's "my 2 npubs show no dashboard" resolves once they're seated on a
post-bond trade in their community). **⭐ OG FALLBACK (Jetty's design, LOCKED):** the OG cabinet is `deviceTrusted`
(readOfficialPool → every non-hidden community) so it's ALWAYS in the pool + unbounded (`BONDS_ENFORCED` stays false ⇒
OGs aren't capacity-filtered). A trade above every bonded arbiter's bond → only OGs remain assignable → OG seated.
"OGs auto-default to all chamas" = already true; "v2 enforces the OGs" = flip BONDS_ENFORCED later. ⏳ **Jetty
device-verifies (money-path, 3-instance/APK):** create a trade in a community with a funded bonded arbiter whose bond
≥ the trade → the bonded npub appears in the pool + can be seated + reads green to the counterparty + sees it in their
arbiter dashboard; a trade ABOVE their bond → falls back to an OG. NOTE: prefer-bonded-over-OG on assignment is NOT
built (round-robin picks among pool incl. OGs) — a later optimization (rides 2B), per the brief.

**⚠ PREFER-BONDED = A CONSENSUS CHANGE (finding 2026-07-06, DEFERRED TO 2B by Jetty):** traced the assignment — the
seated arbiter is **reducer-ENFORCED**, not just suggested: `state-machine.ts:532` rejects an arbiter JOIN with
`ARBITER_NOT_ASSIGNED` unless `event.pubkey === pickArbiterFromPool(communityArbiters, id, [buyer, seller])` (the
deterministic pick, replay-identical everywhere). So "prefer bonded" can't be a client-side reorder — it needs (a) the
bonded subset STAMPED into the CREATE event (the reducer is pure, can't fetch bonds), and (b) a change to the enforced
pick + the C1 `classifyArbiterAssignment` consent basis. That's a **coordinated protocol change** (mixed old/new
clients would pick different arbiters → JOIN accepted by some / rejected by others → chain divergence, money-path).
Trivial to roll out now (~no users) but still a reducer/consensus change → Jetty **deferred to 2B**. Until then
assignment stays round-robin: bonded arbiters DO get seated (they're in the pool) and take their fair ~1/N share, just
not preferred. When 2B builds it: stamp `bondedArbiters ⊆ communityArbiters` at CREATE → reducer + C1 prefer that
subset with OG fallback → version-gate the pick.

**DONE 2026-07-06 (#25 foreign-chama guided switch + v5.0 reframe — uncommitted, typecheck clean, 2758 green):** the
harsh **FED_MISMATCH** "Sign out and rejoin with the correct federation" error (thrown when a trade's fed ≠ the wallet's
fed — e.g. joining a foreign-chama trade) is now a **one-tap guided switch**: `App.onJoin` catches `e.code ===
"FED_MISMATCH"` → `pendingFedSwitch` modal ("This trade lives in 🇹🇿 {chama} — switch to it to pick up where you left
off; your sats stay safe") → `handleSelectCommunity(trade.community)` + **auto-retry the join**, fail-soft (blocked
switch ⇒ helpful toast, e.g. "finish your other live trade first"). Underlying `useEscrow` FED_MISMATCH copy softened to
match (LOCK-path copy in escrow-bridge left as-is). Reframed the header to **v5.0 "finish the bond"**, post-announcement
phase (Nairobi framing dropped). ⚠ **Jetty's device-pass findings:** (a) ⭐ **REAL BUG (Jetty was right; my earlier "working-as-designed" call
was WRONG) — deep-traced, brief `chama-native-lock-crashsafety-brief.md`:** the Tauri **RecoveryBanner** ("recover the
full trade amount to Lightning") fires for a trade that never LOCKED because the **native lock is NOT crash-safe**.
`escrow-bridge.ts:284-299` `lockAndPublish` spends the balance (`fedimint-client.ts:1073` `spendNotes`) then publishes
the LOCK as **two separate awaits** — a Tauri reload BETWEEN them moves the funds but publishes no LOCK (trade stays
CREATED for the seller) and **persists nothing** (the Fedi path stashes via `chama_pending_fundings_v1`; the native path
passes NO stash — `pending-fundings.ts:16` even falsely claims native is atomic). So on reload there's no record the
balance belongs to trade T's pending lock ⇒ `shouldShowRecoveryBanner` fires (RESERVED/CREATED isn't counted as active
escrow) and `identifyStrandedEcashSource` mis-attributes it to the most-recent CLAIM (an OLD trade). The drain advice is
actively harmful (abandons a live trade + burns LN fees vs finishing the lock). The old threshold patch treated the
symptom, never the non-atomic lock — **that's why it recurs.** FIX = make the native lock crash-safe (stash the spent
bundle before publish, clear after; boot resume/re-absorb — mirror the Fedi path); then the banner can distinguish
resume vs stranded. Serious money-path in code CC owns (lockAndPublish + pending-fundings) — build owner TBD (Jetty).
(b) **#34** browser returning-citizen jumps to nsec-paste — should try
extension first / double-tap (nsec-in-browser insecure). (c) **#35** SIM MODE e2e is BROKEN — buyer join FED_MISMATCHes
(wallet sim_fed_000 vs trade fed); sim never worked end-to-end (browser skeptics can't test a full trade). (d) **#36**
landing page still lists Lending. All three queued as tasks.

**DONE 2026-07-06 (#35 sim-e2e fed guards + #34 browser extension-first — uncommitted, typecheck clean, 2758 green):**
CC takes the native-lock crash-safety fix (#37, brief ready). Meanwhile: (1) **#35** — the three FED_MISMATCH guards
(join `useEscrow.ts:1675`, lock `escrow-bridge.ts:121`, claim `escrow-bridge.ts:581`) now **skip in sim mode**
(`!isSimModeOn()`): sim's fake `SIM_FEDERATION_ID` never equals a trade's real stamped fed, and these are real-money
defenses, so they were silently blocking every sim trade at join. Non-sim path byte-identical (tests fire as before,
2758 green). ⏳ Jetty browser-verifies a full sim trade join→lock→settle→claim now completes (the fed guard was the hard
block; if other sim wallet mechanics still fail that's a separate follow-up). (2) **#34** — dropped the "double-tap"
idea (Jetty: "stupid"). `handleReturningSignIn` now: **native (APK/Tauri) → nsec paste always** (no extension exists);
**browser → ALWAYS prefer the NIP-07 extension** (dropped the flaky `hasNostrExtension` gate that raced Alby's late
injection and dumped returning users onto paste), with the paste box as the fallback only after the extension is absent
/ dismissed — plus a browser-only amber "safer with an extension (Alby)" nudge above it. No mobile extension path.

**DONE 2026-07-06 (sim lock guard + sim-picker-skip diagnosis — uncommitted, typecheck clean, 2758 green):** Jetty got
past the join (fed fix) but hit **"Couldn't lock — receive watcher not verified"** (`fund-and-lock.ts:572`). Same class:
the sim wallet's Lightning receive is mocked (auto-settles) and never fires the watcher-ready signal, so the real-money
"can we detect the payment" gate timed out. Fixed: `if (isSimModeOn()) finishReceiveWatchReady()` before the gate
(real mode untouched). ⚠ **WHACK-A-MOLE:** sim e2e keeps tripping production defenses one at a time (fed-match → now
the receive-watcher; likely 1-2 more downstream at pollForFunding/claim). Recommend a **single systematic sim-e2e
sweep** (trace the whole fund→lock→settle→claim path, bypass every `!isSimModeOn()`-worthy guard in one pass, verify a
full browser trade) instead of reactive patching → task #38. **SIM-PICKER-SKIP (Jetty's Q):** the globe picker is gated
`getUserCommunitySlugRaw() === null` post-connect; that read (`claimLegacyStorageItem`, user-scope.ts:61) **CLAIMS a
legacy unscoped `chama_community`** for the first npub to connect — so a sim npub inherits a stale community from earlier
testing → non-null → picker skipped. NOT sim-specific (any fresh npub adopts a leftover legacy key); clearing the key
shows the picker. Minor; fix later if wanted (ignore the legacy-claim for a genuinely-fresh npub, or scope-isolate sim).

**DONE 2026-07-07 (#37 NATIVE LOCK CRASH-SAFETY — the money-path unit, uncommitted, typecheck clean, FULL suite
2954/2954 green [+~200 asserts incl. new block 29g]):** Jetty Go'd all four recon recommendations (D1 re-absorb-only ·
D2 90-day horizon · D3 quorum-gated · D4 one unit). Brief + full verified design: `chama-native-lock-crashsafety-brief.md`.
- **⛔ RESUME-PUBLISH REJECTED (recon finding, drives everything):** boot NEVER re-publishes a LOCK — two distinct LOCKs
  on a chain permanently brick replay (2nd LOCK's INVALID_STATE not replay-benign → loadEscrow null forever), and a
  stale bundle whose notes the wallet's try_cancel auto-refund reclaimed would hand the counterparty a HOLLOW escrow
  (detectable only at the winner's failed redeem). Recovery = **RE-ABSORB ONLY** (reissue-to-self, `redeemWithRetry` →
  `/reissue-notes`); "resume" = normal FOREGROUND re-lock from the restored balance.
- **Part 0 — 90-day lock-spend horizon (`LOCK_SPEND_TRY_CANCEL_SECS`):** fedimint OOB spends auto-refund to the SPENDER
  after try_cancel_after (browser SDK default **1 DAY**, native bridge 7d) — shorter than a disputed trade ⇒ latent
  escrow-hollowing fund-loss, NO crash needed. Lock spends now pass 90d explicitly via new optional
  `mint.spendNotesDetailed` (native: `timeoutSecs` to `/spend-notes`, no Rust change; browser: `tryCancelAfter`), which
  also surfaces the spend `operationId` (was discarded). Non-lock spends keep SDK defaults.
- **Part A — `src/fedimint/pending-native-locks.ts`** (`chama_pending_native_locks_v1`, user-scoped, SEPARATE from the
  Fedi store): lifecycle `intent → spent → publish-attempted → cleared-on-confirmed`. `bridge.lockAndPublish` REBUILT on
  the proven Fedi shape: settle-prior-entry (never clobber live bearer notes) → V8 fail-closed `assertNativeLockStashWritable`
  BEFORE any spend → intent → `spendNotesForLock` (client half 1) → **synchronous** stash upgrade with the raw notes →
  `buildEscrowLockBundle` (half 2; no strict amount equality — browser overpay-by-denomination preserved) →
  publish-attempted → publish → **positive confirm `state.lock.notesHash === ours` ⇒ clear** (also closes the old
  false-"locked" hole where the swallow reported success on a dropped lock). Sim/testnet fully gated. NEW status gate in
  `prepareLockContext` (`Cannot LOCK in state X`) closes the pre-existing publish-onto-non-CREATED chain-poison hazard.
  Covers ALL native entry points (BOLT11/NWC/onchain/Try-LOCK-now) AND the browser WASM wallet (same bug, 1-day window).
- **Part A2 — boot drain `drainPendingNativeLocks`** (beside the Fedi drain in initFedimint; single-flight; sim/testnet
  skipped): per-entry FAIL-CLOSED table — fed-mismatch ⇒ keep (no budget burn) · loadEscrow null ⇒ keep (unknown⇒refuse)
  · LOCK-with-our-hash ⇒ **clear only** (never re-absorb a live escrow's backing — the Fedi drain still has this hole,
  noted in brief) · different-hash ⇒ re-absorb · CREATED+`spent` ⇒ re-absorb · CREATED+`publish-attempted` ⇒ re-absorb
  only on a healthy ≥2-relay read · already-spent family on a funding re-absorb ⇒ notes positively dead (our own
  auto-refund landed) ⇒ clear · else attempts++ (cap 12; user-initiated retries bypass the cap). New
  `EscrowClient.getConnectedRelayCount()`.
- **⭐ DOUBLE-PAY HOLE CLOSED:** `fundAndLockAction` now settles any notes-carrying entry BEFORE creating an invoice
  (bridge `settlePendingNativeLock`) — refuses new payment while unresolved; already-committed ⇒ returns locked;
  re-absorbed + balance covers ⇒ locks DIRECTLY (no new invoice). Plus a funding INTENT persisted at fund start (covers
  the widest W1 window — Jetty's actual repro: payment landed, crash before lock; also the reload-DURING-spend W3
  window for attribution); cleared on clean `expired`, TTL 48h.
- **Part B — honest surfaces:** `hasPendingNativeLock` suppressor in `shouldShowRecoveryBanner` + `decideChamaBarLabel`
  (optional params, existing callers byte-identical); `hasTraceableIdleBalance` gated (stops persisting the WRONG
  `inferred-from-claim-history` sats-trace); MeScreen SATS-RECOVERY card hides + new calm "LOCK RECOVERY PAUSED" card
  for attempt-exhausted entries; `DestroyEcashConfirmModal` hides the drain CTA + promotes Cancel when the balance
  belongs to a pending lock; NEW **`PendingLockCard`** ("Finish locking your trade", calm, renders ABOVE Browse/Create)
  → one-tap `actions.lockAndPublish(escrowId, stashed lockOpts)` (selectedItems/savedHandleId preserved — menu listings
  resume correctly). Suppression BOUNDED (stale intents + exhausted entries stop suppressing).
- Corrected the false "native is immune/atomic" comments (pending-fundings.ts header, useEscrow, tests). ⏳ **Jetty
  device-verifies (3-instance/APK, money-path):** kill between spend and publish → relaunch → drain re-absorbs → resume
  card → finish lock → trade completes; kill after publish-ACK before clear → drain detects committed LOCK, clears, NO
  re-absorb; W1 reload (funded, not locked) → resume card instead of drain banner + no wrong sats-trace; fed-switch
  modal shows the pending-lock copy. NOTE: the browser 1-day→90-day horizon change applies to NEW locks only.
- **⭐ ADVERSARIAL-REVIEW HARDENING (same day, 18 findings raised → all triaged, the real ones fixed):**
  (1) **per-escrow flow mutex** (`withNativeLockFlow`) — bridge lock flow, inline settle, and the drain all serialize
  per trade, closing the recovery-re-absorbs-a-LIVE-in-flight-lock hollow-escrow race + the cancel→re-tap double-flow
  (cross-TAB browser interleavings remain the documented residual; native shells are single-webview);
  (2) **identity-guarded mutations** — clears/attempt-bumps only touch an entry still holding the SAME notes (a stale
  drain snapshot can never delete a successor attempt's live notes); drain re-fetches per entry + drains CHAIN instead
  of coalescing (a fed-switch re-drain with fresh deps is never swallowed);
  (3) **suppression hard-bounded** — `summarizeNativeLocksForUi` now takes {currentFederationId, balanceMsats}: other-
  fed entries + >7d-old entries (`NATIVE_LOCK_SUPPRESS_MAX_MS`) go to the calm stuck card instead of suppressing
  (fed-blind suppression could hide unrelated stranded balance FOREVER since fail-closed keeps never burn attempts),
  and an intent only tells the resume story when the balance can actually satisfy its lock (cancelled/failed fundings
  tell no false "app closed" story; intent also cleared on clean expired/aborted, Fedi-runtime refusal hoisted above
  the stash);
  (4) **honest outcomes** — the direct-lock shortcut + Finish-lock CTA verify `state.lock.notesHash` instead of
  trusting the Cannot-LOCK swallow (no more false "locked" success on a trade that just went terminal), the shortcut
  re-checks CREATED post-settle, and both check `signal.aborted` (an aborted funding can no longer proceed to lock);
  (5) **W3 window minimized** — the stash upgrade now runs via a synchronous `onSpent` callback INSIDE
  `spendNotesForLock` before any diagnostics await (money-debug reads gated on `mlogEnabled()`), and the native
  adapter's post-spend balance refresh is fire-and-forget;
  (6) **UI sim/testnet-gated** (a real entry's resume in sim would have locked FAKE notes into a REAL trade) +
  publish-attempted re-absorb requires the healthy relay bar BEFORE the fetch as well as after. Accepted residuals
  (documented): relay-count is pool-health, not per-relay fetch coverage (D3's accepted risk); cross-tab stash races.

**DONE 2026-07-08 (ChapSmart fiat-funded escrow "Fund with M-Pesa" — BUILT end-to-end, flag-dormant, uncommitted,
typecheck clean, FULL suite 3013/3013 green [+30 asserts, new "CHAPSMART ON-RAMP" block]):** brief
`design/mockups/chama-chapsmart-fiat-funding-brief.md` (its ✅ CONFIRMED 2026-07-08 section = ChapSmart API v6 shapes +
Jetty's answers). NOT a "buy sats" page — ChapSmart as an **alternate payer of the funding BOLT11**. ⭐ **Architecture
(simpler than the brief's step 2):** ZERO `fund-and-lock`/`useEscrow` changes — no `fundingMethod: "chapsmart"`, no
`autoPayInvoice`. The AtomicFundingModal already displays the exact-amount invoice + watches for payment, so ChapSmart
is purely an alternate payer of the DISPLAYED invoice inside `awaiting-payment`; receive-watcher + LOCK byte-identical.
Built: (1) **`chapsmart-onramp.ts`** rebuilt on the real v6 API — `getBuyQuoteForSats` (ChapSmart quotes are
TZS-driven; probe-then-re-quote until `calculatedSats` lands within 1.2% of the exact invoice sats, margin inside the
server-enforced ±2% send-sats tolerance), `ensureChapsmartAccount` (anonymous 16-digit account via proxy
`/create-account`, user-scoped persist), `lookupMpesaTransaction` pre-validation + `sendBuySats`,
`chapsmartMpesaPaySteps` (the Kutoa-Pesa AGENT flow: `*150*00#` → 2 Kutoa Pesa → **wakala 1228685** → exact TZS → name
BRIAN → PIN; the M-Pesa SMS code IS the mpesaId), `normalizeMpesaConfirmationCode`, `friendlyChapsmartError`
(409/410/429/503). (2) **Modal sub-flow** (`ChapsmartMpesaPanel`, AtomicFundingModal.tsx): "🇹🇿 No sats? Fund with
M-Pesa →" under the invoice CopyButton → quote → SW+EN steps + agent-number copy + PAY-EXACTLY banner + code input →
lookup pre-check (**fail-soft**: Jetty's proxy lacks a `/buy-sats/mpesa-lookup` route yet, so 404 ⇒ skip straight to
send-sats, which is authoritative) → "ChapSmart is paying" state; the watcher flips to mint-confirming and the panel
yields to the normal flow. (3) **Gating:** `CHAPSMART_ONRAMP_ENABLED=false` (localStorage `chama_chapsmart_onramp`
"1"/"0" dev override) · `!isSimModeOn()` · TZ context (`isTanzaniaPayoutContext`) · **Exchange ("p2p-trade") excluded**
— new `tradeCategory` threaded App→pendingFundAndLock→modal. ⏳ TO GO LIVE (Jetty infra, no code): API key from
ChapSmart (IP-scoped to the VPS; **expires 1 yr** — calendar it) → redeploy `~/Downloads/chapsmart.ts` on the IncogNET
VPS behind Caddy w/ CORS for Chama origins (+ optionally add the mpesa-lookup proxy route) → set the real
`DEFAULT_CHAPSMART_PROXY_BASE` → flip the flag. Then device-verify with a small real TZ trade.

**DONE 2026-07-06 (sim-e2e sweep — sim trade now completes join→lock→settle→claim→payout, uncommitted, typecheck clean,
2758 green):** Jetty confirmed sim works e2e; two failures + a sweep. (1) **On-chain payout in sim** (⚠ CORRECTED per Jetty:
"don't DISABLE onchain in sim — it's a real feature for TZS off-ramp; treat it like LN"): the sim/browser wallet had NO
`onchain` adapter (`fedimint-client.ts:472` `requireOnchainWallet` throws). Fix = **mock it in the sim wallet**
(`sim-wallet.ts` new `onchain` object: `withdraw` DRAINS the balance + returns a fake txid, exactly like the LN
`payInvoice` leg; deposit methods stubbed) so the NORMAL `payOnchain` path runs in sim and drains cleanly. Reverted the
earlier claim-and-payout skip + the MeScreen `!isSimModeOn()` recovery-card suppression (no longer needed — onchain
drains, no phantom leftover). Onchain now behaves identically to LN in sim. (2) **Timing** — sim per-op delay was 3-8s (`sim-wallet.ts:40`), and
the CLAIM chains several (redeem → payout auto-settle → balance poll) → ~20s+ drag. Shortened to **1.2-2.6s** (one knob;
a single step ≈ lock-speed, multi-step claim a few seconds — "not too fast, not too long"). (3) **Me recovery in sim** —
the mocked on-chain payout intentionally doesn't drain the sim balance, which would've shown a leftover "recover" card;
suppressed the Me `showLocalRecovery` card in sim (`!isSimModeOn()`), consistent with the already-sim-suppressed banner.
Low-level wallet (`fedimint-client` probeReachable/gateway, `sdk-adapter`) already had sim bypasses; the orchestration
guards (fed-match join/lock/claim, receive-watcher, on-chain payout) are the ones this + the prior fixes cover. ⏳ Jetty
browser-verifies a full sim trade for BOTH payout destinations (LN + on-chain) + the snappier timing.

**DONE 2026-07-05 (auth-first follow-ups + XProtect dev-kill forensics — uncommitted, typecheck clean; suite verified
green through all touched sections in-sandbox [1894/1894 asserts, 0 fails — sandbox reaps long processes ~90s so the
FULL run stays Jetty's predeploy]):**
- **BLF-init deferral:** the auto-init effect (App.tsx) now returns early while the home picker gates the app
  (`getUserCommunitySlugRaw() === null`, read from source = effect-order-proof; autoInitDone NOT latched). Fresh npub no
  longer inits BLF behind the picker — the pick itself inits via `handleSelectCommunity`. ⭐ Also fixed a real leak: the
  old `use-default` path PERSISTED `home=blf` behind the gate, so quit-mid-pick + relaunch silently skipped the picker.
  Reconcile-refused during a first pick still surfaces: identity stays set → gate drops → destroy-confirm modal renders.
- **Picker-gate toast:** the gate return now renders `<Toast>` — a failed first pick ("Couldn't reach X…") was invisible.
- **Pending-community stash RETIRED:** all four helpers + `PENDING_COMMUNITY_KEY` deleted from `communities/storage.ts`
  (tombstone comment left — never reuse the `chama_pending_community` key); useEscrow's connect path now just deletes any
  stale pre-4.3 stash key; tests.ts block 31a trimmed to the surviving community-blind-BLF-fallback assert.
- **⚠ XPROTECT KILLED A DEV SESSION (the "Malicious Script Blocked" crash):** fresh-npub keygen → whole tauri-dev tree
  vanished (`[Process completed]`, NO crash report = external SIGKILL; xprotectd verdict logged 22:14:20, payload
  `<private>`-redacted). NOT our code — the app + bridge were healthy (the 404 chain_id guardian WARNs are benign).
  Prime bait: `dev-instance.sh`'s inline `lsof→kill -9` sweep + `exec npm` (script PID *was* the whole tree).
  **Hardened:** sweep moved to `scripts/dev-free-ports.mjs` (Node, same semantics: own ports only, TERM→400ms→KILL);
  `exec` dropped — bash survives as supervisor and prints exit status (137 = SIGKILL → external kill legible next time).
  **CLOSED same evening:** relaunch worked (NOT reproducible → one-off periodic/behavioral sweep); nothing named in
  Notification Center / Privacy & Security; log verdict stays `<private>`. Long-term fix remains the deferred
  prod-signing item (Apple Dev ID).
- **⚡ LIST TIERS LIT (bond track — Jetty picked "light the list, ADDITIVE"):** the picker country LIST now carries the
  computed bond signal on top of the registry tiers (floor kept — never dark, no regrouping/reshuffle; promotion of
  bonded "available" rows into the Live group deliberately deferred until real bonds exist in the wild). Mechanics:
  `groupLatestAnnouncementsByCommunity` (bond-announcement.ts — batched no-`#d` dedup keyed (npub, community); per-npub
  selectLatest would collapse an arbiter bonded in two chamas) → hook action **`fetchBondedArbiterCounts()`** (ONE
  kind-38135 query limit 500 → group → esplora-verify per community, bounded 12 chain-reads/community so fake-announce
  floods can't esplora-hammer → `computeChamaLiveness(…, new Map(), tip).arbiterCount` owns the FUNDED+ACTIVE dedup →
  `Record<slug, count>`, zero-count omitted) → picker prop **`loadBondedCounts`** (fetch-once-on-mount, fail-soft) →
  CountryRow renders a green "· 🛡 N bonded" subtitle note when N>0 (country note sums its chamas' counts; per-chama
  truth stays on the detail view). Wired at App's needsHomePick gate. +4 grouping tests (incl. a nostr-tools gotcha:
  finalizeEvent stamps verifiedSymbol and {...spread} COPIES it, short-circuiting verifyEvent — wire-shaped test events
  must be JSON round-tripped). Suite green through all touched sections (2753 asserts, 0 ❌; full run = Jetty's predeploy).

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
