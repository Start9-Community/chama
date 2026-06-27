import { useMemo, useState, type ReactNode } from "react";
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
  isRealLocalChama,
} from "../../communities/registry.js";

// v2.6 / v4.1 "US-activation": the full-world "Hey Chama, where's home?" picker
// (PHILOSOPHY.md §6). A spinning globe hero + a searchable, full-world country
// list. Every country is tappable and lands on its OWN flag + currency + fed.
//
// THE TWO-GREEN-TIER RULE (the anchor — the old "no local Chama, an arbiter
// would be a stranger" dark landing nearly cost a real first trader). Never
// make a visitor feel they're standing in the dark. The honest split is kept
// in the WORDS, never in the presence/absence of light:
//   • ⚡ Live now    (green) — elected LOCAL arbiters (isRealLocalChama). Kenya.
//   • ✓ Available now (green) — backed by a native-verified G-Bot fed; the
//                    cabinet's global arbiters back every escrow, local arbiters
//                    coming. Effectively everywhere. NEVER claims a local Chama.
//   • Coming soon   (quiet, rare — still not red) — genuinely uncovered feds.
//
// The arbiter / "run your country's Chama" on-ramp moved OUT of onboarding to
// the blue Listings FAB (ArbiterApplyForm) — a leader pitch belongs where a
// self-selecting leader looks, not in every newcomer's first 10 seconds.

// Derive the user's OWN country from the device locale (privacy-clean: no
// geo-IP, no network call — just navigator.language(s)'s region subtag). We
// feature THAT one country, never a hardcoded VIP list: a fixed set reads as
// arbitrary and re-creates the exact "is *my* country in?" anxiety the green
// tiers exist to kill. "en-US" → US, "pt-BR" → BR, "zh-Hant-TW" → TW.
function localeCountryCode(): string | null {
  try {
    const nav = typeof navigator !== "undefined" ? navigator : null;
    if (!nav) return null;
    const tags = (nav.languages && nav.languages.length ? nav.languages : [nav.language])
      .filter(Boolean) as string[];
    for (const tag of tags) {
      const parts = tag.split("-");
      // Region is the last 2-letter subtag (after script/variants).
      for (let i = parts.length - 1; i >= 1; i--) {
        if (/^[A-Za-z]{2}$/.test(parts[i]!)) return parts[i]!.toUpperCase();
      }
    }
  } catch {
    /* older webview without navigator.languages — no featuring, picker still works */
  }
  return null;
}

