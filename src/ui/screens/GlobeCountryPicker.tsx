import { useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { T } from "../theme.js";
import { BrandHeader } from "../components/BrandHeader.js";
import { GlobeHero } from "../components/GlobeHero.js";
import {
  getAllPickerCountries,
  GLOBE_MARKERS,
  type PickerCountry,
} from "../../communities/countries.js";
import {
  DEFAULT_COMMUNITY_SLUG,
  addCustomCommunity,
  getCommunityBySlug,
} from "../../communities/registry.js";
import { setPendingCommunityReport } from "../../communities/community-request.js";

// v2.6: the full-world "Hey Chama, where's home?" picker (PHILOSOPHY.md §6).
// A spinning globe hero + a searchable, full-world country list. Every country
// is tappable and lands on its OWN flag + currency + federation.
//
// The honest split (a flag is NOT a Chama): a country with a verified LOCAL
// federation + real arbiters (Kenya/Afribit+Bitsacco, US/GBF) lands the user
// straight in. Every other country gets the soft-landing — its real flag +
// currency on a default federation (BLF) — with honest copy ("no local Chama
// here yet") plus the channel to request one / become a leader. No user is
// ever made to think a ready local arbiter network exists when it doesn't.
//
// The picker runs BEFORE sign-in, so a "report / no Chama here" tap can't sign
// the request yet. Rather than erroring on the missing signer, we stash the
// report (setPendingCommunityReport) and land the user in sign-in; App's
// post-login effect publishes it the moment a signer exists. The friction
// becomes the "sign in to put yourself on the map" onboarding beat.

export function GlobeCountryPicker({ onSelect }: { onSelect: (slug: string) => void }) {
  const countries = useMemo(() => getAllPickerCountries(), []);
  const liveCountries = useMemo(
    () => countries.filter((c) => c.realChamas.length > 0),
    [countries],
  );
  const otherCountries = useMemo(
    () => countries.filter((c) => c.realChamas.length === 0),
    [countries],
  );
  const [query, setQuery] = useState("");
  // A country opened for disambiguation (>1 live Chama) or soft-landing.
  const [selected, setSelected] = useState<PickerCountry | null>(null);
  const [requestOpen, setRequestOpen] = useState(false);
  const [requestedChama, setRequestedChama] = useState("");
  const [requestNote, setRequestNote] = useState("");
  // v3.1 A3: optional federation-owner credential captured at community request.
  const [fedInvite, setFedInvite] = useState("");

  const q = query.trim().toLowerCase();
  const results = q
    ? countries.filter(
        (c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase() === q,
      )
    : [];
  const requestReady = requestedChama.trim().length > 0;

  // Both report forms (the country soft-landing and the main "Chama not
  // listed?" one) behave identically: stash the report, then advance into
  // sign-in. A tapped country lands on its own shell; the un-scoped main form
  // lands on Global · USD (the user can switch with "Change" later). The
  // signed publish happens post-login (App.tsx).
  const queueReportAndContinue = () => {
    const chama = requestedChama.trim();
    if (!chama) return;
    setPendingCommunityReport({
      requestedChama: chama,
      note: fedInvite.trim()
        ? `${requestNote}${requestNote.trim() ? "\n\n" : ""}Federation operator — invite + steward key: ${fedInvite.trim()}`
        : requestNote,
    });
    if (selected) selectDefault(selected);
    else onSelect(DEFAULT_COMMUNITY_SLUG);
  };

  const openCountry = (c: PickerCountry) => {
    if (c.realChamas.length === 1) {
      onSelect(c.realChamas[0]!.slug);
      return;
    }
    // >1 live Chama → disambiguate; 0 → honest soft-landing.
    setSelected(c);
    setRequestedChama(c.realChamas.length === 0 ? c.name : "");
  };

  // Land on a country's default community (its flag + currency on a default
  // federation). A generated shell isn't in the pre-seed registry, so persist
  // it (addCustomCommunity) before selecting so getCommunityBySlug resolves it
  // downstream; on any persistence failure, fall back to Global · USD so the
  // user is never stuck on the picker.
  const selectDefault = (c: PickerCountry) => {
    const dc = c.defaultCommunity;
    try {
      if (c.isGeneratedShell && !getCommunityBySlug(dc.slug) && dc.federationInvite) {
        addCustomCommunity({
          slug: dc.slug,
          displayName: dc.displayName,
          currency: dc.currency,
          country: dc.country,
          flagEmoji: dc.flagEmoji,
          federationInvite: dc.federationInvite,
          browserReliable: dc.browserReliable,
          languages: dc.languages,
          disambiguator: dc.disambiguator,
        });
      }
      onSelect(dc.slug);
    } catch {
      onSelect(DEFAULT_COMMUNITY_SLUG);
    }
  };

  const backToList = () => {
    setSelected(null);
    setRequestedChama("");
  };

  const requestProps = {
    requestedChama, setRequestedChama, requestNote, setRequestNote,
    fedInvite, setFedInvite,
    onSubmit: queueReportAndContinue, requestReady,
  };

  // ── Country detail: disambiguation (>1 live Chama) or soft-landing ──
  if (selected) {
    const multi = selected.realChamas.length > 1;
    return (
      <>
        <BrandHeader />
        <BackButton label="All countries" onClick={backToList} />
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, width: "100%", maxWidth: 380 }}>
          <span style={{ fontSize: 34, lineHeight: 1 }}>{selected.flag}</span>
          <div style={{ textAlign: "left" }}>
            <div style={{ fontSize: 22, fontWeight: 900, color: T.text, fontFamily: T.sans, lineHeight: 1.1 }}>
              {selected.name}
            </div>
            <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginTop: 2 }}>
              {multi ? "Choose your local federation" : `${selected.currency} · no local Chama yet`}
            </div>
          </div>
        </div>

        {multi ? (
          <div style={{ display: "grid", gap: 10, width: "100%", maxWidth: 380 }}>
            {selected.realChamas.map((c) => (
              <button
                key={c.slug}
                onClick={() => onSelect(c.slug)}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  gap: 12, padding: "13px 14px", borderRadius: T.r,
                  background: T.card, border: `1px solid ${T.border}`,
                  color: T.text, cursor: "pointer", textAlign: "left",
                }}
              >
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: "block", fontFamily: T.sans, fontSize: 14, fontWeight: 800 }}>
                    {c.disambiguator ?? c.displayName}
                  </span>
                  <span style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: T.mono, color: T.muted, fontSize: 10, marginTop: 3 }}>
                    <LiveDot /> {c.currency} · live local Chama
                  </span>
                </span>
                <span style={{ fontFamily: T.mono, color: T.accent, fontSize: 16, lineHeight: 1 }}>→</span>
              </button>
            ))}
          </div>
        ) : (
          <div style={{ width: "100%", maxWidth: 380, display: "grid", gap: 12 }}>
            <div style={{
              padding: "13px 14px", borderRadius: T.r,
              background: T.surface, border: `1px solid ${T.border}`,
              color: T.muted, fontFamily: T.sans, fontSize: 13, lineHeight: 1.55,
              textAlign: "left",
            }}>
              No local Chama in {selected.name} yet — no community leaders or
              arbiters here so far (an arbiter would be a stranger, far from
              you). You can trade now as{" "}
              <span style={{ color: T.text, fontWeight: 700 }}>
                {selected.flag} {selected.name} · {selected.currency}
              </span>{" "}
              and switch the moment a local Chama launches — or ask the arbiters
              to start one / step up as its leader below.
            </div>
            <button
              onClick={() => selectDefault(selected)}
              style={{
                width: "100%", padding: "15px", borderRadius: T.r,
                background: T.accent, border: "none", color: T.bg,
                fontFamily: T.sans, fontSize: 14, fontWeight: 800, cursor: "pointer",
              }}
            >
              Continue as {selected.flag} {selected.name} · {selected.currency} →
            </button>
            <div style={{
              fontFamily: T.mono, fontSize: 10, color: T.muted, letterSpacing: 0.3,
              textAlign: "left", marginTop: 2,
            }}>
              Want to run your country's Chama? Ask below — leader &amp; arbiter
              onboarding (with bonded, graduated trust) is coming.
            </div>
            <RequestForm {...requestProps} submitLabel={`Request a ${selected.name} Chama`} />
          </div>
        )}
      </>
    );
  }

  // ── Main: globe hero + searchable full-world list ──
  return (
    <>
      <BrandHeader />
      <div style={{ fontSize: 28, lineHeight: 1.1, color: T.text, fontFamily: T.sans, fontWeight: 900, marginBottom: 8 }}>
        Where's home?
      </div>
      <div style={{ maxWidth: 340, color: T.muted, fontFamily: T.sans, fontSize: 14, lineHeight: 1.6, marginBottom: 16 }}>
        Find your country — your currency and local payment methods come with
        it. You can change it anytime.
      </div>

      <div style={{ marginBottom: 18 }}>
        <GlobeHero size={186} markers={GLOBE_MARKERS} />
      </div>

      <div style={{ width: "100%", maxWidth: 380, marginBottom: 12 }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search 190+ countries…"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-label="Search countries"
          style={{
            width: "100%", boxSizing: "border-box", padding: "12px 14px",
            borderRadius: T.r, border: `1px solid ${T.border}`,
            background: T.surface, color: T.text, fontFamily: T.sans,
            fontSize: 14, outline: "none",
          }}
        />
      </div>

      {q ? (
        <>
          <SectionLabel>{`${results.length} ${results.length === 1 ? "match" : "matches"}`}</SectionLabel>
          <div style={{ display: "grid", gap: 8, width: "100%", maxWidth: 380 }}>
            {results.map((c) => (
              <CountryRow key={c.code} country={c} onTap={() => openCountry(c)} />
            ))}
            {results.length === 0 && (
              <div style={{
                padding: "16px", borderRadius: T.r, background: T.surface,
                border: `1px dashed ${T.border}`, color: T.muted,
                fontFamily: T.sans, fontSize: 13, textAlign: "center",
              }}>
                No country matches “{query}”. Try the request button below.
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          {liveCountries.length > 0 && (
            <>
              <SectionLabel accent>
                <LiveDot /> {`Live Chamas · ${liveCountries.length}`}
              </SectionLabel>
              <div style={{ display: "grid", gap: 8, width: "100%", maxWidth: 380, marginBottom: 18 }}>
                {liveCountries.map((c) => (
                  <CountryRow key={c.code} country={c} onTap={() => openCountry(c)} />
                ))}
              </div>
            </>
          )}
          <SectionLabel>Every country</SectionLabel>
          <div style={{ display: "grid", gap: 8, width: "100%", maxWidth: 380 }}>
            {otherCountries.map((c) => (
              <CountryRow key={c.code} country={c} onTap={() => openCountry(c)} />
            ))}
          </div>
        </>
      )}

      <div style={{ width: "100%", maxWidth: 380, marginTop: 16 }}>
        <button
          onClick={() => setRequestOpen(!requestOpen)}
          style={{
            width: "100%", padding: "10px 12px", borderRadius: T.rs,
            background: "transparent", border: `1px dashed ${T.border}`,
            color: T.muted, fontFamily: T.sans, fontSize: 12, fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Chama not listed? Request it here
        </button>
        {requestOpen && <RequestForm {...requestProps} />}
      </div>
    </>
  );
}

function CountryRow({ country, onTap }: { country: PickerCountry; onTap: () => void }) {
  const live = country.realChamas.length > 0;
  const subtitle = live
    ? country.realChamas.length > 1
      ? `${country.currency} · ${country.realChamas.length} Chamas`
      : country.currency
    : country.currency;
  return (
    <button
      onClick={onTap}
      style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: 12, padding: "12px 14px", borderRadius: T.r,
        background: T.card, border: `1px solid ${live ? T.green + "44" : T.border}`,
        color: T.text, cursor: "pointer", textAlign: "left",
        opacity: live ? 1 : 0.82,
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
        <span style={{ fontSize: 24, lineHeight: 1 }}>{country.flag}</span>
        <span style={{ minWidth: 0 }}>
          <span style={{
            display: "block", fontFamily: T.sans, fontSize: 14, fontWeight: 800,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>
            {country.name}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 5, fontFamily: T.mono, color: T.muted, fontSize: 10, marginTop: 2 }}>
            {live && <LiveDot />}
            {subtitle}
          </span>
        </span>
      </span>
      <span style={{ fontFamily: T.mono, color: live ? T.accent : T.muted, fontSize: 16, lineHeight: 1 }}>→</span>
    </button>
  );
}

function LiveDot() {
  return (
    <span style={{
      display: "inline-block", width: 6, height: 6, borderRadius: "50%",
      background: T.green, boxShadow: `0 0 6px ${T.green}aa`, flexShrink: 0,
    }} />
  );
}

function SectionLabel({ children, accent }: { children: ReactNode; accent?: boolean }) {
  return (
    <div style={{
      width: "100%", maxWidth: 380, textAlign: "left", margin: "2px 0 10px",
      color: accent ? T.green : T.muted, fontFamily: T.mono, fontSize: 10, fontWeight: 800,
      letterSpacing: 1, textTransform: "uppercase",
      display: "flex", alignItems: "center", gap: 6,
    }}>
      {children}
    </div>
  );
}

function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
  // Constrained to the same 380px content column as the cards below, so the
  // link sits at the column's left edge — not flung to the far edge of the
  // (centered) shell on a wide viewport.
  return (
    <div style={{ width: "100%", maxWidth: 380, marginBottom: 12, textAlign: "left" }}>
      <button
        onClick={onClick}
        style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          padding: "6px 10px", borderRadius: T.rs,
          background: T.surface, border: `1px solid ${T.border}`,
          color: T.muted, fontFamily: T.mono, fontSize: 10, cursor: "pointer",
        }}
      >
        <span style={{ fontSize: 12, lineHeight: 1 }}>←</span>
        {label}
      </button>
    </div>
  );
}

type RequestFormProps = {
  requestedChama: string;
  setRequestedChama: Dispatch<SetStateAction<string>>;
  requestNote: string;
  setRequestNote: Dispatch<SetStateAction<string>>;
  fedInvite: string;
  setFedInvite: Dispatch<SetStateAction<string>>;
  /** Stash the report + advance into sign-in (the signed publish is deferred
   *  to post-login — the picker has no signer). */
  onSubmit: () => void;
  requestReady: boolean;
  submitLabel?: string;
};

function RequestForm({
  requestedChama, setRequestedChama, requestNote, setRequestNote,
  fedInvite, setFedInvite,
  onSubmit, requestReady, submitLabel = "Send request",
}: RequestFormProps) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (requestReady) onSubmit();
      }}
      style={{
        marginTop: 10, padding: 12, borderRadius: T.r,
        background: T.surface, border: `1px solid ${T.border}`,
        display: "grid", gap: 10,
      }}
    >
      <input
        value={requestedChama}
        onChange={(event) => setRequestedChama(event.target.value)}
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
        onChange={(event) => setRequestNote(event.target.value)}
        placeholder="Optional note (e.g. “I can run this — make me a leader”)"
        rows={2}
        style={{
          width: "100%", boxSizing: "border-box", padding: "11px 12px",
          borderRadius: T.rs, border: `1px solid ${T.border}`,
          background: T.card, color: T.text, fontFamily: T.sans,
          fontSize: 13, outline: "none", resize: "vertical",
        }}
      />
      {/* v3.1 A3: federation-owner credential — the premier "proof of work" anchor path. */}
      <div style={{ display: "grid", gap: 5 }}>
        <div style={{ fontSize: 10.5, color: "#5AC8FA", fontFamily: T.mono, fontWeight: 800, letterSpacing: 0.5 }}>
          🏰 RUN YOUR OWN FEDERATION?
        </div>
        <input
          value={fedInvite}
          onChange={(event) => setFedInvite(event.target.value)}
          placeholder="Paste invite + steward key — the strongest anchor path (optional)"
          style={{
            width: "100%", boxSizing: "border-box", padding: "11px 12px",
            borderRadius: T.rs, border: `1px solid ${T.border}`,
            background: T.card, color: T.text, fontFamily: T.mono,
            fontSize: 12, outline: "none",
          }}
        />
      </div>
      <button
        type="submit"
        disabled={!requestReady}
        style={{
          width: "100%", padding: "11px 12px", borderRadius: T.rs,
          background: requestReady ? T.accent : T.surface,
          border: `1px solid ${requestReady ? T.accent : T.border}`,
          color: requestReady ? T.bg : T.muted,
          fontFamily: T.sans, fontSize: 13, fontWeight: 900,
          cursor: requestReady ? "pointer" : "default",
        }}
      >
        {submitLabel}
      </button>
    </form>
  );
}
