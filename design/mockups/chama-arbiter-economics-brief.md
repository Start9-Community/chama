# Chama — Arbiter Economics Brief (premium + dispute fee)

**Status:** E0 decisions FROZEN 2026-07-12 (Jetty blessed). **E1 BUILT 2026-07-12** (uncommitted,
typecheck clean, FULL suite 3188/3188 green incl. the new ARBITER PREMIUM block, browser boot
clean). ⚠ Build deviation from this brief's step 3: the settle hook is NOT inside
`claimAndPayoutAction` — both sides pay via an App boot-sweep effect over COMPLETED trades
(mirrors the payout-reattach sweep), which covers the winner AND the fiat payer AND the
offline-at-settlement case with one mechanism. ⚠ Extra fix the build surfaced: `sortEventChain`
had to bucket PREMIUM with CHAT (no e-tag → it could win root-find over CREATE and brick replay
with MISSING_CREATE). ⏳ Jetty device pass per §Build-order step 7. E2+ not built. Post-v5.1.
**Author seat:** verifier chat. **Owner:** Jetty (release split + device pass as always).
**One-line:** turn the commitment bond from dead capital into a yield-bearing *earnings license* —
a seated **bonded** arbiter collects a small insurance premium on every settled trade in their
chama, paid as out-of-band ecash, with zero reducer/consensus change until the very last phase.

---

## Vocabulary lock (so the numbers never drift)
- **Premium** = **0.5% total** on every *settled* trade, paid to the seated arbiter. Default-ON,
  one uncheck to decline. Split **0.25% each side** (buyer + seller each pay 0.25%).
- **Dispute fee** = **1.5% extra**, paid ONLY when the arbiter actually resolves a dispute *on
  time*. Verdict-neutral. Comes off the disputed pot, capped.
- So a happy trade costs **0.5%**; a disputed one **~2%**. Claims cost 3× premiums — a sane
  insurance curve.
- Reuse the EXISTING constants in `src/arbiters/fees.ts` — do NOT redefine:
  `AMBIENT_ARBITER_FEE_BPS = 50` (0.5%), `DISPUTE_ARBITER_FEE_BPS = 150` (1.5%). Today they're a
  pure calculator wired only to tests; this brief wires them to payment.

## Frozen decisions (E0)
1. **Split:** 0.25% each side, 0.5% total. Symmetric skin; "0.5% insurance" is the one-sentence
   cost story. (Two small ecash spends per trade — free on same-fed ecash.)
2. **Dispute fee source:** taken **off the disputed pot** ("the trade pays for its own dispute"),
   NOT "the winner nets −1.5%". Avoids victim-pays-for-justice optics. **Verdict-neutral is a
   hard invariant** — the arbiter earns identically whichever way they rule. **Capped** by an
   absolute sat ceiling so a large-trade dispute fee never reads as extortionate.
3. **Bonded-only earnings:** YES. Only a FUNDED bonded seated arbiter earns; OG-fallback seats
   stay unpaid. This is the ROI answer to "why lock sats for 3 months," the #52 rule applied to
   money, and the strongest driver for real bonds in the wild.
4. **Floors:** skip on **premium note size**, not trade size — skip if the 0.25% note would be
   under ~10 sats (avoids dust-note churn; a <1,000-sat trade yields a ~2.5-sat note = skip).
5. **On-time window:** 48–72h from dispute-open to resolving vote. Late → base premium only, no
   dispute fee. Rationale: the dispute fee is a **bounty on responsiveness**, not a reward for
   holding the seat; measured from chain event timestamps (dispute-open → resolving vote), no
   subjectivity, no punishment for a slow arbiter (they keep the base premium), just no bonus.

## Architecture (why this is cheap) — validated against the tree 2026-07-12
The premium is paid as **out-of-band ecash notes delivered in-band on the trade's OWN escrow
channel**, encrypted to the arbiter's pubkey — NOT carved out of the escrow pot, and NOT via a
new global DM inbox.

- **Same fed by construction:** trade is fed-stamped; arbiter is seated from that community's
  pool. Same-fed ecash transfer always works, ~zero fee (no LN hop), any size (no dust floor).
