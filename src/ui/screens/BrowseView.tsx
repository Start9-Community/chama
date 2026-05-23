import { useMemo, useState } from "react";
import { type EscrowState } from "../../escrow-engine/types.js";
import { getPickerCommunities, getCommunityBySlug, type Community } from "../../communities/registry.js";
import { T, BROWSE_CATS, inputStyle } from "../theme.js";
import { TradeCard } from "../components/TradeCard.js";
import { LoadTradeInput } from "../components/LoadTradeInput.js";

// Browse tab content — category filters, collapsed Chama selector, and card list.
// Per PHILOSOPHY.md §2.3, the community pills are the user's identity
// affordance: tapping one updates chama_community, switches/joins the
// backing federation. v0.1.87 retired the "All communities" pill and
// the per-community filter — pills are identity-only now.
//
// v0.2.0 item 4: two-section layout per chama_browse_amber_tint_sorted.
// Matching listings (on the user's active route) render first as normal
// cards; non-matching listings render below an "N LISTINGS ON OTHER
// ROUTES" divider with amber tint. Tapping a non-matching listing
// triggers the listing-tap dispatch in App.tsx (silent re-init when
// balance==0; destroy-confirm modal when balance>0).
export function BrowseView({
  browseCategory, setBrowseCategory,
  browseCommunity, onSelectCommunity,
  matchingListings, nonMatchingListings,
  fedimintJoined, pubkey,
  isFirstTime, onPasteCustomInvite,
  onOpenEscrow, onLoadById,
}: {
  browseCategory: string;
  setBrowseCategory: (s: string) => void;
  browseCommunity: string;
  onSelectCommunity: (slug: string) => void;
  matchingListings: EscrowState[];
  nonMatchingListings: EscrowState[];
  fedimintJoined: boolean;
  pubkey: string;
  isFirstTime: boolean;
  onPasteCustomInvite: (invite: string) => void | Promise<void>;
  onOpenEscrow: (id: string) => void;
  onLoadById: (id: string) => void | Promise<void>;
}) {
  const pickerCommunities = useMemo(
    () => [...getPickerCommunities()].sort(compareBrowseCommunities),
    [],
  );
  const [showCommunityPicker, setShowCommunityPicker] = useState(false);
  const [showAdvancedTools, setShowAdvancedTools] = useState(false);
  const [customInviteInput, setCustomInviteInput] = useState("");

  const totalListings = matchingListings.length + nonMatchingListings.length;
  const homeCommunity = getCommunityBySlug(browseCommunity);

  return (
    <div style={{ padding: 16 }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        marginBottom: 14,
        gap: 10,
      }}>
        <div style={{
          fontSize: 12, color: T.muted, fontFamily: T.mono, flexShrink: 0,
        }}>
          {totalListings === 0
            ? "No listings yet"
            : (
              <>
                <span style={{ color: T.text, fontWeight: 700 }}>{totalListings}</span>
                {totalListings === 1 ? " listing" : " listings"}
                {matchingListings.length > 0 && (
                  <>
                    {" · "}
                    <span style={{ color: T.text, fontWeight: 700 }}>{matchingListings.length}</span>
                    {" on your Chama"}
                  </>
                )}
              </>
            )}
        </div>
        {homeCommunity && (
          <button
            title={homeCommunity.displayName}
            onClick={() => setShowCommunityPicker((v) => !v)}
            style={{
              padding: "4px 10px", borderRadius: 14,
              background: T.surface, border: `1px solid ${T.border}`,
              fontFamily: T.mono, fontSize: 11,
              display: "flex", alignItems: "center", gap: 6,
              color: T.text, cursor: "pointer", minWidth: 0,
            }}
          >
            <span style={{ fontSize: 14, lineHeight: 1 }}>{homeCommunity.flagEmoji}</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {homeCommunity.disambiguator ?? homeCommunity.displayName}
            </span>
            <span style={{ color: T.muted, fontSize: 9 }}>{showCommunityPicker ? "▲" : "▼"}</span>
          </button>
        )}
      </div>

      {/* Category filter pills */}
      <div style={{
        display: "flex", gap: 6, marginBottom: 12,
        overflowX: "auto",
        scrollbarWidth: "none" as const,
        WebkitOverflowScrolling: "touch" as const,
        paddingBottom: 2,
      }}>
        {BROWSE_CATS.map(c => {
          const active = browseCategory === c.id;
          return (
            <button
              key={c.id}
              onClick={() => setBrowseCategory(c.id)}
              style={{
                flexShrink: 0,
                padding: "7px 13px", borderRadius: 18,
                background: active ? T.accentDim : T.surface,
                border: `1px solid ${active ? T.accent + "66" : T.border}`,
                color: active ? T.accent : T.muted,
                fontFamily: T.mono, fontSize: 11, fontWeight: 600,
                cursor: "pointer", transition: "all 0.15s",
                whiteSpace: "nowrap" as const,
                letterSpacing: 0.2,
              }}
            >
              {c.i ? c.i + " " : ""}{c.l}
            </button>
          );
        })}
      </div>

      {showCommunityPicker && (
        <div style={{
          display: "flex", gap: 6, marginBottom: 12,
          overflowX: "auto",
          scrollbarWidth: "none" as const,
          WebkitOverflowScrolling: "touch" as const,
          paddingBottom: 2,
        }}>
          {pickerCommunities.map(c => {
            const active = browseCommunity === c.slug;
            return (
              <button
                key={c.slug}
                onClick={() => {
                  setShowCommunityPicker(false);
                  onSelectCommunity(c.slug);
                }}
                style={{
                  flexShrink: 0,
                  padding: "7px 13px", borderRadius: 18,
                  background: active ? T.tealDim : T.surface,
                  border: `1px solid ${active ? T.teal + "66" : T.border}`,
                  color: active ? T.teal : T.muted,
                  fontFamily: T.mono, fontSize: 11, fontWeight: 600,
                  cursor: "pointer", transition: "all 0.15s",
                  whiteSpace: "nowrap" as const,
                  letterSpacing: 0.2,
                }}
              >
                {c.flagEmoji} {c.displayName}
              </button>
            );
          })}
        </div>
      )}

      {totalListings === 0 ? (
        <div style={{
          textAlign: "center", padding: "48px 16px",
          color: T.muted, fontFamily: T.mono, fontSize: 12, lineHeight: 1.6,
        }}>
          {fedimintJoined
            ? "No open listings yet. Tap Create below to publish one."
            : "Open the Chama selector above to see listings."}
        </div>
      ) : (
        <>
          {/* Matching listings — normal styling */}
          {matchingListings.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
              {matchingListings.map((s, i) => (
                <div key={s.id} style={{ animation: `fadeIn 0.4s ease ${i * 0.08}s both` }}>
                  <TradeCard
                    state={s}
                    pubkey={pubkey}
                    onSelect={() => onOpenEscrow(s.id)}
                  />
                </div>
              ))}
            </div>
          )}

          {/* "N LISTINGS ON OTHER FEDERATIONS" divider + amber-tinted
              non-matching cards. Tap → listing-tap dispatch handles
              the silent switch (or destroy-confirm modal). */}
          {nonMatchingListings.length > 0 && (
            <>
              <div style={{
                display: "flex", alignItems: "center", gap: 10,
                margin: "16px 0 12px",
              }}>
                <div style={{ flex: 1, height: 1, background: T.border }} />
                <div style={{
                  fontSize: 9, color: T.muted, fontFamily: T.mono,
                  letterSpacing: 1.2, textTransform: "uppercase",
                  whiteSpace: "nowrap" as const,
                }}>
                  {nonMatchingListings.length} listing{nonMatchingListings.length !== 1 ? "s" : ""} on other routes
                </div>
                <div style={{ flex: 1, height: 1, background: T.border }} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {nonMatchingListings.map((s, i) => (
                  <div key={s.id} style={{ animation: `fadeIn 0.4s ease ${i * 0.08}s both` }}>
                    <TradeCard
                      state={s}
                      pubkey={pubkey}
                      onSelect={() => onOpenEscrow(s.id)}
                      variant="non-matching"
                    />
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      <div style={{ marginTop: 20, fontFamily: T.mono }}>
        <button
          onClick={() => setShowAdvancedTools((v) => !v)}
          style={{
            background: "none", border: "none", padding: 0,
            color: T.muted, fontFamily: T.mono, fontSize: 10, fontWeight: 700,
            cursor: "pointer", letterSpacing: 0.8, textTransform: "uppercase",
          }}
        >
          {showAdvancedTools ? "▲" : "▼"} Advanced tools
        </button>
        {showAdvancedTools && (
          <div style={{
            marginTop: 10, padding: 12, background: T.surface,
            borderRadius: T.rs, border: `1px solid ${T.border}`,
          }}>
            {isFirstTime && (
              <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                <input
                  type="text"
                  placeholder="fed1…"
                  value={customInviteInput}
                  onChange={(e) => setCustomInviteInput(e.target.value)}
                  style={{ ...inputStyle, flex: 1, marginBottom: 0 }}
                />
                <button
                  disabled={!customInviteInput.trim().startsWith("fed1")}
                  onClick={() => {
                    const v = customInviteInput.trim();
                    if (!v) return;
                    setCustomInviteInput("");
                    setShowAdvancedTools(false);
                    void onPasteCustomInvite(v);
                  }}
                  style={{
                    padding: "8px 14px", borderRadius: T.rs,
                    background: customInviteInput.trim().startsWith("fed1") ? T.accentDim : T.surface,
                    border: `1px solid ${customInviteInput.trim().startsWith("fed1") ? T.accent + "44" : T.border}`,
                    color: customInviteInput.trim().startsWith("fed1") ? T.accent : T.muted,
                    fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                    cursor: customInviteInput.trim().startsWith("fed1") ? "pointer" : "not-allowed",
                    whiteSpace: "nowrap" as const,
                  }}
                >
                  Join
                </button>
              </div>
            )}
            <LoadTradeInput onLoad={onLoadById} />
            <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, lineHeight: 1.7, textAlign: "center" }}>
              Events: kinds 38100-38108 · 2-of-3 SSS<br />
              NIP-44 encrypted · relay replay · no server custody
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function compareBrowseCommunities(a: Community, b: Community): number {
  const byLabel = browseCommunitySortLabel(a).localeCompare(
    browseCommunitySortLabel(b),
    undefined,
    { sensitivity: "base" },
  );
  if (byLabel !== 0) return byLabel;
  const byCurrency = a.currency.localeCompare(b.currency, undefined, { sensitivity: "base" });
  if (byCurrency !== 0) return byCurrency;
  return a.slug.localeCompare(b.slug, undefined, { sensitivity: "base" });
}

function browseCommunitySortLabel(community: Community): string {
  return community.displayName
    .replace(/\s·\s[A-Z]{3}$/, "")
    .replace(/\s·\s/g, " ");
}
