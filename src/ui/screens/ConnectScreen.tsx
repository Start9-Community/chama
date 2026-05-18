import { useState, lazy, Suspense } from "react";
import { Capacitor } from "@capacitor/core";
import { T } from "../theme.js";
import { NsecLogin } from "../panels/NsecLogin.js";
import { getSignInEnvironment, shouldOfferNIP46Signer } from "../sign-in-environment.js";

const QRCode = lazy(() => import("../QRCode.js"));

export function ConnectScreen({
  onConnect, onConnectNIP46, onConnectNsec, loading, error, nip46Uri, nip46Waiting,
}: {
  onConnect: () => void;
  onConnectNIP46: () => void;
  onConnectNsec: (nsec: string, remember: boolean) => void | Promise<void>;
  loading: boolean;
  error: string | null;
  nip46Uri?: string | null;
  nip46Waiting?: boolean;
}) {
  const isNative = Capacitor.isNativePlatform();
  const signInEnvironment = {
    ...getSignInEnvironment(),
    isNativePlatform: isNative,
  };
  const offerNIP46Signer = shouldOfferNIP46Signer(signInEnvironment);
  const [showAdvanced, setShowAdvanced] = useState(false);

  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", minHeight: "100vh", padding: "40px 24px",
      textAlign: "center",
      background: `radial-gradient(ellipse at 50% 0%, ${T.accent}08 0%, transparent 60%)`,
    }}>
      {/* v2.3 wordmark — the "chama." lockup with ring-as-c (SVG, transparent) */}
      <div style={{ marginBottom: 32 }}>
        <img
          src="/icons/chama-wordmark.svg"
          alt="Chama"
          style={{
            display: "block",
            margin: "0 auto 16px",
            height: 80,
            width: "auto",
            maxWidth: "90%",
            filter: "drop-shadow(0 0 32px #f7931a22)",
          }}
        />
        <div style={{
          fontSize: 10, color: T.muted, fontFamily: T.mono,
          letterSpacing: 3, textTransform: "uppercase",
        }}>
          Nostr · Fedimint · SSS
        </div>
      </div>

      {/* Friendly tagline */}
      <div style={{
        maxWidth: 300, fontSize: 14, color: T.muted, lineHeight: 1.8,
        fontFamily: T.sans, marginBottom: 32,
      }}>
        Pay bills with Bitcoin. Send money home.
        <br />
        <span style={{ color: T.text }}>Build your circular economy.</span>
      </div>

      {error && (
        <div style={{
          padding: "10px 16px", borderRadius: T.rs, marginBottom: 16,
          background: T.redDim, border: `1px solid ${T.red}33`,
          color: T.red, fontSize: 11, fontFamily: T.mono,
          maxWidth: 340, wordBreak: "break-word",
        }}>
          {error}
        </div>
      )}

      {/* NIP-46 QR code display (when waiting for signer) */}
      {nip46Uri && (
        <div style={{
          width: "100%", maxWidth: 340, padding: 20, marginBottom: 16,
          background: T.purpleDim, border: `1px solid ${T.purple}33`,
          borderRadius: T.r, textAlign: "center",
        }}>
          <div style={{ fontSize: 13, color: T.purple, fontFamily: T.sans, marginBottom: 14, fontWeight: 600 }}>
            Open your signer app and scan
          </div>
          <div style={{
            display: "flex", justifyContent: "center", marginBottom: 14,
            padding: 12, background: "#111118", borderRadius: 12,
          }}>
            <Suspense fallback={<div style={{ width: 200, height: 200 }} />}>
              <QRCode data={nip46Uri} size={200} fgColor="#a78bfa" />
            </Suspense>
          </div>
          <a href={nip46Uri} style={{
            display: "block", padding: "10px 12px", marginBottom: 10,
            background: T.surface, borderRadius: T.rs, border: `1px solid ${T.border}`,
            color: T.purple, fontFamily: T.mono, fontSize: 9,
            wordBreak: "break-all", lineHeight: 1.4, textDecoration: "none",
            maxHeight: 50, overflow: "hidden",
          }}>
            {nip46Uri.slice(0, 60)}...
          </a>
          <button onClick={() => navigator.clipboard?.writeText(nip46Uri)} style={{
            padding: "8px 20px", borderRadius: T.rs,
            background: T.surface, border: `1px solid ${T.border}`,
            color: T.muted, fontFamily: T.mono, fontSize: 10, cursor: "pointer",
          }}>Copy link</button>
          {nip46Waiting && (
            <div style={{
              marginTop: 12, fontSize: 10, color: T.purple, fontFamily: T.mono,
              animation: "pulse 2s ease-in-out infinite",
            }}>
              Waiting for your signer...
            </div>
          )}
        </div>
      )}

      {/* Main action buttons */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%", maxWidth: 320 }}>

        {/* Primary: nsec sign in (native) or Extension (desktop) */}
        {isNative ? (
          <NsecLogin onSubmit={onConnectNsec} />
        ) : (
          <button
            onClick={onConnect}
            disabled={loading}
            style={{
              width: "100%", padding: "16px", borderRadius: T.r,
              background: loading ? T.surface : T.accent,
              border: "none", color: loading ? T.muted : T.bg,
              fontFamily: T.sans, fontSize: 15, fontWeight: 700,
              cursor: loading ? "default" : "pointer",
              transition: "all 0.2s",
            }}
          >
            {loading ? "Connecting..." : "Sign in with Fedi or extension"}
          </button>
        )}

        {!isNative && !showAdvanced && (
          <button
            onClick={() => setShowAdvanced(true)}
            disabled={loading}
            style={{
              width: "100%", padding: "12px", borderRadius: T.r,
              background: T.surface,
              border: `1px solid ${T.border}`,
              color: T.text, fontFamily: T.sans, fontSize: 13, fontWeight: 650,
              cursor: loading ? "default" : "pointer",
              transition: "all 0.2s",
            }}
          >
            New here? Create a key
          </button>
        )}

        {/* Desktop: show nsec option as advanced */}
        {!isNative && (
          <>
            <div
              onClick={() => setShowAdvanced(!showAdvanced)}
              style={{
                fontSize: 11, color: T.muted, fontFamily: T.mono,
                cursor: "pointer", marginTop: 4, transition: "color 0.2s",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = T.text)}
              onMouseLeave={(e) => (e.currentTarget.style.color = T.muted)}
            >
              {showAdvanced ? "▲ Hide key options" : "▼ More sign-in options"}
            </div>
            {showAdvanced && (
              <>
                {offerNIP46Signer && !nip46Uri && (
                  <button
                    onClick={onConnectNIP46}
                    disabled={loading || nip46Waiting}
                    style={{
                      width: "100%", padding: "14px", borderRadius: T.r,
                      background: "transparent",
                      border: `1px solid ${T.border}`,
                      color: T.muted, fontFamily: T.sans, fontSize: 13, fontWeight: 600,
                      cursor: loading || nip46Waiting ? "default" : "pointer",
                      transition: "all 0.2s",
                    }}
                  >
                    {nip46Waiting ? "Waiting..." : "Use a signer app"}
                  </button>
                )}
                <NsecLogin onSubmit={onConnectNsec} defaultOpen />
              </>
            )}
          </>
        )}
      </div>

      {/* Footer */}
      <div style={{
        marginTop: 40, fontSize: 9, color: T.muted + "66", fontFamily: T.mono,
        lineHeight: 1.8, maxWidth: 280,
      }}>
        Your keys, your coins. No server. No custodian.
        <br />
        Powered by community trust + Bitcoin.
      </div>
    </div>
  );
}
