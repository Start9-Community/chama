// ══════════════════════════════════════════════════════════════════════════
// Chama — Active-trade pill
// ══════════════════════════════════════════════════════════════════════════
//
// Informational only: active trades never close Browse, Create, chat, or
// vote surfaces. The pill keeps live commitments visible and gives the
// user a quick route back to the most recent active trade. v0.6.5 made
// it plural-aware so sellers serving multiple buyers, or buyers waiting
// on one trade while browsing for the next, see the aggregate listed
// value rather than a singular pill that suggests there's only one.

import { type EscrowState, EscrowStatus } from "../../escrow-engine/types.js";
import { T, fmtSats } from "../theme.js";

const STATUS_LABEL: Partial<Record<EscrowStatus, string>> = {
  [EscrowStatus.CREATED]: "open",
  [EscrowStatus.LOCKED]: "in escrow",
  [EscrowStatus.APPROVED]: "ready to claim",
  [EscrowStatus.EXPIRED]: "timed out",
};

export function ActiveTradePill({
  trade,
  activeTradeCount = 1,
  activeTradeMsats,
  onTap,
}: {
  trade: EscrowState;
  /** Total live buyer/seller commitments. When > 1 the headline reads
   *  "N active trades"; tap target stays the most recent trade. */
  activeTradeCount?: number;
  /** Aggregate msats across all live buyer/seller trades, including open
   *  listings. This is total listed value, not proof that funds are
   *  locked. */
  activeTradeMsats?: number;
  onTap: () => void;
}) {
  const statusLabel = STATUS_LABEL[trade.status] ?? trade.status.toLowerCase();
  const count = Math.max(1, activeTradeCount);
  const amountMsats = activeTradeMsats ?? trade.amountMsats;
  const tradeWord = count === 1 ? "active trade" : "active trades";
  return (
    <button
      onClick={onTap}
      style={{
        display: "flex", alignItems: "center", gap: 10,
        width: "calc(100% - 32px)",
        margin: "12px 16px 0",
        padding: "10px 14px",
        background: T.purpleDim, border: `1px solid ${T.purple}66`,
        borderRadius: T.r,
        color: T.text, fontFamily: T.sans,
        cursor: "pointer", textAlign: "left" as const,
        transition: "all 0.15s",
      }}
    >
      <span style={{
        width: 10, height: 10, borderRadius: "50%",
        background: T.purple,
        boxShadow: `0 0 8px ${T.purple}88`,
        animation: "pulse 2s ease-in-out infinite",
        flexShrink: 0,
      }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 11, color: T.purple, fontFamily: T.mono,
          letterSpacing: 0.5, textTransform: "uppercase", fontWeight: 700,
        }}>
          {count} {tradeWord} · {fmtSats(amountMsats)} sats total
        </div>
        <div style={{
          fontSize: 13, color: T.text, fontFamily: T.sans,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const,
          marginTop: 2,
        }}>
          {trade.description} · {statusLabel}
        </div>
      </div>
      <span style={{ color: T.muted, fontSize: 18, flexShrink: 0 }}>›</span>
    </button>
  );
}
