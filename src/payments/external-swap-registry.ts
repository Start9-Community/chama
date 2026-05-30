// ══════════════════════════════════════════════════════════════════════════
// Chama — external Lightning <-> fiat swap registry
// ══════════════════════════════════════════════════════════════════════════
//
// Chama is non-custodial: we never touch fiat. Users who want to cash out
// to mobile money (or onramp fiat to sats) do that through external swap
// providers. The legacy `chapsmart-payout.ts` tried to integrate one of
// those providers via API; that path proved unreliable (the partner's
// endpoint kept breaking the chain), so the v1.2.4 model is uniform:
// every provider is a guided redirect — open the provider's swap page in
// a new tab, do the swap there, and (for offramp) paste the resulting
// Lightning invoice back into Chama.
//
// Banxaas is the gold-standard implementation: a single URL handles both
// directions (onramp and offramp), the user picks fiat or sats once they
// land, and the same flow works for every supported country. Providers
// flagged `bidirectional: true` get surfaced earlier in the funnel — even
// pre-LOCK — as a "bring sats in OR cash out" CTA. Single-direction
// (offramp-only) providers stay hidden until the trade reaches CLAIMED
// state so a confused user can't accidentally try to cash out sats they
// haven't actually claimed yet.
//
// Adding a new provider = one entry below. No new component, no new
// modal, no new code path. The ClaimPayoutModal picker reads this
// registry and renders whichever entries match the trade context.

export type ExternalSwapStatus = "enabled" | "coming-soon";

export type ExternalSwapProviderId =
  | "banxaas"
  | "chapsmart"
  | "bitika"
  | "tando"
  | "minmo"
  | "bitzed";

export interface ExternalSwapProvider {
  /** Stable id (used by tests + telemetry + UI keys). */
  id: ExternalSwapProviderId;
  /** Display name on the picker card. */
  displayName: string;
  /** Public swap URL — opens in a new tab. */
  swapUrl: string;
  /** Chama community slug this entry serves. */
  communitySlug: string;
  /** ISO country name shown next to the flag. */
  countryName: string;
  /** ISO 3166-1 alpha-2 country code. */
  countryCode: string;
  /** Country flag emoji. */
  flagEmoji: string;
  /** Fiat currency code (XOF, XAF, TZS, KES, ZMW, etc.). */
  currency: string;
  /** Live now, or partner-side coming-soon shown grayed. */
  status: ExternalSwapStatus;
  /** True when one URL serves both onramp and offramp. Only such
   *  providers are surfaced pre-LOCK as a recommended on/off-ramp CTA;
   *  offramp-only providers stay claim-modal-only. */
  bidirectional?: boolean;
  /** True when the provider has been chosen as the headline option for
   *  its market. Currently only Banxaas (Senegal live, others ramping).
   *  The picker highlights `recommended` entries and orders them first. */
  recommended?: boolean;
  /** One-line user-facing blurb shown in the picker card. */
  blurb?: string;
}

// ── Providers ─────────────────────────────────────────────────────────────
//
// Order within the array is the order the picker will offer when more
// than one provider matches a market (e.g., Kenya has three). Recommended
// + bidirectional entries float to the top.

