// ══════════════════════════════════════════════════════════════════════════
// Chama — Me screen (v0.2.0 Phase 6 skeleton population)
// ══════════════════════════════════════════════════════════════════════════
//
// Consolidates: profile, ratings, Nostr Profile sub-section, settings
// entries, trade history. Per the v0.2.0 brief Me is fully accessible
// during active trades — users may need to update LN address, fetch
// counterparty kind:0, or check ratings/history as part of resolving
// recovery / arbitration.
//
// Ratings: minimal aggregator (count + %positive). v0.2.0 universally
// renders the "no ratings yet" placeholder because no rating events
// are being published until v0.2.1; the surface ships now to teach
// the user that reputation is the primitive.
//
// Nostr Profile: deliberately minimal. The kind:0 toggle (default off,
// privacy-preserving) opts into fetching counterparty names; v0.2.1
// wires the actual fetcher. Read-only display of the user's own kind:0
// is similarly v0.2.1+ territory. v0.2.0 ships the toggle + the
// "Chama doesn't manage your Nostr profile" educational copy so the
// doctrine is visible from day one.

import { useState, useEffect } from "react";
import {
  type EscrowState,
  EscrowStatus,
  EscrowEventKind,
  Outcome,
  Role,
  type SelectedMenuItem,
  getEffectiveParticipantAt,
  getEffectiveParticipantsAt,
} from "../../escrow-engine/types.js";
import { getWinner } from "../../escrow-engine/state-machine.js";
import { arbiterVotePriority, substitutionEligibleAt } from "../../escrow-engine/arbiter-substitution.js";
import { BLF_OFFICIAL_ARBITERS } from "../../arbiters/pool.js";
import { getPickerCommunities, getCommunityBySlug } from "../../communities/registry.js";
import {
  MAIN_SURFACE_RECOVERY_MIN_SATS,
  formatStepInCountdown,
  type AggregateRatings,
} from "../decisions.js";
import { counterpartyToRate, type RatingThumb } from "../../reputation/ratings.js";
import { RatingTap } from "../components/RatingTap.js";
import {
  lightningPayoutReserveSats,
  maxLightningPayoutSats,
} from "../../payments/lightning-fees.js";
import {
  describeSatsTrace,
  type SatsTraceEntry,
} from "../../payments/sats-trace.js";
import { getEcashExport } from "../../payments/ecash-exports.js";
import { T, ROLE_COLOR, type ThemeMode } from "../theme.js";
import {
  notificationsEnabled,
  setNotificationsEnabled,
  ensureNotificationPermission,
} from "../../notifications/notify-service.js";
import { TradeCard } from "../components/TradeCard.js";
import { BitcoinAmount } from "../components/BitcoinAmount.js";
import { readKind0Toggle, writeKind0Toggle } from "../nostr-profiles.js";

type MeTradeFilter = "all" | "needs" | "live" | "listings" | "done";

const ME_TRADE_FILTERS: { id: MeTradeFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "needs", label: "Needs you" },
  { id: "live", label: "Live" },
  { id: "listings", label: "Listings" },
  { id: "done", label: "Done" },
];

