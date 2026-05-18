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
import { type EscrowState } from "../../escrow-engine/types.js";
import {
  MAIN_SURFACE_RECOVERY_MIN_SATS,
  type AggregateRatings,
} from "../decisions.js";
import {
  lightningPayoutReserveSats,
  maxLightningPayoutSats,
} from "../../payments/lightning-fees.js";
import { T } from "../theme.js";
import { TradeCard } from "../components/TradeCard.js";

const KIND0_TOGGLE_KEY_PREFIX = "chama_fetch_kind0_enabled_";

function readKind0Toggle(pubkey: string): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(KIND0_TOGGLE_KEY_PREFIX + pubkey) === "1";
  } catch { return false; }
}

function writeKind0Toggle(pubkey: string, on: boolean): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (on) localStorage.setItem(KIND0_TOGGLE_KEY_PREFIX + pubkey, "1");
    else localStorage.removeItem(KIND0_TOGGLE_KEY_PREFIX + pubkey);
  } catch { /* no-op */ }
}

export function MeScreen({
  pubkey,
  myTrades,
  ratings,
  onOpenTrade,
  onOpenSavedHandles,
  onOpenPayoutDestinations,
  onOpenAdvanced,
  balanceMsats,
  hasActiveCommitment,
  onRecoverSats,
  onSignOut,
}: {
  pubkey: string;
  myTrades: EscrowState[];
  /** Aggregate rating data. v0.2.0 always null (no rating events yet);
   *  v0.2.1 wires the aggregator. */
  ratings: AggregateRatings | null;
  onOpenTrade: (id: string) => void;
  onOpenSavedHandles: () => void;
  onOpenPayoutDestinations: () => void;
  onOpenAdvanced: () => void;
  balanceMsats: number;
  hasActiveCommitment: boolean;
  onRecoverSats: () => void;
  onSignOut: () => void;
}) {
  const npubShort = pubkey.slice(0, 8) + "…" + pubkey.slice(-4);
  const [kind0On, setKind0On] = useState<boolean>(() => readKind0Toggle(pubkey));
  useEffect(() => { writeKind0Toggle(pubkey, kind0On); }, [pubkey, kind0On]);
  const localRecoverySats = Math.floor(Math.max(0, balanceMsats) / 1000);
  const localRecoverableSats = maxLightningPayoutSats(balanceMsats);
  const localReserveSats = lightningPayoutReserveSats(balanceMsats);
  const showLocalRecovery = !hasActiveCommitment && localRecoverySats > 0;
  const isQuietDust = localRecoverySats < MAIN_SURFACE_RECOVERY_MIN_SATS;

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

      {showLocalRecovery && (
        <div style={{
          background: T.card, border: `1px solid ${isQuietDust ? T.border : T.amber + "66"}`,
          borderRadius: T.r, padding: 20, marginBottom: 16,
        }}>
          <div style={{
            fontSize: 11, fontWeight: 600, color: isQuietDust ? T.muted : T.amber,
            fontFamily: T.mono, letterSpacing: 1, marginBottom: 12,
          }}>
            SATS RECOVERY
          </div>
          <div style={{ fontSize: 13, color: T.text, fontFamily: T.sans, lineHeight: 1.55 }}>
            {isQuietDust ? (
              <>
                {localRecoverySats.toLocaleString()} sat{localRecoverySats !== 1 ? "s" : ""} saved from payout fee dust.
                Chama keeps tiny leftovers out of the main flow and lets them accumulate here.
              </>
            ) : (
              <>
                {localRecoverySats.toLocaleString()} sats are ready for recovery before the next trade.
                {localReserveSats > 0 ? ` About ${localReserveSats.toLocaleString()} sats stay reserved for Lightning fees.` : ""}
              </>
            )}
          </div>
          <button
            onClick={onRecoverSats}
            disabled={localRecoverableSats <= 0}
            style={{
              width: "100%", padding: "12px", marginTop: 14,
              background: localRecoverableSats > 0 ? T.amberDim : T.surface,
              border: `1px solid ${localRecoverableSats > 0 ? T.amber + "66" : T.border}`,
              borderRadius: T.rs,
              color: localRecoverableSats > 0 ? T.amber : T.muted,
              fontFamily: T.mono, fontSize: 12, fontWeight: 800,
              cursor: localRecoverableSats > 0 ? "pointer" : "default",
            }}
          >
            {localRecoverableSats > 0
              ? `Recover ${localRecoverableSats.toLocaleString()} sats`
              : "Waiting for enough sats to recover"}
          </button>
        </div>
      )}

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
              fetches the counterparty's self-published Nostr profile name.
              Privacy default is npub-only.
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
          (Damus, Primal, Amethyst) to set your name and picture — it'll
          show up here automatically once the fetcher ships.
        </div>
      </div>

      {/* Settings sub-page entries */}
      <div style={{
        background: T.card, border: `1px solid ${T.border}`,
        borderRadius: T.r, padding: 0, marginBottom: 16, overflow: "hidden",
      }}>
        <SettingsRow label="Payment handles" hint="Saved handles for fast trade-time fill" onClick={onOpenSavedHandles} />
        <SettingsRow label="Payout destinations" hint="Lightning addresses for claims and recovery" onClick={onOpenPayoutDestinations} />
        <SettingsRow label="Advanced" hint="Sandbox mode and Chama tools" onClick={onOpenAdvanced} />
        <SettingsRow label="Sign out" hint={null} onClick={onSignOut} danger />
      </div>

      {/* My trade history */}
      <div style={{
        fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono,
        letterSpacing: 1, marginBottom: 8,
      }}>
        MY TRADES ({myTrades.length})
      </div>
      {myTrades.length === 0 ? (
        <div style={{
          padding: 24, textAlign: "center",
          background: T.surface, border: `1px dashed ${T.border}`,
          borderRadius: T.r, color: T.muted, fontFamily: T.mono, fontSize: 11,
        }}>
          No trades yet. Browse listings to start one.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {myTrades.map((s, i) => (
            <div key={s.id} style={{ animation: `fadeIn 0.4s ease ${i * 0.05}s both` }}>
              <TradeCard state={s} pubkey={pubkey} onSelect={() => onOpenTrade(s.id)} />
            </div>
          ))}
        </div>
      )}
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
