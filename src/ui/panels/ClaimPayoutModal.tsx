// ══════════════════════════════════════════════════════════════════════════
// Chama — ClaimPayoutModal (v0.3.0 send-side atomic flow)
// ══════════════════════════════════════════════════════════════════════════
//
// User taps Claim → DestinationPicker presents saved LN handles + new-
// address input + BOLT11 paste (Tier 1/2/3) → user picks destination
// → claimAndPayout dispatches decrypt-shares → SSS-combine →
// redeemEcash → outbound LN payment. The user never holds an
// intermediate balance (Pillar 2.1 Option B).
//
// Compositional contract: this modal mounts <DestinationPicker /> as
// the canonical consumer surface for Tier 1/2/3 destination input.
// Picker internals (destination-picker-logic.ts) are NOT reached here —
// the shell stays the entry point. Same discipline applied in Phase 4
// (recovery banner) and Phase 4 (destroy modal).
//
// Phase orchestration lives in src/payments/claim-and-payout.ts. This
// file is the React shell that renders the picker → running →
// terminal sequence.

import { useState } from "react";
import { T } from "../theme.js";
import { DestinationPicker } from "../components/DestinationPicker.js";
import type { SavedHandle } from "../../payments/saved-handles.js";
import type {
  ClaimAndPayoutPhase,
  ClaimAndPayoutTerminal,
} from "../../payments/claim-and-payout.js";

export interface ClaimPayoutModalProps {
  /** Trade ID being claimed. Passed through to claimAndPayout. */
  escrowId: string;
  /** Post-fee payout amount the winner receives, in millisatoshis.
   *  Passed to DestinationPicker as the BOLT11 amount and to
   *  claimAndPayout as expectedDeltaMsats. */
  payoutMsats: number;
  /** Saved Lightning Address handles for the picker's Tier 1 list.
   *  Caller fetches via getSavedLightningHandles(); the modal does not
   *  re-fetch. */
  savedHandles: SavedHandle[];
  /** Bound to actions.claimAndPayout from useEscrow. */
  claimAndPayout: (
    escrowId: string,
    args: {
      bolt11: string;
      expectedDeltaMsats: number;
      saveAfter: boolean;
      addressUsed?: string;
      onPhase: (phase: ClaimAndPayoutPhase) => void;
    },
  ) => Promise<ClaimAndPayoutTerminal>;
  /** Closed when the modal terminates (success, cancel, or error).
   *  Consumer reads the terminal kind to surface a toast. Undefined
   *  means user dismissed the picker before resolving. */
  onClose: (terminal?: ClaimAndPayoutTerminal) => void;
}

type Stage =
  | { kind: "picking" }
  | { kind: "running"; phase: ClaimAndPayoutPhase }
  | { kind: "terminal"; terminal: ClaimAndPayoutTerminal };