export function MeScreen({
  pubkey,
  kind0Enabled,
  onKind0EnabledChange,
  themeMode,
  onThemeModeChange,
  myTrades,
  allTrades,
  ratings,
  onOpenTrade,
  onSellerEditListing,
  onSellerDeleteListing,
  onOpenSavedHandles,
  onOpenPayoutDestinations,
  onOpenAdvanced,
  balanceMsats,
  hasActiveCommitment,
  satsTrace,
  onRecoverSats,
  onWithdrawEcash,
  onSignOut,
  communitySlug,
  onSelectCommunity,
  onApplyAsArbiter,
  onRateCounterparty,
  myGivenRatings,
}: {
  pubkey: string;
  kind0Enabled?: boolean;
  onKind0EnabledChange?: (enabled: boolean) => void;
  /** #50 dark/light theming — current mode + setter (App owns the state). */
  themeMode?: ThemeMode;
  onThemeModeChange?: (mode: ThemeMode) => void;
  myTrades: EscrowState[];
  allTrades?: EscrowState[];
  /** Aggregate rating data. v0.2.0 always null (no rating events yet);
   *  v0.2.1 wires the aggregator. */
  ratings: AggregateRatings | null;
  /** Reputation (kind:38123): one-tap rate a counterparty on a settled trade,
   *  and the slots already rated (so a rated trade drops its history one-tap). */
  onRateCounterparty?: (tradeId: string, ratee: string, thumb: RatingThumb) => Promise<void>;
  myGivenRatings?: Array<{ tradeId: string; ratee: string; thumb: RatingThumb }>;
  onOpenTrade: (id: string) => void;
  onSellerEditListing?: (id: string) => void;
  onSellerDeleteListing?: (id: string) => void | Promise<void>;
  onOpenSavedHandles: () => void;
  onOpenPayoutDestinations: () => void;
  onOpenAdvanced: () => void;
  balanceMsats: number;
  hasActiveCommitment: boolean;
  satsTrace?: SatsTraceEntry | null;
  onRecoverSats: () => void;
  /** v2.4 #56 — open the "withdraw as ecash" (fee-free Fedimint note) flow. */
  onWithdrawEcash?: () => void;
  onSignOut: () => void;
  /** v2.3.1: the user's current Chama. The Browse pill is now view-only;
   *  this screen is the deliberate place to CHANGE it. */
  communitySlug?: string | null;
  /** Bound to handleSelectCommunity — switches Chama (with the same funds-at-
   *  risk destroy-confirm guard the Browse pill used to trigger). */
  onSelectCommunity?: (slug: string) => void;
  /** V3 #74: publish a signed arbiter application (kind:38121) for the
   *  user's current community. Absent ⇒ the CTA card doesn't render. */
  onApplyAsArbiter?: (community: string, statement: string) => Promise<void>;
}) {
  const npubShort = pubkey.slice(0, 8) + "…" + pubkey.slice(-4);
  const [localKind0On, setLocalKind0On] = useState<boolean>(() => readKind0Toggle(pubkey));
  const kind0On = kind0Enabled ?? localKind0On;
  const [tradeFilter, setTradeFilter] = useState<MeTradeFilter>("all");
  useEffect(() => {
    setLocalKind0On(readKind0Toggle(pubkey));
  }, [pubkey]);
  useEffect(() => { writeKind0Toggle(pubkey, kind0On); }, [pubkey, kind0On]);
  const setKind0On = (enabled: boolean) => {
    setLocalKind0On(enabled);
    onKind0EnabledChange?.(enabled);
  };
  const localRecoverySats = Math.floor(Math.max(0, balanceMsats) / 1000);
  const localRecoverableSats = maxLightningPayoutSats(balanceMsats);
  const localReserveSats = lightningPayoutReserveSats(balanceMsats);
  const showLocalRecovery = !hasActiveCommitment && localRecoverySats > 0;
  const isSmallLeftover = localRecoverySats < MAIN_SURFACE_RECOVERY_MIN_SATS;
  // A leftover below the material dust line never offers an ACTIVE recover
  // button — recovering ~1 sat burns more than itself in Lightning fees (the
  // same line the switch guard and recovery banner use). The card stays as a
  // quiet "accumulating" note until the pile is worth the fees.
  const recoverWorthwhile = !isSmallLeftover && localRecoverableSats > 0;
  // v2.4 #56 — a pending ecash export (generated but not yet confirmed
  // imported). Surfaced even when the balance reads 0, so the user can always
  // get back to the bearer note they minted.
  const pendingEcashExport = getEcashExport();
  const isClaimPayoutRecovery = !isSmallLeftover && Boolean(satsTrace?.escrowId);
  const traceCopy = describeSatsTrace(satsTrace ?? null);
  const nowSec = Math.floor(Date.now() / 1000);
  const dashboard = buildMeDashboard(myTrades, allTrades ?? myTrades, pubkey, nowSec);
  const tradeCounts = buildMeTradeCounts(myTrades, dashboard.needsYou);
  const visibleTrades = filterMeTrades(myTrades, dashboard.needsYou, tradeFilter);

  return (
    <div style={{ padding: 16, maxWidth: 560, margin: "0 auto" }}>
      {/* Profile header */}
      <div style={{
        background: T.card, border: `1px solid ${T.border}`,
        borderRadius: T.r, padding: 20, marginBottom: 16,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono,
          letterSpacing: 1, marginBottom: 10,
        }}>
          PROFILE
        </div>
        <div style={{
          display: "flex", alignItems: "center", gap: 14,
        }}>
          <div style={{
            width: 48, height: 48, borderRadius: "50%",
            background: T.accentDim, border: `1px solid ${T.accent}66`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: T.mono, fontSize: 18, fontWeight: 800, color: T.accent,
            flexShrink: 0,
          }}>
            {pubkey.slice(0, 1).toUpperCase()}
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 12, color: T.muted, fontFamily: T.mono, marginBottom: 4 }}>
              npub
            </div>
            <div style={{
              fontFamily: T.mono, fontSize: 13, color: T.text,
              wordBreak: "break-all" as const,
            }}>
              {npubShort}
            </div>
          </div>
        </div>
      </div>

      {onSelectCommunity && (
        <YourChamaCard
          communitySlug={communitySlug ?? null}
          hasActiveCommitment={hasActiveCommitment}
          onSelectCommunity={onSelectCommunity}
        />
      )}

      {showLocalRecovery && (
        <div style={{
          background: isClaimPayoutRecovery ? T.amberDim : T.card,
          border: `1px solid ${isSmallLeftover ? T.border : T.amber}`,
          borderRadius: T.r, padding: 20, marginBottom: 16,
          boxShadow: isClaimPayoutRecovery ? `0 0 30px ${T.amber}22` : "none",
        }}>
          <div style={{
            fontSize: 11, fontWeight: 600, color: isSmallLeftover ? T.muted : T.amber,
            fontFamily: T.mono, letterSpacing: 1, marginBottom: 12,
          }}>
            {isClaimPayoutRecovery ? "PAYOUT RECOVERY" : "SATS RECOVERY"}
          </div>
          <div style={{ fontSize: 13, color: T.text, fontFamily: T.sans, lineHeight: 1.55 }}>
            {isSmallLeftover ? (
              <>
                <BitcoinAmount sats={localRecoverySats} size={13} gap={4} glyphScale={1.18} color={T.text} glyphColor={T.muted} /> saved as a small leftover.
                Chama keeps small leftovers out of the main flow and lets them accumulate here.
              </>
            ) : (
              <>
                <BitcoinAmount sats={localRecoverySats} size={13} gap={4} glyphScale={1.18} color={T.text} glyphColor={T.muted} /> are safe in your Chama and ready to recover.
                {localReserveSats > 0 && (
                  <>
                    {" "}About <BitcoinAmount sats={localReserveSats} size={13} gap={4} glyphScale={1.18} color={T.text} glyphColor={T.muted} /> stay reserved for Lightning fees.
                  </>
                )}
              </>
            )}
          </div>
          {traceCopy && (
            <div style={{
              marginTop: 10, padding: "9px 10px",
              background: T.surface, border: `1px solid ${T.border}`,
              borderRadius: T.rs, color: T.muted,
              fontFamily: T.mono, fontSize: 10, lineHeight: 1.45,
            }}>
              TRACE · {traceCopy}
              {satsTrace?.escrowId ? (
                <div style={{ wordBreak: "break-all" as const, marginTop: 4 }}>
                  {satsTrace.escrowId}
                </div>
              ) : null}
            </div>
          )}
          <button
            onClick={onRecoverSats}
            disabled={!recoverWorthwhile}
            style={{
              width: "100%", padding: "12px", marginTop: 14,
              background: recoverWorthwhile ? T.amberDim : T.surface,
              border: `1px solid ${recoverWorthwhile ? T.amber + "66" : T.border}`,
              borderRadius: T.rs,
              color: recoverWorthwhile ? T.amber : T.muted,
              fontFamily: T.mono, fontSize: 12, fontWeight: 800,
              cursor: recoverWorthwhile ? "pointer" : "default",
            }}
          >
            {recoverWorthwhile
              ? <>{isClaimPayoutRecovery ? "Recover payout" : "Recover"} <BitcoinAmount sats={localRecoverableSats} size={12} gap={4} glyphScale={1.18} color="inherit" glyphColor="inherit" /></>
              : isSmallLeftover
                ? "Accumulating — too small to recover over Lightning yet"
                : "Waiting for enough sats to recover"}
          </button>
          {/* v2.4 #56 — fee-free ecash exit. Available for ANY balance,
              including dust the LN "Recover" button can't economically move.
              Spends the balance into a Fedimint note importable into Fedi or
              any Fedimint wallet on this federation. */}
          {onWithdrawEcash && (
            <button
              onClick={onWithdrawEcash}
              style={{
                width: "100%", padding: "11px", marginTop: 8,
                background: T.surface, border: `1px solid ${T.teal}55`,
                borderRadius: T.rs, color: T.teal,
                fontFamily: T.mono, fontSize: 11, fontWeight: 800, cursor: "pointer",
              }}
            >
              Withdraw as ecash · no LN fees
            </button>
          )}
        </div>
      )}

      {/* v2.4 #56 — pending ecash export re-entry. After generating a note the
          balance reads 0, so the SATS RECOVERY card hides; this is how the user
          gets back to the bearer note they minted until they confirm import. */}
      {pendingEcashExport && onWithdrawEcash && (
        <div
          onClick={onWithdrawEcash}
          style={{
            background: T.tealDim, border: `1px solid ${T.teal}66`,
            borderRadius: T.r, padding: 20, marginBottom: 16, cursor: "pointer",
          }}
        >
          <div style={{
            fontSize: 11, fontWeight: 600, color: T.teal,
            fontFamily: T.mono, letterSpacing: 1, marginBottom: 8,
          }}>
            PENDING ECASH EXPORT
          </div>
          <div style={{ fontSize: 13, color: T.text, fontFamily: T.sans, lineHeight: 1.5 }}>
            You minted{" "}
            <BitcoinAmount sats={Math.floor(pendingEcashExport.amountMsats / 1000)} size={13} gap={4} glyphScale={1.18} color={T.text} glyphColor={T.muted} />
            {" "}as an ecash note{pendingEcashExport.federationLabel ? ` on ${pendingEcashExport.federationLabel}` : ""}. Tap to copy or scan it again, then confirm once it's imported.
          </div>
        </div>
      )}

      <MeDashboard
        dashboard={dashboard}
        onOpenTrade={onOpenTrade}
        onSellerEditListing={onSellerEditListing}
        onSellerDeleteListing={onSellerDeleteListing}
        pubkey={pubkey}
      />

      {/* Ratings — minimal v0.2.0 surface. Per Pillar 2.6 reputation
          is the backbone primitive; the surface ships even before
          rating events do, so users learn the model through
          encountering it. */}
      <div style={{
        background: T.card, border: `1px solid ${T.border}`,
        borderRadius: T.r, padding: 20, marginBottom: 16,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono,
          letterSpacing: 1, marginBottom: 12,
        }}>
          RATINGS
        </div>
        {ratings && ratings.count > 0 ? (
          <div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
              <span style={{ fontSize: 28, fontWeight: 800, color: T.text, fontFamily: T.mono }}>
                {ratings.count}
              </span>
              <span style={{ fontSize: 12, color: T.muted, fontFamily: T.mono }}>
                rating{ratings.count !== 1 ? "s" : ""}
              </span>
              <span style={{ flex: 1 }} />
              <span style={{
                fontSize: 16, fontWeight: 700,
                color: ratings.positive >= ratings.count - ratings.negative ? T.green : T.amber,
                fontFamily: T.mono,
              }}>
                {Math.round((ratings.positive / Math.max(ratings.count, 1)) * 100)}%
              </span>
              <span style={{ fontSize: 11, color: T.muted, fontFamily: T.mono }}>
                positive
              </span>
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: T.muted, fontFamily: T.sans, lineHeight: 1.55 }}>
            No ratings yet — complete your first trade to start building
            reputation. Ratings unlock graduated capabilities like
            recurring payments.
          </div>
        )}
      </div>

      {/* Nostr Profile sub-section */}
      <div style={{
        background: T.card, border: `1px solid ${T.border}`,
        borderRadius: T.r, padding: 20, marginBottom: 16,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono,
          letterSpacing: 1, marginBottom: 12,
        }}>
          NOSTR PROFILE
        </div>

        {/* Toggle: fetch counterparty kind:0 */}
        <div
          onClick={() => setKind0On(!kind0On)}
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            cursor: "pointer", marginBottom: 14,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: T.text, fontFamily: T.sans }}>
              Show counterparty names
            </div>
            <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginTop: 4, lineHeight: 1.5 }}>
              Off (default): trades show truncated npubs only. On: Chama
              fetches self-published Nostr profile names for trade
              participants. Privacy default is npub-only.
            </div>
          </div>
          <div style={{
            width: 40, height: 22, borderRadius: 11,
            background: kind0On ? T.accent : T.border,
            padding: 2, transition: "background 0.2s",
            flexShrink: 0, marginLeft: 12,
          }}>
            <div style={{
              width: 18, height: 18, borderRadius: "50%",
              background: T.bg, transition: "transform 0.2s",
              transform: kind0On ? "translateX(18px)" : "translateX(0)",
            }} />
          </div>
        </div>

        {/* Educational copy — Chama doesn't manage profiles */}
        <div style={{
          fontSize: 11, color: T.muted, fontFamily: T.sans, lineHeight: 1.55,
          padding: "10px 12px",
          background: T.surface, border: `1px solid ${T.border}`,
          borderRadius: T.rs,
        }}>
          Chama doesn't manage your Nostr profile. Use a Nostr client
          (Damus, Primal, Amethyst) to set your name and picture. When
          the toggle is on, names appear under participant dots and
          store/seller badges after relays return your kind:0 profile.
        </div>
      </div>

      {/* Settings sub-page entries */}
      <div style={{
        background: T.card, border: `1px solid ${T.border}`,
        borderRadius: T.r, padding: 0, marginBottom: 16, overflow: "hidden",
      }}>
        {themeMode && onThemeModeChange && (
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            gap: 10, padding: "14px 16px", borderBottom: `1px solid ${T.border}`,
          }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: T.text, fontFamily: T.sans }}>
                Appearance
              </div>
              <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginTop: 2 }}>
                Auto follows your device
              </div>
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              {(["dark", "light", "system"] as ThemeMode[]).map(mode => {
                const active = themeMode === mode;
                const label = mode === "system" ? "Auto" : mode === "dark" ? "Dark" : "Light";
                return (
                  <button
                    key={mode}
                    onClick={() => onThemeModeChange(mode)}
                    style={{
                      padding: "6px 10px", borderRadius: 999,
                      border: `1px solid ${active ? T.accent + "66" : T.border}`,
                      background: active ? T.accentDim : T.surface,
                      color: active ? T.accent : T.muted,
                      fontFamily: T.mono, fontSize: 10, fontWeight: 800,
                      cursor: "pointer",
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <NotificationsRow />
        <SettingsRow label="Payment handles" hint="Saved handles for fast trade-time fill" onClick={onOpenSavedHandles} />
        <SettingsRow label="Payout destinations" hint="Lightning addresses for claims and recovery" onClick={onOpenPayoutDestinations} />
        <SettingsRow label="Advanced" hint="Sandbox mode and Chama tools" onClick={onOpenAdvanced} />
        <SettingsRow label="Sign out" hint={null} onClick={onSignOut} danger />
      </div>

      {communitySlug && onApplyAsArbiter && (
        <ArbiterCtaCard
          communitySlug={communitySlug}
          onApply={onApplyAsArbiter}
        />
      )}

      <MeTradeHistory
        trades={visibleTrades}
        totalCount={myTrades.length}
        counts={tradeCounts}
        activeFilter={tradeFilter}
        onFilter={setTradeFilter}
        pubkey={pubkey}
        onOpenTrade={onOpenTrade}
        onRateCounterparty={onRateCounterparty}
        myGivenRatings={myGivenRatings}
      />
    </div>
  );
}

type MeTradeCounts = Record<MeTradeFilter, number>;

function MeTradeHistory({
  trades,
  totalCount,
  counts,
  activeFilter,
  onFilter,
  pubkey,
  onOpenTrade,
  onRateCounterparty,
  myGivenRatings,
}: {
  trades: EscrowState[];
  totalCount: number;
  counts: MeTradeCounts;
  activeFilter: MeTradeFilter;
  onFilter: (filter: MeTradeFilter) => void;
  pubkey: string;
  onOpenTrade: (id: string) => void;
  onRateCounterparty?: (tradeId: string, ratee: string, thumb: RatingThumb) => Promise<void>;
  myGivenRatings?: Array<{ tradeId: string; ratee: string; thumb: RatingThumb }>;
}) {
  const activeFilterLabel = ME_TRADE_FILTERS.find((filter) => filter.id === activeFilter)?.label ?? "All";

  return (
    <section>
      <div style={{
        display: "flex", alignItems: "flex-end", justifyContent: "space-between",
        gap: 12, marginBottom: 10,
      }}>
        <div>
          <div style={{
            fontSize: 11, fontWeight: 700, color: T.muted, fontFamily: T.mono,
            letterSpacing: 1, textTransform: "uppercase",
          }}>
            My trades
          </div>
          <div style={{
            marginTop: 4, color: T.text, fontFamily: T.sans,
            fontSize: 20, fontWeight: 800,
          }}>
            {activeFilterLabel}
          </div>
        </div>
        <div style={{
          color: T.muted, fontFamily: T.mono, fontSize: 11,
          whiteSpace: "nowrap" as const,
        }}>
          {trades.length} / {totalCount}
        </div>
      </div>

      <div style={{
        display: "flex", gap: 6, marginBottom: 12,
        overflowX: "auto", scrollbarWidth: "none" as const,
        WebkitOverflowScrolling: "touch" as const, paddingBottom: 2,
      }}>
        {ME_TRADE_FILTERS.map((filter) => {
          const active = activeFilter === filter.id;
          const count = counts[filter.id];
          return (
            <button
              key={filter.id}
              onClick={() => onFilter(filter.id)}
              style={{
                flexShrink: 0,
                padding: "7px 12px", borderRadius: 18,
                background: active ? T.accentDim : T.surface,
                border: `1px solid ${active ? T.accent + "66" : T.border}`,
                color: active ? T.accent : T.muted,
                fontFamily: T.mono, fontSize: 11, fontWeight: 800,
                cursor: "pointer", whiteSpace: "nowrap" as const,
                letterSpacing: 0,
              }}
            >
              {filter.label} {count > 0 ? count : ""}
            </button>
          );
        })}
      </div>

      {totalCount === 0 ? (
        <div style={{
          padding: 24, textAlign: "center",
          background: T.surface, border: `1px dashed ${T.border}`,
          borderRadius: T.r, color: T.muted, fontFamily: T.mono, fontSize: 11,
        }}>
          No trades yet. Browse listings to start one.
        </div>
      ) : trades.length === 0 ? (
        <div style={{
          padding: 18, textAlign: "center",
          background: T.surface, border: `1px dashed ${T.border}`,
          borderRadius: T.r, color: T.muted, fontFamily: T.mono, fontSize: 11,
        }}>
          Nothing in this view right now.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {trades.map((s, i) => {
            // v1 ratings: a settled-but-UNRATED trade keeps a one-tap thumb in
            // history (the "rate later" path for users who bolt with their sats).
            // Once rated, the tap drops — the slot is replaceable, so it reappears
            // nowhere and double-rating is impossible.
            const ratee = onRateCounterparty && s.status === EscrowStatus.COMPLETED
              ? counterpartyToRate(s, pubkey)
              : null;
            const alreadyRated = ratee
              ? (myGivenRatings ?? []).some(r => r.tradeId === s.id && r.ratee === ratee.toLowerCase())
              : false;
            return (
              <div key={s.id} style={{ animation: `fadeIn 0.4s ease ${i * 0.05}s both` }}>
                <TradeCard state={s} pubkey={pubkey} onSelect={() => onOpenTrade(s.id)} />
                {ratee && !alreadyRated && onRateCounterparty && (
                  <RatingTap tradeId={s.id} ratee={ratee} onRate={onRateCounterparty} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

type MeDashboardModel = {
  needsYou: EscrowState[];
  sellerOpen: EscrowState[];
  sellerLive: EscrowState[];
  sellerInventory: EscrowState[];
  sellerWindowShoppers: EscrowState[];
  sellerReadyToLock: EscrowState[];
  arbiterVisible: boolean;
  arbiterDisputes: EscrowState[];
  arbiterWatching: EscrowState[];
  arbiterSettled: EscrowState[];
};

function MeDashboard({
  dashboard,
  onOpenTrade,
  onSellerEditListing,
  onSellerDeleteListing,
  pubkey,
}: {
  dashboard: MeDashboardModel;
  onOpenTrade: (id: string) => void;
  onSellerEditListing?: (id: string) => void;
  onSellerDeleteListing?: (id: string) => void | Promise<void>;
  pubkey: string;
}) {
  const hasSellerDashboard = dashboard.sellerOpen.length > 0 || dashboard.sellerLive.length > 0;
  const hasNeedsYou = dashboard.needsYou.length > 0;
  const showDashboard = hasNeedsYou || hasSellerDashboard || dashboard.arbiterVisible;
  if (!showDashboard) return null;

  const firstNeedsYou = dashboard.needsYou[0];
  const firstSeller = dashboard.sellerLive[0] ?? dashboard.sellerOpen[0];

  return (
    <div style={{
      background: T.card, border: `1px solid ${T.border}`,
      borderRadius: T.r, padding: 16, marginBottom: 16,
    }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: 12, marginBottom: 12,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 700, color: T.muted, fontFamily: T.mono,
          letterSpacing: 1, textTransform: "uppercase",
        }}>
          Trade dashboard
        </div>
        {hasNeedsYou && (
          <span style={{
            fontFamily: T.mono, color: T.accent, fontSize: 10, fontWeight: 900,
            padding: "4px 8px", borderRadius: 999,
            background: T.accentDim, border: `1px solid ${T.accent}44`,
          }}>
            {dashboard.needsYou.length} needs you
          </span>
        )}
      </div>

      {hasNeedsYou && (
        <DashboardRow
          label="Needs you"
          value={`${dashboard.needsYou.length} trade${dashboard.needsYou.length === 1 ? "" : "s"}`}
          hint="Vote or claim when a trade is waiting on your key."
          tone={T.accent}
          onClick={firstNeedsYou ? () => onOpenTrade(firstNeedsYou.id) : undefined}
          last={!hasSellerDashboard && !dashboard.arbiterVisible}
        />
      )}

      {hasSellerDashboard && (
        <DashboardRow
          label="Seller queue"
          value={`${dashboard.sellerOpen.length} open · ${dashboard.sellerLive.length} live`}
          hint="Listings stay public here; live orders become your working queue."
          tone={T.green}
          onClick={firstSeller ? () => onOpenTrade(firstSeller.id) : undefined}
          last={!dashboard.arbiterVisible}
        />
      )}

      {hasSellerDashboard && (
        <SellerDashboardPanel
          dashboard={dashboard}
          onOpenTrade={onOpenTrade}
          onSellerEditListing={onSellerEditListing}
          onSellerDeleteListing={onSellerDeleteListing}
        />
      )}

      {dashboard.arbiterVisible && (
        <ArbiterDashboardPanel
          dashboard={dashboard}
          onOpenTrade={onOpenTrade}
          viewerPubkey={pubkey}
        />
      )}
    </div>
  );
}

type SellerQueueKey = "ready" | "holds" | "live" | "stock";

const SELLER_QUEUE_LABEL: Record<SellerQueueKey, string> = {
  ready: "Ready",
  holds: "Holds",
  live: "Live",
  stock: "Stock",
};

function SellerDashboardPanel({
  dashboard,
  onOpenTrade,
  onSellerEditListing,
  onSellerDeleteListing,
}: {
  dashboard: MeDashboardModel;
  onOpenTrade: (id: string) => void;
  onSellerEditListing?: (id: string) => void;
  onSellerDeleteListing?: (id: string) => void | Promise<void>;
}) {
  const [queue, setQueue] = useState<SellerQueueKey>(() => firstSellerQueue(dashboard));
  useEffect(() => {
    if (sellerQueueTrades(dashboard, queue).length > 0) return;
    setQueue(firstSellerQueue(dashboard));
  }, [dashboard, queue]);
  const activeTrades = sellerQueueTrades(dashboard, queue);

  return (
    <div style={{
      marginTop: 14,
      paddingTop: 14,
      borderTop: `1px solid ${T.border}`,
    }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: 12, marginBottom: 10,
      }}>
        <div>
          <div style={{
            fontFamily: T.mono, color: T.green, fontSize: 10,
            fontWeight: 900, letterSpacing: 1, textTransform: "uppercase",
          }}>
            Seller dashboard
          </div>
          <div style={{
            marginTop: 3,
            fontFamily: T.sans, color: T.text, fontSize: 15,
            fontWeight: 800,
          }}>
            Inventory and orders
          </div>
        </div>
        <div style={{
          fontFamily: T.mono, color: T.muted, fontSize: 10,
          lineHeight: 1.35, textAlign: "right" as const,
        }}>
          {dashboard.sellerOpen.length.toLocaleString()} open<br />
          {dashboard.sellerLive.length.toLocaleString()} live
        </div>
      </div>

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
        gap: 6,
        marginBottom: 12,
      }}>
        <DashboardMetric
          label="Ready"
          value={dashboard.sellerReadyToLock.length}
          tone={T.accent}
          active={queue === "ready"}
          onClick={() => setQueue("ready")}
        />
        <DashboardMetric
          label="Holds"
          value={dashboard.sellerWindowShoppers.length}
          tone={T.amber}
          active={queue === "holds"}
          onClick={() => setQueue("holds")}
        />
        <DashboardMetric
          label="Live"
          value={dashboard.sellerLive.length}
          tone={T.purple}
          active={queue === "live"}
          onClick={() => setQueue("live")}
        />
        <DashboardMetric
          label="Stock"
          value={dashboard.sellerInventory.length}
          tone={T.green}
          active={queue === "stock"}
          onClick={() => setQueue("stock")}
        />
      </div>

      <SellerQueueList
        queue={queue}
        trades={activeTrades}
        onOpenTrade={onOpenTrade}
        onSellerEditListing={onSellerEditListing}
        onSellerDeleteListing={onSellerDeleteListing}
      />
    </div>
  );
}

function DashboardMetric({
  label,
  value,
  tone,
  active,
  onClick,
}: {
  label: string;
  value: number;
  tone: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        minWidth: 0,
        padding: "10px 6px",
        background: active ? `${tone}22` : T.surface,
        border: `1px solid ${active ? tone : value > 0 ? tone + "44" : T.border}`,
        borderRadius: T.rs,
        cursor: "pointer",
      }}
    >
      <div style={{
        fontFamily: T.mono,
        color: tone,
        fontSize: 20,
        fontWeight: 900,
        lineHeight: 1,
        marginBottom: 5,
      }}>
        {value.toLocaleString()}
      </div>
      <div style={{
        fontFamily: T.mono,
        color: value > 0 ? T.text : T.muted,
        fontSize: 9,
        fontWeight: 800,
        textTransform: "uppercase",
        letterSpacing: 0.6,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap" as const,
      }}>
        {label}
      </div>
    </button>
  );
}

function SellerQueueList({
  queue,
  trades,
  onOpenTrade,
  onSellerEditListing,
  onSellerDeleteListing,
}: {
  queue: SellerQueueKey;
  trades: EscrowState[];
  onOpenTrade: (id: string) => void;
  onSellerEditListing?: (id: string) => void;
  onSellerDeleteListing?: (id: string) => void | Promise<void>;
}) {
  const tone = sellerQueueTone(queue);
  const emptyCopy = queue === "stock"
    ? "No open inventory right now."
    : queue === "live"
      ? "No live seller orders right now."
      : queue === "holds"
        ? "No buyers browsing your listings right now."
        : "No orders are finalized for lock yet.";

  if (trades.length === 0) {
    return (
      <div style={{
        padding: 12,
        background: T.surface,
        border: `1px dashed ${T.border}`,
        borderRadius: T.rs,
        fontFamily: T.mono,
        color: T.muted,
        fontSize: 10,
        textAlign: "center" as const,
      }}>
        {emptyCopy}
      </div>
    );
  }

  return (
    <div style={{
      background: T.surface,
      border: `1px solid ${tone}44`,
      borderRadius: T.rs,
      overflow: "hidden",
    }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        padding: "10px 12px",
        borderBottom: `1px solid ${T.border}`,
      }}>
        <div style={{
          fontFamily: T.mono,
          color: tone,
          fontSize: 10,
          fontWeight: 900,
          textTransform: "uppercase",
          letterSpacing: 1,
        }}>
          {SELLER_QUEUE_LABEL[queue]} queue
        </div>
        <div style={{
          fontFamily: T.mono,
          color: T.muted,
          fontSize: 10,
        }}>
          {trades.length.toLocaleString()} item{trades.length === 1 ? "" : "s"}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {trades.map((trade, index) => (
          <SellerQueueItem
            key={trade.id}
            trade={trade}
            queue={queue}
            last={index === trades.length - 1}
            onOpenTrade={onOpenTrade}
            onSellerEditListing={onSellerEditListing}
            onSellerDeleteListing={onSellerDeleteListing}
          />
        ))}
      </div>
    </div>
  );
}

function SellerQueueItem({
  trade,
  queue,
  last,
  onOpenTrade,
  onSellerEditListing,
  onSellerDeleteListing,
}: {
  trade: EscrowState;
  queue: SellerQueueKey;
  last: boolean;
  onOpenTrade: (id: string) => void;
  onSellerEditListing?: (id: string) => void;
  onSellerDeleteListing?: (id: string) => void | Promise<void>;
}) {
  const canDelete = trade.status === EscrowStatus.CREATED && Boolean(onSellerDeleteListing);
  const canEdit = trade.status === EscrowStatus.CREATED && Boolean(onSellerEditListing);

  return (
    <div style={{
      padding: "12px",
      borderBottom: last ? "none" : `1px solid ${T.border}`,
    }}>
      <div style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 12,
        marginBottom: 10,
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontFamily: T.sans,
            color: T.text,
            fontSize: 13,
            fontWeight: 850,
            whiteSpace: "nowrap" as const,
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}>
            {trade.description}
          </div>
          <div style={{
            marginTop: 3,
            fontFamily: T.mono,
            color: T.muted,
            fontSize: 10,
            whiteSpace: "nowrap" as const,
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}>
            {sellerQueueStatus(queue, trade)}
          </div>
        </div>
        <div style={{
          flexShrink: 0,
        }}>
          <BitcoinAmount
            msats={trade.amountMsats}
            size={12}
            color={sellerQueueTone(queue)}
            gap={4}
            glyphScale={1.18}
          />
        </div>
      </div>
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
        gap: 6,
      }}>
        <SellerActionButton label="View" tone={T.text} onClick={() => onOpenTrade(trade.id)} />
        <SellerActionButton
          label="Edit"
          tone={T.amber}
          disabled={!canEdit}
          onClick={() => onSellerEditListing?.(trade.id)}
        />
        <SellerActionButton
          label={canDelete ? "Delete" : "Locked"}
          tone={canDelete ? T.red : T.muted}
          disabled={!canDelete}
          onClick={() => onSellerDeleteListing?.(trade.id)}
        />
      </div>
    </div>
  );
}

function SellerActionButton({
  label,
  tone,
  disabled = false,
  onClick,
}: {
  label: string;
  tone: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "8px 6px",
        borderRadius: T.rs,
        background: disabled ? T.bg : T.card,
        border: `1px solid ${disabled ? T.border : tone + "55"}`,
        color: disabled ? T.muted : tone,
        fontFamily: T.mono,
        fontSize: 10,
        fontWeight: 900,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.65 : 1,
      }}
    >
      {label}
    </button>
  );
}

type ArbiterQueueKey = "needs" | "watching" | "settled";

const ARBITER_QUEUE_LABEL: Record<ArbiterQueueKey, string> = {
  needs: "Needs decision",
  watching: "Watching",
  settled: "Settled",
};

function ArbiterDashboardPanel({
  dashboard,
  onOpenTrade,
  viewerPubkey,
}: {
  dashboard: MeDashboardModel;
  onOpenTrade: (id: string) => void;
  viewerPubkey: string;
}) {
  const [queue, setQueue] = useState<ArbiterQueueKey>(() => firstArbiterQueue(dashboard));
  useEffect(() => {
    if (arbiterQueueTrades(dashboard, queue).length > 0) return;
    setQueue(firstArbiterQueue(dashboard));
  }, [dashboard, queue]);
  const activeTrades = arbiterQueueTrades(dashboard, queue);

  return (
    <div style={{
      marginTop: 14,
      paddingTop: 14,
      borderTop: `1px solid ${T.border}`,
    }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: 12, marginBottom: 10,
      }}>
        <div>
          <div style={{
            fontFamily: T.mono, color: ROLE_COLOR.arbiter, fontSize: 10,
            fontWeight: 900, letterSpacing: 1, textTransform: "uppercase",
          }}>
            Arbiter dashboard
          </div>
          <div style={{
            marginTop: 3,
            fontFamily: T.sans, color: T.text, fontSize: 15,
            fontWeight: 800,
          }}>
            Disputes and watched trades
          </div>
        </div>
        <div style={{
          fontFamily: T.mono, color: T.muted, fontSize: 10,
          lineHeight: 1.35, textAlign: "right" as const,
        }}>
          listed arbiter<br />
          BLF pool
        </div>
      </div>

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
        gap: 6,
        marginBottom: 12,
      }}>
        <DashboardMetric
          label="Needs"
          value={dashboard.arbiterDisputes.length}
          tone={T.red}
          active={queue === "needs"}
          onClick={() => setQueue("needs")}
        />
        <DashboardMetric
          label="Watching"
          value={dashboard.arbiterWatching.length}
          tone={ROLE_COLOR.arbiter}
          active={queue === "watching"}
          onClick={() => setQueue("watching")}
        />
        <DashboardMetric
          label="Settled"
          value={dashboard.arbiterSettled.length}
          tone={T.green}
          active={queue === "settled"}
          onClick={() => setQueue("settled")}
        />
      </div>

      <ArbiterQueueList
        queue={queue}
        trades={activeTrades}
        onOpenTrade={onOpenTrade}
        viewerPubkey={viewerPubkey}
      />
    </div>
  );
}

