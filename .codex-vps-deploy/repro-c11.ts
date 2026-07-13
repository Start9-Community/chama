// Repro for skeptic check: C11 clamp vs honest clock skew (locker clock ahead).
// Chain: CREATE -> LOCK(lockedAt=T+600) -> buyer VOTE RELEASE (created_at=T+100)
//        -> assigned arbiter VOTE RELEASE just past the PRE-clamp escalation
//        boundary -> RESOLVE -> CLAIM.
// Run against v3.2 (HEAD worktree) and v3.3 (working tree) and compare replay.
import {
  applyEvent, replayEventChain,
} from "./src/escrow-engine/state-machine.js";
import { oneSidedEscalationAt } from "./src/escrow-engine/arbiter-substitution.js";
import {
  Role, Outcome, EscrowEventKind, EscrowStatus,
  type EscrowState, type ParsedEscrowEvent, type EscrowPayload,
  type CreatePayload, type LockPayload, type VotePayload,
  type ResolvePayload, type ClaimPayload, type NostrEvent,
} from "./src/escrow-engine/types.js";

const BUYER_PK    = "aa".repeat(32);
const SELLER_PK   = "bb".repeat(32);
const ARBITER_PK  = "cc".repeat(32);
const ARBITER2_PK = "ee".repeat(32);
const PLATFORM_PK = "dd".repeat(32);
const ESCROW_ID   = "test-escrow-001";
// Ordered so the deterministic pick for ESCROW_ID with basis [BUYER, SELLER]
// is ARBITER_PK (same pool the v2.9 tests use).
const POOL = [ARBITER2_PK, ARBITER_PK, "ff".repeat(32)];

let counter = 0;
function mk<T extends EscrowPayload>(
  kind: EscrowEventKind, pubkey: string, payload: T,
  prevEventId: string | null, created_at: number,
): ParsedEscrowEvent<T> {
  counter++;
  const raw: NostrEvent = {
    id: `event_${counter}_${kind}`,
    pubkey,
    created_at,
    kind,
    tags: [["d", ESCROW_ID], ...(prevEventId ? [["e", prevEventId, "", "reply"]] : [])],
    content: "encrypted",
    sig: "sig_" + counter,
  };
  return { raw, payload, escrowId: ESCROW_ID, prevEventId, kind, pubkey, timestamp: created_at };
}

const T0 = Math.floor(Date.now() / 1000) - 30 * 86400; // a month ago: fully historical

const create = mk<CreatePayload>(EscrowEventKind.CREATE, SELLER_PK, {
  type: "escrow:create",
  description: "Sell 100k sats for $50 USD via Zelle",
  amountMsats: 100_000_000,
  fiatAmount: 50,
  fiatCurrency: "USD",
  category: "p2p-trade",
  mintUrl: "fed11q...",
  platformFeeBps: 50,
  platformFeePubkey: PLATFORM_PK,
  arbiterFeeMsats: 1_000_000,
  paymentMethods: ["Zelle"],
  expirySeconds: 86400,
  communityArbiters: POOL,
  createdAt: T0,
} as CreatePayload, null, T0);

// Locker (seller) clock is +600s fast: lock happens at true T0+0 but is
// stamped T0+600 (both created_at and payload.lockedAt, as lockAndPublish does).
const LOCKED_AT = T0 + 600;
const lock = mk<LockPayload>(EscrowEventKind.LOCK, SELLER_PK, {
  type: "escrow:lock",
  notesHash: "hash_of_ecash_notes_abc123",
  shares: [
    { shareIndex: 0, encryptedFor: { [BUYER_PK]: "e0b", [SELLER_PK]: "e0s", [ARBITER_PK]: "e0a" } },
    { shareIndex: 1, encryptedFor: { [BUYER_PK]: "e1b", [SELLER_PK]: "e1s", [ARBITER_PK]: "e1a" } },
    { shareIndex: 2, encryptedFor: { [BUYER_PK]: "e2b", [SELLER_PK]: "e2s", [ARBITER_PK]: "e2a" } },
  ],
  sellerReceivesMsats: 99_000_000,
  arbiterFeeMsats: 1_000_000,
  buyerPubkey: BUYER_PK,
  arbiterPubkey: ARBITER_PK,
  arbiterPoolShare: true,
  lockedAt: LOCKED_AT,
} as LockPayload, create.raw.id, LOCKED_AT);

