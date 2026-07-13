// ══════════════════════════════════════════════════════════════════════════
// Counterparty ratings — kind:38123 (V3 reputation keystone)
// ══════════════════════════════════════════════════════════════════════════
//
// The reputation primitive the rest of the arbiter economy waits on: a one-tap
// 👍/👎 that a settled-trade participant gives a COUNTERPARTY — buyer, seller,
// OR arbiter, one generic event and one aggregator. Purely ADDITIVE: a new
// event kind older clients simply never query, so it ships whenever it's ready
// with no coordinated-release dance (unlike v2.9's vote-acceptance change).
//
// INTEGRITY — what makes a rating trustworthy without a server:
//   • self-signed by the RATER (the signature proves it came from that key),
//   • references a SETTLED escrow (resolvedOutcome present),
//   • the rater AND the ratee were both PARTICIPANTS of that escrow,
//   • rater ≠ ratee.
// A verifier drops anything failing these — a rating on a trade you weren't in,
// or that never settled, never counts. Replaceable per (rater, trade, ratee)
// via the d-tag, so re-rating overwrites and nobody can ballot-stuff one trade.
// Aggregation counts distinct (rater, trade) verified thumbs about a ratee — so
// a tap on the success screen and a tap from Me history land on the SAME slot.
//
// Sybil note: a fake rating still requires completing a real settled escrow
// (locking real sats) with the ratee — costly, the same trust-bootstrap posture
// as the signed roster. Widening the franchise as history accumulates, and
// spending these ratings on tiered arbiter assignment, is deferred (#73).

import { verifyEvent as verifyNostrEventSignature } from "nostr-tools/pure";
import { Role, type EscrowState, type NostrEvent } from "../escrow-engine/types.js";

export const RATING_KIND = 38123;
export const RATING_TYPE = "chama:rating";

export type RatingThumb = "up" | "down";

export interface RatingPayload {
  type: typeof RATING_TYPE;
  /** The settled escrow this rating is about (the escrow / CREATE id). */
  tradeId: string;
  /** Who is being rated (lowercase hex pubkey). */
  ratee: string;
  thumb: RatingThumb;
  ratedAt?: number;
}

export interface Rating {
  tradeId: string;
  rater: string;
  ratee: string;
  thumb: RatingThumb;
  createdAt: number;
  eventId: string;
}

/** The {count, positive, negative} shape `canOfferSubscription` and the Me
 *  dashboard already consume. Canonical home is here (the reputation layer);
 *  decisions.ts re-exports it for back-compat. */
export interface AggregateRatings {
  count: number;
  positive: number;
  negative: number;
}

/** Replaceable-event key (the d-tag): one rating per (rater, trade, ratee).
 *  The rater is the event's pubkey, so binding (trade, ratee) lets a rater rate
 *  BOTH counterparties of the same trade (e.g. the seller AND the arbiter) —
 *  each gets its own slot — while re-rating the SAME counterparty overwrites. */
export function ratingReplaceableKey(tradeId: string, ratee: string): string {
  return `${tradeId}:${ratee.toLowerCase()}`;
}

/** Build the unsigned rating event (the rater's client signs it). */
export function buildRatingEvent(params: {
  tradeId: string;
  ratee: string;
  thumb: RatingThumb;
  createdAt?: number;
}): { kind: number; created_at: number; tags: string[][]; content: string } {
  const tradeId = params.tradeId.trim();
  if (!tradeId) throw new Error("Rating tradeId is required");
  const ratee = params.ratee.trim().toLowerCase();
  if (!ratee) throw new Error("Rating ratee is required");
  if (params.thumb !== "up" && params.thumb !== "down") {
    throw new Error("Rating thumb must be 'up' or 'down'");
  }
  const createdAt = params.createdAt ?? Math.floor(Date.now() / 1000);
  const payload: RatingPayload = {
    type: RATING_TYPE,
    tradeId,
    ratee,
    thumb: params.thumb,
    ratedAt: createdAt,
  };
  return {
    kind: RATING_KIND,
    created_at: createdAt,
    tags: [
      ["d", ratingReplaceableKey(tradeId, ratee)],
      // v3.1.1 (#1 fix): the trade is identified by the `d` tag
      // (`${tradeId}:${ratee}`) and the content payload — NOT by an `e` tag.
      // `tradeId` is an internal escrow id (`sm_…`), not a 32-byte Nostr event
      // id, so tagging it as `e` made every relay reject the whole event
      // ("unexpected size for fixed-size tag: e") and no rating ever published.
      // Nothing queries `#e` (fetchRatingSummary filters on `#p`), so dropping
      // it is lossless. If query-by-trade is ever wanted, use a non-fixed-size
      // tag (e.g. `["i", tradeId]`), never `e`.
      ["p", ratee],   // the rated pubkey (lets clients query ratings ABOUT someone)
      ["t", RATING_TYPE],
    ],
    content: JSON.stringify(payload),
  };
}

/** Parse + validate + signature-verify one rating event. Returns null on any
 *  malformed / self-rating / bad-signature input. Does NOT check the trade
 *  binding — that needs the trade, see verifyRatingForTrade. */
