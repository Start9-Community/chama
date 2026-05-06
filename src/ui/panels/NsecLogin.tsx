import { useState } from "react";
import { Capacitor } from "@capacitor/core";
import { T } from "../theme.js";

export function NsecLogin({ onSubmit }: { onSubmit: (nsec: string, remember: boolean) => void }) {
  const isNative = Capacitor.isNativePlatform();
  const [showNsec, setShowNsec] = useState(isNative);
  const [nsecInput, setNsecInput] = useState("");
  const [remember, setRemember] = useState(isNative);

  if (!showNsec) {
    return (
      <div
        onClick={() => setShowNsec(true)}
        style={{
          marginTop: 8, fontSize: 10, color: T.muted,
          fontFamily: T.mono, cursor: "pointer",
          transition: "color 0.2s",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.color = T.text)}
        onMouseLeave={(e) => (e.currentTarget.style.color = T.muted)}
      >
        or paste nsec (advanced)
      </div>
    );
  }

  const handleSubmit = () => {
    if (!nsecInput.trim()) return;
    onSubmit(nsecInput.trim(), remember);
  };

  return (
    <div style={{ marginTop: isNative ? 0 : 8, width: "100%", maxWidth: 360 }}>
      {isNative && (
        <div style={{
          fontSize: 10, color: T.muted, fontFamily: T.mono,
          letterSpacing: 1, marginBottom: 8, textAlign: "center",
        }}>
          SIGN IN WITH YOUR KEY
        </div>
      )}
      <input
        value={nsecInput}
        onChange={(e) => setNsecInput(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
        placeholder="nsec1... or hex private key"
        type="password"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        style={{
          width: "100%", padding: "14px 16px", boxSizing: "border-box",
          background: T.surface, border: `1px solid ${T.border}`,
          borderRadius: T.rs, color: T.text,
          fontFamily: T.mono, fontSize: 12, outline: "none",
          marginBottom: 8,
        }}
      />
      <label style={{
        display: "flex", alignItems: "center", gap: 8,
        fontSize: 10, color: T.muted, fontFamily: T.mono,
        cursor: "pointer", marginBottom: 10,
        userSelect: "none" as const,
      }}>
        <input
          type="checkbox"
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
          style={{ accentColor: T.accent, width: 14, height: 14, cursor: "pointer" }}
        />
        Remember me on this device
      </label>
      <button
        onClick={handleSubmit}
        disabled={!nsecInput.trim()}
        style={{
          width: "100%", padding: "14px",
          background: nsecInput.trim() ? T.accent : T.surface,
          border: `1px solid ${nsecInput.trim() ? T.accent : T.border}`,
          borderRadius: T.rs, color: nsecInput.trim() ? T.bg : T.muted,
          fontFamily: T.mono, fontSize: 13, fontWeight: 700,
          cursor: nsecInput.trim() ? "pointer" : "default",
          letterSpacing: 0.5,
          transition: "all 0.2s",
        }}
      >
        Sign in
      </button>
      <div style={{
        fontSize: 9, color: T.muted, fontFamily: T.mono,
        textAlign: "center", marginTop: 10, lineHeight: 1.5,
      }}>
        {isNative
          ? "Your key stays on this device, encrypted in secure storage."
          : "Your key never leaves this browser."}
      </div>
    </div>
  );
}
