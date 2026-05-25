import { T } from "../theme.js";
import { BitcoinAmount } from "../components/BitcoinAmount.js";
import {
  lightningPayoutReserveSats,
  maxLightningPayoutSats,
} from "../../payments/lightning-fees.js";

// ══════════════════════════════════════════════════════════════════════════
// Chama — DestroyEcashConfirmModal
// ══════════════════════════════════════════════════════════════════════════
//
// Surfaces when a federation switch attempt would destroy ecash held in
// the user's current Chama. The button hierarchy has evolved across
// three releases as Pillar 2.1 doctrine tightened:
//
//   v0.1.83  Cancel  ·  Switch and destroy
//             Two-button: a binary choice between safety and destruction.
//             Wrong because it framed sat-loss as an equal-weight option.
//
//   v0.2.0   Withdraw via Lightning (primary)
//             Cancel — keep my sats (secondary)
//             Switch and destroy (tertiary, red)
//             Three-button: surfaced the safe path and demoted destroy
//             to muted styling. Withdraw opened FundWalletModal-Send-LN;
//             once balance reached zero, the shell auto-dispatched the
//             queued switch via pendingSwitchAfterWithdraw.
//
//   v0.3.0   ⚡ Recover N sats and switch (primary, accent)
//             Cancel — keep my Chama (secondary)
//             TWO-button: removes the destroy escape hatch entirely.
//             Pure Option B — there is no legitimate user flow where
//             destroying sats is correct. Sandbox-mode users who truly
//             need to nuke OPFS use Settings → Advanced → Sandbox →
//             Reset OPFS, the explicit power-user path.
//
// The pendingSwitchAfterWithdraw state machine in App.tsx is unchanged
// — only the trigger surface moves from FundWalletModal to
// RecoveryPayoutModal (which composes DestinationPicker).
export function DestroyEcashConfirmModal({
  targetLabel,
  balanceMsats,
  onCancel,
  onWithdraw,
}: {
  targetLabel: string;
  balanceMsats: number;
  /** Reverts to the current Chama; sats untouched. */
  onCancel: () => void;
  /** v0.3.0: opens RecoveryPayoutModal (DestinationPicker → outbound
   *  LN). The shell tracks the originally-attempted switch in
   *  pendingSwitchAfterWithdraw and auto-dispatches it once balance
   *  reaches zero. If the user cancels the picker before resolving,
   *  the shell drops the pending switch (explicit abandonment). */
  onWithdraw: () => void;
}) {
  const totalSats = Math.floor(Math.max(0, balanceMsats) / 1000);
  const recoverableSats = maxLightningPayoutSats(balanceMsats);
  const reserveSats = lightningPayoutReserveSats(balanceMsats);
  const recoveryLabel = recoverableSats > 0
    ? <BitcoinAmount sats={recoverableSats} size={13} gap={4} glyphScale={1.18} color={T.text} glyphColor={T.muted} />
    : "your recoverable balance";
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 20, zIndex: 1100,
    }}>
      <div style={{
        maxWidth: 440, width: "100%", padding: 20, borderRadius: T.r,
        background: T.card, border: `1px solid ${T.amber}66`,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 700, color: T.amber, fontFamily: T.mono,
          letterSpacing: 1, marginBottom: 12,
        }}>
          ⚠ FUNDS AT RISK
        </div>
        <div style={{
          fontSize: 13, color: T.text, fontFamily: T.sans, lineHeight: 1.55,
          marginBottom: 16,
        }}>
          Switching to <strong>{targetLabel}</strong> will move you to a
          different Chama. Your local wallet has{" "}
          <strong>{totalSats > 0 ? <BitcoinAmount sats={totalSats} size={13} gap={4} glyphScale={1.18} color={T.text} glyphColor={T.muted} /> : "a balance"}</strong>{" "}
          on this Chama; <strong>{recoveryLabel}</strong> can be recovered to
          your Lightning wallet first.
        </div>
        <div style={{
          fontSize: 11, color: T.muted, fontFamily: T.mono, lineHeight: 1.5,
          marginBottom: 16,
        }}>
          This guard is based on local wallet balance, not trade history.
          {reserveSats > 0 && (
            <>
              {" "}About <BitcoinAmount sats={reserveSats} size={11} gap={4} glyphScale={1.18} color={T.muted} glyphColor={T.muted} /> are reserved for Lightning fees.
            </>
          )}
          {" "}Fedimint ecash is bearer cash — once your local Chama is wiped,
          those sats cannot be recovered from this device.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {/* Primary: recover, then auto-dispatch the queued switch.
              Bitcoin-orange to match Pillar 5.2 (accent = sats moving
              with intent). */}
          <button
            onClick={onWithdraw}
            style={{
              width: "100%", padding: "12px 14px", borderRadius: T.rs,
              background: T.accent, border: "none",
              color: T.bg, fontFamily: T.mono, fontSize: 13, fontWeight: 800,
              cursor: "pointer", letterSpacing: 0.3,
            }}
          >
            ⚡ Recover{recoverableSats > 0 ? <> <BitcoinAmount sats={recoverableSats} size={13} gap={4} glyphScale={1.18} color="inherit" glyphColor="inherit" /></> : ""} and switch →
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
            Cancel — keep my Chama
          </button>
        </div>
      </div>
    </div>
  );
}
