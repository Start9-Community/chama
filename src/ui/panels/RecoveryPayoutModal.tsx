// ══════════════════════════════════════════════════════════════════════════
// Chama — RecoveryPayoutModal (v0.3.0 Phase 4)
// ══════════════════════════════════════════════════════════════════════════
//
// User-controlled balance drain to a Lightning destination. Used by:
//   - RecoveryBanner: stranded balance from prior failed trade
//   - DestroyEcashConfirmModal: forced recover-first before fed switch
//
// Compositional contract (per Phase 3+4 reminder #1): mounts
// <DestinationPicker /> as the canonical consumer surface for Tier
// 1/2/3 destination input. Picker internals are NOT reached here —
// the shell stays the entry point.
//
// Phase orchestration lives in src/payments/balance-recovery.ts.

import { useState } from "react";
import { T } from "../theme.js";
import { DestinationPicker } from "../components/DestinationPicker.js";
import type { PayoutDestination } from "../../payments/payout-destinations.js";
import {
  lightningPayoutReserveSats,
  maxLightningPayoutSats,
} from "../../payments/lightning-fees.js";
import type {
  RecoveryPayoutPhase,
  RecoveryPayoutTerminal,
} from "../../payments/balance-recovery.js";

export interface RecoveryPayoutModalProps {
  /** Stranded balance in millisatoshis. */
  balanceMsats: number;
  /** Saved Lightning Address payout destinations for the picker's Tier 1 list. */
  savedDestinations: PayoutDestination[];
  /** Title shown in the modal header. Caller customizes per surface
   *  (e.g. "Recover sats", "Recover & switch Chama"). */
  title: string;
  /** Optional subtitle below the amount. */
  subtitle?: string;
  /** Bound to actions.payInvoice. */
  payInvoice: (bolt11: string) => Promise<void>;
  /** Bound to addOrTouchPayoutDestination from payout-destinations.ts. */
  addOrTouchPayoutDestination: (address: string) => void;
  /** Closed when the modal terminates (success, cancel, or error).
   *  terminal=undefined means the user dismissed the picker before
   *  resolving — nothing happened, no orphan was created. */
  onClose: (terminal?: RecoveryPayoutTerminal) => void;
}

type Stage =
  | { kind: "picking" }
  | { kind: "running"; phase: RecoveryPayoutPhase }
  | { kind: "terminal"; terminal: RecoveryPayoutTerminal };

export function RecoveryPayoutModal({
  balanceMsats,
  savedDestinations,
  title,
  subtitle,
  payInvoice,
  addOrTouchPayoutDestination,
  onClose,
}: RecoveryPayoutModalProps) {
  const payoutSats = maxLightningPayoutSats(balanceMsats);
  const reserveSats = lightningPayoutReserveSats(balanceMsats);
  const feeReserveNote = reserveSats > 0
    ? `About ${reserveSats.toLocaleString()} sats stays available for Lightning fees.`
    : "";
  const pickerSubtitle =
    subtitle
      ? [subtitle, feeReserveNote].filter(Boolean).join(" ")
      : (
          reserveSats > 0
            ? `Send ${payoutSats.toLocaleString()} sats to your Lightning address. ${feeReserveNote}`
            : `Send ${payoutSats.toLocaleString()} sats to your Lightning address`
        );
  const [stage, setStage] = useState<Stage>({ kind: "picking" });

  if (stage.kind === "picking") {
    return (
      <DestinationPicker
        amountSats={payoutSats}
        savedDestinations={savedDestinations}
        title={title}
        subtitle={pickerSubtitle}
        onResolve={async (bolt11, opts) => {
          setStage({ kind: "running", phase: { kind: "paying-invoice" } });
          // Lazy-import the orchestrator so the modal stays light
          // when not mounted (consistent with Phase 2/3 hooks).
          const { runRecoveryPayout } = await import("../../payments/balance-recovery.js");
          const terminal = await runRecoveryPayout({
            bolt11,
            saveAfter: opts.saveAfter,
            addressUsed: opts.addressUsed,
            payInvoice,
            addOrTouchLightningHandle: addOrTouchPayoutDestination,
            onPhase: (phase) => setStage({ kind: "running", phase }),
          });
          setStage({ kind: "terminal", terminal });
          if (terminal.kind === "done") {
            setTimeout(() => onClose(terminal), 1500);
          }
        }}
        onCancel={() => onClose(undefined)}
      />
    );
  }

  // Stage 2/3: post-picker frame.
  return (
    <div
      onClick={() => {
        if (stage.kind === "terminal") onClose(stage.terminal);
      }}
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
          padding: 24, maxWidth: 420, width: "100%",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 4 }}>
              {title.toUpperCase()}
            </div>
            <div style={{ fontSize: 22, fontWeight: 800, color: T.text, fontFamily: T.mono, letterSpacing: -0.5 }}>
              {payoutSats.toLocaleString()} <span style={{ color: T.muted, fontWeight: 600, fontSize: 14 }}>sats</span>
            </div>
          </div>
          {stage.kind === "terminal" && (
            <button onClick={() => onClose(stage.terminal)} style={{
              background: "none", border: "none", color: T.muted,
              fontFamily: T.mono, fontSize: 18, cursor: "pointer", padding: 0, lineHeight: 1,
            }}>×</button>
          )}
        </div>

        {stage.kind === "running" && <RunningPanel />}

        {stage.kind === "terminal" && (
          <TerminalPanel terminal={stage.terminal} onClose={() => onClose(stage.terminal)} />
        )}
      </div>
    </div>
  );
}

