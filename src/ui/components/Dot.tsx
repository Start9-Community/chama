import { T, ROLE_COLOR, ROLE_ICON } from "../theme.js";

export function Dot({ role, pk, isYou, voted, outcome }: {
  role: string; pk: string | null; isYou: boolean; voted: boolean; outcome?: string;
}) {
  const c = ROLE_COLOR[role as keyof typeof ROLE_COLOR] || T.muted;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
      <div style={{
        width: 36, height: 36, borderRadius: "50%",
        background: pk ? `${c}22` : T.surface,
        border: `1.5px ${pk ? "solid" : "dashed"} ${pk ? c : T.border}`,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 13, fontWeight: 700, color: pk ? c : T.muted,
        fontFamily: T.mono, position: "relative",
      }}>
        {ROLE_ICON[role as keyof typeof ROLE_ICON] || "?"}
        {voted && (
          <div style={{
            position: "absolute", bottom: -2, right: -2,
            width: 14, height: 14, borderRadius: "50%",
            background: outcome === "release" ? T.green : T.amber,
            border: `2px solid ${T.card}`,
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8,
          }}>
            {outcome === "release" ? "✓" : "↩"}
          </div>
        )}
      </div>
      <span style={{ fontSize: 9, color: isYou ? c : T.muted, fontFamily: T.mono, fontWeight: isYou ? 700 : 400 }}>
        {isYou ? "You" : pk ? pk.slice(0, 6) + "…" : "Empty"}
      </span>
    </div>
  );
}
