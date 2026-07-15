// ══════════════════════════════════════════════════════════════════════════
// Chama — TradeDetail default-pane picker (#68)
// ══════════════════════════════════════════════════════════════════════════
//
// The TradeView pager has three panes: Chat (0), Details (1), Parties (2).
// When a party opens a trade, they should land on the pane that holds their
// NEXT action — never staring at a view with nothing to do.
//
// Pure + presentation-only: this decides only the LEADING pane on a trade's
// mount. It never touches the reducer / event chain. The caller preserves the
// "a manual swipe wins forever" guard (userMovedPaneRef) — this helper is only
// consulted to seed the initial pane and on a trade change, never to yank a
// user who has moved themselves.

import { EscrowStatus, Role } from "../../escrow-engine/types.js";

/** Pager pane indices (must match PAGER_TABS order in TradeDetail). */
export const TRADE_PANE = { CHAT: 0, DETAILS: 1, PARTIES: 2 } as const;

export interface DefaultPaneInput {
  status: EscrowStatus;
  /** The viewer's role in this trade (null = non-participant / browse view). */
  myRole: Role | null;
  /** Which role owes the fiat leg (payer). Null when not applicable. */
  fiatPayerRole: Role | null;
  /** True when the viewer is the payout winner (claim/approve owner). */
  iAmWinner: boolean;
  /** True when the trade title is disputed (suppresses the payer-at-LOCK landing). */
  titleDisputed: boolean;
  /** True when there are unread chat messages from the other party. */
  hasUnreadChat: boolean;
}

/**
 * Land the viewer on the pane where their pending action lives.
 *
 * Priority (highest first):
 *  1. Pre-lock (CREATED) — everyone reads/configures the terms (the cart /
 *     amount / bill selection all live on Details), so a buyer finishing a
 *     multi-item order lands where the config is.
 *  2. A money action → Details (the fund / claim button lives there):
 *       a. the fiat payer at LOCK owes the payment;
 *       b. the winner at APPROVED/CLAIMED owes the claim.
 *  3. A new/unread chat message with no higher-priority action → Chat.
 *  4. Otherwise the sensible default: coordination happens in Chat.
 */
export function pickDefaultPane(input: DefaultPaneInput): number {
  const { status, myRole, fiatPayerRole, iAmWinner, titleDisputed, hasUnreadChat } = input;

  // 1. Pre-lock config / terms.
  if (status === EscrowStatus.CREATED) return TRADE_PANE.DETAILS;

  // 2a. Fiat payer at LOCK — the "You owe" headline + fund button are on Details.
  if (
    status === EscrowStatus.LOCKED &&
    !titleDisputed &&
    myRole != null &&
    myRole === fiatPayerRole
  ) {
    return TRADE_PANE.DETAILS;
  }

  // 2b. Winner at claim/approve — the claim button is on Details.
  if (
    (status === EscrowStatus.APPROVED || status === EscrowStatus.CLAIMED) &&
    iAmWinner
  ) {
    return TRADE_PANE.DETAILS;
  }

  // 3. Unread chat, no pending config/money action → Chat.
  if (hasUnreadChat) return TRADE_PANE.CHAT;

  // 4. Default coordination surface.
  return TRADE_PANE.CHAT;
}