export function parseRatingEvent(
  event: NostrEvent,
  options?: { verifyEvent?: (event: NostrEvent) => boolean },
): Rating | null {
  if (event.kind !== RATING_KIND) return null;
  let payload: RatingPayload;
  try {
    payload = JSON.parse(event.content);
  } catch {
    return null;
  }
  if (payload?.type !== RATING_TYPE) return null;
  const tradeId = typeof payload.tradeId === "string" ? payload.tradeId.trim() : "";
  const ratee = typeof payload.ratee === "string" ? payload.ratee.trim().toLowerCase() : "";
  if (!tradeId || !ratee) return null;
  if (payload.thumb !== "up" && payload.thumb !== "down") return null;
  // The d-tag must match the (tradeId, ratee) binding, so a relay-level replace
  // can't smuggle a thumb onto a different slot than its content claims.
  const dTag = event.tags.find(t => t[0] === "d")?.[1];
  if (dTag !== ratingReplaceableKey(tradeId, ratee)) return null;
  const rater = event.pubkey.toLowerCase();
  if (rater === ratee) return null; // can't rate yourself
  const verify = options?.verifyEvent ?? (verifyNostrEventSignature as unknown as (e: NostrEvent) => boolean);
  if (!verify(event)) return null;
  return { tradeId, rater, ratee, thumb: payload.thumb, createdAt: event.created_at, eventId: event.id };
}

/** Cross-trade integrity: a rating only counts if it's about a SETTLED escrow
 *  that BOTH the rater and the ratee actually took part in. Pure — the caller
 *  supplies the trade it already knows (null ⇒ unverifiable ⇒ dropped). A
 *  backup arbiter who stepped in (actingArbiter) counts as a participant. */
export function verifyRatingForTrade(rating: Rating, trade: EscrowState | null | undefined): boolean {
  if (!trade) return false;
  if (trade.id !== rating.tradeId) return false;
  if (trade.resolvedOutcome == null) return false; // not settled — nobody performed yet
  const seats = [
    trade.participants[Role.BUYER],
    trade.participants[Role.SELLER],
    trade.participants[Role.ARBITER],
    trade.actingArbiter ?? null,
  ].filter((p): p is string => !!p).map(p => p.toLowerCase());
  const seated = new Set(seats);
  const rater = rating.rater.toLowerCase();
  const ratee = rating.ratee.toLowerCase();
  return rater !== ratee && seated.has(rater) && seated.has(ratee);
}

/** Aggregate VERIFIED ratings about one ratee into {count, positive, negative}.
 *  Dedups per (rater, trade): the newest thumb wins (re-rating overwrites), so
 *  one trade yields at most one thumb per rater. Feed this ONLY ratings already
 *  passed through verifyRatingForTrade. */
export function aggregateRatings(ratings: readonly Rating[], ratee: string): AggregateRatings {
  const target = ratee.trim().toLowerCase();
  const latest = new Map<string, Rating>();
  for (const r of ratings) {
    if (r.ratee !== target) continue;
    const key = `${r.rater}:${r.tradeId}`;
    const existing = latest.get(key);
    if (
      !existing
      || r.createdAt > existing.createdAt
      || (r.createdAt === existing.createdAt && r.eventId < existing.eventId)
    ) {
      latest.set(key, r);
    }
  }
  let positive = 0;
  let negative = 0;
  for (const r of latest.values()) {
    if (r.thumb === "up") positive++;
    else negative++;
  }
  return { count: positive + negative, positive, negative };
}

/** Convenience: parse → verify-against-known-trades → aggregate, in one pass.
 *  `tradeFor(id)` returns the verifying client's known escrow for a trade id
 *  (or null/undefined if it can't vouch for it). Unverifiable ratings drop. */
export function aggregateVerifiedRatings(
  events: readonly NostrEvent[],
  ratee: string,
  tradeFor: (tradeId: string) => EscrowState | null | undefined,
  options?: { verifyEvent?: (event: NostrEvent) => boolean },
): AggregateRatings {
  const verified: Rating[] = [];
  for (const event of events) {
    const rating = parseRatingEvent(event, options);
    if (!rating) continue;
    if (!verifyRatingForTrade(rating, tradeFor(rating.tradeId))) continue;
    verified.push(rating);
  }
  return aggregateRatings(verified, ratee);
}

/** The counterparty the signed-in user rates for a settled trade: the OTHER
 *  trade principal (buyer↔seller). Returns null when the user is the arbiter or
 *  not a principal — v1 captures principal↔principal ratings; arbiter ratings
 *  arrive with the arbiter dashboard (#73). Returns the counterparty's pubkey
 *  in its original case (buildRatingEvent lowercases it). */
export function counterpartyToRate(trade: EscrowState, me: string): string | null {
  const m = me.toLowerCase();
  const buyer = trade.participants[Role.BUYER] ?? null;
  const seller = trade.participants[Role.SELLER] ?? null;
  if (buyer && seller) {
    if (m === buyer.toLowerCase()) return seller;
    if (m === seller.toLowerCase()) return buyer;
  }
  return null;
}