function ArbiterQueueList({
  queue,
  trades,
  onOpenTrade,
  viewerPubkey,
}: {
  queue: ArbiterQueueKey;
  trades: EscrowState[];
  onOpenTrade: (id: string) => void;
  viewerPubkey: string;
}) {
  const tone = arbiterQueueTone(queue);
  const emptyCopy = queue === "needs"
    ? "No disputes need your decision right now."
    : queue === "watching"
      ? "No pool trades to watch right now."
      : "No settled arbiter history yet.";

  if (trades.length === 0) {
    return (
      <div style={{
        padding: 12,
        background: T.surface,
        border: `1px dashed ${T.border}`,
        borderRadius: T.rs,
        fontFamily: T.mono,
        color: T.muted,
        fontSize: 10,
        textAlign: "center" as const,
      }}>
        {emptyCopy}
      </div>
    );
  }

  return (
    <div style={{
      background: T.surface,
      border: `1px solid ${tone}44`,
      borderRadius: T.rs,
      overflow: "hidden",
    }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        padding: "10px 12px",
        borderBottom: `1px solid ${T.border}`,
      }}>
        <div style={{
          fontFamily: T.mono,
          color: tone,
          fontSize: 10,
          fontWeight: 900,
          textTransform: "uppercase",
          letterSpacing: 1,
        }}>
          {ARBITER_QUEUE_LABEL[queue]}
        </div>
        <div style={{
          fontFamily: T.mono,
          color: T.muted,
          fontSize: 10,
        }}>
          {trades.length.toLocaleString()} trade{trades.length === 1 ? "" : "s"}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {trades.map((trade, index) => (
          <ArbiterQueueItem
            key={trade.id}
            trade={trade}
            queue={queue}
            last={index === trades.length - 1}
            onOpenTrade={onOpenTrade}
            viewerPubkey={viewerPubkey}
          />
        ))}
      </div>
    </div>
  );
}

