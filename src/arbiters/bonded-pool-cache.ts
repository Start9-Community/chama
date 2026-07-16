// ══════════════════════════════════════════════════════════════════════════
// Chama — bonded-pool cache (the CREATE-time bondedArbiters stamp hardening)
// ══════════════════════════════════════════════════════════════════════════
//
// CreateForm stamps the community's chain-verified bonded arbiters into the
// CREATE event (2B prefer-bonded + the E1 premium's bonded-only payable
// gate). That fetch is fail-soft by design, so a relay flap or esplora
// hiccup at publish time used to drop the stamp SILENTLY — the trade then
// never pays its arbiter a premium (the flaky-stamp revenue loss the
// 2026-07-13 relay scan surfaced: several unstamped CREATEs). This cache
// keeps the last successfully chain-verified bonded set per community so a
// bad network moment falls back to recent truth instead of nothing.
//
// Plain localStorage, NOT user-scoped: bonds are public chain data — the
// same for every npub on the device.
//
// Staleness tradeoff (deliberate): within the TTL a reclaimed/expired bond
// can still be stamped. The stamp is preference-only (the reducer accepts
// bonded-preferred OR the legacy pick — never a fork) and the premium is a
// few sats, so a bounded mis-payment beats silent zero-revenue. The TTL is
// 12h — half the 144-block (~1-day) minimum bond term.

import type { VerifiedBond } from "../bond-multisig/bond-announcement.js";

export const BONDED_POOL_CACHE_KEY = "chama_bonded_pool_cache_v1";
export const BONDED_POOL_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
/** Bounded: communities a device actually creates in are few. */
export const BONDED_POOL_CACHE_MAX_COMMUNITIES = 50;

/** VerifiedBond with the bigint sats fields as decimal strings. */
interface SerializedBond {
  npub: string;
  community: string;
  address: string;
  lockUntil: number;
  actualSats: string;
  claimedSats: string;
  funded: boolean;
  active: boolean;
}

interface CacheEntry {
  verifiedAt: number; // ms
  bonds: SerializedBond[];
}

type CacheStore = Record<string, CacheEntry>;

function loadCache(): CacheStore {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(BONDED_POOL_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as CacheStore;
  } catch {
    return {};
  }
}

function saveCache(store: CacheStore): void {
  try {
    if (typeof localStorage === "undefined") return;
    const slugs = Object.keys(store);
    if (slugs.length > BONDED_POOL_CACHE_MAX_COMMUNITIES) {
      const byOldest = slugs.sort((a, b) => store[a].verifiedAt - store[b].verifiedAt);
      for (const slug of byOldest.slice(0, slugs.length - BONDED_POOL_CACHE_MAX_COMMUNITIES)) {
        delete store[slug];
      }
    }
    localStorage.setItem(BONDED_POOL_CACHE_KEY, JSON.stringify(store));
  } catch (e) {
    // Best-effort cache — never let it block a fetch (let alone a publish).
    console.warn("[chama] bonded-pool-cache: save failed:", e);
  }
}

function serializeBond(b: VerifiedBond): SerializedBond {
  return {
    npub: b.npub,
    community: b.community,
    address: b.address,
    lockUntil: b.lockUntil,
    actualSats: b.actualSats.toString(),
    claimedSats: b.claimedSats.toString(),
    funded: b.funded,
    active: b.active,
  };
}

function deserializeBond(s: SerializedBond): VerifiedBond | null {
  try {
    if (typeof s?.npub !== "string" || typeof s.community !== "string") return null;
    if (typeof s.address !== "string" || !Number.isFinite(s.lockUntil)) return null;
    return {
      npub: s.npub,
      community: s.community,
      address: s.address,
      lockUntil: s.lockUntil,
      actualSats: BigInt(s.actualSats),
      claimedSats: BigInt(s.claimedSats),
      funded: !!s.funded,
      active: !!s.active,
    };
  } catch {
    return null;
  }
}

/**
 * Record a successful chain-verified fetch. An EMPTY result is never
 * written: empty is indistinguishable from a relay flap, and must not
 * clobber a known-good set (a genuinely de-bonded community simply ages
 * out at the TTL).
 */
export function writeCachedCommunityBonds(
  community: string,
  bonds: readonly VerifiedBond[],
  nowMs = Date.now(),
): void {
  if (!community || bonds.length === 0) return;
  const store = loadCache();
  store[community] = { verifiedAt: nowMs, bonds: bonds.map(serializeBond) };
  saveCache(store);
}

/**
 * The last chain-verified bonded set for `community`, or null when absent,
 * stale (past BONDED_POOL_CACHE_TTL_MS), or unreadable. Callers keep their
 * own funded/active filtering — the cache returns what was verified.
 */
export function readCachedCommunityBonds(
  community: string,
  nowMs = Date.now(),
): VerifiedBond[] | null {
  const entry = loadCache()[community];
  if (!entry || !Number.isFinite(entry.verifiedAt)) return null;
  if (nowMs - entry.verifiedAt > BONDED_POOL_CACHE_TTL_MS) return null;
  if (!Array.isArray(entry.bonds)) return null;
  const bonds: VerifiedBond[] = [];
  for (const s of entry.bonds) {
    const b = deserializeBond(s);
    if (!b) return null; // one bad record ⇒ distrust the whole entry
    bonds.push(b);
  }
  return bonds.length > 0 ? bonds : null;
}

/** Tests only. */
export function clearBondedPoolCache(): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(BONDED_POOL_CACHE_KEY);
  } catch {
    /* best-effort */
  }
}
