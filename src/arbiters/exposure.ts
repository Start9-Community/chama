// ══════════════════════════════════════════════════════════════════════════
// Arbiter exposure ledger — Bond Phase 1 (DESIGN-arbiter-economy §8, the
// keystone). Pure functions over caller-resolved inputs; no store, no fetch,
// no money path, no reducer coupling.
// ══════════════════════════════════════════════════════════════════════════
//
// §8 turns "a cheating arbiter or colluding cabinet can't go far" into an
// enforced NUMBER. A self-selected bond caps an arbiter's exposure on TWO
// axes, both HARD:
//   1. Per-trade  — any single trade ≤ their bond.
//   2. Aggregate  — Σ(ALL their open bonded trades, across EVERY chama) +
//                   the new trade ≤ their bond.
// Live capacity = bond − Σ(open bonded trades). A trade BELOW the unbonded
// floor (§K) needs no bond at all — entry stays free / permissionless.
//
// (Cap boundary: the brief 2026-06-22 locks ≤ — "the bond must COVER its
// exposure". The doc's older §8 prose said strict <; the brief wins.)
//
// ENFORCEMENT IS CONSENT-LAYER, NEVER A REDUCER REJECT (mirrors C1/C7 in
// pool.ts). An over-capacity arbiter is *skipped at assignment*; if one is
// hand-seated anyway, the UI warns + asks for acknowledgement. The reducer
// always accepts the LOCK, so a live trade can never freeze on capacity drift.
//
// ⚠️  DORMANT IN PHASE 1. The classifiers below ALWAYS compute the truth (so
// they're unit-tested now), but BONDS_ENFORCED gates whether the system ACTS
// on them — see the seam in pool.ts. While it is false (and while no 38130
// bond is declared) assignment is unchanged and zero consent warnings fire.
// Phase 2 flips the switch when real bonds + the SSS-lock land (§3). Bonds are
// UNBACKED claims until then (see bonds.ts).

import { Role, TRULY_TERMINAL_STATES } from "../escrow-engine/types.js";
import type { EscrowState, NostrEvent } from "../escrow-engine/types.js";
import { selectLatestBond } from "./bonds.js";
import type { ArbiterBond } from "./bonds.js";

export type { ArbiterBond } from "./bonds.js";

/** §K unbonded floor: 10,000 sats. A trade STRICTLY BELOW this needs NO bond —
 *  reputation + the 2-of-3 carry it (an arbiter can't steal alone, only
 *  collude) while a newcomer earns ratings on small stakes. At/above, the
 *  seated arbiter must hold a bond that covers it. */
export const UNBONDED_FLOOR_MSATS = 10_000_000;

/** DORMANT master switch for LIVE bond enforcement (Phase 1 ships false). The
 *  ledger is fully computed + tested regardless; this only gates whether the
 *  pool seam actually excludes over-capacity arbiters and whether the UI warns.
 *  Phase 2 flips it when real bonds + the SSS-lock land. Even when true,
 *  enforcement stays consent-layer (never a reducer reject) and assignment
 *  never strands (the seam keeps a never-empty fallback). */
export const BONDS_ENFORCED: boolean = false;

/** §L exposure-tier display bands (Bronze / Silver / Gold) — kept DISTINCT
 *  from the proof tiers C/B/A. Display-only: the real cap is ALWAYS the bond
 *  amount, never the band. Gold ≥ 1M sats is pinned (Jetty, 2026-06-22); the
 *  Bronze/Silver line is a tunable display nicety. */
export const EXPOSURE_TIER_SILVER_FLOOR_MSATS = 100_000_000; //   100k sats
export const EXPOSURE_TIER_GOLD_FLOOR_MSATS = 1_000_000_000; // 1,000k sats

export type ExposureTier = "Bronze" | "Silver" | "Gold";
export type CapacityTier = "unbonded" | "covered" | "over-capacity";

const HEX64 = /^[0-9a-f]{64}$/;

function normPk(value: string | null | undefined): string | null {
  const t = value?.trim().toLowerCase();
  return t && HEX64.test(t) ? t : null;
}

/** The arbiter's current valid in-term bond, or null. Thin wrapper over the
 *  38130 selector (newest-wins, term-gated). `now` (unix s) defaults to the
 *  wall clock; tests pass a fixed value for determinism. */
export function getArbiterBond(
  npub: string,
  bondEvents: readonly NostrEvent[],
  now: number = Math.floor(Date.now() / 1000),
  options?: { verifyEvent?: (event: NostrEvent) => boolean },
): ArbiterBond | null {
  return selectLatestBond(npub, bondEvents, now, options);
}

