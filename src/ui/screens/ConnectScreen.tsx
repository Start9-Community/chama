import { useEffect, useState, lazy, Suspense, type ReactNode } from "react";
import { Capacitor } from "@capacitor/core";
import { T } from "../theme.js";
import { NsecLogin } from "../panels/NsecLogin.js";
import { BrandHeader } from "../components/BrandHeader.js";
import { GlobeCountryPicker } from "./GlobeCountryPicker.js";
import {
  getSignInEnvironment,
  isFediWebViewSignInEnvironment,
  shouldOfferNIP46Signer,
} from "../sign-in-environment.js";
import { getCommunityBySlug } from "../../communities/registry.js";
import {
  getUserCommunitySlugRaw,
  setUserCommunitySlug,
} from "../../communities/storage.js";

const QRCode = lazy(() => import("../QRCode.js"));

// v2.6: the orientation moment. A brand-new user (no home community yet)
// historically met "Choose your local market" cold — the app asked for a
// commitment before it said what it was. The clearest description of Chama
// (the four trade types) lived three taps deep inside Create. WelcomeIntro
// surfaces that "what is this, what can I do, why is it safe" answer once,
// before the picker, then flows straight into it. Browser-wide localStorage
// (pre-identity, no npub yet) so it fires once per device; "Change" on a
// returning account skips back to the picker, not here.
const INTRO_SEEN_KEY = "chama_intro_seen";

