# Chama — Stranded claim/payout RecoveryBanner (buyer-side, post-settlement) — CC brief

**Status:** diagnosis handoff (2026-07-08, verifier chat). **NOT a #37 regression** — a distinct
claim/payout strand that #37 (native-lock crash-safety) was never in scope for. Money-path; **CC owns**.
The verifier did **not** edit any code for this — read-only diagnosis with file:line evidence below.

## Symptom (Jetty's device pass, FRESH 07-08 build ⇒ #37 running)
The BUYER (:3002) shows the amber **"TRADE NEEDS ATTENTION / Recover ₿2,447"** RecoveryBanner on a
persistent ~**₿2,462** wallet balance — and it PERSISTS across a sidecar/tauri rebuild that includes #37.
The SELLER (:3001) side shows the same trade **DONE/SETTLED**. The banner's trade card names a **₿1,570
Buyer** trade while offering to recover **₿2,462** (amount mismatch / mis-attribution).

## Root cause — this is a CLAIM/PAYOUT strand, not a native-LOCK strand
1. **Banner firing** — `shouldShowRecoveryBanner` (`src/ui/decisions.ts:806-815`) fires when: not sim,
   balance ≥ material threshold (`hasMainSurfaceRecoveryBalance`, `:808`), **`hasAnyActiveEscrow===false`**
   (`:809-810`), not `fundingInProgress`, not `claimPayoutInProgress`, not `hasPendingNativeLock`. The call
   site (`src/ui/App.tsx:1075-1086`) passes `hasAnyActiveEscrow: committedMsats > 0`, and `committedMsats`
   (`App.tsx:1000-1001` → `decisions.ts:641`) sums **only LOCKED/APPROVED** escrows for buyer/seller —
   **CLAIMED and COMPLETED are excluded**. So the instant a trade settles + is claimed, its leftover
   in-wallet balance stops being "explained" and the generic banner fires.
2. **#37 can't suppress it** — the ONLY pending-native-lock stash writers are LOCK-path
   (`escrow-bridge.ts:433/450/468` intent→spent→publish-attempted; `useEscrow.ts:3144` funding intent),
   and BOTH are gated off in sim/testnet (`nativeLockGuardOn()`). **No claim/settlement path ever writes a
   native-lock entry**, so `summarizeNativeLocksForUi` returns `suppressRecovery=false` for any claim
   residue. #37's `hasPendingNativeLock` was never going to catch this.
3. **The buyer never locks in Exchange** — in P2P Exchange the SELLER locks sats; the BUYER pays fiat and
   **CLAIMS** the sats. The buyer never runs `lockAndPublish`, so a buyer-side stranded balance is a CLAIM
   residue by construction. The claim flow (`src/payments/claim-and-payout.ts:48-60`) is
   redeem → `paying-invoice` → `payout-confirming` → `done`; a stalled/failed **outbound-LN payout** leaves
   the already-claimed ecash sitting in the wallet = the stranded balance. The SELLER correctly shows DONE
   because **settlement completed** — only the buyer's payout leg stranded.

## The two real bugs
- **(A) The payout leg strands silently — no claim-side reconcile.** A COMPLETED trade whose outbound
  payout never confirmed leaves the wallet holding claimed ecash, and nothing distinguishes "a payout to
  finish" from "genuinely unexplained stranded funds." It falls through to the generic red RecoveryBanner
  (which reads as alarming/harmful). This is the claim-side analog of #37's `PendingLockCard`. Owning
  surfaces already exist to build on: the `payout-confirming` state in `claim-and-payout.ts`,
  `markUnresolvedCredit` / pending-redemptions (`escrow-bridge.ts:871-876`), and the existing
  **claim-credit-reconcile brief**.
- **(B) Mis-attribution.** Recover amount = the FULL wallet balance `fedimint.balanceMsats` (₿2,462,
  `App.tsx:2691`); the card identity = the SINGLE most-recent CLAIM the user signed
  (`identifyStrandedEcashSource`, `decisions.ts:843-853`; role reads BUYER because
  `participants.buyer===userPubkey`, `:859-861`). When the aggregate balance (this claim + earlier residue)
  exceeds any one trade, the card **under-labels** — shows ₿1,570 while sweeping ₿2,462.

## Recommended fix (CC — money-path)
1. **Reconcile completed claims.** On boot / on balance-settle, if a claimed trade reached COMPLETED but
   its payout never confirmed (payout-journal shows `submitted`-not-confirmed, or pending-redemptions has an
   unresolved credit), treat the matching in-wallet balance as **"finish your payout"** — resume the
   outbound payout (or a calm "finish payout" CTA), NOT the generic red alarm. Mirror the shape of #37's
   PendingLockCard, on the claim side.
2. **Honest banner when it IS residue.** If the balance genuinely is unexplained residue, either aggregate
   the attribution (sum ALL unresolved claims/payouts, not just the most recent) or drop the specific trade
   card and say "residual balance." Never show a ₿1,570 trade card while sweeping ₿2,462.
3. Lands with **payout-journal V6/V7** (`design/mockups/chama-payout-journal-hardening-brief.md`) + the
   **claim-credit-reconcile brief** — same subsystem.

## Safety (important context, not urgency)
Recover is **SAFE** on this specific balance: it's the buyer's own claimed signet ecash, both sides settled,
**no live escrow backs it** — draining to LN/on-chain simply completes the stalled payout and clears the
banner (balance drops below `hasMainSurfaceRecoveryBalance`, `decisions.ts:808`). This is the **opposite** of
the #37 harmful case (which advised abandoning a LIVE lock). So this is a UX + reconcile-correctness fix, not
a fund-loss risk.

## On-device disambiguation (confirm the class before/while fixing)
- `chama_pending_native_locks_v1` — expect **EMPTY** (confirms it is NOT a #37 lock strand).
- `chama_payout_journal*` — expect a `submitted`/stuck-not-confirmed record (confirms the payout strand).
- `chama_pending_redemptions*` / unresolved-credit — possibly present.
- Trade status each side: **seller COMPLETED/SETTLED**, **buyer CLAIMED/COMPLETED with balance retained**.
