// ══════════════════════════════════════════════════════════════════════════
// Chama — external Lightning <-> fiat swap registry
// ══════════════════════════════════════════════════════════════════════════
//
// Chama is non-custodial: we never touch fiat. Users who want to cash out
// to mobile money do that through external swap providers. NOTE: a provider
// that runs a real LUD-16 endpoint should be a NATIVE offramp (like Tando /
// ChapSmart), not a redirect here — see docs/lud16-offramp-provider-requirements.md
// (esp. the CORS gate). The legacy
// `chapsmart-payout.ts` tried to integrate one of those providers via API;
// that path proved unreliable (the partner's endpoint kept breaking the
// chain), so the model here is uniform: every provider in THIS registry is
// a guided redirect — open the provider's swap page in a new tab, cash out
// there, and paste the resulting Lightning invoice back into Chama.
//
// As of the Day-1 fiat-ramps decision (2026-06-24) every registry provider
// is OFFRAMP-only and surfaced POST-CLAIM only (the ClaimPayoutModal
// picker). There is no pre-LOCK CTA and no `bidirectional` special-casing:
// nobody onramps in-app, locking is the user's own action with sats they
// already hold, so a pre-lock provider CTA is pointless. Banxaas keeps
// `recommended` so it tops its market's picker, but it is a plain country
// offramp redirect like the rest.
//
// Tando is deliberately NOT in this registry: it is a genuine LUD-16
// native offramp (`<phone>@bitcoin.co.ke`) routed through the normal
// Lightning-Address payout path, not a redirect. See `tando-offramp.ts`.
//
// Adding a new redirect provider = one entry below. No new component, no
// new modal, no new code path. The ClaimPayoutModal picker reads this
// registry and renders whichever entries match the trade context.

import { openExternalUrl } from "../ui/open-url.js";

export type ExternalSwapStatus = "enabled" | "coming-soon";

export type ExternalSwapProviderId =
  | "banxaas"
  | "bitika"
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
// than one provider matches a market. Recommended entries float to the top.
// All entries are offramp redirects (Tando's native M-Pesa offramp lives in
// `tando-offramp.ts`, not here).

export const EXTERNAL_SWAP_PROVIDERS: readonly ExternalSwapProvider[] = [
  // ── Banxaas ── West & Central Africa, recommended offramp redirect
  // ──────────────────────────────────────────────────────────────────
  // Live in Senegal today; CI / CM / GN flagged coming-soon in the
  // partner's own roadmap so Chama shows them grayed instead of
  // pretending the route works. `recommended` keeps Banxaas at the top
  // of its market's offramp picker; it is otherwise a plain country
  // cash-out redirect (open the page, make an invoice, paste it back).
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
    recommended: true,
    blurb: "Cash out to XOF mobile money via Banxaas.",
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
    recommended: true,
  },

  // ── Chapsmart ── GRADUATED to a native LUD-16 M-Pesa offramp (Tanzania),
  // exactly like Tando (Kenya). Now lives in `chapsmart-offramp.ts` +
  // ClaimPayoutModal's native ChapsmartMpesaPicker (`<phone>@chapsmart.com`),
  // NOT a redirect — so it is intentionally NOT registered here (a redirect
  // entry would double-list it against the native card).

  // ── Kenya ── Bitika is the redirect offramp here. Tando is Kenya's
  // lead cash-out but it is a LUD-16 NATIVE offramp (one-tap M-Pesa via
  // `<phone>@bitcoin.co.ke`), wired in tando-offramp.ts + ClaimPayoutModal
  // — NOT a redirect, so it is intentionally absent from this registry.
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

  // The Kenya Bitsacco route uses the ke-kes-bitsacco slug. Surface the
  // Bitika redirect there too; Tando (native M-Pesa) is added separately
  // in the claim flow for any Kenyan context.
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
 * Recommended providers float to the top of the returned array so the
 * picker renders them first.
 */
/** Master switch for the external offramp redirects (Banxaas, Chapsmart,
 *  Bitika, Bitzed). ON as of the Day-1 fiat-ramps decision (2026-06-24):
 *  these are surfaced POST-CLAIM only, in the ClaimPayoutModal picker, as
 *  honest "open the provider, cash out, paste your invoice back" redirects.
 *  There is no pre-LOCK call site any more. NOTE: Tando's native M-Pesa
 *  offramp does NOT gate on this flag — it is the Lightning-Address payout
 *  path (tando-offramp.ts), always available in Kenyan contexts. */
export const EXTERNAL_SWAPS_ENABLED = true;

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
    } else if (!tradeSlug && homeSlug && provider.communitySlug === homeSlug) {
      // Home + currency are FALLBACKS, used only when the trade carries no
      // community of its own. When it does, the trade's country is authoritative
      // — a foreign trade must never surface the user's home-country offramp
      // (e.g. a Kenyan-home user cashing out a Cameroon trade sees only the
      // Cameroon redirect, not Bitika/Kenya).
      reason = "home-community";
    } else if (!tradeSlug && currency && provider.currency.toUpperCase() === currency) {
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
  //   2. Within the same reason tier, recommended providers float to the
  //      top. Banxaas gets the top slot in Senegal because it's the
  //      recommended provider there.
  //   3. Within the same tier and score, keep registry order.
  const reasonScore: Record<ExternalSwapMatchReason, number> = {
    "trade-community": 3,
    "home-community": 2,
    "fiat-currency": 1,
  };
  matches.sort((a, b) => {
    const reasonDelta = reasonScore[b.reason] - reasonScore[a.reason];
    if (reasonDelta !== 0) return reasonDelta;
    const aScore = a.provider.recommended ? 1 : 0;
    const bScore = b.provider.recommended ? 1 : 0;
    return bScore - aScore;
  });

  return matches;
}

/**
 * Open the provider's swap URL. Centralised so the new-tab guards live in one
 * place. v4.1 B (#16): routes through `openExternalUrl`, which hands the URL to
 * the OS opener under Tauri (where `window.open` is a silent no-op, leaving
 * every redirect offramp dead on desktop/APK) and uses a normal new tab in the
 * browser. The provider's `swapUrl` is a trusted registry value, safe to hand
 * to the OS.
 */
export function openExternalSwap(provider: ExternalSwapProvider): void {
  if (typeof window === "undefined") return;
  void openExternalUrl(provider.swapUrl);
}