- **`spendNotes` produces an OOB note string** (`fedimint-client.ts:106`), with a `try_cancel` /
  `tryCancelAfterSecs` horizon (#37 plumbing, `sdk-adapter.ts:1816`, `native-bridge-adapter.ts:708`)
  so unclaimed premiums **auto-refund to the payer** — an offline/vanished arbiter never strands
  sats. ⚠ Plain `spendNotes` defaults to ~1 day (SDK) / ~7 day (bridge); **opt a 7–14 day horizon
  on premium spends** so a slow mobile arbiter doesn't churn refunds.
- **Redeem rail exists:** `redeemEcash` → `/reissue-notes` (`native-bridge-adapter.ts:739`), same
  rail the pending-fundings drain exercises.
- **In-band delivery (the key refinement — REPLACES the proposal's "DM the npub"):** there is NO
  inbound kind:4 DM inbox in Chama — every subscription is scoped to the escrow band
  (`relay-manager.ts:700`), and building a global self-DM inbox + auto-redeeming arbitrary inbound
  content is both a new build AND a spam/attack surface. Instead publish a **new escrow event
  kind 38113 (PREMIUM)** in the trade's existing channel, carrying the OOB note **encrypted to the
  arbiter's pubkey** (NIP-44 via the existing `signer.nip44Encrypt` used by `notifier.ts:50`). The
  seated arbiter already subscribes to that trade's events (they're a participant) → their client
  sees the PREMIUM event, decrypts, redeems. No new subscription, no global inbox, no attack
  surface beyond that trade's participants. Escrow events are public, but the note blob is opaque
  to everyone but the arbiter, and the auto-refund horizon covers the never-shows case.
- **Zero reducer / lock-bundle / claim-math change** through E3. The escrow money path stays
  byte-identical. Kind 38113 is **non-consensus** — reducer ignores it exactly like CHAT (38108) /
  SUBSCRIBE (38111); it MUST stay out of `EVENT_KIND_TRANSITIONS`.

## Event kind 38113 (PREMIUM) — allocation
- Next free slot in the escrow protocol block (38111 SUBSCRIBE, 38112 PERIOD_RELEASE last used).
- Non-state-changing, informational (like CHAT/SUBSCRIBE). Add to `EscrowEventKind`, to
  `VALID_KINDS`, to the event-parser label map (`escrow:premium`); **do NOT** add to
  `EVENT_KIND_TRANSITIONS`. Document it in the kinds comment in `types.ts`.
- Payload (encrypted to arbiter pubkey): `{ escrowId, payerRole, amountSats, oobNotes, kind:
  "ambient" | "dispute", createdAt }`. Tagged with the escrow `d`/`e` tag so it rides the trade
  channel and the payer's pubkey `p` for provenance.

## ⚠ Naming landmine
`premiumBps` is ALREADY TAKEN — it's the CBP **volunteer bonus** (buyer→volunteer, baked into the
LOCK split; `types.ts:222`, `state-machine.ts:327`, `escrow-client.ts:556`). The arbiter premium
must use a DISTINCT name: **`arbiterPremiumBps`** / **`disputeFeeBps`**. Never reuse `premiumBps`.

---

## Phase map (staged exactly like prefer-bonded: client-default-on → CREATE-stamped → enforced)

### E0 — decisions + this brief. DONE.

### E1 — the premium, client-side default-ON (the 80% of value)
New module **`src/arbiters/arbiter-premium.ts`** (pure where possible): given a settled trade,
compute the per-side premium via `fees.ts`, apply the note-size floor, and decide payable-or-skip.
Only payable when `state.bondedArbiters?.includes(participants.arbiter)` (bonded-only, decision 3).

- **Settlement hook:** attach in `claimAndPayoutAction` (`useEscrow.ts:3457`) right after
  `completeClaim` / `runClaimAndPayout` returns `{ kind: "done" }` — the same chokepoint the payout
  journal lives at. Each trader's client `spendNotes` (7–14d horizon) → publishes a kind-38113
  PREMIUM event on the trade channel, encrypted to the arbiter.
