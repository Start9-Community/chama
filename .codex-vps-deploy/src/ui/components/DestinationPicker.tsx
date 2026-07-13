// ══════════════════════════════════════════════════════════════════════════
// Chama — DestinationPicker (v0.3.0 send-side affordance)
// ══════════════════════════════════════════════════════════════════════════
//
// The canonical "user provides a destination to receive sats" surface,
// reused by the claim flow, recovery banner, and destroy-modal recovery
// path. See destination-picker-logic.ts for the pure decision logic
// (tested in src/escrow-engine/tests.ts).
//
// API contract:
//
//   props.amountSats     — the exact amount the consumer needs to receive
//   props.savedDestinations — listPayoutDestinations() result, passed in
//                            so the consumer controls when to refresh
//   props.title          — header text (caller-customized: "Claim",
//                          "Recover sats", etc.)
//   props.onResolve      — fired with (bolt11, { saveAfter, addressUsed })
//                          once the picker has a BOLT11. The consumer
//                          dispatches the actual outbound LN send and
//                          decides whether to call addOrTouchPayoutDestination
//                          based on saveAfter
//   props.onCancel       — modal dismissed without committing
//
// The picker handles Lightning Address LNURL-pay resolution and NWC
// make_invoice resolution internally; the consumer only sees BOLT11.