function ArbiterQueueItem({
  trade,
  queue,
  last,
  onOpenTrade,
  viewerPubkey,
}: {
  trade: EscrowState;
  queue: ArbiterQueueKey;
  last: boolean;
  onOpenTrade: (id: string) => void;
  viewerPubkey: string;
}) {
  const tone = arbiterQueueTone(queue);
  const participants = getEffectiveParticipantsAt(trade);

  return (
    <div style={{
      padding: "12px",
      borderBottom: last ? "none" : `1px solid ${T.border}`,
    }}>
      <div style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 12,
        marginBottom: 10,
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontFamily: T.sans,
            color: T.text,
            fontSize: 13,
            fontWeight: 850,
            whiteSpace: "nowrap" as const,
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}>
            {trade.description}
          </div>
          <div style={{
            marginTop: 3,
            fontFamily: T.mono,
            color: T.muted,
            fontSize: 10,
            whiteSpace: "nowrap" as const,
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}>
            {arbiterQueueStatus(queue, trade, viewerPubkey)}
          </div>
        </div>
        <div style={{
          flexShrink: 0,
        }}>
          <BitcoinAmount
            msats={trade.amountMsats}
            size={12}
            color={tone}
            gap={4}
            glyphScale={1.18}
          />
        </div>
      </div>

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
        gap: 6,
        marginBottom: 8,
      }}>
        <VoteChip label="Buyer" outcome={trade.votes[Role.BUYER]} />
        <VoteChip label="Seller" outcome={trade.votes[Role.SELLER]} />
        <VoteChip label="You" outcome={trade.votes[Role.ARBITER]} />
      </div>

      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
      }}>
        <div style={{
          minWidth: 0,
          fontFamily: T.mono,
          color: T.muted,
          fontSize: 9,
          whiteSpace: "nowrap" as const,
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}>
          B {shortPubkey(participants[Role.BUYER])} · S {shortPubkey(participants[Role.SELLER])}
        </div>
        <SellerActionButton
          label={queue === "needs" ? "Decide" : "View"}
          tone={tone}
          onClick={() => onOpenTrade(trade.id)}
        />
      </div>
    </div>
  );
}

