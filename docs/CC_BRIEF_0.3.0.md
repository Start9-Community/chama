# Code-Claude brief: v0.3.0 — Atomic Lifecycle

## Why this release exists

v0.2.0 shipped federation-follows-listing — the convergence release for
community/federation identity. During smoke review on production, a real
gap surfaced: **FundWalletModal is still in primary user paths**
(recovery banner withdraw, destroy modal withdraw, hidden as a settings
power-tool). It contradicts Pillar 2.1 (Option B), which says ecash
exists only during LOCK→CLAIM and the user never holds an arbitrary
balance between trades.

PHILOSOPHY.md has carried this principle since v0.1.85. The UI hasn't
operationalized it. v0.3.0 closes the gap.

The release is partly removal work (taking FundWalletModal off main
paths), partly architectural (rebuilding the listing-tap → exact-amount
funding flow), and partly UX (the LNURL-first claim hierarchy
operationalizes Pillar 2.7 the same way item 6 of v0.2.0 operationalized
Pillar 2.1 the first time).

This brief also folds in **four v0.2.1 catches from the v0.2.0 smoke
test**, since v0.3.0 rewrites the surfaces those fixes touch. Doing them
separately would mean re-touching the same files in a v0.2.1 micro
release a week later.

## Status anchor

- v0.2.0 SHIPPED (commit `bf734cb`, tag `v0.2.0`). 489/489 tests passing.
- main is at `1566253` (release.sh patch) + `4987b27` (BACKLOG +
  DECISIONS docs commit). Verify your start point matches.
- BACKLOG.md and DECISIONS.md are now living documents at repo root.
  Reference them as the canonical record of what's planned and why.

## Things that already work (do NOT break)

- Federation-follows-listing (listing-tap silent re-init, two-section
  Browse, State A/B detail subtitles). v0.3.0 will *enhance* these
  surfaces; preserve their semantics.
- Recovery banner gate logic (`balance > 0 && !hasActiveBuyerSellerCommitment`
  → banner replaces Browse + Create). v0.3.0 changes the *copy* and the
  *button hierarchy*, not the gate.
- DestroyEcashConfirmModal three-button structure with post-withdraw
  auto-switch. v0.3.0 will simplify this — see item 6 below.
- Active-trade pill, one-trade-at-a-time gating, arbiter warnings,
  three-step Create wizard, save-draft per-vertical, kind:0 toggle.
  All v0.2.0 surfaces stay.
- Atomic LOCK protocol, NIP-44 3-recipient envelope, federation health
  probe, saved payment handles with privacy gates.
- 489/489 tests. If any pre-existing test breaks during your work, stop
  and surface to Jetty. The protocol layer is sacred.

## Scope — eight items, one PR

This is one coherent release. All eight items ship together. No
incremental patches.

---

### Item 1 — Listing-tap → exact-amount BOLT11 invoice (atomic funding)

**The headline change.** Today, funding a trade requires two surfaces:
the user opens FundWalletModal, generates an arbitrary-amount invoice,
pays it, then taps Fund on the listing detail to LOCK from their loaded
balance. v0.3.0 collapses this: tap Fund on a listing, get a BOLT11
invoice for exactly the trade amount, pay it from any external Lightning
wallet, ecash mints into a transient state that immediately becomes the
LOCK. The user never sees an intermediate "you have N sats in your
Chama" balance.

**Surface design:**

1. User taps a listing → State A or State B detail screen renders (per
   v0.2.0 federation-follows-listing).
2. User taps `Fund trade · X sats` CTA → new `AtomicFundingModal`
   replaces the existing FundWalletModal-based flow.
3. AtomicFundingModal generates a BOLT11 invoice for exactly the trade
   amount, plus a small mint-margin (~10 sats? to cover Fedimint
   issuance edge cases — needs verification with Fedimint internals).
4. Modal renders: invoice QR + copyable BOLT11 text, exact amount
   prominently displayed, expiration countdown (10 min), "Waiting for
   payment..." pulse indicator.
5. The same balance-watcher pattern from v0.1.52 detects payment landing.
   On detection: modal flips to a brief success state, then immediately
   chains into LOCK via `lockAndPublishAction`. State machine moves
   CREATED → LOCKED in one perceived motion.
