// ══════════════════════════════════════════════════════════════════════════
// Chama — Balance recovery orchestrator (v0.3.0 Phase 4)
// ══════════════════════════════════════════════════════════════════════════
//
// User-controlled drain of an existing ecash balance to a Lightning
// destination. Used by:
//   - RecoveryBanner (Phase 4): user has stranded sats from a prior
//     trade that didn't complete cleanly; banner offers Recover.
//   - DestroyEcashConfirmModal (Phase 4): user attempted a federation
//     switch with non-zero balance; modal forces the recover-first
//     path before the switch can happen.
//
// Distinct from runClaimAndPayout: there's no claim phase here — the
// balance is already in the user's wallet at the time this orchestrator
// runs. We just send it out via Lightning.
//
// Optional handle save mirrors Phase 3's auto-save semantics: success
// + saveAfter + addressUsed → bump the saved-handle list. Failures
// here are cosmetic (the payout already succeeded).

import { markSatsTracesDrained, recordSatsTrace } from "./sats-trace.js";

export type RecoveryPayoutPhase =
  | { kind: "paying-invoice" }
  | { kind: "payout-confirming"; error?: string }
  | { kind: "done" }
  | { kind: "payout-failed"; error: string };

export type RecoveryPayoutTerminal =
  | { kind: "done" }
  /** R3-1: the payout was submitted but settlement is unconfirmed — RETRY must
   *  NOT re-pay (the journal re-attaches to operationId). Same as the claim
   *  path's payout-confirming. */
  | { kind: "payout-confirming"; error?: string }
  | { kind: "payout-failed"; error: string };

/** Reassurance copy for the recovery payout-confirming terminal — never
 *  invites a re-pay (that's the double-send this guards against). */
export const RECOVERY_CONFIRMING_COPY =
  "Your payout was sent and is confirming. Don't retry — check your destination wallet. Chama finishes this once it confirms.";

export interface RunRecoveryPayoutOpts {
  /** BOLT11 invoice resolved by DestinationPicker for the user's
   *  destination (Tier 1/2 LN-address-resolved or Tier 3 paste). */
  bolt11: string;
  /** Whether to call addOrTouchLightningHandle on success. */
  saveAfter: boolean;
  /** Address to save (if saveAfter). Unset for Tier 3 paste. */
  addressUsed?: string;
  /** Bound to bridge.payInvoice. Resolves with the durable LN-pay operationId;
   *  throws a coded error (LN_PAY_INFLIGHT / LN_PAY_REFUNDED / SUBMIT_FAILED)
   *  on failure — same contract as runClaimAndPayout's payInvoice. */
  payInvoice: (bolt11: string) => Promise<string | undefined | void>;
  /** Optional balance reader for post-payout trace cleanup. */
  getBalance?: () => Promise<number>;
  /** Optional provenance when the recovery surface knows the source. The
   *  escrowId, when present, keys the double-pay journal below. */
  traceContext?: {
    escrowId?: string;
    amountMsats?: number;
  };
  /** Bound to addOrTouchLightningHandle. Best-effort post-success. */
  addOrTouchLightningHandle: (address: string) => void;
  /** Phase callback. */
  onPhase: (phase: RecoveryPayoutPhase) => void;
  // ── R3-1 double-pay guard (shares the claim path's escrow-keyed journal) ──
  // All optional + only active when traceContext.escrowId is set, so existing
  // callers/tests run unchanged. See payments/payout-journal.ts.
  getPayoutRecord?: (escrowId: string) => { status: "submitted" | "settled"; operationId?: string } | null;
  recordPayoutSubmitted?: (input: { escrowId: string; operationId?: string; amountMsats?: number }) => void;
  markPayoutSettled?: (escrowId: string, operationId?: string) => void;
  clearPayoutRecord?: (escrowId: string) => void;
  /** v4.0.0 fail-closed: throws if the journal can't be persisted (so we never
   *  dispatch an unguarded payout). No-op when unset. */
  assertPayoutJournalWritable?: () => void;
  awaitPayoutOutcome?: (operationId: string) => Promise<"settled" | "refunded" | "unknown">;
}

function errorMessage(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "string" && e) return e;
  if (
    e &&
    typeof e === "object" &&
    typeof (e as { message?: unknown }).message === "string" &&
    (e as { message: string }).message
  ) {
    return (e as { message: string }).message;
  }
  return fallback;
}

/** Pay BOLT11 → optionally save handle → done. Resolves with terminal,
 *  never rejects. payout-failed leaves the orphan in the user's wallet
 *  for a subsequent retry; the recovery banner gate keeps firing until
 *  the balance reaches zero. */
