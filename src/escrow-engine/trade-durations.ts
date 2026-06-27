// ══════════════════════════════════════════════════════════════════════════
// Chama — per-category trade durations (CREATE-side expiry policy)
// ══════════════════════════════════════════════════════════════════════════
//
// v4.1 D (WRITE-UP / UNWIRED — for review before it goes live).
//
// Today every CREATE stamps a flat `expirySeconds` default of 86_400s (24h)
// regardless of vertical (escrow-client.ts `defaultExpirySeconds`). Different
// trade types want different clocks: an Exchange should close in hours, a
// Marketplace sale needs a day to coordinate a handoff, a loan runs for days.
//
// ── CONSENSUS SAFETY (why this is a pure creation-side change) ──
// The ONLY consensus rule on expiry is `expirySeconds > 0` — every client's
// reducer (state-machine.ts:273) and parser (event-parser.ts:239) accept ANY
// positive value; `listingExpiresAt = createTimestamp + expirySeconds` is then
// derived deterministically. So per-category defaults + creation-side clamps
// only constrain what THIS device STAMPS; they never change what a client
// ACCEPTS off the wire. This module therefore needs NO coordinated release —
// but it stays UNWIRED until reviewed (the live default is unchanged).
//
// `category` is the CREATE payload's vertical string ("p2p-trade" | "bill-pay"
// | "marketplace" | "lending"), exactly what CreateForm stamps (category:
// vertical). Unknown / legacy categories fall back to the generous legacy
// window so an off-registry vertical is never rejected or over-constrained.

export const HOUR_SECONDS = 60 * 60;
export const DAY_SECONDS = 24 * HOUR_SECONDS;

/** Min / default / max expiry window for a category, in seconds. The DEFAULT
 *  is what an un-customized CREATE stamps; MIN/MAX are the hard clamps that
 *  bound the creator's optional customization. All three are > 0 (consensus
 *  invariant) and satisfy `min ≤ default ≤ max`. */
export interface ExpiryBounds {
  min: number;
  default: number;
  max: number;
}

// LOCKED defaults (2026-06-24): Exchange 3h · CBP 3h · Marketplace 1 day ·
// Lending 7-day cap. The MIN/MAX clamp bounds below are PROPOSED (pending
// Jetty's sign-off) — only the defaults are locked.
const CATEGORY_EXPIRY: Record<string, ExpiryBounds> = {
  // Exchange — a cash↔sats swap should settle fast; hours, not days.
  "p2p-trade": { min: 1 * HOUR_SECONDS, default: 3 * HOUR_SECONDS, max: 12 * HOUR_SECONDS },
  // Community Bill Pay — same fast posture as Exchange.
  "bill-pay": { min: 1 * HOUR_SECONDS, default: 3 * HOUR_SECONDS, max: 12 * HOUR_SECONDS },
  // Marketplace — a goods/service handoff needs coordination room; a day by
  // default (the current flat value), up to a few days.
  "marketplace": { min: 6 * HOUR_SECONDS, default: 1 * DAY_SECONDS, max: 3 * DAY_SECONDS },
  // Lending — repayment-based; the 7-day cap is the ceiling. (Lending is
  // "coming soon" on Create, so this is forward-looking config.)
  "lending": { min: 1 * DAY_SECONDS, default: 7 * DAY_SECONDS, max: 7 * DAY_SECONDS },
};

/** The legacy/fallback window for an unknown or off-registry category. Keeps
 *  the historical 24h default and a generous, never-rejecting envelope. */
export const FALLBACK_EXPIRY: ExpiryBounds = {
  min: 1 * HOUR_SECONDS,
  default: 1 * DAY_SECONDS,
  max: 7 * DAY_SECONDS,
};

/** The expiry bounds for a category, or the safe fallback for anything not in
 *  the table (legacy / custom verticals). Never throws. */
export function expiryBoundsForCategory(category: string | null | undefined): ExpiryBounds {
  if (typeof category !== "string") return FALLBACK_EXPIRY;
  return CATEGORY_EXPIRY[category] ?? FALLBACK_EXPIRY;
}

/** The default expiry (seconds) a fresh CREATE should stamp for a category. */
export function defaultExpiryForCategory(category: string | null | undefined): number {
  return expiryBoundsForCategory(category).default;
}

/** Clamp a user-chosen expiry into the category's hard [min, max] window.
 *  Non-finite / non-positive input falls back to the category default (never
 *  returns ≤ 0 — the consensus floor). */
export function clampExpiryForCategory(
  category: string | null | undefined,
  seconds: number,
): number {
  const bounds = expiryBoundsForCategory(category);
  if (!Number.isFinite(seconds) || seconds <= 0) return bounds.default;
  return Math.min(bounds.max, Math.max(bounds.min, Math.floor(seconds)));
}

/** True when a chosen expiry is longer than the category's default — i.e. the
 *  creator is extending the clock. Drives the "longer window = your sats are
 *  committed longer; the counterparty has more time" tradeoff copy on Create
 *  (the UI surface is part of the deferred wiring). */
export function isExtendedExpiry(
  category: string | null | undefined,
  seconds: number,
): boolean {
  return seconds > expiryBoundsForCategory(category).default;
}
