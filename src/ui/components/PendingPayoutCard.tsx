// ══════════════════════════════════════════════════════════════════════════
// Chama — Pending-payout resume card (stranded-payout recovery)
// ══════════════════════════════════════════════════════════════════════════
//
// The claim-side sibling of PendingLockCard (#37): the HONEST surface for a
// won trade whose outbound payout didn't finish. The claimed sats are back
// in (or headed to) the user's wallet and the trade is CLAIMED-not-COMPLETED
// — the correct next step is the trade's own RETRY CLAIM (double-pay guarded
// by the payout journal), not the generic drain-shaped recovery alarm that
// used to fire here with a mis-attributed amount.
//
// Deliberately CALM (a recoverable in-flight state, not a failure): no
// pulse, no red, renders ABOVE the normal view instead of replacing it.
//
// Two flavors, decided by summarizePendingPayoutsForUi:
//   finish     — no payout-journal record: the payout was never sent or
//                definitively failed. CTA opens the trade, whose RETRY
//                CLAIM re-runs the guarded claim flow.
//   confirming — a `submitted` record exists: a payout is in flight or its
//                outcome is unknown. Opening the trade re-attaches to the
//                operationId (never re-pays); reassure, never invite a
//                second send.

import { T } from "../theme.js";
import { BitcoinAmount } from "./BitcoinAmount.js";
import type { PendingClaimPayout } from "../decisions.js";

export function PendingPayoutCard({
  entry,
  onOpenTrade,
}: {
  entry: PendingClaimPayout;
  /** Navigate to the trade detail — RETRY CLAIM / payout-confirming UI
   *  there owns the actual money path. */
  onOpenTrade: () => void;
}) {
  const confirming = entry.kind === "confirming";
  return (
    <div style={{ padding: "12px 16px 0", maxWidth: 560, margin: "0 auto" }}>
      <div style={{
        background: T.surface, border: `1px solid ${T.accent}55`,
        borderRadius: T.r, padding: 16,
      }}>
        <div style={{
          fontSize: 10, fontWeight: 700, color: T.accent, fontFamily: T.mono,
          letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 8,
        }}>
          {confirming ? "⏳ Payout confirming" : "⚡ Finish your payout"}
        </div>

        <div style={{
          fontSize: 13, color: T.text, fontFamily: T.sans,
          lineHeight: 1.5, marginBottom: 4,
        }}>
          {confirming
            ? <>Your payout of{" "}
                <BitcoinAmount msats={entry.amountMsats} size={13} gap={4} glyphScale={1.18} color={T.text} glyphColor={T.muted} />{" "}
                was sent and is confirming. Chama checks automatically —
                don't claim again; watch your destination wallet.</>
            : <>You won this trade — your{" "}
                <BitcoinAmount msats={entry.amountMsats} size={13} gap={4} glyphScale={1.18} color={T.text} glyphColor={T.muted} />{" "}
                are in your wallet, but the payout to your address didn't
                finish. Open the trade to send them where you want.</>}
        </div>

        {entry.description && (
          <div style={{
            fontSize: 12, color: T.muted, fontFamily: T.sans,
            marginBottom: 12, overflow: "hidden", textOverflow: "ellipsis",
            whiteSpace: "nowrap" as const,
          }}>
            {entry.description}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: entry.description ? 0 : 12 }}>
          <button
            onClick={onOpenTrade}
            style={{
              flex: 1, padding: "12px",
              background: T.accent,
              border: "none", borderRadius: T.rs,
              color: T.bg, fontFamily: T.mono, fontSize: 13, fontWeight: 800,
              cursor: "pointer", letterSpacing: 0.5,
            }}
          >
            {confirming ? "Open trade →" : "Finish payout →"}
          </button>
        </div>

        <div style={{
          marginTop: 8, fontSize: 9, color: T.muted, fontFamily: T.mono,
          lineHeight: 1.5,
        }}>
          Retrying is safe — Chama never pays the same trade out twice.
        </div>
      </div>
    </div>
  );
}
