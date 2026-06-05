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
import { BitcoinAmount } from "../components/BitcoinAmount.js";
import type { PayoutDestination } from "../../payments/payout-destinations.js";
import {
  addOrTouchSavedNwcConnection,
  type SavedNwcConnection,
} from "../../payments/nwc-connections.js";
import {
  claimPayoutReserveSats,
  claimPayoutSats,
  MATERIAL_RECOVERY_MIN_SATS,
} from "../../payments/lightning-fees.js";
import {
  EXTERNAL_SWAPS_ENABLED,
  getExternalSwapsForContext,
  openExternalSwap,
  type ExternalSwapMatch,
  type ExternalSwapProvider,
} from "../../payments/external-swap-registry.js";
import { humanizeNwcError, resolveNwcConnectionToInvoice } from "../../payments/nwc.js";
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
  /** Saved NWC payout/funding wallets for the picker. */
  savedNwcConnections?: SavedNwcConnection[];
  /** User's selected country/community Chama. Enables local payout rails
   *  such as Chapsmart when the user lives in Tanzania. */
  homeCommunity?: string | null;
  /** Active trade community. Lets local payout handoffs key off the
   *  listing country instead of only the claimant's home Chama. */
  tradeCommunity?: string | null;
  /** Active trade fiat currency. Lets TZS trades expose Chapsmart even
   *  when an older user has no home-community selection yet. */
  fiatCurrency?: string | null;
  /** Bound to actions.claimAndPayout from useEscrow. */
  claimAndPayout: (
    escrowId: string,
    args: {
      bolt11?: string;
      onchainAddress?: string;
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

// v1.2.4: the picker dispatches into Lightning (direct payout), Onchain
// (onchain payout), or an external swap provider drawn from the unified
// `external-swap-registry.ts`. Banxaas / Chapsmart / Bitika / Tando /
// Pilot / Bitzed are no longer special-cased — each is one entry in the
// registry, surfaced as a button in the chooser when the trade context
// matches.
type PayoutMethod =
  | { kind: "lightning" }
  | { kind: "onchain" }
  | { kind: "external"; match: ExternalSwapMatch };

/** Stashed dispatch arguments from the initial picker resolve. Used by
 *  retry paths to re-dispatch with the same destination after a
 *  successful re-probe. */
interface DispatchArgs {
  bolt11?: string;
  onchainAddress?: string;
  saveAfter: boolean;
  addressUsed?: string;
  nwcConnectionString?: string;
  saveNwcAfter?: boolean;
}

export function ClaimPayoutModal({
  escrowId,
  payoutMsats,
  savedDestinations,
  savedNwcConnections = [],
  homeCommunity,
  tradeCommunity,
  fiatCurrency,
  claimAndPayout,
  claimTarget = "lightning",
  probeFederation,
  onClose,
}: ClaimPayoutModalProps) {
  const payoutSats = claimPayoutSats(payoutMsats, claimTarget);
  const reserveSats = claimPayoutReserveSats(payoutMsats, claimTarget);
  const [stage, setStage] = useState<Stage>({ kind: "picking" });
  const [payoutMethod, setPayoutMethod] = useState<PayoutMethod | null>(null);
  // Retry state: when a retryable terminal is up, the "Try again"
  // button toggles this to render the inline probing spinner.
  const [retryProbing, setRetryProbing] = useState(false);
  // Stashed dispatch args. Set when the picker resolves; reused on
  // Try-again so the retry uses the exact same destination/save
  // semantics as the original attempt.
  const lastDispatchRef = useRef<DispatchArgs | null>(null);
  // v1.2.4: all external swap providers resolve through the unified
  // registry. Banxaas / Chapsmart / Bitika / Tando / Pilot / Bitzed
  // each have one or more entries; the picker surfaces every match
  // for the current trade context and the user picks which to use.
  // Hard-gating on post-CLAIM state happens at the dispatching modal's
  // mount boundary (this modal only opens after a CLAIM is in flight),
  // so by the time we render here the user already has authority over
  // the sats and external offramps are safe to offer.
  const externalSwaps = EXTERNAL_SWAPS_ENABLED ? getExternalSwapsForContext({
    homeCommunity,
    tradeCommunity,
    fiatCurrency,
  }) : [];

  // Common dispatch helper — used by both the picker's first resolve
  // and the terminal retry path. Updates stage transitions and
  // schedules auto-close on success.
  const dispatchClaim = async (args: DispatchArgs) => {
    setStage({ kind: "running", phase: { kind: "claiming" } });
    let terminal: ClaimAndPayoutTerminal;
    try {
      terminal = await claimAndPayout(escrowId, {
        bolt11: args.bolt11,
        onchainAddress: args.onchainAddress,
        expectedDeltaMsats: payoutMsats,
        saveAfter: args.saveAfter,
        addressUsed: args.addressUsed,
        onPhase: (phase) => setStage({ kind: "running", phase }),
      });
    } catch (e: any) {
      terminal = {
        kind: "claim-bridge-threw",
        error: e?.message || "Claim could not start. Reconnect your Chama and try again.",
      };
    }
    setStage({ kind: "terminal", terminal });
    if (terminal.kind === "done") {
      if (args.saveNwcAfter && args.nwcConnectionString) {
        try { addOrTouchSavedNwcConnection(args.nwcConnectionString); } catch {}
      }
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

  const resolveDestination = (bolt11: string, opts: {
    saveAfter: boolean;
    addressUsed?: string;
    nwcConnectionString?: string;
    saveNwcAfter?: boolean;
  }) => {
    lastDispatchRef.current = {
      bolt11,
      saveAfter: opts.saveAfter,
      addressUsed: opts.addressUsed,
      nwcConnectionString: opts.nwcConnectionString,
      saveNwcAfter: opts.saveNwcAfter,
    };
    // Fire-and-forget — dispatchClaim manages its own stage
    // transitions and terminal handling.
    void dispatchClaim(lastDispatchRef.current);
  };

  // v1.2.5: claim-side NWC quick-pick. Mirrors the funding modal's
  // saved-NWC top-level button — one tap on a saved wallet, the
  // chooser resolves an invoice via NWC's make_invoice, then dispatches
  // the claim. The spinner appears immediately so the user sees that
  // something is happening during the relay round-trip.
  const dispatchSavedNwcClaim = async (connection: SavedNwcConnection) => {
    setStage({ kind: "running", phase: { kind: "claiming" } });
    let invoice: string;
    try {
      invoice = await resolveNwcConnectionToInvoice(
        connection.connectionString,
        payoutSats,
        { description: "Chama claim payout" },
      );
    } catch (e: any) {
      // NWC wallet refused or couldn't issue the invoice — surface
      // through the standard terminal panel so the user can retry or
      // pick a different destination.
      setStage({
        kind: "terminal",
        terminal: {
          kind: "claim-failed",
          error: e?.message || "NWC wallet couldn't create a destination invoice",
        },
      });
      return;
    }
    // Touch the saved row (bumps lastUsedAt) — same UX as
    // DestinationPicker's saved-NWC branch.
    try { addOrTouchSavedNwcConnection(connection.connectionString); } catch {}
    resolveDestination(invoice, {
      saveAfter: false,
      nwcConnectionString: connection.connectionString,
      saveNwcAfter: false,
    });
  };

  const resolveOnchainAddress = (address: string) => {
    lastDispatchRef.current = {
      onchainAddress: address,
      saveAfter: false,
    };
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

    if (!payoutMethod) {
      return (
        <ClaimMethodChooser
          payoutSats={payoutSats}
          externalSwaps={externalSwaps}
          savedNwcConnections={savedNwcConnections}
          onSelect={setPayoutMethod}
          onSelectSavedNwc={dispatchSavedNwcClaim}
          onCancel={() => onClose(undefined)}
        />
      );
    }

    if (payoutMethod.kind === "external") {
      return (
        <ExternalSwapRedirectPicker
          match={payoutMethod.match}
          payoutSats={payoutSats}
          reserveSats={reserveSats}
          onResolve={(bolt11) => resolveDestination(bolt11, { saveAfter: false })}
          onBack={() => setPayoutMethod(null)}
          onCancel={() => onClose(undefined)}
        />
      );
    }

    if (payoutMethod.kind === "onchain") {
      return (
        <OnchainPayoutPicker
          payoutSats={payoutSats}
          onResolve={resolveOnchainAddress}
          onBack={() => setPayoutMethod(null)}
          onCancel={() => onClose(undefined)}
        />
      );
    }

    // payoutMethod.kind === "lightning"
    return (
      <DestinationPicker
        amountSats={payoutSats}
        savedDestinations={savedDestinations}
        savedNwcConnections={savedNwcConnections}
        title="Claim your sats"
        subtitle={(
          <>
            Send <BitcoinAmount sats={payoutSats} size={11} gap={4} glyphScale={1.18} color={T.muted} glyphColor={T.muted} /> to your Lightning wallet
            {reserveSats > 0 && (
              <>
                . About <BitcoinAmount sats={reserveSats} size={11} gap={4} glyphScale={1.18} color={T.muted} glyphColor={T.muted} /> stays available for Lightning fees.
              </>
            )}
          </>
        )}
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
              <BitcoinAmount sats={payoutSats} size={22} gap={6} glyphScale={1.2} color={T.text} glyphColor={T.muted} />
            </div>
          </div>
          {stage.kind === "terminal" && !retryProbing && (
            <button onClick={() => onClose(stage.terminal)} style={{
              background: "none", border: "none", color: T.muted,
              fontFamily: T.mono, fontSize: 18, cursor: "pointer", padding: 0, lineHeight: 1,
            }}>×</button>
          )}
        </div>

        {stage.kind === "running" && <RunningPanel phase={stage.phase} payoutMethod={payoutMethod} />}

        {stage.kind === "terminal" && (
          <TerminalPanel
            terminal={stage.terminal}
            payoutMethod={payoutMethod}
            retryProbing={retryProbing}
            recoveryCtaWorthwhile={payoutSats >= MATERIAL_RECOVERY_MIN_SATS}
            onRetry={handleClaimRetry}
            onClose={() => onClose(stage.terminal)}
          />
        )}
      </div>
    </div>
  );
}

function ClaimMethodChooser({
  payoutSats,
  externalSwaps,
  savedNwcConnections,
  onSelect,
  onSelectSavedNwc,
  onCancel,
}: {
  payoutSats: number;
  externalSwaps: ExternalSwapMatch[];
  /** v1.2.5: saved NWC connections, promoted to top-level quick-pick
   *  buttons here just like AtomicFundingModal does on the funding
   *  side. A returning user with a saved wallet can claim straight
   *  to it in one tap — no detour through LN → DestinationPicker. */
  savedNwcConnections: SavedNwcConnection[];
  onSelect: (method: PayoutMethod) => void;
  onSelectSavedNwc: (connection: SavedNwcConnection) => void;
  onCancel: () => void;
}) {
  // Single-column layout once external swaps are surfaced (they have
  // taller cards with flag + status badge); two-column when only the
  // built-in Lightning + Onchain methods are available.
  const methodGridColumns = externalSwaps.length > 0 ? "1fr" : "1fr 1fr";
  const methodMinHeight = externalSwaps.length > 0 ? 92 : 118;

  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed", inset: 0, background: "#000c", zIndex: 9998,
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 16, animation: "fadeIn 0.2s ease",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: T.card, border: `1px solid ${T.borderHi}`,
          borderRadius: T.r, padding: 24, maxWidth: 420, width: "100%",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, letterSpacing: 0, marginBottom: 4 }}>
              CLAIM
            </div>
            <div style={{ fontSize: 22, fontWeight: 800, color: T.text, fontFamily: T.mono, letterSpacing: 0 }}>
              <BitcoinAmount sats={payoutSats} size={22} gap={6} glyphScale={1.2} color={T.text} glyphColor={T.muted} />
            </div>
          </div>
          <button onClick={onCancel} style={{
            background: "none", border: "none", color: T.muted,
            fontFamily: T.mono, fontSize: 18, cursor: "pointer", padding: 0, lineHeight: 1,
          }}>×</button>
        </div>
        <div style={{
          fontSize: 11, color: T.muted, fontFamily: T.mono,
          lineHeight: 1.5, marginBottom: 12,
        }}>
          Choose where Chama sends the rebuilt ecash after your claim settles.
        </div>

        {/* v1.2.5: saved NWC connections promoted to top-level quick-
            pick buttons here, matching the AtomicFundingModal pattern
            for funding. A returning user with a saved NWC wallet
            claims straight to it in one tap; the LN button below
            still routes through DestinationPicker for first-time
            paste-an-address flow and Lightning-Address use cases. */}
        {savedNwcConnections.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{
              fontSize: 9, color: T.accent, fontFamily: T.mono,
              letterSpacing: 1, marginBottom: 6, fontWeight: 800,
            }}>
              ⚡ FASTEST · CLAIM STRAIGHT TO SAVED NWC WALLET
            </div>
            <div style={{ display: "grid", gap: 6 }}>
              {savedNwcConnections.map((connection) => (
                <button
                  key={connection.id}
                  onClick={() => onSelectSavedNwc(connection)}
                  style={{
                    width: "100%", padding: "12px 14px", borderRadius: T.r,
                    background: T.accentDim, border: `1px solid ${T.accent}66`,
                    color: T.text, fontFamily: T.mono, fontSize: 12,
                    cursor: "pointer", display: "flex",
                    justifyContent: "space-between", alignItems: "center",
                    gap: 12,
                  }}
                >
                  <span style={{
                    overflow: "hidden", textOverflow: "ellipsis",
                    whiteSpace: "nowrap", fontWeight: 600,
                  }}>
                    {connection.label}
                  </span>
                  <span style={{
                    color: T.accent, flexShrink: 0, fontSize: 9,
                    fontWeight: 800, letterSpacing: 1,
                  }}>
                    CLAIM →
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: methodGridColumns, gap: 10 }}>
          <button
            onClick={() => onSelect({ kind: "lightning" })}
            style={{
              minHeight: methodMinHeight, padding: 12, borderRadius: T.r,
              background: T.accentDim, border: `1px solid ${T.accent}66`,
              color: T.text, cursor: "pointer", textAlign: "left",
            }}
          >
            <div style={{ fontSize: 20, marginBottom: 8 }}>⚡</div>
            <div style={{ fontSize: 12, fontWeight: 800, color: T.accent, fontFamily: T.mono, marginBottom: 6 }}>
              LN · FAST
            </div>
            <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, lineHeight: 1.45 }}>
              Best path. Send to a Lightning address, invoice, or NWC.
            </div>
          </button>
          {externalSwaps.map((match) => {
            const provider = match.provider;
            const isLive = provider.status === "enabled";
            const recommended = provider.recommended === true;
            // Recommended providers (Banxaas today) get a stronger
            // teal pill + "TOP PICK" badge. The rest use a neutral
            // teal border to stay consistent with the chooser's
            // colour vocabulary.
            const accentBg = recommended ? T.tealDim : T.surface;
            const accentBorder = recommended ? `${T.teal}66` : T.border;
            const titleColor = recommended ? T.teal : T.text;
            return (
              <button
                key={`${provider.id}|${provider.communitySlug}`}
                onClick={() => onSelect({ kind: "external", match })}
                style={{
                  minHeight: methodMinHeight, padding: 12, borderRadius: T.r,
                  background: accentBg, border: `1px solid ${accentBorder}`,
                  color: T.text, cursor: "pointer", textAlign: "left",
                }}
              >
                <div style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  gap: 10, marginBottom: 8,
                }}>
                  <span style={{ fontSize: 20 }}>{provider.flagEmoji}</span>
                  <span style={{
                    fontSize: 8, fontFamily: T.mono,
                    color: isLive ? T.teal : T.amber,
                    border: `1px solid ${isLive ? T.teal : T.amber}55`,
                    borderRadius: 4, padding: "2px 6px",
                    textTransform: "uppercase",
                  }}>
                    {recommended ? "top pick" : (isLive ? "live" : "soon")}
                  </span>
                </div>
                <div style={{
                  fontSize: 12, fontWeight: 800, color: titleColor,
                  fontFamily: T.mono, marginBottom: 6,
                  textTransform: "uppercase",
                }}>
                  {provider.displayName} · {provider.currency}
                </div>
                <div style={{
                  fontSize: 10, color: T.muted, fontFamily: T.mono,
                  lineHeight: 1.45,
                }}>
                  {provider.blurb ||
                    `Cash out to ${provider.countryName} ${provider.currency} via a Lightning invoice.`}
                </div>
              </button>
            );
          })}
          <button
            onClick={() => onSelect({ kind: "onchain" })}
            style={{
              minHeight: methodMinHeight, padding: 12, borderRadius: T.r,
              background: T.amberDim, border: `1px solid ${T.amber}66`,
              color: T.text, cursor: "pointer", textAlign: "left",
            }}
          >
            <div style={{ fontSize: 20, marginBottom: 8 }}>₿</div>
            <div style={{ fontSize: 12, fontWeight: 800, color: T.amber, fontFamily: T.mono, marginBottom: 6 }}>
              ONCHAIN · SLOW
            </div>
            <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, lineHeight: 1.45 }}>
              Paste a bitcoin address once. Fees are deducted from payout.
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}

