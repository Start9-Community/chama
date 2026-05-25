// ══════════════════════════════════════════════════════════════════════════
// Chama — Banxaas mobile-money payout handoff
// ══════════════════════════════════════════════════════════════════════════
//
// Banxaas is an external Lightning <-> Mobile Money swap surface. Chama
// does not have a partner API yet, so the safe integration is a guided
// handoff: open Banxaas, let the user create a Lightning invoice there,
// then pay that pasted invoice through the normal claim+payout path.

export const BANXAAS_SWAP_URL = "https://banxaas.com/swap";

export type BanxaasPayoutStatus = "enabled" | "coming-soon";

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

export const BANXAAS_PAYOUT_COUNTRIES: readonly BanxaasPayoutCountry[] = [
  {
    slug: "sn-cfa",
    countryCode: "SN",
    displayName: "Senegal",
    flagEmoji: "🇸🇳",
    currency: "XOF",
    status: "enabled",
  },
  {
    slug: "ci-xof",
    countryCode: "CI",
    displayName: "Côte d'Ivoire",
    flagEmoji: "🇨🇮",
    currency: "XOF",
    status: "coming-soon",
  },
  {
    slug: "cm-xaf",
    countryCode: "CM",
    displayName: "Cameroon",
    flagEmoji: "🇨🇲",
    currency: "XAF",
    status: "coming-soon",
  },
  {
    slug: "gn-gnf",
    countryCode: "GN",
    displayName: "Guinea",
    flagEmoji: "🇬🇳",
    currency: "GNF",
    status: "coming-soon",
  },
];

const BY_SLUG = new Map(BANXAAS_PAYOUT_COUNTRIES.map(country => [country.slug, country]));

function byCurrency(currency: string | null | undefined): BanxaasPayoutCountry | null {
  const normalized = (currency ?? "").trim().toUpperCase();
  if (!normalized) return null;

  if (normalized === "XAF") {
    return BY_SLUG.get("cm-xaf") ?? null;
  }
  if (normalized === "GNF") {
    return BY_SLUG.get("gn-gnf") ?? null;
  }
  if (normalized === "XOF") {
    // XOF is shared by Senegal and Côte d'Ivoire. Without a community
    // slug, prefer the country that is live today so older trades still
    // expose a working cash-out route.
    return BY_SLUG.get("sn-cfa") ?? null;
  }
  return null;
}

export function getBanxaasPayoutAvailability(input: {
  homeCommunity?: string | null;
  tradeCommunity?: string | null;
  fiatCurrency?: string | null;
}): BanxaasPayoutAvailability | null {
  const tradeCountry = input.tradeCommunity ? BY_SLUG.get(input.tradeCommunity) : null;
  if (tradeCountry) {
    return {
      country: tradeCountry,
      status: tradeCountry.status,
      reason: "trade-community",
    };
  }

  const homeCountry = input.homeCommunity ? BY_SLUG.get(input.homeCommunity) : null;
  if (homeCountry) {
    return {
      country: homeCountry,
      status: homeCountry.status,
      reason: "home-community",
    };
  }

  const currencyCountry = byCurrency(input.fiatCurrency);
  if (currencyCountry) {
    return {
      country: currencyCountry,
      status: currencyCountry.status,
      reason: "fiat-currency",
    };
  }

  return null;
}
