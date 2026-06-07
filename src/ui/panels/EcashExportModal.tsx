// ══════════════════════════════════════════════════════════════════════════
// Chama — EcashExportModal (v2.4, #56 "withdraw as ecash, no LN fees")
// ══════════════════════════════════════════════════════════════════════════
//
// Spends the user's Chama balance into a Fedimint OOB note — a bearer string
// they can import into Fedi or any other Fedimint wallet on the SAME
// federation, with zero Lightning routing fees. This is the dust exit: it
// works even for balances too small for LN to move economically.
//
// Money-safety: the moment spendNotes returns, the sats have LEFT the wallet
// balance and exist only as the string. We stash it (ecash-exports.ts) before
// showing it, so a close/crash can't orphan it; a "pending ecash export"
// surface in Me re-opens this modal to retrieve it. Clearing the stash is
// two-tap, since it makes Chama forget the only copy it holds.

import { useState } from "react";
import { T } from "../theme.js";
import { BitcoinAmount } from "../components/BitcoinAmount.js";
import { QRCode } from "../QRCode.js";
import {
  clearEcashExport,
  getEcashExport,
  stashEcashExport,
} from "../../payments/ecash-exports.js";

type Phase = "intro" | "generating" | "ready" | "error";

export function EcashExportModal({
  balanceMsats,
  federationLabel,
  spendNotes,
  onExported,
  onClose,
}: {
  /** Full local balance to export, in msats. */
  balanceMsats: number;
  /** Human label for the federation the note will be bound to (e.g. "BLF"). */
  federationLabel: string;
  /** Bound to actions.spendNotes — spends the amount into an OOB note string. */
  spendNotes: (amountMsats: number) => Promise<string>;
  /** Fired after a successful generate so the shell can refresh the balance. */
  onExported?: () => void;
  onClose: () => void;
}) {
  // Resume a prior unconfirmed export if one is stashed (the balance may now
  // read 0, so this modal is the only way back to it).
  const stashed = getEcashExport();
  const [phase, setPhase] = useState<Phase>(stashed ? "ready" : "intro");
  const [notes, setNotes] = useState<string>(stashed?.notes ?? "");
  const [exportedMsats, setExportedMsats] = useState<number>(stashed?.amountMsats ?? balanceMsats);
  const [error, setError] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const sats = Math.floor(Math.max(0, balanceMsats) / 1000);
  const exportedSats = Math.floor(Math.max(0, exportedMsats) / 1000);

  const generate = async () => {
    setPhase("generating");
    setError("");
    try {
      const oob = await spendNotes(balanceMsats);
      // Crash-safety: persist BEFORE we show it.
      stashEcashExport({ notes: oob, amountMsats: balanceMsats, federationLabel });
      setNotes(oob);
      setExportedMsats(balanceMsats);
      setPhase("ready");
      onExported?.();
    } catch (e: any) {
      setError(e?.message || "Couldn't generate the ecash note. Your sats are safe in your Chama.");
      setPhase("error");
    }
  };

  const dismissConfirmed = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    clearEcashExport();
    onClose();
  };

  return (
    <div
      onClick={() => { if (phase !== "generating") onClose(); }}
      style={{
        position: "fixed", inset: 0, background: "#000c", zIndex: 9998,
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 16, animation: "fadeIn 0.2s ease",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: T.card, border: `1px solid ${T.borderHi}`, borderRadius: T.r,
          padding: 24, maxWidth: 440, width: "100%",
          maxHeight: "88vh", overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 4 }}>
              WITHDRAW AS ECASH · NO LN FEES
            </div>
            <div style={{ fontSize: 22, fontWeight: 800, color: T.text, fontFamily: T.mono }}>
              <BitcoinAmount sats={phase === "ready" ? exportedSats : sats} size={22} gap={6} glyphScale={1.2} color={T.text} glyphColor={T.muted} />
            </div>
          </div>
          {phase !== "generating" && (
            <button onClick={onClose} style={{
              background: "none", border: "none", color: T.muted,
              fontFamily: T.mono, fontSize: 18, cursor: "pointer", padding: 0, lineHeight: 1,
            }}>×</button>
          )}
        </div>

        {phase === "intro" && (
          <>
            <div style={{ fontSize: 12, color: T.muted, fontFamily: T.mono, lineHeight: 1.6, marginBottom: 12 }}>
              Turn your balance into a Fedimint ecash note you can import into
              Fedi — or any Fedimint wallet on <strong style={{ color: T.text }}>{federationLabel}</strong> —
              with no Lightning fees. Perfect for dust that costs more to move over Lightning than it's worth.
            </div>
            <div style={{
              padding: "10px 12px", borderRadius: T.rs, marginBottom: 14,
              background: T.amberDim, border: `1px solid ${T.amber}44`,
              color: T.amber, fontFamily: T.mono, fontSize: 10, lineHeight: 1.6,
            }}>
              ⚠ The note <strong>is</strong> your sats. The moment you generate it, your
              balance leaves your Chama and lives only in that string. Save it before
              closing — Chama keeps a copy under "pending ecash export" until you confirm
              you've imported it. It only works on {federationLabel}, not Cashu wallets.
            </div>
            <button
              onClick={generate}
              style={{
                width: "100%", padding: "12px 16px", borderRadius: T.rs,
                background: T.accent, border: `1px solid ${T.accent}`,
                color: "#000", fontFamily: T.mono, fontSize: 12, fontWeight: 800,
                cursor: "pointer", letterSpacing: 0.5,
              }}
            >
              Generate ecash note
            </button>
          </>
        )}

        {phase === "generating" && (
          <div style={{
            padding: "32px 16px", textAlign: "center",
            background: T.purpleDim, border: `1px solid ${T.purple}44`, borderRadius: T.r,
          }}>
            <div style={{
              width: 10, height: 10, borderRadius: "50%",
              background: T.purple, animation: "pulse 1.4s ease-in-out infinite",
              margin: "0 auto 12px",
            }} />
            <div style={{ fontSize: 11, fontWeight: 600, color: T.purple, fontFamily: T.mono, letterSpacing: 1 }}>
              MINTING YOUR ECASH NOTE…
            </div>
          </div>
        )}

        {phase === "ready" && (
          <>
            <div style={{
              padding: "9px 11px", borderRadius: T.rs, marginBottom: 12,
              background: T.greenDim, border: `1px solid ${T.green}44`,
              color: T.green, fontFamily: T.mono, fontSize: 10, lineHeight: 1.55,
            }}>
              ✓ Fedimint ecash · {federationLabel}. Import this into Fedi or any
              Fedimint wallet on {federationLabel}. Save it now — it's bearer money.
            </div>

            <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
              <QRCode data={notes} size={240} margin={4} errorCorrectionLevel="L" />
            </div>

            <div style={{
              padding: "10px 12px", borderRadius: T.rs, marginBottom: 12,
              background: T.bg, border: `1px solid ${T.border}`,
              color: T.muted, fontFamily: T.mono, fontSize: 9, lineHeight: 1.4,
              wordBreak: "break-all" as const, maxHeight: 96, overflowY: "auto",
            }}>
              {notes}
            </div>

            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <button
                onClick={() => {
                  try {
                    navigator.clipboard?.writeText(notes);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  } catch { /* clipboard unavailable — QR + on-screen string remain */ }
                }}
                style={{
                  flex: 1, padding: "11px 12px", borderRadius: T.rs,
                  background: copied ? T.greenDim : T.accent,
                  border: `1px solid ${copied ? T.green + "66" : T.accent}`,
                  color: copied ? T.green : "#000",
                  fontFamily: T.mono, fontSize: 12, fontWeight: 800, cursor: "pointer",
                }}
              >
                {copied ? "✓ Copied" : "Copy ecash"}
              </button>
            </div>

            <button
              onClick={dismissConfirmed}
              style={{
                width: "100%", padding: "10px 12px", borderRadius: T.rs, marginBottom: 8,
                background: confirmClear ? T.amber : T.surface,
                border: `1px solid ${confirmClear ? T.amber : T.border}`,
                color: confirmClear ? "#000" : T.muted,
                fontFamily: T.mono, fontSize: 11, fontWeight: 800, cursor: "pointer",
              }}
            >
              {confirmClear
                ? "Sure? Chama will forget this note — tap again only if it's saved"
                : "I've imported it — clear"}
            </button>
            <button
              onClick={onClose}
              style={{
                width: "100%", padding: "9px 12px", borderRadius: T.rs,
                background: "none", border: `1px solid ${T.border}`, color: T.muted,
                fontFamily: T.mono, fontSize: 11, fontWeight: 700, cursor: "pointer",
              }}
            >
              Keep it pending — I'll finish later
            </button>
          </>
        )}

        {phase === "error" && (
          <>
            <div style={{
              padding: "20px 16px", textAlign: "center", marginBottom: 12,
              background: T.redDim, border: `1px solid ${T.red}66`, borderRadius: T.r,
            }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>✕</div>
              <div style={{ fontSize: 12, fontWeight: 700, color: T.red, fontFamily: T.sans, marginBottom: 4 }}>
                Couldn't generate the note
              </div>
              <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {error}
              </div>
            </div>
            <button
              onClick={generate}
              style={{
                width: "100%", padding: "11px 16px", borderRadius: T.rs, marginBottom: 8,
                background: T.accent, border: `1px solid ${T.accent}`,
                color: "#000", fontFamily: T.mono, fontSize: 12, fontWeight: 800, cursor: "pointer",
              }}
            >
              Try again
            </button>
            <button
              onClick={onClose}
              style={{
                width: "100%", padding: "9px 16px", borderRadius: T.rs,
                background: "none", border: `1px solid ${T.border}`, color: T.muted,
                fontFamily: T.mono, fontSize: 11, fontWeight: 700, cursor: "pointer",
              }}
            >
              Close
            </button>
          </>
        )}
      </div>
    </div>
  );
}