export function ClaimPayoutModal({
  escrowId,
  payoutMsats,
  savedHandles,
  claimAndPayout,
  onClose,
}: ClaimPayoutModalProps) {
  const payoutSats = Math.floor(payoutMsats / 1000);
  const [stage, setStage] = useState<Stage>({ kind: "picking" });

  // Stage 1: DestinationPicker. The shell handles all three tiers
  // internally. We pass amountSats so the LNURL resolver requests an
  // invoice of exactly the right size.
  if (stage.kind === "picking") {
    return (
      <DestinationPicker
        amountSats={payoutSats}
        savedHandles={savedHandles}
        title="Claim your sats"
        subtitle={`Send ${payoutSats.toLocaleString()} sats to your Lightning wallet`}
        onResolve={async (bolt11, opts) => {
          setStage({ kind: "running", phase: { kind: "claiming" } });
          const terminal = await claimAndPayout(escrowId, {
            bolt11,
            expectedDeltaMsats: payoutMsats,
            saveAfter: opts.saveAfter,
            addressUsed: opts.addressUsed,
            onPhase: (phase) => setStage({ kind: "running", phase }),
          });
          setStage({ kind: "terminal", terminal });
          if (terminal.kind === "done") {
            // Auto-close on success after a brief celebratory beat.
            setTimeout(() => onClose(terminal), 1500);
          }
        }}
        onCancel={() => onClose(undefined)}
      />
    );
  }

  // Stage 2/3: post-picker frame — running or terminal. Same modal
  // shell as DestinationPicker, different content.
  return (
    <div
      onClick={() => {
        // Only allow click-outside to dismiss when terminal (not while
        // claim+payout is in flight — closing mid-flow can't actually
        // cancel the dispatch and would leave the user confused).
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
              CLAIM
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

        {stage.kind === "running" && <RunningPanel phase={stage.phase} />}

        {stage.kind === "terminal" && (
          <TerminalPanel terminal={stage.terminal} onClose={() => onClose(stage.terminal)} />
        )}
      </div>
    </div>
  );
}

// ── Sub-panels ──────────────────────────────────────────────────────────

function RunningPanel({ phase }: { phase: ClaimAndPayoutPhase }) {
  const message =
    phase.kind === "claiming" ? "Recovering your share…" :
    phase.kind === "confirming" ? "Confirming with the federation…" :
    phase.kind === "paying-invoice" ? "Sending to your wallet…" :
    "Working…";
  const tone =
    phase.kind === "paying-invoice" ? T.amber :
    phase.kind === "confirming" ? T.amber :
    T.purple;
  const toneDim =
    phase.kind === "paying-invoice" ? T.amberDim :
    phase.kind === "confirming" ? T.amberDim :
    T.purpleDim;

  return (
    <div style={{
      padding: "32px 16px", textAlign: "center",
      background: toneDim, border: `1px solid ${tone}44`, borderRadius: T.r,
    }}>
      <div style={{
        width: 10, height: 10, borderRadius: "50%",
        background: tone, animation: "pulse 1.4s ease-in-out infinite",
        margin: "0 auto 12px",
      }} />
      <div style={{ fontSize: 11, fontWeight: 600, color: tone, fontFamily: T.mono, letterSpacing: 1 }}>
        {message.toUpperCase()}
      </div>
    </div>
  );
}

function TerminalPanel({
  terminal, onClose,
}: { terminal: ClaimAndPayoutTerminal; onClose: () => void }) {
  if (terminal.kind === "done") {
    return (
      <div style={{
        padding: "32px 16px", textAlign: "center",
        background: T.greenDim, border: `1px solid ${T.green}66`,
        borderRadius: T.r, animation: "fadeIn 0.3s ease",
      }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>✓</div>
        <div style={{ fontSize: 14, fontWeight: 700, color: T.green, fontFamily: T.sans, marginBottom: 6 }}>
          Sent to your wallet
        </div>
        <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginTop: 12 }}>
          Closing…
        </div>
      </div>
    );
  }

  // Error states share a common card layout but vary in tone + message.
  let title: string;
  let subtitle: string;
  let tone: string;
  let toneDim: string;
  let icon: string;

  if (terminal.kind === "claim-failed") {
    title = "Couldn't recover your share";
    subtitle = terminal.error;
    tone = T.red;
    toneDim = T.redDim;
    icon = "✕";
  } else if (terminal.kind === "claim-pending") {
    title = "Your sats are still arriving";
    subtitle = terminal.error;
    tone = T.amber;
    toneDim = T.amberDim;
    icon = "⏳";
  } else {
    // payout-failed
    title = "Payout couldn't be sent";
    subtitle = `${terminal.error}\n\nYour sats are safe in your Chama. Use the Recovery banner on Browse to retry.`;
    tone = T.amber;
    toneDim = T.amberDim;
    icon = "⏳";
  }

  return (
    <div>
      <div style={{
        padding: "20px 16px", textAlign: "center",
        background: toneDim, border: `1px solid ${tone}66`, borderRadius: T.r,
        marginBottom: 12,
      }}>
        <div style={{ fontSize: 28, marginBottom: 8 }}>{icon}</div>
        <div style={{ fontSize: 12, fontWeight: 700, color: tone, fontFamily: T.sans, marginBottom: 4 }}>
          {title}
        </div>
        <div style={{
          fontSize: 10, color: T.muted, fontFamily: T.mono,
          whiteSpace: "pre-wrap", wordBreak: "break-word",
        }}>
          {subtitle}
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
