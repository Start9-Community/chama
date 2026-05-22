// Chama — production funding guardrails

/** Small real Lightning escrows are allowed again. The receive watcher now
 * surfaces failed settlement paths honestly, so the UI floor only blocks
 * zero-value trades. */
export const MIN_REAL_ATOMIC_FUNDING_SATS = 1;
export const MIN_REAL_ATOMIC_FUNDING_MSATS = MIN_REAL_ATOMIC_FUNDING_SATS * 1000;

export function minimumAtomicFundingMessage(): string {
  const unit = MIN_REAL_ATOMIC_FUNDING_SATS === 1 ? "sat" : "sats";
  return `Minimum real Lightning escrow is ${MIN_REAL_ATOMIC_FUNDING_SATS.toLocaleString()} ${unit}.`;
}
