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
import { readVerifiedRoster, resolveRosterAuthority } from "./roster.js";

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

  const sources = getTrustedArbiterPoolSources(options);
  return unique([
    ...sources.rosterArbiters,
    ...sources.deviceTrusted,
  ])
    .filter((pk) => !excluded.has(pk));
}

/** The trusted pool split by WHERE the trust comes from. v3.5 (C7): the green
 *  "community-verified" badge must refuse when it depends on a roster signed
 *  by a party to the trade — that needs the roster keys (and their signer)
 *  kept distinct from the device-anchored pools. */
export interface TrustedArbiterPoolSources {
  /** official + local + env — trust anchored on THIS device / build. */
  deviceTrusted: string[];
  /** Arbiters vouched for by the community's verified kind:38120 roster. */
  rosterArbiters: string[];
  /** Signer of the winning roster event; null when no verifiable roster. */
  rosterSigner: string | null;
}

export function getTrustedArbiterPoolSources(
  options: TrustedArbiterPoolOptions = {},
): TrustedArbiterPoolSources {
  const roster = readVerifiedRosterSource(options.community);
  return {
    deviceTrusted: unique([
      ...readOfficialPool(options.community),
      ...readLocalPool(options.community),
      ...readEnvPool(options.community),
    ]),
    rosterArbiters: roster.arbiters,
    rosterSigner: roster.signer,
  };
}

/** Roster-sourced pool with the hybrid authority resolved from the registry.
 *  Exported so provenance surfaces can show WHICH arbiters are roster-backed
 *  (vs device-trusted) when #73's tier badges land. */
export function readVerifiedRosterPool(community?: string | null): string[] {
  return readVerifiedRosterSource(community).arbiters;
}

/** Roster arbiters + the key that vouched for them. The V3 keystone source:
 *  the community's SIGNED kind:38120 roster — cached locally, re-verified
 *  against the hybrid authority (registry steward pin, else shell creator) on
 *  every read. Empty when no verifiable roster exists. */
