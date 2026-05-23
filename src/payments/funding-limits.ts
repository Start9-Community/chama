// Chama — production funding guardrails

/** Keep real Lightning funding away from tiny test invoices while receive-gateway
 * trust is being stabilized. This is only a UX guardrail; sdk-adapter still
 * refuses to create receive invoices unless the SDK marks the gateway vetted. */
export const MIN_REAL_ATOMIC_FUNDING_SATS = 1_000;
export const MIN_REAL_ATOMIC_FUNDING_MSATS = MIN_REAL_ATOMIC_FUNDING_SATS * 1000;

export function minimumAtomicFundingMessage(): string {
  return `Minimum real Lightning escrow is ${MIN_REAL_ATOMIC_FUNDING_SATS.toLocaleString()} sats.`;
}