export const EXTERNAL_SWAP_PROVIDERS: readonly ExternalSwapProvider[] = [
  // ── Banxaas ── West & Central Africa, recommended, bidirectional
  // ──────────────────────────────────────────────────────────────────
  // Live in Senegal today; CI / CM / GN flagged coming-soon in the
  // partner's own roadmap so Chama shows them grayed instead of
  // pretending the route works. Banxaas serves both onramp and
  // offramp from the same URL, which is why it gets pre-LOCK
  // placement and the `recommended` highlight.
  {
    id: "banxaas",
    displayName: "Banxaas",
    swapUrl: "https://banxaas.com/swap",
    communitySlug: "sn-cfa",
    countryName: "Senegal",
    countryCode: "SN",
    flagEmoji: "🇸🇳",
    currency: "XOF",
    status: "enabled",
    bidirectional: true,
    recommended: true,
    blurb: "Bring sats in or cash out — same link, both ways.",
  },
  {
    id: "banxaas",
    displayName: "Banxaas",
    swapUrl: "https://banxaas.com/swap",
    communitySlug: "ci-xof",
    countryName: "Côte d'Ivoire",
    countryCode: "CI",
    flagEmoji: "🇨🇮",
    currency: "XOF",
    status: "coming-soon",
    bidirectional: true,
    recommended: true,
  },
  {
    id: "banxaas",
    displayName: "Banxaas",
    swapUrl: "https://banxaas.com/swap",
    communitySlug: "cm-xaf",
    countryName: "Cameroon",
    countryCode: "CM",
    flagEmoji: "🇨🇲",
    currency: "XAF",
    status: "coming-soon",
    bidirectional: true,
    recommended: true,
  },
  {
    id: "banxaas",
    displayName: "Banxaas",
    swapUrl: "https://banxaas.com/swap",
    communitySlug: "gn-gnf",
    countryName: "Guinea",
    countryCode: "GN",
    flagEmoji: "🇬🇳",
    currency: "GNF",
    status: "coming-soon",
    bidirectional: true,
    recommended: true,
  },

  // ── Chapsmart ── Tanzania, offramp redirect (replaces v1.2.3 API)
  // ──────────────────────────────────────────────────────────────────
  // Earlier versions of Chama posted directly to a Chapsmart endpoint
  // to mint a payout invoice; that endpoint was unreliable in
  // production. v1.2.4 cuts the API and treats Chapsmart as a guided
  // redirect like Banxaas. Offramp-only — only shows post-CLAIM.
  {
    id: "chapsmart",
    displayName: "Chapsmart",
    swapUrl: "https://chapsmart.com",
    communitySlug: "tz-tzs",
    countryName: "Tanzania",
    countryCode: "TZ",
    flagEmoji: "🇹🇿",
    currency: "TZS",
    status: "enabled",
  },

  // ── Kenya ── three offramp options surfaced in parallel; users
  // pick whichever they trust. All redirect-style; the user pastes a
  // Lightning invoice back into Chama after creating one on the
  // provider's site.
  {
    id: "bitika",
    displayName: "Bitika",
    swapUrl: "https://bitika.xyz",
    communitySlug: "ke-kes",
    countryName: "Kenya",
    countryCode: "KE",
    flagEmoji: "🇰🇪",
    currency: "KES",
    status: "enabled",
  },
  {
    id: "tando",
    displayName: "Tando",
    swapUrl: "https://use.tando.me",
    communitySlug: "ke-kes",
    countryName: "Kenya",
    countryCode: "KE",
    flagEmoji: "🇰🇪",
    currency: "KES",
    status: "enabled",
  },
  {
    // "Pilot" is the subdomain used by Minmo for the pilot deployment
    // of their swap surface; the provider itself is Minmo. Speaks
    // WebLN — Fedi's WebView already exposes WebLN, so there's no
    // special-case branch in Chama; in plain browsers the user can
    // still complete the swap manually on Minmo's UI.
    id: "minmo",
    displayName: "Minmo",
    swapUrl: "https://swap.pilot.minmo.to",
    communitySlug: "ke-kes",
    countryName: "Kenya",
    countryCode: "KE",
    flagEmoji: "🇰🇪",
    currency: "KES",
    status: "enabled",
  },

  // ── Bitzed ── Zambia, offramp redirect
  // ──────────────────────────────────────────────────────────────────
  {
    id: "bitzed",
    displayName: "Bitzed",
    swapUrl: "https://app.bitzed.xyz",
    communitySlug: "zm-zmw",
    countryName: "Zambia",
    countryCode: "ZM",
    flagEmoji: "🇿🇲",
    currency: "ZMW",
    status: "enabled",
  },

  // The Kenya Bitsacco route is currently covered by the same
  // ke-kes-bitsacco slug Chama uses elsewhere. Surface the same
  // three options there too — users picking the Bitsacco route still
  // want Bitika / Tando / Pilot as their offramp.
  {
    id: "bitika",
    displayName: "Bitika",
    swapUrl: "https://bitika.xyz",
    communitySlug: "ke-kes-bitsacco",
    countryName: "Kenya",
    countryCode: "KE",
    flagEmoji: "🇰🇪",
    currency: "KES",
    status: "enabled",
  },
  {
    id: "tando",
    displayName: "Tando",
    swapUrl: "https://use.tando.me",
    communitySlug: "ke-kes-bitsacco",
    countryName: "Kenya",
    countryCode: "KE",
    flagEmoji: "🇰🇪",
    currency: "KES",
    status: "enabled",
  },
  {
    id: "minmo",
    displayName: "Minmo",
    swapUrl: "https://swap.pilot.minmo.to",
    communitySlug: "ke-kes-bitsacco",
    countryName: "Kenya",
    countryCode: "KE",
    flagEmoji: "🇰🇪",
    currency: "KES",
    status: "enabled",
  },
];

// ── Resolver ──────────────────────────────────────────────────────────────

export type ExternalSwapMatchReason =
  | "trade-community"
  | "home-community"
  | "fiat-currency";

export interface ExternalSwapMatch {
  provider: ExternalSwapProvider;
  reason: ExternalSwapMatchReason;
}

