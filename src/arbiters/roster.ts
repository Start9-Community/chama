// ══════════════════════════════════════════════════════════════════════════
// Signed community arbiter roster — kind:38120 (V3 keystone, field-read J)
// ══════════════════════════════════════════════════════════════════════════
//
// The signed, replayable roster that lets arbiter provenance graduate from
// "matches this device's baked-in pool" toward a real trust anchor: a
// community's recognized arbiters, published as a parameterized-replaceable
// Nostr event signed by the community's roster AUTHORITY.
//
// KIND ALLOCATION — why 38120 and not the 38104 the design notes used:
// 38104 is already RESOLVE on the escrow wire (kinds 38100–38108 are the
// trade event chain; 38109/38110 are retired-but-reserved). Rosters live in
// a deliberately separate governance neighborhood at 38120+, leaving
// 38121/38122 free for the arbiter application + admission-vote events
// (#74). Trade parsers and governance parsers never see each other's kinds.
//
// AUTHORITY (decided 2026-06-08, hybrid): a roster is verified iff signed by
//   1. the community's registry-pinned steward key, when one exists
//      (curated communities — BLF official etc.), else
//   2. the community creator's pubkey (permissionless country shells via
//      addCustomCommunity, which records its creator going forward).
// Verifiers prefer the pin. No anchor → rosters stay unverifiable and the
// device's existing pools (official/local/env) carry on alone; provenance
// remains soft (#61's informed-consent posture — never a reducer reject).
//
// Replaceable semantics: newest created_at wins; ties break to the
// lexicographically smallest event id (NIP-01). The cache stores the raw
// event and re-verifies on every read — a poisoned cache buys nothing.

import { verifyEvent as verifyNostrEventSignature } from "nostr-tools/pure";
import type { NostrEvent } from "../escrow-engine/types.js";

export const ARBITER_ROSTER_KIND = 38120;
export const ARBITER_ROSTER_TYPE = "chama:arbiter-roster";
/** Sanity cap — a roster bigger than this is malformed, not ambitious. */
export const MAX_ROSTER_ARBITERS = 16;

const ROSTER_STORAGE_PREFIX = "chama_arbiter_roster_";

export interface ArbiterRosterPayload {
  type: typeof ARBITER_ROSTER_TYPE;
  /** Community slug — must equal the event's `d` tag. */
  community: string;
  /** Arbiter pubkeys (hex or npub; normalized to hex on parse). */
  arbiters: string[];
  /** Author-asserted update time (informational; ordering uses created_at). */
  updatedAt?: number;
  note?: string;
}

export interface VerifiedArbiterRoster {
  community: string;
  /** Normalized lower-case hex pubkeys, deduped, order preserved. */
  arbiters: string[];
  /** The pubkey that signed the roster event. */
  signer: string;
  createdAt: number;
  eventId: string;
}

export type RosterParseResult =
  | { ok: true; roster: VerifiedArbiterRoster }
  | { ok: false; reason: string };

// Reuse the same hex/npub normalization rules as the pool (kept local to
// avoid a pool↔roster import cycle; pool.ts merges roster output instead).
const HEX64 = /^[0-9a-f]{64}$/;

export function normalizeRosterPubkey(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return null;
  if (HEX64.test(trimmed)) return trimmed;
  // npub: defer to nostr-tools only if present at call sites that import it;
  // roster events SHOULD carry hex. npub inputs are tolerated by callers that
  // normalize before building (buildArbiterRosterEvent refuses non-hex).
  return null;
}

/** The ordered list of pubkeys allowed to sign a community's roster.
 *  Pure — caller supplies whatever anchors the registry / shell records. */
export function resolveRosterAuthority(anchors: {
  stewardPubkey?: string | null;
  creatorPubkey?: string | null;
}): string[] {
  const out: string[] = [];
  const steward = normalizeRosterPubkey(anchors.stewardPubkey);
  const creator = normalizeRosterPubkey(anchors.creatorPubkey);
  if (steward) out.push(steward);
  if (creator && creator !== steward) out.push(creator);
  return out;
}

