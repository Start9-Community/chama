// ══════════════════════════════════════════════════════════════════════════
// Chama — Banxaas mobile-money payout handoff
// ══════════════════════════════════════════════════════════════════════════
//
// Banxaas is now part of the unified external-swap registry in
// `external-swap-registry.ts`. This module remains as a thin
// back-compat shim so existing callers and the test suite — which
// import `BANXAAS_SWAP_URL`, `BANXAAS_PAYOUT_COUNTRIES`, and
// `getBanxaasPayoutAvailability` directly — keep compiling unchanged.
//
// New code paths should prefer the registry directly:
//   import { getExternalSwapsForContext } from "./external-swap-registry.js";

import {
  EXTERNAL_SWAP_PROVIDERS,
  getExternalSwapsForContext,
  type ExternalSwapStatus,
} from "./external-swap-registry.js";

/** Banxaas's public swap landing page. Same URL handles onramp and
 *  offramp — Banxaas decides which based on user choice on their side. */
export const BANXAAS_SWAP_URL = "https://banxaas.com/swap";

export type BanxaasPayoutStatus = ExternalSwapStatus;

export interface BanxaasPayoutCountry {
  slug: string;
  countryCode: "SN" | "CI" | "CM" | "GN";
  displayName: string;
  flagEmoji: string;
  currency: "XOF" | "XAF" | "GNF";
  status: BanxaasPayoutStatus;
}

export interface BanxaasPayoutAvailability {
  country: BanxaasPayoutCountry;
  status: BanxaasPayoutStatus;
  reason: "home-community" | "trade-community" | "fiat-currency";
}

/** Derived from the unified registry, filtered to Banxaas entries.
 *  Kept exported in its original shape so existing tests and the
 *  legacy claim modal continue to work without edits. */
export const BANXAAS_PAYOUT_COUNTRIES: readonly BanxaasPayoutCountry[] =
  EXTERNAL_SWAP_PROVIDERS
    .filter((p) => p.id === "banxaas")
    .map((p) => ({
      slug: p.communitySlug,
      countryCode: p.countryCode as BanxaasPayoutCountry["countryCode"],
      displayName: p.countryName,
      flagEmoji: p.flagEmoji,
      currency: p.currency as BanxaasPayoutCountry["currency"],
      status: p.status,
    }));

/**
 * Back-compat wrapper over the unified resolver. Returns at most one
 * Banxaas entry, matching the legacy single-result contract.
 */
export function getBanxaasPayoutAvailability(input: {
  homeCommunity?: string | null;
  tradeCommunity?: string | null;
  fiatCurrency?: string | null;
}): BanxaasPayoutAvailability | null {
  const matches = getExternalSwapsForContext(input).filter(
    (m) => m.provider.id === "banxaas",
  );
  if (matches.length === 0) return null;
  const match = matches[0];
  const country = BANXAAS_PAYOUT_COUNTRIES.find(
    (c) => c.slug === match.provider.communitySlug,
  );
  if (!country) return null;
  return {
    country,
    status: match.provider.status,
    reason: match.reason,
  };
}
