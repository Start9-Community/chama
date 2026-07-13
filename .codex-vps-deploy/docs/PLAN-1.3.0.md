# Chama 1.3.0 — Implementation Plan

**Status:** plan-first (no app code written yet, by request).
**Decisions captured this round:**
- **#2 lending repayment → PARKED.** Hide the fiat rails at lock for every vertical now; leave a documented hook so loan-repayment can re-enable a fiat-rail-at-lock path later. The "lock with an external no-KYC invoice + chain it with Chama, guarded against liquidity drain" idea is recorded under the hook for a future minor.
- Heavy-feature priority (all four selected): **#6 quantity/anti-spam, #7 shared-order view, #8 notifications/DM, #9 landscape.** #5 image bug and the globe are covered regardless.
- Tooling **#10 is built and shipped-ready** in this round (see `scripts/commit-file.sh`, `scripts/release.sh --from-tmp`, `npm run ship`).

**Effort key:** S = < ½ day · M = 1–2 days · L = 3–5 days. **Risk** reflects blast radius on the escrow state machine / on-wire schema.

---

## Sequencing roadmap

| Phase | Items | Why this order |
|------|-------|----------------|
| **0 — done** | #10 commit tooling | Enabling infra: every later phase ships through it. |
| **1 — safe surface fixes** | #1, #3, #4, #2-hide | Low risk, no schema changes, individually shippable. Good momentum + immediately visible polish. |
| **1b — correctness bug** | #5 image sync | Independent; needs a device repro. Run in parallel with Phase 1. |
| **2 — economic safety** | #6 → #7 | #6 (inventory) is the foundation; #7 (shared view + countdown) reads #6's "remaining" and reuses `joinHolds`. Touches the authoritative state machine — most test-heavy. |
| **3 — comms** | #8 notifications + Nostr DM | Self-contained once Phase 2 events exist to notify about. Crypto-interop testing against real clients. |
| **4 — surfaces / wow** | #9 landscape, globe | Pure presentation; no protocol risk. Globe is the headline onboarding moment. |

