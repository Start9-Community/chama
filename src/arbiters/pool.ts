// Chama — trusted arbiter pool
//
// v1 keeps arbiter assignment simple: community listings carry a pool of
// eligible arbiters, and LOCK auto-assigns from that pool without requiring
// the arbiter to publish a JOIN first. BLF has a baked official pool;
// operators can add more arbiters at build time with
// VITE_CHAMA_TRUSTED_ARBITERS or set chama_trusted_arbiters in localStorage
// while testing.

import { nip19 } from "nostr-tools";
import { getCommunityBySlug } from "../communities/registry.js";
import { BLF_FEDERATION_INVITE } from "../fedimint/federation-invites.js";

export const TRUSTED_ARBITERS_STORAGE_KEY = "chama_trusted_arbiters";
export const TRUSTED_ARBITERS_ENV_KEY = "VITE_CHAMA_TRUSTED_ARBITERS";
export const BLF_OFFICIAL_ARBITER_NPUBS = [
  "npub1ytm3v8mkup6mnc9z2zjy0zz2czdsfd3kal7hcup6jgu5a5lm885qhup3z6",
  "npub1z75k4fqjmyvfcv5e57tampeqatnfsrt6mt78dmz4ps9nezskjncqqtvwsz",
];

export interface TrustedArbiterPoolOptions {
  community?: string | null;
  excludePubkeys?: Array<string | null | undefined>;
}