/** Does this trade still EXPOSE its arbiter? Open = NOT truly-terminal.
 *  COMPLETED / CANCELLED are settled (funds done); EXPIRED is NOT — an expired
 *  LOCKED trade still has ecash at stake and can heal, so it keeps counting.
 *  Uses the exported TRULY_TERMINAL_STATES (the pure equivalent of the hook's
 *  private isSettledStatus), keeping this module free of React/hook imports. */
export function isOpenExposure(state: EscrowState): boolean {
  return !TRULY_TERMINAL_STATES.has(state.status);
}

/** Every OPEN bonded trade (amount ≥ the unbonded floor) where `npub` is the
 *  SEATED arbiter (participants[ARBITER]) — across EVERY chama, since the §8
 *  aggregate cap is global. Pass `excludeId` to drop the subject trade when
 *  judging an arbiter already seated on it (so it isn't double-counted). */
export function getOpenBondedTrades(
  npub: string,
  allTrades: Iterable<EscrowState>,
  opts?: { excludeId?: string | null },
): EscrowState[] {
  const want = normPk(npub);
  if (!want) return [];
  const excludeId = opts?.excludeId ?? null;
  const out: EscrowState[] = [];
  for (const trade of allTrades) {
    if (excludeId && trade.id === excludeId) continue;
    if (trade.amountMsats < UNBONDED_FLOOR_MSATS) continue; // below floor = unbonded, no exposure
    if (!isOpenExposure(trade)) continue; // settled = no exposure
    if (normPk(trade.participants?.[Role.ARBITER]) !== want) continue;
    out.push(trade);
  }
  return out;
}

/** Σ of the given open bonded trade amounts (msats). */
export function sumOpenExposure(openTrades: Iterable<EscrowState>): number {
  let sum = 0;
  for (const trade of openTrades) sum += trade.amountMsats;
  return sum;
}

/** §8 live capacity: bond − Σ(the given open bonded trades). Negative when
 *  over-committed. Pure over the set the caller supplies. */
export function liveCapacity(
  bond: ArbiterBond | null,
  openTrades: Iterable<EscrowState>,
): number {
  return (bond?.bondMsats ?? 0) - sumOpenExposure(openTrades);
}

export interface ArbiterCapacity {
  tier: CapacityTier;
  /** §8 live capacity AFTER counting the subject trade: bond − (Σ other open +
   *  trade). Negative ⇒ how far over capacity. For an unbonded (sub-floor)
   *  subject this is bond − Σ(other open), since the subject needs no bond. */
  liveCapacity: number;
  bondMsats: number;
}

/** Classify whether an arbiter can carry a trade of `tradeMsats`, given their
 *  bond and their OTHER open bonded trades (the subject trade excluded). Pure;
 *  mirrors classifyArbiterProvenance. ALWAYS truthful — the dormant switch only
 *  gates whether callers ACT on the verdict.
 *    • trade < floor                                   → "unbonded" (§K)
 *    • no/expired bond, OR per-trade fail, OR aggregate fail → "over-capacity"
 *    • else                                            → "covered"
 *  Both caps use ≤ (the bond must COVER its exposure — brief 2026-06-22). */
export function classifyArbiterCapacity(params: {
  /** Accepted for symmetry / labels; the verdict is computed from bond + set. */
  arbiter?: string | null;
  tradeMsats: number;
  bond: ArbiterBond | null;
  openTrades: Iterable<EscrowState>;
}): ArbiterCapacity {
  const bondMsats = params.bond?.bondMsats ?? 0;
  const sumOther = sumOpenExposure(params.openTrades);

  if (params.tradeMsats < UNBONDED_FLOOR_MSATS) {
    return { tier: "unbonded", liveCapacity: bondMsats - sumOther, bondMsats };
  }

  const liveCap = bondMsats - (sumOther + params.tradeMsats);
  const perTradeOk = !!params.bond && params.tradeMsats <= bondMsats;
  const aggregateOk = !!params.bond && sumOther + params.tradeMsats <= bondMsats;
  const tier: CapacityTier = perTradeOk && aggregateOk ? "covered" : "over-capacity";
  return { tier, liveCapacity: liveCap, bondMsats };
}

/** Assignment predicate: may this arbiter be SEATED on this trade? True for
 *  "unbonded" (sub-floor) and "covered"; false for "over-capacity". */
export function canAssignArbiter(params: {
  npub?: string | null;
  tradeMsats: number;
  bond: ArbiterBond | null;
  openTrades: Iterable<EscrowState>;
}): boolean {
  return (
    classifyArbiterCapacity({
      arbiter: params.npub,
      tradeMsats: params.tradeMsats,
      bond: params.bond,
      openTrades: params.openTrades,
    }).tier !== "over-capacity"
  );
}

