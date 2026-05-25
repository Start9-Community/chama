import { useEffect, type ReactNode } from "react";
import { T } from "../theme.js";
import { isSimModeOn } from "../../sim/simMode.js";
import { SIM_PILL_HEIGHT } from "../../sim/SimModeBanner.js";

export function Toast({ message, type, onDone }: {
  message: ReactNode; type: "success" | "error" | "info"; onDone: () => void;
}) {
  useEffect(() => { const t = setTimeout(onDone, 4000); return () => clearTimeout(t); }, [onDone]);
  const colors = { success: T.green, error: T.red, info: T.accent };
  const bgs = { success: T.greenDim, error: T.redDim, info: T.accentDim };
  // v0.4.2 hotfix round 2: SIM MODE pill (top:0, z:10000) was clipping
  // the top of the toast (top:16, z:9999). Slide the toast below the
  // pill when sim mode is on so the green community-switch confirmation
  // and other toasts read cleanly.
  const topOffset = isSimModeOn() ? SIM_PILL_HEIGHT + 16 : 16;
  return (
    <div style={{
      position: "fixed", top: topOffset, left: "50%", transform: "translateX(-50%)",
      padding: "10px 20px", borderRadius: T.rs,
      background: bgs[type], border: `1px solid ${colors[type]}44`,
      color: colors[type], fontFamily: T.mono, fontSize: 12, fontWeight: 600,
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
