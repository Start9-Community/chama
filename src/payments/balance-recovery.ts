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
  | { kind: "done" }
  | { kind: "payout-failed"; error: string };

export type RecoveryPayoutTerminal =
  | { kind: "done" }
  | { kind: "payout-failed"; error: string };

export interface RunRecoveryPayoutOpts {
  /** BOLT11 invoice resolved by DestinationPicker for the user's
   *  destination (Tier 1/2 LN-address-resolved or Tier 3 paste). */
  bolt11: string;
  /** Whether to call addOrTouchLightningHandle on success. */
  saveAfter: boolean;
  /** Address to save (if saveAfter). Unset for Tier 3 paste. */
  addressUsed?: string;
  /** Bound to bridge.payInvoice. */
  payInvoice: (bolt11: string) => Promise<void>;
  /** Optional balance reader for post-payout trace cleanup. */
  getBalance?: () => Promise<number>;
  /** Optional provenance when the recovery surface knows the source. */
  traceContext?: {
    escrowId?: string;
    amountMsats?: number;
  };
  /** Bound to addOrTouchLightningHandle. Best-effort post-success. */
  addOrTouchLightningHandle: (address: string) => void;
  /** Phase callback. */
  onPhase: (phase: RecoveryPayoutPhase) => void;
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

  emit({ kind: "paying-invoice" });
  try {
    await opts.payInvoice(opts.bolt11);
  } catch (e: any) {
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