- **Arbiter redeem:** on loading a trade where self is the seated arbiter, scan its events for a
  38113 addressed to self, decrypt, `redeemEcash`, record to the ledger. A once-per-session boot
  sweep over trades-I-arbitered (mirror the pending-payout boot sweep) picks up any missed while
  offline (before the payer's horizon lapses).
- **Earnings ledger:** new `arbiter-earnings_v1` localStorage store, cloned from
  `trade-index.ts` (user-scoped, sync, best-effort, never blocks money path): earned / pending /
  redeemed per trade.
- **Dashboard EARNINGS tile:** slot a new card between WALLET (0) and STANDING (1) in
  `DashboardScreen.tsx`: "₿N earned across M trades covered." This tile IS the recruitment ad.
- **Checkout honesty:** the "You owe KES X" headline gains the premium line at **lock time**, not
  as a settle-time surprise. Reconcile with the existing FAQ "0.5% fee" copy so total cost stays
  one sentence.
- **Decline path:** prechecked "Insurance: ₿X to your arbiter (0.25%)" in the settle flow, one
  uncheck to decline.
- **i18n:** new EN/FR/ES keys (assurance/caution vocabulary exists from the bond glossary).
- **Wash-trade note:** a self-dealing arbiter pays the premium to themselves — net zero minus
  fees. Premium farming needs real third-party volume. Fake trades can still farm ratings/liveness
  — that's #52's territory; same answer: the bond gates, ratings modulate.
- **Tests:** premium math + floor + bonded-only gate + skip-below-floor + verdict-neutral stub +
  a PREMIUM event round-trip (encrypt → publish → arbiter decrypts → redeems → ledger).

### E2 — the dispute fee, same rails
On a resolved dispute (2nd vote lands, funds move), the paying client sends 1.5% off the disputed
pot to the arbiter via the same 38113 mechanism (`kind: "dispute"`). Hard invariants:
- **Verdict-neutral:** fee identical whichever way the arbiter rules (compute from the pot, not the
  outcome).
- **On-time gated:** only fires if `resolvingVoteTs − disputeOpenTs ≤ WINDOW` (48–72h). Late →
  base premium only.
- **Capped** by an absolute sat ceiling.
- Arbiters can't initiate disputes (already true — they only break ties), so "disputes pay 3×"
  creates no perverse arbiter-side incentive.

### E3 — stamp terms into CREATE (consent, not enforcement)
Add optional **`arbiterPremiumBps` / `disputeFeeBps`** to `CreatePayload` + `EscrowState` — the
exact additive pattern `bondedArbiters` used in 2B. Both parties see + accept the insurance terms
at join; reducer STORES but doesn't enforce; old clients ignore the fields. Kills client-copy
drift and makes E4 possible.

### E4 — enforcement (its own coordinated release; rides with `BONDS_ENFORCED`)
Reducer/claim path verifies the premium moved before COMPLETED finalizes, OR the fee is carved into
the lock bundle as an arbiter tranche (the E4 endgame that touches `state-machine.ts`, the lock
builder, every replay). Only worth building once real volume proves people strip the default —
and mostly they won't: default-on-with-an-uncheck captures the honest majority, and a user hacking
their client to dodge 0.5% was never going to pay anyway.

### E5 — the distribution flywheel (parallel, mostly already built)
Chama liveness already computes from bonds; extend the score with **insured-volume**, and make
high-liveness chamas the ones `GlobeCountryPicker` features. Completes the loop:
**bond → get seated → earn premiums → your chama's signal rises → more traders route to you → you
advertise Chama to keep it rising.** You (Jetty) bonding yourself and earning like anyone else is
the ethos proof.

---

## Build order for the first session (E1 only)
1. `arbiter-premium.ts` (compute + floor + bonded-only gate) + tests.
2. Kind 38113 wiring (`types.ts` enum + VALID_KINDS + parser label; NOT in transitions).
3. Settle-hook publish (payer side) in `claimAndPayoutAction`, 7–14d horizon.
4. Arbiter redeem-on-load + boot sweep + `arbiter-earnings_v1` ledger.
5. Dashboard EARNINGS tile + settle-flow decline UI + checkout premium line.
6. i18n EN/FR/ES.
7. typecheck + suite; Jetty device pass (3-instance: bonded arbiter earns on a settled trade;
   OG-fallback earns nothing; decline works; slow arbiter → payer auto-refund; ledger + tile
   update).