function normalizeBolt11Input(input: string): string {
  const trimmed = input.trim();
  return /^lightning:/i.test(trimmed)
    ? trimmed.slice("lightning:".length).trim()
    : trimmed;
}

function ExternalSwapRedirectPicker({
  match,
  payoutSats,
  reserveSats,
  onResolve,
  onBack,
  onCancel,
}: {
  match: ExternalSwapMatch;
  payoutSats: number;
  reserveSats: number;
  onResolve: (bolt11: string) => void;
  onBack: () => void;
  onCancel: () => void;
}) {
  // Generic guided-redirect picker: open the provider's swap page,
  // let the user create a Lightning invoice on their side, paste it
  // back here, and route it through the normal claim+payout path.
  // Behaviour is identical for every entry in the registry; provider
  // identity only affects the copy and the URL.
  const provider: ExternalSwapProvider = match.provider;
  const availability: { country: { displayName: string; flagEmoji: string }; status: typeof provider.status } = {
    country: { displayName: provider.countryName, flagEmoji: provider.flagEmoji },
    status: provider.status,
  };
  const [invoice, setInvoice] = useState("");
  const normalizedInvoice = normalizeBolt11Input(invoice);
  const looksLikeBolt11 = /^ln(bc|bcrt|tb)[a-z0-9]+$/i.test(normalizedInvoice);
  const isLive = availability.status === "enabled";

  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed", inset: 0, background: "#000c", zIndex: 9998,
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 16, animation: "fadeIn 0.2s ease",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: T.card, border: `1px solid ${T.borderHi}`,
          borderRadius: T.r, padding: 24, maxWidth: 420, width: "100%",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, letterSpacing: 0, marginBottom: 4 }}>
              {provider.displayName.toUpperCase()} CLAIM
            </div>
            <div style={{ fontSize: 22, fontWeight: 800, color: T.text, fontFamily: T.mono, letterSpacing: 0 }}>
              <BitcoinAmount sats={payoutSats} size={22} gap={6} glyphScale={1.2} color={T.text} glyphColor={T.muted} />
            </div>
          </div>
          <button onClick={onCancel} style={{
            background: "none", border: "none", color: T.muted,
            fontFamily: T.mono, fontSize: 18, cursor: "pointer", padding: 0, lineHeight: 1,
          }}>×</button>
        </div>

        <div style={{
          padding: "12px", borderRadius: T.r,
          background: T.tealDim, border: `1px solid ${T.teal}44`,
          color: T.text, marginBottom: 12,
        }}>
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            gap: 10, marginBottom: 8,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <span style={{ fontSize: 20 }}>{availability.country.flagEmoji}</span>
              <span style={{
                color: T.teal, fontFamily: T.mono, fontSize: 11,
                fontWeight: 900, overflow: "hidden", textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}>
                {availability.country.displayName}
              </span>
            </div>
            <span style={{
              flexShrink: 0, color: isLive ? T.green : T.amber,
              background: isLive ? T.greenDim : T.amberDim,
              border: `1px solid ${isLive ? T.green : T.amber}55`,
              borderRadius: 4, padding: "2px 6px",
              fontFamily: T.mono, fontSize: 8, fontWeight: 900,
              textTransform: "uppercase",
            }}>
              {isLive ? "live now" : "coming soon"}
            </span>
          </div>
          <div style={{
            color: T.muted, fontFamily: T.mono, fontSize: 10,
            lineHeight: 1.5,
          }}>
            {isLive
              ? (
                  <>
                    Open {provider.displayName}, choose Lightning &rarr; {provider.currency} {provider.bidirectional ? "(or the other direction)" : "mobile money"},
                    make an invoice up to <BitcoinAmount sats={payoutSats} size={10} gap={3} glyphScale={1.18} color={T.muted} glyphColor={T.muted} />,
                    then paste it below.
                    {reserveSats > 0 && (
                      <>
                        {" "}About <BitcoinAmount sats={reserveSats} size={10} gap={3} glyphScale={1.18} color={T.muted} glyphColor={T.muted} /> stays available for Lightning fees.
                      </>
                    )}
                  </>
                )
              : (
                  <>
                    {provider.displayName} lists this country as coming soon.
                    Use Lightning or onchain for this claim today.
                  </>
                )}
          </div>
        </div>

        <button
          onClick={() => openExternalSwap(provider)}
          style={{
            width: "100%", padding: "12px 16px", borderRadius: T.rs,
            background: T.teal, border: `1px solid ${T.teal}`,
            color: T.bg, fontFamily: T.mono, fontSize: 12,
            fontWeight: 900, cursor: "pointer", marginBottom: 10,
          }}
        >
          {isLive ? `Open ${provider.displayName} swap` : `Check ${provider.displayName}`}
        </button>

        {isLive && (
          <>
            <textarea
              value={invoice}
              onChange={(e) => setInvoice(e.target.value)}
              placeholder="lnbc..."
              rows={3}
              style={{
                width: "100%", boxSizing: "border-box", resize: "vertical",
                minHeight: 74, padding: "10px 12px", borderRadius: T.rs,
                background: T.bg, border: `1px solid ${T.border}`,
                color: T.text, fontFamily: T.mono, fontSize: 12,
                outline: "none", marginBottom: 10,
              }}
            />
            <button
              onClick={() => onResolve(normalizedInvoice)}
              disabled={!looksLikeBolt11}
              style={{
                width: "100%", padding: "12px 16px", borderRadius: T.rs,
                background: looksLikeBolt11 ? T.teal : T.surface,
                border: `1px solid ${looksLikeBolt11 ? T.teal : T.border}`,
                color: looksLikeBolt11 ? T.bg : T.muted,
                fontFamily: T.mono, fontSize: 12, fontWeight: 900,
                cursor: looksLikeBolt11 ? "pointer" : "default",
                marginBottom: 8,
              }}
            >
              Claim via {provider.displayName} invoice
            </button>
          </>
        )}

        <button
          onClick={onBack}
          style={{
            width: "100%", padding: "10px 16px", borderRadius: T.rs,
            background: T.surface, border: `1px solid ${T.border}`,
            color: T.muted, fontFamily: T.mono, fontSize: 11,
            fontWeight: 700, cursor: "pointer",
          }}
        >
          Back
        </button>
      </div>
    </div>
  );
}