// Buyer (accurate clock) pays fiat and votes RELEASE 100s after the true lock
// time: created_at = T0+100 < lockedAt = T0+600. Seller ghosts.
const buyerVote = mk<VotePayload>(EscrowEventKind.VOTE, BUYER_PK, {
  type: "escrow:vote", outcome: Outcome.RELEASE, role: Role.BUYER, votedAt: T0 + 100,
} as VotePayload, lock.raw.id, T0 + 100);

// Build state up to the contested point to read this version's escalation clock.
let s = (applyEvent(null, create) as any);
if (!s.ok) { console.log("CREATE rejected:", s.error); process.exit(1); }
s = applyEvent(s.state, lock) as any;
if (!s.ok) { console.log("LOCK rejected:", s.error); process.exit(1); }
s = applyEvent(s.state, buyerVote) as any;
if (!s.ok) { console.log("BUYER VOTE rejected:", s.error); process.exit(1); }
const contested: EscrowState = s.state;

const escAt = oneSidedEscalationAt(contested);
console.log("lockedAt              =", LOCKED_AT, `(T0+${LOCKED_AT - T0})`);
console.log("buyer vote created_at =", T0 + 100, "(T0+100)");
console.log("expiresAt             =", contested.expiresAt, `(T0+${contested.expiresAt! - T0})`);
console.log("oneSidedEscalationAt  =", escAt, escAt === null ? "" : `(T0+${escAt - T0})`);

// The arbiter votes 60s past the UNCLAMPED (v3.2) boundary:
//   v3.2 boundary = (T0+100) + min(grace, half) ; v3.3 boundary is 500s later.
// Compute the v3.2 boundary from first principles so the SAME event is used
// under both versions: anchor=T0+100, grace=14400 (default), half-life floor.
const GRACE = 4 * 3600;
const anchorV32 = T0 + 100;
const halfV32 = Math.max(0, Math.floor((contested.expiresAt! - anchorV32) / 2));
const escAtV32 = anchorV32 + Math.min(GRACE, halfV32);
const ARB_VOTE_AT = escAtV32 + 60;
console.log("v3.2-style boundary   =", escAtV32, `(T0+${escAtV32 - T0})`, "arbiter votes at", `T0+${ARB_VOTE_AT - T0}`);

const arbVote = mk<VotePayload>(EscrowEventKind.VOTE, ARBITER_PK, {
  type: "escrow:vote", outcome: Outcome.RELEASE, role: Role.ARBITER, votedAt: ARB_VOTE_AT,
} as VotePayload, buyerVote.raw.id, ARB_VOTE_AT);

const resolve = mk<ResolvePayload>(EscrowEventKind.RESOLVE, BUYER_PK, {
  type: "escrow:resolve", outcome: Outcome.RELEASE,
  majority: [Role.BUYER, Role.ARBITER], arbiterInvolved: true, resolvedAt: ARB_VOTE_AT + 10,
} as ResolvePayload, arbVote.raw.id, ARB_VOTE_AT + 10);

const claim = mk<ClaimPayload>(EscrowEventKind.CLAIM, BUYER_PK, {
  type: "escrow:claim", claimerRole: Role.BUYER,
  notesHashVerification: "hash_of_ecash_notes_abc123", claimedAt: ARB_VOTE_AT + 20,
} as ClaimPayload, resolve.raw.id, ARB_VOTE_AT + 20);

const chain = [create, lock, buyerVote, arbVote, resolve, claim];
const replay = replayEventChain(chain);
if (replay.ok) {
  console.log("REPLAY OK — status:", replay.state.status,
    "resolvedOutcome:", replay.state.resolvedOutcome,
    "votes:", JSON.stringify(replay.state.votes));
} else {
  console.log("REPLAY FAILED —", replay.error.code + ":", replay.error.message);
}
