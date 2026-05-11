import { T } from "../theme.js";

// One-time-per-account honest disclosure for browser users. Per Pillar
// 2.7: educate at every opportunity. The v0.1.85 reality is that every
// Fedimint federation we currently have access to relies on the same
// iroh-relay infrastructure with known browser-WebSocket flakiness.
// Acknowledging that openly beats pretending one fed is reliable when
// none currently are. The banner is non-blocking — users can absolutely
// still trade from browser, they just need patience occasionally.
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
	Heads up: Browser Fedimint clients are temporarily blocked on a 
	known upstream issue (iroh-relay protocol upgrade, Fedimint SDK 
	catch-up pending). You can sign in and browse, but federation 
	operations won't complete from browser today. Tracking: 
	github.com/fedimint/fedimint-sdk/issues/288
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
