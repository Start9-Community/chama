// ══════════════════════════════════════════════════════════════════════════
// Chama — Active-trade pill (v0.2.0 item 3)
// ══════════════════════════════════════════════════════════════════════════
//
// Per the v0.2.0 brief: when the user has an active trade, every
// non-trade screen surfaces a sticky pill at the top reminding them
// the trade exists and offering one-tap navigation back to it.
// Browse and Me stay accessible (per Q2: research listings, update
// payment handles, etc.), but the pill ensures the active trade is
// never out of reach.
//
// Per Q2, the pill also renders on Create (where the surrounding
// content explains *why* Create is hard-blocked) and on Sandbox
// (because Sandbox lives under Me, which is fully accessible during
// active trade).

import { type EscrowState, EscrowStatus } from "../../escrow-engine/types.js";
import { T, fmtSats } from "../theme.js";

const STATUS_LABEL: Partial<Record<EscrowStatus, string>> = {
  [EscrowStatus.CREATED]: "open",
  [EscrowStatus.LOCKED]: "in escrow",
  [EscrowStatus.APPROVED]: "ready to claim",
  [EscrowStatus.CLAIMED]: "settling",
  [EscrowStatus.EXPIRED]: "timed out",
};

export function ActiveTradePill({
  trade,
  onTap,
}: {
  trade: EscrowState;
  onTap: () => void;
}) {
  const statusLabel = STATUS_LABEL[trade.status] ?? trade.status.toLowerCase();
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
          Active trade · {statusLabel}
        </div>
        <div style={{
          fontSize: 13, color: T.text, fontFamily: T.sans,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const,
          marginTop: 2,
        }}>
          {trade.description} · {fmtSats(trade.amountMsats)} sats
        </div>
      </div>
      <span style={{ color: T.muted, fontSize: 18, flexShrink: 0 }}>›</span>
    </button>
  );
}
