import { useEffect } from "react";
import { T } from "../theme.js";

export function Toast({ message, type, onDone }: {
  message: string; type: "success" | "error" | "info"; onDone: () => void;
}) {
  useEffect(() => { const t = setTimeout(onDone, 4000); return () => clearTimeout(t); }, [onDone]);
  const colors = { success: T.green, error: T.red, info: T.accent };
  const bgs = { success: T.greenDim, error: T.redDim, info: T.accentDim };
  return (
    <div style={{
      position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)",
      padding: "10px 20px", borderRadius: T.rs,
      background: bgs[type], border: `1px solid ${colors[type]}44`,
      color: colors[type], fontFamily: T.mono, fontSize: 12, fontWeight: 600,
      zIndex: 9999, animation: "fadeIn 0.3s ease",
      maxWidth: "90vw", textAlign: "center", wordBreak: "break-word",
    }}>
      {type === "success" ? "✓ " : type === "error" ? "✗ " : "⚡ "}{message}
    </div>
  );
}