function OnchainPayoutPicker({
  payoutSats,
  onResolve,
  onBack,
  onCancel,
}: {
  payoutSats: number;
  onResolve: (address: string) => void;
  onBack: () => void;
  onCancel: () => void;
}) {
  const [address, setAddress] = useState("");
  const trimmed = address.trim();
  const looksLikeBitcoinAddress = /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{20,}$/i.test(trimmed);

  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed", inset: 0, background: "#000c", zIndex: 9998,
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 16, animation: "fadeIn 0.2s ease",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: T.card, border: `1px solid ${T.borderHi}`,
          borderRadius: T.r, padding: 24, maxWidth: 420, width: "100%",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, letterSpacing: 0, marginBottom: 4 }}>
              ONCHAIN CLAIM
            </div>
            <div style={{ fontSize: 22, fontWeight: 800, color: T.text, fontFamily: T.mono, letterSpacing: 0 }}>
              <BitcoinAmount sats={payoutSats} size={22} gap={6} glyphScale={1.2} color={T.text} glyphColor={T.muted} />
            </div>
          </div>
          <button onClick={onCancel} style={{
            background: "none", border: "none", color: T.muted,
            fontFamily: T.mono, fontSize: 18, cursor: "pointer", padding: 0, lineHeight: 1,
          }}>×</button>
        </div>
        <div style={{
          padding: "10px 12px", borderRadius: T.rs,
          background: T.amberDim, border: `1px solid ${T.amber}44`,
          color: T.amber, fontFamily: T.mono, fontSize: 10,
          lineHeight: 1.5, marginBottom: 12,
        }}>
          Slow path. Paste a fresh bitcoin address. Chama uses it only for
          this transaction and does not save it. Network and peg-out fees
          come out of the claimed amount.
        </div>
        <textarea
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="bc1..."
          rows={3}
          style={{
            width: "100%", boxSizing: "border-box", resize: "vertical",
            minHeight: 74, padding: "10px 12px", borderRadius: T.rs,
            background: T.bg, border: `1px solid ${T.border}`,
            color: T.text, fontFamily: T.mono, fontSize: 12,
            outline: "none", marginBottom: 10,
          }}
        />
        <button
          onClick={() => onResolve(trimmed)}
          disabled={!looksLikeBitcoinAddress}
          style={{
            width: "100%", padding: "12px 16px", borderRadius: T.rs,
            background: looksLikeBitcoinAddress ? T.amber : T.surface,
            border: `1px solid ${looksLikeBitcoinAddress ? T.amber : T.border}`,
            color: looksLikeBitcoinAddress ? T.bg : T.muted,
            fontFamily: T.mono, fontSize: 12, fontWeight: 800,
            cursor: looksLikeBitcoinAddress ? "pointer" : "default",
            marginBottom: 8,
          }}
        >
          Claim onchain
        </button>
        <button
          onClick={onBack}
          style={{
            width: "100%", padding: "10px 16px", borderRadius: T.rs,
            background: T.surface, border: `1px solid ${T.border}`,
            color: T.muted, fontFamily: T.mono, fontSize: 11, fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Back
        </button>
      </div>
    </div>
  );
}