function VoteChip({ label, outcome }: { label: string; outcome?: Outcome }) {
  const tone = outcome === Outcome.RELEASE
    ? T.green
    : outcome === Outcome.REFUND
      ? T.amber
      : T.muted;
  const text = outcome === Outcome.RELEASE
    ? "release"
    : outcome === Outcome.REFUND
      ? "refund"
      : "pending";

  return (
    <div style={{
      minWidth: 0,
      padding: "6px 6px",
      borderRadius: T.rs,
      background: T.card,
      border: `1px solid ${outcome ? tone + "55" : T.border}`,
      fontFamily: T.mono,
      fontSize: 9,
      color: tone,
      textTransform: "uppercase",
      letterSpacing: 0.4,
      whiteSpace: "nowrap" as const,
      overflow: "hidden",
      textOverflow: "ellipsis",
      textAlign: "center" as const,
    }}>
      {label} · {text}
    </div>
  );
}

function DashboardRow({
  label,
  value,
  hint,
  tone,
  onClick,
  last = false,
}: {
  label: string;
  value: string;
  hint: string;
  tone: string;
  onClick?: () => void;
  last?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      style={{
        width: "100%",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: 12, padding: "12px 0",
        background: "none", border: "none",
        borderBottom: last ? "none" : `1px solid ${T.border}`,
        cursor: onClick ? "pointer" : "default", textAlign: "left" as const,
        color: T.text,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontFamily: T.sans, fontSize: 14, fontWeight: 800,
          color: T.text, marginBottom: 3,
        }}>
          {label}
        </div>
        <div style={{
          fontFamily: T.mono, fontSize: 10, color: T.muted,
          lineHeight: 1.45,
        }}>
          {hint}
        </div>
      </div>
      <div style={{
        flexShrink: 0, display: "flex", alignItems: "center", gap: 7,
        color: tone, fontFamily: T.mono, fontSize: 11, fontWeight: 900,
      }}>
        {value}
        {onClick && <span style={{ color: T.muted, fontSize: 14 }}>›</span>}
      </div>
    </button>
  );
}

