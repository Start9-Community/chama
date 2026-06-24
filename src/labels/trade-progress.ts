// ══════════════════════════════════════════════════════════════════════════
// Chama — Trade-progress display helpers (pure, React-free, testable)
// ══════════════════════════════════════════════════════════════════════════
//
// Display-only derivations for the TradeView UX pass. NOTHING here changes the
// reducer or the wire protocol — these turn existing state (category,
// fulfillment, the event chain) into the words and bubbles the screen shows.
//
//   • funderRole / performerRole — who LOCKS vs who is PAID on release, by
//     vertical, mirroring the engine's locker convention.
//   • markDoneVerb / markDoneChatMessage — the performer's "I did my part"
//     button + the structured chat note it rides (kind 38108).
//   • eventToSystemBubble — one event-chain entry → a centered system bubble
//     for the living chat feed (reuses the notification vocabulary).
//
// Source of truth note: the v4 mockup's bill-pay example happens to label the
// volunteer as "seller", but the ENGINE (labels/vote-labels.ts, recipients.ts,
// state-machine.ts) makes the volunteer the BUYER (performer) and the bill
// owner the SELLER (funder/locker). The engine wins — see funderRole below.

import { type ParsedEscrowEvent, Role, Outcome } from "../escrow-engine/types.js";

// ── Who locks vs who performs ──────────────────────────────────────────────
//
// The FUNDER locks the sats into escrow; RELEASE pays the PERFORMER (the
// non-locker). Marketplace: the buyer locks (pays for the order) → performer is
// the seller. Every other vertical: the seller locks (p2p maker, bill owner,
// lender) → performer is the buyer (taker, volunteer, borrower). This matches
// theme.refundRecipientFor, TradeDetail's `expectedLocker`, and the routing in
// recipients.ts. raw-escrow has no menu/performer semantics; it falls through
// to the seller-locks default, which is harmless (its labels stay neutral).

export function funderRole(category: string | undefined): Role {
  return category === "marketplace" ? Role.BUYER : Role.SELLER;
}

export function performerRole(category: string | undefined): Role {
  return category === "marketplace" ? Role.SELLER : Role.BUYER;
}

// ── Mark-done verb (the performer's pre-vote "I did my part" signal) ─────────

export interface MarkDoneVerb {
  /** Leading glyph, e.g. "📦". */
  icon: string;
  /** Imperative button label, e.g. "Mark delivered". */
  label: string;
  /** Past participle for the structured chat note / system bubble, e.g.
   *  "delivered" → "📦 Marked as delivered". */
  done: string;
}

export interface MarkDoneOpts {
  /** Lending runs as two reversed-role trades. Disbursement (first cycle): the
   *  borrower acknowledges receipt → "Mark received". Repayment (Option B): the
   *  repaying side closes the loan → "↩ Mark repaid". Defaults to disbursement,
   *  the primary cycle. (Jetty's emphasis: the verb must read right per phase —
   *  a flat "Mark repaid" misreads on the disbursement trade where nothing has
   *  been repaid yet.) */
  lendingPhase?: "disbursement" | "repayment";
}

/** The performer's mark-done verb, keyed off (category, fulfillment) — and, for
 *  lending, the cycle phase. Marketplace splits by fulfillment (the only
 *  vertical where fulfillment is a real choice); the rest are per-vertical. */
export function markDoneVerb(
  category: string | undefined,
  fulfillment: string | undefined,
  opts: MarkDoneOpts = {},
): MarkDoneVerb {
  switch (category) {
    case "marketplace":
      if (fulfillment === "service") return { icon: "✓", label: "Mark completed", done: "completed" };
      if (fulfillment === "digital") return { icon: "📤", label: "Mark sent", done: "sent" };
      return { icon: "📦", label: "Mark delivered", done: "delivered" }; // physical (default)
    case "p2p-trade":
      return { icon: "💸", label: "Mark sent", done: "sent" };
    case "bill-pay":
      return { icon: "✓", label: "Mark paid", done: "paid" };
    case "lending":
      return opts.lendingPhase === "repayment"
        ? { icon: "↩", label: "Mark repaid", done: "repaid" }
        : { icon: "📥", label: "Mark received", done: "received" };
    default:
      return { icon: "✓", label: "Mark done", done: "done" };
  }
}

