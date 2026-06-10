import { T } from "../theme.js";
import { getSignInEnvironment, shouldApplyCssSafeAreaInsets } from "../sign-in-environment.js";

export type Tab = "browse" | "create" | "me";

export const BOTTOM_NAV_HEIGHT = 64;

// Bottom navigation — fixed at the viewport bottom. v0.2.0 will add
// active-trade interception on tab tap; v0.1.85 is visual only.
export function BottomNav({ active, onSelect }: {
  active: Tab;
  onSelect: (t: Tab) => void;
}) {
  const useSafeAreaInsets = shouldApplyCssSafeAreaInsets(getSignInEnvironment());
  // v3.2: the old Create tab mirrors the Browse pencil for now. Both surfaces
  // open the same overlay, keeping one create path until the tab's permanent
  // future is decided.
  const items: { id: Tab; label: string; icon: string }[] = [
    { id: "browse", label: "Browse", icon: "🔍" },
    { id: "create", label: "Create", icon: "✎" },
    { id: "me",     label: "Me",     icon: "👤" },
  ];
  return (
    <div style={{
      position: "fixed", bottom: 0, left: 0, right: 0,
      background: T.surface, borderTop: `1px solid ${T.border}`,
      display: "flex", justifyContent: "center",
      zIndex: 100,
      paddingBottom: useSafeAreaInsets ? "env(safe-area-inset-bottom, 0px)" : 0,
    }}>
      <div style={{
        display: "flex", width: "100%", maxWidth: 520,
      }}>
        {items.map(item => {
          const isActive = active === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onSelect(item.id)}
              style={{
                flex: 1, padding: "10px 4px",
                background: "none", border: "none",
                color: isActive ? T.accent : T.muted,
                opacity: 1,
                fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                cursor: "pointer", letterSpacing: 0.5,
                display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                height: BOTTOM_NAV_HEIGHT,
                borderTop: `2px solid ${isActive ? T.accent : "transparent"}`,
                transition: "all 0.15s",
              }}
            >
              <span style={{ fontSize: 18, lineHeight: 1 }}>{item.icon}</span>
              {item.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
