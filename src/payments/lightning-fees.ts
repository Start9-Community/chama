// ══════════════════════════════════════════════════════════════════════════
// Chama — Lightning outbound fee helpers
// ══════════════════════════════════════════════════════════════════════════
//
// Browser Fedimint pays outbound Lightning fees from the sender's ecash
// balance, in addition to the invoice amount. For claim/recovery payouts
// this means the destination invoice must be slightly smaller than the
// available balance, otherwise tiny payouts fail even though the wallet
// visibly has "enough" sats.

const DEFAULT_LIGHTNING_SEND_BASE_FEE_MSATS = 2_000;
const DEFAULT_LIGHTNING_SEND_PPM = 5_000;
const DEFAULT_LIGHTNING_SEND_BUFFER_MSATS = 500;

export function estimateLightningSendFeeMsats(invoiceAmountMsats: number): number {
  const amount = Math.max(0, Math.floor(invoiceAmountMsats));
  return (
    DEFAULT_LIGHTNING_SEND_BASE_FEE_MSATS
    + Math.ceil((amount * DEFAULT_LIGHTNING_SEND_PPM) / 1_000_000)
    + DEFAULT_LIGHTNING_SEND_BUFFER_MSATS
  );
}

export function maxLightningPayoutSats(balanceMsats: number): number {
  const balance = Math.max(0, Math.floor(balanceMsats));
  let lo = 0;
  let hi = Math.floor(balance / 1000);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const invoiceAmountMsats = mid * 1000;
    const totalCostMsats =
      invoiceAmountMsats + estimateLightningSendFeeMsats(invoiceAmountMsats);
    if (totalCostMsats <= balance) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

export function hasLightningWithdrawableBalance(balanceMsats: number): boolean {
  return maxLightningPayoutSats(balanceMsats) > 0;
}

export function lightningPayoutReserveSats(balanceMsats: number): number {
  const payoutSats = maxLightningPayoutSats(balanceMsats);
  return Math.max(0, Math.ceil((Math.max(0, balanceMsats) - payoutSats * 1000) / 1000));
}

export type ClaimPayoutTarget = "lightning" | "fedi-wallet";

export function claimPayoutSats(balanceMsats: number, target: ClaimPayoutTarget): number {
  if (target === "fedi-wallet") {
    return Math.max(0, Math.floor(balanceMsats / 1000));
  }
  return maxLightningPayoutSats(balanceMsats);
}

export function claimPayoutReserveSats(balanceMsats: number, target: ClaimPayoutTarget): number {
  if (target === "fedi-wallet") return 0;
  return lightningPayoutReserveSats(balanceMsats);
}

export function retrySmallerLightningPayoutSats(currentPayoutSats: number): number {
  const current = Math.max(0, Math.floor(currentPayoutSats));
  if (current <= 1) return 0;
  return Math.max(1, Math.floor(current / 2));
}
