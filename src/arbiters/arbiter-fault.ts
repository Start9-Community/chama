// ══════════════════════════════════════════════════════════════════════════
// Arbiter fault attestation — kind 38136 (accountability #2)
// ══════════════════════════════════════════════════════════════════════════
//
// The one credible signal available for a judgement call that the chain cannot
// adjudicate: BOTH principals of a settled dispute — people who were arguing
// with each other — agreeing afterwards that the arbiter acted in bad faith.
// One side complaining is worthless by construction; unanimity of former
// opponents is the entire signal.
//
// Nostr signs one event per key, so a "dual-signed" attestation is a PAIR of
// events: buyer's and seller's, naming the same escrow and the same arbiter.
// Neither alone means anything.
//
// SEVERITY, honestly bounded. This pays nobody and seizes nothing — the bond
// still returns to its owner at term end (PHILOSOPHY 2.11). What it does is
// remove the privilege of being seated, and put a permanent public record
// beside that npub. Identity is free, so a determined bad actor abandons the
// key and re-bonds fresh with zero standing; the destroyed reputation IS the
// punishment, and it lands immediately. The exclusion window mostly binds
// people who stay — which is why it runs on an absolute clock (not "N terms",
// which the arbiter chooses and could set to a day) and why the accused gets a
// signed right of reply.
//
// KIND ALLOCATION: 38130 declaration · 38131 victim made-whole · 38132–38134
// RETIRED with the 2-of-3 cabinet bond (never reuse — stale events live on
// relays forever) · 38135 bond announcement · 38136 THIS. Clear of the escrow
// wire (38100–38112).

import { EscrowStatus, Role, EscrowEventKind } from "../escrow-engine/types.js";
import type { EscrowState, NostrEvent, VotePayload } from "../escrow-engine/types.js";

/**
 * Whether clients should READ fault attestations yet.
 *
 * The verification engine and the pool exclusion are complete and tested, but
 * nothing can PUBLISH a 38136 until the dual-signature flow ships — and a lone
 * signature is correctly worth nothing, so no valid attestation can exist in
 * the wild. Reading anyway costs a blocking relay round-trip on every CREATE
 * to learn something that cannot be there.
 *
 * The sign/publish work flips this to true. Until then the exclusion path is
 * dormant, not absent: it is exercised by the suite, just never queried live.
 */
export const ARBITER_FAULT_READS_ENABLED = false;

export const ARBITER_FAULT_KIND = 38136;
export const ARBITER_FAULT_TYPE = "chama:arbiter-fault";
export const ARBITER_REBUTTAL_TYPE = "chama:arbiter-rebuttal";

/** Absolute exclusion floor. Deliberately long: this is reserved for a
 *  unanimous verdict by two people who were opponents. Absolute rather than
 *  term-denominated because term length is the arbiter's own choice. */
export const FAULT_EXCLUSION_FLOOR_SECS = 180 * 24 * 3600;

/** Free-text cap — a reason, not an essay, and a bound on relay payload. */
export const FAULT_REASON_MAX_CHARS = 500;

export interface ArbiterFaultPayload {
  type: typeof ARBITER_FAULT_TYPE | typeof ARBITER_REBUTTAL_TYPE;
  escrowId: string;
  /** The seated arbiter being attested against (hex pubkey). */
  arbiter: string;
  reason: string;
  at: number;
}

export interface ArbiterFaultRecord {
  payload: ArbiterFaultPayload;
  /** Who signed it — authoritative from the event, never from the payload. */
  signer: string;
  createdAt: number;
  eventId: string;
}

/** A complete attestation: both principals of one settled trade, agreeing. */
export interface ArbiterFaultPair {
  escrowId: string;
  arbiter: string;
  buyer: ArbiterFaultRecord;
  seller: ArbiterFaultRecord;
  /** The later of the two signatures — when the accusation became complete. */
  attestedAt: number;
}

function isNonEmptyHex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

/** Addressable key: one standing attestation per (signer, trade, arbiter), so
 *  a re-publish replaces rather than accumulates. */
export function arbiterFaultDTag(escrowId: string, arbiter: string): string {
  return `${escrowId}:${arbiter}`;
}

export function buildArbiterFaultEvent(params: {
  escrowId: string;
  arbiter: string;
  reason?: string;
  createdAt?: number;
  rebuttal?: boolean;
}): { kind: number; created_at: number; tags: string[][]; content: string } {
  const at = params.createdAt ?? Math.floor(Date.now() / 1000);
  const payload: ArbiterFaultPayload = {
    type: params.rebuttal ? ARBITER_REBUTTAL_TYPE : ARBITER_FAULT_TYPE,
    escrowId: params.escrowId,
    arbiter: params.arbiter,
    reason: (params.reason ?? "").slice(0, FAULT_REASON_MAX_CHARS),
    at,
  };
  return {
    kind: ARBITER_FAULT_KIND,
    created_at: at,
    tags: [
      ["d", arbiterFaultDTag(params.escrowId, params.arbiter)],
      ["p", params.arbiter],
      ["t", payload.type],
    ],
    content: JSON.stringify(payload),
  };
}

