// ══════════════════════════════════════════════════════════════════════════
// Chama — Sim mode banner + first-entry info modal
// ══════════════════════════════════════════════════════════════════════════
//
// Two surfaces, one component, one purpose: make it impossible to
// confuse sim trades with real ones.
//
//   - SimModePill: persistent top-of-viewport bar. Visible on every
//     screen for the entire sim session. The pill is the only thing
//     that distinguishes a sim wallet from a real one in the UI; if
//     it ever disappears, a tester could move on assuming they're
//     spending real sats. So it sits in a fixed-position container
//     above all other content with z-index that beats modals.
//
//   - SimEntryModal: appears once per browser per sim mode activation.
//     Reads + writes a localStorage flag (`chama_sim_modal_ack_<v>`) so
//     the user is briefed exactly once. The "v1" suffix lets us force
//     a re-acknowledgment if the sim contract ever changes (e.g. when
//     we wire real Fedimint back in alongside sim).

import { useEffect, useState } from "react";
import { T } from "../ui/theme.js";
import { isSimModeOn, setSimMode } from "./simMode.js";

const ACK_KEY = "chama_sim_modal_ack_v1";

/**
 * Vertical space the fixed-position pill occupies. App roots add
 * paddingTop = SIM_PILL_HEIGHT when sim mode is on so the header
 * doesn't render underneath the banner.
 *
 * Kept in sync with the pill's padding: 6px top + ~14px text line +
 * 6px bottom, plus a 4px buffer for varying font metrics.
 */
export const SIM_PILL_HEIGHT = 30;

export function SimModePill() {
  // Stay reactive to sim-mode flips (e.g. user clicks "Exit" in the modal)
  const [on, setOn] = useState(isSimModeOn);
  useEffect(() => {
    const tick = () => setOn(isSimModeOn());
    window.addEventListener("storage", tick);
    return () => window.removeEventListener("storage", tick);
  }, []);

  if (!on) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        top: 0, left: 0, right: 0,
        zIndex: 10_000,
        background: T.red,
        color: "#fff",
        fontFamily: T.mono,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 1.5,
        textAlign: "center",
        padding: "6px 12px",
        boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
        pointerEvents: "none",
      }}
    >
      ▲ SIM MODE — no real sats, no real federation
    </div>
  );
}

export function SimEntryModal() {
  const [on] = useState(isSimModeOn);
  // Treat the modal as one-shot per acknowledgement. If the user
  // re-enters sim mode after exiting, we'll re-show — because in
  // between they may have done real trades and the warning is worth
  // refreshing.
  const [shown, setShown] = useState<boolean>(() => {
    if (!isSimModeOn()) return true; // not in sim, suppress modal
    try { return localStorage.getItem(ACK_KEY) === "1"; }
    catch { return false; }
  });

  if (!on || shown) return null;

  const ack = () => {
    try { localStorage.setItem(ACK_KEY, "1"); } catch {}
    setShown(true);
  };

  const exit = () => {
    try { localStorage.removeItem(ACK_KEY); } catch {}
    setSimMode(false);
    // Surface change to the rest of the app via the storage event.
    // (Same-tab listeners on the pill won't fire from a direct write,
    // so we force a reload — cleaner than chasing every consumer.)
    window.location.reload();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10_001,
        background: "rgba(0,0,0,0.75)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div style={{
        maxWidth: 480,
        background: T.card,
        border: `2px solid ${T.red}`,
        borderRadius: T.r,
        padding: 24,
        color: T.text,
        fontFamily: T.sans,
        lineHeight: 1.5,
      }}>
        <div style={{
          fontFamily: T.mono,
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 2,
          color: T.red,
          marginBottom: 12,
        }}>
          ▲ SIM MODE
        </div>

        <h2 style={{
          fontSize: 22,
          fontWeight: 700,
          margin: "0 0 16px 0",
          fontFamily: T.sans,
        }}>
          You're in the Chama sim.
        </h2>

        <div style={{ fontSize: 14, color: T.text, marginBottom: 16 }}>
          Everything you do here is fake. The Fedimint wallet is mocked,
          balances live in your browser only, and Lightning invoices
          auto-settle after a few seconds. No real sats move.
        </div>

        <div style={{ fontSize: 13, color: T.muted, marginBottom: 24 }}>
          Trades still publish to real Nostr relays so the multi-party
          flow is genuine — they're tagged so the production app and
          the sim never mix. Your sim balance starts at 0; fund it from
          Settings → Manual fund and pay the invoice from anywhere
          (since it's a sim, paying it from this same tab works fine).
        </div>

        <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
          <button
            onClick={exit}
            style={{
              background: "none",
              border: `1px solid ${T.border}`,
              color: T.muted,
              fontFamily: T.mono,
              fontSize: 12,
              fontWeight: 600,
              padding: "10px 16px",
              borderRadius: T.rs,
              cursor: "pointer",
              letterSpacing: 0.5,
            }}
          >
            Exit sim mode
          </button>
          <button
            onClick={ack}
            style={{
              background: T.red,
              border: "none",
              color: "#fff",
              fontFamily: T.mono,
              fontSize: 12,
              fontWeight: 700,
              padding: "10px 20px",
              borderRadius: T.rs,
              cursor: "pointer",
              letterSpacing: 0.5,
            }}
          >
            Got it, let me play
          </button>
        </div>
      </div>
    </div>
  );
}