/** Plausible refund reasons to offer as chips when a party arms a refund — the
 *  picked one rides into the chat as their message (display-only, no reducer
 *  change). Split by funder (asking for their sats back — a complaint) vs
 *  performer (returning the sats / backing out), flavoured per vertical. Phrased
 *  in the party's own voice since it's sent as their chat message. The arbiter
 *  isn't offered reasons — their refund is a ruling, not a request. */
export function refundReasons(
  category: string | undefined,
  fulfillment: string | undefined,
  voteRole: Role,
): string[] {
  if (voteRole === performerRole(category)) {
    // The performer is returning the sats / backing out.
    switch (category) {
      case "marketplace": return ["Out of stock", "Can't fulfill it", "Buyer asked to cancel"];
      case "p2p-trade": return ["Couldn't send the fiat", "Changed my mind"];
      case "bill-pay": return ["Couldn't pay the bill", "Changed my mind"];
      case "lending": return ["Don't need it anymore", "Changed my mind"];
      default: return ["Can't complete it", "Changed my mind"];
    }
  }
  // The funder is asking for their locked sats back.
  switch (category) {
    case "marketplace":
      return fulfillment === "service" ? ["Work wasn't done", "Not as agreed", "Changed my mind"]
        : fulfillment === "digital" ? ["File never arrived", "Not as described", "Changed my mind"]
        : ["It didn't arrive", "Not as described", "Changed my mind"];
    case "p2p-trade": return ["Fiat never arrived", "Wrong amount", "Changed my mind"];
    case "bill-pay": return ["Bill wasn't paid", "I paid it myself", "Changed my mind"];
    case "lending": return ["Terms not met", "Changed my mind"];
    default: return ["Didn't get it", "Changed my mind"];
  }
}

// Icons a structured mark-done note can lead with — used to recognise these
// messages in the chat stream so the living feed renders them as centered
// system bubbles rather than ordinary left/right speech bubbles.
const MARK_DONE_ICONS = ["📦", "✓", "📤", "💸", "📥", "↩"];

/** The structured chat note the performer publishes on mark-done (rides kind
 *  38108, like a normal message — no new wire event). Marketplace-physical
 *  keeps its exact legacy wording the buyer + arbiter already recognise; the
 *  other verticals follow the same "{icon} Marked as {done}" shape. */
export function markDoneChatMessage(
  category: string | undefined,
  fulfillment: string | undefined,
  opts: MarkDoneOpts = {},
): string {
  if (category === "marketplace" && (fulfillment ?? "physical") === "physical") {
    return "📦 Marked as delivered — on its way.";
  }
  const v = markDoneVerb(category, fulfillment, opts);
  return `${v.icon} Marked as ${v.done}.`;
}

/** True when a chat message is a structured mark-done note (any vertical), so
 *  the living feed can lift it into a system bubble. The icon-prefix guard
 *  keeps an ordinary message that merely contains "Marked as" from matching. */
export function isStructuredMarkDoneMessage(message: string | undefined | null): boolean {
  if (!message) return false;
  return message.includes(" Marked as ") && MARK_DONE_ICONS.some(ic => message.startsWith(ic + " "));
}

// ── Living chat: event chain → system bubble ────────────────────────────────

export type SystemBubbleTone = "teal" | "lock" | "green" | "vote" | "amber" | "win";

export interface SystemBubble {
  /** Stable React key (the source event id, or a synthetic id). */
  key: string;
  icon: string;
  text: string;
  tone: SystemBubbleTone;
  /** Unix seconds (raw.created_at) — the sort key that weaves bubbles into the
   *  human-message timeline. */
  at: number;
}

export interface LivingChatCtx {
  category: string | undefined;
  /** Short trade id for the "reserved" bubble. */
  shortId: string;
  /** Pre-formatted amount, e.g. "1,723 sats". */
  amountLabel: string;
  /** The trade's final outcome, so the "settled" bubble can name the winner. */
  resolvedOutcome?: Outcome | null;
  /** Fulfillment, so the performer's release vote can render with the right
   *  mark-done verb (delivered / completed / sent / …). */
  fulfillment?: string;
  /** Display name for a role ("Mama Njeri" / "You" / "Buyer"). */
  nameFor: (role: Role) => string;
}