function RunningPanel() {
  return (
    <div style={{
      padding: "32px 16px", textAlign: "center",
      background: T.amberDim, border: `1px solid ${T.amber}44`, borderRadius: T.r,
    }}>
      <div style={{
        width: 10, height: 10, borderRadius: "50%",
        background: T.amber, animation: "pulse 1.4s ease-in-out infinite",
        margin: "0 auto 12px",
      }} />
      <div style={{ fontSize: 11, fontWeight: 600, color: T.amber, fontFamily: T.mono, letterSpacing: 1 }}>
        SENDING TO YOUR WALLET…
      </div>
    </div>
  );
}

function TerminalPanel({
  terminal, onClose,
}: { terminal: RecoveryPayoutTerminal; onClose: () => void }) {
  if (terminal.kind === "done") {
    return (
      <div style={{
        padding: "32px 16px", textAlign: "center",
        background: T.greenDim, border: `1px solid ${T.green}66`,
        borderRadius: T.r, animation: "fadeIn 0.3s ease",
      }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>✓</div>
        <div style={{ fontSize: 14, fontWeight: 700, color: T.green, fontFamily: T.sans, marginBottom: 6 }}>
          Recovered to your wallet
        </div>
        <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginTop: 12 }}>
          Closing…
        </div>
      </div>
    );
  }

  // payout-failed
  return (
    <div>
      <div style={{
        padding: "20px 16px", textAlign: "center",
        background: T.redDim, border: `1px solid ${T.red}66`, borderRadius: T.r,
        marginBottom: 12,
      }}>
        <div style={{ fontSize: 24, marginBottom: 8 }}>✕</div>
        <div style={{ fontSize: 12, fontWeight: 700, color: T.red, fontFamily: T.sans, marginBottom: 4 }}>
          Recovery couldn't be sent
        </div>
        <div style={{
          fontSize: 10, color: T.muted, fontFamily: T.mono,
          whiteSpace: "pre-wrap", wordBreak: "break-word",
        }}>
          {terminal.error}{"\n\n"}Your sats are still in your Chama. Try again from the recovery banner.
        </div>
      </div>
      <button
        onClick={onClose}
        style={{
          width: "100%", padding: "10px 16px", borderRadius: T.rs,
          background: T.surface, border: `1px solid ${T.border}`,
          color: T.muted, fontFamily: T.mono, fontSize: 11, fontWeight: 700,
          cursor: "pointer",
        }}
      >
        Close
      </button>
    </div>
  );
}