/** Parse + shape-check. Signer is taken from the EVENT, never the payload, so
 *  a forged `signer` field in content can't impersonate a principal. */
export function parseArbiterFaultEvent(event: NostrEvent): ArbiterFaultRecord | null {
  if (!event || event.kind !== ARBITER_FAULT_KIND) return null;
  if (!isNonEmptyHex(event.pubkey)) return null;
  let payload: ArbiterFaultPayload;
  try {
    payload = JSON.parse(event.content) as ArbiterFaultPayload;
  } catch {
    return null;
  }
  if (payload?.type !== ARBITER_FAULT_TYPE && payload?.type !== ARBITER_REBUTTAL_TYPE) return null;
  if (typeof payload.escrowId !== "string" || !payload.escrowId) return null;
  if (!isNonEmptyHex(payload.arbiter)) return null;
  return {
    payload: {
      ...payload,
      reason: typeof payload.reason === "string"
        ? payload.reason.slice(0, FAULT_REASON_MAX_CHARS)
        : "",
    },
    signer: event.pubkey,
    createdAt: Number.isFinite(event.created_at) ? event.created_at : 0,
    eventId: typeof event.id === "string" ? event.id : "",
  };
}

/** Did the seated arbiter actually rule on a real dispute here? */
function arbiterRuledOnDispute(state: EscrowState): boolean {
  const arbiter = state.participants[Role.ARBITER];
  if (!arbiter) return false;
  const buyerVote = state.votes[Role.BUYER];
  const sellerVote = state.votes[Role.SELLER];
  // No disagreement ⇒ the arbiter had no say to abuse.
  if (!buyerVote || !sellerVote || buyerVote === sellerVote) return false;
  return state.eventChain.some(ve =>
    ve.kind === EscrowEventKind.VOTE &&
    (ve.payload as VotePayload | undefined)?.role === Role.ARBITER
  );
}

/**
 * May this signer attest against this trade's arbiter?
 *
 * Settled only, on purpose: an attestation that could be published mid-dispute
 * would become leverage over the ruling itself — "rule my way or we both sign".
 * Attest afterwards, never during.
 */
export function canAttestArbiterFault(
  state: EscrowState | null | undefined,
  signer: string,
): boolean {
  if (!state) return false;
  if (state.status !== EscrowStatus.COMPLETED && state.status !== EscrowStatus.CANCELLED) return false;
  if (!arbiterRuledOnDispute(state)) return false;
  const buyer = state.participants[Role.BUYER];
  const seller = state.participants[Role.SELLER];
  return signer === buyer || signer === seller;
}

/**
 * Keep only complete, verified attestations. Every record is re-checked against
 * the trade it names — a signer who wasn't a principal, a trade that never
 * settled, an arbiter who never ruled, or a single unmatched complaint all fall
 * out here. Newest signature per (signer, trade) wins.
 */
export function selectArbiterFaultPairs(
  events: readonly NostrEvent[],
  tradeFor: (escrowId: string) => EscrowState | null | undefined,
): ArbiterFaultPair[] {
  const bySignerKey = new Map<string, ArbiterFaultRecord>();
  for (const event of events) {
    const record = parseArbiterFaultEvent(event);
    if (!record || record.payload.type !== ARBITER_FAULT_TYPE) continue;
    const state = tradeFor(record.payload.escrowId);
    if (!canAttestArbiterFault(state, record.signer)) continue;
    // The named arbiter must be the one who actually sat on this trade.
    if (state!.participants[Role.ARBITER] !== record.payload.arbiter) continue;
    const key = `${record.payload.escrowId}|${record.payload.arbiter}|${record.signer}`;
    const prior = bySignerKey.get(key);
    if (!prior || record.createdAt > prior.createdAt) bySignerKey.set(key, record);
  }

  const byTrade = new Map<string, ArbiterFaultRecord[]>();
  for (const record of bySignerKey.values()) {
    const key = `${record.payload.escrowId}|${record.payload.arbiter}`;
    const list = byTrade.get(key) ?? [];
    list.push(record);
    byTrade.set(key, list);
  }

  const pairs: ArbiterFaultPair[] = [];
  for (const [key, records] of byTrade) {
    const [escrowId, arbiter] = key.split("|");
    const state = tradeFor(escrowId);
    if (!state) continue;
    const buyer = records.find(r => r.signer === state.participants[Role.BUYER]);
    const seller = records.find(r => r.signer === state.participants[Role.SELLER]);
    // One side alone is not an attestation. This is the whole doctrine.
    if (!buyer || !seller) continue;
    pairs.push({
      escrowId,
      arbiter,
      buyer,
      seller,
      attestedAt: Math.max(buyer.createdAt, seller.createdAt),
    });
  }
  return pairs.sort((a, b) => a.attestedAt - b.attestedAt);
}

