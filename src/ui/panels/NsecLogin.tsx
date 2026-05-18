import { useState } from "react";
import { Capacitor } from "@capacitor/core";
import { T } from "../theme.js";

export function NsecLogin({
  onSubmit,
  defaultOpen = false,
}: {
  onSubmit: (nsec: string, remember: boolean) => void;
  defaultOpen?: boolean;
}) {
  const isNative = Capacitor.isNativePlatform();
  const [showNsec, setShowNsec] = useState(isNative || defaultOpen);
  const [nsecInput, setNsecInput] = useState("");
  const [remember, setRemember] = useState(isNative);
  const [generatedNsec, setGeneratedNsec] = useState<string | null>(null);
  const [backupConfirmed, setBackupConfirmed] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

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
        Create or paste an nsec
      </div>
    );
  }

  const handleSubmit = () => {
    if (!nsecInput.trim()) return;
    if (generatedNsec && nsecInput.trim() === generatedNsec && !backupConfirmed) return;
    onSubmit(nsecInput.trim(), remember);
  };

  const handleGenerate = async () => {
    setGenerating(true);
    setGenerateError(null);
    try {
      const [{ generateSecretKey }, { nip19 }] = await Promise.all([
        import("nostr-tools/pure"),
        import("nostr-tools"),
      ]);
      const nsec = nip19.nsecEncode(generateSecretKey());
      setNsecInput(nsec);
      setGeneratedNsec(nsec);
      setBackupConfirmed(false);
      setRemember(true);
      setShowKey(true);
    } catch (e: any) {
      setGenerateError(e?.message || "Could not create key");
    } finally {
      setGenerating(false);
    }
  };

  const generatedActive = generatedNsec !== null && nsecInput.trim() === generatedNsec;
  const submitDisabled = !nsecInput.trim() || (generatedActive && !backupConfirmed);

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
        onChange={(e) => {
          setNsecInput(e.target.value);
          if (generatedNsec && e.target.value.trim() !== generatedNsec) {
            setGeneratedNsec(null);
            setBackupConfirmed(false);
          }
        }}
        onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
        placeholder="nsec1... or hex private key"
        type={showKey ? "text" : "password"}
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
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <button
          onClick={handleGenerate}
          disabled={generating}
          style={{
            flex: 1, padding: "10px 12px",
            background: T.surface, border: `1px solid ${T.border}`,
            borderRadius: T.rs, color: T.text,
            fontFamily: T.mono, fontSize: 10, fontWeight: 700,
            cursor: generating ? "default" : "pointer",
          }}
        >
          {generating ? "Creating..." : "Create new key"}
        </button>
        <button
          onClick={() => setShowKey(!showKey)}
          disabled={!nsecInput.trim()}
          style={{
            width: 92, padding: "10px 12px",
            background: "transparent", border: `1px solid ${T.border}`,
            borderRadius: T.rs, color: nsecInput.trim() ? T.muted : T.muted + "66",
            fontFamily: T.mono, fontSize: 10, fontWeight: 700,
            cursor: nsecInput.trim() ? "pointer" : "default",
          }}
        >
          {showKey ? "Hide" : "Show"}
        </button>
      </div>
      {generateError && (
        <div style={{
          marginBottom: 8, padding: "8px 10px",
          background: T.redDim, border: `1px solid ${T.red}33`,
          borderRadius: T.rs, color: T.red,
          fontSize: 10, fontFamily: T.mono,
        }}>
          {generateError}
        </div>
      )}
      {generatedActive && (
        <div style={{
          marginBottom: 10, padding: 12,
          background: T.amberDim, border: `1px solid ${T.amber}55`,
          borderRadius: T.rs, textAlign: "left",
        }}>
          <div style={{
            fontSize: 10, color: T.amber, fontFamily: T.mono,
            fontWeight: 800, letterSpacing: 0.8, marginBottom: 8,
          }}>
            RECOVERY KEY
          </div>
          <div style={{
            fontSize: 10, color: T.text, fontFamily: T.mono,
            lineHeight: 1.55, wordBreak: "break-all",
            padding: 10, background: T.bg, border: `1px solid ${T.border}`,
            borderRadius: T.rs, marginBottom: 8,
          }}>
            {generatedNsec}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              onClick={() => navigator.clipboard?.writeText(generatedNsec)}
              style={{
                padding: "8px 10px", background: T.surface,
                border: `1px solid ${T.border}`, borderRadius: T.rs,
                color: T.text, fontFamily: T.mono, fontSize: 10,
                fontWeight: 700, cursor: "pointer",
              }}
            >
              Copy
            </button>
            <label style={{
              display: "flex", alignItems: "center", gap: 7,
              color: T.text, fontSize: 10, fontFamily: T.mono,
              cursor: "pointer", userSelect: "none" as const,
            }}>
              <input
                type="checkbox"
                checked={backupConfirmed}
                onChange={(e) => setBackupConfirmed(e.target.checked)}
                style={{ accentColor: T.accent, width: 14, height: 14, cursor: "pointer" }}
              />
              I saved it
            </label>
          </div>
        </div>
      )}
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
        disabled={submitDisabled}
        style={{
          width: "100%", padding: "14px",
          background: !submitDisabled ? T.accent : T.surface,
          border: `1px solid ${!submitDisabled ? T.accent : T.border}`,
          borderRadius: T.rs, color: !submitDisabled ? T.bg : T.muted,
          fontFamily: T.mono, fontSize: 13, fontWeight: 700,
          cursor: !submitDisabled ? "pointer" : "default",
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