function firstSellerQueue(dashboard: MeDashboardModel): SellerQueueKey {
  if (dashboard.sellerReadyToLock.length > 0) return "ready";
  if (dashboard.sellerWindowShoppers.length > 0) return "holds";
  if (dashboard.sellerLive.length > 0) return "live";
  return "stock";
}

function sellerQueueTrades(dashboard: MeDashboardModel, queue: SellerQueueKey): EscrowState[] {
  if (queue === "ready") return dashboard.sellerReadyToLock;
  if (queue === "holds") return dashboard.sellerWindowShoppers;
  if (queue === "live") return dashboard.sellerLive;
  return dashboard.sellerInventory;
}

function sellerQueueTone(queue: SellerQueueKey): string {
  if (queue === "ready") return T.accent;
  if (queue === "holds") return T.amber;
  if (queue === "live") return T.purple;
  return T.green;
}

function sellerQueueStatus(queue: SellerQueueKey, trade: EscrowState): string {
  const itemSummary = selectedOrMenuSummary(trade);
  if (queue === "ready") {
    return `${itemSummary ?? "order finalized"} · waiting for your lock`;
  }
  if (queue === "holds") {
    return `${itemSummary ?? "buyer browsing"} · waiting for checkout`;
  }
  if (queue === "live") {
    return `${trade.status.toLowerCase()} · ${itemSummary ?? "money moving"}`;
  }
  return itemSummary ?? "single listing";
}

function firstArbiterQueue(dashboard: MeDashboardModel): ArbiterQueueKey {
  if (dashboard.arbiterDisputes.length > 0) return "needs";
  if (dashboard.arbiterWatching.length > 0) return "watching";
  return "settled";
}

function arbiterQueueTrades(dashboard: MeDashboardModel, queue: ArbiterQueueKey): EscrowState[] {
  if (queue === "needs") return dashboard.arbiterDisputes;
  if (queue === "watching") return dashboard.arbiterWatching;
  return dashboard.arbiterSettled;
}

function arbiterQueueTone(queue: ArbiterQueueKey): string {
  if (queue === "needs") return T.red;
  if (queue === "watching") return ROLE_COLOR.arbiter;
  return T.green;
}

function arbiterQueueStatus(queue: ArbiterQueueKey, trade: EscrowState, viewerPubkey?: string): string {
  if (queue === "needs") {
    if (trade.status === EscrowStatus.EXPIRED) {
      return `${arbiterDisputeLine(trade)} · expired unresolved — open it to heal (auto-refunds the locker)`;
    }
    // Arbiter substitution: a BACKUP viewing a pooled-lock dispute sees the
    // assigned arbiter's floor countdown, then the step-in invitation.
    const assigned = getEffectiveParticipantsAt(trade)[Role.ARBITER];
    if (
      viewerPubkey && trade.lock.arbiterPoolShare && assigned !== viewerPubkey
    ) {
      const eligibleAt = substitutionEligibleAt(trade);
      const nowSec = Math.floor(Date.now() / 1000);
      if (eligibleAt !== null && nowSec < eligibleAt) {
        return `${arbiterDisputeLine(trade)} · assigned arbiter has the floor · you can step in ${formatStepInCountdown(eligibleAt - nowSec)}`;
      }
      return `${arbiterDisputeLine(trade)} · assigned arbiter absent · step in as backup`;
    }
    return `${arbiterDisputeLine(trade)} · decision needed`;
  }
  if (queue === "watching") {
    return `${arbiterDisputeLine(trade)} · ${trade.status.toLowerCase()}`;
  }
  return `${trade.status.toLowerCase()} · ${trade.resolvedOutcome ?? "no outcome"}`;
}

function arbiterDisputeLine(trade: EscrowState): string {
  const buyer = voteText(trade.votes[Role.BUYER]);
  const seller = voteText(trade.votes[Role.SELLER]);
  return `buyer ${buyer} · seller ${seller}`;
}

function voteText(outcome?: Outcome): string {
  if (outcome === Outcome.RELEASE) return "release";
  if (outcome === Outcome.REFUND) return "refund";
  return "pending";
}