function normalizePubkey(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed.toLowerCase();
  if (trimmed.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(trimmed);
      return decoded.type === "npub" && typeof decoded.data === "string"
        ? decoded.data.toLowerCase()
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

function splitConfiguredPubkeys(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map(normalizePubkey)
    .filter((pk): pk is string => pk !== null);
}

export const BLF_OFFICIAL_ARBITERS = unique(
  splitConfiguredPubkeys(BLF_OFFICIAL_ARBITER_NPUBS.join(","))
);

function communityEnvKey(community: string | null | undefined): string | null {
  if (!community) return null;
  const suffix = community.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return suffix ? `${TRUSTED_ARBITERS_ENV_KEY}_${suffix}` : null;
}

function communityStorageKey(community: string | null | undefined): string | null {
  if (!community) return null;
  const slug = community.trim();
  return slug ? `${TRUSTED_ARBITERS_STORAGE_KEY}:${slug}` : null;
}

function readEnvPool(community?: string | null): string[] {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const scopedKey = communityEnvKey(community);
  return splitConfiguredPubkeys([
    env?.[TRUSTED_ARBITERS_ENV_KEY],
    scopedKey ? env?.[scopedKey] : undefined,
  ].filter(Boolean).join(","));
}

function readLocalPool(community?: string | null): string[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const scopedKey = communityStorageKey(community);
    return splitConfiguredPubkeys([
      localStorage.getItem(TRUSTED_ARBITERS_STORAGE_KEY),
      scopedKey ? localStorage.getItem(scopedKey) : null,
    ].filter(Boolean).join(","));
  } catch {
    return [];
  }
}

function readOfficialPool(community?: string | null): string[] {
  const slug = community?.trim();
  if (!slug) return [];
  const record = getCommunityBySlug(slug);
  if (!record) return [];
  if (record.federationInvite === BLF_FEDERATION_INVITE) {
    return BLF_OFFICIAL_ARBITERS;
  }
  // v0.8.0: native-federation communities (future Bitsacco, etc.) still
  // need Chama's bootstrap arbiter pool until the v2 live election path
  // replaces hardcoded lists. The federation route and the social arbiter
  // pool are separate product layers.
  if (!record.hiddenFromPicker) return BLF_OFFICIAL_ARBITERS;
  return [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function getTrustedArbiterPool(options: TrustedArbiterPoolOptions = {}): string[] {
  const excluded = new Set(
    (options.excludePubkeys ?? [])
      .map((pk) => pk?.toLowerCase())
      .filter((pk): pk is string => !!pk)
  );

  return unique([
    ...readOfficialPool(options.community),
    ...readLocalPool(options.community),
    ...readEnvPool(options.community),
  ])
    .filter((pk) => !excluded.has(pk));
}

export function normalizeTrustedArbiterInput(raw: string): string[] {
  return unique(splitConfiguredPubkeys(raw));
}

// ── Arbiter provenance (v2.3 — close the "arbiter door") ───────────────────
//
// A trade's `communityArbiters` ride in on the CREATE payload, set by the
// creator's own client. The reducer only checks that the LOCK's chosen
// arbiter is a member of THAT pool — never that the pool itself is the
// community's real one. A hostile creator can therefore stuff the pool with
// sock-puppet keys they control; in any dispute "the neutral arbiter" is
// theirs, and a party who also seats the arbiter slot holds 2 of 3 shares.
//
// We close this with informed consent rather than a hard reducer reject
// (which would turn version/registry drift into a DoS and a funds-stranding
// footgun — the threat here is TRUST, not validity). classifyArbiterProvenance
// is the pure heart: compare a trade's pool against the set THIS device
// trusts for the community, and let the UI badge a clean trade or warn before
// money goes at risk. The official community pool is the shared baseline, so
// two honest clients on it always agree (green); a stuffed pool surfaces its
// unrecognized keys to the counterparty the instant they look.

export interface ArbiterProvenance {
  /** Trade arbiters that ARE in this device's trusted pool for the community. */
  recognized: string[];
  /** Trade arbiters NOT in the trusted pool — the sock-puppet signal. */
  unrecognized: string[];
  /** True only when the trade names a non-empty pool AND every member is
   *  recognized. An empty pool (raw/legacy escrow, no community arbiter) is
   *  NOT "verified" — there is simply nothing to verify; see hasPool. */
  verified: boolean;
  /** Whether the trade carries any community arbiters at all. Lets the UI
   *  distinguish "no community arbiter" (neutral) from "verified" (green)
   *  from "has unrecognized members" (warn). */
  hasPool: boolean;
}

/** Classify a trade's committed arbiter pool against a trusted reference set.
 *  Pure: the caller resolves `trustedPool` (typically
 *  getTrustedArbiterPool({ community })). Pubkeys are compared
 *  case-insensitively; non-hex / npub inputs are normalized first so a trade
 *  that stored npubs and a device that stored hex still match. */
export function classifyArbiterProvenance(
  communityArbiters: readonly string[] | null | undefined,
  trustedPool: readonly string[],
): ArbiterProvenance {
  const trusted = new Set(
    trustedPool
      .map((pk) => normalizePubkey(pk) ?? pk.trim().toLowerCase())
      .filter((pk) => !!pk),
  );
  const recognized: string[] = [];
  const unrecognized: string[] = [];
  const seen = new Set<string>();
  for (const raw of communityArbiters ?? []) {
    const pk = normalizePubkey(raw) ?? raw.trim().toLowerCase();
    if (!pk || seen.has(pk)) continue;
    seen.add(pk);
    (trusted.has(pk) ? recognized : unrecognized).push(pk);
  }
  const hasPool = recognized.length > 0 || unrecognized.length > 0;
  return {
    recognized,
    unrecognized,
    verified: hasPool && unrecognized.length === 0,
    hasPool,
  };
}

/**
 * v0.6.5: deterministic round-robin selection from a community arbiter
 * pool. Same escrow id always picks the same arbiter — important so
 * repeated relay replays of LOCK pick a consistent slot rather than
 * drifting. No server-side state required.
 *
 * Algorithm is intentionally simple (charcode sum mod pool length):
 * the input is a UUID-ish escrow id and the pool is tiny (≤ a few
 * dozen). A cryptographic hash would be overkill — distribution is
 * close enough to uniform for fair load-spreading across the pool.
 */
export function pickArbiterFromPool(
  pool: string[],
  escrowId: string,
  excludePubkeys: Array<string | null | undefined> = [],
): string | undefined {
  const excluded = new Set(
    excludePubkeys
      .map((pk) => pk?.toLowerCase())
      .filter((pk): pk is string => !!pk)
  );
  const candidates = pool.filter((pk) => !excluded.has(pk.toLowerCase()));
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  let hash = 0;
  for (let i = 0; i < escrowId.length; i++) {
    hash = (hash + escrowId.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % candidates.length;
  return candidates[idx];
}