/**
 * Return every swap provider that applies to a trade's context. The
 * picker uses this to render one card per match; if the same country
 * has multiple providers (Kenya does), the user sees them all.
 *
 * Resolution priority per provider:
 *   1. Exact trade-community match (most precise)
 *   2. Exact home-community match (user's normal locale)
 *   3. Fiat-currency match (legacy trades without a community tag)
 *
 * Recommended and bidirectional providers float to the top of the
 * returned array so the picker renders them first.
 */
/** Master switch for the external on/off-ramp integrations (Banxaas,
 *  Chapsmart, Bitika, Tando, Minmo, Bitzed). OFF as of v1.2.8: none of them
 *  drop in as a real in-app Chama funding/payout step the way we'd hoped —
 *  Banxaas, for one, is NWC-only end to end — so surfacing them only sends
 *  users to a dead end. The registry data + resolver helpers stay intact and
 *  unit-tested behind this flag; flip it back on (globally, or per provider)
 *  once a genuine integration lands. The two UI call sites gate on this:
 *  AtomicFundingModal (pre-LOCK CTA) and ClaimPayoutModal (claim picker). */
export const EXTERNAL_SWAPS_ENABLED = false;

export function getExternalSwapsForContext(input: {
  homeCommunity?: string | null;
  tradeCommunity?: string | null;
  fiatCurrency?: string | null;
}): ExternalSwapMatch[] {
  const matches: ExternalSwapMatch[] = [];
  const seen = new Set<string>();

  const tradeSlug = input.tradeCommunity ?? null;
  const homeSlug = input.homeCommunity ?? null;
  const currency = (input.fiatCurrency ?? "").trim().toUpperCase() || null;

  for (const provider of EXTERNAL_SWAP_PROVIDERS) {
    let reason: ExternalSwapMatchReason | null = null;
    if (tradeSlug && provider.communitySlug === tradeSlug) {
      reason = "trade-community";
    } else if (homeSlug && provider.communitySlug === homeSlug) {
      reason = "home-community";
    } else if (currency && provider.currency.toUpperCase() === currency) {
      reason = "fiat-currency";
    }
    if (!reason) continue;
    // Dedupe by (provider id × community slug). The same physical
    // provider entry can match via multiple reasons (e.g. trade and
    // home both point at sn-cfa); keep only the highest-priority
    // reason, which is whichever fired first in the order above.
    const key = `${provider.id}|${provider.communitySlug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({ provider, reason });
  }

  // Sort:
  //   1. Reason priority — trade-community beats home-community beats
  //      fiat-currency. This is the contract callers expect: "if my
  //      trade is in Ivory Coast but my home is Senegal, surface the
  //      Ivory Coast result first" (it's the more specific context).
  //   2. Within the same reason tier, recommended + bidirectional
  //      providers float to the top. Banxaas gets the top slot in
  //      Senegal because it's the recommended provider there.
  //   3. Within the same tier and score, keep registry order so
  //      Kenya's three providers always render Bitika → Tando → Minmo.
  const reasonScore: Record<ExternalSwapMatchReason, number> = {
    "trade-community": 3,
    "home-community": 2,
    "fiat-currency": 1,
  };
  matches.sort((a, b) => {
    const reasonDelta = reasonScore[b.reason] - reasonScore[a.reason];
    if (reasonDelta !== 0) return reasonDelta;
    const aScore = (a.provider.recommended ? 2 : 0) + (a.provider.bidirectional ? 1 : 0);
    const bScore = (b.provider.recommended ? 2 : 0) + (b.provider.bidirectional ? 1 : 0);
    return bScore - aScore;
  });

  return matches;
}

/**
 * Return only the bidirectional providers — the ones safe to surface
 * pre-LOCK as a "bring sats in OR cash out" recommendation. Currently
 * Banxaas only; future bidirectional partners join the same lane
 * automatically.
 */
export function getBidirectionalSwapsForContext(input: {
  homeCommunity?: string | null;
  tradeCommunity?: string | null;
  fiatCurrency?: string | null;
}): ExternalSwapMatch[] {
  return getExternalSwapsForContext(input).filter(
    (m) => m.provider.bidirectional === true,
  );
}

/**
 * Open the provider's swap URL in a new tab. Centralised so the
 * window.open guards live in one place — easy to noop in SSR or to
 * swap for a Capacitor browser plugin if the in-app browser becomes
 * a better UX than a system-handed-off tab.
 */
export function openExternalSwap(provider: ExternalSwapProvider): void {
  if (typeof window === "undefined") return;
  window.open(provider.swapUrl, "_blank", "noopener,noreferrer");
}