// v2.3.1 — the deliberate "change your Chama" surface. The Browse pill is now
// view-only; switching lives here so it's an intentional, between-trades act.
// While the user is party to a live trade, switching is held back with a clear
// reason (their locked shares live on the current Chama; a switch would strand
// the claim until they switch back — the data-layer gate is tracked as a
// follow-up). Idle → pick freely; the same funds-at-risk destroy-confirm guard
// the pill used to fire still applies downstream via onSelectCommunity.
function YourChamaCard({
  communitySlug,
  hasActiveCommitment,
  onSelectCommunity,
}: {
  communitySlug: string | null;
  hasActiveCommitment: boolean;
  onSelectCommunity: (slug: string) => void;
}) {
  const [changing, setChanging] = useState(false);
  const current = communitySlug ? getCommunityBySlug(communitySlug) : null;
  const communities = [...getPickerCommunities()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }),
  );

  return (
    <div style={{
      background: T.card, border: `1px solid ${T.border}`,
      borderRadius: T.r, padding: 20, marginBottom: 16,
    }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: 12,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono, letterSpacing: 1,
        }}>
          YOUR CHAMA
        </div>
        {!hasActiveCommitment && (
          <button
            onClick={() => setChanging((v) => !v)}
            style={{
              background: changing ? T.surface : T.accentDim,
              border: `1px solid ${changing ? T.border : T.accent + "66"}`,
              color: changing ? T.muted : T.accent,
              fontFamily: T.mono, fontSize: 10, fontWeight: 800, letterSpacing: 0.5,
              padding: "5px 10px", borderRadius: T.rs, cursor: "pointer",
            }}
          >
            {changing ? "Cancel" : "Change →"}
          </button>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ fontSize: 24, lineHeight: 1 }}>{current?.flagEmoji ?? "🌐"}</span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, color: T.text, fontFamily: T.sans, fontWeight: 600 }}>
            {current?.disambiguator ?? current?.displayName ?? "Global"}
          </div>
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono }}>
            {current?.currency ?? "USD"}
          </div>
        </div>
      </div>

      {hasActiveCommitment && (
        <div style={{
          marginTop: 12, padding: "9px 11px", borderRadius: T.rs,
          background: T.amberDim, border: `1px solid ${T.amber}44`,
          fontSize: 10, color: T.muted, fontFamily: T.mono, lineHeight: 1.5,
        }}>
          You have a live trade. Finish it before switching — your locked sats
          live on this Chama, and a switch would put your claim on hold until you
          switch back.
        </div>
      )}

      {changing && !hasActiveCommitment && (
        <div style={{
          marginTop: 12, display: "flex", flexWrap: "wrap" as const, gap: 6,
        }}>
          {communities.map((c) => {
            const active = c.slug === communitySlug;
            return (
              <button
                key={c.slug}
                onClick={() => {
                  setChanging(false);
                  if (!active) onSelectCommunity(c.slug);
                }}
                style={{
                  padding: "7px 12px", borderRadius: 18,
                  background: active ? T.tealDim : T.surface,
                  border: `1px solid ${active ? T.teal + "66" : T.border}`,
                  color: active ? T.teal : T.muted,
                  fontFamily: T.mono, fontSize: 11, fontWeight: 600,
                  cursor: active ? "default" : "pointer",
                  whiteSpace: "nowrap" as const,
                }}
              >
                {c.flagEmoji} {c.disambiguator ?? c.displayName} · {c.currency}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function buildMeDashboard(
  myTrades: EscrowState[],
  allTrades: EscrowState[],
  pubkey: string,
  nowSec: number,
): MeDashboardModel {
  const lowerPubkey = pubkey.toLowerCase();
  const needsYou: EscrowState[] = [];
  const sellerOpen: EscrowState[] = [];
  const sellerLive: EscrowState[] = [];
  const sellerInventory: EscrowState[] = [];
  const sellerWindowShoppers: EscrowState[] = [];
  const sellerReadyToLock: EscrowState[] = [];
  const arbiterDisputes: EscrowState[] = [];
  const arbiterWatching: EscrowState[] = [];
  const arbiterSettled: EscrowState[] = [];
  let arbiterVisible = BLF_OFFICIAL_ARBITERS.includes(lowerPubkey);

  for (const trade of allTrades) {
    const isPoolArbiter = trade.communityArbiters.some((pk) => pk.toLowerCase() === lowerPubkey);
    if (isPoolArbiter) {
      arbiterVisible = true;
    }
    const role = getUserRoleForTrade(trade, pubkey, nowSec);
    const isAssignedArbiter = role === Role.ARBITER;
    const watchesAsArbiter = isAssignedArbiter || isPoolArbiter;

    if (watchesAsArbiter) {
      // Arbiter substitution: a pool BACKUP also lands in "needs" on a
      // pooled-share lock with a live dispute and an open arbiter slot —
      // first showing the assigned arbiter's floor countdown, then the
      // step-in affordance once it lapses (decideVotePrompt gates the
      // actual buttons; the reducer re-enforces everything).
      const substitutionCandidate =
        !isAssignedArbiter &&
        trade.status === EscrowStatus.LOCKED &&
        trade.lock.arbiterPoolShare === true &&
        tradeHasBuyerSellerDispute(trade) &&
        trade.votes[Role.ARBITER] === undefined &&
        arbiterVotePriority(trade, pubkey) !== null;
      // The field-found visibility gap: an EXPIRED-but-unresolved trade is the
      // MOST arbiter-needing state there is (funds blocked until a healing
      // vote), yet the LOCKED-only check above dropped it to WATCHING — zero
      // red anywhere while sats sat in limbo. Surface healable trades in NEEDS
      // for the assigned arbiter and (on pooled locks) for pool backups whose
      // own vote isn't already in the chain. Opening the trade auto-heals.
      const healableExpired =
        (trade.status === EscrowStatus.EXPIRED ||
          (trade.status === EscrowStatus.LOCKED &&
            trade.expiresAt > 0 &&
            nowSec > trade.expiresAt)) &&
        !trade.eventChain.some((e) => e.kind === EscrowEventKind.RESOLVE);
      const canHealIt =
        healableExpired &&
        (isAssignedArbiter
          ? !trade.eventChain.some(
              (e) => e.kind === EscrowEventKind.VOTE && e.pubkey === pubkey,
            )
          : trade.lock.arbiterPoolShare === true &&
            arbiterVotePriority(trade, pubkey) !== null &&
            !trade.eventChain.some(
              (e) => e.kind === EscrowEventKind.VOTE && e.pubkey === pubkey,
            ));
      if (
        (isAssignedArbiter &&
          trade.status === EscrowStatus.LOCKED &&
          tradeHasBuyerSellerDispute(trade) &&
          !trade.votes[Role.ARBITER]) ||
        substitutionCandidate ||
        canHealIt
      ) {
        arbiterDisputes.push(trade);
      } else if (isArbiterSettledTrade(trade)) {
        arbiterSettled.push(trade);
      } else {
        arbiterWatching.push(trade);
      }
    }
  }

  for (const trade of myTrades) {
    const role = getUserRoleForTrade(trade, pubkey, nowSec);
    if (role === Role.SELLER && trade.status === EscrowStatus.CREATED) {
      sellerOpen.push(trade);
      const sellerOrderState = getSellerOrderState(trade, nowSec);
      if (sellerOrderState === "ready") {
        sellerReadyToLock.push(trade);
      } else if (sellerOrderState === "hold") {
        sellerWindowShoppers.push(trade);
      } else {
        sellerInventory.push(trade);
      }
    }
    if (
      role === Role.SELLER &&
      (trade.status === EscrowStatus.LOCKED ||
        trade.status === EscrowStatus.APPROVED ||
        trade.status === EscrowStatus.CLAIMED)
    ) {
      sellerLive.push(trade);
    }

    if (tradeNeedsUser(trade, pubkey, role)) {
      needsYou.push(trade);
    }
  }

  return {
    needsYou,
    sellerOpen,
    sellerLive,
    sellerInventory,
    sellerWindowShoppers,
    sellerReadyToLock,
    arbiterVisible,
    arbiterDisputes,
    arbiterWatching,
    arbiterSettled,
  };
}

function getSellerOrderState(
  trade: EscrowState,
  nowSec: number,
): "inventory" | "hold" | "ready" {
  const buyer = getEffectiveParticipantAt(trade, Role.BUYER, nowSec);
  if (!buyer) return "inventory";
  const hold = trade.joinHolds?.[Role.BUYER];
  if (trade.items && trade.items.length > 0) {
    return hold?.orderFinalizedAt ? "ready" : "hold";
  }
  return "ready";
}

function selectedOrMenuSummary(trade: EscrowState): string | null {
  const selectedItems = trade.joinHolds?.[Role.BUYER]?.selectedItems
    ?? trade.lock.selectedItems
    ?? [];
  if (selectedItems.length > 0) return selectedItemsSummary(selectedItems);
  const menuCount = trade.items?.length ?? 0;
  if (menuCount === 0) return null;
  if (trade.category === "bill-pay") return `${menuCount} bill${menuCount === 1 ? "" : "s"}`;
  if (trade.category === "lending") return `${menuCount} loan${menuCount === 1 ? "" : "s"}`;
  if (trade.category === "marketplace") return `${menuCount} item${menuCount === 1 ? "" : "s"}`;
  return `${menuCount} option${menuCount === 1 ? "" : "s"}`;
}

function selectedItemsSummary(items: SelectedMenuItem[]): string {
  if (items.length === 1) {
    const item = items[0];
    return `${item.label}${item.quantity > 1 ? ` x${item.quantity}` : ""}`;
  }
  return `${items.length} selected`;
}


function getUserRoleForTrade(
  trade: EscrowState,
  pubkey: string,
  nowSec: number,
): Role | null {
  const lowerPubkey = pubkey.toLowerCase();
  const participants = getEffectiveParticipantsAt(trade, nowSec);
  if (participants[Role.BUYER]?.toLowerCase() === lowerPubkey) return Role.BUYER;
  if (participants[Role.SELLER]?.toLowerCase() === lowerPubkey) return Role.SELLER;
  if (participants[Role.ARBITER]?.toLowerCase() === lowerPubkey) return Role.ARBITER;
  return null;
}

function tradeNeedsUser(trade: EscrowState, pubkey: string, role: Role | null): boolean {
  if (trade.status === EscrowStatus.APPROVED) {
    return getWinner(trade)?.pubkey === pubkey;
  }
  if (trade.status !== EscrowStatus.LOCKED || role === null) return false;
  if ((role === Role.BUYER || role === Role.SELLER) && !trade.votes[role]) return true;
  return role === Role.ARBITER && tradeHasBuyerSellerDispute(trade) && !trade.votes[Role.ARBITER];
}

function tradeHasBuyerSellerDispute(trade: EscrowState): boolean {
  const buyerVote = trade.votes[Role.BUYER];
  const sellerVote = trade.votes[Role.SELLER];
  return (
    (buyerVote === Outcome.RELEASE || buyerVote === Outcome.REFUND) &&
    (sellerVote === Outcome.RELEASE || sellerVote === Outcome.REFUND) &&
    buyerVote !== sellerVote
  );
}

function isArbiterSettledTrade(trade: EscrowState): boolean {
  return (
    trade.status === EscrowStatus.APPROVED ||
    trade.status === EscrowStatus.CLAIMED ||
    trade.status === EscrowStatus.COMPLETED ||
    trade.status === EscrowStatus.EXPIRED ||
    trade.status === EscrowStatus.CANCELLED
  );
}

function shortPubkey(pubkey: string | null | undefined): string {
  if (!pubkey) return "empty";
  return pubkey.slice(0, 6) + "…";
}

function buildMeTradeCounts(
  trades: EscrowState[],
  needsYou: EscrowState[],
): MeTradeCounts {
  return {
    all: trades.length,
    needs: needsYou.length,
    live: trades.filter(isLiveTrade).length,
    listings: trades.filter(isOpenListing).length,
    done: trades.filter(isDoneTrade).length,
  };
}

function filterMeTrades(
  trades: EscrowState[],
  needsYou: EscrowState[],
  filter: MeTradeFilter,
): EscrowState[] {
  const needsYouIds = new Set(needsYou.map((trade) => trade.id));
  if (filter === "needs") return trades.filter((trade) => needsYouIds.has(trade.id));
  if (filter === "live") return trades.filter(isLiveTrade);
  if (filter === "listings") return trades.filter(isOpenListing);
  if (filter === "done") return trades.filter(isDoneTrade);
  return trades;
}

function isLiveTrade(trade: EscrowState): boolean {
  return (
    trade.status === EscrowStatus.LOCKED ||
    trade.status === EscrowStatus.APPROVED ||
    trade.status === EscrowStatus.CLAIMED
  );
}

function isOpenListing(trade: EscrowState): boolean {
  return trade.status === EscrowStatus.CREATED;
}

function isDoneTrade(trade: EscrowState): boolean {
  return (
    trade.status === EscrowStatus.COMPLETED ||
    trade.status === EscrowStatus.EXPIRED ||
    trade.status === EscrowStatus.CANCELLED
  );
}

// #88: single on/off for trade-event notifications (locked / claim ready /
// dispute / settled). Default on; the OS permission is the real gate, so
// flipping it on proactively asks. Self-contained — no prop threading.
function NotificationsRow() {
  const [on, setOn] = useState<boolean>(() => notificationsEnabled());
  const toggle = () => {
    const next = !on;
    setOn(next);
    setNotificationsEnabled(next);
    if (next) void ensureNotificationPermission();
  };
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      gap: 10, padding: "14px 16px", borderBottom: `1px solid ${T.border}`,
    }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: T.text, fontFamily: T.sans }}>
          Notifications
        </div>
        <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginTop: 2 }}>
          Locked · claim ready · disputes · settled
        </div>
      </div>
      <button
        onClick={toggle}
        role="switch"
        aria-checked={on}
        style={{
          width: 46, height: 26, borderRadius: 999, position: "relative",
          border: `1px solid ${on ? T.green + "66" : T.border}`,
          background: on ? T.green + "33" : T.surface,
          cursor: "pointer", transition: "background 0.15s, border-color 0.15s",
        }}
      >
        <span style={{
          position: "absolute", top: 2, left: on ? 22 : 2,
          width: 20, height: 20, borderRadius: "50%",
          background: on ? T.green : T.muted, transition: "left 0.15s",
        }} />
      </button>
    </div>
  );
}

