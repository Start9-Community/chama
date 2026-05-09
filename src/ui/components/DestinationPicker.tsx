// ══════════════════════════════════════════════════════════════════════════
// Chama — DestinationPicker (v0.3.0 send-side affordance)
// ══════════════════════════════════════════════════════════════════════════
//
// The canonical "user provides a destination to receive sats" surface,
// reused by the claim flow, recovery banner, and destroy-modal recovery
// path. See destination-picker-logic.ts for the pure decision logic
// (tested in src/escrow-engine/tests.ts).
//
// API contract (locked for v0.3.0; future receive-side wiring like NWC
// in v1.5 plugs in via a different surface — AtomicFundingModal —
// not this picker):
//
//   props.amountSats     — the exact amount the consumer needs to receive
//   props.savedHandles   — getSavedLightningHandles() result, passed in
//                          so the consumer controls when to refresh
//   props.title          — header text (caller-customized: "Claim",
//                          "Recover sats", etc.)
//   props.onResolve      — fired with (bolt11, { saveAfter, addressUsed })
//                          once the picker has a BOLT11 to hand off; the
//                          consumer dispatches the actual outbound LN
//                          send and decides whether to call
//                          addOrTouchLightningHandle based on saveAfter
//   props.onCancel       — modal dismissed without committing
//
// The picker handles its own LNURL resolution + error rendering; the
// consumer only sees the BOLT11 + dispatch metadata.

import { useMemo, useState } from "react";
import { T, inputStyle } from "../theme.js";
import type { SavedHandle } from "../../payments/saved-handles.js";
import {
  resolveLightningAddressToInvoice,
  LnurlError,
} from "../../payments/lnurl.js";
import {
  decorateSavedHandlesForPicker,
  classifyDestinationInput,
  decideDispatch,
} from "./destination-picker-logic.js";

export interface DestinationPickerResolveOpts {
  /** Whether the consumer should call addOrTouchLightningHandle. */
  saveAfter: boolean;
  /** The Lightning Address used (if any) — passed back so the consumer
   *  doesn't need to re-derive it from the BOLT11. Unset for Tier 3
   *  pasted-BOLT11 dispatch. */
  addressUsed?: string;
}

export interface DestinationPickerProps {
  /** Exact amount the consumer needs to receive. Passed into LNURL
   *  metadata validation and into the callback URL. */
  amountSats: number;
  /** Lightning Address handles previously saved by the user. Caller
   *  fetches these via getSavedLightningHandles() and re-fetches after
   *  a successful resolve to reflect addOrTouchLightningHandle bumps. */
  savedHandles: SavedHandle[];
  /** Modal header. "Claim", "Recover sats", etc. */
  title: string;
  /** Optional one-line subtitle below the title. */
  subtitle?: string;
  /** Fired with the BOLT11 (resolved from LNURL or pasted directly) plus
   *  metadata describing whether/what to save. */
  onResolve: (bolt11: string, opts: DestinationPickerResolveOpts) => void;
  /** Fired when the user dismisses the modal without committing. */
  onCancel: () => void;
}

export function DestinationPicker({
  amountSats,
  savedHandles,
  title,
  subtitle,
  onResolve,
  onCancel,
}: DestinationPickerProps) {
  const [typed, setTyped] = useState("");
  const [bolt11, setBolt11] = useState("");
  const [saveToggle, setSaveToggle] = useState(true); // default ON (Q3)
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const decoratedRows = useMemo(
    () => decorateSavedHandlesForPicker(savedHandles),
    [savedHandles],
  );

  const dispatchSavedRow = async (handle: SavedHandle) => {
    setErr(null);
    setBusy(true);
    try {
      const invoice = await resolveLightningAddressToInvoice(
        handle.handle,
        amountSats,
      );
      onResolve(invoice, { saveAfter: true, addressUsed: handle.handle });
    } catch (e) {
      setErr(formatLnurlError(e));
    } finally {
      setBusy(false);
    }
  };

  const dispatchTyped = async () => {
    setErr(null);
    const decision = decideDispatch({
      typedInput: classifyDestinationInput(typed),
      bolt11PasteInput: showAdvanced
        ? classifyDestinationInput(bolt11)
        : undefined,
      saveToggleOn: saveToggle,
    });
    if (!decision.ok) {
      setErr(decision.reason);
      return;
    }
    setBusy(true);
    try {
      if (decision.decision.tier === "pasted-bolt11") {
        const pastedRaw = (showAdvanced && bolt11.trim()) || typed.trim();
        onResolve(pastedRaw, { saveAfter: false });
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
          {subtitle ?? `Send ${amountSats.toLocaleString()} sats to your Lightning wallet`}
        </div>

        {/* Tier 1: saved rows */}
        {decoratedRows.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, marginBottom: 6, letterSpacing: 1 }}>
              SAVED DESTINATIONS
            </div>
            {decoratedRows.map(({ handle, isDefault }) => (
              <button
                key={handle.id}
                disabled={busy}
                onClick={() => dispatchSavedRow(handle)}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  width: "100%", padding: "10px 12px", marginBottom: 6,
                  background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs,
                  cursor: busy ? "not-allowed" : "pointer", textAlign: "left",
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ color: T.accent, fontFamily: T.mono, fontSize: 12 }}>⚡</span>
                  <span style={{ color: T.text, fontFamily: T.mono, fontSize: 11 }}>
                    {handle.handle}
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
          </div>
        )}

        {/* Tier 2: typed Lightning Address */}
        <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, marginBottom: 6, letterSpacing: 1 }}>
          {decoratedRows.length > 0 ? "OR SEND TO A NEW ADDRESS" : "SEND TO LIGHTNING ADDRESS"}
        </div>
        <input
          type="text"
          inputMode="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={typed}
          onChange={(e) => { setTyped(e.target.value); setErr(null); }}
          placeholder="you@yourwallet.app"
          disabled={busy}
          style={{ ...inputStyle, marginBottom: 10 }}
        />
        <label style={{
          display: "flex", alignItems: "center", gap: 8,
          marginBottom: 12, cursor: "pointer",
          fontFamily: T.mono, fontSize: 10, color: T.muted,
        }}>
          <input
            type="checkbox"
            checked={saveToggle}
            onChange={(e) => setSaveToggle(e.target.checked)}
            disabled={busy}
            style={{ accentColor: T.accent }}
          />
          Save for next time
        </label>

        <button
          disabled={busy}
          onClick={dispatchTyped}
          style={{
            width: "100%", padding: "12px 16px", borderRadius: T.rs,
            background: busy ? T.surface : T.accent, border: `1px solid ${T.accent}`,
            color: busy ? T.muted : "#000",
            fontFamily: T.mono, fontSize: 12, fontWeight: 800,
            cursor: busy ? "not-allowed" : "pointer", marginBottom: 10,
          }}
        >
          {busy ? "Resolving…" : `Send ${amountSats.toLocaleString()} sats →`}
        </button>

        {/* Tier 3: BOLT11 paste under disclosure */}
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
              PASTE BOLT11 INVOICE
            </div>
            <textarea
              value={bolt11}
              onChange={(e) => { setBolt11(e.target.value); setErr(null); }}
              placeholder="lnbc..."
              rows={3}
              disabled={busy}
              style={{ ...inputStyle, resize: "vertical" as const, minHeight: 60, marginBottom: 8 }}
            />
            <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, marginBottom: 12 }}>
              For BOLT11-only wallets. Pasted invoices aren't saved.
            </div>
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
  return (e as { message?: string })?.message || "Couldn't resolve destination";
}
