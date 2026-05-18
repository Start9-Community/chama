// Chama — trusted arbiter pool
//
// v1 keeps arbiter assignment simple: community listings carry a pool of
// eligible arbiters, and LOCK auto-assigns from that pool without requiring
// the arbiter to publish a JOIN first. Operators can bake the pool at build
// time with VITE_CHAMA_TRUSTED_ARBITERS or set chama_trusted_arbiters in
// localStorage while testing.

import { nip19 } from "nostr-tools";

export const TRUSTED_ARBITERS_STORAGE_KEY = "chama_trusted_arbiters";
export const TRUSTED_ARBITERS_ENV_KEY = "VITE_CHAMA_TRUSTED_ARBITERS";

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

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function getTrustedArbiterPool(options: TrustedArbiterPoolOptions = {}): string[] {
  const excluded = new Set(
    (options.excludePubkeys ?? [])
      .map((pk) => pk?.toLowerCase())
      .filter((pk): pk is string => !!pk)
  );

  return unique([...readLocalPool(options.community), ...readEnvPool(options.community)])
    .filter((pk) => !excluded.has(pk));
}

export function normalizeTrustedArbiterInput(raw: string): string[] {
  return unique(splitConfiguredPubkeys(raw));
}
