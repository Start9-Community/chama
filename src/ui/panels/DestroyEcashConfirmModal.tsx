import { T } from "../theme.js";

// Surfaces when initFedimint refuses with RECONCILE_REFUSED_NONZERO_BALANCE.
// User picked federation B but the OPFS holds sats on federation A.
// Confirm = wipe + rejoin B (sats destroyed). Cancel = revert to A.
export function DestroyEcashConfirmModal({
  targetLabel,
  balanceMsats,
  onCancel,
  onConfirm,
}: {
  targetLabel: string;
  balanceMsats: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const sats = Math.floor(balanceMsats / 1000);
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 20, zIndex: 1100,
    }}>
      <div style={{
        maxWidth: 440, width: "100%", padding: 20, borderRadius: T.r,
        background: T.card, border: `1px solid ${T.red}66`,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 700, color: T.red, fontFamily: T.mono,
          letterSpacing: 1, marginBottom: 12,
        }}>
          ⚠ FUNDS AT RISK
        </div>
        <div style={{
          fontSize: 13, color: T.text, fontFamily: T.sans, lineHeight: 1.55,
          marginBottom: 16,
        }}>
          Switching to <strong>{targetLabel}</strong> will permanently destroy{" "}
          <strong>{sats > 0 ? `${sats.toLocaleString()} sats` : "an unknown balance"}</strong>{" "}
          held in your current Chama. Fedimint ecash is bearer cash — once
          your local Chama is wiped, those sats cannot be recovered from
          the federation.
        </div>
        <div style={{
          fontSize: 11, color: T.muted, fontFamily: T.mono, lineHeight: 1.5,
          marginBottom: 16,
        }}>
          To preserve them: cancel, withdraw the balance via Lightning, then
          retry the switch.
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={onCancel}
            style={{
              flex: 1, padding: "10px 14px", borderRadius: T.rs,
              background: T.accent, border: "none",
              color: "#000", fontFamily: T.mono, fontSize: 12, fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Cancel — keep my sats
          </button>
          <button
            onClick={onConfirm}
            style={{
              flex: 1, padding: "10px 14px", borderRadius: T.rs,
              background: T.red, border: "none",
              color: "#fff", fontFamily: T.mono, fontSize: 12, fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Switch and destroy
          </button>
        </div>
      </div>
    </div>
  );
}