import { useMemo, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react";
import { T, inputStyle } from "../theme.js";
import type { PayoutDestination } from "../../payments/payout-destinations.js";
import type { SavedNwcConnection } from "../../payments/nwc-connections.js";
import {
  resolveLightningAddressToInvoice,
  LnurlError,
} from "../../payments/lnurl.js";
import { resolveNwcConnectionToInvoice, NwcError } from "../../payments/nwc.js";
import {
  decoratePayoutDestinationsForPicker,
  classifyDestinationInput,
  decideDispatch,
} from "./destination-picker-logic.js";
import { BitcoinAmount } from "./BitcoinAmount.js";

export interface DestinationPickerResolveOpts {
  /** Whether the consumer should call addOrTouchPayoutDestination. */
  saveAfter: boolean;
  /** The Lightning Address used (if any) — passed back so the consumer
   *  doesn't need to re-derive it from the BOLT11. Unset for Tier 3
   *  pasted-BOLT11 dispatch. */
  addressUsed?: string;
  /** NWC connection used to create the returned BOLT11, if any. */
  nwcConnectionString?: string;
  /** Whether the caller should save/touch the NWC connection after success. */
  saveNwcAfter?: boolean;
}

export interface DestinationPickerProps {
  /** Exact amount the consumer needs to receive. Passed into LNURL
   *  metadata validation and into the callback URL. */
  amountSats: number;
  /** Lightning Address payout destinations previously saved by the user.
   *  Caller fetches these via listPayoutDestinations(). */
  savedDestinations: PayoutDestination[];
  /** Saved NWC wallets. Caller fetches via listSavedNwcConnections(). */
  savedNwcConnections?: SavedNwcConnection[];
  /** Modal header. "Claim", "Recover sats", etc. */
  title: string;
  /** Optional one-line subtitle below the title. */
  subtitle?: ReactNode;
  /** Fired with BOLT11 plus metadata describing whether/what to save. */
  onResolve: (bolt11: string, opts: DestinationPickerResolveOpts) => void;
  /** Fired when the user dismisses the modal without committing. */
  onCancel: () => void;
  /** Optional first-tier destination supplied by a caller-specific
   *  adapter, such as Chapsmart for Tanzania TZS payouts. */
  topSlot?: ReactNode;
}

export function DestinationPicker({
  amountSats,
  savedDestinations,
  savedNwcConnections = [],
  title,
  subtitle,
  onResolve,
  onCancel,
  topSlot,
}: DestinationPickerProps) {
  const [typed, setTyped] = useState("");
  const [bolt11, setBolt11] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [rememberNwc, setRememberNwc] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const typedInput = useMemo(() => classifyDestinationInput(typed), [typed]);
  const bolt11PasteInput = useMemo(
    () => showAdvanced ? classifyDestinationInput(bolt11) : undefined,
    [bolt11, showAdvanced],
  );
  const dispatchPreview = useMemo(
    () => decideDispatch({
      typedInput,
      bolt11PasteInput,
      saveToggleOn: true,
    }),
    [typedInput, bolt11PasteInput],
  );

  const decoratedRows = useMemo(
    () => decoratePayoutDestinationsForPicker(savedDestinations),
    [savedDestinations],
  );

  const dispatchSavedRow = async (destination: PayoutDestination) => {
    setErr(null);
    setBusy(true);
    try {
      const invoice = await resolveLightningAddressToInvoice(
        destination.address,
        amountSats,
      );
      onResolve(invoice, { saveAfter: true, addressUsed: destination.address });
    } catch (e) {
      setErr(formatLnurlError(e));
    } finally {
      setBusy(false);
    }
  };

  const dispatchSavedNwc = async (connection: SavedNwcConnection) => {
    setErr(null);
    setBusy(true);
    try {
      const invoice = await resolveNwcConnectionToInvoice(
        connection.connectionString,
        amountSats,
        { description: "Chama payout" },
      );
      onResolve(invoice, {
        saveAfter: false,
        nwcConnectionString: connection.connectionString,
        saveNwcAfter: true,
      });
    } catch (e) {
      setErr(formatLnurlError(e));
    } finally {
      setBusy(false);
    }
  };

  const dispatchTyped = async (saveAfterOverride = true) => {
    setErr(null);
    const decision = decideDispatch({
      typedInput,
      bolt11PasteInput,
      saveToggleOn: saveAfterOverride,
    });
    if (!decision.ok) {
      setErr(decision.reason);
      return;
    }
    setBusy(true);
    try {
      if (decision.decision.tier === "pasted-bolt11") {
        const resolvedBolt11 = bolt11PasteInput?.kind === "bolt11"
          ? bolt11PasteInput.bolt11
          : typedInput.kind === "bolt11"
            ? typedInput.bolt11
            : (showAdvanced && bolt11.trim()) || typed.trim();
        onResolve(resolvedBolt11, { saveAfter: false });
        return;
      }
      if (decision.decision.tier === "pasted-nwc") {
        const connectionString = bolt11PasteInput?.kind === "nwc"
          ? bolt11PasteInput.connectionString
          : typedInput.kind === "nwc"
            ? typedInput.connectionString
            : (showAdvanced && bolt11.trim()) || typed.trim();
        const invoice = await resolveNwcConnectionToInvoice(
          connectionString,
          amountSats,
          { description: "Chama payout" },
        );
        onResolve(invoice, {
          saveAfter: false,
          nwcConnectionString: connectionString,
          saveNwcAfter: rememberNwc,
        });
        return;
      }
      // typed-address path
      const address = decision.decision.addressUsed!;
      const invoice = await resolveLightningAddressToInvoice(
        address,
        amountSats,
      );
      onResolve(invoice, {
        saveAfter: decision.decision.saveAfter,
        addressUsed: address,
      });
    } catch (e) {
      setErr(formatLnurlError(e));
    } finally {
      setBusy(false);
    }
  };

  const commitOnEnter = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || busy) return;
    e.preventDefault();
    void dispatchTyped(true);
  };

  const handleTypedPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    const pasted = classifyDestinationInput(text);
    if (pasted.kind === "bolt11" || pasted.kind === "nwc") {
      e.preventDefault();
      setTyped("");
      setBolt11(pasted.kind === "bolt11" ? pasted.bolt11 : pasted.connectionString);
      if (pasted.kind === "nwc") setRememberNwc(true);
      setShowAdvanced(true);
      setErr(null);
    }
  };

  const handleAdvancedPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const text = e.clipboardData.getData("text");
    const pasted = classifyDestinationInput(text);
    if (pasted.kind === "lightning-address") {
      e.preventDefault();
      setTyped(pasted.address);
      setBolt11("");
      setShowAdvanced(false);
      setErr(null);
    }
  };

  const activeSubmit = dispatchPreview.ok && !busy;
  const previewTier = dispatchPreview.ok ? dispatchPreview.decision.tier : null;
  const submitAmount = (
    <BitcoinAmount sats={amountSats} size={12} gap={4} glyphScale={1.18} color="inherit" glyphColor="inherit" />
  );
  const submitLabel = busy
    ? "Resolving…"
    : dispatchPreview.ok && dispatchPreview.decision.tier === "pasted-bolt11"
      ? <>Pay invoice · {submitAmount}</>
      : dispatchPreview.ok && dispatchPreview.decision.tier === "pasted-nwc"
        ? <>NWC invoice · {submitAmount}</>
        : dispatchPreview.ok && dispatchPreview.decision.tier === "typed-address"
          ? <>Save & send · {submitAmount}</>
          : <>Send {submitAmount} →</>;

  const renderPrimarySubmitButton = (marginBottom = 10, saveAfterOverride = true) => (
    <button
      disabled={busy}
      onClick={() => void dispatchTyped(saveAfterOverride)}
      style={{
        width: "100%", padding: "12px 16px", borderRadius: T.rs,
        background: activeSubmit ? T.accent : T.surface,
        border: `1px solid ${activeSubmit ? T.accent : T.border}`,
        color: activeSubmit ? "#000" : T.muted,
        fontFamily: T.mono, fontSize: 12, fontWeight: 800,
        cursor: busy ? "not-allowed" : "pointer", marginBottom,
      }}
    >
      {submitLabel}
    </button>
  );

  const renderActionButtons = (marginBottom = 10) => {
    if (previewTier !== "typed-address") {
      return renderPrimarySubmitButton(marginBottom);
    }

    return (
      <div style={{ marginBottom }}>
        {renderPrimarySubmitButton(8, true)}
        <button
          disabled={busy}
          onClick={() => void dispatchTyped(false)}
          style={{
            width: "100%", padding: "11px 16px", borderRadius: T.rs,
            background: T.surface, border: `1px solid ${activeSubmit ? T.accent + "55" : T.border}`,
            color: activeSubmit ? T.accent : T.muted,
            fontFamily: T.mono, fontSize: 11, fontWeight: 800,
            cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          Send once — don't save
        </button>
      </div>
    );
  };

  return (
    <div onClick={onCancel} style={{
      position: "fixed", inset: 0, background: "#000a", zIndex: 9998,
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 16, animation: "fadeIn 0.2s ease",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: T.card, border: `1px solid ${T.borderHi}`, borderRadius: T.r,
        padding: 24, maxWidth: 420, width: "100%",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.text, fontFamily: T.sans }}>
            {title}
          </div>
          <button onClick={onCancel} style={{
            background: "none", border: "none", color: T.muted,
            fontFamily: T.mono, fontSize: 18, cursor: "pointer", padding: 0, lineHeight: 1,
          }}>×</button>
        </div>
        <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 16 }}>
          {subtitle ?? <>Send <BitcoinAmount sats={amountSats} size={11} gap={4} glyphScale={1.18} color={T.muted} glyphColor={T.muted} /> to your Lightning wallet</>}
        </div>

        {topSlot && (
          <div style={{ marginBottom: 16 }}>
            {topSlot}
          </div>
        )}

        {/* Tier 1: saved rows */}
        {(decoratedRows.length > 0 || savedNwcConnections.length > 0) && (
          <div style={{ marginBottom: 16 }}>
            {decoratedRows.length > 0 && (
              <>
                <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, marginBottom: 6, letterSpacing: 1 }}>
                  SAVED DESTINATIONS
                </div>
                {decoratedRows.map(({ destination, isDefault }) => (
                  <button
                    key={destination.id}
                    disabled={busy}
                    onClick={() => dispatchSavedRow(destination)}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      width: "100%", padding: "10px 12px", marginBottom: 6,
                      background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs,
                      cursor: busy ? "not-allowed" : "pointer", textAlign: "left",
                    }}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <span style={{ color: T.accent, fontFamily: T.mono, fontSize: 12 }}>⚡</span>
                      <span style={{
                        color: T.text, fontFamily: T.mono, fontSize: 11,
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}>
                        {destination.address}
                      </span>
                    </span>
                    {isDefault && (
                      <span style={{
                        fontSize: 8, fontFamily: T.mono, letterSpacing: 1,
                        color: T.accent, background: T.accentDim,
                        padding: "2px 6px", borderRadius: 4,
                      }}>DEFAULT</span>
                    )}
                  </button>
                ))}
              </>
            )}
            {savedNwcConnections.length > 0 && (
              <>
                <div style={{
                  fontSize: 9, color: T.muted, fontFamily: T.mono,
                  margin: decoratedRows.length > 0 ? "10px 0 6px" : "0 0 6px",
                  letterSpacing: 1,
                }}>
                  SAVED NWC WALLETS
                </div>
                {savedNwcConnections.map((connection, i) => (
                  <button
                    key={connection.id}
                    disabled={busy}
                    onClick={() => dispatchSavedNwc(connection)}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      width: "100%", padding: "10px 12px", marginBottom: 6,
                      background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs,
                      cursor: busy ? "not-allowed" : "pointer", textAlign: "left",
                    }}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <span style={{ color: T.accent, fontFamily: T.mono, fontSize: 11 }}>NWC</span>
                      <span style={{
                        color: T.text, fontFamily: T.mono, fontSize: 11,
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}>
                        {connection.label}
                      </span>
                    </span>
                    {i === 0 && (
                      <span style={{
                        fontSize: 8, fontFamily: T.mono, letterSpacing: 1,
                        color: T.accent, background: T.accentDim,
                        padding: "2px 6px", borderRadius: 4,
                      }}>DEFAULT</span>
                    )}
                  </button>
                ))}
              </>
            )}
          </div>
        )}

        {/* Tier 2: typed Lightning Address */}
        <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, marginBottom: 6, letterSpacing: 1 }}>
          {(decoratedRows.length > 0 || savedNwcConnections.length > 0) ? "OR SEND TO A NEW ADDRESS" : "SEND TO LIGHTNING ADDRESS"}
        </div>
        <input
          type="text"
          inputMode="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={typed}
          onChange={(e) => { setTyped(e.target.value); setErr(null); }}
          onPaste={handleTypedPaste}
          onKeyDown={commitOnEnter}
          placeholder="you@yourwallet.app"
          disabled={busy}
          style={{ ...inputStyle, marginBottom: 10 }}
        />

        {!showAdvanced && renderActionButtons(10)}

        {/* Tier 3: BOLT11/NWC paste under disclosure */}
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          style={{
            width: "100%", padding: "6px 0", borderRadius: T.rs,
            background: "transparent", border: "none",
            color: T.muted, fontFamily: T.mono, fontSize: 10,
            cursor: "pointer", marginBottom: showAdvanced ? 8 : 0,
          }}
        >
          {showAdvanced ? "▾ More options" : "▸ More options"}
        </button>
        {showAdvanced && (
          <>
            <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, marginBottom: 6, letterSpacing: 1 }}>
              PASTE BOLT11 INVOICE OR NWC
            </div>
            <textarea
              value={bolt11}
              onChange={(e) => { setBolt11(e.target.value); setErr(null); }}
              onPaste={handleAdvancedPaste}
              onKeyDown={commitOnEnter}
              placeholder="lnbc... or nostr+walletconnect://..."
              rows={3}
              disabled={busy}
              style={{ ...inputStyle, resize: "vertical" as const, minHeight: 60, marginBottom: 8 }}
            />
            <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, marginBottom: 12 }}>
              For invoice-only wallets or NWC make_invoice.
            </div>
            {bolt11PasteInput?.kind === "nwc" && (
              <label style={{
                display: "flex", alignItems: "center", gap: 8,
                marginBottom: 12, color: T.muted, fontFamily: T.mono,
                fontSize: 10, cursor: busy ? "not-allowed" : "pointer",
              }}>
                <input
                  type="checkbox"
                  checked={rememberNwc}
                  disabled={busy}
                  onChange={(e) => setRememberNwc(e.target.checked)}
                />
                Remember this NWC wallet
              </label>
            )}
            {renderActionButtons(10)}
          </>
        )}

        {err && (
          <div style={{
            marginTop: 4, padding: 10, borderRadius: T.rs,
            background: T.redDim, border: `1px solid ${T.red}44`,
            color: T.red, fontFamily: T.mono, fontSize: 10,
          }}>
            {err}
          </div>
        )}
      </div>
    </div>
  );
}

function formatLnurlError(e: unknown): string {
  if (e instanceof LnurlError) {
    switch (e.code) {
      case "LnurlParseError":
        return e.message;
      case "LnurlDnsError":
        return `Couldn't reach that wallet's server. ${e.message}`;
      case "LnurlServerError":
        return `That wallet's server is unhappy. ${e.message}`;
      case "LnurlMalformedError":
        return `That wallet returned an unexpected response. ${e.message}`;
      case "LnurlAmountOutOfRangeError":
        return e.message;
    }
  }
  if (e instanceof NwcError) {
    switch (e.code) {
      case "NwcParseError":
        return e.message;
      case "NwcUnsupportedWallet":
        return e.message;
      case "NwcRelayError":
        return `Couldn't reach that NWC relay. ${e.message}`;
      case "NwcTimeout":
        return e.message;
      case "NwcWalletError":
        return `NWC wallet refused the invoice request. ${e.message}`;
      case "NwcMalformedResponse":
        return `NWC wallet returned an unexpected response. ${e.message}`;
    }
  }
  return (e as { message?: string })?.message || "Couldn't resolve destination";
}