function SettingsRow({ label, hint, onClick, danger }: {
  label: string; hint: string | null; onClick: () => void; danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        width: "100%", padding: "14px 16px",
        background: "none", border: "none", borderBottom: `1px solid ${T.border}`,
        color: danger ? T.red : T.text,
        cursor: "pointer", textAlign: "left" as const,
        fontFamily: T.sans,
      }}
    >
      <div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div>
        {hint && (
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginTop: 2 }}>
            {hint}
          </div>
        )}
      </div>
      <span style={{ color: T.muted, fontSize: 16 }}>›</span>
    </button>
  );
}

// ── V3 #74: the arbiter on-ramp — CTA + FAQ + signed application ────────────
// Field-read I: "a small CTA widget... the human on-ramp to consensus
// admission. It makes the recruitment path visible instead of tribal
// knowledge." Publishing signs a kind:38121 event the community's roster
// steward reviews; the FAQ is honest that community-wide admission VOTING
// comes later (kind:38122 reserved).
function ArbiterCtaCard({
  communitySlug,
  onApply,
}: {
  communitySlug: string;
  onApply: (community: string, statement: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [statement, setStatement] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fedInvite, setFedInvite] = useState("");
  const community = getCommunityBySlug(communitySlug);
  const displayName = community?.displayName ?? communitySlug;

  const submit = async () => {
    if (!statement.trim()) {
      setError("Tell the community why — the statement IS the application.");
      return;
    }
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      // v3.1 A3: fed operators are the strongest anchors — carry the invite +
      // steward key inside the statement text (no kind:38121 schema change).
      const fullStatement = fedInvite.trim()
        ? `${statement.trim()}\n\nFederation operator — invite + steward key: ${fedInvite.trim()}`
        : statement;
      await onApply(communitySlug, fullStatement);
      setStatus("Application signed and published. The community steward reviews it from their roster surface.");
      setStatement("");
      setFedInvite("");
    } catch (e: any) {
      setError(e?.message || "Couldn't publish the application. Check relays and retry.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      background: T.card, border: `1px solid ${T.border}`,
      borderRadius: T.r, marginBottom: 16, overflow: "hidden",
    }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          width: "100%", padding: "14px 16px",
          background: "none", border: "none", cursor: "pointer", textAlign: "left",
        }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: T.text, fontFamily: T.sans }}>
            ⚖ Become a community arbiter
          </div>
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginTop: 2 }}>
            Keep {displayName} trades fair — duty pays
          </div>
        </div>
        <span style={{ color: T.muted, fontSize: 16 }}>{open ? "▾" : "›"}</span>
      </button>
      {open && (
        <div style={{ padding: "0 16px 16px" }}>
          <div style={{
            fontSize: 11, color: T.muted, fontFamily: T.sans, lineHeight: 1.6,
            padding: "10px 12px", borderRadius: T.rs, marginBottom: 10,
            background: T.surface, border: `1px solid ${T.border}`,
          }}>
            Arbiters are the community's neutral third key. You vote only when
            buyer and seller disagree, inside a response window — and the
            dispute fee (1.5%, split-paid by both parties) is yours for the
            work. Show up and rule fairly: presence will be bonded and
            fairness is your public rating. Today the community steward
            reviews applications and signs the roster; community-wide
            admission voting comes in a later release.
          </div>
          <textarea
            value={statement}
            onChange={e => setStatement(e.target.value)}
            placeholder={`Why you? Languages, availability, how ${displayName} knows you…`}
            rows={3}
            maxLength={800}
            style={{
              width: "100%", boxSizing: "border-box", resize: "vertical",
              padding: "10px 12px", borderRadius: T.rs, marginBottom: 8,
              background: T.surface, border: `1px solid ${T.border}`,
              color: T.text, fontFamily: T.sans, fontSize: 12, lineHeight: 1.5,
            }}
          />
          {/* v3.1 A3: federation-owner credential — the premier "proof of work"
              anchor path. Form + copy only; the invite rides in the statement. */}
          <div style={{
            marginBottom: 8, padding: "10px 12px", borderRadius: T.rs,
            background: `${ROLE_COLOR.arbiter}0f`, border: `1px solid ${ROLE_COLOR.arbiter}33`,
          }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: ROLE_COLOR.arbiter, fontFamily: T.mono, marginBottom: 4, letterSpacing: 0.5 }}>
              🏰 RUN YOUR OWN FEDERATION?
            </div>
            <div style={{ fontSize: 10.5, color: T.muted, fontFamily: T.sans, lineHeight: 1.45, marginBottom: 8 }}>
              Federation operators are the strongest anchors — the premier proof-of-work path. Paste your invite + steward key and the steward can fast-track you.
            </div>
            <input
              value={fedInvite}
              onChange={e => setFedInvite(e.target.value)}
              placeholder="fed1… invite + steward npub / key (optional)"
              style={{
                width: "100%", boxSizing: "border-box",
                padding: "9px 11px", borderRadius: T.rs,
                background: T.surface, border: `1px solid ${T.border}`,
                color: T.text, fontFamily: T.mono, fontSize: 12,
              }}
            />
          </div>
          <button
            onClick={submit}
            disabled={busy}
            style={{
              padding: "10px 14px", borderRadius: T.rs,
              border: `1px solid ${ROLE_COLOR.arbiter}66`, background: `${ROLE_COLOR.arbiter}22`,
              color: ROLE_COLOR.arbiter, fontFamily: T.mono, fontSize: 11, fontWeight: 800,
              cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? "Publishing…" : "Sign + send application"}
          </button>
          {status && (
            <div style={{ marginTop: 8, fontSize: 11, color: T.green, fontFamily: T.mono }}>
              ✓ {status}
            </div>
          )}
          {error && (
            <div style={{ marginTop: 8, fontSize: 11, color: T.red, fontFamily: T.mono }}>
              ⚠ {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
