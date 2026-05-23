// ══════════════════════════════════════════════════════════════════════════
// Chama — Design tokens + small format helpers
// ══════════════════════════════════════════════════════════════════════════
//
// Per PHILOSOPHY.md §5.3: Apple-grade dark mode, JetBrains Mono for
// cryptographic strings, sentence case throughout. Role colors are sacred
// and reserved for role identification (no decorative use).

import type { CSSProperties } from "react";
import { Role } from "../escrow-engine/types.js";

export const T = {
  bg: "#0a0a0f", surface: "#111118", card: "#16161f",
  border: "#1e1e2e", borderHi: "#2a2a3e",
  text: "#e8e6e0", muted: "#6b6980",
  accent: "#f7931a", accentDim: "#f7931a33",
  green: "#22c55e", greenDim: "#22c55e22",
  red: "#ef4444", redDim: "#ef444422",
  purple: "#a78bfa", purpleDim: "#a78bfa22",
  teal: "#2dd4bf", tealDim: "#2dd4bf22",
  amber: "#fbbf24", amberDim: "#fbbf2422",
  r: 12, rs: 8,
  mono: "'JetBrains Mono','SF Mono','Fira Code',monospace",
  sans: "'DM Sans',-apple-system,sans-serif",
};

// v0.1.66.33: human-first status vocabulary + three visual modes.
//   mode "active"   → filled pill, pulsing dot (user action required)
//   mode "working"  → filled pill, static dot  (system working)
//   mode "resolved" → outlined pill, no dot    (done)
export type StatusMode = "active" | "working" | "resolved";

export const STATUS = {
  CREATED:   { c: T.teal,   bg: T.tealDim,   l: "Open",            mode: "working"  as StatusMode },
  LOCKED:    { c: T.purple, bg: T.purpleDim, l: "Sats in escrow",  mode: "working"  as StatusMode },
  APPROVED:  { c: T.accent, bg: T.accentDim, l: "Ready to claim",  mode: "active"   as StatusMode },
  CLAIMED:   { c: T.amber,  bg: T.amberDim,  l: "Settling",        mode: "working"  as StatusMode },
  CLAIM_FAILED: { c: T.red, bg: T.redDim, l: "Claim failed",        mode: "active"   as StatusMode },
  COMPLETED: { c: T.green,  bg: T.greenDim,  l: "Done",            mode: "resolved" as StatusMode },
  EXPIRED:   { c: T.red,    bg: T.redDim,    l: "Timed out",       mode: "active"   as StatusMode },
  CANCELLED: { c: T.muted,  bg: T.surface,   l: "Cancelled",       mode: "resolved" as StatusMode },
} as Record<string, { c: string; bg: string; l: string; mode: StatusMode }>;

// Brand-pack role colors (PHILOSOPHY.md §5.2, sacred — reserved for role
// identification, no decorative use).
//   Buyer   = Nostr Purple   #BF5AF2
//   Seller  = Bitcoin Orange #F7931A
//   Arbiter = Signal Teal    #5AC8FA
export const ROLE_COLOR = { buyer: "#BF5AF2", seller: "#F7931A", arbiter: "#5AC8FA" };
export const ROLE_ICON  = { buyer: "B", seller: "S", arbiter: "A" };

// v0.3.0 Phase 6 (item 8): Trinity Ring participant render order.
// PHILOSOPHY.md §5.2 brand mark places the arbiter at the apex with
// buyer/seller flanking below. TradeDetail's participant row mirrors
// this — arbiter is the structural center, not a third-party
// afterthought. Order: Buyer (left) · Arbiter (middle) · Seller (right).
//
// This constant is the source of truth — TradeDetail.tsx imports it
// for the .map render. The §43 test pins the order directly so a
// future refactor that "tidies" rendering can't silently re-sort
// participants and break brand coherence.
export const TRINITY_RING_ORDER: readonly Role[] = [
  Role.BUYER,
  Role.ARBITER,
  Role.SELLER,
];

export const CAT_ICON = { "p2p-trade": "⚡", "bill-pay": "🧾", marketplace: "🏪", lending: "🤝" } as Record<string, string>;
export const CAT_LABEL: Record<string, string> = {
  "p2p-trade":   "⚡ Exchange",
  "bill-pay":    "🧾 Community Bill Pay",
  marketplace:   "🏪 Marketplace",
  lending:       "🤝 Lending",
  "raw-escrow":  "🔧 Raw Escrow",
};

// Browse tab category filter pills. `id` matches state.category values
// (or "all"/"subscription" as cross-cutting filters).
export const BROWSE_CATS: { id: string; l: string; i: string }[] = [
  { id: "all",          l: "All",          i: "" },
  { id: "p2p-trade",    l: "Exchange",     i: "⚡" },
  { id: "bill-pay",     l: "Com. Bill Pay", i: "🧾" },
  { id: "marketplace",  l: "Market",       i: "🏪" },
  { id: "lending",      l: "Lending",      i: "🤝" },
  { id: "subscription", l: "Repeats",      i: "🔄" },
];

export const fmtSats = (ms: number) => Math.floor(ms / 1000).toLocaleString();

// Who receives sats on a REFUND outcome, by category. Mirrors the
// getWinner() logic in state-machine.ts for the REFUND branch:
//   marketplace: buyer locks → refund returns to buyer
//   p2p-trade / bill-pay / lending / raw-escrow: seller locks → refund to seller
export function refundRecipientFor(category: string): "buyer" | "seller" {
  return category === "marketplace" ? "buyer" : "seller";
}

export const inputStyle: CSSProperties = {
  width: "100%", padding: "12px 14px",
  background: T.surface, border: `1px solid ${T.border}`,
  borderRadius: T.rs, color: T.text,
  fontFamily: T.sans, fontSize: 14, outline: "none", boxSizing: "border-box",
};