/** Map ONE event-chain entry to a system bubble for the living chat, or null if
 *  it isn't surfaced in the feed (join / complete / subscription belong only in
 *  the technical timeline). Display-only: derived from the existing chain, never
 *  published. Colour follows meaning — teal reserved, purple lock, orange vote,
 *  green ready, amber cancel, win-green settled. */
export function eventToSystemBubble(
  event: ParsedEscrowEvent,
  ctx: LivingChatCtx,
): SystemBubble | null {
  const at = event.raw.created_at;
  const key = event.raw.id;
  const p = event.payload as { type: string; outcome?: Outcome; role?: Role };
  switch (p.type) {
    case "escrow:create":
      return { key, at, icon: "📋", tone: "teal", text: `Trade reserved · ${ctx.shortId}` };
    case "escrow:lock":
      return { key, at, icon: "⚡", tone: "lock", text: `Sats locked in escrow · ${ctx.amountLabel}` };
    case "escrow:vote": {
      const outcome = p.outcome ?? Outcome.RELEASE;
      const voterRole = p.role ?? funderRole(ctx.category);
      const voter = ctx.nameFor(voterRole);
      // The performer's RELEASE vote IS their mark-done — render it as
      // "{name} marked it {delivered/sent/paid/…}" (green), friendlier than
      // "released → pays {themselves}".
      if (outcome === Outcome.RELEASE && voterRole === performerRole(ctx.category)) {
        const verb = markDoneVerb(ctx.category, ctx.fulfillment);
        return { key, at, icon: verb.icon, tone: "green", text: `${voter} marked it ${verb.done}` };
      }
      if (outcome === Outcome.REFUND) {
        // A lone refund stays calm (orange ↩) — the funder asking for their sats
        // back, or the performer returning them in good faith. The escalation to
        // amber is the synthetic "⚖ Dispute opened" bubble when both sides clash.
        const funderName = ctx.nameFor(funderRole(ctx.category));
        if (voterRole === Role.ARBITER) {
          return { key, at, icon: "⚖", tone: "vote", text: `Arbiter refunded → back to ${funderName}` };
        }
        if (voterRole === performerRole(ctx.category)) {
          return { key, at, icon: "↩", tone: "vote", text: `${voter} refunded ${funderName}` };
        }
        return { key, at, icon: "↩", tone: "vote", text: `${voter} asked for a refund` };
      }
      // RELEASE by the funder (or arbiter ruling) → pays the performer.
      const recipient = ctx.nameFor(performerRole(ctx.category));
      return { key, at, icon: "🗳️", tone: "vote", text: `${voter} released → pays ${recipient}` };
    }
    case "escrow:resolve": {
      const outcome = p.outcome ?? Outcome.RELEASE;
      return {
        key, at, icon: "✅", tone: "green",
        text: outcome === Outcome.REFUND
          ? "Refund approved — ready to claim"
          : "Released — ready to claim",
      };
    }
    case "escrow:claim": {
      const outcome = ctx.resolvedOutcome ?? null;
      const winnerRole = outcome === Outcome.REFUND ? funderRole(ctx.category)
        : outcome === Outcome.RELEASE ? performerRole(ctx.category)
        : null;
      const winner = winnerRole ? ctx.nameFor(winnerRole) : "the winner";
      return { key, at, icon: "🎉", tone: "win", text: `Settled — ${ctx.amountLabel} to ${winner}` };
    }
    case "escrow:cancel":
      return { key, at, icon: "✖", tone: "amber", text: "Trade cancelled" };
    default:
      // join / complete / subscribe / period_release / chat — not in the feed.
      return null;
  }
}

/** A dispute isn't a discrete event (it's both outcomes on record, unresolved),
 *  so the feed synthesises it at the moment the conflicting vote landed. */
export function disputeBubble(at: number): SystemBubble {
  return { key: "sys:dispute", at, icon: "⚖", tone: "amber", text: "Dispute opened" };
}

/** Likewise an expiry is time-based, not an event — synthesised when the trade
 *  reads EXPIRED. */
export function timeoutBubble(at: number): SystemBubble {
  return { key: "sys:timeout", at, icon: "⏳", tone: "amber", text: "Timed out — past the deadline" };
}
