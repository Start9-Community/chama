// ══════════════════════════════════════════════════════════════════════════
// Chama — Holder-only shares (escrow safety)
// ══════════════════════════════════════════════════════════════════════════
//
// See docs/DESIGN-holder-only-shares.md. Pure helpers for the "holder-only-v1"
// share policy: each 2-of-3 SSS share is encrypted to ONLY its assigned holder,
// so no one party can reconstruct alone. Reconstruction needs a second share,
// re-encrypted to the payout recipient by an *agreeing voter* (the cryptographic
// 2-of-3). These functions are pure — no relays, no money, no crypto — so the
// share→holder mapping and the reconstruction-selection logic are unit-testable
// in isolation; the Fedimint bridge wires them to real encrypt/decrypt.

import { Role, type EscrowState, type VoteShareEnvelope, type Outcome } from "./types.js";
import { payoutRecipientFor } from "./recipients.js";

export const HOLDER_ONLY_SHARE_POLICY = "holder-only-v1" as const;

/** Fixed share-index → holder-role mapping. shareIndex 0 = buyer, 1 = seller,
 *  2 = arbiter. Stable wire convention — never reorder. */
export const HOLDER_ROLE_BY_SHARE_INDEX: Readonly<Record<number, Role>> = {
  0: Role.BUYER,
  1: Role.SELLER,
  2: Role.ARBITER,
};

const SHARE_INDEX_BY_HOLDER_ROLE: Readonly<Record<Role, number>> = {
  [Role.BUYER]: 0,
  [Role.SELLER]: 1,
  [Role.ARBITER]: 2,
};

/** The holder role assigned to a share index (null for an out-of-range index). */
export function holderRoleForShareIndex(shareIndex: number): Role | null {
  return HOLDER_ROLE_BY_SHARE_INDEX[shareIndex] ?? null;
}

/** The share index a role holds (buyer→0, seller→1, arbiter→2). */
export function shareIndexForRole(role: Role): number {
  return SHARE_INDEX_BY_HOLDER_ROLE[role];
}

/** The pubkey that holds a given share index for this escrow (null if that
 *  participant slot is empty). */
export function holderPubkeyForShareIndex(state: EscrowState, shareIndex: number): string | null {
  const role = holderRoleForShareIndex(shareIndex);
  return role ? state.participants[role] ?? null : null;
}

/** Validate a VOTE-carried share envelope against the escrow + the voter, for
 *  the binding the parser/claim path enforces (refinement #5 pins shareIndex to
 *  the voter's role). Returns the reason on failure, or null when valid. Pure —
 *  does NOT verify the ciphertext (the notesHash + reconstruction backstop that).
 *
 *  - shareIndex must equal the voter's role-derived holder index.
 *  - outcome must match the vote's outcome.
 *  - notesHash must match the lock's funded token.
 *  - recipientPubkey must equal payoutRecipientFor(state, outcome) — the share
 *    has to route to the engine-computed recipient, not an arbitrary key.
 *  - encryptedFor must contain exactly the recipient's entry. */
export function validateVoteShareEnvelope(
  env: VoteShareEnvelope,
  state: EscrowState,
  voterRole: Role,
  voteOutcome: Outcome,
  lockNotesHash: string | null | undefined,
): string | null {
  if (env.shareIndex !== shareIndexForRole(voterRole)) {
    return `shareIndex ${env.shareIndex} is not the ${voterRole}'s holder index ${shareIndexForRole(voterRole)}`;
  }
  if (env.outcome !== voteOutcome) {
    return `share outcome ${env.outcome} disagrees with the vote outcome ${voteOutcome}`;
  }
  if (lockNotesHash && env.notesHash !== lockNotesHash) {
    return "share notesHash does not match the locked token";
  }
  const recipient = payoutRecipientFor(state, voteOutcome);
  if (!recipient) return "no engine recipient for this outcome";
  if (env.recipientPubkey !== recipient.pubkey) {
    return "share recipient is not the engine-computed payout recipient";
  }
  if (!env.encryptedFor || env.encryptedFor[recipient.pubkey] === undefined) {
    return "share is not encrypted to the recipient";
  }
  return null;
}
