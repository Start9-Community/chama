// ══════════════════════════════════════════════════════════════════════════
// Chama — Pending-lock resume card (#37 lock crash-safety, Part B)
// ══════════════════════════════════════════════════════════════════════════
//
// The HONEST surface for a lock attempt that didn't finish (reload/crash
// mid-funding or mid-lock). It replaces the drain-shaped alarm for this
// state: the balance/notes belong to a KNOWN trade, and the correct next
// step is to FINISH the lock — not to sweep the sats out over Lightning at
// a fee (which would abandon a live trade).
//
// Deliberately CALM (a recoverable in-flight state, not a failure): no
// pulse, no red, renders ABOVE the normal view instead of replacing it.
//
// "Finish lock" runs the normal foreground lock (actions.lockAndPublish
// with the stashed lock options). Under the hood the bridge first settles
// the stashed entry — re-absorbing the previous attempt's notes back into
// the wallet when provably safe, or returning the already-locked state if
// the crash-window publish actually landed — then locks fresh. One tap, no
// new invoice, no double payment.

import { T } from "../theme.js";
import { BitcoinAmount } from "./BitcoinAmount.js";
import type { PendingNativeLock } from "../../fedimint/pending-native-locks.js";

export function PendingLockCard({
  entry,
  tradeDescription,
  busy,
  onFinishLock,
  onOpenTrade,
}: {
  entry: PendingNativeLock;
  /** Description of the trade, when it's loaded locally. */
  tradeDescription: string | null;
  /** True while the finish-lock call is in flight. */
  busy: boolean;
  /** Re-run the lock in the foreground (recovery + fresh lock inside). */
  onFinishLock: () => void;
  /** Navigate to the trade detail. */
  onOpenTrade: () => void;
}) {
  const spent = entry.stage !== "intent";
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
          ⏸ Finish locking your trade
        </div>

        <div style={{
          fontSize: 13, color: T.text, fontFamily: T.sans,
          lineHeight: 1.5, marginBottom: 4,
        }}>
          {spent
            ? <>Your last session ended before the lock finished. Your{" "}
                <BitcoinAmount msats={entry.amountMsats} size={13} gap={4} glyphScale={1.18} color={T.text} glyphColor={T.muted} />{" "}
                are safe — finish the lock to put them in escrow.</>
            : <>You were funding this trade when the app closed. Pick up where
                you left off — locking{" "}
                <BitcoinAmount msats={entry.amountMsats} size={13} gap={4} glyphScale={1.18} color={T.text} glyphColor={T.muted} />{" "}
                puts your sats in escrow.</>}
        </div>

        {tradeDescription && (
          <div style={{
            fontSize: 12, color: T.muted, fontFamily: T.sans,
            marginBottom: 12, overflow: "hidden", textOverflow: "ellipsis",
            whiteSpace: "nowrap" as const,
          }}>
            {tradeDescription}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: tradeDescription ? 0 : 12 }}>
          <button
            onClick={onFinishLock}
            disabled={busy}
            style={{
              flex: 1, padding: "12px",
              background: busy ? T.border : T.accent,
              border: "none", borderRadius: T.rs,
              color: T.bg, fontFamily: T.mono, fontSize: 13, fontWeight: 800,
              cursor: busy ? "default" : "pointer", letterSpacing: 0.5,
            }}
          >
            {busy ? "Finishing…" : "Finish lock →"}
          </button>
          <button
            onClick={onOpenTrade}
            style={{
              padding: "12px 14px",
              background: "transparent",
              border: `1px solid ${T.border}`, borderRadius: T.rs,
              color: T.text, fontFamily: T.mono, fontSize: 12, fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Open trade
          </button>
        </div>

        <div style={{
          marginTop: 8, fontSize: 9, color: T.muted, fontFamily: T.mono,
          lineHeight: 1.5,
        }}>
          Recovery is automatic and fee-free — nothing is sent over Lightning.
        </div>
      </div>
    </div>
  );
}
