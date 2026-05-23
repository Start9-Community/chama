// ══════════════════════════════════════════════════════════════════════════
// Chama — ClaimPayoutModal (v0.3.0 send-side atomic flow)
// ══════════════════════════════════════════════════════════════════════════
//
// User taps Claim → DestinationPicker presents payout destinations + new-
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
//
// v0.3.1 Phase 1: adds the `claim-bridge-threw` terminal panel with a
// Try-again affordance. Per Q2 of the v0.3.1 plan, retry is two-step:
// (1) probe the federation; (2) if probe succeeds, re-dispatch
// claimAndPayout with the same destination; if probe fails, stay on
// the same terminal with an updated error message. Avoids the confusing
// "tapped Try again, got same error instantly" UX (Pillar 2.7).

import { useEffect, useRef, useState } from "react";
import { T } from "../theme.js";
import { DestinationPicker } from "../components/DestinationPicker.js";
import type { PayoutDestination } from "../../payments/payout-destinations.js";
import {
  createChapsmartPayoutInvoice,
  getChapsmartPayoutProfile,
  isChapsmartPayoutEligible,
  saveChapsmartPayoutProfile,
} from "../../payments/chapsmart-payout.js";
import {
  claimPayoutReserveSats,
  claimPayoutSats,
} from "../../payments/lightning-fees.js";
import type {
  ClaimAndPayoutPhase,
  ClaimAndPayoutTerminal,
} from "../../payments/claim-and-payout.js";

export interface ClaimPayoutModalProps {
  /** Trade ID being claimed. Passed through to claimAndPayout. */
  escrowId: string;
  /** Post-escrow-fee payout amount in millisatoshis. claimAndPayout
   *  uses this as expectedDeltaMsats; the Lightning invoice amount is
   *  reduced slightly in the modal so the wallet can pay outbound LN
   *  fees from the same balance. */
  payoutMsats: number;
  /** Saved Lightning Address payout destinations for the picker's Tier 1
   *  list. Caller fetches via listPayoutDestinations(); the modal does
   *  not re-fetch. */
  savedDestinations: PayoutDestination[];
  /** User's selected country/community Chama. Enables local payout rails
   *  such as Chapsmart when the user lives in Tanzania. */
  homeCommunity?: string | null;
  /** Active trade fiat currency. Lets TZS trades expose Chapsmart even
   *  when an older user has no home-community selection yet. */
  fiatCurrency?: string | null;
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
  /** Fedi Mini-App path: claim directly into the host Fedi wallet with
   *  window.fediInternal.receiveEcash instead of asking for a Lightning
   *  payout destination. */
  claimTarget?: "lightning" | "fedi-wallet";
  /** v0.3.1 Phase 1: bound to actions.probeFederation. Called from the
   *  Try-again button on claim-bridge-threw terminal. Returns ok/error
   *  shape (never throws). The retry path only re-dispatches the claim
   *  if the probe returns ok. */
  probeFederation: () => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Closed when the modal terminates (success, cancel, or error).
   *  Consumer reads the terminal kind to surface a toast. Undefined
   *  means user dismissed the picker before resolving. */
  onClose: (terminal?: ClaimAndPayoutTerminal) => void;
}

type Stage =
  | { kind: "picking" }
  | { kind: "running"; phase: ClaimAndPayoutPhase }
  | { kind: "terminal"; terminal: ClaimAndPayoutTerminal };

/** Stashed dispatch arguments from the initial picker resolve. Used by
 *  retry paths to re-dispatch with the same destination after a
 *  successful re-probe. */
interface DispatchArgs {
  bolt11: string;
  saveAfter: boolean;
  addressUsed?: string;
}