export function GlobeCountryPicker({ onSelect }: { onSelect: (slug: string) => void }) {
  const countries = useMemo(() => getAllPickerCountries(), []);
  const liveCountries = useMemo(
    () => countries.filter((c) => c.availability === "live"),
    [countries],
  );
  // The user's own country, featured — but only when it's an "available" tier
  // (a live-tier home country is already prominent in the Live now group, so we
  // don't double-list it). Null when locale is unknown or the home country is
  // live/uncovered.
  const homeCountry = useMemo(() => {
    const code = localeCountryCode();
    if (!code) return null;
    const c = countries.find((x) => x.code === code);
    return c && c.availability === "available" ? c : null;
  }, [countries]);
  const featuredCodes = useMemo(
    () => new Set(homeCountry ? [homeCountry.code] : []),
    [homeCountry],
  );
  // The full searchable world, minus the rows already shown in the Live + the
  // featured home-country zone above (no duplicates).
  const restCountries = useMemo(
    () => countries.filter((c) => c.availability !== "live" && !featuredCodes.has(c.code)),
    [countries, featuredCodes],
  );

  const [query, setQuery] = useState("");
  // A country opened for disambiguation (≥2 chamas) or the green landing.
  const [selected, setSelected] = useState<PickerCountry | null>(null);

  const q = query.trim().toLowerCase();
  const results = q
    ? countries.filter(
        (c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase() === q,
      )
    : [];

  const openCountry = (c: PickerCountry) => {
    // N-chama drill-down: ≥2 named chamas (real OR available) → disambiguate,
    // exactly Kenya's path, now for any country. A single REAL local chama
    // opens straight through; a single available chama / bare shell lands on
    // the green "Available now" screen (one tap to Continue).
    if (c.chamas.length >= 2) {
      setSelected(c);
      return;
    }
    if (c.realChamas.length === 1) {
      onSelect(c.realChamas[0]!.slug);
      return;
    }
    setSelected(c);
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

  const backToList = () => setSelected(null);

  // ── Country detail: N-chama disambiguation (≥2 chamas) or the green landing ──
  if (selected) {
    const multi = selected.chamas.length >= 2;
    const comingSoon = selected.availability === "comingSoon";
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
            <div style={{ fontSize: 11, color: multi ? T.muted : T.green, fontFamily: T.mono, marginTop: 2 }}>
              {multi
                ? "Choose your Chama"
                : comingSoon
                  ? `${selected.currency} · coming soon`
                  : `${selected.currency} · available now`}
            </div>
          </div>
        </div>

        {multi ? (
          // The N-chama drill-down — all named chamas for the country, each
          // tier-tagged: a real elected-local Chama reads ⚡ "live local Chama";
          // a native-verified one reads ✓ "available now" (honest — no false
          // local-arbiter claim). Same path Kenya already uses, now for any N.
          <div style={{ display: "grid", gap: 10, width: "100%", maxWidth: 380 }}>
            {selected.chamas.map((c) => {
              const real = isRealLocalChama(c);
              return (
              <button
                key={c.slug}
                onClick={() => onSelect(c.slug)}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  gap: 12, padding: "13px 14px", borderRadius: T.r,
                  background: T.card, border: `1px solid ${real ? T.green + "44" : T.border}`,
                  color: T.text, cursor: "pointer", textAlign: "left",
                }}
              >
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: "block", fontFamily: T.sans, fontSize: 14, fontWeight: 800 }}>
                    {c.disambiguator ?? c.displayName}
                  </span>
                  <span style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: T.mono, color: T.muted, fontSize: 10, marginTop: 3 }}>
                    {real ? <LiveDot /> : <CheckDot />}
                    {c.currency} · {real ? "live local Chama" : "available now"}
                  </span>
                </span>
                <span style={{ fontFamily: T.mono, color: T.accent, fontSize: 16, lineHeight: 1 }}>→</span>
              </button>
              );
            })}
          </div>
        ) : (
          // The green landing — two greens, the words carry the distinction.
          // "Available now" never claims a local Chama; it states the route
          // works and the cabinet backs the trade. "Coming soon" stays calm
          // (still not red) and still lets the user in on the global fed.
          <div style={{ width: "100%", maxWidth: 380, display: "grid", gap: 12 }}>
            <div style={{
              padding: "14px 15px", borderRadius: T.r,
              background: `${T.green}12`, border: `1px solid ${T.green}44`,
              boxShadow: `0 0 0 3px ${T.green}10`,
              color: T.text, fontFamily: T.sans, fontSize: 13.5, lineHeight: 1.6,
              textAlign: "left",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, fontFamily: T.mono, fontWeight: 800, fontSize: 11, letterSpacing: 0.5, color: T.green }}>
                {comingSoon ? "○ Coming soon" : "✓ Available now"}
              </div>
              {comingSoon ? (
                <>
                  A local Chama in {selected.name} is coming. You can start
                  trading today as{" "}
                  <span style={{ fontWeight: 700 }}>
                    {selected.flag} {selected.name} · {selected.currency}
                  </span>{" "}
                  on Chama's global federation, backed by the cabinet's arbiters.
                </>
              ) : (
                <>
                  Trade {selected.name}'s sats now as{" "}
                  <span style={{ fontWeight: 700 }}>
                    {selected.flag} {selected.name} · {selected.currency}
                  </span>{" "}
                  — backed by Chama's global arbiters. Your own local Chama is
                  coming; switch to it the moment it launches.
                </>
              )}
            </div>
            <button
              onClick={() => selectDefault(selected)}
              style={{
                width: "100%", padding: "15px", borderRadius: T.r,
                background: T.green, border: "none", color: T.bg,
                fontFamily: T.sans, fontSize: 14, fontWeight: 800, cursor: "pointer",
              }}
            >
              Continue as {selected.flag} {selected.name} · {selected.currency} →
            </button>
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
                No country matches “{query}”. Check the spelling and try again.
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          {liveCountries.length > 0 && (
            <>
              <SectionLabel accent>
                <LiveDot /> {`Live now · ${liveCountries.length}`}
              </SectionLabel>
              <div style={{ display: "grid", gap: 8, width: "100%", maxWidth: 380, marginBottom: 18 }}>
                {liveCountries.map((c) => (
                  <CountryRow key={c.code} country={c} onTap={() => openCountry(c)} />
                ))}
              </div>
            </>
          )}
          {homeCountry && (
            <>
              <SectionLabel accent>
                <CheckDot /> Available now · your country
              </SectionLabel>
              <div style={{ display: "grid", gap: 8, width: "100%", maxWidth: 380, marginBottom: 18 }}>
                <CountryRow country={homeCountry} onTap={() => openCountry(homeCountry)} />
              </div>
            </>
          )}
          <SectionLabel>Every country</SectionLabel>
          <div style={{ display: "grid", gap: 8, width: "100%", maxWidth: 380 }}>
            {restCountries.map((c) => (
              <CountryRow key={c.code} country={c} onTap={() => openCountry(c)} />
            ))}
          </div>
        </>
      )}
    </>
  );
}

function CountryRow({ country, onTap }: { country: PickerCountry; onTap: () => void }) {
  const tier = country.availability;
  // Two greens: both "live" and "available" read green (you're in); only the
  // rare genuinely-uncovered "comingSoon" recedes — and even then, never red.
  const green = tier === "live" || tier === "available";
  const subtitle =
    tier === "live"
      ? country.realChamas.length > 1
        ? `${country.currency} · ${country.realChamas.length} Chamas`
        : country.currency
      : tier === "available"
        ? `${country.currency} · available now`
        : `${country.currency} · coming soon`;
  return (
    <button
      onClick={onTap}
      style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: 12, padding: "12px 14px", borderRadius: T.r,
        background: T.card, border: `1px solid ${green ? T.green + "44" : T.border}`,
        color: T.text, cursor: "pointer", textAlign: "left",
        opacity: green ? 1 : 0.82,
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
            {tier === "live" && <LiveDot />}
            {tier === "available" && <CheckDot />}
            {subtitle}
          </span>
        </span>
      </span>
      <span style={{ fontFamily: T.mono, color: green ? T.accent : T.muted, fontSize: 16, lineHeight: 1 }}>→</span>
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

// The "✓ Available now" mark — a calm green check, the second green. Distinct
// from the pulsing LiveDot so the two tiers read apart at a glance, but both
// unmistakably green (no darkness, ever).
function CheckDot() {
  return (
    <span style={{
      fontSize: 9, lineHeight: 1, color: T.green, fontWeight: 900, flexShrink: 0,
    }}>
      ✓
    </span>
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