/** Build the unsigned roster event (the steward's client signs + publishes). */
export function buildArbiterRosterEvent(params: {
  community: string;
  arbiters: string[];
  createdAt?: number;
  note?: string;
}): { kind: number; created_at: number; tags: string[][]; content: string } {
  const community = params.community.trim();
  if (!community) throw new Error("Roster community slug is required");
  const arbiters: string[] = [];
  const seen = new Set<string>();
  for (const raw of params.arbiters) {
    const pk = normalizeRosterPubkey(raw);
    if (!pk) throw new Error(`Roster arbiter is not a 64-char hex pubkey: ${raw}`);
    if (seen.has(pk)) continue;
    seen.add(pk);
    arbiters.push(pk);
  }
  if (arbiters.length === 0) throw new Error("Roster needs at least one arbiter");
  if (arbiters.length > MAX_ROSTER_ARBITERS) {
    throw new Error(`Roster exceeds the ${MAX_ROSTER_ARBITERS}-arbiter cap`);
  }
  const createdAt = params.createdAt ?? Math.floor(Date.now() / 1000);
  const payload: ArbiterRosterPayload = {
    type: ARBITER_ROSTER_TYPE,
    community,
    arbiters,
    updatedAt: createdAt,
    ...(params.note ? { note: params.note } : {}),
  };
  return {
    kind: ARBITER_ROSTER_KIND,
    created_at: createdAt,
    tags: [
      ["d", community],
      ["t", ARBITER_ROSTER_TYPE],
    ],
    content: JSON.stringify(payload),
  };
}

/** Parse + structurally validate + signature-verify a roster event.
 *  Authority is NOT checked here — selectLatestRoster owns that, so a UI
 *  can still show "unverified roster exists" distinctly from "no roster". */
export function parseArbiterRosterEvent(
  event: NostrEvent,
  options?: { verifyEvent?: (event: NostrEvent) => boolean },
): RosterParseResult {
  if (event.kind !== ARBITER_ROSTER_KIND) {
    return { ok: false, reason: `wrong kind ${event.kind}` };
  }
  const dTag = event.tags.find(t => t[0] === "d")?.[1];
  if (!dTag) return { ok: false, reason: "missing d tag" };

  let payload: ArbiterRosterPayload;
  try {
    payload = JSON.parse(event.content);
  } catch {
    return { ok: false, reason: "content is not JSON" };
  }
  if (payload?.type !== ARBITER_ROSTER_TYPE) {
    return { ok: false, reason: "payload type mismatch" };
  }
  if (payload.community !== dTag) {
    return { ok: false, reason: "payload community does not match d tag" };
  }
  if (!Array.isArray(payload.arbiters) || payload.arbiters.length === 0) {
    return { ok: false, reason: "payload has no arbiters" };
  }
  if (payload.arbiters.length > MAX_ROSTER_ARBITERS) {
    return { ok: false, reason: "roster exceeds arbiter cap" };
  }
  const arbiters: string[] = [];
  const seen = new Set<string>();
  for (const raw of payload.arbiters) {
    const pk = normalizeRosterPubkey(typeof raw === "string" ? raw : null);
    if (!pk) return { ok: false, reason: `non-hex arbiter pubkey: ${String(raw)}` };
    if (!seen.has(pk)) {
      seen.add(pk);
      arbiters.push(pk);
    }
  }
  const verify = options?.verifyEvent ?? (verifyNostrEventSignature as unknown as (e: NostrEvent) => boolean);
  if (!verify(event)) {
    return { ok: false, reason: "bad signature" };
  }
  return {
    ok: true,
    roster: {
      community: dTag,
      arbiters,
      signer: event.pubkey.toLowerCase(),
      createdAt: event.created_at,
      eventId: event.id,
    },
  };
}

/** Pick the authoritative roster from candidate events: parse-valid, signer
 *  in authority, newest created_at; ties → lexicographically smallest id. */