6. Modal auto-closes; user is now on the LOCKED trade detail screen.

**State management:**

- New action in `useEscrow`: `fundAndLock(escrowId, savedHandleId?)`.
  Wraps the existing `createFundingInvoice` + balance-watcher + `lockAndPublish`
  sequence into one composed flow. Exposes a `phase` callback so the
  modal can render `awaiting-payment | mint-confirming | locking | done`.
- Existing `lockAndPublish` action stays (still callable for the rare
  edge case where ecash is already present — Sandbox-mode testing).
- `createFundingInvoice` stays. AtomicFundingModal calls it directly
  with the trade amount.

**Failure modes:**

- Invoice expires unpaid → modal shows "Generate new invoice" CTA;
  no state change, listing still in CREATED state.
- Payment lands but mint fails → balance-watcher times out (60s after
  payment detection); modal surfaces "Mint is taking longer than
  expected" + "Try LOCK now" + "Cancel" buttons. The cancel path
  returns the user to the listing detail; balance is now stranded
  and recovery banner will fire on next reload (which is the failure-
  mode-only surface per item 7).
- LOCK fails post-mint → toast surfaces error; existing recovery banner
  catches the orphan balance on next visit.

**What the user never sees:** an intermediate "you have N sats in your
Chama" surface. Pure Option B.

**Tests to add:**
- `fundAndLock dispatches createFundingInvoice → balance watcher → lockAndPublish in sequence`
- `fundAndLock invoice expiry leaves trade in CREATED state with no orphan balance`
- `fundAndLock mint timeout surfaces try-LOCK retry path`
- `fundAndLock LOCK failure leaves orphan balance for recovery banner`

---

### Item 2 — LNURL-first claim hierarchy (Pillar 2.7 operationalized)

**Three-tier surface at claim time, replacing today's "claim then
withdraw" two-step.**

When a winner reaches the claim moment (status = APPROVED), they
currently tap Claim, ecash redeems into their Chama balance, and they
have to separately withdraw via FundWalletModal-Send-LN. v0.3.0
collapses this: the user provides a destination at claim time, claim
+ redeem + outbound Lightning payment happens in one flow.

**The destination input has three tiers:**

**Tier 1 — Saved destinations (primary affordance).** If the user has
saved Lightning Addresses or LNURLs in their handles list (from prior
trades or explicit settings adds), render them as a list of one-tap
rows at the top of the claim modal:

```
┌─────────────────────────────────────────────┐
│  ⚡  jetty@phoenix.app          [default]   │ ← tap to claim
│  ⚡  jetty@strike.me                         │
└─────────────────────────────────────────────┘
```

The "default" badge is on the most-recently-used handle. Tapping any
row dispatches the claim flow with that destination. No further input
required.

**Tier 2 — Lightning Address input (secondary affordance, with
auto-save).** Below the saved-destinations list (or as the primary
surface if no saved destinations exist):

```
┌─────────────────────────────────────────────┐
│  Send to:  [you@yourwallet.app           ]  │
│  ☑ Save for next time                        │
│                                              │
│  [Claim 38,500 sats →]                       │
└─────────────────────────────────────────────┘
```

The "Save for next time" toggle defaults to ON. On successful claim,
the address is saved to the user's handles list and becomes a Tier 1
row on next trade. The toggle itself is the Pillar 2.7 educational
moment — the user reads "save for next time" and understands implicitly
that future trades will be faster. No tutorial required.

**Tier 3 — BOLT11 paste (tertiary, behind Advanced disclosure).** A
small "More options" expander reveals a BOLT11 invoice paste field for
power users and BOLT11-only wallets:

```
▾ More options
┌─────────────────────────────────────────────┐
│  Paste invoice:  [lnbc...                ]  │
│  [Claim with invoice →]                      │
└─────────────────────────────────────────────┘
```

**LNURL resolution flow:**
- User enters Lightning Address `jetty@phoenix.app`.
- On Claim tap: resolve `https://phoenix.app/.well-known/lnurlp/jetty`
  → fetch LNURL-pay metadata → request invoice for the exact claim
  amount → receive BOLT11 → pass through to Lightning send.
- LNURL resolution happens in a new module `src/payments/lnurl.ts`.
- Failures (DNS, 404, malformed metadata, amount-out-of-range) surface
  as user-readable errors with retry affordance.

