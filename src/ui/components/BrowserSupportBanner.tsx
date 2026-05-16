import { T } from "../theme.js";

// One-time-per-account positive announcement for browser users.
// v0.5.0: the Fedimint canary SDK bumped iroh-relay to 0.90 and
// cleared the 400 Bad Request that previously gated browser-WebSocket
// transport. End-to-end browser flows — federation join, ecash mint,
// claim/redeem — verified working. Per Pillar 2.7 (educate at every
// opportunity), surface the current honest state so returning users
// who saw the old "temporarily blocked" copy know the gate is gone.
export function BrowserSupportBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div style={{
      margin: "12px 16px", padding: "14px 16px",
      background: T.amberDim, border: `1px solid ${T.amber}44`,
      borderRadius: T.r,
      display: "flex", flexDirection: "column", gap: 12,
    }}>
      <div style={{
        fontSize: 11, fontWeight: 700, color: T.amber, fontFamily: T.mono,
        letterSpacing: 1,
      }}>
        BROWSER SUPPORT NOTE
      </div>
      <div style={{
        fontSize: 13, color: T.text, fontFamily: T.sans,
        lineHeight: 1.55,
      }}>
        Browser Fedimint enabled. Chama now runs end-to-end in the
        browser — federations join, ecash mints, claims redeem.
        Available on canary SDK pending Fedimint stable release.
        Tracking: github.com/fedimint/fedimint-sdk/issues/288
      </div>
      <button
        onClick={onDismiss}
        style={{
          alignSelf: "flex-start",
          padding: "7px 14px", borderRadius: T.rs,
          background: T.surface, border: `1px solid ${T.amber}44`,
          color: T.amber, fontFamily: T.mono, fontSize: 11, fontWeight: 700,
          cursor: "pointer", letterSpacing: 0.5,
        }}
      >
        Got it
      </button>
    </div>
  );
}
