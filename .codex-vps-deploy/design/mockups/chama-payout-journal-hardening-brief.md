# CC BRIEF — Payout-journal hardening: V7 (app-death mid-pay) + V6 (stuck-confirming)

**Severity: fund-loss (double-pay) + stuck-trade.** Pre-existing, **cross-platform** gaps in the
shared v3.5.1 escrow-keyed payout journal (DECISIONS 2026-06-17). They affect browser identically and
are **not** introduced by #9 — but #9 Part 2/3 (native now actually pays) newly exposes them on native.

> **Scheduling:** V8 (the no-crash sibling) is being fixed **now in v4.0.0** (journal fail-closed).
> This brief is **V7 + V6**, the next focused leg — schedule right after v4.0.0 ships. It touches the
> shared claim path AND adds a bridge endpoint, so it deserves its own adversarial verification.

---

## V7 — app dies between bridge-commit and journal write → double-pay

**Cause (verified):** every journal write happens *after* the bridge `/pay` call:
`payInvoice` (`src/payments/claim-and-payout.ts:749`) → `markPayoutSettled` (`:754`); the inflight
record is in the catch (`recordPayoutSubmitted`, `:764`). So if the app dies (Cmd+Q, OS-kill, crash)
in the window between the bridge committing the payment and the JS writing the journal, **no record is
persisted** → on relaunch the journal is empty → seller re-taps Claim → fresh invoice → **pays twice.**
Narrow window, but Cmd+Q is a documented lifecycle and low-end Android OS-kills backgrounded apps.

**Fix — pre-send journaling + reconcile-by-escrow:**
1. **Pre-send intent record.** Before calling `payInvoice`/`/pay`, write an escrow-keyed journal
   record `{escrowId, status: "intent", ts}`. A record now exists even if the app dies mid-pay;
   the success/throw paths upgrade it to settled / submitted / cleared.
2. **Reconcile-by-escrow (bridge).** Add `escrowId` to the `/pay` request; the bridge persists an
   **op ↔ escrow** mapping for every outgoing pay. Add a lookup endpoint
   (`/pay-outcome-by-escrow?escrowId=…`) returning the terminal outcome
   (`settled|refunded|inflight|none`) for the most recent payout op of that escrow.
3. **Reconcile before re-pay.** On relaunch / before any re-pay, the orchestrator reconciles by
   **escrow id** (not just operationId, which may be lost across restart): prior payout settled →
   mark claimed, no re-pay; none/failed → safe to pay.

Closes V7: even with an empty JS journal after a crash, the bridge knows (by escrow) whether a payout
already settled, so a retry reconciles instead of re-paying.

## V6 — stuck "payout-confirming" forever

**Cause:** a payout that ends `inflight`/`confirming` relies on `awaitPayOutcome` / reattach to
resolve later; if the operationId is lost (restart) or the watch never re-emits, the trade stays
"confirming" with no path to resolve.

**Fix:** the **same reconcile-by-escrow endpoint** resolves it — a stuck-confirming trade queries by
escrow id and resolves to its true terminal outcome (settled → complete; refunded → re-payable). So
**V6 is closed as a side-effect of the V7 fix** — do them in one leg.

## Verify
- Native: kill the process right after the bridge commits the pay, before the JS write → relaunch →
  Claim **reconciles by escrow → does NOT double-pay.** (This is the brief's load-bearing test.)
- A genuinely failed / never-sent payout → retry pays **exactly once.**
- A stuck-confirming trade → resolves on view via reconcile-by-escrow.
- Shared path: browser claim flow unaffected (regression); `npm run predeploy` green; run the
  adversarial pass (fund-loss path).
- Leave uncommitted for Jetty's split.

## Notes
- Bigger than V8: touches the **shared** claim path + adds a bridge endpoint + an `escrowId` param on
  `/pay`. That's why it's its own leg, not bundled into v4.0.0.
- Pairs with V8 (v4.0.0 = fail-closed on write): V8 stops a *lost write* from causing a re-pay; V7
  ensures a *crash mid-pay* can still reconcile. Together they fully close the journal-architecture
  double-pays. Both are the "unknown ⇒ confirm, not retry" doctrine (PHILOSOPHY 2.1).
