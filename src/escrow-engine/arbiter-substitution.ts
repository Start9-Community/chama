// ══════════════════════════════════════════════════════════════════════════
// Arbiter substitution — deterministic pool priority + eligibility (Stage 1)
// ══════════════════════════════════════════════════════════════════════════
//
// See docs/DESIGN-arbiter-substitution.md (maintainer-locked 2026-06-04).
//
// Holder-only made the assigned arbiter the sole holder of the arbiter Shamir
// share, so an absent arbiter stranded disputes on the expiry refund. These
// helpers are the pure heart of the fix: a deterministic PRIORITY ORDER of
// pool arbiters per escrow (assigned first, then backups via the same
// round-robin pick the LOCK used), and a chain-derived GRACE WINDOW after
// which a backup may cast the arbiter vote. Everything here is a pure
// function of state the event chain already carries, so every client
// converges on the same answers with no coordinator:
//
//   • who may substitute   → arbiterPriorityOrder / arbiterVotePriority
//   • when they may        → disputeStartAt + substitutionEligibleAt
//   • which vote wins      → lowest priority index among arbiter votes in the
//                            chain (the reducer applies this; assigned = 0
//                            always trumps backups pre-settlement)
//
// The grace window is courtesy, not correctness: even if a backup votes the
// moment it opens, a later vote from the assigned arbiter still wins the slot
// until a RESOLVE + CLAIM settles the trade (first accepted wins).

import { Role, EscrowEventKind, Outcome, type EscrowState, type VotePayload } from "./types.js";
import { pickArbiterFromPool } from "../arbiters/pool.js";

/** Pool members who hold a copy of the arbiter share AND may vote: the
 *  assigned arbiter + 2 backups. Share-holding and vote-eligibility are capped
 *  to the same set so they can never diverge. */
export const ARBITER_POOL_SHARE_CAP = 3;

/** Max exclusivity for the assigned arbiter once a dispute starts. */
export const SUBSTITUTION_GRACE_MAX_SECONDS = 4 * 3600;

/** Low-level deterministic priority order. The LOCK builder calls this with
 *  the pubkeys it is about to commit (the arbiter isn't seated in state yet at
 *  build time); everyone else should prefer arbiterPriorityOrder(state). */
export function arbiterPriorityOrderFor(params: {
  escrowId: string;
  pool: readonly string[];
  buyerPubkey?: string | null;
  sellerPubkey?: string | null;
  assignedArbiter?: string | null;
}): string[] {
  const order: string[] = [];
  if (params.assignedArbiter) order.push(params.assignedArbiter);
  while (order.length < ARBITER_POOL_SHARE_CAP) {
    const next = pickArbiterFromPool(
      [...params.pool],
      params.escrowId,
      [params.buyerPubkey, params.sellerPubkey, ...order],
    );
    if (!next) break;
    order.push(next);
  }
  return order;
}

/** Deterministic arbiter priority order for this escrow: index 0 is the
 *  assigned arbiter (as committed in the LOCK), then backups derived by
 *  iterating the same deterministic pool pick the LOCK used, excluding
 *  buyer/seller and everyone already ordered. Capped at
 *  ARBITER_POOL_SHARE_CAP. Pure over (participants, communityArbiters, id) —
 *  every client computes the identical order. */
export function arbiterPriorityOrder(state: EscrowState): string[] {
  return arbiterPriorityOrderFor({
    escrowId: state.id,
    pool: state.communityArbiters ?? [],
    buyerPubkey: state.participants[Role.BUYER],
    sellerPubkey: state.participants[Role.SELLER],
    assignedArbiter: state.participants[Role.ARBITER],
  });
}

/** Priority index of `pubkey` in the order above (0 = assigned, 1-2 =
 *  backups), or null when the pubkey is not substitution-eligible here. */
export function arbiterVotePriority(state: EscrowState, pubkey: string): number | null {
  const idx = arbiterPriorityOrder(state).indexOf(pubkey);
  return idx === -1 ? null : idx;
}

/** When the dispute started: the created_at of the LATER of buyer's and
 *  seller's votes, but only when both exist and disagree. Null otherwise
 *  (no dispute → no substitution clock). Derived from the event chain so it
 *  replays identically everywhere. */
export function disputeStartAt(state: EscrowState): number | null {
  let buyer: { outcome: Outcome; at: number } | null = null;
  let seller: { outcome: Outcome; at: number } | null = null;
  for (const ve of state.eventChain) {
    if (ve.kind !== EscrowEventKind.VOTE) continue;
    const p = ve.payload as VotePayload | undefined;
    if (!p) continue;
    const at = (ve as { raw?: { created_at?: number } }).raw?.created_at ?? 0;
    if (p.role === Role.BUYER && !buyer) buyer = { outcome: p.outcome, at };
    else if (p.role === Role.SELLER && !seller) seller = { outcome: p.outcome, at };
  }
  if (!buyer || !seller || buyer.outcome === seller.outcome) return null;
  return Math.max(buyer.at, seller.at);
}

/** The moment a BACKUP becomes eligible to cast the arbiter vote:
 *  disputeStartAt + min(4h, half the trade's remaining life). The adaptive
 *  floor keeps backups viable on short trades (a 2h-to-expiry dispute gives
 *  the assigned arbiter 1h, not never); already-expired edge floors at 0 so a
 *  merit resolution can still beat the expiry refund. Null while there is no
 *  dispute. */
export function substitutionEligibleAt(state: EscrowState): number | null {
  const start = disputeStartAt(state);
  if (start === null) return null;
  const half = state.expiresAt
    ? Math.max(0, Math.floor((state.expiresAt - start) / 2))
    : SUBSTITUTION_GRACE_MAX_SECONDS;
  return start + Math.min(SUBSTITUTION_GRACE_MAX_SECONDS, half);
}
