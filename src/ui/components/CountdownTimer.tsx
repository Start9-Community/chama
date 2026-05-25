import { useState, useEffect } from "react";
import { T } from "../theme.js";

export function CountdownTimer({
  expiresAt,
  label = "EXPIRES IN",
}: {
  expiresAt: number;
  label?: string;
}) {
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));

  useEffect(() => {
    const interval = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(interval);
  }, []);

  const remaining = expiresAt - now;
  if (remaining <= 0) {
    // v0.1.66.29: only the outer guard's skip-list keeps this from
    // showing on resolved trades. As a safety net, call it "Deadline
    // passed" rather than "EXPIRED" — the word EXPIRED is reserved
    // for the actual EscrowStatus.EXPIRED terminal state.
    return (
      <div style={{
        padding: "10px 16px", borderRadius: T.rs,
        background: T.redDim, border: `1px solid ${T.red}44`,
        textAlign: "center", fontFamily: T.mono, fontSize: 12,
        color: T.red, fontWeight: 700,
      }}>
        DEADLINE PASSED
      </div>
    );
  }

  const hours = Math.floor(remaining / 3600);
  const mins = Math.floor((remaining % 3600) / 60);
  const secs = remaining % 60;
  const timeStr = hours > 0
    ? `${hours}h ${mins.toString().padStart(2, "0")}m ${secs.toString().padStart(2, "0")}s`
    : mins > 0
    ? `${mins}m ${secs.toString().padStart(2, "0")}s`
    : `${secs}s`;

  const urgent = remaining < 300;
  const warning = remaining < 600;
  const caution = remaining < 3600;

  const color = warning ? T.red : caution ? T.amber : T.green;
  const bg = warning ? T.redDim : caution ? T.amberDim : T.greenDim;

  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "center",
      gap: 8, padding: "8px 16px", borderRadius: T.rs,
      background: bg, border: `1px solid ${color}44`,
      fontFamily: T.mono, fontSize: 11,
      animation: urgent ? "pulse 1s ease-in-out infinite" : "none",
    }}>
      <span style={{ color: T.muted, fontSize: 9, letterSpacing: 1 }}>{label}</span>
      <span style={{ color, fontWeight: 700, fontSize: 13 }}>{timeStr}</span>
    </div>
  );
}
