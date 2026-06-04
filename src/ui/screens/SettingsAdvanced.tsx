import { useState, useEffect, useRef, type ReactNode } from "react";
import { type FedimintState } from "../../hooks/useEscrow.js";
import { T, inputStyle } from "../theme.js";
import { BitcoinAmount } from "../components/BitcoinAmount.js";
import { isPowerUserModeOn, setPowerUserMode } from "../powerUserMode.js";
import { SwitchFederationPanel } from "../panels/SwitchFederationPanel.js";
import { isSimModeOn } from "../../sim/simMode.js";
import { isNwcConnectionString } from "../../payments/nwc.js";
import {
  addOrTouchSavedNwcConnection,
  deleteSavedNwcConnection,
  listSavedNwcConnections,
  type SavedNwcConnection,
} from "../../payments/nwc-connections.js";
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
  focusNwc = false,
}: {
  fedimint: FedimintState;
  onBack: () => void;
  onSwitchFederation: (inviteCode: string, opts?: { force?: boolean }) => Promise<void>;
  onResetLocalWallet: () => Promise<void>;
  /** When true (arrived via the "Change" link on the trade-page NWC banner),
   *  open expanded on the NWC wallets section and scroll it into view. */
  focusNwc?: boolean;
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
  const [nwcManagerOpen, setNwcManagerOpen] = useState(focusNwc);
  const [savedNwcConnections, setSavedNwcConnections] = useState<SavedNwcConnection[]>(
    () => listSavedNwcConnections(),
  );
  const [nwcInput, setNwcInput] = useState("");
  const [nwcError, setNwcError] = useState<string | null>(null);
  const nwcInputReady = isNwcConnectionString(nwcInput);

  // Arrived from the trade-page NWC "Change" link → land on the NWC wallets
  // section: expand it and scroll it into view once layout settles.
  const nwcSectionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusNwc) return;
    setNwcManagerOpen(true);
    const t = setTimeout(() => {
      nwcSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 60);
    return () => clearTimeout(t);
  }, [focusNwc]);

  const refreshNwcConnections = () => setSavedNwcConnections(listSavedNwcConnections());
  const handleSaveNwc = () => {
    setNwcError(null);
    try {
      addOrTouchSavedNwcConnection(nwcInput);
      setNwcInput("");
      refreshNwcConnections();
    } catch (e: any) {
      setNwcError(e?.message || "NWC connection could not be saved");
    }
  };
  const handleDeleteNwc = (id: string) => {
    deleteSavedNwcConnection(id);
    refreshNwcConnections();
  };

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
          <BalanceMetric label="Whole" value={<BitcoinAmount sats={wholeSats} size={13} gap={3} glyphScale={1.18} color={T.text} glyphColor={T.muted} />} />
          <BalanceMetric label="Recoverable" value={<BitcoinAmount sats={recoverableSats} size={13} gap={3} glyphScale={1.18} color={recoverableSats > 0 ? T.amber : T.muted} glyphColor={recoverableSats > 0 ? T.amber : T.muted} />} tone={recoverableSats > 0 ? T.amber : T.muted} />
        </div>
        <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, lineHeight: 1.6 }}>
          Route: <span style={{ color: T.text }}>{routeLabel}</span>
          {" · "}
          Status: <span style={{ color: fedimint.joined ? T.green : fedimint.busy ? T.amber : T.muted }}>
            {fedimint.joined ? "joined" : fedimint.busy ? "connecting" : "not joined"}
          </span>
          {" · "}
          Lightning reserve: <span style={{ color: reserveSats > 0 ? T.amber : T.muted }}>
            <BitcoinAmount sats={reserveSats} size={10} gap={3} glyphScale={1.18} color={reserveSats > 0 ? T.amber : T.muted} glyphColor={reserveSats > 0 ? T.amber : T.muted} />
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

      <div ref={nwcSectionRef} style={{
        background: T.card, border: `1px solid ${T.border}`,
        borderRadius: T.r, padding: 16, marginBottom: 16,
      }}>
        <div
          onClick={() => setNwcManagerOpen(!nwcManagerOpen)}
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            cursor: "pointer", gap: 12,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: T.text, fontFamily: T.sans }}>
              NWC wallets
            </div>
            <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginTop: 4, lineHeight: 1.5 }}>
              Advanced wallet links for fast payouts and auto-funding.
            </div>
          </div>
          <div style={{
            color: T.muted, fontFamily: T.mono, fontSize: 12,
            transform: nwcManagerOpen ? "rotate(90deg)" : "rotate(0)",
            transition: "transform 0.16s ease",
          }}>
            ▸
          </div>
        </div>

        {nwcManagerOpen && (
          <NwcManager
            saved={savedNwcConnections}
            input={nwcInput}
            error={nwcError}
            inputReady={nwcInputReady}
            onInput={setNwcInput}
            onSave={handleSaveNwc}
            onDelete={handleDeleteNwc}
          />
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

      {/* Arbiter-substitution live testing: per-device override of the CREATE
          expiry. Consensus-safe — the value is committed wire data in the
          CREATE event, so every client derives the same expiry and the same
          backup-arbiter floor (min(4h, half remaining life)). Only the
          CREATING device needs it set. Power-user gated like manual fund. */}
      {(powerUserOn || isDev || simOn) && (
        <TestExpiryOverrideCard />
      )}

      {!(powerUserOn || isDev) && (
        <div style={{
          padding: 24, textAlign: "center" as const,
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
  value: ReactNode;
  suffix?: string;
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
      {suffix && (
        <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, marginTop: 3 }}>
          {suffix}
        </div>
      )}
    </div>
  );
}

function NwcManager({
  saved,
  input,
  error,
  inputReady,
  onInput,
  onSave,
  onDelete,
}: {
  saved: SavedNwcConnection[];
  input: string;
  error: string | null;
  inputReady: boolean;
  onInput: (value: string) => void;
  onSave: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div style={{
      marginTop: 14,
      paddingTop: 14,
      borderTop: `1px solid ${T.border}`,
    }}>
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
        gap: 8,
        marginBottom: 12,
      }}>
        <NwcPermissionCard
          title="Payouts"
          value="Create invoices"
          hint="Needed for Claim and Recover to send sats to this wallet."
        />
        <NwcPermissionCard
          title="Auto-fund"
          value="Send payments"
          hint="Needed only when you want Chama to lock trades from this wallet."
        />
      </div>

      <div style={{
        padding: "10px 12px",
        background: T.surface,
        border: `1px solid ${T.border}`,
        borderRadius: T.rs,
        marginBottom: 12,
      }}>
        <div style={{
          fontSize: 10,
          color: T.text,
          fontFamily: T.mono,
          fontWeight: 800,
          letterSpacing: 0.4,
          marginBottom: 6,
        }}>
          SETUP
        </div>
        <ol style={{
          margin: 0,
          paddingLeft: 18,
          color: T.muted,
          fontFamily: T.mono,
          fontSize: 10,
          lineHeight: 1.65,
        }}>
          <li>Name it Chama.</li>
          <li>Use Custom permissions.</li>
          <li>Enable Create invoices.</li>
          <li>Enable Send payments for auto-funding.</li>
          <li>Set a budget at least as large as your expected trades.</li>
          <li>Use an expiration you are comfortable revoking later.</li>
        </ol>
      </div>

      {saved.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{
            fontSize: 9,
            color: T.muted,
            fontFamily: T.mono,
            letterSpacing: 1,
            marginBottom: 6,
          }}>
            SAVED
          </div>
          {saved.map((connection) => (
            <div
              key={connection.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                padding: "10px 12px",
                background: T.surface,
                border: `1px solid ${T.border}`,
                borderRadius: T.rs,
                marginBottom: 6,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{
                  color: T.text,
                  fontFamily: T.mono,
                  fontSize: 11,
                  fontWeight: 800,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}>
                  {connection.label}
                </div>
                <div style={{
                  color: T.muted,
                  fontFamily: T.mono,
                  fontSize: 9,
                  marginTop: 3,
                }}>
                  {connection.relayCount} relay{connection.relayCount === 1 ? "" : "s"} · {connection.walletPubkey.slice(0, 8)}
                </div>
              </div>
              <button
                onClick={() => onDelete(connection.id)}
                style={{
                  background: "none",
                  border: "none",
                  color: T.red,
                  fontFamily: T.mono,
                  fontSize: 10,
                  cursor: "pointer",
                  padding: "4px 0",
                  flexShrink: 0,
                }}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{
        fontSize: 9,
        color: T.muted,
        fontFamily: T.mono,
        letterSpacing: 1,
        marginBottom: 6,
      }}>
        PASTE CONNECTION
      </div>
      <textarea
        value={input}
        onChange={(e) => onInput(e.target.value)}
        placeholder="nostr+walletconnect://..."
        rows={3}
        style={{ ...inputStyle, resize: "vertical" as const, minHeight: 62, marginBottom: 8 }}
      />
      {error && (
        <div style={{
          padding: "8px 10px",
          background: T.redDim,
          border: `1px solid ${T.red}44`,
          color: T.red,
          borderRadius: T.rs,
          fontFamily: T.mono,
          fontSize: 10,
          marginBottom: 8,
        }}>
          {error}
        </div>
      )}
      <button
        onClick={onSave}
        disabled={!inputReady}
        style={{
          width: "100%",
          padding: "11px 12px",
          borderRadius: T.rs,
          background: inputReady ? T.accent : T.surface,
          border: `1px solid ${inputReady ? T.accent : T.border}`,
          color: inputReady ? "#000" : T.muted,
          fontFamily: T.mono,
          fontSize: 11,
          fontWeight: 800,
          cursor: inputReady ? "pointer" : "not-allowed",
        }}
      >
        Save NWC wallet
      </button>
    </div>
  );
}

function NwcPermissionCard({
  title,
  value,
  hint,
}: {
  title: string;
  value: string;
  hint: string;
}) {
  return (
    <div style={{
      background: T.surface,
      border: `1px solid ${T.border}`,
      borderRadius: T.rs,
      padding: 10,
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
        {title}
      </div>
      <div style={{
        fontSize: 12,
        color: T.accent,
        fontFamily: T.mono,
        fontWeight: 900,
        lineHeight: 1.25,
        marginBottom: 5,
      }}>
        {value}
      </div>
      <div style={{
        color: T.muted,
        fontFamily: T.mono,
        fontSize: 9,
        lineHeight: 1.45,
      }}>
        {hint}
      </div>
    </div>
  );
}

// ── Arbiter-substitution test lever ──────────────────────────────────────
// Writes chama_create_expiry_seconds, which createEscrow reads as the CREATE
// expiry override. Consensus-safe: the value is committed into the CREATE
// event itself, so all clients derive the same expiry + the same backup-
// arbiter floor. Only the creating device needs it. Power-user gated.
const CREATE_EXPIRY_OVERRIDE_KEY = "chama_create_expiry_seconds";

function readExpiryOverrideRaw(): string {
  try {
    return typeof localStorage === "undefined"
      ? ""
      : localStorage.getItem(CREATE_EXPIRY_OVERRIDE_KEY) ?? "";
  } catch {
    return "";
  }
}

function TestExpiryOverrideCard() {
  const [value, setValue] = useState<string>(() => readExpiryOverrideRaw());
  const active = readExpiryOverrideRaw() !== "";
  const parsed = Number(value);
  const valid = Number.isFinite(parsed) && parsed >= 300 && parsed <= 30 * 86400;

  const save = () => {
    try {
      if (!valid) return;
      localStorage.setItem(CREATE_EXPIRY_OVERRIDE_KEY, String(Math.floor(parsed)));
      setValue(String(Math.floor(parsed)));
    } catch { /* storage unavailable — no-op */ }
  };
  const clear = () => {
    try {
      localStorage.removeItem(CREATE_EXPIRY_OVERRIDE_KEY);
      setValue("");
    } catch { /* no-op */ }
  };

  return (
    <div style={{
      background: T.card, border: `1px solid ${active ? T.amber : T.border}`,
      borderRadius: T.r, padding: 16, marginBottom: 16,
    }}>
      <div style={{
        fontSize: 11, fontWeight: 600, color: active ? T.amber : T.muted,
        fontFamily: T.mono, letterSpacing: 1, marginBottom: 8,
      }}>
        TEST TRADE EXPIRY {active ? "· ACTIVE" : "(POWER USER)"}
      </div>
      <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, lineHeight: 1.5, marginBottom: 12 }}>
        Overrides the expiry baked into trades CREATED on this device (seconds,
        5 min – 30 days). A 1800s trade opens the backup-arbiter floor after
        ~15 min — every device follows the trade, only the creator needs this.
        Clear it after testing or you will list 30-minute trades for real.
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="e.g. 1800"
          inputMode="numeric"
          style={{ ...inputStyle, flex: 1, fontFamily: T.mono, fontSize: 12 }}
        />
        <button
          onClick={save}
          disabled={!valid}
          style={{
            background: valid ? T.amberDim : "none",
            border: `1px solid ${valid ? T.amber + "66" : T.border}`,
            color: valid ? T.amber : T.muted,
            fontFamily: T.mono, fontSize: 11, fontWeight: 700,
            padding: "8px 12px", borderRadius: T.rs,
            cursor: valid ? "pointer" : "default",
          }}
        >
          Set
        </button>
        <button
          onClick={clear}
          style={{
            background: "none", border: `1px solid ${T.border}`, color: T.muted,
            fontFamily: T.mono, fontSize: 11, fontWeight: 700,
            padding: "8px 12px", borderRadius: T.rs, cursor: "pointer",
          }}
        >
          Clear
        </button>
      </div>
    </div>
  );
}