export async function runRecoveryPayout(
  opts: RunRecoveryPayoutOpts,
): Promise<RecoveryPayoutTerminal> {
  const emit = (p: RecoveryPayoutPhase) => opts.onPhase(p);
  const escrowId = opts.traceContext?.escrowId;

  // ── R3-1 double-pay guard ────────────────────────────────────────────────
  // Mirrors runClaimAndPayout's top guard, on the SAME escrow-keyed journal:
  // a settled/submitted record for this escrow means a payout already went
  // out (the refund's twin of the claim-side bug). Only active with an
  // escrowId — a generic balance drain has no stable key, and a drained
  // balance is its own guard.
  if (escrowId) {
    const prior = opts.getPayoutRecord?.(escrowId) ?? null;
    if (prior?.status === "settled") {
      emit({ kind: "done" });
      return { kind: "done" };
    }
    if (prior?.status === "submitted") {
      emit({ kind: "payout-confirming" });
      let outcome: "settled" | "refunded" | "unknown" = "unknown";
      if (opts.awaitPayoutOutcome && prior.operationId) {
        try { outcome = await opts.awaitPayoutOutcome(prior.operationId); }
        catch { outcome = "unknown"; }
      }
      if (outcome === "settled") {
        // Submitted record (which got us here) persists and already blocks
        // re-pay; a failed settled-upgrade is fund-safe. Proceed to done.
        try { opts.markPayoutSettled?.(escrowId, prior.operationId); }
        catch (e) { console.warn("[chama] recovery: re-attach markPayoutSettled persist failed (submitted record still guards):", e); }
        emit({ kind: "done" });
        return { kind: "done" };
      }
      if (outcome === "refunded") {
        opts.clearPayoutRecord?.(escrowId); // sats came back — pay fresh below
      } else {
        emit({ kind: "payout-confirming", error: RECOVERY_CONFIRMING_COPY });
        return { kind: "payout-confirming", error: RECOVERY_CONFIRMING_COPY };
      }
    }
  }

  // v4.0.0 FAIL-CLOSED (guard only active with an escrowId): refuse to SEND if
  // the journal can't be persisted, so a later re-tap can't double-pay. Nothing
  // is sent here, so a retry once storage recovers is safe.
  if (escrowId && opts.assertPayoutJournalWritable) {
    try {
      opts.assertPayoutJournalWritable();
    } catch (e) {
      const error = errorMessage(
        e,
        "Can't recover safely right now — this device's storage is full or unavailable, so the anti-double-pay guard can't be saved. No payment was sent; free up space and try again.",
      );
      emit({ kind: "payout-failed", error });
      return { kind: "payout-failed", error };
    }
  }

  emit({ kind: "paying-invoice" });
  try {
    const res = await opts.payInvoice(opts.bolt11);
    // payInvoice only resolves on success — journal it settled so a retry is
    // a no-op, never a second send. If that write fails after a SENT payout, do
    // not surface a re-payable failure — force payout-confirming.
    if (escrowId) {
      try {
        opts.markPayoutSettled?.(escrowId, typeof res === "string" ? res : undefined);
      } catch (persistErr) {
        console.error("[chama] recovery: markPayoutSettled persist failed after a sent payout; forcing payout-confirming:", persistErr);
        emit({ kind: "payout-confirming", error: RECOVERY_CONFIRMING_COPY });
        return { kind: "payout-confirming", error: RECOVERY_CONFIRMING_COPY };
      }
    }
  } catch (e: any) {
    const code = (e as { code?: string })?.code;
    const opId = (e as { operationId?: string })?.operationId;
    // Submitted-but-unconfirmed (watch timed out mid-flight) ⇒ never a
    // re-payable failure. Journal it and surface payout-confirming.
    if (code === "LN_PAY_INFLIGHT") {
      if (escrowId) {
        // Even if the submitted guard can't persist, force payout-confirming —
        // never fall through to the re-payable terminal for an in-flight payout.
        try {
          opts.recordPayoutSubmitted?.({ escrowId, operationId: opId, amountMsats: opts.traceContext?.amountMsats });
        } catch (persistErr) {
          console.error("[chama] recovery: recordPayoutSubmitted persist failed for an in-flight payout; forcing payout-confirming anyway:", persistErr);
        }
      }
      emit({ kind: "payout-confirming", error: RECOVERY_CONFIRMING_COPY });
      return { kind: "payout-confirming", error: RECOVERY_CONFIRMING_COPY };
    }
    // Definite failure (confirmed refund, submit-failed, other) — re-paying is
    // correct; drop any record so a retry isn't wrongly blocked.
    if (escrowId) opts.clearPayoutRecord?.(escrowId);
    const error = errorMessage(e, "Lightning payment failed");
    emit({ kind: "payout-failed", error });
    return { kind: "payout-failed", error };
  }

  if (opts.saveAfter && opts.addressUsed) {
    try {
      opts.addOrTouchLightningHandle(opts.addressUsed);
    } catch {
      // Cosmetic — payout already succeeded.
    }
  }

  if (opts.getBalance) {
    try {
      const balance = await opts.getBalance();
      if (Math.floor(Math.max(0, balance) / 1000) > 0) {
        recordSatsTrace({
          source: "recovery",
          escrowId: opts.traceContext?.escrowId,
          amountMsats: opts.traceContext?.amountMsats,
          balanceMsats: balance,
          reason: "recovery-leftover",
        });
      } else {
        markSatsTracesDrained("recovery-drained");
      }
    } catch {
      // Best-effort trace cleanup only.
    }
  }

  emit({ kind: "done" });
  return { kind: "done" };
}
