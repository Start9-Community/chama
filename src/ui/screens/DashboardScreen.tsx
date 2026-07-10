// ══════════════════════════════════════════════════════════════════════════
// Chama — Dashboard (v5.0 "finish the bond" — the standing home)
// ══════════════════════════════════════════════════════════════════════════
//
// The home the bond + ratings have waited for. Replaces the v4.2.1 "coming soon"
// placeholder with the four things a Chama identity is made of:
//   1. STANDING   — public, trade-verified ratings (the trust you've earned).
//   2. YOUR BOND  — your commitment bond(s): capital locked in the open = "how
//                   much × how long" (dev-gated behind SHOW_BOND_CEREMONY until
//                   the bond ships to prod; this is where "become an arbiter" lives).
//   3. LIVENESS   — how live your chama is (bonded arbiters, computed, never faked).
//   4. STATS      — your trade activity at a glance.
//
// Read-only + composed from data the app already has; no new money path.

import { useMemo } from "react";
import { T } from "../theme.js";
import { BitcoinAmount } from "../components/BitcoinAmount.js";
import { LivenessSignal, useLiveness } from "../components/LivenessSignal.js";
import type { ChamaLiveness } from "../../arbiters/live-chama.js";
import { listCommitmentBonds } from "../../bond-multisig/commitment-store.js";
import { SHOW_BOND_CEREMONY } from "../panels/BondCeremonyModal.js";
import { getCommunityBySlug } from "../../communities/registry.js";
import { EscrowStatus, Role, type EscrowState } from "../../escrow-engine/types.js";
import type { AggregateRatings } from "../../reputation/ratings.js";

const TERMINAL = new Set<EscrowStatus>([
  EscrowStatus.COMPLETED, EscrowStatus.CANCELLED, EscrowStatus.CLAIMED,
]);

