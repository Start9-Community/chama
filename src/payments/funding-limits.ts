// Chama — production funding guardrails

/** Browser Fedimint receive can issue very small BOLT11 invoices, but
 * production v0.7.0 showed a 50-sat receive reach the gateway and then
 * reject before ecash minted. Until the SDK exposes a paid-settlement
 * dry run or gateway minimums, keep real atomic funding away from dust
 * amounts. */
export const MIN_REAL_ATOMIC_FUNDING_SATS = 1_000;
export const MIN_REAL_ATOMIC_FUNDING_MSATS = MIN_REAL_ATOMIC_FUNDING_SATS * 1000;

export function minimumAtomicFundingMessage(): string {
  return `Minimum real Lightning escrow is ${MIN_REAL_ATOMIC_FUNDING_SATS.toLocaleString()} sats.`;
}
