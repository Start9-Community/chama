// ══════════════════════════════════════════════════════════════════════════
// Chama — country → community resolution + search (shared)
// ══════════════════════════════════════════════════════════════════════════
//
// The picker deals in COUNTRIES (all 190, PickerCountry); the rest of the app
// deals in COMMUNITIES / chamas (a slug + optional Fedimint fed, real or a
// generated shell). These helpers bridge the two so any surface that lets a user
// point at a country — the market switcher, the bond-announcement picker — turns
// that into a stable community slug the same way.
//
// A "Chama" is any community living inside a country, with OR without a G-Bot
// fed; every country therefore resolves to at least its default community.

import { addCustomCommunity, getCommunityBySlug, DEFAULT_COMMUNITY_SLUG } from "./registry.js";
import type { PickerCountry } from "./countries.js";

/** Case-insensitive match over a country's name, ISO code, and currency. */
export function countryMatchesSearch(country: PickerCountry, search: string): boolean {
  return [country.code, country.name, country.currency]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(search);
}

/** Short "USD · US" sub-label for a country row. */
export function countrySubline(country: PickerCountry): string {
  return `${country.currency} · ${country.code}`;
}

/** Resolve a picked country to the community slug to act on: its real elected-
 *  local chama if one exists, else its default community. A generated shell is
 *  persisted (addCustomCommunity) so the slug resolves downstream; on any failure
 *  we fall back to the global default so the caller is never handed a dead slug. */
export function resolveCountryCommunitySlug(country: PickerCountry): string {
  const realLocal = country.realChamas[0];
  if (realLocal) return realLocal.slug;

  const dc = country.defaultCommunity;
  try {
    if (country.isGeneratedShell && !getCommunityBySlug(dc.slug) && dc.federationInvite) {
      addCustomCommunity({
        slug: dc.slug,
        displayName: dc.displayName,
        currency: dc.currency,
        country: dc.country,
        flagEmoji: dc.flagEmoji,
        federationInvite: dc.federationInvite,
        browserReliable: dc.browserReliable,
        languages: dc.languages,
        disambiguator: dc.disambiguator,
      });
    }
    return dc.slug;
  } catch {
    return DEFAULT_COMMUNITY_SLUG;
  }
}
