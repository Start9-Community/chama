import { useEffect, type ReactNode } from "react";
import { T } from "../theme.js";
import { isSimModeOn } from "../../sim/simMode.js";
import { SIM_PILL_HEIGHT } from "../../sim/SimModeBanner.js";

export function Toast({ message, type, onDone }: {
  message: ReactNode; type: "success" | "error" | "info"; onDone: () => void;
}) {
  useEffect(() => { const t = setTimeout(onDone, 4000); return () => clearTimeout(t); }, [onDone]);
  const colors = { success: T.green, error: T.red, info: T.accent };
  // v0.4.2 hotfix round 2: SIM MODE pill (top:0, z:10000) was clipping
  // the top of the toast (top:16, z:9999). Slide the toast below the
  // pill when sim mode is on so the green community-switch confirmation
  // and other toasts read cleanly.
  const topOffset = isSimModeOn() ? SIM_PILL_HEIGHT + 16 : 16;
  return (
    <div style={{
      position: "fixed", top: topOffset, left: "50%", transform: "translateX(-50%)",
      padding: "11px 20px", borderRadius: 999,
      // OPAQUE surface so the toast never blends into whatever's behind it — a
      // toast is allowed to hide the page for its few seconds. The type colour
      // lives in the border, icon, and text; a soft shadow lifts it off.
      background: T.card, border: `1px solid ${colors[type]}88`,
      boxShadow: `0 8px 24px rgba(0,0,0,0.4), 0 0 0 1px ${T.bg}`,
      color: colors[type], fontFamily: T.mono, fontSize: 12, fontWeight: 700,
      zIndex: 9999, animation: "fadeIn 0.3s ease",
      maxWidth: "90vw", textAlign: "center", wordBreak: "break-word",
    }}>
      <span style={{ display: "inline-flex", alignItems: "baseline", justifyContent: "center", gap: 4, flexWrap: "wrap" }}>
        <span>{type === "success" ? "✓" : type === "error" ? "✗" : "⚡"}</span>
        <span>{message}</span>
      </span>
    </div>
  );
}
