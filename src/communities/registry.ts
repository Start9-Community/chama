// ══════════════════════════════════════════════════════════════════════════
// Chama — Community Registry
// ══════════════════════════════════════════════════════════════════════════
//
// Per PHILOSOPHY.md §2.3: Communities are the user-facing layer; federations
// are the technical layer. A community is currency-primary, country-and-
// language-multivalent. Users pick a community at sign-in; Chama silently
// provisions a wallet on the appropriate backing federation.
//
// v0.1.85 schema additions: flagEmoji, country, browserReliable, notes,
// disambiguator, hiddenFromPicker. The brief's pre-seed list is curated
// to federations Jetty has operational relationships with or proven
// testing history — every other federation is left to its community
// leader to claim permissionlessly via addCustomCommunity().
//
// federationInvite is non-null for every pre-seeded entry in v0.1.85.
// The legacy `null` semantics (fall through to a default) survive only
// for back-compat with on-the-wire listings that carry an unknown slug —
// in that case `resolveFederationForCommunity` returns BP per
// federation-config.ts.

// Pull invite constants from the dedicated module rather than
// federation-config.js — the latter imports back into registry for
// resolveFederationForCommunity, and we'd hit a TDZ on COMMUNITY_REGISTRY
// initialization if we let that cycle stand.
import { BP_FEDERATION_INVITE, BLF_FEDERATION_INVITE } from "../fedimint/federation-invites.js";

export interface Community {
  /** Stable wire identifier — must never change once published. Lower-case
   *  region-or-scope hyphen currency. Examples: sn-cfa, ke-kes, sv-usd,
   *  global-usd, us-blf. */
  slug: string;
  /** Human-readable display name in the UI. Localizable in v2. */
  displayName: string;
  /** Three-letter currency code (ISO 4217) — the load-bearing axis. */
  currency: string;
  /** ISO 3166-1 alpha-2 country codes the community spans. May be empty
   *  for genuinely scope-less communities (global-usd). */
  countries: string[];
  /** ISO 639-1 language codes spoken by the community. Listings and chat
   *  happen in any of these — Chama does not enforce one. */
  languages: string[];
  /** Federation invite code that backs this community's wallet. `null`
   *  falls through to BP per resolveFederationForCommunity — used only
   *  for legacy/wire-stale slugs; every pre-seeded entry pins explicitly. */
  federationInvite: string | null;
  /** Single flag emoji for the community pill. 🌎 / 🌍 are valid for
   *  scope-less or regional communities. */
  flagEmoji: string;
  /** ISO country code for the primary flag-display country. `null` for
   *  global / regional aggregators. */
  country: string | null;
  /** True when the backing federation works reliably from browsers.
   *  v0.5.0: now true across the board after the Fedimint canary SDK
   *  bumped iroh-relay to 0.90 and resolved the 400 Bad Request that
   *  previously gated browser transport. The flag stays in the schema
   *  so individual entries can flip back to false if a specific
   *  federation regresses. APK users are unaffected either way. */
  browserReliable: boolean;
  /** Optional internal note, NOT shown to users. Tracks why a federation
   *  has the reliability flag it does, etc. */
  notes: string | null;
  /** Optional disambiguator suffix when multiple federations serve one
   *  country (e.g. Kenya · Afribit vs Kenya · Bitsacco). Null until
   *  needed; gets set when a second federation for the same country is
   *  added. */
  disambiguator: string | null;
  /** When true, the entry resolves on-the-wire (existing listings still
   *  render correctly) but is hidden from the community picker. Used
   *  for slugs we're sunsetting from the curated list while preserving
   *  back-compat. */
  hiddenFromPicker: boolean;
}

/** Shared notes string. v0.5.0 reality: the Fedimint canary SDK
 *  (0.0.0-canary-cf43f9193627f8081b7144f7c057a7a112989031) bumped
 *  iroh-relay to 0.90, which clears the 400 Bad Request that gated
 *  browser WebSocket transport across every federation we have access
 *  to (BP, BLF, Afribit, etc.). End-to-end browser flows — join,
 *  mint, claim — verified working. The flag stays in the schema so
 *  individual entries can flip back to false if a specific federation
 *  ever regresses. */
const IROH_LIMITATION_NOTE =
  "Browser Fedimint reliable via canary iroh bump.";