export function selectLatestRoster(
  events: readonly NostrEvent[],
  authority: readonly string[],
  options?: { verifyEvent?: (event: NostrEvent) => boolean },
): VerifiedArbiterRoster | null {
  const allowed = new Set(authority.map(pk => pk.toLowerCase()));
  if (allowed.size === 0) return null;
  let best: VerifiedArbiterRoster | null = null;
  for (const event of events) {
    const parsed = parseArbiterRosterEvent(event, options);
    if (!parsed.ok) continue;
    if (!allowed.has(parsed.roster.signer)) continue;
    if (
      !best ||
      parsed.roster.createdAt > best.createdAt ||
      (parsed.roster.createdAt === best.createdAt && parsed.roster.eventId < best.eventId)
    ) {
      best = parsed.roster;
    }
  }
  return best;
}

// ── Device cache (raw event; re-verified on every read) ────────────────────

function rosterStorageKey(community: string): string {
  return `${ROSTER_STORAGE_PREFIX}${community}`;
}

export function writeCachedRosterEvent(community: string, event: NostrEvent): void {
  try {
    globalThis.localStorage?.setItem(rosterStorageKey(community), JSON.stringify(event));
  } catch {
    // Cache only — losing it just means a refetch.
  }
}

export function readCachedRosterEvent(community: string): NostrEvent | null {
  try {
    const raw = globalThis.localStorage?.getItem(rosterStorageKey(community));
    if (!raw) return null;
    const event = JSON.parse(raw) as NostrEvent;
    return event && typeof event === "object" ? event : null;
  } catch {
    return null;
  }
}

/** The roster-sourced arbiter pool for a community: cached event, re-parsed,
 *  re-verified, authority-checked on EVERY read. Returns [] when there is no
 *  verifiable roster — callers merge with the existing pools. */
export function readRosterPool(
  community: string | null | undefined,
  authority: readonly string[],
  options?: { verifyEvent?: (event: NostrEvent) => boolean },
): string[] {
  if (!community) return [];
  const cached = readCachedRosterEvent(community);
  if (!cached) return [];
  const best = selectLatestRoster([cached], authority, options);
  return best?.arbiters ?? [];
}

// ── Relay sync ──────────────────────────────────────────────────────────────

/** Minimal query shape — adapt the caller's fetcher (EscrowClient.queryOnce)
 *  with a lambda; roster.ts stays free of client/relay imports. */
export type RosterQueryFn = (
  filter: { kinds: number[]; "#d": string[]; limit?: number },
  timeoutMs?: number,
) => Promise<NostrEvent[]>;

/** Fetch the community's roster events from relays, pick the newest
 *  authorized one (considering the cached event too — relays can lag), and
 *  cache it. Returns the winning roster, or null when nothing verifiable
 *  exists. Never throws on relay failure — the cache simply stays as-is. */
export async function fetchAndCacheCommunityRoster(params: {
  community: string;
  authority: readonly string[];
  query: RosterQueryFn;
  verifyEvent?: (event: NostrEvent) => boolean;
}): Promise<VerifiedArbiterRoster | null> {
  if (!params.community || params.authority.length === 0) return null;
  let fetched: NostrEvent[] = [];
  try {
    fetched = await params.query(
      { kinds: [ARBITER_ROSTER_KIND], "#d": [params.community], limit: 8 },
      5_000,
    );
  } catch {
    // Relay hiccup — fall through to the cache-only view.
  }
  const cached = readCachedRosterEvent(params.community);
  const candidates = cached ? [...fetched, cached] : fetched;
  const best = selectLatestRoster(candidates, params.authority, {
    verifyEvent: params.verifyEvent,
  });
  if (!best) return null;
  if (best.eventId !== cached?.id) {
    const bestEvent = candidates.find(e => e.id === best.eventId);
    if (bestEvent) writeCachedRosterEvent(params.community, bestEvent);
  }
  return best;
}