**State management:**
- Existing `claimAndRedeemAction` in `useEscrow` becomes a private
  step. New action: `claimAndPayout(escrowId, destination)` wraps
  decrypt-shares → SSS-combine → `redeemEcash` → outbound LN payment
  to the resolved BOLT11.
- Saved-handles list extended with `lightningAddress` field on
  existing handle records (currently fiat-rail-typed; LN is a new
  rail).
- Auto-save flow: on successful claim, if "Save for next time" was on,
  call `addSavedHandle({ rail: "lightning", value: destination, ... })`.
  Idempotent — if the address is already saved, just bump its `lastUsedAt`.

**Tests to add:**
- `LNURL resolver fetches metadata and returns BOLT11 for exact amount`
- `LNURL resolver surfaces typed errors for DNS / 404 / amount-out-of-range`
- `claimAndPayout dispatches redeem → LN-send in sequence`
- `claimAndPayout auto-saves destination when toggle is ON and not already saved`
- `claimAndPayout does not auto-save when toggle is OFF`
- `Saved handles list renders with most-recent-used as default badge`

---

### Item 3 — Inverted hierarchy at QR-IN (fund-time destinations)

The same three-tier hierarchy applies symmetrically at funding time
when the user is providing destinations for fund-time flows. The
asymmetry is real (Lightning Addresses are receive-only, BOLT11
invoices the user pastes for funding come from Chama itself), but the
affordance ordering principle holds:

**At funding time, the user is on the receiving side** — they're
receiving the BOLT11 invoice that Chama generated. Their job is to
copy it / scan it / pay it from their external wallet. This isn't a
destination-input surface; it's an invoice-display surface.

**However, when the user is acting as a sender** in non-trade contexts
(Sandbox-mode FundWalletModal Send-LN, manual withdrawal flows
post-v0.3.0), the same hierarchy applies. Bake it into a reusable
component:

- New component: `src/ui/components/DestinationPicker.tsx` — renders
  the three-tier surface (Tier 1 saved list, Tier 2 input + toggle,
  Tier 3 advanced paste) and emits a resolved BOLT11 + a
  `shouldSaveAfter: boolean` flag. Consumed by claim flow (item 2),
  Sandbox Send-LN flow, and any future destination-input surface.

This component becomes the canonical Chama affordance for "user
provides a destination." Reusable, testable, single source of truth.

**Tests:**
- Covered transitively by item 2's test set; no separate test surface.

---

### Item 4 — FundWalletModal → Sandbox-only

Move the existing FundWalletModal out of all primary user paths. It
stays accessible via Settings → Advanced → Sandbox mode for power
users testing the app, but production users never see it.

**Paths that currently use FundWalletModal:**
1. Top-bar Wallet button (existing) → REMOVED. The top-bar surface
   becomes a status indicator only ("Active funds in escrow: N sats"
   when in a trade, "Chama: ready" otherwise).
2. Recovery banner withdraw button (v0.2.0) → REPLACED by direct
   DestinationPicker flow (item 5 below).
3. DestroyEcashConfirmModal "Withdraw via Lightning" (v0.2.0) →
   REPLACED by direct DestinationPicker flow (item 6 below).
4. Sandbox-mode → REMAINS. Power users keep the arbitrary-funding
   surface for testing federation switches, exercising mint flows,
   etc.

**The Wallet/Chama top-bar component:**
- Renders federation status (existing).
- When `balanceMsats > 0 && hasActiveBuyerSellerCommitment` → label
  reads "Active funds in escrow: N sats" with the existing accent pill
  styling.
- When `balanceMsats > 0 && !hasActiveBuyerSellerCommitment` → label
  reads "N sats stranded — recover" and tapping opens the recovery
  banner directly. (This is the "you have a failure-mode balance"
  surface; recovery banner is the action surface.)
- When `balanceMsats === 0` → label reads "Chama: ready" or similar
  neutral state.

The top-bar is a *signal* surface, not an *action* surface. Actions
live on the listing detail (Fund) and trade detail (Claim).

**Tests:**
- `Top-bar renders correct label for in-trade / stranded / ready states`
- `Top-bar tap on stranded state opens recovery banner`

