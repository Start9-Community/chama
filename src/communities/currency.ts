// ══════════════════════════════════════════════════════════════════════════
// Chama — Community currency helpers
// ══════════════════════════════════════════════════════════════════════════

import { getCommunityBySlug } from "./registry.js";

export function defaultCurrencyForCommunity(
  slug: string | null | undefined,
  fallback = "USD",
): string {
  return getCommunityBySlug(slug)?.currency ?? fallback;
}
