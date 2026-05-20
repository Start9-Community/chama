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
  if (getCommunityBySlug(slug)?.federationInvite === BLF_FEDERATION_INVITE) {
    return BLF_OFFICIAL_ARBITERS;
  }
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
export function pickArbiterFromPool(pool: string[], escrowId: string): string | undefined {
  if (pool.length === 0) return undefined;
  if (pool.length === 1) return pool[0];
  let hash = 0;
  for (let i = 0; i < escrowId.length; i++) {
    hash = (hash + escrowId.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % pool.length;
  return pool[idx];
}
