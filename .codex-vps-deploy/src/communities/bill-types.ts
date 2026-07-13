// ══════════════════════════════════════════════════════════════════════════
// Community Bill Pay — bill types (#12), per-country registry
// ══════════════════════════════════════════════════════════════════════════
//
// A bill type makes a CBP listing legible ("what am I paying?"), helps a
// volunteer payer decide, and enables Browse filtering later. INFORMATIONAL
// METADATA ONLY — it never touches escrow logic. Optional on every listing;
// "Other" catches the long tail. Keyed by the home community's ISO country so
// Senegal / Benin / etc. localise their own later; an unlisted country falls
// back to a generic set. Kenya ships first (Nairobi launch).

export interface BillType {
  /** Stable slug persisted on the listing (e.g. "electricity-kplc"). Never change. */
  id: string;
  /** Human label shown in the picker + on the card/detail. */
  label: string;
  /** Leading emoji. */
  icon: string;
}

// 🇰🇪 Kenya — Nairobi-first (Jetty to confirm the exact set on-device).
const KENYA: BillType[] = [
  { id: "electricity-kplc", label: "Electricity — KPLC", icon: "⚡" },
  { id: "water",            label: "Water",              icon: "💧" },
  { id: "school-fees",      label: "School fees",        icon: "🎓" },
  { id: "rent",             label: "Rent",               icon: "🏠" },
  { id: "tv",               label: "TV (DSTV/GOtv/Zuku)", icon: "📺" },
  { id: "internet",         label: "Internet / fibre",   icon: "🌐" },
  { id: "airtime-data",     label: "Airtime & data",     icon: "📱" },
  { id: "health-sha",       label: "Health — SHA/SHIF",  icon: "🛡️" },
  { id: "cooking-gas",      label: "Cooking gas (LPG)",  icon: "🔥" },
  { id: "other",            label: "Other",              icon: "🧾" },
];

// Generic fallback for communities without a localised list yet.
const GENERIC: BillType[] = [
  { id: "utilities",   label: "Utilities",      icon: "💡" },
  { id: "rent",        label: "Rent",           icon: "🏠" },
  { id: "school-fees", label: "School fees",    icon: "🎓" },
  { id: "airtime",     label: "Airtime & data", icon: "📱" },
  { id: "other",       label: "Other",          icon: "🧾" },
];

// ISO 3166-1 alpha-2 country code → localised list.
const BY_COUNTRY: Record<string, BillType[]> = {
  KE: KENYA,
};

/** The bill-type options for a community's country (alpha-2); generic fallback
 *  when that country has no localised list yet. */
export function billTypesForCountry(country: string | null | undefined): BillType[] {
  if (!country) return GENERIC;
  return BY_COUNTRY[country.toUpperCase()] ?? GENERIC;
}

/** Resolve a stored bill-type id to its {label, icon}, searching ALL lists — so a
 *  card renders correctly even when the viewer's country differs from the poster's.
 *  An unknown id (a future / foreign list) renders raw with a neutral icon. Empty
 *  / missing id ⇒ null. */
export function billTypeDisplay(id: string | null | undefined): { label: string; icon: string } | null {
  if (!id) return null;
  for (const list of [KENYA, GENERIC]) {
    const hit = list.find(b => b.id === id);
    if (hit) return { label: hit.label, icon: hit.icon };
  }
  return { label: id, icon: "🧾" };
}
