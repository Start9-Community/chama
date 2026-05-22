import { useState, useEffect } from "react";
import { type FedimintState } from "../../hooks/useEscrow.js";
import { T } from "../theme.js";
import { isPowerUserModeOn, setPowerUserMode } from "../powerUserMode.js";
import { SwitchFederationPanel } from "../panels/SwitchFederationPanel.js";
import { isSimModeOn } from "../../sim/simMode.js";
import {
  lightningPayoutReserveSats,
  maxLightningPayoutSats,
} from "../../payments/lightning-fees.js";

// Settings → Advanced — the home of Power-user mode (formerly
// "Sandbox mode" through v0.4.1) and the federation-switching tools
// that previously lived on the home screen. Per the v0.2.0 brief,
// these surfaces are too dangerous for normie users to encounter
// incidentally. v0.1.85 relocates them here.
//
// First-time onboarding happens via community pill taps in BrowseView
// (one-tap join). Power-user mode is the only on-shell home for picking
// a non-community-mapped federation or pasting a custom invite — and the
// shell's onSwitchFederation handler dispatches init-vs-switch so this
// works for both first-time-join and federation-switch flows.
export function SettingsAdvanced({
  fedimint,
  onBack,
  onSwitchFederation,
  onResetLocalWallet,
  onSandboxFund,
}: {
  fedimint: FedimintState;
  onBack: () => void;
  onSwitchFederation: (inviteCode: string, opts?: { force?: boolean }) => Promise<void>;
  onResetLocalWallet: () => Promise<void>;
  /** v0.3.0 Phase 5: opens FundWalletModal — the only remaining
   *  callsite of that surface in production. Reachable only when
   *  Power-user mode is on. The label on the button below carries the
   *  warning in plain English; do not surface this from any other
   *  production path. */
  onSandboxFund?: () => void;
}) {
  const [powerUserOn, setPowerUserOn] = useState(isPowerUserModeOn);
  // Toggle the flag — dev builds remain auto-on regardless
  useEffect(() => { setPowerUserMode(powerUserOn); }, [powerUserOn]);

  const isDev = (() => {
    try { return !!(import.meta as any).env?.DEV; } catch { return false; }
  })();

  // v0.4.2: sim mode is the only way for prod testers to fund a fresh
  // wallet (atomic funding is buyer-side and assumes a counterparty).
  // Expose the manual-fund affordance whenever sim mode is on, even if
  // the user hasn't separately enabled power-user mode. The federation
  // switcher and OPFS reset stay behind power-user — those are
  // dangerous in real life and pointless in sim.
  const simOn = isSimModeOn();
  const balanceMsats = Math.max(0, Math.floor(fedimint.balanceMsats ?? 0));
  const wholeSats = Math.floor(balanceMsats / 1000);
  const recoverableSats = maxLightningPayoutSats(balanceMsats);
  const reserveSats = lightningPayoutReserveSats(balanceMsats);
  const routeLabel = fedimint.federationName || (fedimint.joined ? "Joined route" : "No Chama");

  return (
    <div style={{ padding: 16, maxWidth: 560, margin: "0 auto" }}>
      <div style={{
        display: "flex", justifyContent: "space-between",
        alignItems: "center", marginBottom: 20,
      }}>
        <button onClick={onBack} style={{
          background: "none", border: "none", color: T.muted,
          fontFamily: T.mono, fontSize: 12, cursor: "pointer", padding: 0,
        }}>
          ← Back
        </button>
        <span style={{ fontSize: 18, fontWeight: 700, color: T.text, fontFamily: T.sans }}>
          Advanced
        </span>
        <span style={{ width: 50 }} />
      </div>

      <div style={{
        background: T.card, border: `1px solid ${T.border}`,
        borderRadius: T.r, padding: 16, marginBottom: 16,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono,
          letterSpacing: 1, marginBottom: 10,
        }}>
          LOCAL WALLET BALANCE
        </div>
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          gap: 8,
          marginBottom: 12,
        }}>
          <BalanceMetric label="Raw" value={balanceMsats.toLocaleString()} suffix="msats" />
          <BalanceMetric label="Whole" value={wholeSats.toLocaleString()} suffix="sats" />
          <BalanceMetric label="Recoverable" value={recoverableSats.toLocaleString()} suffix="sats" tone={recoverableSats > 0 ? T.amber : T.muted} />
        </div>
        <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, lineHeight: 1.6 }}>
          Route: <span style={{ color: T.text }}>{routeLabel}</span>
          {" · "}
          Status: <span style={{ color: fedimint.joined ? T.green : fedimint.busy ? T.amber : T.muted }}>
            {fedimint.joined ? "joined" : fedimint.busy ? "connecting" : "not joined"}
          </span>
          {" · "}
          Lightning reserve: <span style={{ color: reserveSats > 0 ? T.amber : T.muted }}>
            {reserveSats.toLocaleString()} sats
          </span>
        </div>
        {fedimint.federationId && (
          <div style={{
            fontSize: 9, color: T.muted, fontFamily: T.mono,
            marginTop: 8, wordBreak: "break-all",
          }}>
            fed {fedimint.federationId}
          </div>
        )}
      </div>

      {/* Power-user toggle */}
      <div style={{
        background: T.card, border: `1px solid ${T.border}`,
        borderRadius: T.r, padding: 16, marginBottom: 16,
      }}>
        <div
          onClick={() => !isDev && setPowerUserOn(!powerUserOn)}
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            cursor: isDev ? "default" : "pointer",
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: T.text, fontFamily: T.sans }}>
              Power-user mode
            </div>
            <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginTop: 4, lineHeight: 1.5 }}>
              Reveals power-user surfaces: route switching, external invite
              paste, OPFS reset. Off by default.
              {isDev && (
                <span style={{ color: T.amber, display: "block", marginTop: 4 }}>
                  Auto-on in dev builds.
                </span>
              )}
            </div>
          </div>
          <div style={{
            width: 40, height: 22, borderRadius: 11,
            background: (powerUserOn || isDev) ? T.accent : T.border,
            padding: 2, transition: "background 0.2s",
            opacity: isDev ? 0.7 : 1,
          }}>
            <div style={{
              width: 18, height: 18, borderRadius: "50%",
              background: T.bg, transition: "transform 0.2s",
              transform: (powerUserOn || isDev) ? "translateX(18px)" : "translateX(0)",
            }} />
          </div>
        </div>
      </div>

      {(powerUserOn || isDev) && (
        <>
          {/* Route switching */}
          <div style={{
            background: T.card, border: `1px solid ${T.border}`,
            borderRadius: T.r, padding: 16, marginBottom: 16,
          }}>
            <div style={{
              fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono,
              letterSpacing: 1, marginBottom: 8,
            }}>
              ROUTE
            </div>
            {/* SwitchFederationPanel renders for both joined and pre-join
                states — the shell's onSwitchFederation handler dispatches
                init-vs-switch based on whether a fed is loaded. v0.1.85:
                this is the only first-time-join surface for power users
                (the on-shell picker has been retired). */}
            <SwitchFederationPanel
              fedimint={fedimint}
              onSwitch={onSwitchFederation}
            />
          </div>

          {/* Reset local Chama */}
          <div style={{
            background: T.card, border: `1px solid ${T.border}`,
            borderRadius: T.r, padding: 16, marginBottom: 16,
          }}>
            <div style={{
              fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono,
              letterSpacing: 1, marginBottom: 8,
            }}>
              RESET LOCAL CHAMA
            </div>
            <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, lineHeight: 1.5, marginBottom: 12 }}>
              Wipes the OPFS-bound Fedimint client. Your Nostr-backed seed and
              trade history survive. The v0.1.76 fund-loss guard refuses if a
              balance is present — withdraw via Lightning first.
            </div>
            <button
              onClick={() => onResetLocalWallet().catch((e: any) => alert(e?.message || "Reset failed"))}
              style={{
                background: "none",
                border: `1px solid ${T.border}`,
                color: T.muted,
                fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                padding: "8px 12px", borderRadius: T.rs,
                cursor: "pointer", letterSpacing: 0.5,
              }}
            >
              ↺ Reset local Chama
            </button>
          </div>
        </>
      )}

      {/* v0.3.0 Phase 5 / v0.4.2 sim mode: Manual fund — the only
          remaining entry point to FundWalletModal in production. Gated
          behind Power-user mode OR Sim mode. The label IS the warning
          (per Phase 5 reminder #2): users see "Production trades use
          atomic funding via listing-tap" and understand at a glance
          that this is a testing surface, not the normal funding path.
          In sim mode this is the natural starter step: fund the sim
          wallet from 0, then trade. */}
      {onSandboxFund && (powerUserOn || isDev || simOn) && (
        <div style={{
          background: T.card, border: `1px solid ${simOn ? T.red : T.border}`,
          borderRadius: T.r, padding: 16, marginBottom: 16,
        }}>
          <div style={{
            fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono,
            letterSpacing: 1, marginBottom: 8,
          }}>
            {simOn ? "FUND SIM WALLET" : "MANUAL FUND (POWER USER)"}
          </div>
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, lineHeight: 1.5, marginBottom: 12 }}>
            {simOn
              ? "Generate a sim Lightning invoice. It auto-settles after a few seconds — no real wallet needed."
              : "Generate an arbitrary-amount Lightning invoice for testing. Production trades use atomic funding via listing-tap."}
          </div>
          <button
            onClick={onSandboxFund}
            style={{
              background: "none",
              border: `1px solid ${T.border}`,
              color: T.muted,
              fontFamily: T.mono, fontSize: 11, fontWeight: 700,
              padding: "8px 12px", borderRadius: T.rs,
              cursor: "pointer", letterSpacing: 0.5,
            }}
          >
            ⚡ Open manual fund
          </button>
        </div>
      )}

      {!(powerUserOn || isDev) && (
        <div style={{
          padding: 24, textAlign: "center",
          background: T.surface, border: `1px dashed ${T.border}`,
          borderRadius: T.r, color: T.muted, fontFamily: T.mono, fontSize: 11, lineHeight: 1.7,
        }}>
          Power-user surfaces are hidden in production. Flip Power-user
          mode above to reveal them.
        </div>
      )}
    </div>
  );
}

function BalanceMetric({
  label,
  value,
  suffix,
  tone = T.text,
}: {
  label: string;
  value: string;
  suffix: string;
  tone?: string;
}) {
  return (
    <div style={{
      background: T.surface,
      border: `1px solid ${T.border}`,
      borderRadius: T.rs,
      padding: "10px 8px",
      minWidth: 0,
    }}>
      <div style={{
        fontSize: 9,
        color: T.muted,
        fontFamily: T.mono,
        textTransform: "uppercase",
        letterSpacing: 0.8,
        marginBottom: 5,
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 13,
        color: tone,
        fontFamily: T.mono,
        fontWeight: 800,
        lineHeight: 1.2,
        wordBreak: "break-word",
      }}>
        {value}
      </div>
      <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, marginTop: 3 }}>
        {suffix}
      </div>
    </div>
  );
}
