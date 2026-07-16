// ══════════════════════════════════════════════════════════════════════════
// Chama — Arbiter premium (task #53 E1: the 0.5% insurance, client-side)
// ══════════════════════════════════════════════════════════════════════════
//
// Each trade principal pays 0.25% of the trade to the seated arbiter at
// settlement (0.5% total — AMBIENT_ARBITER_FEE_BPS split across both
// sides), as an OOB ecash note riding the trade's own channel (kind 38113,
// encrypted to the arbiter). Default-ON with a one-uncheck decline.
//
// Frozen E0 decisions this module encodes:
//   - BONDED-ONLY earnings: only a seated arbiter present in the trade's
//     CREATE-stamped bondedArbiters subset is payable. OG-fallback seats
//     earn nothing — the bond is the earnings license (#52: gate
//     privileges on the bond).
//   - Floor on NOTE size, not trade size: skip when the per-side note
//     would be under PREMIUM_MIN_NOTE_SATS (dust-note churn).
//   - Long try_cancel horizon on the premium spend so an absent arbiter's
//     note auto-refunds to the payer — nothing ever strands.
//
// Pure module: no storage, no wallet. The orchestration (spend → publish →
// ledger) lives in useEscrow; selection helpers here stay testable.

import { AMBIENT_ARBITER_FEE_BPS, calculateBasisPointFeeMsats } from "./fees.js";
import { EscrowStatus, Role, TAGS, type EscrowState } from "../escrow-engine/types.js";

/** Each side pays half of the 0.5% ambient fee. */
export const PER_SIDE_PREMIUM_BPS = AMBIENT_ARBITER_FEE_BPS / 2; // 25 bps

/** Skip premiums whose per-side note would be smaller than this (sats). */
export const PREMIUM_MIN_NOTE_SATS = 10;

/** try_cancel horizon for premium spends: 14 days. Long enough for a slow
 *  mobile arbiter to come online; short enough that a vanished arbiter's
 *  note refunds the payer within a fortnight. */
export const PREMIUM_SPEND_TRY_CANCEL_SECS = 14 * 24 * 60 * 60;

/** The narrow slice of EscrowState the calculator needs (testable). */
export type PremiumStateSlice = Pick<
  EscrowState,
  "amountMsats" | "participants" | "bondedArbiters"
>;

export type PremiumSkipReason =
  | "no-arbiter"
  | "not-principal"
  | "arbiter-not-bonded"
  | "below-floor"
  | "bad-amount";

export type PremiumDecision =
  | {
      payable: true;
      arbiter: string;
      payerRole: Role.BUYER | Role.SELLER;
      /** Whole-sat note (msats and sats always agree). */
      amountMsats: number;
      amountSats: number;
    }
  | { payable: false; reason: PremiumSkipReason };

function samePubkey(a?: string | null, b?: string | null): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/**
 * Decide whether `myPubkey` owes the seated arbiter a premium on this
 * trade, and how much. Pure; encodes every E0 gate. Verdict-neutral by
 * construction — computed from the trade amount only, never the outcome.
 */
export function computeArbiterPremium(
  state: PremiumStateSlice,
  myPubkey: string | null,
): PremiumDecision {
  const arbiter = state.participants[Role.ARBITER];
  if (!arbiter) return { payable: false, reason: "no-arbiter" };

  const payerRole = samePubkey(state.participants[Role.BUYER], myPubkey)
    ? Role.BUYER
    : samePubkey(state.participants[Role.SELLER], myPubkey)
      ? Role.SELLER
      : null;
  if (!payerRole) return { payable: false, reason: "not-principal" };

  // Bonded-only: the earnings license. The CREATE-stamped subset is the
  // consensus-visible truth both parties accepted at join (2B pattern).
  const bonded = state.bondedArbiters ?? [];
  if (!bonded.some((pk) => samePubkey(pk, arbiter))) {
    return { payable: false, reason: "arbiter-not-bonded" };
  }

  if (!Number.isFinite(state.amountMsats) || state.amountMsats <= 0) {
    return { payable: false, reason: "bad-amount" };
  }

  const rawMsats = calculateBasisPointFeeMsats(state.amountMsats, PER_SIDE_PREMIUM_BPS);
  const amountSats = Math.floor(rawMsats / 1000);
  if (amountSats < PREMIUM_MIN_NOTE_SATS) {
    return { payable: false, reason: "below-floor" };
  }

  return {
    payable: true,
    arbiter,
    payerRole,
    amountMsats: amountSats * 1000,
    amountSats,
  };
}

