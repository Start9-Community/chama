// ══════════════════════════════════════════════════════════════════════════
// Chama — Claim Payout Journal (double-pay guard)
// ══════════════════════════════════════════════════════════════════════════
//
// The companion to pending-redemptions.ts on the OUTBOUND side of a claim.
// Pending-redemptions protects the bearer notes between CLAIM-publish and
// redeem; this journal protects against paying the winner's destination
// invoice TWICE.
//
// ── The bug this exists for (3.5.1 device pass, round 2) ──────────────────
//
//   1. Claim settles, balance covers the payout.
//   2. runClaimAndPayout pays the winner's Lightning invoice via the
//      federation gateway. The adapter submits, gets an operationId, then
//      watches subscribeLnPay for `success{preimage}`.
//   3. The HTLC is slow. The 60s watch window (PAY_WATCH_TIMEOUT_MS) expires
//      while the payment is STILL IN FLIGHT, so payInvoice throws.
//   4. The payment then settles — sats land in the winner's wallet — but the
//      UI already fell to a retryable terminal.
//   5. RETRY mints a FRESH invoice (different payment hash, so the gateway
//      cannot dedupe) and pays AGAIN. The winner is paid twice.
//
// Lightning's own payment-hash idempotency cannot save us here precisely
// because each retry resolves a new invoice. The guard therefore keys on the
// ESCROW, not the invoice: once a payout for an escrow has been SUBMITTED
// (an operationId exists ⇒ the gateway accepted it), no second payout is ever
// dispatched for that escrow. The true outcome is resolved by re-attaching to
// the operationId, never by paying again.
//
// ── unknown ⇒ refuse ──────────────────────────────────────────────────────
//
// Mirrors the fund-loss-guard stance used elsewhere in Chama: an
// indeterminate payout outcome (timed-out watch, stream error, unexpected
// state) is recorded as `submitted`, NOT cleared. A `submitted` record blocks
// re-pay. Only a CONFIRMED refund clears the record (the bridge does that by
// calling clearPayoutRecord), making the escrow freshly payable again.
//
// Storage mirrors pending-redemptions.ts exactly: synchronous, user-scoped
// localStorage, versioned key, durable across crashes / refreshes.

import {
  getScopedStorageItem,
  removeScopedStorageItem,
  setScopedStorageItem,
} from "../storage/user-scope.js";

// ── Constants ──────────────────────────────────────────────────────────────

/** localStorage key. Versioned so we can migrate the payload shape later. */
export const PAYOUT_JOURNAL_KEY = "chama_payout_journal_v1";

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * submitted — the gateway accepted a payout for this escrow (an operationId
 *   exists) but settlement is not yet CONFIRMED. Blocks re-pay. The true
 *   outcome is resolved by re-attaching to `operationId`.
 * settled   — the payout reached a `success{preimage}` terminal. Blocks
 *   re-pay permanently; a retry is a no-op that just completes the claim.
 */
export type PayoutStatus = "submitted" | "settled";

export interface PayoutRecord {
  /** Escrow ID this payout belongs to (journal key). */
  escrowId: string;
  /** Current lifecycle status. */
  status: PayoutStatus;
  /** Fedimint LN-pay operation id — the durable handle for re-attach.
   *  Present whenever the gateway accepted the payment. */
  operationId?: string;
  /** Payout amount in msats, for forensics / "already paid" UI. */
  amountMsats?: number;
  /** When the payout was first submitted (Unix ms). */
  createdAt: number;
  /** When it reached `settled` (Unix ms). */
  settledAt?: number;
}

// ── Internal: load/save the whole map ──────────────────────────────────────

type Journal = Record<string, PayoutRecord>;

function loadJournal(): Journal {
  try {
    const raw = getScopedStorageItem(PAYOUT_JOURNAL_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Journal;
  } catch (e) {
    console.warn("[chama] payout-journal: loadJournal failed:", e);
    return {};
  }
}

function saveJournal(journal: Journal): void {
  try {
    setScopedStorageItem(PAYOUT_JOURNAL_KEY, JSON.stringify(journal));
  } catch (e) {
    // QuotaExceededError is the main concern. Surface loudly — failing to
    // persist the guard re-opens the double-pay window.
    console.error(
      "[chama] payout-journal: saveJournal failed — double-pay guard may be lost:",
      e,
    );
  }
}

// ══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ══════════════════════════════════════════════════════════════════════════

/** The payout record for an escrow, or null if none has been submitted. */
export function getPayoutRecord(escrowId: string): PayoutRecord | null {
  return loadJournal()[escrowId] ?? null;
}

/**
 * Record that a payout has been SUBMITTED for this escrow (the gateway
 * accepted it; an operationId exists) but settlement is not yet confirmed.
 * Called by the claim orchestrator the moment payInvoice yields an
 * operationId OR throws an in-flight (unknown-outcome) error carrying one.
 *
 * Idempotent: never downgrades a `settled` record back to `submitted`.
 */
export function recordPayoutSubmitted(input: {
  escrowId: string;
  operationId?: string;
  amountMsats?: number;
}): void {
  const journal = loadJournal();
  const existing = journal[input.escrowId];
  if (existing?.status === "settled") return; // never un-settle
  journal[input.escrowId] = {
    escrowId: input.escrowId,
    status: "submitted",
    operationId: input.operationId ?? existing?.operationId,
    amountMsats: input.amountMsats ?? existing?.amountMsats,
    createdAt: existing?.createdAt ?? Date.now(),
  };
  saveJournal(journal);
  console.info(
    `[claim-trace] payout-submitted escrowId=${input.escrowId} ` +
      `op=${(input.operationId ?? existing?.operationId ?? "?").slice(0, 16)}`,
  );
}

/**
 * Mark the payout for an escrow as CONFIRMED settled (success{preimage}).
 * After this, any re-tap of Claim is a no-op that just re-publishes COMPLETE.
 */
export function markPayoutSettled(escrowId: string, operationId?: string): void {
  const journal = loadJournal();
  const existing = journal[escrowId];
  journal[escrowId] = {
    escrowId,
    status: "settled",
    operationId: operationId ?? existing?.operationId,
    amountMsats: existing?.amountMsats,
    createdAt: existing?.createdAt ?? Date.now(),
    settledAt: Date.now(),
  };
  saveJournal(journal);
  console.info(`[claim-trace] payout-settled escrowId=${escrowId}`);
}

/**
 * Remove the payout record for an escrow. Called ONLY when a payout is
 * CONFIRMED refunded/canceled — the sats came back, so the escrow is freshly
 * payable and a retry is correct. Never call this on an unknown outcome.
 */
export function clearPayoutRecord(escrowId: string): void {
  const journal = loadJournal();
  if (journal[escrowId]) {
    delete journal[escrowId];
    saveJournal(journal);
    console.info(`[claim-trace] payout-clear escrowId=${escrowId}`);
  }
}

/** Snapshot of all current records. For UI / debug / tests. */
export function listPayoutRecords(): PayoutRecord[] {
  return Object.values(loadJournal());
}

/** Wipe the whole journal. Tests + a future advanced-settings action only. */
export function clearAllPayoutRecords(): void {
  try {
    removeScopedStorageItem(PAYOUT_JOURNAL_KEY);
  } catch (e) {
    console.warn("[chama] payout-journal: clearAll failed:", e);
  }
}
