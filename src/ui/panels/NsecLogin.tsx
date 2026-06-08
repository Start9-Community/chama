import { useEffect, useRef, useState, type ReactNode } from "react";
import { Capacitor } from "@capacitor/core";
import { T } from "../theme.js";
import { validateRecoveryKeyInput } from "../../escrow-engine/nsec-signer.js";

export function NsecLogin({
  onSubmit,
  defaultOpen = false,
  friendly = false,
  friendlySecondary,
  allowCreate = true,
  minimalPaste = false,
  choiceFooter,
}: {
  onSubmit: (nsec: string, remember: boolean, wasGenerated: boolean) => void;
  defaultOpen?: boolean;
  friendly?: boolean;
  friendlySecondary?: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    tone?: "accent" | "neutral";
  };
  allowCreate?: boolean;
  minimalPaste?: boolean;
  // Overrides the choice-mode footer copy. ConnectScreen swaps in
  // recovery-specific guidance once "I'm a returning Chama citizen" reveals
  // the paste box, so the "we'll create a key" line never sits above a box
  // that's asking for an existing one.
  choiceFooter?: ReactNode;
}) {
  const isNative = Capacitor.isNativePlatform();
  const [showNsec, setShowNsec] = useState(isNative || defaultOpen || friendly);
  const [mode, setMode] = useState<"choice" | "create" | "paste">(
    friendly ? "choice" : "paste",
  );
  const [nsecInput, setNsecInput] = useState("");
  // v2.5: no more "Remember me" toggle. On native we always persist the key to
  // secure storage so auto-login just works next launch (sign-out is the
  // forget switch); on web nothing is persisted regardless. Simpler, and it's
  // what people expect on their own phone.
  const remember = isNative;
  const [generatedNsec, setGeneratedNsec] = useState<string | null>(null);
  const [backupConfirmed, setBackupConfirmed] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const autoSubmittedKeyRef = useRef<string | null>(null);
  const copyResetRef = useRef<number | null>(null);

  // Copy the generated key with a brief "Copied ✓" confirmation — the
  // reassurance that the most important string in the app actually made it to
  // the clipboard.
  const handleCopyKey = () => {
    if (!generatedNsec) return;
    navigator.clipboard?.writeText(generatedNsec);
    setCopied(true);
    if (copyResetRef.current) window.clearTimeout(copyResetRef.current);
    copyResetRef.current = window.setTimeout(() => setCopied(false), 1800);
  };

  const handleGenerate = async () => {
    setMode("create");
    setGenerating(true);
    setGenerateError(null);
    setInputError(null);
    try {
      const [{ generateSecretKey }, { nip19 }] = await Promise.all([
        import("nostr-tools/pure"),
        import("nostr-tools"),
      ]);
      const nsec = nip19.nsecEncode(generateSecretKey());
      setNsecInput(nsec);
      setGeneratedNsec(nsec);
      setBackupConfirmed(false);
      setShowKey(true);
    } catch (e: any) {
      setGenerateError(e?.message || "Could not create key");
    } finally {
      setGenerating(false);
    }
  };

  const handleSubmit = async () => {
    if (!nsecInput.trim()) return;
    if (generatedNsec && nsecInput.trim() === generatedNsec && !backupConfirmed) return;
    const validated = await validateRecoveryKeyInput(nsecInput);
    if (!validated.ok) {
      setInputError(validated.error);
      return;
    }
    setInputError(null);
    // v2.5: tell the shell whether this key was generated in Chama (so only
    // generated keys get the master-key reveal in Me › Advanced). The submitted
    // key matching the just-generated one is the signal.
    const wasGenerated = generatedNsec !== null && nsecInput.trim() === generatedNsec;
    onSubmit(nsecInput.trim(), remember, wasGenerated);
  };

  const generatedActive = generatedNsec !== null && nsecInput.trim() === generatedNsec;
  const submitDisabled = !nsecInput.trim() || (generatedActive && !backupConfirmed);
  const showPasteInput = !generatedActive || mode === "paste";

  useEffect(() => {
    const value = nsecInput.trim();
    if (!showPasteInput || !value || generatedActive) return;
    if (generatedNsec && value === generatedNsec && !backupConfirmed) return;
    if (autoSubmittedKeyRef.current === value) return;

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const validated = await validateRecoveryKeyInput(value);
      if (cancelled || !validated.ok) return;
      autoSubmittedKeyRef.current = value;
      setInputError(null);
      // Auto-submit only fires for a PASTED key (gated on !generatedActive
      // above), so it's never the Chama-generated one.
      onSubmit(value, remember, false);
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    nsecInput,
    showPasteInput,
    generatedActive,
    generatedNsec,
    backupConfirmed,
    remember,
    onSubmit,
  ]);

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
        Use an existing account
      </div>
    );
  }

  if (friendly && mode === "choice") {
    const secondaryAccent = friendlySecondary?.tone === "accent";
    return (
      <div style={{ width: "100%", maxWidth: 360 }}>
        <button
          onClick={handleGenerate}
          disabled={generating}
          style={{
            width: "100%", padding: "16px", borderRadius: T.r,
            background: T.accent, border: "none", color: T.bg,
            fontFamily: T.sans, fontSize: 15, fontWeight: 800,
            cursor: generating ? "default" : "pointer",
            marginBottom: 10,
          }}
        >
          {generating ? "Creating..." : "Create my account"}
        </button>
        <button
          onClick={friendlySecondary
            ? friendlySecondary.onClick
            : () => {
                setMode("paste");
                setGeneratedNsec(null);
                setBackupConfirmed(false);
                setInputError(null);
              }}
          disabled={friendlySecondary?.disabled}
          style={{
            width: "100%", padding: "13px", borderRadius: T.r,
            background: secondaryAccent ? T.accentDim : T.surface,
            border: `1px solid ${secondaryAccent ? `${T.accent}99` : T.border}`,
            color: friendlySecondary?.disabled ? T.muted : secondaryAccent ? T.accent : T.text,
            fontFamily: T.sans, fontSize: 13,
            fontWeight: 700,
            cursor: friendlySecondary?.disabled ? "default" : "pointer",
          }}
        >
          {friendlySecondary?.label ?? "I already have a key"}
        </button>
        <div style={{
          fontSize: 10, color: T.muted, fontFamily: T.sans,
          textAlign: "center", marginTop: 12, lineHeight: 1.5,
        }}>
          {choiceFooter ?? (
            <>Chama creates a private recovery key on this device. Save it once
            so you can restore your account later.</>
          )}
        </div>
        {generateError && <InlineError>{generateError}</InlineError>}
      </div>
    );
  }

  return (
    <div style={{ marginTop: isNative ? 0 : 8, width: "100%", maxWidth: 360 }}>
      {isNative && (
        <div style={{
          fontSize: 10, color: T.muted, fontFamily: T.mono,
          letterSpacing: 1, marginBottom: 8, textAlign: "center",
        }}>
          SIGN IN
        </div>
      )}

      {friendly && (
        <button
          onClick={() => {
            setMode("choice");
            setNsecInput("");
            setGeneratedNsec(null);
            setBackupConfirmed(false);
            setInputError(null);
          }}
          style={{
            background: "transparent", border: "none", color: T.muted,
            fontFamily: T.mono, fontSize: 10, cursor: "pointer",
            marginBottom: 10,
          }}
        >
          ← Back
        </button>
      )}

      {showPasteInput && (
        <>
          <input
            value={nsecInput}
            onChange={(e) => {
              setNsecInput(e.target.value);
              setInputError(null);
              if (generatedNsec && e.target.value.trim() !== generatedNsec) {
                setGeneratedNsec(null);
                setBackupConfirmed(false);
              }
            }}
            onKeyDown={(e) => e.key === "Enter" && void handleSubmit()}
            placeholder="Paste recovery key"
            type={showKey ? "text" : "password"}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            style={{
              width: "100%", padding: "14px 16px", boxSizing: "border-box",
              background: T.surface, border: `1px solid ${inputError ? T.red : T.border}`,
              borderRadius: T.rs, color: T.text,
              fontFamily: T.mono, fontSize: 12, outline: "none",
              marginBottom: 8,
            }}
          />
          <div style={{
            display: "flex", gap: 8, marginBottom: 8,
            justifyContent: allowCreate ? "stretch" : "flex-end",
          }}>
            {allowCreate && (
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
                {generating ? "Creating..." : "Create new account"}
              </button>
            )}
            <button
              onClick={() => setShowKey(!showKey)}
              disabled={!nsecInput.trim()}
              style={{
                width: allowCreate ? 92 : 120, padding: "10px 12px",
                background: "transparent", border: `1px solid ${T.border}`,
                borderRadius: T.rs, color: nsecInput.trim() ? T.muted : T.muted + "66",
                fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                cursor: nsecInput.trim() ? "pointer" : "default",
              }}
            >
              {showKey ? "Hide" : "Show"}
            </button>
          </div>
        </>
      )}

      {generateError && <InlineError>{generateError}</InlineError>}
      {inputError && <InlineError>{inputError}</InlineError>}

      {generatedActive && (
        <div style={{
          marginBottom: 12, padding: 16,
          background: T.amberDim, border: `1px solid ${T.amber}55`,
          borderRadius: T.r, textAlign: "left",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 8 }}>
            <span style={{ fontSize: 18, lineHeight: 1 }}>🔑</span>
            <span style={{ fontSize: 15, fontWeight: 800, color: T.text, fontFamily: T.sans }}>
              Save your recovery key
            </span>
          </div>
          <div style={{
            fontSize: 13, color: T.muted, fontFamily: T.sans,
            lineHeight: 1.55, marginBottom: 12,
          }}>
            This is the{" "}
            <span style={{ color: T.text, fontWeight: 700 }}>
              only key to your account and the money in it
            </span>. Chama never sees it and can't reset it — if you lose it,
            no one can get your account back. Keep it somewhere safe, like a
            password manager.
          </div>
          <div style={{
            fontSize: 11, color: T.text, fontFamily: T.mono,
            lineHeight: 1.55, wordBreak: "break-all",
            padding: 12, background: T.bg, border: `1px solid ${T.border}`,
            borderRadius: T.rs, marginBottom: 11,
          }}>
            {generatedNsec}
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <button
              onClick={handleCopyKey}
              style={{
                padding: "9px 14px", flexShrink: 0,
                background: copied ? T.greenDim : T.surface,
                border: `1px solid ${copied ? T.green : T.borderHi}`,
                borderRadius: T.rs, color: copied ? T.green : T.text,
                fontFamily: T.sans, fontSize: 12, fontWeight: 700,
                cursor: "pointer", transition: "all 0.15s",
              }}
            >
              {copied ? "Copied ✓" : "Copy key"}
            </button>
            <label style={{
              display: "flex", alignItems: "center", gap: 8,
              color: T.text, fontSize: 13, fontFamily: T.sans, fontWeight: 600,
              cursor: "pointer", userSelect: "none" as const,
            }}>
              <input
                type="checkbox"
                checked={backupConfirmed}
                onChange={(e) => setBackupConfirmed(e.target.checked)}
                style={{ accentColor: T.accent, width: 16, height: 16, cursor: "pointer" }}
              />
              I've saved it
            </label>
          </div>
        </div>
      )}

      {/* v2.5: minimalPaste (the returning-user box attached to "I'm a
          returning Chama citizen") drops the Continue button entirely —
          a valid paste auto-submits, and Enter also works — and the
          footer, so the user just pastes and is in. The Continue stays
          for the generation flow (where an explicit "I saved it" confirm
          is required) and the native sign-in. */}
      {!minimalPaste && (
        <button
          onClick={() => void handleSubmit()}
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
          {generatedActive ? "Continue with this key" : "Continue"}
        </button>
      )}
      {!minimalPaste && (
        <div style={{
          fontSize: 10, color: T.muted, fontFamily: T.sans,
          textAlign: "center", marginTop: 10, lineHeight: 1.5,
        }}>
          {generatedActive
            ? (isNative
                ? "Saved on this device, encrypted — but keep your own copy too, in case you lose the phone."
                : "Chama doesn't keep this for you — your saved copy is the only way back in.")
            : (isNative
                ? "Your recovery key stays on this device, encrypted in secure storage."
                : "Your recovery key stays in this browser.")}
        </div>
      )}
    </div>
  );
}

function InlineError({ children }: { children: string }) {
  return (
    <div style={{
      marginBottom: 8, padding: "8px 10px",
      background: T.redDim, border: `1px solid ${T.red}33`,
      borderRadius: T.rs, color: T.red,
      fontSize: 10, fontFamily: T.mono,
    }}>
      {children}
    </div>
  );
}
