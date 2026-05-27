import { T } from "../theme.js";

// One-time-per-account positive runtime announcement.
// v1.1.0: the production-safe real-sats paths are the shells that ship
// their own Fedimint path directly: Fedi, Tauri desktop, and the APK.
// The component keeps the old name so callsites/storage migration stay
// small, but the copy is no longer browser-specific.
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
        CHAMA SUPPORT NOTE
      </div>
      <div style={{
        fontSize: 13, color: T.text, fontFamily: T.sans,
        lineHeight: 1.55,
      }}>
        Safe to use directly with Fedi, Tauri desktop, and the Android APK.
        These routes use Chama's supported Fedimint paths for real sats.
        Browser mode is fine for browsing and testing; for production money
        movement, use one of the supported shells.
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
