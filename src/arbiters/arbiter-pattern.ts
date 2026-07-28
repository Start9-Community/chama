// ══════════════════════════════════════════════════════════════════════════
// Arbiter ruling concentration — the collusion instrument
// ══════════════════════════════════════════════════════════════════════════
//
// The dual-signed attestation (arbiter-fault.ts) is testimony, and testimony
// has one structural blind spot: an arbiter colluding WITH the winner. The
// loser signs; the winner never will, because the winner is the beneficiary.
// So the pair never forms and the attestation never exists.
//
// Testimony catches what people will admit. This catches what they won't.
//
// Every escrow event is public — participants, seated arbiter, votes, outcome.
// So "how often has this arbiter ruled in favour of this same counterparty" is
// computable by anyone, from data that already exists, with nobody confessing
// anything. One ruling for the same person is a coin flip. Five out of five is
// a fingerprint.
//
// DESCRIPTIVE, like tenure and cohort context: publish the number, let humans
// conclude. No verdict, no automatic exclusion, no new event kind. A displayed
// count is not an accusation, and that is deliberate — the honest explanation
// (a small community with few traders) is common, and the number lets a reader
// see that too.

import { EscrowEventKind, Role } from "../escrow-engine/types.js";
import type { EscrowState, VotePayload } from "../escrow-engine/types.js";
import { payoutRecipientFor } from "../escrow-engine/recipients.js";

export interface BeneficiaryCount {
  npub: string;
  count: number;
}

export interface RulingConcentration {
  /** Disputes this arbiter actually decided. The denominator, always reported —
   *  "3 of 3" and "3 of 40" are different worlds. */
  rulings: number;
  /** Who their rulings favoured, most-favoured first. */
  byBeneficiary: BeneficiaryCount[];
  /** Top beneficiary's share of all rulings, 0..1. Zero when there are none. */
  topShare: number;
}

/** The arbiter's OWN vote on this trade, or null if they never ruled. Read from
 *  the chain rather than `state.votes` so it is the seated arbiter's own act,
 *  not a backup's substitution. */
function arbiterVoteOutcomeBy(state: EscrowState, npub: string) {
  for (const ve of state.eventChain) {
    if (ve.kind !== EscrowEventKind.VOTE) continue;
    const payload = ve.payload as VotePayload | undefined;
    if (payload?.role !== Role.ARBITER) continue;
    if ((ve as { raw?: { pubkey?: string } }).raw?.pubkey !== npub) continue;
    return payload.outcome;
  }
  return null;
}

/** Was this a real dispute — both principals voted and disagreed? An arbiter
 *  vote on an agreed trade decides nothing and must not count. */
function wasContested(state: EscrowState): boolean {
  const buyer = state.votes[Role.BUYER];
  const seller = state.votes[Role.SELLER];
  return !!buyer && !!seller && buyer !== seller;
}

/**
 * How concentrated an arbiter's rulings are among the people they favoured.
 *
 * Counts only decisions: both principals voted, they disagreed, and this
 * arbiter cast their own arbiter vote. The beneficiary is who THAT vote
 * favoured — not the final resolution — so the number describes the arbiter's
 * choice rather than the outcome others may have produced.
 *
 * Deduped by escrow id, so a trade loaded twice can never inflate it.
 */
export function arbiterRulingConcentration(
  states: readonly EscrowState[],
  arbiterNpub: string,
): RulingConcentration {
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  let rulings = 0;

  for (const state of states) {
    if (seen.has(state.id)) continue;
    if (!wasContested(state)) continue;
    const outcome = arbiterVoteOutcomeBy(state, arbiterNpub);
    if (outcome === null) continue;
    const beneficiary = payoutRecipientFor(state, outcome);
    if (!beneficiary) continue;

    seen.add(state.id);
    rulings++;
    counts.set(beneficiary.pubkey, (counts.get(beneficiary.pubkey) ?? 0) + 1);
  }

  const byBeneficiary = [...counts.entries()]
    .map(([npub, count]) => ({ npub, count }))
    // Ties broken by npub so the ordering is stable across clients.
    .sort((a, b) => (b.count - a.count) || a.npub.localeCompare(b.npub));

  return {
    rulings,
    byBeneficiary,
    topShare: rulings > 0 && byBeneficiary.length > 0
      ? byBeneficiary[0].count / rulings
      : 0,
  };
}

/** Minimum rulings before concentration means anything. Below this, "1 of 1"
 *  is just a first dispute, and showing a share would manufacture suspicion
 *  out of nothing. */
export const CONCENTRATION_MIN_RULINGS = 3;

/** Whether the number is worth showing at all. Not "is this arbiter bad" —
 *  that judgement belongs to the reader, not to this function. */
export function concentrationWorthShowing(c: RulingConcentration): boolean {
  return c.rulings >= CONCENTRATION_MIN_RULINGS && c.byBeneficiary.length > 0;
}
