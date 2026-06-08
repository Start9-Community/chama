// ══════════════════════════════════════════════════════════════════════════
// Trade notifications — the pure "should this transition buzz the user?" core
// ══════════════════════════════════════════════════════════════════════════
//
// #88: surface the async trade moments that otherwise make people babysit the
// app — counterparty locked, claim ready, a dispute needs the arbiter, trade
// settled/timed out. This module is PURE: given the previous and next replayed
// state of one escrow + the viewer's pubkey, it returns a notification to fire,
// or null. The side-effecting delivery (Capacitor / Tauri / Web) + permission +
// the persisted fire-once dedup live in notify-service.ts. Keeping the decision
// pure makes every role/transition case exhaustively testable.
//
// Guard: `prev` must be non-null. We only notify on an OBSERVED transition, not
// on the first time we ever see a trade (initial cache load / cold replay would
// otherwise buzz for every already-advanced trade). Combined with the
// fire-once-per-(escrow,kind) dedup in the service, each real moment notifies
// at most once — including ones discovered when the app reopens after being
// closed (prev = cached state, next = newer relay state).

import { EscrowStatus, Role, Outcome, type EscrowState } from "../escrow-engine/types.js";
import { payoutRecipientFor } from "../escrow-engine/recipients.js";

export interface TradeNotification {
  escrowId: string;
  title: string;
  body: string;
  /** Dedup key — the same (escrow, kind) fires at most once, ever. */
  tag: string;
}

function samePubkey(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/** The viewer's role in this trade — including a stepped-in / pool arbiter. */
function roleOf(state: EscrowState, pubkey: string): Role | null {
  if (samePubkey(state.participants[Role.BUYER], pubkey)) return Role.BUYER;
  if (samePubkey(state.participants[Role.SELLER], pubkey)) return Role.SELLER;
  if (samePubkey(state.participants[Role.ARBITER], pubkey)) return Role.ARBITER;
  if (samePubkey(state.actingArbiter, pubkey)) return Role.ARBITER;
  if (state.communityArbiters?.some(a => samePubkey(a, pubkey))) return Role.ARBITER;
  return null;
}

function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 10)}…` : id;
}

/** Buyer and seller have both voted and DISAGREE — the moment an arbiter is
 *  actually needed. */
function inDispute(state: EscrowState): boolean {
  const b = state.votes[Role.BUYER];
  const s = state.votes[Role.SELLER];
  return b !== undefined && s !== undefined && b !== s;
}

/**
 * The notification (if any) to fire for one escrow transitioning prev → next,
 * from the perspective of `userPubkey`. Pure; null when nothing should buzz.
 */
export function notificationForTransition(
  prev: EscrowState | null | undefined,
  next: EscrowState,
  userPubkey: string | null | undefined,
): TradeNotification | null {
  if (!prev || !userPubkey) return null; // only notify on an OBSERVED change
  const role = roleOf(next, userPubkey);
  if (!role) return null; // not a party to this trade
  const id = next.id;
  const label = shortId(id);

  // 1) Sats just locked → tell the NON-locker (the counterparty whose turn it
  //    is). The locker did the action; they don't need telling.
  if (prev.status === EscrowStatus.CREATED && next.status === EscrowStatus.LOCKED) {
    const nonLocker = payoutRecipientFor(next, Outcome.RELEASE); // release goes to the non-locker
    if (nonLocker && samePubkey(nonLocker.pubkey, userPubkey)) {
      return {
        escrowId: id,
        title: "⚡ Sats locked in escrow",
        body: `Trade ${label} is live — the other side funded it. Your move.`,
        tag: `${id}:locked`,
      };
    }
  }

  // 2) Resolved in someone's favor → tell the WINNER their claim is ready.
  if (prev.status !== EscrowStatus.APPROVED && next.status === EscrowStatus.APPROVED) {
    const winner = payoutRecipientFor(next, next.resolvedOutcome ?? Outcome.RELEASE);
    if (winner && samePubkey(winner.pubkey, userPubkey)) {
      return {
        escrowId: id,
        title: "✅ Your claim is ready",
        body: `Trade ${label} resolved in your favor — open Chama to claim your sats.`,
        tag: `${id}:approved`,
      };
    }
  }

  // 3) A dispute just opened → tell the ARBITER. This is the keystone: an
  //    arbiter who's never told can't show up (the very no-show the expiry fix
  //    exists to contain).
  if (role === Role.ARBITER && !inDispute(prev) && inDispute(next)
      && next.status === EscrowStatus.LOCKED) {
    return {
      escrowId: id,
      title: "⚖️ A trade needs your ruling",
      body: `Buyer and seller disagree on trade ${label}. They're waiting on you — review and vote.`,
      tag: `${id}:dispute`,
    };
  }

  // 4) Settled → tell the two parties it's done.
  if (prev.status !== EscrowStatus.COMPLETED && next.status === EscrowStatus.COMPLETED
      && (role === Role.BUYER || role === Role.SELLER)) {
    return {
      escrowId: id,
      title: "🎉 Trade complete",
      body: `Trade ${label} settled — the sats have moved.`,
      tag: `${id}:completed`,
    };
  }

  // 5) Timed out → tell the two parties to look.
  if (prev.status !== EscrowStatus.EXPIRED && next.status === EscrowStatus.EXPIRED
      && (role === Role.BUYER || role === Role.SELLER)) {
    return {
      escrowId: id,
      title: "⏰ Trade timed out",
      body: `Trade ${label} reached its deadline. Open Chama to see where it landed.`,
      tag: `${id}:expired`,
    };
  }

  return null;
}
