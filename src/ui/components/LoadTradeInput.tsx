import { useState } from "react";
import { T } from "../theme.js";

export function LoadTradeInput({ onLoad }: { onLoad: (id: string) => void }) {
  const [id, setId] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLoad = async () => {
    if (!id.trim()) return;
    setLoading(true);
    try { await onLoad(id.trim()); } finally { setLoading(false); setId(""); }
  };

  return (
    <div style={{
      display: "flex", gap: 8, marginBottom: 16,
      padding: 12, background: T.surface,
      borderRadius: T.r, border: `1px solid ${T.border}`,
    }}>
      <input
        value={id}
        onChange={e => setId(e.target.value)}
        onKeyDown={e => e.key === "Enter" && handleLoad()}
        placeholder="Paste escrow ID to join a trade..."
        style={{
          flex: 1, padding: "8px 12px",
          background: T.card, border: `1px solid ${T.border}`,
          borderRadius: T.rs, color: T.text,
          fontFamily: T.mono, fontSize: 11, outline: "none",
        }}
      />
      <button
        onClick={handleLoad}
        disabled={!id.trim() || loading}
        style={{
          padding: "8px 16px", borderRadius: T.rs,
          background: id.trim() && !loading ? T.tealDim : T.card,
          border: `1px solid ${id.trim() && !loading ? T.teal + "44" : T.border}`,
          color: id.trim() && !loading ? T.teal : T.muted,
          fontFamily: T.mono, fontSize: 11, fontWeight: 700,
          cursor: id.trim() && !loading ? "pointer" : "default",
          transition: "all 0.2s", whiteSpace: "nowrap",
        }}
      >
        {loading ? "Loading..." : "Load"}
      </button>
    </div>
  );
}
