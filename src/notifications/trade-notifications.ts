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
import { translate, getCurrentLang } from "../i18n/index.js";

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
      // #63 storefront routing: a child order LOCKing is a new sale on the
      // seller's storefront. The seller is the RELEASE recipient (non-locker),
      // so this same branch fires for them — but with storefront-specific copy
      // that reads as "a new order arrived", deep-linking to the child (escrowId
      // = child id). Tag stays keyed on the child so it dedupes per order.
      const isChildOrder = next.parent !== undefined && role === Role.SELLER;
      return {
        escrowId: id,
        title: translate(getCurrentLang(), isChildOrder ? "notify.newOrderTitle" : "notify.lockedTitle"),
        body: translate(getCurrentLang(), isChildOrder ? "notify.newOrderBody" : "notify.lockedBody", { label }),
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
        title: translate(getCurrentLang(), "notify.approvedTitle"),
        body: translate(getCurrentLang(), "notify.approvedBody", { label }),
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
      title: translate(getCurrentLang(), "notify.disputeTitle"),
      body: translate(getCurrentLang(), "notify.disputeBody", { label }),
      tag: `${id}:dispute`,
    };
  }

  // 4) Settled → tell the two parties it's done.
  if (prev.status !== EscrowStatus.COMPLETED && next.status === EscrowStatus.COMPLETED
      && (role === Role.BUYER || role === Role.SELLER)) {
    return {
      escrowId: id,
      title: translate(getCurrentLang(), "notify.completedTitle"),
      body: translate(getCurrentLang(), "notify.completedBody", { label }),
      tag: `${id}:completed`,
    };
  }

  // 5) Timed out → tell the two parties to look.
  if (prev.status !== EscrowStatus.EXPIRED && next.status === EscrowStatus.EXPIRED
      && (role === Role.BUYER || role === Role.SELLER)) {
    return {
      escrowId: id,
      title: translate(getCurrentLang(), "notify.expiredTitle"),
      body: translate(getCurrentLang(), "notify.expiredBody", { label }),
      tag: `${id}:expired`,
    };
  }

  return null;
}

// ══════════════════════════════════════════════════════════════════════════
// Liquidity & attention — pull the seller back on buyer INTEREST (not just LOCK)
// ══════════════════════════════════════════════════════════════════════════
//
// #63 already buzzes the seller when a child order LOCKs (a funded sale). This
// fires EARLIER: the moment a buyer is on one of the seller's listings but
// hasn't funded yet — a fresh child order appearing pre-lock, or a JOIN hold
// landing on the seller's own single listing. The goal is to pull the seller
// back BEFORE the buyer gives up waiting for a response. Pure; the side effects
// (permission, dedup, delivery) live in notify-service.
//
// Backlog guard: unlike the transition core (which requires a non-null prev),
// this can fire on a FIRST observation (a child CREATE arriving fresh IS the
// interest), so it guards backlog with `liveSinceSec` on the reservation's own
// timestamp — the same discipline as the chat notifier.

/**
 * The notification (if any) to fire when a buyer shows INTEREST in one of the
 * seller's listings, from the perspective of `userPubkey`. Pure; null when
 * nothing should buzz. `liveSinceSec` is when this client session went live —
 * interest older than it is backlog and stays silent.
 *
 * Two cases, both seller-only and pre-lock (once LOCKED the #63 newOrder path
 * owns the copy):
 *   • a child order just appeared on my storefront (buyer-created child escrow
 *     that seated me as seller) — a fresh observation is fine, the child IS the
 *     signal; guarded on the child's createdAt.
 *   • a buyer JOIN hold just landed on my own single listing — guarded on the
 *     hold's joinedAt, and de-duplicated per buyer so a new buyer re-buzzes.
 */
