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

import {
  EscrowStatus, Role, Outcome,
  getEffectiveParticipantsAt,
  type EscrowState, type ChatPayload, type ParsedEscrowEvent,
} from "../escrow-engine/types.js";
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

// ══════════════════════════════════════════════════════════════════════════
// DM / trade-chat notifications — the pure "should this message buzz?" core
// ══════════════════════════════════════════════════════════════════════════
//
// Companion to notificationForTransition for inbound trade chat. The dispatch
// keeps three things pure here: (1) a tri-state preference — `auto` defaults the
// buzz to your ROLE ON THAT TRADE (arbiters are the responders, so they hear
// pings; buyers/sellers stay quiet) while `on`/`off` are explicit global
// overrides; (2) never buzz for your OWN echoed message; (3) never buzz for chat
// that predates this live session — backlog replayed on cold-boot/heal must stay
// silent (the analogue of notificationForTransition's prev-must-be-non-null
// guard). Chat recurs, so unlike the transition core this is deliberately NOT
// paired with the fire-once-ever dedup: every fresh inbound message may buzz.

/** DM-notification preference. `auto` = follow your per-trade role (arbiter ⇒ on,
 *  buyer/seller ⇒ off). `on`/`off` = explicit global override. */
export type DmNotifyPref = "auto" | "on" | "off";

/** The viewer's COMMITTED role on this trade, from the effective participants
 *  (timed JOIN holds resolved). Deliberately the assigned arbiter only — a mere
 *  pool member who never took the seat can't decrypt the chat anyway, so "am I
 *  the arbiter" here means the responder, not the roster. */
function participantRoleAt(state: EscrowState, pubkey: string, atSec: number): Role | null {
  const p = getEffectiveParticipantsAt(state, atSec);
  if (samePubkey(p[Role.BUYER], pubkey)) return Role.BUYER;
  if (samePubkey(p[Role.SELLER], pubkey)) return Role.SELLER;
  if (samePubkey(p[Role.ARBITER], pubkey)) return Role.ARBITER;
  return null;
}

/**
 * The notification (if any) to fire for one inbound chat `message` on `state`,
 * from the perspective of `userPubkey`, given the tri-state `pref`. Pure; null
 * when nothing should buzz. `liveSinceSec` is when this client session went
 * live — messages older than it are backlog and stay silent.
 */
export function chatNotificationFor(
  state: EscrowState,
  message: ParsedEscrowEvent<ChatPayload>,
  userPubkey: string | null | undefined,
  pref: DmNotifyPref,
  liveSinceSec: number,
): TradeNotification | null {
  if (!userPubkey) return null;
  if (pref === "off") return null;
  if (samePubkey(message.pubkey, userPubkey)) return null;  // my own echo
  if (message.timestamp < liveSinceSec) return null;        // backlog, not live

  const myRole = participantRoleAt(state, userPubkey, message.timestamp);
  if (!myRole) return null;                                 // not a party to this trade
  if (pref === "auto" && myRole !== Role.ARBITER) return null; // role default: arbiters only

  const id = state.id;
  const label = shortId(id);
  const senderRole = participantRoleAt(state, message.pubkey, message.timestamp)
    ?? message.payload.senderRole;
  const who = senderRole ? `The ${senderRole}` : "Someone";
  return {
    escrowId: id,
    title: "💬 New message",
    // Content stays OUT of the OS buzz — escrow chat can carry payment handles;
    // the notification says who + which trade, the tap opens it to read.
    body: `${who} messaged you on trade ${label}.`,
    tag: `${id}:chat:${message.raw.id}`,
  };
}