/**
 * E1.1 funder side: the premium to FOLD INTO the funding invoice so the
 * wallet retains a residue after the lock spend (the trade flows
 * otherwise drain wallets to ~zero — the E1 field failure).
 *
 * At funding time the arbiter seat is not yet taken (LOCK seats it), so
 * this predicts eligibility from the CREATE-stamped bondedArbiters: the
 * lock builder prefers exactly that subset, so a non-empty stamp means a
 * bonded seat. A wrong prediction merely leaves the funder a few sats of
 * dust in their own wallet. Returns whole-sat msats, or 0 when no
 * premium applies (no stamp / below the note floor / bad amount).
 */
export function funderPremiumMsats(
  state: Pick<EscrowState, "bondedArbiters">,
  lockAmountMsats: number,
): number {
  if ((state.bondedArbiters ?? []).length === 0) return 0;
  if (!Number.isFinite(lockAmountMsats) || lockAmountMsats <= 0) return 0;
  const sats = Math.floor(
    calculateBasisPointFeeMsats(lockAmountMsats, PER_SIDE_PREMIUM_BPS) / 1000,
  );
  return sats < PREMIUM_MIN_NOTE_SATS ? 0 : sats * 1000;
}

/**
 * Pick the COMPLETED trades on which `myPubkey` still owes a premium.
 * `hasOutboxRecord` is the durable idempotence gate (paid / declined /
 * sending records all block a re-pay). Pure — the App sweep feeds it the
 * live escrow map.
 */
export function selectPremiumPayTargets(opts: {
  escrows: Iterable<EscrowState>;
  myPubkey: string | null;
  hasOutboxRecord: (escrowId: string) => boolean;
}): string[] {
  const out: string[] = [];
  for (const state of opts.escrows) {
    if (state.status !== EscrowStatus.COMPLETED) continue;
    if (opts.hasOutboxRecord(state.id)) continue;
    if (!computeArbiterPremium(state, opts.myPubkey).payable) continue;
    out.push(state.id);
  }
  return out;
}

/** How often the App re-runs the #62 redeem-probe while open. One cheap
 *  single-filter REQ; only fires loads when an unredeemed note exists. */
export const PREMIUM_PROBE_INTERVAL_MS = 5 * 60 * 1000;

/** Slack past the note's try_cancel horizon after which a probed premium
 *  is certainly refunded to its payer — not worth loading the trade for. */
export const PREMIUM_PROBE_HORIZON_SLACK_SECS = 24 * 60 * 60;

/** The slice of a raw kind-38113 Nostr event the probe selector needs. */
export interface PremiumProbeEvent {
  id: string;
  created_at: number;
  tags: string[][];
}

/**
 * Task #62 arbiter redeem-probe selector. The redeem sweep only walks
 * LOADED trades — but a settled trade is unwatched (no live sub) and
 * skipped by discovery's "settled — nothing to heal" gate, so a premium
 * published AFTER settlement never reaches a passive arbiter's state.
 * Given the raw events a `{kinds:[38113], "#p":[me]}` relay probe
 * returned, pick the DISTINCT escrow ids worth a loadEscrow: some note is
 * neither settled in the earnings ledger, nor already in the loaded
 * state (the sweep owns those), nor past its refund horizon. Pure.
 */
export function selectPremiumProbeLoads(
  events: Iterable<PremiumProbeEvent>,
  opts: {
    isSettled: (eventId: string) => boolean;
    isNoteLoaded: (escrowId: string, eventId: string) => boolean;
    nowSecs?: number;
  },
): string[] {
  const now = opts.nowSecs ?? Math.floor(Date.now() / 1000);
  const horizon = PREMIUM_SPEND_TRY_CANCEL_SECS + PREMIUM_PROBE_HORIZON_SLACK_SECS;
  const out = new Set<string>();
  for (const ev of events) {
    if (!ev || typeof ev.id !== "string" || !Array.isArray(ev.tags)) continue;
    const escrowId = ev.tags.find((t) => Array.isArray(t) && t[0] === TAGS.ESCROW_ID)?.[1];
    if (!escrowId) continue;
    if (Number.isFinite(ev.created_at) && now - ev.created_at > horizon) continue;
    if (opts.isSettled(ev.id)) continue;
    if (opts.isNoteLoaded(escrowId, ev.id)) continue;
    out.add(escrowId);
  }
  return [...out];
}

/**
 * Arbiter side: the loaded trades holding premium notes addressed to me
 * that the earnings ledger hasn't settled yet. `isSettled` covers both
 * redeemed and given-up records.
 */
export function selectPremiumRedeemTargets(opts: {
  escrows: Iterable<EscrowState>;
  myPubkey: string | null;
  isSettled: (eventId: string) => boolean;
}): string[] {
  const out: string[] = [];
  if (!opts.myPubkey) return out;
  for (const state of opts.escrows) {
    if (!samePubkey(state.participants[Role.ARBITER], opts.myPubkey)) continue;
    const notes = state.premiumNotes ?? [];
    if (notes.some((ev) => !opts.isSettled(ev.raw.id))) out.push(state.id);
  }
  return out;
}