function readIntroSeen(): boolean {
  try {
    return typeof localStorage !== "undefined"
      && localStorage.getItem(INTRO_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

function markIntroSeen(): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(INTRO_SEEN_KEY, "1");
  } catch {
    // private mode / storage disabled — the intro just shows again next launch.
  }
}

// The four things you can do, in the user's words. Mirrors the Create
// wizard's trade-type cards (CreateForm) so the model a newcomer learns
// here is the exact model they act on later — no re-teaching. Tints are
// drawn from the theme palette (not the sacred buyer/seller/arbiter role
// hexes) purely for glanceable variety.
const INTRO_USE_CASES: { icon: string; title: string; blurb: string; tint: string }[] = [
  { icon: "⚡", title: "Exchange",            blurb: "Swap cash for sats with someone local",   tint: T.accent },
  { icon: "🧾", title: "Community Bill Pay",  blurb: "Pay a bill in exchange for sats",          tint: T.teal },
  { icon: "🏪", title: "Marketplace",         blurb: "Sell goods, services, or digital items",   tint: T.purple },
  { icon: "🤝", title: "Lending",             blurb: "Lend sats with clear repayment terms",     tint: T.green },
];

export function ConnectScreen({
  onConnect, onConnectNIP46, onConnectNsec, loading, error, nip46Uri, nip46Waiting,
}: {
  onConnect: () => void;
  onConnectNIP46: () => void;
  onConnectNsec: (nsec: string, remember: boolean, wasGenerated: boolean) => void | Promise<void>;
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
  const isFediWebView = isFediWebViewSignInEnvironment(signInEnvironment);
  const offerNIP46Signer = shouldOfferNIP46Signer(signInEnvironment);
  const [homeSlug, setHomeSlug] = useState<string | null>(() => getUserCommunitySlugRaw());
  // v2.6: gate the one-time orientation screen ahead of the market picker.
  const [introSeen, setIntroSeen] = useState<boolean>(() => readIntroSeen());
  const [showAdvanced, setShowAdvanced] = useState(false);
  // v2.5: the recovery-key paste box, revealed by "I'm a returning Chama
  // citizen" on the platforms where pasting is the right path — no hint detour,
  // no intermediate button.
  const [showRecoveryKey, setShowRecoveryKey] = useState(false);
  const [returningSignInAttempted, setReturningSignInAttempted] = useState(false);
  const homeCommunity = homeSlug ? getCommunityBySlug(homeSlug) : null;
  // NIP-07 browser extension (Alby, nos2x, …). Only meaningful in a desktop
  // browser — native shells and the Fedi WebView don't inject window.nostr.
  const hasNostrExtension = typeof window !== "undefined" && !!(window as any).nostr;

  // v2.5: device-aware "returning" sign-in.
  //   • Fedi      → the Fedi-provided signer (its own welcome-home button).
  //   • APK/Tauri → paste the recovery key (no browser extension possible).
  //   • desktop browser → use the NIP-07 extension; fall back to the clean
  //     paste box if there's no extension or it fails.
  const handleReturningSignIn = () => {
    if (isNative || !hasNostrExtension) {
      setShowRecoveryKey(true);
      return;
    }
    setReturningSignInAttempted(true);
    onConnect();
  };

  // Clean fallback: if the extension attempt errors out, just reveal the
  // attached paste box (no hint prose, no "more options" dig).
  useEffect(() => {
    if (!returningSignInAttempted || loading || !error) return;
    setShowRecoveryKey(true);
  }, [returningSignInAttempted, loading, error]);

  if (!homeSlug || !homeCommunity) {
    // First-ever launch on this device → orient before asking for a
    // commitment. Once dismissed (or for a returning account re-picking
    // a community), drop straight into the market picker.
    if (!introSeen) {
      return (
        <OnboardingShell>
          <WelcomeIntro
            onContinue={() => {
              markIntroSeen();
              setIntroSeen(true);
            }}
          />
        </OnboardingShell>
      );
    }
    return (
      <OnboardingShell>
        <GlobeCountryPicker
          onSelect={(slug) => {
            setUserCommunitySlug(slug);
            setHomeSlug(slug);
          }}
        />
      </OnboardingShell>
    );
  }

  return (
    <OnboardingShell>
      <BrandHeader />

      <div style={{
        maxWidth: 360, width: "100%", marginBottom: 18,
        padding: 14, borderRadius: T.r,
        background: T.surface, border: `1px solid ${T.border}`,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: 12,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <span style={{ fontSize: 24, lineHeight: 1 }}>{homeCommunity.flagEmoji}</span>
          <div style={{ minWidth: 0, textAlign: "left" }}>
            <div style={{ fontSize: 12, color: T.text, fontFamily: T.sans, fontWeight: 800 }}>
              {homeCommunity.displayName}
            </div>
            <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono }}>
              Your Chama
            </div>
          </div>
        </div>
        <button
          onClick={() => {
            setUserCommunitySlug("");
            setHomeSlug(null);
          }}
          style={{
            background: "transparent", border: `1px solid ${T.border}`,
            color: T.muted, borderRadius: T.rs, padding: "7px 10px",
            fontFamily: T.mono, fontSize: 10, cursor: "pointer",
            flexShrink: 0,
          }}
        >
          Change
        </button>
      </div>

      <div style={{
        maxWidth: 330, fontSize: 14, color: T.muted, lineHeight: 1.8,
        fontFamily: T.sans, marginBottom: 26,
      }}>
        Send money home. Earn with Community Bill Pay.
        <br />
        <span style={{ color: T.text }}>Trade locally with Bitcoin rails underneath.</span>
      </div>

      {error && <ErrorBox>{friendlySignInError(error)}</ErrorBox>}

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
            <Suspense fallback={<div style={{ width: 220, height: 220 }} />}>
              <QRCode data={nip46Uri} size={220} margin={4} />
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

      <div style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%", maxWidth: 360 }}>
        {isFediWebView ? (
          <FediOnlyConnectButton
            loading={loading}
            onConnect={onConnect}
          />
        ) : (
          <>
            <NsecLogin
              onSubmit={onConnectNsec}
              friendly
              friendlySecondary={{
                label: loading ? "Connecting..." : "I'm a returning Chama citizen",
                // v2.5: device-aware — desktop browser kicks the NIP-07
                // extension; APK/Tauri (and the no-extension / extension-
                // failure cases) drop the clean paste box in attached below.
                onClick: handleReturningSignIn,
                disabled: loading,
                tone: "accent",
              }}
            />

            {showRecoveryKey && (
              // The paste box, attached to "I'm a returning Chama citizen".
              // minimalPaste: just the field + Show; a valid paste (or Enter)
              // signs you in — no Continue button, no clutter.
              <NsecLogin
                onSubmit={onConnectNsec}
                defaultOpen
                allowCreate={false}
                minimalPaste
              />
            )}

            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              style={{
                width: "100%", padding: "10px", borderRadius: T.r,
                background: "transparent", border: "none",
                color: T.muted, fontFamily: T.mono, fontSize: 11,
                cursor: "pointer",
              }}
            >
              {showAdvanced ? "▲ Hide more sign-in options" : "▼ More sign-in options"}
            </button>

            {showAdvanced && (
              <>
                {hasNostrExtension && (
                  <button
                    onClick={onConnect}
                    disabled={loading}
                    style={{
                      width: "100%", padding: "14px", borderRadius: T.r,
                      background: "transparent",
                      border: `1px solid ${T.border}`,
                      color: T.text, fontFamily: T.sans, fontSize: 13, fontWeight: 600,
                      cursor: loading ? "default" : "pointer",
                    }}
                  >
                    {loading ? "Connecting..." : "Sign in with browser extension"}
                  </button>
                )}
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
                    }}
                  >
                    {nip46Waiting ? "Waiting..." : "Use a signer app"}
                  </button>
                )}
              </>
            )}
          </>
        )}
      </div>

      <div style={{
        marginTop: 34, fontSize: 9, color: T.muted + "66", fontFamily: T.mono,
        lineHeight: 1.8, maxWidth: 280,
      }}>
        Chama does not hold your funds.
        <br />
        Trade, save, and exchange locally with Bitcoin rails.
      </div>
    </OnboardingShell>
  );
}