---

### Item 5 — Recovery banner becomes failure-mode-only

The recovery banner shipped in v0.2.0 was conceived as a generic
"you have a balance, here's how to use it" surface. In Pure Option B,
balance > 0 between trades is *always* a failure state. Update the
banner copy and the action hierarchy to match:

**Old copy (v0.2.0):**
> CONTINUE YOUR TRADE
> You have unspent sats from a previous trade
> Withdraw them to your Lightning wallet to keep them safe — Chama
> is non-custodial and ecash is bearer cash.
> [Finish trade · withdraw N sats]

**New copy (v0.3.0):**
> ⚠ TRADE NEEDS ATTENTION
> Your last trade didn't finish cleanly
> N sats are still in escrow on your local Chama. Send them to your
> Lightning wallet to recover and free up Chama for your next trade.
> [Recover N sats →]

**Action hierarchy on the banner:**
- Primary CTA → opens the DestinationPicker (item 3 component) with
  the stranded amount pre-filled.
- After successful payout, the banner clears, balance is zero, Browse
  + Create are unblocked.

**Counterparty resolution:** the existing v0.2.0 logic (resolve via
most recent CLAIM event the user signed, fall back to "Recover your
sats from a previous trade") stays. The banner just renders that info
in the new failure-framed copy.

**Tests:**
- `Recovery banner renders with failure-mode copy when balance > 0 && no active commitment`
- `Recovery banner DestinationPicker dispatch drains balance and clears banner`

---

### Item 6 — DestroyEcashConfirmModal: simplify to two buttons

v0.2.0 shipped the destroy modal with three buttons (Withdraw via
Lightning / Cancel / Switch and destroy). The "Withdraw via Lightning"
button now becomes the only sane primary action — under Pure Option B,
balance > 0 means the user is in a failure state, and the right thing
to do is always recover the sats first.

**v0.3.0 destroy modal: two buttons.**

```
⚠ FUNDS AT RISK

Switching to Kenya · Afribit · KES will move you to a different
Chama. Your local 50 sats need to be recovered to your Lightning
wallet first.

[⚡ Recover 50 sats and switch →]   ← primary (orange)
[Cancel — keep my Chama]             ← secondary (neutral)
```

The "Switch and destroy" tertiary button is REMOVED. There's no
legitimate user flow under Pure Option B where destroying sats is
correct — if the user truly wants to nuke their Chama (Sandbox testing),
they go through Settings → Advanced → Sandbox → Reset OPFS, which is
the explicit power-user path.

**Behavior on primary CTA:**
1. Open DestinationPicker (item 3 component) with the balance pre-filled.
2. On successful payout (balance reaches zero), auto-dispatch the
   originally-attempted federation switch.
3. If user cancels the DestinationPicker before draining: return to the
   destroy modal, no state change, sats preserved.

This is mechanically the same as v0.2.0's three-button flow, just with
the unsafe path removed.

**Migration:**
- Existing `pendingSwitchAfterWithdraw` state machine in App.tsx stays.
- Existing `onWithdraw` callback is now the only non-cancel path.
- Remove `onConfirm` (the destroy path) entirely from the modal.

**Tests:**
- `DestroyEcashConfirmModal renders with two buttons under v0.3.0`
- `DestroyEcashConfirmModal primary CTA opens DestinationPicker`
- `Cancel from DestinationPicker returns to modal without switching`
- `Successful payout auto-dispatches the queued switch`

---

### Item 7 — State B copy tightening (v0.2.0 smoke catches)

The v0.2.0 State B detail screen subtitle and callout were written too
educationally and still use "federation" instead of "Chama" (the PR A
sweep was scoped before this copy existed). Tighten:

**Old (v0.2.0):**
> Subtitle: "Running on BLF · we switched you in for this trade"
> Callout: "Your wallet was on Senegal · CFA. Since this listing is
> on BLF and your balance was 0 sats, we switched automatically. No
> funds moved on Lightning — fresh wallet on BLF for this trade."

**New (v0.3.0):**
> Subtitle: "Running on BLF · switched in for this trade"
> Callout (one sentence, dismissible): "Your Chama switched
> automatically — no funds at risk."

The educational essay (the "your wallet was on... since this listing
is on... no funds moved on Lightning..." paragraph) moves to a
**one-time info card per pubkey**. Same pattern as the first-publish
honesty card from v0.2.0:

- localStorage flag: `chama_state_b_explained_<pubkey>`.
- First time State B fires for a given pubkey, render the full
  educational paragraph in a dismissible card above the State B detail.
- Once dismissed, only the tightened subtitle + callout show on
  subsequent State B encounters.
- Pillar 2.7: educate at every opportunity, but only the *first*
  opportunity. Don't lecture returning users.

**Tests:**
- `State B subtitle renders new tightened copy`
- `State B callout renders one-sentence reassurance`
- `One-time info card renders for first State B per pubkey, hides after dismiss`

---

### Item 8 — Trinity Ring participant order + arbiter warning copy
### tightening (v0.2.0 smoke catches)

**Participant order on TradeDetail: B / A / S.**

Currently TradeDetail renders participants in the order B / S / A
(buyer-purple-left, seller-orange-middle, arbiter-teal-right). The
Trinity Ring brand mark places the arbiter at the apex (12 o'clock) and
buyer/seller flanking below. The TradeDetail rendering should mirror
this — the arbiter is the structural center, not a third-party
afterthought.

Update the participant rendering to **B / A / S** (buyer-purple-left,
arbiter-teal-middle, seller-orange-right). This is a visual tweak in
TradeDetail.tsx; no protocol or state-machine implications.

**Hard arbiter warning copy tightening.**

Current text (v0.2.0):
> ⚠️ A trade you're arbiting needs your vote.
> {npub-A} and {npub-B} disagreed on the outcome of their trade.
> Your decision determines where their sats go. Strongly recommend
> resolving their trade before starting your own — splitting attention
> here can cost someone real money.

Tightened (v0.3.0):
> ⚠️ A trade you're arbiting needs your vote.
> {npub-A} and {npub-B} disagreed on their trade.
> Splitting your attention now could cost someone their sats.
> Resolve theirs first.

**Tests:**
- No new tests; visual + copy changes only.

---

## Items intentionally out of scope (not v0.3.0)

- **EcashProvider interface.** Filed in BACKLOG.md under v0.3.0 but
  deferred — designing the abstraction without a second provider in
  hand risks over-engineering. v1.5+ work, when Cashu becomes a
  concrete need.
- **Auto-sweep CTA at QR-OUT.** Filed in BACKLOG.md; v1.5+ once we
  observe how often orphans accumulate in real production usage.
- **chama.community Lightning Address service (v0.3.1).** Separate
  release after v0.3.0 stabilizes.
- **Menu primitive (v0.4.0).** Separate release after v0.3.1.
- **Recovery banner withdraw-failed UX (v0.2.1 catch).** Item 5 above
  *replaces* the recovery banner withdraw flow with DestinationPicker,
  which has its own typed error handling baked in. The v0.2.1 backlog
  item is structurally subsumed.
- **kind:0 fetcher for displayCounterpartyName.** Separate v0.2.1+ work.
- **Subscription mode reveal.** v0.2.1+ work, pending real ratings data.
- **Soften v0.1.74 seed-safety error red-on-refresh.** v0.2.1+ work,
  not in v0.3.0 surfaces.
- **First-publish honesty card opt-out.** v0.2.1+ polish.
- **Multi-relay loadEscrow over-eager pruning.** Investigation queue.

## Architectural notes

**The DestinationPicker (item 3) is the load-bearing piece.** It's the
single component that operationalizes Pillar 2.7's claim-time UX, gets
reused by recovery banner (item 5) and destroy modal (item 6), and
becomes the canonical "user provides a destination" affordance going
forward. Build it well, test it thoroughly, document its API in the
component file. Future surfaces (NWC adapter in v1.5, sovereign LN
address withdrawal in v0.3.1) will plug into the same contract.

**The fundAndLock action (item 1) is the other load-bearing piece.**
It's the new atomic flow that operationalizes Pillar 2.1 Option B in
the UI. Same care: well-tested, well-documented, phase callbacks
exposed cleanly so the modal can render granular states.

**FundWalletModal lives.** Don't delete it. It still serves Sandbox
mode, where it's the right tool for power-user testing. Just remove
all production code paths that reach it.

## Patcher discipline reminders

- `assert_unique` on every anchor before patching.
- Dry-run against uploaded copies before touching real files.
- Idempotency guards required.
- Do NOT edit `package.json` `version` field. Do NOT run `npm version`.
  release.sh handles version bumping at deploy. Leave package.json at
  whatever main is currently at.
- Commit message references the BACKLOG.md items addressed.
- Final stage to `/tmp/chama-v0.3.0-commit.txt` for review. No commit,
  push, tag, or deploy from CC.

## Test target

v0.2.0 baseline: 489/489.

Estimated v0.3.0 surface adds:
- Item 1 (fundAndLock + AtomicFundingModal): ~8-10 tests
- Item 2 (LNURL resolver + claimAndPayout + auto-save): ~10-12 tests
- Item 3 (DestinationPicker): ~6-8 tests (mostly covered by item 2 + 5 + 6)
- Item 4 (top-bar state rendering): ~3-4 tests
- Item 5 (recovery banner failure-mode copy): ~2-3 tests
- Item 6 (destroy modal two-button): ~3-4 tests
- Item 7 (State B copy + one-time info card): ~3 tests
- Item 8 (participant order, copy tweak): 0-1 tests

**Net target: ~35-45 new tests** (489 → ~525-535).

## What "done" looks like

After v0.3.0 ships:

- A user taps a Bill Pay listing for 50 sats, scans the BOLT11 invoice
  with Phoenix, pays it, watches the trade lock in real time. No
  intermediate "fund your wallet" step.
- The arbiter votes. The buyer wins.
- The buyer types `jetty@phoenix.app` into the claim input, taps
  "Save for next time" (already on by default), taps Claim. Sats land
  in their Phoenix wallet. Their next claim shows `jetty@phoenix.app`
  as a tappable saved row.
- At no point did the user see a balance, a wallet, or a
  fund-then-trade two-step. Pure QR-IN → escrow → QR-OUT.
- The Chama header shows `Chama: ready`. They go back to Browse and
  the next trade is one tap away.

That's the demo. That's what gets the chama.community landing page
written. That's what Adopting Bitcoin Nairobi sees in June.

## Open question for Jetty before CC starts

**Q1 — AtomicFundingModal expiration window.** Lightning invoices
default to 1-hour expiry; the v0.1.52 receive-confirmation flow used a
10-minute display countdown. For trade funding, what's the right
window? 10 minutes feels right for "user is actively trying to fund a
trade right now," but if the seller's listing was discovered 30 minutes
ago and the user is just now tapping Fund, the BOLT11 issued just-in-
time has fresh life. **Suggested: 15 minutes.** Long enough to scan +
walk to a different room + open Phoenix + paste, short enough that
abandoned-mid-flow invoices clear themselves quickly.

**Q2 — LNURL fallback when resolution fails.** If `jetty@phoenix.app`
fails to resolve (DNS down, server 500, malformed metadata), should the
claim modal:
  - (a) Surface the error and require user to try a different
        destination (current proposal)?
  - (b) Auto-fall-back to BOLT11-paste mode with the user's typed
        Lightning Address pre-filled in a "paste manually" notice?
  - (c) Retry with backoff before surfacing error?

  Suggested: (a). Errors are educational; falling back silently teaches
  users that LN Addresses are unreliable when they're often not.

**Q3 — Auto-save default state.** Toggle defaults ON per the brief.
Edge case: user has 5+ saved Lightning addresses and the "Save for
next time" toggle would clutter the list. Should there be a soft cap
(e.g., 10 saved) past which the toggle defaults OFF? Or just let the
list grow and lean on the most-recent-used "default" badge to keep the
list usable?

  Suggested: no cap, just sort by most-recent-used. If the list ever
  grows unwieldy, that's a v0.3.x polish item.

**Q4 — Top-bar component name.** Currently `FedimintBar`. Should this
rename in v0.3.0 to `ChamaBar` to match the broader Federation→Chama
language sweep? Code-identifier-only change; no UI implication.

  Suggested: yes. Rename in v0.3.0 since you're touching the file
  anyway for item 4. Keeps the codebase honest with the user-facing
  language.

Confirm these four answers and I'll come back with a phased plan
(same shape as v0.2.0 PR B). Standing by.
