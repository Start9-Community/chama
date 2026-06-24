// Outgoing-Lightning-payment outcome codes — the fund-safety contract that the
// claim orchestrator's double-pay guard keys on. Kept in a tiny, dependency-free
// module so BOTH the browser WASM adapter (`sdk-adapter.ts`) and the native Rust
// bridge adapter (`native-bridge-adapter.ts`) mint the SAME coded errors without
// the native shell pulling in the WASM SDK.
//
// Bias throughout: unknown ⇒ INFLIGHT. A payment is only treated as re-payable
// when it DEMONSTRABLY did not move sats (submit failed) or the sats DEMONSTRABLY
// came back (confirmed refund). Anything ambiguous stays INFLIGHT so the guard
// refuses to re-pay. `claim-and-payout.ts` matches the literal "LN_PAY_INFLIGHT"
// (its catch records the payout `submitted` and re-attaches instead of re-paying),
// so these string values must not drift.

/** Submitted, outcome NOT known (watch timed out / stream broke / bridge
 *  reported inflight). The HTLC may still settle ⇒ never re-pay; the claim guard
 *  journals it `submitted` and reconciles via `awaitPayOutcome(operationId)`. */
export const LN_PAY_INFLIGHT = "LN_PAY_INFLIGHT";

/** CONFIRMED refund/cancel — the sats demonstrably came back to the wallet, so a
 *  fresh pay is correct (not a double-send). */
export const LN_PAY_REFUNDED = "LN_PAY_REFUNDED";

/** Submit rejected BEFORE a payment operation existed — no sats moved, safe to
 *  retry with a fresh invoice. */
export const LN_PAY_SUBMIT_FAILED = "LN_PAY_SUBMIT_FAILED";

export interface CodedPayError extends Error {
  code?: string;
  operationId?: string;
}

export function codedPayError(
  message: string,
  code: string,
  operationId?: string,
): CodedPayError {
  const err: CodedPayError = new Error(message);
  err.code = code;
  if (operationId) err.operationId = operationId;
  return err;
}
