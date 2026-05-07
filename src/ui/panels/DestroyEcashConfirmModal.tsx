import { T } from "../theme.js";

// Surfaces when a federation switch attempt would destroy ecash held
// in the user's current Chama. v0.2.0 item 8: three-button
// restructure. Pre-v0.2.0 the modal forced a binary choice between
// "Cancel" and "Switch and destroy", which violated Pillar 2.1 by
// presenting sat-loss as an equal-weight option to safety. v0.2.0
// surfaces a primary "Withdraw via Lightning" CTA that opens the
// FundWalletModal-Send-LN flow; once balance reaches zero the shell
// auto-dispatches the originally-attempted switch.
//
// Final button order:
//   1. Withdraw via Lightning (primary, accent) — preserves sats,
//      then re-prompts the switch
//   2. Cancel — keep my sats (secondary, neutral) — reverts to the
//      current Chama; sats untouched
//   3. Switch and destroy (tertiary, red) — existing force-override;
//      destroys the balance held under the current fed
export function DestroyEcashConfirmModal({
  targetLabel,
  balanceMsats,
  onCancel,
  onConfirm,
  onWithdraw,
}: {
  targetLabel: string;
  balanceMsats: number;
  onCancel: () => void;
  onConfirm: () => void;
  /** v0.2.0 item 8: opens the FundWalletModal-Send-LN flow. The shell
   *  tracks the originally-attempted switch in state and auto-
   *  dispatches it when balance reaches zero. If the user cancels
   *  the withdraw before draining, the shell drops the pending
   *  switch (per Q4: cancel = explicit abandonment). */
  onWithdraw: () => void;
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
          Switching to <strong>{targetLabel}</strong> will destroy{" "}
          <strong>{sats > 0 ? `${sats.toLocaleString()} sats` : "an unknown balance"}</strong>{" "}
          held in your current Chama. Move them out via Lightning first
          to keep them safe.
        </div>
        <div style={{
          fontSize: 11, color: T.muted, fontFamily: T.mono, lineHeight: 1.5,
          marginBottom: 16,
        }}>
          Fedimint ecash is bearer cash — once your local Chama is wiped,
          those sats cannot be recovered from the Chama.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {/* Primary: withdraw via Lightning. Bitcoin-orange to match
              Pillar 5.2's role-color semantics (accent = sats moving). */}
          <button
            onClick={onWithdraw}
            style={{
              width: "100%", padding: "12px 14px", borderRadius: T.rs,
              background: T.accent, border: "none",
              color: T.bg, fontFamily: T.mono, fontSize: 13, fontWeight: 800,
              cursor: "pointer", letterSpacing: 0.3,
            }}
          >
            ⚡ Withdraw via Lightning
            {sats > 0 && (
              <span style={{ marginLeft: 6, fontWeight: 600 }}>
                · {sats.toLocaleString()} sats
              </span>
            )}
          </button>
          {/* Secondary: keep current Chama, abandon the switch. */}
          <button
            onClick={onCancel}
            style={{
              width: "100%", padding: "10px 14px", borderRadius: T.rs,
              background: T.surface, border: `1px solid ${T.border}`,
              color: T.text, fontFamily: T.mono, fontSize: 12, fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Cancel — keep my sats
          </button>
          {/* Tertiary: force-override. Destructive; muted styling so
              it doesn't compete with the safe paths. */}
          <button
            onClick={onConfirm}
            style={{
              width: "100%", padding: "10px 14px", borderRadius: T.rs,
              background: "transparent", border: `1px solid ${T.red}66`,
              color: T.red, fontFamily: T.mono, fontSize: 11, fontWeight: 600,
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