export function readVerifiedRosterSource(
  community?: string | null,
): { arbiters: string[]; signer: string | null } {
  if (!community) return { arbiters: [], signer: null };
  try {
    const entry = getCommunityBySlug(community);
    const authority = resolveRosterAuthority({
      stewardPubkey: entry?.stewardPubkey ?? null,
      creatorPubkey: entry?.creatorPubkey ?? null,
    });
    if (authority.length === 0) return { arbiters: [], signer: null };
    const roster = readVerifiedRoster(community, authority);
    return roster
      ? { arbiters: roster.arbiters, signer: roster.signer }
      : { arbiters: [], signer: null };
  } catch {
    return { arbiters: [], signer: null };
  }
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

// ── Arbiter assignment integrity (v3.5 — C1, consent layer) ────────────────
//
// INVARIANT(arbiter-assignment) — consent-enforced. Membership (provenance,
// above) answers "is this arbiter in a pool this device recognizes?";
// assignment answers "is it the member this escrow id actually selects?".
// The gap between the two is C1: the locker freely names ANY pool member in
// the LOCK payload, so a colluding member can be seated instead of the
// deterministically-assigned one and still badge green on membership alone.
//
// The reducer deliberately does NOT enforce assignment on LOCK — a recompute
// with today's exclusion rules rejects genuine old chains on replay, and
// ARBITER_NOT_ASSIGNED is not a benign code, so the whole chain becomes
// unloadable and locked funds strand (see handleLock's NOTE + INVARIANTS C1).
// This check therefore lives at the informed-consent layer, where a miss is a
// warning, never a strand: the at-risk party sees a loud off-assignment state
// and must explicitly acknowledge it before performing.
//
// Accept-any-of-three: every LOCK builder this app ever shipped is a valid
// historical basis for "as-assigned":
//   • pre-v0.6.5  — communityArbiters[0] (the original fallback)
//   • v0.6.5+     — pickArbiterFromPool(pool, id)            (no exclusions)
//   • v0.7.2+     — pickArbiterFromPool(pool, id, [buyer, seller])
// A committed arbiter matching NONE of these was hand-seated — the colluder
// signal C1 exists to surface. Residual, accepted: a colluder who happens to
// sit at pool[0] (or on an old pick) passes clean — assignment only ranks
// WITHIN an already-recognized pool; pool trust itself is membership + C7.

export type ArbiterAssignmentStatus =
  /** Committed arbiter matches a historical deterministic assignment. */
  | "as-assigned"
  /** Committed arbiter matches NO historical basis — hand-seated. */
  | "off-assignment"
  /** Nothing to judge: no pool, or no committed arbiter yet. */
  | "not-applicable";

export interface ArbiterAssignment {
  status: ArbiterAssignmentStatus;
  /** Every pubkey a historical assignment basis selects (deduped, hex). */
  accepted: string[];
}

export function classifyArbiterAssignment(params: {
  pool: readonly string[];
  escrowId: string;
  /** The LOCK-committed arbiter (state.participants[ARBITER] post-lock). */
  committedArbiter: string | null | undefined;
  buyerPubkey?: string | null;
  sellerPubkey?: string | null;
}): ArbiterAssignment {
  const pool = [...params.pool];
  const committed = params.committedArbiter
    ? normalizePubkey(params.committedArbiter) ?? params.committedArbiter.trim().toLowerCase()
    : null;
  if (!committed || pool.length === 0) {
    return { status: "not-applicable", accepted: [] };
  }
  const bases = [
    pool[0],
    pickArbiterFromPool(pool, params.escrowId),
    pickArbiterFromPool(pool, params.escrowId, [params.buyerPubkey, params.sellerPubkey]),
  ];
  const accepted = unique(
    bases
      .map((pk) => (pk ? normalizePubkey(pk) ?? pk.trim().toLowerCase() : null))
      .filter((pk): pk is string => !!pk),
  );
  return {
    status: accepted.includes(committed) ? "as-assigned" : "off-assignment",
    accepted,
  };
}

// ── Roster conflict-of-interest (v3.5 — C7, consent layer) ─────────────────
//
// INVARIANT(roster-distinct-authority) — a permissionless shell's roster
// authority is its CREATOR, and nothing stops that same key from creating
// (or joining) trades in its own community. Self-rostered sock-puppet
// arbiters would earn the green "community-verified" badge from every honest
// client that fetched the roster. The badge must refuse whenever the green
// verdict DEPENDS on a roster signed by a party to the very trade being
// judged: a vouch from your counterparty is not a vouch.
//
// Deliberately NOT flagged: a roster signer who is the trade's seated
// ARBITER but not buyer/seller/creator. A steward who arbitrates in their
// own small community is the normal trust anchor, not a conflict — the
// conflicted identities are the ones with a stake in the outcome.
//
// Known residual (accepted, document — don't pretend it's closed): a
// CROSS-IDENTITY Sybil defeats this check. Key#1 creates the shell (becomes
// the roster authority) and rosters sock puppets; key#2 — the accomplice —
// creates the trade. The signer is then not a trade party, so the badge
// stays green. Closing that requires an authority anchored OUTSIDE the
// attacker's keyspace: the registry steward pin / federation-owner
// credential (chama-governance-levels). Until then the roster of a
// permissionless shell certifies "the shell's creator vouches", no more.

/** True when at least one of the trade's pool members is recognized ONLY via
 *  a roster whose signer is a party to this trade (creator / buyer / seller).
 *  Pure; the caller resolves sources via getTrustedArbiterPoolSources. */
export function classifySelfRoster(params: {
  communityArbiters: readonly string[] | null | undefined;
  sources: Pick<TrustedArbiterPoolSources, "deviceTrusted" | "rosterArbiters" | "rosterSigner">;
  /** Stake-holding identities: trade creator + buyer + seller. */
  tradeParties: readonly (string | null | undefined)[];
}): boolean {
  const signer = params.sources.rosterSigner
    ? normalizePubkey(params.sources.rosterSigner) ?? params.sources.rosterSigner.trim().toLowerCase()
    : null;
  if (!signer) return false;
  const parties = new Set(
    params.tradeParties
      .map((pk) => (pk ? normalizePubkey(pk) ?? pk.trim().toLowerCase() : null))
      .filter((pk): pk is string => !!pk),
  );
  if (!parties.has(signer)) return false;
  const norm = (list: readonly string[]) =>
    new Set(list.map((pk) => normalizePubkey(pk) ?? pk.trim().toLowerCase()));
  const device = norm(params.sources.deviceTrusted);
  const roster = norm(params.sources.rosterArbiters);
  for (const raw of params.communityArbiters ?? []) {
    const pk = normalizePubkey(raw) ?? raw.trim().toLowerCase();
    if (!pk) continue;
    // Recognition that survives WITHOUT the conflicted roster is fine; the
    // flag fires only when the roster is load-bearing for this pool member.
    if (roster.has(pk) && !device.has(pk)) return true;
  }
  return false;
}

// ── Verified-roster consent gate (v3.5 — C7, wired ahead of the economic
//    layer) ─────────────────────────────────────────────────────────────────
//
// When fees/bonds turn on, collusion becomes profitable, and "this device
// happens to trust the pool" stops being enough: fee-bearing or high-value
// trades should require a community roster verified by an authority DISTINCT
// from the trade's parties, with enough members for real substitution.
// Wired now so the gate exists the day the economic layer lands; with fees
// off it only arms on genuinely high-value trades.
//
// This is a CONSENT gate (explicit acknowledge), never a hard disable — a
// false positive must never strand a performer's recourse (their RELEASE
// vote is their dispute escalation). Small pools are awareness only: the
// default community pool is 2 members and must keep working untouched.

/** High-value threshold for the consent gate, in msats (2,000,000 sats).
 *  Tune alongside the economic layer; deliberately high so the gate stays
 *  quiet for everyday trades while fees are off. */
export const HIGH_VALUE_CONSENT_MSATS = 2_000_000_000;

/** Minimum pool size for fee-bearing / high-value trades to pass without
 *  the consent gate. NEVER applied to ordinary trades. */
export const FEE_TRADE_MIN_POOL = 3;

export function requiresVerifiedRosterConsent(params: {
  arbiterFeeMsats?: number | null;
  amountMsats: number;
  poolSize: number;
  /** provenance.verified AND not self-rostered — the C7 "real" green. */
  distinctAuthorityVerified: boolean;
}): boolean {
  const feeBearing = typeof params.arbiterFeeMsats === "number" && params.arbiterFeeMsats > 0;
  const highValue = params.amountMsats >= HIGH_VALUE_CONSENT_MSATS;
  if (!feeBearing && !highValue) return false;
  return !(params.distinctAuthorityVerified && params.poolSize >= FEE_TRADE_MIN_POOL);
}