function FediOnlyConnectButton({
  loading,
  onConnect,
}: {
  loading: boolean;
  onConnect: () => void;
}) {
  return (
    <div style={{ width: "100%", maxWidth: 360 }}>
      <button
        onClick={onConnect}
        disabled={loading}
        style={{
          width: "100%", padding: "16px", borderRadius: T.r,
          background: T.accent, border: "none", color: T.bg,
          fontFamily: T.sans, fontSize: 15, fontWeight: 800,
          cursor: loading ? "default" : "pointer",
        }}
      >
        {loading ? "Connecting..." : "Welcome home"}
      </button>
      <div style={{
        fontSize: 10, color: T.muted, fontFamily: T.sans,
        textAlign: "center", marginTop: 12, lineHeight: 1.5,
      }}>
        Chama uses the identity and wallet Fedi already gave you — just step in.
      </div>
    </div>
  );
}

function OnboardingShell({ children }: { children: ReactNode }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", minHeight: "100dvh", padding: "36px 18px",
      textAlign: "center",
      background: `linear-gradient(180deg, ${T.bg} 0%, ${T.surface} 46%, ${T.bg} 100%)`,
    }}>
      {children}
    </div>
  );
}

function WelcomeIntro({ onContinue }: { onContinue: () => void }) {
  return (
    <>
      <BrandHeader />

      <div style={{
        fontSize: 27, lineHeight: 1.12, color: T.text,
        fontFamily: T.sans, fontWeight: 900, marginBottom: 12,
        maxWidth: 360,
      }}>
        Trade bitcoin with your community
      </div>
      <div style={{
        maxWidth: 340, color: T.muted, fontFamily: T.sans,
        fontSize: 14, lineHeight: 1.6, marginBottom: 22,
      }}>
        Swap cash for sats, pay bills, sell, and lend — in your
        local currency. <span style={{ color: T.text }}>Chama never
        holds your money.</span>
      </div>

      <div style={{
        display: "grid", gap: 8, width: "100%", maxWidth: 380,
        marginBottom: 16,
      }}>
        {INTRO_USE_CASES.map(({ icon, title, blurb, tint }) => (
          <div
            key={title}
            style={{
              display: "flex", alignItems: "center", gap: 13,
              padding: "11px 13px", borderRadius: T.r,
              background: T.card, border: `1px solid ${T.border}`,
              textAlign: "left",
            }}
          >
            <span style={{
              flexShrink: 0,
              width: 38, height: 38, borderRadius: T.rs,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 19, lineHeight: 1,
              background: tint + "1a", border: `1px solid ${tint}44`,
            }}>
              {icon}
            </span>
            <span style={{ minWidth: 0 }}>
              <span style={{
                display: "block", fontFamily: T.sans,
                fontSize: 14, fontWeight: 800, color: T.text,
              }}>
                {title}
              </span>
              <span style={{
                display: "block", fontFamily: T.sans,
                fontSize: 12, color: T.muted, marginTop: 1, lineHeight: 1.35,
              }}>
                {blurb}
              </span>
            </span>
          </div>
        ))}
      </div>

      {/* The differentiator, stated where it reassures: every trade is
          2-of-3 escrow with a community arbiter, never custodied by us. */}
      <div style={{
        display: "flex", alignItems: "flex-start", gap: 11,
        width: "100%", maxWidth: 380, marginBottom: 24,
        padding: "12px 14px", borderRadius: T.r,
        background: T.accentDim, border: `1px solid ${T.accent}44`,
        textAlign: "left",
      }}>
        <span style={{ fontSize: 17, lineHeight: 1.2, flexShrink: 0 }}>🛡️</span>
        <span style={{
          fontFamily: T.sans, fontSize: 12, lineHeight: 1.5, color: T.text,
        }}>
          <span style={{ fontWeight: 800 }}>Protected by 2-of-3 escrow.</span>{" "}
          <span style={{ color: T.muted }}>
            Your sats release only when both sides agree — or a community
            arbiter steps in. Never held by Chama.
          </span>
        </span>
      </div>

      <button
        onClick={onContinue}
        style={{
          width: "100%", maxWidth: 380, padding: "16px",
          borderRadius: T.r, background: T.accent, border: "none",
          color: T.bg, fontFamily: T.sans, fontSize: 15, fontWeight: 800,
          cursor: "pointer",
        }}
      >
        Choose my market →
      </button>

      <div style={{
        marginTop: 14, fontSize: 10, color: T.muted, fontFamily: T.mono,
        letterSpacing: 0.4, lineHeight: 1.6, maxWidth: 300,
      }}>
        Non-custodial · Nostr-native · No bank, no sign-up
      </div>
    </>
  );
}

function ErrorBox({ children }: { children: string }) {
  return (
    <div style={{
      padding: "10px 16px", borderRadius: T.rs, marginBottom: 16,
      background: T.redDim, border: `1px solid ${T.red}33`,
      color: T.red, fontSize: 11, fontFamily: T.mono,
      maxWidth: 340, wordBreak: "break-word",
    }}>
      {children}
    </div>
  );
}

function InstructionBox({ children }: { children: string }) {
  return (
    <div style={{
      padding: "12px 14px", borderRadius: T.rs, marginBottom: 2,
      background: T.accentDim, border: `1px solid ${T.accent}55`,
      color: T.text, fontSize: 12, fontFamily: T.sans,
      lineHeight: 1.5,
    }}>
      {children}
    </div>
  );
}

function friendlySignInError(message: string): string {
  if (/No Nostr signer|NIP-07|open in Fedi|Amber|browser signer|No browser environment/i.test(message)) {
    return "We couldn't find a signer on this device. If you're returning with a recovery key, use More sign-in options below.";
  }
  return message;
}
