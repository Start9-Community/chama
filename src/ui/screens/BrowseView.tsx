import { useMemo, useState } from "react";
import { type EscrowState } from "../../escrow-engine/types.js";
import { getCommunityBySlug, type Community } from "../../communities/registry.js";
import { T, BROWSE_CATS, inputStyle } from "../theme.js";
import { TradeCard } from "../components/TradeCard.js";
import { LoadTradeInput } from "../components/LoadTradeInput.js";
import { type NostrProfileNameMap } from "../nostr-profiles.js";
import { type AmountDisplayMode } from "../amount-display.js";

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
  browseCommunity,
  amountDisplayMode,
  matchingListings, nonMatchingListings,
  stockByListing,
  categoryCounts,
  fedimintJoined, pubkey,
  kind0Enabled = false, profileNames,
  isFirstTime, onPasteCustomInvite,
  onOpenEscrow, onLoadById,
}: {
  browseCategory: string;
  setBrowseCategory: (s: string) => void;
  browseCommunity: string;
  amountDisplayMode: AmountDisplayMode;
  matchingListings: EscrowState[];
  nonMatchingListings: EscrowState[];
  /** #7 Stage 3: derived "N left" per multi-unit parent listing id. */
  stockByListing?: Map<string, number>;
  categoryCounts?: Record<string, number>;
  fedimintJoined: boolean;
  pubkey: string;
  kind0Enabled?: boolean;
  profileNames?: NostrProfileNameMap;
  isFirstTime: boolean;
  onPasteCustomInvite: (invite: string) => void | Promise<void>;
  onOpenEscrow: (id: string) => void;
  onLoadById: (id: string) => void | Promise<void>;
}) {
  const [showAdvancedTools, setShowAdvancedTools] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [customInviteInput, setCustomInviteInput] = useState("");

  const totalListings = matchingListings.length + nonMatchingListings.length;
  const homeCommunity = getCommunityBySlug(browseCommunity);
  const search = searchQuery.trim().toLowerCase();
  const filteredMatchingListings = useMemo(
    () => matchingListings.filter((listing) => listingMatchesSearch(listing, search)),
    [matchingListings, search],
  );
  const filteredNonMatchingListings = useMemo(
    () => nonMatchingListings.filter((listing) => listingMatchesSearch(listing, search)),
    [nonMatchingListings, search],
  );
  const matchingSections = useMemo(
    () => groupListingsByVertical(filteredMatchingListings),
    [filteredMatchingListings],
  );
  const nonMatchingSections = useMemo(
    () => groupListingsByVertical(filteredNonMatchingListings),
    [filteredNonMatchingListings],
  );
  const filteredTotal = filteredMatchingListings.length + filteredNonMatchingListings.length;
  const browseSummary = totalListings === 0
    ? "No open offers yet"
    : `${filteredTotal.toLocaleString()} of ${totalListings.toLocaleString()} open offer${totalListings === 1 ? "" : "s"}`;
  const quoteCurrency = homeCommunity?.currency ?? null;

  return (
    <div style={{ padding: 16 }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "flex-start",
        marginBottom: 16,
        gap: 12,
      }}>
        <div style={{ minWidth: 0 }}>
          <h1 style={{
            margin: 0, color: T.text, fontFamily: T.sans,
            fontSize: 30, lineHeight: 1.05, fontWeight: 800,
          }}>
            Listings
          </h1>
          <div style={{
            marginTop: 6, fontSize: 12, color: T.muted,
            fontFamily: T.mono, whiteSpace: "nowrap" as const,
            overflow: "hidden", textOverflow: "ellipsis",
          }}>
            {browseSummary}
          </div>
        </div>
        {homeCommunity && (
          // v2.3.1: view-only identity chip. The community SWITCHER moved to
          // Me › Your Chama so switching is a deliberate, between-trades act
          // (and reclaims the Browse real estate the dropdown used to eat).
          // This just tells you which Chama you're browsing as.
          <div
            title={browseCommunityButtonLabel(homeCommunity)}
            style={{
              padding: "7px 10px", borderRadius: 18,
              background: T.surface, border: `1px solid ${T.border}`,
              fontFamily: T.mono, fontSize: 11,
              display: "flex", alignItems: "center", gap: 6,
              color: T.text, minWidth: 0,
              maxWidth: 174, flexShrink: 0,
            }}
          >
            <span style={{ fontSize: 16, lineHeight: 1 }}>{homeCommunity.flagEmoji}</span>
            <span style={{
              minWidth: 0, display: "flex", flexDirection: "column",
              alignItems: "flex-start", lineHeight: 1.1,
            }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 132 }}>
                {homeCommunity.disambiguator ?? homeCommunity.displayName}
              </span>
              <span style={{ color: T.muted, fontSize: 9 }}>{homeCommunity.currency}</span>
            </span>
          </div>
        )}
      </div>

      <div style={{
        display: "flex", gap: 8, alignItems: "center",
        marginBottom: 10,
      }}>
        <label style={{
          flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8,
          padding: "10px 12px", borderRadius: T.rs, background: T.surface,
          border: `1px solid ${T.border}`,
          color: T.muted, fontFamily: T.mono,
        }}>
          <span style={{ fontSize: 16, lineHeight: 1 }}>⌕</span>
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search listings..."
            style={{
              flex: 1, minWidth: 0, background: "transparent", border: "none",
              outline: "none", color: T.text, fontFamily: T.sans,
              fontSize: 14, letterSpacing: 0,
            }}
          />
        </label>
      </div>

      <div style={{
        display: "flex", gap: 6, marginBottom: 12,
        overflowX: "auto",
        scrollbarWidth: "none" as const,
        WebkitOverflowScrolling: "touch" as const,
        paddingBottom: 2,
      }}>
        {BROWSE_CATS.map(c => {
          const active = browseCategory === c.id;
          const count = categoryCounts?.[c.id]
            ?? (c.id === "all" ? totalListings : countListingsByCategory(matchingListings, nonMatchingListings, c.id));
          return (
            <button
              key={c.id}
              onClick={() => setBrowseCategory(c.id)}
              style={{
                flexShrink: 0,
                padding: "7px 11px", borderRadius: 18,
                background: active ? T.accentDim : T.surface,
                border: `1px solid ${active ? T.accent + "66" : T.border}`,
                color: active ? T.accent : T.muted,
                fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                cursor: "pointer", transition: "all 0.15s",
                whiteSpace: "nowrap" as const,
                letterSpacing: 0,
                display: "inline-flex", alignItems: "center", gap: 6,
              }}
            >
              {c.i && <span>{c.i}</span>}
              <span>{c.l}</span>
              <span style={{
                color: active ? T.bg : T.muted,
                background: active ? T.accent : T.card,
                border: `1px solid ${active ? T.accent : T.border}`,
                borderRadius: 999,
                padding: "1px 5px",
                fontSize: 9,
                lineHeight: 1.2,
              }}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {search && totalListings > 0 && filteredTotal === 0 && (
        <div style={{
          textAlign: "center", padding: "24px 16px",
          color: T.muted, fontFamily: T.mono, fontSize: 12, lineHeight: 1.6,
          background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs,
          marginBottom: 14,
        }}>
          No listings match "{searchQuery.trim()}".
        </div>
      )}

      {totalListings === 0 ? (
        <div style={{
          textAlign: "center", padding: "44px 20px", fontFamily: T.sans,
        }}>
          {fedimintJoined ? (
            <>
              <div style={{ fontSize: 40, marginBottom: 14, lineHeight: 1 }}>🤝</div>
              <div style={{ fontSize: 16, fontWeight: 800, color: T.text, marginBottom: 8 }}>
                Be the first to post here
              </div>
              <div style={{ fontSize: 13, color: T.muted, lineHeight: 1.6, maxWidth: 300, margin: "0 auto" }}>
                No open offers in your community yet. Tap{" "}
                <strong style={{ color: T.accent }}>Create</strong> below to post
                one — buyers and sellers nearby will see it.
              </div>
            </>
          ) : (
            <div style={{ fontSize: 13, color: T.muted, lineHeight: 1.6 }}>
              Pick your Chama above to see what's trading.
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Matching listings — normal styling */}
          {filteredMatchingListings.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              {browseCategory === "all" ? (
                matchingSections.map(section => (
                  <BrowseSection
                    key={section.id}
                    section={section}
                    pubkey={pubkey}
                    onOpenEscrow={onOpenEscrow}
                    kind0Enabled={kind0Enabled}
                    profileNames={profileNames}
                    amountDisplayMode={amountDisplayMode}
                    quoteCurrency={quoteCurrency}
                    stockByListing={stockByListing}
                  />
                ))
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {filteredMatchingListings.map((s, i) => (
                    <div key={s.id} style={{ animation: `fadeIn 0.4s ease ${i * 0.08}s both` }}>
                      <TradeCard
                        state={s}
                        pubkey={pubkey}
                        onSelect={() => onOpenEscrow(s.id)}
                        kind0Enabled={kind0Enabled}
                        profileNames={profileNames}
                        amountDisplayMode={amountDisplayMode}
                        quoteCurrency={quoteCurrency}
                        stockLeft={stockByListing?.get(s.id)}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* "N LISTINGS ON OTHER FEDERATIONS" divider + amber-tinted
              non-matching cards. Tap → listing-tap dispatch handles
              the silent switch (or destroy-confirm modal). */}
          {filteredNonMatchingListings.length > 0 && (
            <>
              <div style={{
                display: "flex", alignItems: "center", gap: 10,
                margin: "16px 0 12px",
              }}>
                <div style={{ flex: 1, height: 1, background: T.border }} />
                <div style={{
                  fontSize: 9, color: T.muted, fontFamily: T.mono,
                  letterSpacing: 0, textTransform: "uppercase",
                  whiteSpace: "nowrap" as const,
                }}>
                  {filteredNonMatchingListings.length} listing{filteredNonMatchingListings.length !== 1 ? "s" : ""} in other communities
                </div>
                <div style={{ flex: 1, height: 1, background: T.border }} />
              </div>
              {browseCategory === "all" ? (
                nonMatchingSections.map(section => (
                  <BrowseSection
                    key={section.id}
                    section={section}
                    pubkey={pubkey}
                    onOpenEscrow={onOpenEscrow}
                    variant="non-matching"
                    kind0Enabled={kind0Enabled}
                    profileNames={profileNames}
                    amountDisplayMode={amountDisplayMode}
                    quoteCurrency={quoteCurrency}
                    stockByListing={stockByListing}
                  />
                ))
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {filteredNonMatchingListings.map((s, i) => (
                    <div key={s.id} style={{ animation: `fadeIn 0.4s ease ${i * 0.08}s both` }}>
                      <TradeCard
                        state={s}
                        pubkey={pubkey}
                        onSelect={() => onOpenEscrow(s.id)}
                        variant="non-matching"
                        kind0Enabled={kind0Enabled}
                        profileNames={profileNames}
                        amountDisplayMode={amountDisplayMode}
                        quoteCurrency={quoteCurrency}
                        stockLeft={stockByListing?.get(s.id)}
                      />
                    </div>
                  ))}
                </div>
              )}
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
            cursor: "pointer", letterSpacing: 0, textTransform: "uppercase",
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

function browseCommunityButtonLabel(community: Community): string {
  return community.disambiguator
    ? `${community.displayName} · ${community.disambiguator}`
    : community.displayName;
}

function listingMatchesSearch(listing: EscrowState, query: string): boolean {
  if (!query) return true;
  const community = listing.community ? getCommunityBySlug(listing.community) : null;
  const haystack = [
    listing.description,
    listing.category,
    listing.fulfillment,
    listing.fiatCurrency,
    listing.fiatAmount?.toString(),
    community?.displayName,
    community?.disambiguator,
    community?.currency,
    Math.floor(listing.amountMsats / 1000).toString(),
    ...(listing.items ?? []).flatMap(item => [
      item.label,
      item.description,
      item.fiatCurrency,
      item.fiatAmount?.toString(),
      item.kind,
      item.fulfillment,
      item.minAmountMsats ? Math.floor(item.minAmountMsats / 1000).toString() : undefined,
      item.maxAmountMsats ? Math.floor(item.maxAmountMsats / 1000).toString() : undefined,
      item.dueAt ? new Date(item.dueAt * 1000).toLocaleDateString() : undefined,
      item.termDays?.toString(),
      item.trustTier?.toString(),
      Math.floor(item.amountMsats / 1000).toString(),
    ]),
  ]
    .filter((part): part is string => !!part)
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

interface BrowseListingSection {
  id: string;
  label: string;
  icon: string;
  listings: EscrowState[];
}

function groupListingsByVertical(listings: EscrowState[]): BrowseListingSection[] {
  return BROWSE_CATS
    .filter(c => c.id !== "all")
    .map(c => ({
      id: c.id,
      label: c.l,
      icon: c.i,
      listings: listings.filter(listing => listing.category === c.id),
    }))
    .filter(section => section.listings.length > 0);
}

function countListingsByCategory(
  matchingListings: EscrowState[],
  nonMatchingListings: EscrowState[],
  category: string,
): number {
  return [...matchingListings, ...nonMatchingListings]
    .filter(listing => listing.category === category)
    .length;
}

function BrowseSection({
  section,
  pubkey,
  onOpenEscrow,
  variant = "matching",
  kind0Enabled = false,
  profileNames,
  amountDisplayMode,
  quoteCurrency,
  stockByListing,
}: {
  section: BrowseListingSection;
  pubkey: string;
  onOpenEscrow: (id: string) => void;
  variant?: "matching" | "non-matching";
  kind0Enabled?: boolean;
  profileNames?: NostrProfileNameMap;
  amountDisplayMode: AmountDisplayMode;
  quoteCurrency?: string | null;
  stockByListing?: Map<string, number>;
}) {
  return (
    <section style={{ marginBottom: 16 }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        marginBottom: 8,
      }}>
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          color: T.text,
          fontFamily: T.mono,
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: 0.8,
          textTransform: "uppercase",
        }}>
          <span style={{ fontSize: 13 }}>{section.icon}</span>
          {section.label}
        </div>
        <div style={{
          color: T.muted,
          fontFamily: T.mono,
          fontSize: 10,
        }}>
          {section.listings.length} open
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {section.listings.map((s, i) => (
          <div key={s.id} style={{ animation: `fadeIn 0.4s ease ${i * 0.08}s both` }}>
            <TradeCard
              state={s}
              pubkey={pubkey}
              onSelect={() => onOpenEscrow(s.id)}
              variant={variant}
              kind0Enabled={kind0Enabled}
              profileNames={profileNames}
              amountDisplayMode={amountDisplayMode}
              quoteCurrency={quoteCurrency}
              stockLeft={stockByListing?.get(s.id)}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