/** v0.1.85 pre-seed list. Curated to federations Jetty operates or
 *  has proven testing history with; permissionless additions go via
 *  `addCustomCommunity()` to localStorage. Other countries listed in
 *  the brief (Bitsacco Kenya, Galoy US, regional aggregators) get
 *  added when their community leaders claim them.
 *
 *  PRE-SEED ORDER MATTERS: this is the order they render in the picker. */
export const COMMUNITY_REGISTRY: Community[] = [
  {
    slug: "us-blf",
    displayName: "US · Bitcoin Life · USD",
    currency: "USD",
    countries: ["US"],
    languages: ["en"],
    federationInvite: BLF_FEDERATION_INVITE,
    flagEmoji: "🇺🇸",
    country: "US",
    browserReliable: true,
    notes: IROH_LIMITATION_NOTE,
    disambiguator: "Bitcoin Life",
    hiddenFromPicker: false,
  },
  {
    slug: "sn-cfa",
    displayName: "Senegal · CFA",
    currency: "XOF",
    countries: ["SN"],
    languages: ["fr", "wo"],
    federationInvite: BP_FEDERATION_INVITE,
    flagEmoji: "🇸🇳",
    country: "SN",
    browserReliable: true,
    notes: IROH_LIMITATION_NOTE,
    disambiguator: null,
    hiddenFromPicker: false,
  },
  {
    slug: "global-usd",
    displayName: "Global · USD",
    currency: "USD",
    countries: [],
    languages: ["en", "es"],
    federationInvite: BP_FEDERATION_INVITE,
    flagEmoji: "🌎",
    country: null,
    browserReliable: true,
    notes: IROH_LIMITATION_NOTE,
    disambiguator: null,
    hiddenFromPicker: false,
  },
  {
    slug: "ke-kes",
    displayName: "Kenya · Afribit · KES",
    currency: "KES",
    countries: ["KE"],
    languages: ["sw", "en"],
    // Afribit invite — Adopting Bitcoin Nairobi demo partner.
    federationInvite:
      "fed11qgqyj3mfwfhksw309ucrxe35vgcryvesxf3nyepsv3jnyepsvgcnxdpjv5urjcfkv4nrydmxxvervef3xcmxxce5x5ergwfnxcukzetr8qen2vnpvsmr2vrzqyqjplegdfhg4qq8f0zeuvjxn8e49sa3tnep7w08dca79wecgjkyszrufgwesp",
    flagEmoji: "🇰🇪",
    country: "KE",
    browserReliable: true,
    notes: IROH_LIMITATION_NOTE,
    disambiguator: "Afribit",
    hiddenFromPicker: false,
  },
  // Sunset entry — kept alive so old listings carrying community: "sv-usd"
  // still resolve, but hidden from the curated picker until a community
  // leader claims El Salvador.
  {
    slug: "sv-usd",
    displayName: "El Salvador · USD",
    currency: "USD",
    countries: ["SV"],
    languages: ["es"],
    federationInvite: null,
    flagEmoji: "🇸🇻",
    country: "SV",
    browserReliable: true,
    notes: IROH_LIMITATION_NOTE,
    disambiguator: null,
    hiddenFromPicker: true,
  },
];

const BY_SLUG: Map<string, Community> = new Map(
  COMMUNITY_REGISTRY.map(c => [c.slug, c])
);

/** Look up a community by slug. Walks pre-seeds first, then user-added
 *  custom communities in localStorage. Returns null if the slug is
 *  unknown — callers must handle null (typically by treating the
 *  listing as cross-community and rendering a neutral pill). */
export function getCommunityBySlug(slug: string | null | undefined): Community | null {
  if (!slug) return null;
  const preSeed = BY_SLUG.get(slug);
  if (preSeed) return preSeed;
  // Permissionless additions live in localStorage; resolve on demand.
  return getCustomCommunityBySlug(slug);
}

/** Default community when the user hasn't picked one yet. global-usd
 *  exists precisely so first-launch users always have a sensible
 *  fallback that won't geofence them out of any listing. */
export const DEFAULT_COMMUNITY_SLUG = "us-blf";

/** Pre-seeded entries that should appear in the picker (excludes
 *  hiddenFromPicker entries). Custom communities get appended on top
 *  by callers via getCustomCommunities(). */
export function getPickerCommunities(): Community[] {
  return COMMUNITY_REGISTRY.filter(c => !c.hiddenFromPicker);
}

