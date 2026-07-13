// Chama funding guardrails

/** Keep the UI floor tiny for Fedi ecash testing. The SDK adapter still refuses
 * to create browser receive invoices unless the gateway trust check passes. */
export const MIN_REAL_ATOMIC_FUNDING_SATS = 1;
export const MIN_REAL_ATOMIC_FUNDING_MSATS = MIN_REAL_ATOMIC_FUNDING_SATS * 1000;

export function minimumAtomicFundingMessage(): string {
  const unit = MIN_REAL_ATOMIC_FUNDING_SATS === 1 ? "sat" : "sats";
  return `Minimum real Lightning escrow is ${MIN_REAL_ATOMIC_FUNDING_SATS.toLocaleString()} ${unit}.`;
}