export function buyerInterestNotificationFor(
  prev: EscrowState | null | undefined,
  next: EscrowState,
  userPubkey: string | null | undefined,
  liveSinceSec: number,
): TradeNotification | null {
  if (!userPubkey) return null;
  // Only the seller cares about buyer interest — and only while the listing is
  // still open (a LOCKED order is a funded sale, handled by the transition core).
  if (!samePubkey(next.participants[Role.SELLER], userPubkey)) return null;
  if (next.status !== EscrowStatus.CREATED) return null;

  const id = next.id;
  const label = shortId(id);
  const lang = getCurrentLang();
  const build = (tag: string): TradeNotification => ({
    escrowId: id,
    title: translate(lang, "notify.buyerInterestTitle"),
    body: translate(lang, "notify.buyerInterestBody", { label }),
    tag,
  });

  // Case A: a child order just appeared on my storefront.
  if (next.parent !== undefined) {
    if (prev) return null;                     // only a FIRST sighting is "new interest"
    if (next.createdAt < liveSinceSec) return null; // backlog — replayed on cold boot
    return build(`${id}:interest`);
  }

  // Case B: a buyer JOIN hold just landed on my own single listing.
  const hold = next.joinHolds?.[Role.BUYER];
  if (!hold) return null;
  if (hold.joinedAt < liveSinceSec) return null;             // backlog
  const prevHold = prev?.joinHolds?.[Role.BUYER];
  if (prevHold && samePubkey(prevHold.pubkey, hold.pubkey)) return null; // already saw this buyer
  // Tag by buyer so a different buyer joining later re-buzzes (fire-once per buyer).
  return build(`${id}:interest:${hold.pubkey.toLowerCase()}`);
}

// ══════════════════════════════════════════════════════════════════════════
// Liquidity & attention — pull buyers/volunteers in on a NEW home-chama listing
// ══════════════════════════════════════════════════════════════════════════
//
// Opt-in (default OFF, whole-community). When a fresh CREATE listing appears in
// the viewer's HOME chama that isn't theirs, buzz them so supply meets demand.
// Pure; the opt-in gate + permission + dedup + delivery live in notify-service.

/**
 * The notification (if any) to fire for a newly-seen listing, from the
 * perspective of `userPubkey`. Pure; null when nothing should buzz.
 *   • only a FIRST observation of an open (CREATED) parent listing
 *   • only in the viewer's HOME community (`homeCommunitySlug`)
 *   • never the viewer's own listing, never a child order
 *   • `createdAt` must be ≥ `liveSinceSec` (backlog guard)
 * `communityLabel` is the friendly name for the body; the caller resolves it.
 */
export function newListingNotificationFor(
  prev: EscrowState | null | undefined,
  next: EscrowState,
  userPubkey: string | null | undefined,
  homeCommunitySlug: string | null | undefined,
  communityLabel: string,
  liveSinceSec: number,
): TradeNotification | null {
  if (!userPubkey) return null;
  if (prev) return null;                                 // only a brand-new sighting
  if (next.status !== EscrowStatus.CREATED) return null; // only open listings
  if (next.parent !== undefined) return null;            // child orders aren't listings
  if (!homeCommunitySlug) return null;                   // no explicit home ⇒ don't ping
  if (next.community !== homeCommunitySlug) return null;  // home community only
  if (next.createdAt < liveSinceSec) return null;         // backlog guard
  if (roleOf(next, userPubkey) !== null) return null;     // not mine

  const lang = getCurrentLang();
  return {
    escrowId: next.id,
    title: translate(lang, "notify.newListingTitle"),
    body: translate(lang, "notify.newListingBody", {
      community: communityLabel,
      title: next.description,
    }),
    tag: `${next.id}:newlisting`,
  };
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
  const lang = getCurrentLang();
  const who = senderRole
    ? translate(lang, "notify.chatSenderRole", { role: senderRole })
    : translate(lang, "notify.chatSomeone");
  return {
    escrowId: id,
    title: translate(lang, "notify.chatTitle"),
    // Content stays OUT of the OS buzz — escrow chat can carry payment handles;
    // the notification says who + which trade, the tap opens it to read.
    body: translate(lang, "notify.chatBody", { who, label }),
    tag: `${id}:chat:${message.raw.id}`,
  };
}