// ══════════════════════════════════════════════════════════════════════════
// PERMISSIONLESS COMMUNITY ADDITION (v0.1.85)
// ══════════════════════════════════════════════════════════════════════════
//
// Per PHILOSOPHY.md §2.3 and the v0.2.0 brief: any user can add a custom
// community to their local picker. v0.1.85 ships the localStorage-backed
// primitive; v0.2.0 wires a Sandbox-mode UI for testing; v1.5 adds the
// Nostr-published kind:38112 community-claim layer for cross-client
// discovery.
//
// Storage: a JSON array of Community records under a single key. Custom
// entries always have hiddenFromPicker:false (the user added them on
// purpose) and a `notes` field set to "user-added" so they're visually
// distinguishable from pre-seeds in debug surfaces.

const CUSTOM_COMMUNITIES_STORAGE_KEY = "chama_custom_communities";

export interface AddCustomCommunityInput {
  slug: string;
  displayName: string;
  currency: string;
  country: string | null;
  flagEmoji: string;
  federationInvite: string;
  /** Defaults to true — user-added communities are assumed browser-friendly
   *  unless the user knows otherwise. */
  browserReliable?: boolean;
  /** Optional language list; defaults to []. */
  languages?: string[];
  /** Optional disambiguator suffix. */
  disambiguator?: string | null;
}

/** Read all user-added communities from localStorage. Silently returns []
 *  on any parse error or if storage is unavailable. */
export function getCustomCommunities(): Community[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(CUSTOM_COMMUNITIES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCommunityShape);
  } catch {
    return [];
  }
}

/** Look up a custom (user-added) community by slug. */
export function getCustomCommunityBySlug(slug: string): Community | null {
  return getCustomCommunities().find(c => c.slug === slug) ?? null;
}

/** Persist a new custom community. Throws on shape errors (invalid slug,
 *  invite that doesn't start with `fed1`, slug colliding with a pre-seed).
 *  Slug collision with another custom community OVERWRITES the previous
 *  entry — the user is intentionally updating it. */
export function addCustomCommunity(input: AddCustomCommunityInput): Community {
  const slug = (input.slug || "").trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(slug)) {
    throw new Error("slug must be lowercase letters, digits, and hyphens only");
  }
  if (BY_SLUG.has(slug)) {
    throw new Error(`slug "${slug}" collides with a pre-seeded community`);
  }
  const invite = (input.federationInvite || "").trim();
  if (!invite.startsWith("fed1")) {
    throw new Error("federationInvite must start with fed1");
  }
  const entry: Community = {
    slug,
    displayName: input.displayName.trim(),
    currency: input.currency.trim().toUpperCase(),
    countries: input.country ? [input.country] : [],
    languages: input.languages ?? [],
    federationInvite: invite,
    flagEmoji: input.flagEmoji,
    country: input.country,
    browserReliable: input.browserReliable ?? true,
    notes: "user-added",
    disambiguator: input.disambiguator ?? null,
    hiddenFromPicker: false,
  };
  const all = getCustomCommunities().filter(c => c.slug !== slug);
  all.push(entry);
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(CUSTOM_COMMUNITIES_STORAGE_KEY, JSON.stringify(all));
    }
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }
  return entry;
}

/** Remove a user-added community by slug. No-op if the slug isn't user-added. */
export function removeCustomCommunity(slug: string): void {
  const all = getCustomCommunities().filter(c => c.slug !== slug);
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(CUSTOM_COMMUNITIES_STORAGE_KEY, JSON.stringify(all));
    }
  } catch { /* no-op */ }
}

function isCommunityShape(c: any): c is Community {
  return (
    typeof c === "object" && c !== null &&
    typeof c.slug === "string" &&
    typeof c.displayName === "string" &&
    typeof c.currency === "string" &&
    Array.isArray(c.countries) &&
    Array.isArray(c.languages) &&
    (c.federationInvite === null || typeof c.federationInvite === "string") &&
    typeof c.flagEmoji === "string" &&
    (c.country === null || typeof c.country === "string") &&
    typeof c.browserReliable === "boolean" &&
    (c.notes === null || typeof c.notes === "string") &&
    (c.disambiguator === null || typeof c.disambiguator === "string") &&
    typeof c.hiddenFromPicker === "boolean"
  );
}
