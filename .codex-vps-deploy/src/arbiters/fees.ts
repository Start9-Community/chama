// Chama arbiter fee policy
//
// Source of truth for the v1 social contract described in
// PHILOSOPHY.md §2.8 and DECISIONS.md 2026-05-22.
//
// Important: these helpers describe the policy and the wire terms.
// The current escrow token is still one reconstructed ecash payload,
// so actual multi-party payout enforcement needs a dedicated payout
// path before we should deduct this from Fedi/ecash claims.

export const AMBIENT_ARBITER_FEE_BPS = 50; // 0.5%
export const DISPUTE_ARBITER_FEE_BPS = 150; // 1.5%
export const DISPUTE_PARTY_SHARE_BPS = DISPUTE_ARBITER_FEE_BPS / 2; // 0.75%
export const TOTAL_DISPUTED_ARBITER_FEE_BPS =
  AMBIENT_ARBITER_FEE_BPS + DISPUTE_ARBITER_FEE_BPS; // 2%

export function calculateBasisPointFeeMsats(amountMsats: number, bps: number): number {
  if (!Number.isFinite(amountMsats) || amountMsats <= 0) return 0;
  if (!Number.isFinite(bps) || bps <= 0) return 0;
  return Math.floor((amountMsats * bps) / 10_000);
}

export function calculateAmbientArbiterFeeMsats(amountMsats: number): number {
  return calculateBasisPointFeeMsats(amountMsats, AMBIENT_ARBITER_FEE_BPS);
}

export function calculateDisputeArbiterFeeMsats(amountMsats: number): number {
  return calculateBasisPointFeeMsats(amountMsats, DISPUTE_ARBITER_FEE_BPS);
}

export function calculateDisputePartyShareMsats(amountMsats: number): number {
  return calculateBasisPointFeeMsats(amountMsats, DISPUTE_PARTY_SHARE_BPS);
}
