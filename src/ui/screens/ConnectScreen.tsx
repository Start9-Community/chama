import { useMemo, useState, lazy, Suspense, type ReactNode } from "react";
import { Capacitor } from "@capacitor/core";
import { T } from "../theme.js";
import { NsecLogin } from "../panels/NsecLogin.js";
import { getSignInEnvironment, shouldOfferNIP46Signer } from "../sign-in-environment.js";
import {
  CENTRAL_AFRICA_COUNTRY_CODES,
  EAST_AFRICA_COUNTRY_CODES,
  WEST_AFRICA_COUNTRY_CODES,
  getCommunityBySlug,
  getPickerCommunities,
  type Community,
} from "../../communities/registry.js";
import {
  getUserCommunitySlugRaw,
  setUserCommunitySlug,
} from "../../communities/storage.js";
import { sendCommunityRequestToGlobalArbiters } from "../../communities/community-request.js";

const QRCode = lazy(() => import("../QRCode.js"));
type RegionFilter = "east" | "west" | "central" | "global";
type RequestStatus = {
  state: "idle" | "sending" | "sent" | "error";
  message?: string;
};

const REGION_FILTERS: Array<{ id: RegionFilter; label: string }> = [
  { id: "east", label: "East Africa" },
  { id: "west", label: "West Africa" },
  { id: "central", label: "Central Africa" },
  { id: "global", label: "Global" },
];

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
  const [homeSlug, setHomeSlug] = useState<string | null>(() => getUserCommunitySlugRaw());
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showRecoveryKey, setShowRecoveryKey] = useState(false);
  const homeCommunity = homeSlug ? getCommunityBySlug(homeSlug) : null;

  if (!homeSlug || !homeCommunity) {
    return (
      <OnboardingShell>
        <CountryChamaStep
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
        Send money home. Earn with Bill Pay.
        <br />
        <span style={{ color: T.text }}>Trade locally with Bitcoin rails underneath.</span>
      </div>

      {error && <ErrorBox>{error}</ErrorBox>}

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

      <div style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%", maxWidth: 360 }}>
        <NsecLogin
          onSubmit={onConnectNsec}
          friendly
          friendlySecondary={!isNative ? {
            label: loading ? "Connecting..." : "Use Fedi or browser signer",
            onClick: onConnect,
            disabled: loading,
          } : undefined}
        />

        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          style={{
            width: "100%", padding: "10px", borderRadius: T.r,
            background: "transparent", border: "none",
            color: T.muted, fontFamily: T.mono, fontSize: 11,
            cursor: "pointer",
          }}
        >
          {showAdvanced ? "▲ Hide power-user options" : "▼ Power-user options"}
        </button>

        {showAdvanced && (
          <>
            <button
              onClick={() => setShowRecoveryKey(!showRecoveryKey)}
              style={{
                width: "100%", padding: "14px", borderRadius: T.r,
                background: T.surface,
                border: `1px solid ${T.border}`,
                color: T.text,
                fontFamily: T.sans, fontSize: 13, fontWeight: 700,
                cursor: "pointer",
              }}
            >
              {showRecoveryKey ? "Hide recovery key entry" : "Use a Chama recovery key"}
            </button>
            {showRecoveryKey && <NsecLogin onSubmit={onConnectNsec} defaultOpen />}
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
      </div>

      <div style={{
        marginTop: 34, fontSize: 9, color: T.muted + "66", fontFamily: T.mono,
        lineHeight: 1.8, maxWidth: 280,
      }}>
        Your keys, your coins. No custodian.
        <br />
        Community trust + Bitcoin settlement.
      </div>
    </OnboardingShell>
  );
}

function OnboardingShell({ children }: { children: ReactNode }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", minHeight: "100vh", padding: "36px 18px",
      textAlign: "center",
      background: `linear-gradient(180deg, ${T.bg} 0%, #0d0d14 46%, ${T.bg} 100%)`,
    }}>
      {children}
    </div>
  );
}