export function DashboardScreen({
  pubkey,
  ratings,
  myTrades,
  communitySlug,
  loadLiveness,
  livenessBlocksPerDay = 144,
  onOpenBondCeremony,
}: {
  pubkey: string;
  /** The user's own trade-verified public rating (null until it can verify any). */
  ratings: AggregateRatings | null;
  myTrades: EscrowState[];
  communitySlug?: string | null;
  loadLiveness?: (slug: string) => Promise<ChamaLiveness | null>;
  livenessBlocksPerDay?: number;
  /** Open the bond ceremony (dev-gated). */
  onOpenBondCeremony?: () => void;
}) {
  const lower = pubkey.toLowerCase();
  const community = communitySlug ? getCommunityBySlug(communitySlug) : null;

  // Lean stats — completed / live / as-arbiter, computed inline (buildMeDashboard
  // is MeScreen's heavier queue model; the Dashboard only needs the headline counts).
  const stats = useMemo(() => {
    let completed = 0, live = 0, asArbiter = 0;
    for (const t of myTrades) {
      if (t.status === EscrowStatus.COMPLETED) completed++;
      else if (!TERMINAL.has(t.status)) live++;
      if (t.participants?.[Role.ARBITER]?.toLowerCase() === lower) asArbiter++;
    }
    return { total: myTrades.length, completed, live, asArbiter };
  }, [myTrades, lower]);

  const bonds = useMemo(() => listCommitmentBonds(), []);
  const activeBonds = bonds.filter((b) => b.phase !== "reclaimed");

  const { liveness, loading: livenessLoading } = useLiveness(communitySlug ?? null, loadLiveness, { intervalMs: 90_000 });

  const ratePct = ratings && ratings.count > 0 ? Math.round((ratings.positive / ratings.count) * 100) : null;

  return (
    <div style={{ padding: 16, maxWidth: 560, margin: "0 auto", animation: "fadeIn 0.3s ease" }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 4 }}>
        DASHBOARD
      </div>
      <div style={{ fontSize: 22, fontWeight: 900, color: T.text, fontFamily: T.sans, marginBottom: 16 }}>
        Your standing
      </div>

      {/* 1. STANDING — the hero. Public, trade-verified trust. */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: T.r, padding: 20, marginBottom: 14 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 12 }}>
          STANDING
        </div>
        {ratePct !== null ? (
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 34, fontWeight: 900, color: T.green, fontFamily: T.sans, lineHeight: 1 }}>
              {ratePct}%
            </span>
            <span style={{ fontSize: 13, color: T.muted, fontFamily: T.mono }}>positive</span>
            <span style={{ marginLeft: "auto", fontSize: 12, color: T.muted, fontFamily: T.mono }}>
              👍 {ratings!.positive} · 👎 {ratings!.negative} · {ratings!.count} rated
            </span>
          </div>
        ) : (
          <div style={{ fontSize: 14, color: T.text, fontFamily: T.sans, lineHeight: 1.55 }}>
            New here. <span style={{ color: T.muted }}>Complete trades honestly and your public rating builds — that's the trust others read before dealing with you.</span>
          </div>
        )}
      </div>

      {/* 2. YOUR BOND — dev-gated until the bond ships to prod. Where "become an
          arbiter" lives: locked capital, in the open, is the commitment signal. */}
      {SHOW_BOND_CEREMONY && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: T.r, padding: 20, marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: T.muted, fontFamily: T.mono, letterSpacing: 1 }}>
              YOUR BOND
            </div>
            {onOpenBondCeremony && (
              <button onClick={onOpenBondCeremony}
                style={{ background: T.accentDim, border: `1px solid ${T.accent}66`, color: T.accent, fontFamily: T.mono, fontSize: 10, fontWeight: 800, letterSpacing: 0.5, padding: "5px 10px", borderRadius: T.rs, cursor: "pointer" }}>
                {activeBonds.length > 0 ? "Manage" : "Post a bond"}
              </button>
            )}
          </div>
          {activeBonds.length > 0 ? (
            <div style={{ display: "grid", gap: 8 }}>
              {activeBonds.map((b) => {
                const locked = b.phase === "locked";
                return (
                  <div key={b.bondId} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 12px", background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs }}>
                    <span style={{ fontSize: 14, fontWeight: 800, color: T.text, fontFamily: T.mono }}>
                      <BitcoinAmount sats={Number(b.amountSats)} size={14} gap={4} glyphScale={1.18} color={T.text} glyphColor={T.muted} />
                    </span>
                    <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: 1, fontFamily: T.mono, color: locked ? T.green : T.amber, border: `1px solid ${locked ? T.green : T.amber}`, borderRadius: 99, padding: "2px 8px" }}>
                      {locked ? "🔒 LOCKED" : "AWAITING FUNDING"}
                    </span>
                  </div>
                );
              })}
              <div style={{ fontSize: 10.5, color: T.muted, fontFamily: T.mono, lineHeight: 1.5, marginTop: 2 }}>
                Locked capital, in the open — how much × how long you'll stand behind your word. It makes you a bonded arbiter for your chama.
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 14, color: T.text, fontFamily: T.sans, lineHeight: 1.55 }}>
              No bond yet. <span style={{ color: T.muted }}>Lock your own sats, to your own key, for a term — a public commitment that makes you an arbiter for your chama. Nobody can touch it; you reclaim it when the term ends.</span>
            </div>
          )}
        </div>
      )}

      {/* 3. CHAMA LIVENESS — how live your community is (computed, chain-verified). */}
      {loadLiveness && communitySlug && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 8 }}>
            {community?.flagEmoji ?? "🌍"} {community?.displayName ?? communitySlug}
          </div>
          <LivenessSignal liveness={liveness} loading={livenessLoading} blocksPerDay={livenessBlocksPerDay} />
        </div>
      )}

      {/* 4. STATS — trade activity at a glance. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
        <StatTile label="Trades" value={stats.total} />
        <StatTile label="Completed" value={stats.completed} accent={T.green} />
        <StatTile label="Live now" value={stats.live} accent={stats.live > 0 ? T.accent : undefined} />
      </div>
      {stats.asArbiter > 0 && (
        <div style={{ marginTop: 10, fontSize: 12, color: T.muted, fontFamily: T.mono, textAlign: "center" }}>
          Arbitrated <span style={{ color: T.text, fontWeight: 700 }}>{stats.asArbiter}</span> trade{stats.asArbiter === 1 ? "" : "s"}.
        </div>
      )}
    </div>
  );
}

function StatTile({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div style={{ background: T.surface, borderRadius: T.r, padding: "14px 12px", textAlign: "center" }}>
      <div style={{ fontSize: 24, fontWeight: 900, color: accent ?? T.text, fontFamily: T.sans, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, letterSpacing: 0.5, marginTop: 6, textTransform: "uppercase" }}>{label}</div>
    </div>
  );
}
