# CC BRIEF — Claim "credit unconfirmed" over-alarm: balance-reconcile + calm split

**Severity: pre-launch UX (fund-SAFE, not a money bug).** A *successful* claim currently ends in a
glowing red "CLAIM NEEDS ATTENTION" banner — it fired on both parties in the 3-instance shot (562 and
99), and on native it's likely common. Crying wolf on a benign outcome trains users to ignore the
alert that *does* matter.

## Verified root cause
- `markUnresolvedCredit` is called **only** when `redeemCode === "ALREADY_SPENT_UNCONFIRMED"`
  (`src/fedimint/escrow-bridge.ts:677`; also the boot-drain path `pending-redemptions.ts:344`). The
  mint **confirmed** the released note is already consumed; Chama just has no signal that *this* wallet
  was the one credited.
- Stored as `stranded: "unresolved-credit"` (`pending-redemptions.ts:115`), shares poison-skip
  semantics (permanently skipped by future drains — retrying a spent note can't change anything); the
  entry stays exportable for forensics.
- Surfaced in `MeScreen.tsx:256-266` with the **same loud red "save the bearer note" treatment** as a
  genuinely-live un-redeemed note (`App.tsx:1805` export copy: "Save it anyway…").
- ⇒ The note is **DEAD (mint-confirmed spent)**: no double-spend is possible (re-presenting a spent
  note just fails), and there is nothing live to "save." The loud "save the note NOW" alarm over-states
  a benign, common result.

## Fix — reconcile against balance, then split by outcome (scope: `unresolved-credit` ONLY)
1. **Balance-reconcile.** On surfacing the `unresolved-credit` entry (and/or right after claim, where
   `balanceAfterClaim` already exists in `claim-and-payout.ts`), compare wallet balance to the entry
   amount (try once + a short retry for eventual consistency):
   - **Balance covers it → auto-resolve SILENTLY.** Archive the entry, no banner. Common, benign case —
     the sats landed; a successful trade ends clean.
   - **Balance does NOT cover it → calm, honest, dismissible alert** (not loud red): e.g. "฿{amt} may
     have already been claimed on another device — check there. Saved as backup." Keep the note
     exportable; two-tap dismiss = archive.
2. **Guardrail — scope strictly.** The calm/auto-resolve path applies ONLY to
   `stranded === "unresolved-credit"`. Keep the existing LOUD red for `retries-exhausted` and
   `poisoned` — those notes may still be **live** money (un-redeemed), where "save the bearer note" is
   correct. Do not let the downgrade leak into a potentially-live note.
3. **Archive, don't delete.** Resolve/dismiss moves the entry out of the stranded/alarm list but KEEPS
   the bearer-note string (it already "stays exportable for forensics"). Zero fund-loss risk; preserves
   the recovery path the copy promises. (The slim "claimed elsewhere = another device" edge is exactly
   why we keep the export + the calm alert when balance can't confirm.)

## Why this beats a blanket calm-dismiss
Balance-reconcile separates "definitely fine" (balance confirms → silent) from the genuinely-ambiguous
"not credited here" sliver (→ calm alert). It honors **"unknown ⇒ verify"** without crying wolf, and
auto-clears the common case entirely — the best UX.

## Verify
- Normal claim where the credit landed → **no red banner** (auto-resolved silently after balance
  confirms), both seller + buyer.
- Simulated "already-spent, balance does NOT include it" → calm dismissible alert (not loud red), note
  still exportable, two-tap dismiss archives it.
- A genuinely-live un-redeemed note (`retries-exhausted`) → STILL loud red "save the note" (unchanged).
- No double-spend path anywhere (spent notes reject on re-present — unchanged).
- `npm run predeploy` green. Leave uncommitted for Jetty's split.

## Notes
- Fund-SAFE refactor: the note is mint-confirmed spent, so nothing here can double-spend or lose sats.
  This is purely "stop over-alarming a benign, common outcome, and auto-resolve it."
- Same doctrine as the payout/relay guards: the safety net is correct; it just over-fired on the common
  case (PHILOSOPHY 2.1 — "no sats stranded" stays; don't cry wolf).
