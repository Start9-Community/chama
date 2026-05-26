import { useMemo, useState, lazy, Suspense, type ReactNode } from "react";
import { Capacitor } from "@capacitor/core";
import { T } from "../theme.js";
import { NsecLogin } from "../panels/NsecLogin.js";
import {
  getSignInEnvironment,
  isFediWebViewSignInEnvironment,
  shouldOfferNIP46Signer,
} from "../sign-in-environment.js";
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
type RegionChoice = {
  id: RegionFilter;
  label: string;
  tint: string;
};
type RequestStatus = {
  state: "idle" | "sending" | "sent" | "error";
  message?: string;
};

const REGION_FILTERS: RegionChoice[] = [
  { id: "west", label: "West Africa", tint: T.amber },
  { id: "central", label: "Central Africa", tint: T.purple },
  { id: "east", label: "East Africa", tint: T.teal },
  { id: "global", label: "Global", tint: T.accent },
];
// Base globe asset: Pixabay "World, Globe, Africa", stored locally for offline/native onboarding.
const AFRICA_GLOBE_SRC = "/icons/africa-globe-base.png";

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
  const isFediWebView = isFediWebViewSignInEnvironment(signInEnvironment);
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
        Send money home. Earn with Community Bill Pay.
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
              friendlySecondary={!isNative ? {
                label: loading ? "Connecting..." : "Use Fedi or browser signer",
                onClick: onConnect,
                disabled: loading,
                tone: "accent",
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
        {loading ? "Connecting..." : "Continue with Fedi"}
      </button>
      <div style={{
        fontSize: 10, color: T.muted, fontFamily: T.sans,
        textAlign: "center", marginTop: 12, lineHeight: 1.5,
      }}>
        Chama will use the signer and wallet already provided by Fedi.
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
        src="/icons/chama-woven-trust-lockup-horizontal.svg?v=0.9.4"
        alt="Chama"
        style={{
          display: "block",
          margin: "0 auto 18px",
          width: "min(78vw, 300px)",
          height: "auto",
          maxWidth: "100%",
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
  const [region, setRegion] = useState<RegionFilter | null>(null);
  const [selectedCountryKey, setSelectedCountryKey] = useState<string | null>(null);
  const [requestOpen, setRequestOpen] = useState(false);
  const [requestedChama, setRequestedChama] = useState("");
  const [requestNote, setRequestNote] = useState("");
  const [requestStatus, setRequestStatus] = useState<RequestStatus>({ state: "idle" });
  const selectedRegion = REGION_FILTERS.find((r) => r.id === region) ?? null;
  const visible = region
    ? communities
        .filter((c) => regionForCommunity(c) === region)
        .sort((a, b) => {
          if (a.country === null && b.country !== null) return -1;
          if (a.country !== null && b.country === null) return 1;
          return countryLabel(a).localeCompare(countryLabel(b));
        })
    : [];
  const countryChoices = countryChoicesForCommunities(visible);
  const selectedCountryChoice = selectedCountryKey
    ? countryChoices.find((choice) => choice.key === selectedCountryKey) ?? null
    : null;
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
        Send money home. Earn with Community Bill Pay. Trade locally.
      </div>

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
        gap: 8, width: "100%", maxWidth: 420, marginBottom: 12,
      }}>
        {REGION_FILTERS.map(({ id, label, tint }) => {
          const active = region === id;
          return (
            <button
              key={id}
              onClick={() => {
                setRegion(id);
                setSelectedCountryKey(null);
              }}
              aria-pressed={active}
              style={{
                minHeight: 112,
                padding: "10px 8px", borderRadius: T.rs,
                background: active ? tint + "18" : T.surface,
                border: `1px solid ${active ? tint + "88" : T.border}`,
                color: active ? T.text : T.muted,
                fontFamily: T.mono, fontSize: 10, fontWeight: 800,
                cursor: "pointer",
                display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center", gap: 8,
              }}
            >
              <MiniGlobe region={id} active={active} tint={tint} />
              <span style={{ lineHeight: 1.2 }}>{label}</span>
            </button>
          );
        })}
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

      {region && (
        <div style={{
          width: "100%", maxWidth: 380,
          animation: "fadeIn 0.18s ease-out",
        }}>
          <div style={{
            textAlign: "left", margin: "2px 0 10px",
            color: selectedRegion?.tint ?? T.accent,
            fontFamily: T.mono, fontSize: 10, fontWeight: 800,
            letterSpacing: 1, textTransform: "uppercase",
          }}>
            {selectedRegion?.label}
          </div>
          {selectedCountryChoice && selectedCountryChoice.communities.length > 1 && (
            <button
              onClick={() => setSelectedCountryKey(null)}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                marginBottom: 10, padding: "6px 9px", borderRadius: T.rs,
                background: T.surface, border: `1px solid ${T.border}`,
                color: T.muted, fontFamily: T.mono, fontSize: 10,
                cursor: "pointer",
              }}
            >
              <span style={{ fontSize: 12, lineHeight: 1 }}>←</span>
              {selectedCountryChoice.label}
            </button>
          )}
          <div style={{ display: "grid", gap: 10, width: "100%" }}>
            {(selectedCountryChoice?.communities ?? countryChoices).map((choice) => {
              let countryChoice: CountryChoice | null = null;
              let community: Community;
              if (isCommunityChoice(choice)) {
                community = choice;
              } else {
                countryChoice = choice;
                community = choice.communities[0]!;
              }
              const hasRoutes = countryChoice !== null && countryChoice.communities.length > 1;
              const title = countryChoice === null
                ? community.disambiguator ?? countryLabel(community)
                : countryChoice.label;
              const subtitle = countryChoice === null
                ? community.displayName
                : hasRoutes
                  ? `${countryChoice.communities.length} Chamas`
                  : community.disambiguator
                    ? `${community.currency} · ${community.disambiguator}`
                    : community.currency;
              return (
                <button
                  key={countryChoice ? countryChoice.key : community.slug}
                  onClick={() => {
                    if (hasRoutes && countryChoice) {
                      setSelectedCountryKey(countryChoice.key);
                      return;
                    }
                    onSelect(community.slug);
                  }}
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
                        {title}
                      </span>
                      <span style={{
                        display: "block", fontFamily: T.mono,
                        color: T.muted, fontSize: 10, marginTop: 2,
                      }}>
                        {subtitle}
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
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

interface CountryChoice {
  key: string;
  label: string;
  flagEmoji: string;
  communities: Community[];
}

function countryChoicesForCommunities(communities: Community[]): CountryChoice[] {
  const choices: CountryChoice[] = [];
  const byKey = new Map<string, CountryChoice>();
  for (const community of communities) {
    const key = community.country ?? community.slug;
    let choice = byKey.get(key);
    if (!choice) {
      choice = {
        key,
        label: community.pickerLabel ?? countryLabel(community),
        flagEmoji: community.flagEmoji,
        communities: [],
      };
      byKey.set(key, choice);
      choices.push(choice);
    }
    choice.communities.push(community);
  }
  for (const choice of choices) {
    choice.communities.sort(compareCommunityRoutes);
  }
  return choices;
}

function compareCommunityRoutes(a: Community, b: Community): number {
  const byLabel = (a.disambiguator ?? a.displayName).localeCompare(
    b.disambiguator ?? b.displayName,
    undefined,
    { sensitivity: "base" },
  );
  if (byLabel !== 0) return byLabel;
  return a.slug.localeCompare(b.slug, undefined, { sensitivity: "base" });
}

function isCommunityChoice(choice: Community | CountryChoice): choice is Community {
  return "slug" in choice;
}

function MiniGlobe({
  region,
  active,
  tint,
}: {
  region: RegionFilter;
  active: boolean;
  tint: string;
}) {
  const isGlobal = region === "global";
  const highlightPath = regionHighlightPath(region);
  const clipId = `africa-globe-clip-${region}`;
  return (
    <svg
      viewBox="0 0 100 100"
      aria-hidden="true"
      style={{
        width: 68,
        height: 68,
        display: "block",
        flexShrink: 0,
        filter: active ? `drop-shadow(0 0 10px ${tint}55)` : "none",
      }}
    >
      <defs>
        <clipPath id={clipId}>
          <circle cx="50" cy="50" r="46" />
        </clipPath>
      </defs>
      <circle cx="50" cy="50" r="47" fill={active ? "#102a3f" : "#0c1e2c"} />
      <g clipPath={`url(#${clipId})`}>
        <image
          href={AFRICA_GLOBE_SRC}
          x="0"
          y="0"
          width="100"
          height="100"
          preserveAspectRatio="xMidYMid slice"
          opacity="0.92"
          style={{ filter: active ? "saturate(0.95) brightness(0.9)" : "saturate(0.8) brightness(0.78)" }}
        />
        <circle cx="50" cy="50" r="47" fill="#071018" opacity={isGlobal ? 0.02 : active ? 0.08 : 0.18} />
        {!isGlobal && (
          <>
            <path
              d={highlightPath}
              fill="#ff3b30"
              opacity="0.9"
            />
            <path
              d={highlightPath}
              fill="none"
              stroke="#fff7"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </>
        )}
        <circle cx="33" cy="26" r="17" fill="#ffffff22" />
      </g>
      <circle cx="50" cy="50" r="46" fill="none" stroke={active ? tint : T.borderHi} strokeWidth="2.2" />
      <circle cx="50" cy="50" r="42" fill="none" stroke="#ffffff22" strokeWidth="1" />
    </svg>
  );
}

function regionHighlightPath(region: RegionFilter): string {
  if (region === "west") {
    return "M29 43 C33 38 42 38 48 42 C46 47 46 51 49 55 C45 58 42 62 41 67 C35 65 30 60 27 54 C25 49 26 45 29 43 Z";
  }
  if (region === "east") {
    return "M55 43 C62 44 68 48 76 53 C72 56 68 60 67 65 C65 70 60 73 56 69 C57 63 56 58 53 53 C54 49 55 46 55 43 Z";
  }
  if (region === "central") {
    return "M42 53 C48 50 56 51 61 56 C61 62 55 67 48 66 C42 65 39 59 42 53 Z";
  }
  return "";
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
  return community.displayName.replace(/\s(?:·|-)\s[A-Z]{3}$/, "");
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
