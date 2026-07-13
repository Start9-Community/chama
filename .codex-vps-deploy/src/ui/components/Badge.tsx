import { T, STATUS } from "../theme.js";

// v0.1.66.33: pill treatment depends on mode.
// Resolved → outlined, no dot. Active → filled, pulsing dot.
// Working → filled, static dot.
export function Badge({ status }: { status: string }) {
  const s = STATUS[status] || STATUS.CREATED;
  const isResolved = s.mode === "resolved";
  const isActive = s.mode === "active";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      padding: "3px 10px", borderRadius: 20,
      background: isResolved ? "transparent" : s.bg,
      color: s.c,
      border: isResolved ? `1px solid ${s.c}66` : "1px solid transparent",
      fontSize: 11, fontWeight: 600, letterSpacing: 0.5,
      textTransform: "uppercase", fontFamily: T.mono,
    }}>
      {!isResolved && (
        <span style={{
          width: 6, height: 6, borderRadius: "50%", background: s.c,
          boxShadow: `0 0 8px ${s.c}66`,
          animation: isActive ? "pulse 2s ease-in-out infinite" : "none",
        }} />
      )}
      {s.l}
    </span>
  );
}