/** The arbiter's signed reply to an attestation, if they published one. */
export function selectArbiterRebuttal(
  events: readonly NostrEvent[],
  pair: ArbiterFaultPair,
): ArbiterFaultRecord | null {
  let latest: ArbiterFaultRecord | null = null;
  for (const event of events) {
    const record = parseArbiterFaultEvent(event);
    if (!record || record.payload.type !== ARBITER_REBUTTAL_TYPE) continue;
    if (record.payload.escrowId !== pair.escrowId) continue;
    // Only the accused may reply, and only about themselves.
    if (record.signer !== pair.arbiter || record.payload.arbiter !== pair.arbiter) continue;
    if (!latest || record.createdAt > latest.createdAt) latest = record;
  }
  return latest;
}

/**
 * When this npub regains the privilege of being seated, or null if never
 * attested. Absolute clock: the floor cannot be shortened by choosing a short
 * bond term, and a long term they cheated during cannot be escaped early.
 * `currentTermEndsAtSec` is optional — omit it and the floor alone applies.
 */
export function arbiterFaultExclusionUntil(
  pairs: readonly ArbiterFaultPair[],
  npub: string,
  currentTermEndsAtSec?: number | null,
): number | null {
  let until: number | null = null;
  for (const pair of pairs) {
    if (pair.arbiter !== npub) continue;
    const floor = pair.attestedAt + FAULT_EXCLUSION_FLOOR_SECS;
    const candidate = Math.max(floor, currentTermEndsAtSec ?? 0);
    if (until === null || candidate > until) until = candidate;
  }
  return until;
}

export function isArbiterFaultExcluded(
  pairs: readonly ArbiterFaultPair[],
  npub: string,
  nowSec: number,
  currentTermEndsAtSec?: number | null,
): boolean {
  const until = arbiterFaultExclusionUntil(pairs, npub, currentTermEndsAtSec);
  return until !== null && nowSec < until;
}

/** Npubs to keep out of the assignable pool right now. Preference-only: the
 *  caller must retain its never-empty fallback so an attestation can never
 *  strand a trade. */
export function excludedArbitersNow(
  pairs: readonly ArbiterFaultPair[],
  nowSec: number,
  termEndFor?: (npub: string) => number | null | undefined,
): string[] {
  const excluded = new Set<string>();
  for (const pair of pairs) {
    if (isArbiterFaultExcluded(pairs, pair.arbiter, nowSec, termEndFor?.(pair.arbiter) ?? null)) {
      excluded.add(pair.arbiter);
    }
  }
  return [...excluded];
}

// ── Reclaim under a cloud (accountability #3) ─────────────────────────────
//
// The bond ALWAYS returns to its owner at term end — that is the promise, and
// nothing here touches it. What used to happen silently is the exit: an arbiter
// with unanswered attestations against them could let the term lapse, take
// their sats, and leave no trace anyone could see. The announcement simply went
// inactive, which looks identical to an honest arbiter retiring.
//
// So we don't block the exit. We make it legible.

/** An attestation the arbiter never replied to. Silence is the signal here —
 *  a rebuttal doesn't clear the exclusion, but its ABSENCE is its own fact. */
export function unansweredAttestations(
  pairs: readonly ArbiterFaultPair[],
  npub: string,
  rebuttalEvents: readonly NostrEvent[] = [],
): ArbiterFaultPair[] {
  return pairs.filter(pair =>
    pair.arbiter === npub && selectArbiterRebuttal(rebuttalEvents, pair) === null
  );
}

export interface ReclaimUnderCloud {
  /** Complete attestations standing against them. */
  attestations: number;
  /** How many they never answered. */
  unanswered: number;
  /** True once the bond is no longer live — the exit has happened. */
  reclaimed: boolean;
}

/**
 * The public record of an arbiter's exit. `bondStillFunded` comes from the
 * caller's chain-verified announcement read, so this stays pure.
 *
 * Returns null when there is nothing to say — no attestations means no cloud,
 * and an arbiter with a live bond has not exited yet.
 */
export function reclaimUnderCloud(
  pairs: readonly ArbiterFaultPair[],
  npub: string,
  bondStillFunded: boolean,
  rebuttalEvents: readonly NostrEvent[] = [],
): ReclaimUnderCloud | null {
  const against = pairs.filter(pair => pair.arbiter === npub);
  if (against.length === 0) return null;
  return {
    attestations: against.length,
    unanswered: unansweredAttestations(pairs, npub, rebuttalEvents).length,
    reclaimed: !bondStillFunded,
  };
}