export function ClaimPayoutModal({
  escrowId,
  payoutMsats,
  savedDestinations,
  homeCommunity,
  fiatCurrency,
  claimAndPayout,
  claimTarget = "lightning",
  probeFederation,
  onClose,
}: ClaimPayoutModalProps) {
  const payoutSats = claimPayoutSats(payoutMsats, claimTarget);
  const reserveSats = claimPayoutReserveSats(payoutMsats, claimTarget);
  const [stage, setStage] = useState<Stage>({ kind: "picking" });
  // Retry state: when a retryable terminal is up, the "Try again"
  // button toggles this to render the inline probing spinner.
  const [retryProbing, setRetryProbing] = useState(false);
  // Stashed dispatch args. Set when the picker resolves; reused on
  // Try-again so the retry uses the exact same destination/save
  // semantics as the original attempt.
  const lastDispatchRef = useRef<DispatchArgs | null>(null);
  const chapsmartEligible = isChapsmartPayoutEligible({ homeCommunity, fiatCurrency });

  // Common dispatch helper — used by both the picker's first resolve
  // and the terminal retry path. Updates stage transitions and
  // schedules auto-close on success.
  const dispatchClaim = async (args: DispatchArgs) => {
    setStage({ kind: "running", phase: { kind: "claiming" } });
    const terminal = await claimAndPayout(escrowId, {
      bolt11: args.bolt11,
      expectedDeltaMsats: payoutMsats,
      saveAfter: args.saveAfter,
      addressUsed: args.addressUsed,
      onPhase: (phase) => setStage({ kind: "running", phase }),
    });
    setStage({ kind: "terminal", terminal });
    if (terminal.kind === "done") {
      // Auto-close on success after a brief celebratory beat.
      setTimeout(() => onClose(terminal), 1500);
    }
  };

  useEffect(() => {
    if (claimTarget !== "fedi-wallet") return;
    if (stage.kind !== "picking") return;
    if (lastDispatchRef.current) return;
    lastDispatchRef.current = {
      bolt11: "fedi-internal://receive-ecash",
      saveAfter: false,
    };
    void dispatchClaim(lastDispatchRef.current);
  }, [claimTarget, stage.kind]);

  const resolveDestination = (bolt11: string, opts: { saveAfter: boolean; addressUsed?: string }) => {
    lastDispatchRef.current = {
      bolt11,
      saveAfter: opts.saveAfter,
      addressUsed: opts.addressUsed,
    };
    // Fire-and-forget — dispatchClaim manages its own stage
    // transitions and terminal handling.
    void dispatchClaim(lastDispatchRef.current);
  };

  // Terminal retry handler. Two-step per Q2: probe first, then
  // re-dispatch only on probe success. Stays on terminal with updated
  // error if the probe still fails.
  const handleClaimRetry = async () => {
    const args = lastDispatchRef.current;
    if (!args) return;
    setRetryProbing(true);
    try {
      const probe = await probeFederation();
      if (!probe.ok) {
        setStage({
          kind: "terminal",
          terminal: {
            kind: "claim-bridge-threw",
            error: probe.error || "Federation still unreachable",
          },
        });
        return;
      }
      // Probe succeeded — re-dispatch from scratch. dispatchClaim
      // moves stage off the terminal as its first act.
      await dispatchClaim(args);
    } finally {
      setRetryProbing(false);
    }
  };

  // Stage 1: DestinationPicker. The shell handles all three tiers
  // internally. We pass amountSats so the LNURL resolver requests an
  // invoice of exactly the right size.
  if (stage.kind === "picking") {
    if (claimTarget === "fedi-wallet") {
      return (
        <div
          style={{
            position: "fixed", inset: 0, background: "#000c", zIndex: 9998,
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: 16, animation: "fadeIn 0.2s ease",
          }}
        />
      );
    }

    return (
      <DestinationPicker
        amountSats={payoutSats}
        savedDestinations={savedDestinations}
        title="Claim your sats"
        subtitle={
          reserveSats > 0
            ? `Send ${payoutSats.toLocaleString()} sats to your Lightning wallet. About ${reserveSats.toLocaleString()} sats stays available for Lightning fees.`
            : `Send ${payoutSats.toLocaleString()} sats to your Lightning wallet`
        }
        topSlot={chapsmartEligible ? (
          <ChapsmartPayoutOption
            escrowId={escrowId}
            amountSats={payoutSats}
            onResolve={(bolt11) => resolveDestination(bolt11, { saveAfter: false })}
          />
        ) : undefined}
        onResolve={resolveDestination}
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
          {stage.kind === "terminal" && !retryProbing && (
            <button onClick={() => onClose(stage.terminal)} style={{
              background: "none", border: "none", color: T.muted,
              fontFamily: T.mono, fontSize: 18, cursor: "pointer", padding: 0, lineHeight: 1,
            }}>×</button>
          )}
        </div>

        {stage.kind === "running" && <RunningPanel phase={stage.phase} />}

        {stage.kind === "terminal" && (
          <TerminalPanel
            terminal={stage.terminal}
            retryProbing={retryProbing}
            onRetry={handleClaimRetry}
            onClose={() => onClose(stage.terminal)}
          />
        )}
      </div>
    </div>
  );
}

function ChapsmartPayoutOption({
  escrowId,
  amountSats,
  onResolve,
}: {
  escrowId: string;
  amountSats: number;
  onResolve: (bolt11: string) => void;
}) {
  const profile = getChapsmartPayoutProfile();
  const [phoneNumber, setPhoneNumber] = useState(profile?.phoneNumber ?? "");
  const [recipientName, setRecipientName] = useState(profile?.recipientName ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleChapsmart = async () => {
    setErr(null);
    setBusy(true);
    try {
      const saved = saveChapsmartPayoutProfile({ phoneNumber, recipientName });
      const invoice = await createChapsmartPayoutInvoice({
        phoneNumber: saved.phoneNumber,
        recipientName: saved.recipientName,
        amountSatsMax: amountSats,
        escrowId,
      });
      onResolve(invoice.bolt11);
    } catch (e: any) {
      setErr(e?.message || "Chapsmart payout is not ready yet");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      padding: 12, borderRadius: T.r,
      background: T.tealDim, border: `1px solid ${T.teal}44`,
    }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        gap: 10, marginBottom: 10,
      }}>
        <div style={{ textAlign: "left" }}>
          <div style={{
            fontSize: 11, color: T.teal, fontFamily: T.mono,
            fontWeight: 900, letterSpacing: 0.4,
          }}>
            M-PESA VIA CHAPSMART
          </div>
          <div style={{
            fontSize: 10, color: T.muted, fontFamily: T.sans,
            marginTop: 2,
          }}>
            Send up to {amountSats.toLocaleString()} sats as TZS
          </div>
        </div>
        <span style={{ fontSize: 22, lineHeight: 1 }}>🇹🇿</span>
      </div>
      <div style={{ display: "grid", gap: 8, marginBottom: 10 }}>
        <input
          value={phoneNumber}
          onChange={(e) => { setPhoneNumber(e.target.value); setErr(null); }}
          placeholder="+255 71 234 5678"
          type="tel"
          disabled={busy}
          style={{
            width: "100%", padding: "10px 12px", boxSizing: "border-box",
            background: T.bg, border: `1px solid ${T.border}`,
            borderRadius: T.rs, color: T.text,
            fontFamily: T.sans, fontSize: 13, outline: "none",
          }}
        />
        <input
          value={recipientName}
          onChange={(e) => { setRecipientName(e.target.value); setErr(null); }}
          placeholder="Recipient full name"
          type="text"
          disabled={busy}
          style={{
            width: "100%", padding: "10px 12px", boxSizing: "border-box",
            background: T.bg, border: `1px solid ${T.border}`,
            borderRadius: T.rs, color: T.text,
            fontFamily: T.sans, fontSize: 13, outline: "none",
          }}
        />
      </div>
      {err && (
        <div style={{
          marginBottom: 8, padding: "8px 10px",
          background: T.redDim, border: `1px solid ${T.red}33`,
          borderRadius: T.rs, color: T.red,
          fontSize: 10, fontFamily: T.mono,
        }}>
          {err}
        </div>
      )}
      <button
        onClick={handleChapsmart}
        disabled={busy || !phoneNumber.trim() || !recipientName.trim()}
        style={{
          width: "100%", padding: "11px 12px", borderRadius: T.rs,
          background: busy || !phoneNumber.trim() || !recipientName.trim() ? T.surface : T.teal,
          border: `1px solid ${busy || !phoneNumber.trim() || !recipientName.trim() ? T.border : T.teal}`,
          color: busy || !phoneNumber.trim() || !recipientName.trim() ? T.muted : T.bg,
          fontFamily: T.mono, fontSize: 11, fontWeight: 900,
          cursor: busy || !phoneNumber.trim() || !recipientName.trim() ? "default" : "pointer",
        }}
      >
        {busy ? "Getting Chapsmart invoice..." : "Send to M-Pesa"}
      </button>
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
  terminal, retryProbing, onRetry, onClose,
}: {
  terminal: ClaimAndPayoutTerminal;
  retryProbing: boolean;
  onRetry: () => void;
  onClose: () => void;
}) {
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

  // Error states share a common card layout but vary in tone + message
  // + retry affordance.
  let title: string;
  let subtitle: string;
  let tone: string;
  let toneDim: string;
  let icon: string;
  let showRetry = false;

  if (terminal.kind === "claim-failed") {
    const settlementFailed = /reissue|consumed|settle/i.test(terminal.error);
    title = settlementFailed ? "Claim did not settle" : "Couldn't recover your share";
    subtitle = terminal.error;
    tone = T.red;
    toneDim = T.redDim;
    icon = "✕";
  } else if (terminal.kind === "claim-bridge-threw") {
    // v0.3.1 Phase 1: retry-able structural failure (FED_PROBE_FAILED
    // / FED_MISMATCH). Surface the actual underlying error and offer
    // Try again. No sats moved — safe to retry.
    title = "Couldn't reach your Chama";
    subtitle = terminal.error;
    tone = T.amber;
    toneDim = T.amberDim;
    icon = "⚠";
    showRetry = true;
  } else if (terminal.kind === "claim-pending") {
    title = "Your sats are still arriving";
    subtitle = terminal.error;
    tone = T.amber;
    toneDim = T.amberDim;
    icon = "⏳";
    showRetry = true;
  } else {
    // payout-failed
    title = "Payout couldn't be sent";
    subtitle = `${terminal.error}\n\nYour sats are safe in your Chama. Close this and use the Recovery banner to retry the payout only.`;
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
      {showRetry && (
        <button
          disabled={retryProbing}
          onClick={onRetry}
          style={{
            width: "100%", padding: "12px 16px", borderRadius: T.rs,
            background: retryProbing ? T.surface : T.accent,
            border: `1px solid ${T.accent}`,
            color: retryProbing ? T.muted : "#000",
            fontFamily: T.mono, fontSize: 12, fontWeight: 800,
            cursor: retryProbing ? "not-allowed" : "pointer",
            marginBottom: 8,
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          }}
        >
          {retryProbing && (
            <span style={{
              width: 8, height: 8, borderRadius: "50%",
              background: T.muted, animation: "pulse 1.4s ease-in-out infinite",
            }} />
          )}
          {retryProbing ? "Checking your Chama…" : "Try again"}
        </button>
      )}
      <button
        onClick={onClose}
        disabled={retryProbing}
        style={{
          width: "100%", padding: "10px 16px", borderRadius: T.rs,
          background: T.surface, border: `1px solid ${T.border}`,
          color: T.muted, fontFamily: T.mono, fontSize: 11, fontWeight: 700,
          cursor: retryProbing ? "not-allowed" : "pointer",
        }}
      >
        {terminal.kind === "payout-failed" ? "Show recovery" : "Close"}
      </button>
    </div>
  );
}