// v1.2.4: the inline ChapsmartPayoutOption (phone + name form that
// POSTed to the now-dead nwc.chapsmart.com endpoint) was deleted.
// Chapsmart now lives in external-swap-registry.ts as a guided
// redirect alongside Banxaas / Bitika / Tando / Minmo / Bitzed, and
// surfaces through the shared ExternalSwapRedirectPicker. The
// per-user profile helpers (phone + name) remain in
// chapsmart-payout.ts for any future on-Chapsmart pre-fill but no
// longer hit the network from Chama itself.

// ── Sub-panels ──────────────────────────────────────────────────────────

function RunningPanel({
  phase,
  payoutMethod,
}: {
  phase: ClaimAndPayoutPhase;
  payoutMethod: PayoutMethod | null;
}) {
  const message =
    phase.kind === "claiming" ? "Recovering your share…" :
    phase.kind === "confirming" ? "Confirming with the federation…" :
    phase.kind === "paying-onchain" ? "Broadcasting onchain payout…" :
    phase.kind === "paying-invoice" && payoutMethod?.kind === "external"
      ? `Sending to ${payoutMethod.match.provider.displayName}…`
      : phase.kind === "paying-invoice" ? "Sending to your wallet…" :
    "Working…";
  const tone =
    phase.kind === "paying-onchain" ? T.amber :
    phase.kind === "paying-invoice" ? T.amber :
    phase.kind === "confirming" ? T.amber :
    T.purple;
  const toneDim =
    phase.kind === "paying-onchain" ? T.amberDim :
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
  terminal, payoutMethod, retryProbing, recoveryCtaWorthwhile, onRetry, onClose,
}: {
  terminal: ClaimAndPayoutTerminal;
  payoutMethod: PayoutMethod | null;
  retryProbing: boolean;
  /** v2.1.1: whether Me's Recover surface will actually show this amount
   *  (it stays quiet below the material line). Gates the "Show recovery
   *  now" CTA so sub-material payout failures aren't pointed at a
   *  surface that will ignore them. */
  recoveryCtaWorthwhile: boolean;
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
          {payoutMethod?.kind === "external"
            ? `Sent to ${payoutMethod.match.provider.displayName}`
            : "Sent to your wallet"}
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
  // v2.1.1: a payout failure on the COVER settlement path leaves the
  // trade un-COMPLETEd on purpose — the Claim button is still alive and
  // retries with a fresh invoice. That's a strictly better retry path
  // than the recovery surface (which also ignores sub-material amounts),
  // so only point at recovery when it will actually engage.
  const claimStillOpen =
    terminal.kind === "payout-failed" && terminal.claimCompleted === false;
  const showRecoveryCta =
    terminal.kind === "payout-failed" && !claimStillOpen && recoveryCtaWorthwhile;

  // v1.2.5: translate NWC / BOLT error codes into human copy here too
  // (in addition to the App-level toast wrapper) so the in-modal
  // terminal panel reads cleanly even on the brief beat before the
  // modal closes and the toast takes over.
  const humanizedError = humanizeNwcError(terminal.error);

  if (terminal.kind === "claim-failed") {
    const settlementFailed = /reissue|consumed|settle/i.test(terminal.error);
    title = settlementFailed ? "Claim did not settle" : "Couldn't recover your share";
    subtitle = humanizedError;
    tone = T.red;
    toneDim = T.redDim;
    icon = "✕";
  } else if (terminal.kind === "claim-bridge-threw") {
    // v0.3.1 Phase 1: retry-able structural failure (FED_PROBE_FAILED
    // / FED_MISMATCH). Surface the actual underlying error and offer
    // Try again. No sats moved — safe to retry.
    title = "Couldn't reach your Chama";
    subtitle = humanizedError;
    tone = T.amber;
    toneDim = T.amberDim;
    icon = "⚠";
    showRetry = true;
  } else if (terminal.kind === "claim-pending") {
    title = "Your sats are still arriving";
    subtitle = humanizedError;
    tone = T.amber;
    toneDim = T.amberDim;
    icon = "⏳";
    showRetry = true;
  } else {
    // payout-failed
    title = "Payout couldn't be sent";
    subtitle = claimStillOpen
      ? `${humanizedError}\n\nYour sats are safe in your Chama. Close this and tap Claim again — the payout retries with a fresh invoice.`
      : showRecoveryCta
        ? `${humanizedError}\n\nYour sats are safe in your Chama. Tap Show recovery now to retry the payout only.`
        : `${humanizedError}\n\nYour sats are safe in your Chama.`;
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
          background: showRecoveryCta ? T.amber : T.surface,
          border: `1px solid ${showRecoveryCta ? T.amber : T.border}`,
          color: showRecoveryCta ? "#000" : T.muted,
          fontFamily: T.mono, fontSize: 11, fontWeight: 800,
          cursor: retryProbing ? "not-allowed" : "pointer",
          boxShadow: showRecoveryCta ? `0 0 24px ${T.amber}33` : "none",
        }}
      >
        {showRecoveryCta ? "Show recovery now" : "Close"}
      </button>
    </div>
  );
}
