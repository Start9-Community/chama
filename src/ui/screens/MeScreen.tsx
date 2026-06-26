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
import {
  DEFAULT_COMMUNITY_SLUG,
  addCustomCommunity,
  getCommunityBySlug,
} from "../../communities/registry.js";
import { getAllPickerCountries, type PickerCountry } from "../../communities/countries.js";
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
import { listStrandedRedemptions, partitionStrandedClaims, resolveUnresolvedCredit, type StrandedRedemption } from "../../fedimint/pending-redemptions.js";
import { T, ROLE_COLOR, type ThemeMode } from "../theme.js";
import {
  notificationsEnabled,
  setNotificationsEnabled,
  ensureNotificationPermission,
  dmNotifyPref,
  setDmNotifyPref,
  type DmNotifyPref,
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
  onRefreshTrades,
  onSellerEditListing,
  onSellerDeleteListing,
  onOpenSavedHandles,
  onOpenPayoutDestinations,
  onOpenAdvanced,
  onOpenHelp,
  balanceMsats,
  hasActiveCommitment,
  satsTrace,
  onRecoverSats,
  onWithdrawEcash,
  onSignOut,
  communitySlug,
  onSelectCommunity,
  onRateCounterparty,
  myGivenRatings,
  onExportStrandedClaim,
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
  /** Manual "refresh my trades" pull — re-runs active relay discovery and
   *  hydrates any trades missing from the local list. Returns how many were
   *  added (for a toast). */
  onRefreshTrades?: () => Promise<number> | void;
  onSellerEditListing?: (id: string) => void;
  onSellerDeleteListing?: (id: string) => void | Promise<void>;
  onOpenSavedHandles: () => void;
  onOpenPayoutDestinations: () => void;
  onOpenAdvanced: () => void;
  onOpenHelp: () => void;
  balanceMsats: number;
  hasActiveCommitment: boolean;
  satsTrace?: SatsTraceEntry | null;
  onRecoverSats: () => void;
  /** v2.4 #56 — open the "withdraw as ecash" (fee-free Fedimint note) flow. */
  onWithdrawEcash?: () => void;
  /** v3.4.0 C13 — open the export modal for a stranded claim's bearer
   *  note (a pending-redemption entry automatic retry gave up on). */
  onExportStrandedClaim?: (entry: StrandedRedemption) => void;
  onSignOut: () => void;
  /** v2.3.1: the user's current Chama. The Browse pill is now view-only;
   *  this screen is the deliberate place to CHANGE it. */
  communitySlug?: string | null;
  /** Bound to handleSelectCommunity — switches Chama (with the same funds-at-
   *  risk destroy-confirm guard the Browse pill used to trigger). */
  onSelectCommunity?: (slug: string) => void;
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
  // v3.4.0 C13 — claims whose bearer notes automatic retry gave up on.
  // These sit in clearable localStorage while the chain reads COMPLETED;
  // without a loud surface, a data-clear or federation switch destroys
  // the only copy of the money. Rendered as the topmost alarm card.
  // v4.0.0: bump to force a re-read after a dismiss mutates the stash.
  const [, bumpStrandedTick] = useState(0);
  const strandedClaims = listStrandedRedemptions();
  // Reconcile the "unresolved-credit" sliver against the wallet balance the
  // copy already invokes — covered → resolve silently; short → calm nudge;
  // poisoned / retries-exhausted stay loud (may be live money). See
  // partitionStrandedClaims.
  const { loud: loudClaims, calm: calmClaims, reconciledIds } =
    partitionStrandedClaims(strandedClaims, balanceMsats);
  const reconciledKey = reconciledIds.join(",");
  useEffect(() => {
    if (!reconciledKey) return;
    for (const id of reconciledKey.split(",")) resolveUnresolvedCredit(id, "balance-reconciled");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconciledKey]);
  const dismissClaim = (escrowId: string) => {
    resolveUnresolvedCredit(escrowId, "user-dismissed");
    bumpStrandedTick((t) => t + 1);
  };
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

      {/* v3.4.0 C13 — stranded claim notes. INVARIANT(stranded-notes-surfaced):
          a bearer note the drain gave up on gets a persistent, actionable
          alarm — not a console line. Tap → EcashExportModal (preset mode)
          with QR + copy, so the user can move the money to safety. */}
      {/* LOUD: poisoned / retries-exhausted — the bearer note is (or may be)
          LIVE money the drain couldn't redeem. Stays a red, tap-to-export alarm;
          never balance-downgraded. */}
      {onExportStrandedClaim && loudClaims.map((entry) => (
        <div
          key={entry.escrowId}
          onClick={() => onExportStrandedClaim(entry)}
          style={{
            background: T.redDim, border: `1px solid ${T.red}88`,
            borderRadius: T.r, padding: 20, marginBottom: 16, cursor: "pointer",
            boxShadow: `0 0 30px ${T.red}22`,
          }}
        >
          <div style={{
            fontSize: 11, fontWeight: 600, color: T.red,
            fontFamily: T.mono, letterSpacing: 1, marginBottom: 8,
          }}>
            STRANDED CLAIM — ACTION NEEDED
          </div>
          <div style={{ fontSize: 13, color: T.text, fontFamily: T.sans, lineHeight: 1.5 }}>
            <BitcoinAmount sats={Math.floor(entry.amountMsats / 1000)} size={13} gap={4} glyphScale={1.18} color={T.text} glyphColor={T.muted} />
            {" "}from a settled trade couldn't land in your wallet automatically.
            The bearer note — the money itself — is saved only in this browser.
            Tap to export it now, before clearing data or switching federations
            can destroy the only copy.
          </div>
        </div>
      ))}

      {/* CALM: unresolved-credit whose amount the wallet balance does NOT cover.
          The note was reported already-redeemed (so it's not live money to
          rescue) but this wallet is short — likely claimed on another device.
          Honest, dismissible nudge; the note is archived (kept) on dismiss. The
          balance-covered case never reaches here — it auto-reconciles silently. */}
      {calmClaims.map((entry) => (
        <div
          key={entry.escrowId}
          style={{
            background: T.card, border: `1px solid ${T.amber}55`,
            borderRadius: T.r, padding: 18, marginBottom: 16,
          }}
        >
          <div style={{
            fontSize: 11, fontWeight: 600, color: T.amber,
            fontFamily: T.mono, letterSpacing: 1, marginBottom: 8,
          }}>
            CHECK YOUR OTHER DEVICE
          </div>
          <div style={{ fontSize: 13, color: T.text, fontFamily: T.sans, lineHeight: 1.5, marginBottom: 12 }}>
            <BitcoinAmount sats={Math.floor(entry.amountMsats / 1000)} size={13} gap={4} glyphScale={1.18} color={T.text} glyphColor={T.muted} />
            {" "}from a settled trade was reported already claimed, but your balance
            here is short by that much — it most likely landed on another device.
            The note is saved as a backup if you need it.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {onExportStrandedClaim && (
              <button
                onClick={() => onExportStrandedClaim(entry)}
                style={{
                  flex: 1, minHeight: 40, borderRadius: T.rs,
                  background: "none", border: `1px solid ${T.border}`,
                  color: T.text, fontFamily: T.sans, fontSize: 13, fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                View note
              </button>
            )}
            <button
              onClick={() => dismissClaim(entry.escrowId)}
              style={{
                flex: 1, minHeight: 40, borderRadius: T.rs,
                background: T.amberDim, border: `1px solid ${T.amber}66`,
                color: T.amber, fontFamily: T.sans, fontSize: 13, fontWeight: 800,
                cursor: "pointer",
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      ))}

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
            {/* v3.1.1 (#2): 👍/👎 breakdown, consistent with the tap-a-
                counterparty reputation readout. This aggregate includes arbiter
                ratings (any verified rating where you are the ratee). */}
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 10, fontFamily: T.mono, fontSize: 13 }}>
              <span style={{ color: T.green, fontWeight: 700 }}>👍 {ratings.positive}</span>
              <span style={{ color: T.amber, fontWeight: 700 }}>👎 {ratings.negative}</span>
              <span style={{ color: T.muted, fontSize: 11 }}>from {ratings.count} settled trade{ratings.count !== 1 ? "s" : ""}</span>
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
        <DmNotificationsRow />
        <NostrNamesRow on={kind0On} onToggle={() => setKind0On(!kind0On)} />
        <SettingsRow label="Payment methods" hint="Phone, mobile money, bank, and app IDs" onClick={onOpenSavedHandles} />
        <SettingsRow label="Lightning Addresses" hint="Saved addresses for claims and recovery" onClick={onOpenPayoutDestinations} />
        <SettingsRow label="Advanced" hint="Sandbox mode and Chama tools" onClick={onOpenAdvanced} />
        <SettingsRow label="Help & FAQ" hint="Trading basics, getting paid, arbiter duties, recovery" onClick={onOpenHelp} />
        <SettingsRow label="Sign out" hint={null} onClick={onSignOut} danger />
      </div>

      <MeTradeHistory
        trades={visibleTrades}
        totalCount={myTrades.length}
        counts={tradeCounts}
        activeFilter={tradeFilter}
        onFilter={setTradeFilter}
        pubkey={pubkey}
        onOpenTrade={onOpenTrade}
        onRefreshTrades={onRefreshTrades}
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
  onRefreshTrades,
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
  onRefreshTrades?: () => Promise<number> | void;
  onRateCounterparty?: (tradeId: string, ratee: string, thumb: RatingThumb) => Promise<void>;
  myGivenRatings?: Array<{ tradeId: string; ratee: string; thumb: RatingThumb }>;
}) {
  const activeFilterLabel = ME_TRADE_FILTERS.find((filter) => filter.id === activeFilter)?.label ?? "All";
  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = async () => {
    if (!onRefreshTrades || refreshing) return;
    setRefreshing(true);
    try {
      await onRefreshTrades();
    } finally {
      setRefreshing(false);
    }
  };

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
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            color: T.muted, fontFamily: T.mono, fontSize: 11,
            whiteSpace: "nowrap" as const,
          }}>
            {trades.length} / {totalCount}
          </div>
          {onRefreshTrades && (
            <button
              type="button"
              onClick={handleRefresh}
              disabled={refreshing}
              title="Re-check relays for your trades"
              style={{
                display: "inline-flex", alignItems: "center", gap: 5,
                background: "transparent", border: `1px solid ${T.border}`,
                borderRadius: 8, padding: "4px 8px",
                color: refreshing ? T.muted : T.text,
                fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                cursor: refreshing ? "default" : "pointer",
                opacity: refreshing ? 0.6 : 1,
                whiteSpace: "nowrap" as const,
              }}
            >
              <span style={{
                display: "inline-block",
                animation: refreshing ? "spin 0.8s linear infinite" : "none",
              }}>↻</span>
              {refreshing ? "Syncing…" : "Refresh"}
            </button>
          )}
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
                {/* Safety net Jetty asked for: rate the counterparty straight from
                    history (👍/👎) if you forgot or backed out of the trade. */}
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
  const [query, setQuery] = useState("");
  const current = communitySlug ? getCommunityBySlug(communitySlug) : null;
  const countries = getAllPickerCountries();
  const currentCountry = current?.country
    ? countries.find((country) => country.code === current.country) ?? null
    : null;
  const currentCountryCode = currentCountry?.code ?? current?.country ?? null;
  const currentCountryLabel = currentCountry?.name ?? current?.country ?? "Global";
  const currentCountryFlag = currentCountry?.flag ?? (current?.country ? current.flagEmoji : null);
  const currentCountrySubline = currentCountry
    ? countrySubline(currentCountry)
    : current?.currency ?? "USD";
  const search = query.trim().toLowerCase();
  const filteredCountries = search
    ? countries.filter((country) => countryMatchesSearch(country, search))
    : countries;
  const otherCountries = filteredCountries.filter((country) => country.code !== currentCountryCode);

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
            onClick={() => {
              setChanging((v) => !v);
              setQuery("");
            }}
            style={{
              background: changing ? T.surface : T.accentDim,
              border: `1px solid ${changing ? T.border : T.accent + "66"}`,
              color: changing ? T.muted : T.accent,
              fontFamily: T.mono, fontSize: 10, fontWeight: 800, letterSpacing: 0.5,
              padding: "5px 10px", borderRadius: T.rs, cursor: "pointer",
            }}
          >
            {changing ? "Cancel" : "Switch"}
          </button>
        )}
      </div>

      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "11px 12px", borderRadius: T.rs,
        background: T.surface, border: `1px solid ${T.border}`,
      }}>
        {currentCountryFlag ? (
          <span style={{ fontSize: 24, lineHeight: 1 }}>{currentCountryFlag}</span>
        ) : (
          <span style={{
            width: 34, height: 34, borderRadius: "50%",
            background: T.accentDim, color: T.accent,
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            fontFamily: T.mono, fontSize: 13, fontWeight: 900,
          }}>
            C
          </span>
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14, color: T.text, fontFamily: T.sans, fontWeight: 600 }}>
            {currentCountryLabel}
          </div>
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono }}>
            {currentCountrySubline}
          </div>
        </div>
        <div style={{ color: T.accent, fontFamily: T.mono, fontSize: 10, fontWeight: 900 }}>
          current
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
          marginTop: 12,
        }}>
          <label style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "10px 12px", borderRadius: T.rs,
            background: T.surface, border: `1px solid ${T.border}`,
            color: T.muted, fontFamily: T.mono, marginBottom: 12,
          }}>
            <span style={{ fontSize: 15, lineHeight: 1 }}>⌕</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search countries..."
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              style={{
                flex: 1, minWidth: 0, background: "transparent", border: "none",
                outline: "none", color: T.text, fontFamily: T.sans,
                fontSize: 14, letterSpacing: 0,
              }}
            />
          </label>

          <div style={{
            fontSize: 10, fontWeight: 800, color: T.muted,
            fontFamily: T.mono, letterSpacing: 1, marginBottom: 8,
          }}>
            {search ? `${otherCountries.length} MATCH${otherCountries.length === 1 ? "" : "ES"}` : "OTHER COUNTRIES"}
          </div>
          <div style={{ display: "grid", gap: 8, maxHeight: 260, overflowY: "auto", paddingRight: 2 }}>
            {otherCountries.length === 0 ? (
              <div style={{
                padding: "14px 12px", borderRadius: T.rs,
                background: T.surface, border: `1px dashed ${T.border}`,
                color: T.muted, fontFamily: T.mono, fontSize: 11,
                textAlign: "center" as const,
              }}>
                No countries match that search.
              </div>
            ) : otherCountries.map((country) => (
              <button
                key={country.code}
                onClick={() => {
                  setChanging(false);
                  setQuery("");
                  onSelectCommunity(resolveCountryCommunitySlug(country));
                }}
                style={{
                  width: "100%",
                  display: "flex", alignItems: "center", gap: 11,
                  padding: "11px 12px", borderRadius: T.rs,
                  background: T.surface, border: `1px solid ${T.border}`,
                  color: T.text, fontFamily: T.sans,
                  cursor: "pointer", textAlign: "left",
                }}
              >
                <span style={{ fontSize: 22, lineHeight: 1 }}>{country.flag}</span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{
                    display: "block", overflow: "hidden",
                    textOverflow: "ellipsis", whiteSpace: "nowrap",
                    fontSize: 13, fontWeight: 800, color: T.text,
                  }}>
                    {country.name}
                  </span>
                  <span style={{
                    display: "block", marginTop: 2,
                    overflow: "hidden", textOverflow: "ellipsis",
                    whiteSpace: "nowrap", fontFamily: T.mono,
                    fontSize: 10, color: T.muted,
                  }}>
                    {countrySubline(country)}
                  </span>
                </span>
                <span style={{ color: T.accent, fontFamily: T.mono, fontSize: 11, fontWeight: 900 }}>
                  switch
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function countryMatchesSearch(country: PickerCountry, search: string): boolean {
  return [
    country.code,
    country.name,
    country.currency,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(search);
}

function countrySubline(country: PickerCountry): string {
  return `${country.currency} · ${country.code}`;
}

function resolveCountryCommunitySlug(country: PickerCountry): string {
  const realLocal = country.realChamas[0];
  if (realLocal) return realLocal.slug;

  const dc = country.defaultCommunity;
  try {
    if (country.isGeneratedShell && !getCommunityBySlug(dc.slug) && dc.federationInvite) {
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
    return dc.slug;
  } catch {
    return DEFAULT_COMMUNITY_SLUG;
  }
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

// DM / trade-chat notifications. Tri-state, mirroring the Appearance control:
// Auto follows your role ON EACH TRADE (arbiters are the responders, so they
// buzz; buyers/sellers stay quiet), On/Off are explicit global overrides.
// Self-contained — reads/writes the pref directly. Auto or On proactively asks
// OS permission (the real gate).
function DmNotificationsRow() {
  const [pref, setPref] = useState<DmNotifyPref>(() => dmNotifyPref());
  const pick = (next: DmNotifyPref) => {
    setPref(next);
    setDmNotifyPref(next);
    if (next !== "off") void ensureNotificationPermission();
  };
  const sublabel =
    pref === "auto" ? "Auto — buzzes when you're the arbiter"
    : pref === "on" ? "On — buzzes on every trade"
    : "Off — chat stays silent";
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      gap: 10, padding: "14px 16px", borderBottom: `1px solid ${T.border}`,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: T.text, fontFamily: T.sans }}>
          DM notifications
        </div>
        <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginTop: 2 }}>
          {sublabel}
        </div>
      </div>
      <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
        {(["auto", "on", "off"] as DmNotifyPref[]).map(opt => {
          const active = pref === opt;
          const label = opt === "auto" ? "Auto" : opt === "on" ? "On" : "Off";
          return (
            <button
              key={opt}
              onClick={() => pick(opt)}
              role="radio"
              aria-checked={active}
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
  );
}

function NostrNamesRow({ on, onToggle }: {
  on: boolean; onToggle: () => void;
}) {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      gap: 10, padding: "14px 16px", borderBottom: `1px solid ${T.border}`,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: T.text, fontFamily: T.sans }}>
          Nostr names
        </div>
        <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginTop: 2 }}>
          Show profile names instead of npub IDs
        </div>
      </div>
      <button
        onClick={onToggle}
        role="switch"
        aria-checked={on}
        style={{
          width: 46, height: 26, borderRadius: 999, position: "relative",
          border: `1px solid ${on ? T.accent + "66" : T.border}`,
          background: on ? T.accentDim : T.surface,
          cursor: "pointer", transition: "background 0.15s, border-color 0.15s",
          flexShrink: 0,
        }}
      >
        <span style={{
          position: "absolute", top: 2, left: on ? 22 : 2,
          width: 20, height: 20, borderRadius: "50%",
          background: on ? T.accent : T.muted, transition: "left 0.15s",
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