function BrandHeader() {
  return (
    <div style={{ marginBottom: 24 }}>
      <img
        src="/icons/chama-wordmark.svg"
        alt="Chama"
        style={{
          display: "block",
          margin: "0 auto 14px",
          height: 76,
          width: "auto",
          maxWidth: "90%",
          filter: "drop-shadow(0 0 32px #f7931a22)",
        }}
      />
      <div style={{
        fontSize: 10, color: T.muted, fontFamily: T.mono,
        letterSpacing: 3, textTransform: "uppercase",
      }}>
        local money, bitcoin rails
      </div>
    </div>
  );
}

function CountryChamaStep({ onSelect }: { onSelect: (slug: string) => void }) {
  const communities = useMemo(() => getPickerCommunities(), []);
  const [region, setRegion] = useState<RegionFilter>("east");
  const [requestOpen, setRequestOpen] = useState(false);
  const [requestedChama, setRequestedChama] = useState("");
  const [requestNote, setRequestNote] = useState("");
  const [requestStatus, setRequestStatus] = useState<RequestStatus>({ state: "idle" });
  const visible = communities
    .filter((c) => regionForCommunity(c) === region)
    .sort((a, b) => {
      if (a.country === null && b.country !== null) return -1;
      if (a.country !== null && b.country === null) return 1;
      return countryLabel(a).localeCompare(countryLabel(b));
    });
  const requestReady = requestStatus.state !== "sending" && requestedChama.trim().length > 0;

  const sendCommunityRequest = async () => {
    setRequestStatus({ state: "sending" });
    try {
      const result = await sendCommunityRequestToGlobalArbiters({
        requestedChama,
        note: requestNote,
      });
      setRequestedChama("");
      setRequestNote("");
      setRequestStatus({
        state: "sent",
        message: `Request sent to ${result.sent} Chama arbiters.`,
      });
    } catch (e) {
      setRequestStatus({
        state: "error",
        message: communityRequestErrorMessage(e),
      });
    }
  };

  return (
    <>
      <BrandHeader />
      <div style={{
        fontSize: 28, lineHeight: 1.1, color: T.text,
        fontFamily: T.sans, fontWeight: 900, marginBottom: 10,
      }}>
        Where is your Chama?
      </div>
      <div style={{
        maxWidth: 350, color: T.muted, fontFamily: T.sans,
        fontSize: 14, lineHeight: 1.7, marginBottom: 20,
      }}>
        Send money home. Earn with Bill Pay. Trade locally.
      </div>

      <div style={{
        display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
        gap: 8, width: "100%", maxWidth: 360, marginBottom: 12,
      }}>
        {REGION_FILTERS.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setRegion(id)}
            style={{
              padding: "9px 8px", borderRadius: T.rs,
              background: region === id ? T.accentDim : T.surface,
              border: `1px solid ${region === id ? T.accent + "66" : T.border}`,
              color: region === id ? T.accent : T.muted,
              fontFamily: T.mono, fontSize: 10, fontWeight: 800,
              cursor: "pointer",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div style={{ width: "100%", maxWidth: 380, marginBottom: 12 }}>
        <button
          onClick={() => {
            setRequestOpen(!requestOpen);
            setRequestStatus({ state: "idle" });
          }}
          style={{
            width: "100%", padding: "10px 12px", borderRadius: T.rs,
            background: "transparent", border: `1px dashed ${T.border}`,
            color: T.muted, fontFamily: T.sans, fontSize: 12, fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Chama not listed? Request it here
        </button>

        {requestOpen && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (requestStatus.state === "sending") return;
              void sendCommunityRequest();
            }}
            style={{
              marginTop: 10, padding: 12, borderRadius: T.r,
              background: T.surface, border: `1px solid ${T.border}`,
              display: "grid", gap: 10,
            }}
          >
            <input
              value={requestedChama}
              onChange={(event) => {
                setRequestedChama(event.target.value);
                if (requestStatus.state !== "sending") setRequestStatus({ state: "idle" });
              }}
              placeholder="Country or Chama"
              autoComplete="country-name"
              style={{
                width: "100%", boxSizing: "border-box", padding: "11px 12px",
                borderRadius: T.rs, border: `1px solid ${T.border}`,
                background: T.card, color: T.text, fontFamily: T.sans,
                fontSize: 13, outline: "none",
              }}
            />
            <textarea
              value={requestNote}
              onChange={(event) => {
                setRequestNote(event.target.value);
                if (requestStatus.state !== "sending") setRequestStatus({ state: "idle" });
              }}
              placeholder="Optional note"
              rows={2}
              style={{
                width: "100%", boxSizing: "border-box", padding: "11px 12px",
                borderRadius: T.rs, border: `1px solid ${T.border}`,
                background: T.card, color: T.text, fontFamily: T.sans,
                fontSize: 13, outline: "none", resize: "vertical",
              }}
            />
            <button
              type="submit"
              disabled={!requestReady}
              style={{
                width: "100%", padding: "11px 12px", borderRadius: T.rs,
                background: requestReady ? T.accent : T.surface,
                border: `1px solid ${requestReady ? T.accent : T.border}`,
                color: requestReady ? T.bg : T.muted,
                fontFamily: T.sans,
                fontSize: 13, fontWeight: 900,
                cursor: requestReady ? "pointer" : "default",
              }}
            >
              {requestStatus.state === "sending" ? "Sending..." : "Send request"}
            </button>
            {requestStatus.message && (
              <div style={{
                color: requestStatus.state === "sent" ? T.green : T.red,
                fontFamily: T.mono, fontSize: 10, lineHeight: 1.5,
                textAlign: "left",
              }}>
                {requestStatus.message}
              </div>
            )}
          </form>
        )}
      </div>

      <div style={{
        display: "grid", gap: 10, width: "100%", maxWidth: 380,
      }}>
        {visible.map((community) => (
          <button
            key={community.slug}
            onClick={() => onSelect(community.slug)}
            style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              gap: 12, padding: "13px 14px", borderRadius: T.r,
              background: T.card, border: `1px solid ${T.border}`,
              color: T.text, cursor: "pointer", textAlign: "left",
            }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
              <span style={{ fontSize: 26, lineHeight: 1 }}>{community.flagEmoji}</span>
              <span style={{ minWidth: 0 }}>
                <span style={{
                  display: "block", fontFamily: T.sans,
                  fontSize: 14, fontWeight: 800,
                }}>
                  {countryLabel(community)}
                </span>
                <span style={{
                  display: "block", fontFamily: T.mono,
                  color: T.muted, fontSize: 10, marginTop: 2,
                }}>
                  {community.currency}
                </span>
              </span>
            </span>
            <span style={{
              fontFamily: T.mono, color: T.accent,
              fontSize: 16, lineHeight: 1,
            }}>
              →
            </span>
          </button>
        ))}
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

function countryLabel(community: Community): string {
  if (community.country === "TZ") return "Tanzania";
  if (community.country === "KE") return "Kenya";
  if (community.country === "SN") return "Senegal";
  return community.displayName.replace(/\s·\s[A-Z]{3}$/, "");
}

function regionForCommunity(community: Community): RegionFilter {
  if (community.country && (EAST_AFRICA_COUNTRY_CODES as readonly string[]).includes(community.country)) return "east";
  if (community.country && (WEST_AFRICA_COUNTRY_CODES as readonly string[]).includes(community.country)) return "west";
  if (community.country && (CENTRAL_AFRICA_COUNTRY_CODES as readonly string[]).includes(community.country)) return "central";
  return "global";
}

function communityRequestErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/No Nostr signer|NIP-07|browser environment|Extension does not support/i.test(message)) {
    return "Use Fedi, Amber, or a browser signer first so the arbiters know who sent it.";
  }
  return message || "Could not send the Chama request. Try again in a moment.";
}