/** ⭐ S4 BRIDGE — which chain-verified **38135 commitment** bonded arbiters can be
 *  SEATED on a trade of `tradeMsats`, applying the §8 caps to the REAL bond
 *  (`actualSats`) instead of the legacy 38130 declaration:
 *    • per-trade  — trade ≤ bond, AND
 *    • aggregate  — Σ(their other open bonded trades) + trade ≤ bond.
 *  A sub-floor trade needs no bond, so every bonded arbiter qualifies. This is
 *  the "auto-select by bond amount (per trade / combination of trades)" rule.
 *  Pure; the caller passes FUNDED+ACTIVE bonds (VerifiedBond) so no term-gating
 *  is needed. Feed the result to getTrustedArbiterPool's `bondedPool`. */
export function assignableBondedArbiters(params: {
  bonds: readonly { npub: string; actualSats: bigint }[];
  tradeMsats: number;
  allTrades: Iterable<EscrowState>;
  excludeTradeId?: string | null;
}): string[] {
  const materialized = [...params.allTrades];
  const subFloor = params.tradeMsats < UNBONDED_FLOOR_MSATS;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const b of params.bonds) {
    const npub = normPk(b.npub);
    if (!npub || seen.has(npub)) continue;
    seen.add(npub);
    if (subFloor) { out.push(npub); continue; }
    const bondMsats = Number(b.actualSats) * 1000;
    const sumOther = sumOpenExposure(getOpenBondedTrades(npub, materialized, { excludeId: params.excludeTradeId }));
    // Both caps use ≤ — the bond must COVER its exposure (brief 2026-06-22).
    if (params.tradeMsats <= bondMsats && sumOther + params.tradeMsats <= bondMsats) out.push(npub);
  }
  return out;
}

/** §L display band for a bond size. Display-only; the cap is the bond amount. */
export function exposureTier(bondMsats: number): ExposureTier {
  if (bondMsats >= EXPOSURE_TIER_GOLD_FLOOR_MSATS) return "Gold";
  if (bondMsats >= EXPOSURE_TIER_SILVER_FLOOR_MSATS) return "Silver";
  return "Bronze";
}

// ── The assignment seam (pure; the dormant switch lives in pool.ts) ──────────

/** Inputs the assignment seam needs to judge a whole pool for one trade. The
 *  caller resolves these from already-fetched data — exposure.ts fetches
 *  nothing and owns no store. */
export interface PoolCapacityContext {
  tradeMsats: number;
  /** All known 38130 bond declarations (any arbiters'). */
  bondEvents: readonly NostrEvent[];
  /** All known escrows, to sum each candidate's open bonded exposure. */
  allTrades: Iterable<EscrowState>;
  /** Subject escrow id to exclude from each candidate's open set. */
  excludeTradeId?: string | null;
  /** Clock (unix s) for term-gating bonds; defaults to the wall clock. */
  now?: number;
  verifyEvent?: (event: NostrEvent) => boolean;
}

/** The OVER-CAPACITY members of `pool` for this trade — the set assignment
 *  should skip (consent-layer). PURE and ALWAYS truthful (NOT gated by
 *  BONDS_ENFORCED) so the cap logic is unit-testable; the dormant switch lives
 *  in the getTrustedArbiterPool seam that consumes this. */
export function selectOverCapacityArbiters(
  pool: readonly string[],
  ctx: PoolCapacityContext,
): string[] {
  const allTrades = [...ctx.allTrades]; // materialize once; reused per candidate
  const now = ctx.now ?? Math.floor(Date.now() / 1000);
  const over: string[] = [];
  for (const raw of pool) {
    const pk = normPk(raw);
    if (!pk) continue;
    const bond = getArbiterBond(pk, ctx.bondEvents, now, { verifyEvent: ctx.verifyEvent });
    const openTrades = getOpenBondedTrades(pk, allTrades, { excludeId: ctx.excludeTradeId });
    if (!canAssignArbiter({ npub: pk, tradeMsats: ctx.tradeMsats, bond, openTrades })) {
      over.push(pk);
    }
  }
  return over;
}

/** The ASSIGNABLE subset of `pool` for this trade: over-capacity members
 *  removed — but if that would EMPTY the pool, the full pool is returned
 *  (never strand a live trade on capacity drift; consent-layer, not a hard
 *  gate). PURE and ungated (testable); the dormant switch lives in the
 *  getTrustedArbiterPool seam. */
export function assignablePool(pool: readonly string[], ctx: PoolCapacityContext): string[] {
  const over = new Set(selectOverCapacityArbiters(pool, ctx));
  if (over.size === 0) return [...pool];
  const filtered = pool.filter((pk) => {
    const norm = normPk(pk);
    return !norm || !over.has(norm);
  });
  return filtered.length > 0 ? filtered : [...pool];
}
