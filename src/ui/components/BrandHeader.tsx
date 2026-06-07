import { T } from "../theme.js";

// The Woven Trust lockup + tagline shown at the top of every onboarding
// surface (connect, welcome intro, country picker). Extracted to a shared
// component so the globe picker and ConnectScreen render one source of truth.
export function BrandHeader() {
  return (
    <div style={{ marginBottom: 24 }}>
      <img
        src="/icons/chama-woven-trust-lockup-horizontal.svg?v=0.9.4"
        alt="Chama"
        style={{
          display: "block",
          margin: "0 auto 18px",
          width: "min(78vw, 300px)",
          height: "auto",
          maxWidth: "100%",
          filter: "drop-shadow(0 0 32px #f7931a22)",
        }}
      />
      <div style={{
        fontSize: 10, color: T.muted, fontFamily: T.mono,
        letterSpacing: 3, textTransform: "uppercase",
      }}>
        local money, bitcoin rails
      </div>
    </div>
  );
}