Rationale: ship value early and de-risk the schema-touching work (#6/#7) in the middle with the most test budget, leaving presentation work (which can't break trades) for last.

---

## #1 — Enforce full number + country code on phone reveal · **S · low risk**

**Goal:** when a phone handle is revealed (in settings and during a trade), show the *entire* international number including the `+CC`, not a flag-led, country-code-stripped national form.

**Root cause (found):** `src/ui/panels/SavedHandlesPanel.tsx:331–332` — on reveal, phone rails render with `formatPhoneNumberForDisplay(h.handle)`. That returns `getPhoneNumberDisplayParts(value).display` (`src/payments/saved-handles.ts:548–556`), which is the **flag-led** form `"${flagEmoji} ${nationalFormatted}"` — it deliberately drops the explicit `+254` digits and shows only the flag + national grouping. For Kenya the national part is 9 digits with no `+254`, which is the "missing digits / no country code" you saw. (Where the flag isn't known it falls back to `normalized`, which *does* include `+CC` — hence the inconsistency.)

**Approach:**
1. Add one canonical formatter in `saved-handles.ts`, e.g. `formatPhoneNumberRevealed(value)` → `"🇰🇪 +254 712-345-678"` (flag, then the **full** `normalized` international form). Single source of truth for any "fully revealed to a participant" context.
2. Use it at every reveal surface: `SavedHandlesPanel.tsx:332`, the active-trade participant reveal in `TradeDetail.tsx:~1911` (verify it uses the new formatter, not raw cleartext or `.display`).
3. Leave `maskHandle()` (public/masked) untouched.

**Tests:** unit-assert the revealed output for a KE/+254, a NANP/+1, and an unknown-CC number all contain the country-code digits; add to `src/escrow-engine/tests.ts` or a small `saved-handles` test.

---

## #2 — Don't show Banxaas / Chapsmart at lock (lending parked, with hook) · **S–M · low risk**

**Current state (found):** `src/payments/external-swap-registry.ts` already models placement by context. Bidirectional providers (Banxaas) are surfaced **pre-LOCK** via `getBidirectionalSwapsForContext()` (line ~339); offramp-only providers (Chapsmart) are **already** claim-modal-only (hidden until `CLAIMED`, see header comment lines 18–21). So the only thing actually appearing "at lock" today is the Banxaas pre-LOCK CTA.

**Approach (park lending):**
1. Gate the pre-LOCK CTA behind a single capability check, e.g. `fiatRailsAllowedAtLock(vertical): boolean` in `external-swap-registry.ts` (or `rail-registry.ts`). Default **false** for all verticals → `getBidirectionalSwapsForContext()` returns `[]` at lock.
2. Find and neutralize the call site in the lock UI (`src/ui/panels/AtomicFundingModal.tsx` / `src/payments/fund-and-lock.ts`) — it should render nothing when the gate is false.
3. Claim-time off-ramp behavior is unchanged (Chapsmart/Banxaas still available post-CLAIMED).

**The parked lending hook (record in `DECISIONS.md`):**
```
fiatRailsAllowedAtLock(vertical) === vertical === "lending-repayment"   // FUTURE, default off
```
When lending repayment is built, this flips on *only* for that vertical, enabling "pay the loan in fiat via Banxaas, then land the Chama lock with the external invoice." The **liquidity-drain guard** for that future work: a lock backed by an external invoice must be bounded by the same per-order / inventory ceiling as #6 and require the invoice to be settled (or hash-locked) before the Chama escrow commits funds — never let an unsettled external promise reserve Chama liquidity. Recorded now so the idea isn't lost; not built in 1.3.0.

**Tests:** assert `getBidirectionalSwapsForContext()` returns empty at lock context for each vertical; assert claim-context still returns providers.

---

## #3 — NWC "Change" button routes to the wrong screen · **S · low risk**

**Root cause (found):** `src/ui/App.tsx:1694` passes `onOpenSettings={() => setView("saved-handles")}` into `TradeDetail`. The NWC banner's **CHANGE** button calls `onManage={onOpenSettings}` (`TradeDetail.tsx:1723` and `:2102`) → lands on **Payment Handles**. Note the same `onOpenSettings` is *correctly* used by the "no saved handles" CTA (`TradeDetail.tsx:~1688`), so it must **not** be globally repurposed.

**Approach:**
1. Add a distinct prop `onOpenNwcSettings?: () => void` to `TradeDetail`.
2. Point both `NwcStatusBanner` instances at it: `onManage={onOpenNwcSettings}`.
3. In `App.tsx`, wire `onOpenNwcSettings={() => setView("advanced")}` (the `SettingsAdvanced` screen, which owns the NWC manager).
4. Optional polish: add a `focus="nwc"` prop / scroll-anchor in `SettingsAdvanced.tsx` so it scrolls to the NWC section on open.

**Tests:** none automated needed; manual — CHANGE opens Advanced › NWC, the no-handles CTA still opens Payment Handles.

---

## #4 — Reorganize the voting tally (green ⟵ pending ⟶ orange, under teal arbiter) · **M · low risk**

**Goal:** make the tally read spatially like the decision: arbiter (teal) on top; the **"awaiting decision"** state centered directly beneath it; the **green** vote on one side and the **orange** vote on the other. This matches how a voter reasons about the choice.

**Current state (found):** colors are defined in `src/ui/theme.ts` (green `#22c55e`, teal `#2dd4bf`, amber/orange `#fbbf24`); role colors per `decisions.ts` comment are Buyer / Seller = Bitcoin Orange / Arbiter = Signal Teal. The participant block already uses Trinity order Buyer · Arbiter · Seller (`TradeDetail.tsx:1294`) and a `"1fr 1fr 1fr"` grid (`:1504`). The "awaiting decision" label is at `:530`. Vote buttons (green = side with buyer, orange = side with seller) are at `:1978–2036`.

**Approach:**
1. Refactor the tally block (~`:1500`) into an explicit 3-zone layout: left = green tally/vote, center column = teal arbiter header **with the pending/"awaiting decision" chip stacked beneath it**, right = orange tally/vote.
2. Keep the vote buttons' semantics; only re-flow position so green sits left, orange right, consistent with the tally above them.
3. Drive everything off the existing `state.votes` / `resolvedOutcome` so no logic changes — purely presentational ordering.

**Tests:** snapshot/manual across the states: no votes (centered "awaiting"), one vote each side, resolved.

---

## #5 — Images sent from the APK never appear elsewhere · **M (hotfix) / L (durable) · medium risk**

**Symptom:** APK → image shows only on the sender's own device; browser → image appears everywhere.

**Current state (found):** chat images are inlined as **base64 data URLs** inside the chat event (`src/ui/panels/ChatPanel.tsx`: cap `MAX_CHAT_IMAGE_DATA_URL_CHARS = 120_000`, downscaled to `960px`), sent via `escrow-client.ts:sendChat()` (~`:870`) and `relayManager.publish()`. The relay layer already detects rejection: `relay-manager.ts:publish()` (`:398`) returns `{accepted, rejected, errors}` and **rejects when zero relays accept**, and `onOk` (`:51`, `:350`) carries the relay's `accepted` flag + `message`.

**Most likely root cause:** APK-encoded images are larger than the browser's (different WebView canvas/JPEG encoding), and after JSON + NIP-44 the event exceeds relays' max-event-size, so **every relay sends `OK:false` ("event too large")** and `publish()` rejects — but the sender already sees an **optimistic local echo**, so it looks fine on their device only. Browser images are small enough to slip under the cap, so browser→everywhere works.

**Diagnostic plan (confirm before fixing):**
1. Log `JSON.stringify(signed).length` and the per-relay `onOk(message)` for chat events on Android.
2. Compare the produced data-URL byte size for the same photo on Android vs desktop.
3. Confirm whether `sendChat` applies the local echo before/independent of `publish()` success (it shouldn't claim success on reject).

**Fix (two layers):**
- **1.3.0 hotfix (M):** enforce an *encrypted-size budget* — recompress/downscale (force JPEG quality, smaller max edge, target encoded bytes, e.g. ≤ 60 KB) until under a safe relay cap; surface a real error toast on `publish()` reject instead of a silent local echo. Same code path on both platforms, so Android stops producing oversized events.
- **Durable follow-up (L, can be post-1.3.0):** move images **off the event** — upload to a Blossom server / NIP-94, send a tiny chat event carrying URL + blurhash + dimensions, render via fetch. Permanently removes the size asymmetry and cuts relay load.

**Tests:** unit-test the recompression returns ≤ budget bytes; integration-test that a `publish()` reject shows an error and does not leave a "sent"-looking local echo.

---

## #6 — Quantity per order + per menu button, synced, anti-spam · **L · medium–high risk** (economic-safety core)

**Goal:** no one can drain a seller's liquidity by spamming orders. Quantity is bounded both per order and per offered item, and the bound is enforced everywhere.

**Current state (found):** `MenuItem` (the seller's offered button, `types.ts:289`) has **no** quantity/inventory field. Only `SelectedMenuItem` (the buyer's chosen count, `:307`) has `quantity`. **Nothing decrements inventory anywhere** (confirmed: no inventory-decrement code exists). So a buyer can choose an arbitrary quantity and unlimited buyers can each open/lock against the same offer.

**Approach:**
1. **Schema (`types.ts` + `event-parser.ts`):** add to `MenuItem` (and the single-listing equivalent): `stock?: number` (units available) and `maxPerOrder?: number` (per-order ceiling). Keep optional — `undefined` = unlimited (legacy/back-compat). Validate in the event parser.
2. **CreateForm (`CreateForm.tsx`):** add stock + max-per-order inputs per menu button and for single mode; validate (`maxPerOrder ≤ stock`, integers > 0).
3. **Enforcement (the anti-drain core, in the pure reducer `state-machine.ts`):** committed units for an item = Σ active `joinHolds[*].selectedItems[item].quantity` + locked `selectedItems` quantities. A JOIN/order is accepted only if `requestedQty ≤ remaining (= stock − committed)` **and** `requestedQty ≤ maxPerOrder`. Reject over-cap JOINs as an invalid transition. This makes the cap authoritative, not merely a UI hint.
4. **UI mirror:** clamp/disable the quantity selector and show "X left" in `TradeDetail`, `TradeCard`, `BrowseView`, and the CreateForm preview — all derived from the same listing fields + holds (single source of truth → "synced everywhere").

**Consistency note:** Nostr is serverless/eventually-consistent, so two buyers can race the last unit. The existing `joinHolds` + JOIN-ACK + seller/arbiter acceptance is the tie-breaker; the reducer rejects the loser's lock. Document this model in `DECISIONS.md`.

**Tests:** extend `escrow-engine/tests.ts` — over-cap JOIN rejected; concurrent holds sum correctly; remaining hits 0 → further JOINs rejected; legacy items (no stock) behave as today.

---

## #7 — Shared order view + viewer countdown (only when 0 < remaining < 2) · **M · medium risk** (builds on #6)

**Goal:** the same visible order stays viewable by others until it's locked; when someone is actively viewing/holding it, tell other viewers and show a public countdown — but **only** when remaining quantity is `< 2` and `> 0` (i.e., the last unit is genuinely at stake).

**Current state (found):** the reservation foundation exists — `joinHolds` (`types.ts:630`) hold `expiresAt`, `selectedItems`, `eventId` per role; `joinHoldExpiresAt`, `JOIN_HOLD_LOCK_GRACE_SECONDS`, `roleUsesJoinHold` in `state-machine.ts`; "reserved trade UI" already shipped (commit `c207008`). A `CountdownTimer` component exists (`src/ui/components/CountdownTimer.tsx`).

**Approach:**
1. **Stable identifier:** ensure each visible order keeps a stable listing/order id (the listing `d`-tag / address) so multiple trade instances reference the *same* order. When buyer A locks, others continue to see the same order (with updated remaining) until it's sold out/fully locked. ("Sync a new trade id / use an identifier for the same visible order with their existing order once locked.")
2. **Public "being viewed" + countdown:** when `0 < remaining < 2` and an active `joinHold` exists, surface in TradeDetail (and a subtle badge on TradeCard): "Someone is viewing this — Ns left if they don't complete," driven by the hold's `expiresAt` via `CountdownTimer`.
3. **Privacy:** reveal only the countdown + the fact of a viewer — never identity. Gate strictly on `remaining` from #6 so it never shows when plenty of stock remains.

**Dependency:** needs #6's `remaining`. Build immediately after #6.

**Tests:** badge/countdown shows only in the `0 < remaining < 2` window; hides at `remaining ≥ 2` and at `0`; countdown tracks `expiresAt`.

---

## #8 — Opt-in notifications in Me + Nostr DM (and fix the DM decryption) · **L · medium risk**

**Goal:** a baked-in, opt-in notifications surface under **Me › Notifications**, including optional Nostr DM delivery, with a fix for the encryption so a recipient's app (Chapsmart's) can actually decrypt.

**Current state (found):** the escrow protocol encrypts LOCK/VOTE/CLAIM/RESOLVE with a **custom per-recipient NIP-44 envelope** (`encryption-config.ts`, `envelope.ts`) — these are *not* standard DMs. The signer interface exposes `nip44Encrypt/Decrypt` (`escrow-client.ts:88/94`) but **no `nip04`**. So if notifications are currently riding the envelope / a NIP-44 kind-4, a generic client that expects **NIP-04** (legacy) or **NIP-17** gift-wrap can't read them — exactly Chapsmart's complaint.

**Approach:**
1. **Me › Notifications UI (`MeScreen.tsx`):** opt-in master switch + per-event toggles (new order, JOIN/reservation, LOCK, vote needed, resolved, payout). Channels: in-app and **Nostr DM (opt-in)**.
2. **Nostr DM delivery — use a standard, decryptable format:**
   - **Primary: NIP-17** gift-wrapped DMs (kind 1059, sealed kind 13, NIP-44 content). Modern standard; reuses the existing `nip44` signer methods. Supported by Damus, Amethyst, 0xchat, Nostur, etc.
   - **Optional fallback: NIP-04** (legacy kind 4) for maximum reach — requires adding `nip04Encrypt/Decrypt` to the signer interface + implementations (NIP-07 extensions and Amber both support nip04; `nostr-tools` provides it).
   - Let the user pick, and **show an in-app explainer** of which apps support which (and that NIP-17 is more private).
3. **The decryption fix:** route notification DMs through the chosen standard (NIP-17/NIP-04) with correct conversation-key derivation — never the escrow envelope. Verify round-trip against a real external client before shipping (this is the part that broke for Chapsmart).

**Tests:** encrypt→decrypt round-trip for NIP-17 and NIP-04 against `nostr-tools` as a stand-in external client; opt-in defaults to off; toggles persist.

---

## #9 — Landscape dual-pane trading (vote buttons left, chat right) · **M · low–medium risk**

**Goal:** in landscape, present a browser-like two-column trade view — actions/vote on the left, chat on the right. "Normalize" it as the default landscape layout.

**Current state (found):** **zero** orientation/landscape code in `src/` today, and the Android activity already allows rotation (`AndroidManifest.xml:20` lists `orientation|screenSize|…` in `configChanges`, with **no** `android:screenOrientation` portrait lock) — which is why rotating already "works" and just reflows. So this is a **pure web/CSS layout addition; no native changes needed.**

**Approach:**
1. Add a small `useOrientation()` hook (`matchMedia("(orientation: landscape)")` + width/height check, with a resize listener).
2. In `TradeDetail.tsx`, when landscape **and** the viewport is wide enough, render a two-column flex/grid: left = vote/action buttons + key trade state; right = `ChatPanel` at full height. Portrait layout stays exactly as-is (additive).
3. Reuse existing components untouched; only the container re-flows. Make it the default in landscape (no hidden toggle), per "normalize."

**Tests:** manual on device + a couple of widths; portrait unchanged; landscape shows both panes; rotate mid-trade doesn't drop chat state.

---

## Bonus — Globe community picker for onboarding · **L · medium risk** (the 1.3.0 headline)

**Goal:** replace the v1 list/chip picker with the cinematic "where's home?" globe — rotate Earth, tap your country, confirm. (Vision spec already in `PHILOSOPHY.md:328`.)

**Current state (found):** `ConnectScreen.tsx` uses region-filter chips (east/west/central/global) + a **static** SVG-clipped Africa PNG (`MiniGlobe`, `/icons/africa-globe-base.png`) per region. Communities are East/West/Central Africa + global (`communities/registry.ts`). **Three.js is *not* actually installed** (despite the philosophy note) — it's not in `package.json` or `node_modules`.

**Dependency decision (needs your pick before build):**

| Option | What | Cost | Recommendation |
|--------|------|------|----------------|
| **A. Three.js WebGL globe** | True 3D draggable Earth, country pick, optional live-activity dots | +~150 KB gzip; WebGL perf on low-end Android; interacts with the vite/esbuild note in `package.json` | Most "wow," matches the full vision |
| **B. 2D orthographic globe (d3-geo)** | Draggable spinning globe on canvas/SVG via a small Africa TopoJSON | +~30–50 KB; no WebGL; works everywhere | **Recommended for 1.3.0** — ~80% of the magic, ships in the window, accessible |
| **C. Animate the existing PNG/SVG** | Spin the current sprite, tappable hotspots | negligible | Cheapest; least "real globe" |

**Approach (assuming B):**
1. Add d3-geo + a trimmed Africa TopoJSON; render an orthographic projection; drag to rotate; tap a country → flag emoji + community name surface → one tap confirms → `setUserCommunitySlug()`.
2. Keep the **v1 list picker as the documented keyboard-accessible / low-bandwidth fallback** (per philosophy — globe is polish, not load-bearing).
3. Africa-first (matches the community registry) with the existing "global" fallback. Live-activity dots = nice-to-have; stub/defer unless a recent-trades-per-region feed is cheap.

**Tests:** picker selects the correct community slug; fallback list still works; no crash without WebGL (if A).

---

## How this ships (tooling #10, already built)

`scripts/ship.sh` wraps your existing two-step flow into one command — it does
**not** change `release.sh` / `release-all.sh` / `android-release.sh`, it
orchestrates them. Per release:
1. I hand over the notes file(s) named for the target version:
   `chama-v<VERSION>_release_notes` (required) and, when there's something
   user-facing, `chama-v<VERSION>_zapstore_notes`.
2. You drop them in `/tmp` and run **`npm run ship -- --minor`** (or `--patch`,
   `--major`, `--set-version X.Y.Z`).
3. ship.sh computes the target version up front, resolves both files (failing
   fast if the required one is missing), then runs exactly your flow:
   `npm version <bump> --no-git-tag-version` → `git add -A && git commit -F <release_notes> && git push origin main`
   → `npm run release:all -- --github-release --clobber --zapstore --gpg-key <key> --notes-file <release_notes> [--zapstore-notes-file <zapstore_notes>]`.

`--dry-run` prints the plan without executing. `SIGN_WITH`, `CHAMA_ZSP_BIN`,
`CHAMA_GPG_KEY`, `CHAMA_DEPLOY_KEY` pass straight through. Details: `README.md`
› "Releasing with npm run ship"; template at `scripts/release-notes-template.txt`.

---

## Open decisions before coding

1. **Globe dependency:** A (Three.js), B (d3-geo 2D, recommended), or C (animate existing)?
2. **#8 DM scheme:** NIP-17 only (modern, recommended), or NIP-17 + NIP-04 fallback (wider reach, needs nip04 added to the signer)?
3. **Versioning:** keep the Phase-1 safe fixes as one `1.3.0`, or land them as a quick `1.2.5` and reserve `1.3.0` for the feature batch?
4. **#5 image fix depth for 1.3.0:** hotfix only (size budget) now, Blossom later — confirm?
