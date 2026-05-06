// ══════════════════════════════════════════════════════════════════════════
// Chama Escrow Engine — Test Suite (PR 1 atomic funding + PR 2 community)
// ══════════════════════════════════════════════════════════════════════════
//
// Run: npx tsx src/escrow-engine/tests.ts
//
// Tests the pure state machine with synthetic events — no relays, no
// crypto, no network. Just state transitions and invariants for:
//
//   PR 1 — atomic funding spine:
//     - LOCK fires directly from CREATED (no FUNDED, no READY ceremony)
//     - LOCK is self-describing: carries buyerPubkey + arbiterPubkey
//     - JOIN is ACK only — records pubkey but does NOT transition state
//     - Double-LOCK rejected (atomic, not idempotent-with-side-effects)
//     - Arbiter must be from communityArbiters pool when present
//     - LOCK pubkeys consistent with any prior JOIN ACKs
//
//   PR 2 — community + listing schema + BLF resolver + vote labels:
//     - Community registry lookup (valid/missing/null slug)
//     - User community storage (default + persistence)
//     - BP fallback in resolveFederationForCommunity (BLF only via opt-in)
//     - Fulfillment normalization in handleCreate (auto-set per category)
//     - Vote label dictionary returns the right copy per
//       (category, fulfillment, role, outcome) tuple

// PR 2: minimal localStorage stub for the storage + resolver tests.
// The escrow modules already gate on `typeof localStorage !== "undefined"`,
// so installing this stub before any imports lets the storage-aware code
// paths run under tsx in Node without ceremony.
(globalThis as any).localStorage = (() => {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => { data.set(k, String(v)); },
    removeItem: (k: string) => { data.delete(k); },
    clear: () => { data.clear(); },
  };
})();

import {
  EscrowStatus,
  EscrowEventKind,
  Role,
  Outcome,
  type ParsedEscrowEvent,
  type CreatePayload,
  type JoinPayload,
  type LockPayload,
  type VotePayload,
  type ResolvePayload,
  type ClaimPayload,
  type CompletePayload,
  type CancelPayload,
  type ChatPayload,
  type EscrowPayload,
  type NostrEvent,
} from "./types.js";

import {
  applyEvent,
  replayEventChain,
  canVote,
  getWinner,
  isExpired,
  getSummary,
  type TransitionResult,
} from "./state-machine.js";

import {
  parseEscrowEvent,
  sortEventChain,
  buildEscrowFilter,
} from "./event-parser.js";

// PR 2 imports
import {
  COMMUNITY_REGISTRY,
  DEFAULT_COMMUNITY_SLUG,
  getCommunityBySlug,
  getPickerCommunities,
  getCustomCommunities,
  getCustomCommunityBySlug,
  addCustomCommunity,
  removeCustomCommunity,
} from "../communities/registry.js";
import {
  getUserCommunitySlug,
  getUserCommunitySlugRaw,
  setUserCommunitySlug,
  COMMUNITY_STORAGE_KEY,
} from "../communities/storage.js";
import {
  resolveFederationForCommunity,
  setCustomFederationInvite,
  BP_FEDERATION_INVITE,
  BLF_FEDERATION_INVITE,
} from "../fedimint/federation-config.js";
import {
  queryUntilFound,
  SEED_RECOVERY_RETRY_DELAYS_MS,
} from "../fedimint/seed-manager.js";
import { deriveCreateFedTags } from "../fedimint/create-fed-tags.js";
import {
  getVoteLabel,
  defaultFulfillmentFor,
  categoryAllowsFulfillmentChoice,
} from "../labels/vote-labels.js";

// PR 3 imports
import {
  RAIL_REGISTRY,
  getRailByKey,
  railsForCommunity,
  railAllowsPublicHandle,
} from "../payments/rail-registry.js";
import {
  SAVED_HANDLES_STORAGE_KEY,
  listSavedHandles,
  getSavedHandle,
  getSavedHandlesByRail,
  addSavedHandle,
  deleteSavedHandle,
  updateSavedHandle,
  setHandleVisibility,
  maskHandle,
  publicHandleDisplay,
  handleDisplayForViewer,
} from "../payments/saved-handles.js";

// PR 4 imports — envelope helpers + real NIP-44 from nostr-tools
import {
  createEnvelope,
  decryptFromEnvelope,
  envelopeHasRecipient,
} from "./envelope.js";
import { ENCRYPTION_CONFIG } from "./encryption-config.js";
import { generateSecretKey, getPublicKey, nip44 } from "nostr-tools";

/** Build a minimal NIP-44 encrypt/decrypt pair for a given private key,
 *  using nostr-tools v2 NIP-44. The "encrypt as me to recipient" function
 *  derives ECDH(my_priv, recipient_pub); "decrypt sent by sender" derives
 *  ECDH(my_priv, sender_pub). Both lead to the same shared secret on
 *  matched pairs, the bedrock of NIP-44. */
function makeNip44(myPriv: Uint8Array) {
  return {
    encrypt: async (plaintext: string, recipientPubkey: string): Promise<string> => {
      const conv = nip44.v2.utils.getConversationKey(myPriv, recipientPubkey);
      return nip44.v2.encrypt(plaintext, conv);
    },
    decrypt: async (ciphertext: string, senderPubkey: string): Promise<string> => {
      const conv = nip44.v2.utils.getConversationKey(myPriv, senderPubkey);
      return nip44.v2.decrypt(ciphertext, conv);
    },
  };
}

// ── Test helpers ──────────────────────────────────────────────────────────

const BUYER_PK    = "aa".repeat(32);
const SELLER_PK   = "bb".repeat(32);
const ARBITER_PK  = "cc".repeat(32);
const ARBITER2_PK = "ee".repeat(32);
const PLATFORM_PK = "dd".repeat(32);
const ESCROW_ID   = "test-escrow-001";

let eventCounter = 0;
const NOW = Math.floor(Date.now() / 1000);

function makeRawEvent(kind: EscrowEventKind, pubkey: string, tags: string[][]): NostrEvent {
  eventCounter++;
  return {
    id: `event_${eventCounter}_${kind}`,
    pubkey,
    created_at: NOW + eventCounter,
    kind,
    tags,
    content: "encrypted",
    sig: "sig_" + eventCounter,
  };
}

function makeParsedEvent<T extends EscrowPayload>(
  kind: EscrowEventKind,
  pubkey: string,
  payload: T,
  prevEventId: string | null = null
): ParsedEscrowEvent<T> {
  const raw = makeRawEvent(kind, pubkey, [
    ["d", ESCROW_ID],
    ...(prevEventId ? [["e", prevEventId, "", "reply"]] : []),
  ]);
  return {
    raw,
    payload,
    escrowId: ESCROW_ID,
    prevEventId,
    kind,
    pubkey,
    timestamp: raw.created_at,
  };
}

// ── Standard event builders ───────────────────────────────────────────────

function createEvent(opts: { communityArbiters?: string[] } = {}): ParsedEscrowEvent<CreatePayload> {
  return makeParsedEvent(EscrowEventKind.CREATE, SELLER_PK, {
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
    paymentMethods: ["Zelle", "CashApp"],
    expirySeconds: 86400,
    communityArbiters: opts.communityArbiters,
    createdAt: NOW,
  });
}

function joinEvent(role: Role, pubkey: string, prevId: string): ParsedEscrowEvent<JoinPayload> {
  return makeParsedEvent(EscrowEventKind.JOIN, pubkey, {
    type: "escrow:join",
    role,
    joinedAt: NOW + eventCounter,
    ...(role === Role.ARBITER ? { arbiterFeeMsats: 1_000_000 } : {}),
  }, prevId);
}

function lockEvent(prevId: string, opts: {
  buyerPubkey?: string;
  arbiterPubkey?: string;
  sellerReceivesMsats?: number;
  arbiterFeeMsats?: number;
  locker?: string;
} = {}): ParsedEscrowEvent<LockPayload> {
  const buyerPk   = opts.buyerPubkey   ?? BUYER_PK;
  const arbiterPk = opts.arbiterPubkey ?? ARBITER_PK;
  return makeParsedEvent(EscrowEventKind.LOCK, opts.locker ?? SELLER_PK, {
    type: "escrow:lock",
    notesHash: "hash_of_ecash_notes_abc123",
    shares: [
      { shareIndex: 0, encryptedFor: { [buyerPk]: "enc_0_b", [SELLER_PK]: "enc_0_s", [arbiterPk]: "enc_0_a" } },
      { shareIndex: 1, encryptedFor: { [buyerPk]: "enc_1_b", [SELLER_PK]: "enc_1_s", [arbiterPk]: "enc_1_a" } },
      { shareIndex: 2, encryptedFor: { [buyerPk]: "enc_2_b", [SELLER_PK]: "enc_2_s", [arbiterPk]: "enc_2_a" } },
    ],
    sellerReceivesMsats: opts.sellerReceivesMsats ?? 99_000_000,
    arbiterFeeMsats:     opts.arbiterFeeMsats     ?? 1_000_000,
    buyerPubkey:   buyerPk,
    arbiterPubkey: arbiterPk,
    lockedAt: NOW + eventCounter,
  }, prevId);
}

function voteEvent(role: Role, pubkey: string, outcome: Outcome, prevId: string): ParsedEscrowEvent<VotePayload> {
  return makeParsedEvent(EscrowEventKind.VOTE, pubkey, {
    type: "escrow:vote",
    outcome,
    role,
    votedAt: NOW + eventCounter,
  }, prevId);
}

function resolveEvent(outcome: Outcome, majority: [Role, Role], arbiterInvolved: boolean, prevId: string): ParsedEscrowEvent<ResolvePayload> {
  return makeParsedEvent(EscrowEventKind.RESOLVE, BUYER_PK, {
    type: "escrow:resolve",
    outcome,
    majority,
    arbiterInvolved,
    resolvedAt: NOW + eventCounter,
  }, prevId);
}

function claimEvent(claimerRole: Role, claimerPk: string, prevId: string): ParsedEscrowEvent<ClaimPayload> {
  return makeParsedEvent(EscrowEventKind.CLAIM, claimerPk, {
    type: "escrow:claim",
    claimerRole,
    notesHashVerification: "hash_of_ecash_notes_abc123",
    claimedAt: NOW + eventCounter,
  }, prevId);
}

function completeEvent(prevId: string): ParsedEscrowEvent<CompletePayload> {
  return makeParsedEvent(EscrowEventKind.COMPLETE, BUYER_PK, {
    type: "escrow:complete",
    completedAt: NOW + eventCounter,
  }, prevId);
}

function cancelEvent(prevId: string): ParsedEscrowEvent<CancelPayload> {
  return makeParsedEvent(EscrowEventKind.CANCEL, SELLER_PK, {
    type: "escrow:cancel",
    cancellerRole: Role.SELLER,
    reason: "Changed my mind",
    cancelledAt: NOW + eventCounter,
  }, prevId);
}

// ── Test runner ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string, details?: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${details ? ` — ${details}` : ""}`);
  }
}

function assertOk(result: TransitionResult, name: string): result is { ok: true; state: any } {
  if (result.ok) {
    passed++;
    console.log(`  ✅ ${name}`);
    return true;
  } else {
    failed++;
    console.log(`  ❌ ${name} — ${result.error.code}: ${result.error.message}`);
    return false;
  }
}

function assertErr(result: TransitionResult, expectedCode: string, name: string) {
  if (!result.ok && result.error.code === expectedCode) {
    passed++;
    console.log(`  ✅ ${name} (${expectedCode})`);
  } else if (!result.ok) {
    failed++;
    console.log(`  ❌ ${name} — expected ${expectedCode}, got ${result.error.code}`);
  } else {
    failed++;
    console.log(`  ❌ ${name} — expected error ${expectedCode}, got success`);
  }
}

// Helper: drive a fresh chain to LOCKED. Useful for tests downstream of LOCK.
function buildToLocked(): { state: any; lock: ParsedEscrowEvent<LockPayload> } {
  const create = createEvent();
  const r1 = applyEvent(null, create);
  if (!r1.ok) throw new Error("CREATE failed in helper");
  const lock = lockEvent(create.raw.id);
  const r2 = applyEvent(r1.state, lock);
  if (!r2.ok) throw new Error("LOCK failed in helper: " + r2.error.message);
  return { state: r2.state, lock };
}

// ══════════════════════════════════════════════════════════════════════════
// TEST SUITES
// ══════════════════════════════════════════════════════════════════════════

console.log("\n🧪 Chama Escrow Engine — Test Suite (PR 1 atomic funding)\n");

// ── 1. CREATE ─────────────────────────────────────────────────────────────
console.log("── CREATE ──");
{
  const create = createEvent();
  const result = applyEvent(null, create);

  if (assertOk(result, "CREATE bootstraps initial state")) {
    const s = result.state;
    assert(s.status === EscrowStatus.CREATED, "Status is CREATED");
    assert(s.id === ESCROW_ID, "Escrow ID set correctly");
    assert(s.participants[Role.SELLER] === SELLER_PK, "Seller is initiator");
    assert(s.participants[Role.BUYER] === null, "Buyer slot empty pre-LOCK");
    assert(s.participants[Role.ARBITER] === null, "Arbiter slot empty pre-LOCK");
    assert(s.amountMsats === 100_000_000, "Amount set correctly");
    assert(s.fees.platformBps === 50, "Platform fee BPS set");
    assert(s.fees.platformMsats === 500_000, "Platform fee calculated");
    assert(s.eventChain.length === 1, "Event chain has 1 event");
  }
}

// Duplicate CREATE
{
  const create = createEvent();
  const r1 = applyEvent(null, create);
  if (r1.ok) {
    const r2 = applyEvent(r1.state, createEvent());
    assertErr(r2, "DUPLICATE_CREATE", "Duplicate CREATE rejected");
  }
}

// ── 2. JOIN as ACK (no state transition) ─────────────────────────────────
console.log("\n── JOIN (ACK only — does not transition state) ──");
{
  const create = createEvent();
  const r1 = applyEvent(null, create);
  if (r1.ok) {
    const join1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
    const r2 = applyEvent(r1.state, join1);
    if (assertOk(r2, "Buyer JOIN accepted as ACK")) {
      assert(r2.state.participants[Role.BUYER] === BUYER_PK, "Buyer pubkey recorded");
      assert(r2.state.status === EscrowStatus.CREATED, "Status STAYS CREATED after buyer JOIN");

      const join2 = joinEvent(Role.ARBITER, ARBITER_PK, join1.raw.id);
      const r3 = applyEvent(r2.state, join2);
      if (assertOk(r3, "Arbiter JOIN accepted as ACK")) {
        assert(r3.state.participants[Role.ARBITER] === ARBITER_PK, "Arbiter pubkey recorded");
        assert(r3.state.status === EscrowStatus.CREATED,
          "Status STAYS CREATED even after all participants JOINed (no FUNDED state)");
        assert(r3.state.fees.arbiterMsats === 1_000_000, "Arbiter fee recorded from JOIN payload");
      }
    }
  }
}

// Role already taken
{
  const create = createEvent();
  const r1 = applyEvent(null, create);
  if (r1.ok) {
    const join1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
    const r2 = applyEvent(r1.state, join1);
    if (r2.ok) {
      const join3 = joinEvent(Role.BUYER, "ee".repeat(32), join1.raw.id);
      assertErr(applyEvent(r2.state, join3), "ROLE_TAKEN", "Different pubkey can't grab a filled slot");
    }
  }
}

// Same pubkey re-joining same role: ALREADY_JOINED (idempotent relay echo)
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const join1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
  state = (applyEvent(state, join1) as any).state;
  const join1dup = joinEvent(Role.BUYER, BUYER_PK, join1.raw.id);
  assertErr(applyEvent(state, join1dup), "ALREADY_JOINED", "Same pubkey re-JOIN is benign duplicate");
}

// Can't JOIN as initiator's role
{
  const create = createEvent();
  const r1 = applyEvent(null, create);
  if (r1.ok) {
    const join = joinEvent(Role.SELLER, BUYER_PK, create.raw.id);
    assertErr(applyEvent(r1.state, join), "ROLE_CONFLICT", "Can't JOIN as initiator's role");
  }
}

// Arbiter must be in communityArbiters pool when one exists
{
  const create = createEvent({ communityArbiters: [ARBITER_PK, ARBITER2_PK] });
  const r1 = applyEvent(null, create);
  if (r1.ok) {
    const goodArbiter = joinEvent(Role.ARBITER, ARBITER_PK, create.raw.id);
    const ok = applyEvent(r1.state, goodArbiter);
    assertOk(ok, "Arbiter from pool can JOIN");

    const stranger = joinEvent(Role.ARBITER, "ff".repeat(32), create.raw.id);
    assertErr(applyEvent(r1.state, stranger), "ARBITER_NOT_IN_POOL",
      "Non-pool arbiter rejected when pool is non-empty");
  }
}

// Empty pool: any arbiter accepted
{
  const create = createEvent(); // no pool
  const r1 = applyEvent(null, create);
  if (r1.ok) {
    const anyArbiter = joinEvent(Role.ARBITER, "99".repeat(32), create.raw.id);
    assertOk(applyEvent(r1.state, anyArbiter),
      "Empty pool means any arbiter pubkey can JOIN");
  }
}

// ── 3. ATOMIC LOCK ───────────────────────────────────────────────────────
console.log("\n── ATOMIC LOCK (CREATED → LOCKED, no FUNDED hop) ──");

// 3a. LOCK fires from CREATED with no prior JOINs
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  assert(state.status === EscrowStatus.CREATED, "Pre-condition: state is CREATED");

  const lock = lockEvent(create.raw.id);
  const r = applyEvent(state, lock);
  if (assertOk(r, "LOCK from CREATED with no prior JOINs (atomic funding)")) {
    assert(r.state.status === EscrowStatus.LOCKED, "Status transitions CREATED → LOCKED directly");
    assert(r.state.participants[Role.BUYER] === BUYER_PK, "LOCK populated buyer slot");
    assert(r.state.participants[Role.ARBITER] === ARBITER_PK, "LOCK populated arbiter slot");
    assert(r.state.lock.notesHash === "hash_of_ecash_notes_abc123", "Notes hash stored");
    assert(r.state.lock.shares.size === 3, "3 SSS shares stored");
  }
}

// 3b. LOCK fires from CREATED after JOIN ACKs (consistent pubkeys)
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const j1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
  state = (applyEvent(state, j1) as any).state;
  const j2 = joinEvent(Role.ARBITER, ARBITER_PK, j1.raw.id);
  state = (applyEvent(state, j2) as any).state;

  const lock = lockEvent(j2.raw.id);
  const r = applyEvent(state, lock);
  assertOk(r, "LOCK after consistent JOIN ACKs");
}

// 3c. LOCK with buyer pubkey disagreeing with prior JOIN → BUYER_PUBKEY_MISMATCH
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const j1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
  state = (applyEvent(state, j1) as any).state;

  const lock = lockEvent(j1.raw.id, { buyerPubkey: "ff".repeat(32) });
  assertErr(applyEvent(state, lock), "BUYER_PUBKEY_MISMATCH",
    "LOCK buyerPubkey must match prior buyer JOIN");
}

// 3d. LOCK with arbiter pubkey not in community pool → ARBITER_NOT_IN_POOL
{
  const create = createEvent({ communityArbiters: [ARBITER_PK, ARBITER2_PK] });
  let state = (applyEvent(null, create) as any).state;
  const lock = lockEvent(create.raw.id, { arbiterPubkey: "ff".repeat(32) });
  assertErr(applyEvent(state, lock), "ARBITER_NOT_IN_POOL",
    "LOCK arbiterPubkey must come from communityArbiters pool");
}

// 3e. LOCK missing buyerPubkey → MISSING_BUYER_PUBKEY
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const badLock = makeParsedEvent(EscrowEventKind.LOCK, SELLER_PK, {
    type: "escrow:lock" as const,
    notesHash: "hash",
    shares: [
      { shareIndex: 0, encryptedFor: { [BUYER_PK]: "x", [SELLER_PK]: "x", [ARBITER_PK]: "x" } },
      { shareIndex: 1, encryptedFor: { [BUYER_PK]: "x", [SELLER_PK]: "x", [ARBITER_PK]: "x" } },
      { shareIndex: 2, encryptedFor: { [BUYER_PK]: "x", [SELLER_PK]: "x", [ARBITER_PK]: "x" } },
    ],
    sellerReceivesMsats: 99_000_000,
    arbiterFeeMsats: 1_000_000,
    buyerPubkey: "",
    arbiterPubkey: ARBITER_PK,
    lockedAt: NOW,
  }, create.raw.id);
  assertErr(applyEvent(state, badLock), "MISSING_BUYER_PUBKEY",
    "LOCK with empty buyerPubkey rejected");
}

// 3f. LOCK with wrong amount sum → AMOUNT_MISMATCH
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const badLock = lockEvent(create.raw.id, { sellerReceivesMsats: 90_000_000 });
  assertErr(applyEvent(state, badLock), "AMOUNT_MISMATCH",
    "LOCK with wrong amount sum rejected");
}

// 3g. WRONG_LOCKER: buyer can't lock in p2p-trade
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const buyerLock = lockEvent(create.raw.id, { locker: BUYER_PK });
  assertErr(applyEvent(state, buyerLock), "NOT_PARTICIPANT",
    "In p2p-trade, the buyer pubkey is not a participant pre-LOCK so signing as buyer fails NOT_PARTICIPANT");
}

// 3h. DOUBLE-LOCK: a second LOCK after LOCKED is rejected
//
// This is the load-bearing atomic-funding invariant: payment-detection
// can fire twice (relay echo, retry, two browsers), but the chain MUST
// NOT advance past LOCKED twice. Sanity check: applying a second LOCK
// to an already-LOCKED state returns INVALID_STATE.
{
  const { state, lock } = buildToLocked();
  assert(state.status === EscrowStatus.LOCKED, "Pre-condition: first LOCK succeeded");

  const dupLock = lockEvent(lock.raw.id);
  assertErr(applyEvent(state, dupLock), "INVALID_STATE",
    "Double-LOCK after LOCKED is rejected — atomic, not idempotent-with-side-effects");
}

// 3i. DUPLICATE_PARTICIPANT: arbiter == seller
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const badLock = lockEvent(create.raw.id, { arbiterPubkey: SELLER_PK });
  assertErr(applyEvent(state, badLock), "DUPLICATE_PARTICIPANT",
    "LOCK can't assign seller pubkey as arbiter");
}

// ── 4. VOTE — Happy Path ─────────────────────────────────────────────────
console.log("\n── VOTE (happy path: buyer+seller agree) ──");
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const lock = lockEvent(create.raw.id);
  state = (applyEvent(state, lock) as any).state;

  const v1 = voteEvent(Role.BUYER, BUYER_PK, Outcome.RELEASE, lock.raw.id);
  const r1 = applyEvent(state, v1);
  if (assertOk(r1, "Buyer votes RELEASE")) {
    assert(r1.state.votes[Role.BUYER] === Outcome.RELEASE, "Buyer vote recorded");
    assert(r1.state.status === EscrowStatus.LOCKED, "Still LOCKED (need 2 votes + RESOLVE)");

    const v2 = voteEvent(Role.SELLER, SELLER_PK, Outcome.RELEASE, v1.raw.id);
    const r2 = applyEvent(r1.state, v2);
    if (assertOk(r2, "Seller votes RELEASE")) {
      assert(r2.state.votes[Role.SELLER] === Outcome.RELEASE, "Seller vote recorded");

      const cv = canVote(r2.state, ARBITER_PK);
      assert(!cv.canVote, "Arbiter can't vote when buyer+seller agree");

      const resolve = resolveEvent(Outcome.RELEASE, [Role.BUYER, Role.SELLER], false, v2.raw.id);
      const r3 = applyEvent(r2.state, resolve);
      if (assertOk(r3, "RESOLVE → APPROVED")) {
        assert(r3.state.status === EscrowStatus.APPROVED, "Status is APPROVED");
        assert(r3.state.resolvedOutcome === Outcome.RELEASE, "Outcome is RELEASE");

        const winner = getWinner(r3.state);
        assert(winner?.role === Role.BUYER, "Winner is buyer");
        assert(winner?.pubkey === BUYER_PK, "Winner pubkey correct");
      }
    }
  }
}

// ── 5. VOTE — Dispute Path ───────────────────────────────────────────────
console.log("\n── VOTE (dispute: arbiter breaks tie) ──");
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const lock = lockEvent(create.raw.id);
  state = (applyEvent(state, lock) as any).state;

  const v1 = voteEvent(Role.BUYER, BUYER_PK, Outcome.RELEASE, lock.raw.id);
  state = (applyEvent(state, v1) as any).state;
  const v2 = voteEvent(Role.SELLER, SELLER_PK, Outcome.REFUND, v1.raw.id);
  state = (applyEvent(state, v2) as any).state;

  const cv = canVote(state, ARBITER_PK);
  assert(cv.canVote === true, "Arbiter CAN vote after disagreement");

  const v3 = voteEvent(Role.ARBITER, ARBITER_PK, Outcome.REFUND, v2.raw.id);
  const r = applyEvent(state, v3);
  if (assertOk(r, "Arbiter votes REFUND")) {
    const resolve = resolveEvent(Outcome.REFUND, [Role.SELLER, Role.ARBITER], true, v3.raw.id);
    const r2 = applyEvent(r.state, resolve);
    if (assertOk(r2, "RESOLVE with arbiter → APPROVED (refund)")) {
      assert(r2.state.resolvedOutcome === Outcome.REFUND, "Outcome is REFUND");
      const winner = getWinner(r2.state);
      assert(winner?.role === Role.SELLER, "Winner is seller (refund)");
    }
  }
}

// Arbiter tries to vote too early
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const lock = lockEvent(create.raw.id);
  state = (applyEvent(state, lock) as any).state;

  const earlyVote = voteEvent(Role.ARBITER, ARBITER_PK, Outcome.RELEASE, lock.raw.id);
  assertErr(applyEvent(state, earlyVote), "ARBITER_TOO_EARLY",
    "Arbiter can't vote before buyer+seller");
}

// Double vote
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const lock = lockEvent(create.raw.id);
  state = (applyEvent(state, lock) as any).state;

  const v1 = voteEvent(Role.BUYER, BUYER_PK, Outcome.RELEASE, lock.raw.id);
  state = (applyEvent(state, v1) as any).state;
  const v1dup = voteEvent(Role.BUYER, BUYER_PK, Outcome.REFUND, v1.raw.id);
  assertErr(applyEvent(state, v1dup), "ALREADY_VOTED", "Double vote rejected");
}

// ── 6. CLAIM + COMPLETE ──────────────────────────────────────────────────
console.log("\n── CLAIM + COMPLETE ──");
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const lock = lockEvent(create.raw.id);
  state = (applyEvent(state, lock) as any).state;
  const v1 = voteEvent(Role.BUYER, BUYER_PK, Outcome.RELEASE, lock.raw.id);
  state = (applyEvent(state, v1) as any).state;
  const v2 = voteEvent(Role.SELLER, SELLER_PK, Outcome.RELEASE, v1.raw.id);
  state = (applyEvent(state, v2) as any).state;
  const resolve = resolveEvent(Outcome.RELEASE, [Role.BUYER, Role.SELLER], false, v2.raw.id);
  state = (applyEvent(state, resolve) as any).state;

  const claim = claimEvent(Role.BUYER, BUYER_PK, resolve.raw.id);
  const rc = applyEvent(state, claim);
  if (assertOk(rc, "Buyer claims → CLAIMED")) {
    assert(rc.state.status === EscrowStatus.CLAIMED, "Status is CLAIMED");

    const complete = completeEvent(claim.raw.id);
    const rf = applyEvent(rc.state, complete);
    if (assertOk(rf, "COMPLETE → terminal")) {
      assert(rf.state.status === EscrowStatus.COMPLETED, "Status is COMPLETED");

      const lateVote = voteEvent(Role.ARBITER, ARBITER_PK, Outcome.RELEASE, complete.raw.id);
      assertErr(applyEvent(rf.state, lateVote), "TERMINAL_STATE", "No events after COMPLETED");
    }
  }

  // Wrong claimer
  const wrongClaim = claimEvent(Role.SELLER, SELLER_PK, resolve.raw.id);
  assertErr(applyEvent(state, wrongClaim), "WRONG_CLAIMER", "Seller can't claim on RELEASE outcome");
}

// ── 7. CANCEL ─────────────────────────────────────────────────────────────
console.log("\n── CANCEL ──");
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;

  const cancel = cancelEvent(create.raw.id);
  const r = applyEvent(state, cancel);
  if (assertOk(r, "Cancel in CREATED state")) {
    assert(r.state.status === EscrowStatus.CANCELLED, "Status is CANCELLED");
  }
}

// Can't cancel after LOCKED
{
  const { state, lock } = buildToLocked();
  const cancel = cancelEvent(lock.raw.id);
  assertErr(applyEvent(state, cancel), "INVALID_STATE", "Can't cancel after LOCKED");
}

// Non-initiator can't cancel
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const j1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
  state = (applyEvent(state, j1) as any).state;

  const badCancel = makeParsedEvent(EscrowEventKind.CANCEL, BUYER_PK, {
    type: "escrow:cancel" as const,
    cancellerRole: Role.BUYER,
    cancelledAt: NOW,
  }, j1.raw.id);

  assertErr(applyEvent(state, badCancel), "NOT_INITIATOR", "Non-initiator can't cancel");
}

// ── 8. CHAT ───────────────────────────────────────────────────────────────
console.log("\n── CHAT ──");
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const j1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
  state = (applyEvent(state, j1) as any).state;

  const chat = makeParsedEvent<ChatPayload>(EscrowEventKind.CHAT, BUYER_PK, {
    type: "escrow:chat",
    message: "Hey, I'm ready to trade!",
    senderRole: Role.BUYER,
    sentAt: NOW,
  });

  const r = applyEvent(state, chat);
  if (assertOk(r, "Chat message accepted")) {
    assert(r.state.chatMessages.length === 1, "Chat stored in chatMessages");
    assert(r.state.eventChain.length === 2, "Chat NOT in eventChain (state chain)");
  }

  // Non-participant can't chat
  const badChat = makeParsedEvent<ChatPayload>(EscrowEventKind.CHAT, "ff".repeat(32), {
    type: "escrow:chat",
    message: "I'm not part of this",
    senderRole: Role.BUYER,
    sentAt: NOW,
  });
  assertErr(applyEvent(state, badChat), "NOT_PARTICIPANT", "Non-participant can't chat");
}

// ── 9. REPLAY ─────────────────────────────────────────────────────────────
console.log("\n── REPLAY (full happy path from event chain) ──");
{
  eventCounter = 100; // Reset for clean IDs

  const events: ParsedEscrowEvent[] = [];

  const create = createEvent();
  events.push(create);

  // Optional JOIN ACKs (still valid pre-LOCK)
  const j1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
  events.push(j1);
  const j2 = joinEvent(Role.ARBITER, ARBITER_PK, j1.raw.id);
  events.push(j2);

  const lock = lockEvent(j2.raw.id);
  events.push(lock);

  const v1 = voteEvent(Role.BUYER, BUYER_PK, Outcome.RELEASE, lock.raw.id);
  events.push(v1);

  const v2 = voteEvent(Role.SELLER, SELLER_PK, Outcome.RELEASE, v1.raw.id);
  events.push(v2);

  const resolve = resolveEvent(Outcome.RELEASE, [Role.BUYER, Role.SELLER], false, v2.raw.id);
  events.push(resolve);

  const claim = claimEvent(Role.BUYER, BUYER_PK, resolve.raw.id);
  events.push(claim);

  const complete = completeEvent(claim.raw.id);
  events.push(complete);

  const result = replayEventChain(events);
  if (assertOk(result, "Full replay succeeds")) {
    assert(result.state.status === EscrowStatus.COMPLETED, "Final state is COMPLETED");
    assert(result.state.eventChain.length === 9, "All 9 events in chain");
    assert(result.state.resolvedOutcome === Outcome.RELEASE, "Outcome is RELEASE");

    console.log("\n  📋 State summary:");
    console.log("  " + getSummary(result.state).split("\n").join("\n  "));
  }
}

// ── 9b. REPLAY without any JOIN events ───────────────────────────────────
console.log("\n── REPLAY (atomic minimum: CREATE → LOCK → … with NO JOINs) ──");
{
  eventCounter = 200;
  const events: ParsedEscrowEvent[] = [];
  const create = createEvent();           events.push(create);
  const lock = lockEvent(create.raw.id);  events.push(lock);
  const v1 = voteEvent(Role.BUYER, BUYER_PK, Outcome.RELEASE, lock.raw.id);  events.push(v1);
  const v2 = voteEvent(Role.SELLER, SELLER_PK, Outcome.RELEASE, v1.raw.id);  events.push(v2);
  const resolve = resolveEvent(Outcome.RELEASE, [Role.BUYER, Role.SELLER], false, v2.raw.id); events.push(resolve);
  const claim = claimEvent(Role.BUYER, BUYER_PK, resolve.raw.id);            events.push(claim);
  const complete = completeEvent(claim.raw.id);                              events.push(complete);

  const result = replayEventChain(events);
  if (assertOk(result, "Replay succeeds without any JOIN events")) {
    assert(result.state.status === EscrowStatus.COMPLETED,
      "Trade completes from CREATE→LOCK→VOTE→RESOLVE→CLAIM→COMPLETE — no JOIN ceremony required");
    assert(result.state.participants[Role.BUYER] === BUYER_PK,
      "Buyer slot populated by LOCK payload, not JOIN");
    assert(result.state.participants[Role.ARBITER] === ARBITER_PK,
      "Arbiter slot populated by LOCK payload, not JOIN");
  }
}

// ── 10. EVENT PARSER ──────────────────────────────────────────────────────
console.log("\n── EVENT PARSER ──");
{
  const raw: NostrEvent = {
    id: "parser_test_1",
    pubkey: SELLER_PK,
    created_at: NOW,
    kind: EscrowEventKind.CREATE,
    tags: [["d", "test-123"]],
    content: "encrypted_content",
    sig: "sig_test",
  };

  const decrypted = JSON.stringify({
    type: "escrow:create",
    description: "Test listing",
    amountMsats: 50_000_000,
    category: "marketplace",
    mintUrl: "fed://test",
    platformFeeBps: 50,
    platformFeePubkey: PLATFORM_PK,
    expirySeconds: 3600,
    createdAt: NOW,
  });

  const result = parseEscrowEvent(raw, decrypted, true);
  assert(result.ok === true, "Parser accepts valid CREATE event");
  if (result.ok) {
    assert(result.event.escrowId === "test-123", "Escrow ID extracted");
    assert(result.event.kind === EscrowEventKind.CREATE, "Kind parsed");
    assert((result.event.payload as CreatePayload).description === "Test listing", "Payload parsed");
  }

  // Bad kind
  const badRaw = { ...raw, kind: 99999, id: "bad_kind" };
  assert(!parseEscrowEvent(badRaw, decrypted, true).ok, "Parser rejects unknown kind");

  // Retired READY kind 38109 — must now reject as INVALID_KIND
  const retiredReady = { ...raw, kind: 38109, id: "retired_ready" };
  assert(!parseEscrowEvent(retiredReady, decrypted, true).ok, "Parser rejects retired READY kind");

  // Retired KICK kind 38110 — must now reject as INVALID_KIND
  const retiredKick = { ...raw, kind: 38110, id: "retired_kick" };
  assert(!parseEscrowEvent(retiredKick, decrypted, true).ok, "Parser rejects retired KICK kind");

  // LOCK without buyerPubkey/arbiterPubkey → INVALID_PAYLOAD
  const badLockContent = JSON.stringify({
    type: "escrow:lock",
    notesHash: "h",
    shares: [
      { shareIndex: 0, encryptedFor: { x: "y" } },
      { shareIndex: 1, encryptedFor: { x: "y" } },
      { shareIndex: 2, encryptedFor: { x: "y" } },
    ],
    sellerReceivesMsats: 99_000_000,
    arbiterFeeMsats: 1_000_000,
    lockedAt: NOW,
  });
  const badLockRaw = { ...raw, kind: EscrowEventKind.LOCK, id: "no_pubkeys", tags: [["d", "no-pks"]] };
  assert(!parseEscrowEvent(badLockRaw, badLockContent, true).ok,
    "Parser rejects LOCK without buyerPubkey/arbiterPubkey");

  // Missing d-tag
  const noDTag = { ...raw, tags: [], id: "no_d" };
  assert(!parseEscrowEvent(noDTag, decrypted, true).ok, "Parser rejects missing d-tag");

  // Bad JSON
  assert(!parseEscrowEvent(raw, "not json {{{", true).ok, "Parser rejects invalid JSON");
}

// ── 11. CHAIN SORTING ────────────────────────────────────────────────────
console.log("\n── CHAIN SORTING ──");
{
  eventCounter = 300;

  const create = createEvent();
  const j1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
  const j2 = joinEvent(Role.ARBITER, ARBITER_PK, j1.raw.id);

  const unsorted = [j2, create, j1];
  const sorted = sortEventChain(unsorted);

  assert(sorted[0].raw.id === create.raw.id, "CREATE first after sort");
  assert(sorted[1].raw.id === j1.raw.id, "JOIN (buyer) second");
  assert(sorted[2].raw.id === j2.raw.id, "JOIN (arbiter) third");
}

// ── 12. FILTER BUILDER ───────────────────────────────────────────────────
console.log("\n── FILTER BUILDER ──");
{
  const filter = buildEscrowFilter("my-escrow-123");
  assert(Array.isArray(filter.kinds), "Filter has kinds array");
  assert(filter.kinds.includes(EscrowEventKind.CREATE), "Filter includes CREATE kind");
  assert(filter["#d"]?.[0] === "my-escrow-123", "Filter targets escrow ID");
}

// ── 13. EXPIRY ────────────────────────────────────────────────────────────
console.log("\n── EXPIRY ──");
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;

  assert(!isExpired(state, NOW + 100), "Not expired within window");
  assert(isExpired(state, NOW + 100_000), "Expired past deadline");
}

// ══════════════════════════════════════════════════════════════════════════
// PR 2 — community + listing schema + BLF resolver + vote labels
// ══════════════════════════════════════════════════════════════════════════

// ── 14. COMMUNITY REGISTRY + STORAGE ─────────────────────────────────────
console.log("\n── COMMUNITY REGISTRY + STORAGE ──");
{
  // v0.1.85: registry pre-seed expanded to 5 entries — sn-cfa, global-usd,
  // ke-kes (now Afribit-backed), us-blf (new), sv-usd (sunset, hiddenFromPicker).
  // Permissionless additions live in localStorage and are not counted here.
  assert(COMMUNITY_REGISTRY.length === 5, "Registry has the 5 v0.1.85 pre-seeds");
  assert(getCommunityBySlug("sn-cfa")?.currency === "XOF", "sn-cfa is XOF");
  assert(getCommunityBySlug("ke-kes")?.currency === "KES", "ke-kes is KES");
  assert(getCommunityBySlug("sv-usd")?.currency === "USD", "sv-usd is USD");
  assert(getCommunityBySlug("global-usd")?.currency === "USD", "global-usd is USD");
  assert(getCommunityBySlug("us-blf")?.currency === "USD", "us-blf is USD");
  assert(DEFAULT_COMMUNITY_SLUG === "global-usd", "Default community is global-usd");

  // Lookup with valid + missing slug
  assert(getCommunityBySlug("sn-cfa") !== null, "Valid slug returns community");
  assert(getCommunityBySlug("xx-zz") === null, "Unknown slug returns null");
  assert(getCommunityBySlug(null) === null, "Null slug returns null");
  assert(getCommunityBySlug(undefined) === null, "Undefined slug returns null");

  // v0.1.85: every pre-seed now pins federationInvite explicitly. BP for
  // browser-friendly defaults (sn-cfa, global-usd), Afribit for ke-kes,
  // BLF for the explicit us-blf entry. sv-usd carries a null invite as
  // a sunset marker (hidden from picker; resolves on-the-wire to BP).
  const allPinned = COMMUNITY_REGISTRY
    .filter(c => !c.hiddenFromPicker)
    .every(c => typeof c.federationInvite === "string" && c.federationInvite.startsWith("fed1"));
  assert(allPinned,
    "Every visible pre-seed pins federationInvite explicitly (no implicit fallback)");
  assert(getCommunityBySlug("sv-usd")?.hiddenFromPicker === true,
    "sv-usd is hidden from picker (sunset entry)");
  assert(getCommunityBySlug("sv-usd")?.federationInvite === null,
    "sv-usd carries null invite (resolves to BP fallback on-the-wire)");

  // Schema additions: every entry must carry the new fields
  for (const c of COMMUNITY_REGISTRY) {
    assert(typeof c.flagEmoji === "string" && c.flagEmoji.length > 0,
      `${c.slug} has flagEmoji`);
    assert(c.country === null || typeof c.country === "string",
      `${c.slug} country is string|null`);
    assert(typeof c.browserReliable === "boolean",
      `${c.slug} has browserReliable`);
    assert(typeof c.hiddenFromPicker === "boolean",
      `${c.slug} has hiddenFromPicker`);
  }
  // Reliability flags reflect transport reality. v0.1.85 smoke-test
  // discovery: every Fedimint federation we have access to today
  // shares the same iroh-relay infrastructure, so browser users hit
  // the same flakiness regardless of which fed they pick. The flag
  // stays in the schema so individual entries flip back to true once
  // upstream @fedimint/transport-web lands a fix and we verify per-fed.
  for (const c of COMMUNITY_REGISTRY) {
    assert(c.browserReliable === false,
      `${c.slug} browserReliable=false (universal iroh-relay limitation)`);
    assert(typeof c.notes === "string" && c.notes.includes("iroh-relay"),
      `${c.slug} carries the shared iroh-limitation note`);
  }
  assert(getCommunityBySlug("ke-kes")?.disambiguator === "Afribit",
    "ke-kes disambiguator=Afribit (multi-fed-per-country prep)");

  // Picker filter excludes hiddenFromPicker entries
  const picker = getPickerCommunities();
  assert(picker.length === 4, "Picker shows 4 visible entries (sv-usd hidden)");
  assert(!picker.some(c => c.slug === "sv-usd"),
    "Picker excludes sv-usd");
  assert(picker.some(c => c.slug === "us-blf"),
    "Picker includes us-blf");

  // Storage roundtrip — defaults to global-usd when nothing set
  (globalThis as any).localStorage.clear();
  assert(getUserCommunitySlug() === "global-usd",
    "getUserCommunitySlug defaults to global-usd when nothing stored");

  // Set + read
  setUserCommunitySlug("sn-cfa");
  assert(getUserCommunitySlug() === "sn-cfa", "Persisted slug round-trips");

  // Stale/invalid slug falls back to default rather than flowing through
  (globalThis as any).localStorage.setItem(COMMUNITY_STORAGE_KEY, "ghost-fed");
  assert(getUserCommunitySlug() === "global-usd",
    "Unknown stored slug falls back to default (registry validation)");

  // Clear via empty string
  setUserCommunitySlug("ke-kes");
  assert(getUserCommunitySlug() === "ke-kes", "Pre-clear: ke-kes set");
  setUserCommunitySlug("");
  assert(getUserCommunitySlug() === "global-usd", "Empty string clears, falls to default");
}

// ── 14b. PERMISSIONLESS COMMUNITY ADDITION (v0.1.85) ─────────────────────
console.log("\n── PERMISSIONLESS COMMUNITY ADDITION ──");
{
  (globalThis as any).localStorage.clear();

  // Empty by default
  assert(getCustomCommunities().length === 0, "No custom communities initially");
  assert(getCustomCommunityBySlug("anywhere") === null, "Unknown custom slug → null");

  // Successful add — new entry surfaces in lookups + persists to localStorage
  const fakeInvite = "fed1qtest_user_added_community_invite_for_persistence_test";
  const added = addCustomCommunity({
    slug: "br-brl",
    displayName: "Brazil · BRL",
    currency: "brl",
    country: "BR",
    flagEmoji: "🇧🇷",
    federationInvite: fakeInvite,
    languages: ["pt"],
  });
  assert(added.slug === "br-brl", "addCustomCommunity returns the new entry");
  assert(added.currency === "BRL", "Currency normalized to upper-case");
  assert(added.notes === "user-added", "User-added entries marked in notes");
  assert(added.browserReliable === true, "Default browserReliable is true");
  assert(added.hiddenFromPicker === false, "User-added entries are visible by default");

  assert(getCustomCommunities().length === 1, "One custom community after add");
  assert(getCustomCommunityBySlug("br-brl")?.federationInvite === fakeInvite,
    "Custom community persists with full payload");
  assert(getCommunityBySlug("br-brl")?.flagEmoji === "🇧🇷",
    "getCommunityBySlug walks pre-seeds AND custom entries");

  // localStorage roundtrip — re-reading from raw storage finds the entry
  const raw = (globalThis as any).localStorage.getItem("chama_custom_communities");
  assert(raw && raw.includes("br-brl"), "Persisted to chama_custom_communities key");

  // Slug collision with pre-seed → throws
  let threwOnPreSeedCollision = false;
  try {
    addCustomCommunity({
      slug: "sn-cfa",
      displayName: "Hijack",
      currency: "XOF",
      country: "SN",
      flagEmoji: "🇸🇳",
      federationInvite: fakeInvite,
    });
  } catch (e: any) {
    threwOnPreSeedCollision = /pre-seeded/.test(e.message || "");
  }
  assert(threwOnPreSeedCollision, "Pre-seed slug collision rejects with clear error");

  // Invalid invite → throws
  let threwOnBadInvite = false;
  try {
    addCustomCommunity({
      slug: "xx-test",
      displayName: "Test",
      currency: "USD",
      country: null,
      flagEmoji: "🌍",
      federationInvite: "not-a-fed1-invite",
    });
  } catch (e: any) {
    threwOnBadInvite = /fed1/.test(e.message || "");
  }
  assert(threwOnBadInvite, "Invalid invite rejects with clear error");

  // Invalid slug shape → throws
  let threwOnBadSlug = false;
  try {
    addCustomCommunity({
      slug: "Bad Slug!",
      displayName: "Test",
      currency: "USD",
      country: null,
      flagEmoji: "🌍",
      federationInvite: fakeInvite,
    });
  } catch (e: any) {
    threwOnBadSlug = /slug/.test(e.message || "");
  }
  assert(threwOnBadSlug, "Invalid slug shape rejects with clear error");

  // Update-by-overwrite: re-adding same slug overwrites payload
  addCustomCommunity({
    slug: "br-brl",
    displayName: "Brazil · BRL · Updated",
    currency: "BRL",
    country: "BR",
    flagEmoji: "🇧🇷",
    federationInvite: fakeInvite,
  });
  assert(getCustomCommunities().length === 1, "Re-add same slug overwrites, doesn't duplicate");
  assert(getCustomCommunityBySlug("br-brl")?.displayName === "Brazil · BRL · Updated",
    "Re-add updates fields in place");

  // Removal works
  removeCustomCommunity("br-brl");
  assert(getCustomCommunities().length === 0, "Custom community removed");
  assert(getCustomCommunityBySlug("br-brl") === null, "Lookup after remove returns null");

  // Picker integration — custom entries don't appear in pre-seed picker by default
  // (picker callers compose: pre-seed + custom themselves)
  assert(getPickerCommunities().every(c => c.notes !== "user-added"),
    "getPickerCommunities returns only pre-seeds");
}

// ── 15. BP / BLF RESOLVER ────────────────────────────────────────────────
// v0.1.85: the universal browser-friendly fallback is BP, not BLF. Every
// pre-seeded community now has an explicit federationInvite. BLF is
// reachable only via the us-blf entry, sandbox-mode picker, or a pasted
// custom invite — never as an ambient fallback.
console.log("\n── BP / BLF RESOLVER ──");
{
  // No custom invite, no community: BP fallback
  (globalThis as any).localStorage.clear();
  assert(resolveFederationForCommunity(null) === BP_FEDERATION_INVITE,
    "Null slug → BP default");
  assert(resolveFederationForCommunity(undefined) === BP_FEDERATION_INVITE,
    "Undefined slug → BP default");
  assert(resolveFederationForCommunity("xx-unknown") === BP_FEDERATION_INVITE,
    "Unknown slug → BP default");

  // Pre-seeded communities resolve to their pinned invite, not the BP
  // fallback — the registry now carries the choice explicitly.
  const snCfaInvite = getCommunityBySlug("sn-cfa")!.federationInvite!;
  assert(resolveFederationForCommunity("sn-cfa") === snCfaInvite,
    "sn-cfa → registry-pinned invite");
  assert(snCfaInvite === BP_FEDERATION_INVITE,
    "sn-cfa pins BP (browser-friendly fallback)");

  const keKesInvite = getCommunityBySlug("ke-kes")!.federationInvite!;
  assert(resolveFederationForCommunity("ke-kes") === keKesInvite,
    "ke-kes → registry-pinned invite");
  assert(keKesInvite !== BP_FEDERATION_INVITE && keKesInvite !== BLF_FEDERATION_INVITE,
    "ke-kes pins Afribit (distinct from BP and BLF)");

  const globalUsdInvite = getCommunityBySlug("global-usd")!.federationInvite!;
  assert(resolveFederationForCommunity("global-usd") === globalUsdInvite,
    "global-usd → registry-pinned BP invite");
  assert(globalUsdInvite === BP_FEDERATION_INVITE,
    "global-usd pins BP");

  const usBlfInvite = getCommunityBySlug("us-blf")!.federationInvite!;
  assert(resolveFederationForCommunity("us-blf") === usBlfInvite,
    "us-blf → registry-pinned invite");
  assert(usBlfInvite === BLF_FEDERATION_INVITE,
    "us-blf pins BLF (the only opt-in path to BLF as a community)");

  // Custom invite override beats community resolution
  const fakeCustomInvite = "fed1qcustom_user_pasted_invite_for_resolver_test";
  setCustomFederationInvite(fakeCustomInvite);
  assert(resolveFederationForCommunity("sn-cfa") === fakeCustomInvite,
    "Custom invite overrides community resolution");
  assert(resolveFederationForCommunity(null) === fakeCustomInvite,
    "Custom invite overrides null slug too");

  // Cleanup so other tests aren't poisoned
  setCustomFederationInvite("");
  assert(resolveFederationForCommunity(null) === BP_FEDERATION_INVITE,
    "After clearing custom invite, falls back to BP again");
}

// ── 16. FULFILLMENT NORMALIZATION ────────────────────────────────────────
console.log("\n── FULFILLMENT NORMALIZATION (handleCreate) ──");
{
  // Helper to build a CREATE with a specific category + fulfillment
  function createWith(category: string, fulfillment?: "physical" | "service" | "digital") {
    return makeParsedEvent(EscrowEventKind.CREATE, SELLER_PK, {
      type: "escrow:create",
      description: "test",
      amountMsats: 100_000_000,
      category,
      fulfillment,
      community: "sn-cfa",
      mintUrl: "fed11q...",
      platformFeeBps: 50,
      platformFeePubkey: PLATFORM_PK,
      arbiterFeeMsats: 1_000_000,
      expirySeconds: 86400,
      createdAt: NOW,
    });
  }

  // Marketplace + explicit pick → preserved
  {
    const r = applyEvent(null, createWith("marketplace", "digital"));
    if (assertOk(r, "Marketplace + digital → CREATED")) {
      assert(r.state.fulfillment === "digital", "Marketplace user pick preserved (digital)");
      assert(r.state.community === "sn-cfa", "Community slug propagated to state");
    }
  }
  {
    const r = applyEvent(null, createWith("marketplace", "service"));
    if (assertOk(r, "Marketplace + service → CREATED")) {
      assert(r.state.fulfillment === "service", "Marketplace user pick preserved (service)");
    }
  }

  // Marketplace + missing → defaults to "physical"
  {
    const r = applyEvent(null, createWith("marketplace"));
    if (assertOk(r, "Marketplace + missing fulfillment → CREATED")) {
      assert(r.state.fulfillment === "physical",
        "Marketplace defaults to physical when fulfillment missing");
    }
  }

  // Non-marketplace → forced to "service" regardless of input
  for (const cat of ["p2p-trade", "bill-pay", "lending"]) {
    const r1 = applyEvent(null, createWith(cat));
    if (assertOk(r1, `${cat} + missing fulfillment → CREATED`)) {
      assert(r1.state.fulfillment === "service",
        `${cat} fulfillment defaults to "service" when missing`);
    }
    // Even if a misbehaving client passed "physical", normalize to service
    const r2 = applyEvent(null, createWith(cat, "physical"));
    if (assertOk(r2, `${cat} + (incorrect) physical → CREATED`)) {
      assert(r2.state.fulfillment === "service",
        `${cat} normalizes wire fulfillment back to "service" (chain consistency)`);
    }
  }

  // Community is null when CREATE omits it (pre-PR-2 backwards compat)
  {
    const noCommunity = makeParsedEvent(EscrowEventKind.CREATE, SELLER_PK, {
      type: "escrow:create",
      description: "test",
      amountMsats: 100_000_000,
      category: "p2p-trade",
      mintUrl: "fed11q...",
      platformFeeBps: 50,
      platformFeePubkey: PLATFORM_PK,
      arbiterFeeMsats: 1_000_000,
      expirySeconds: 86400,
      createdAt: NOW,
    });
    const r = applyEvent(null, noCommunity);
    if (assertOk(r, "CREATE without community → CREATED")) {
      assert(r.state.community === null, "community is null when omitted (backwards compat)");
    }
  }
}

// ── 17. VOTE LABEL DICTIONARY ────────────────────────────────────────────
console.log("\n── VOTE LABEL DICTIONARY ──");
{
  // Helpers
  assert(defaultFulfillmentFor("marketplace") === "physical",
    "Marketplace default fulfillment is physical");
  assert(defaultFulfillmentFor("p2p-trade") === "service",
    "p2p-trade default fulfillment is service");
  assert(defaultFulfillmentFor("bill-pay") === "service",
    "bill-pay default fulfillment is service");
  assert(defaultFulfillmentFor(undefined) === "service",
    "Undefined category default fulfillment is service");
  assert(categoryAllowsFulfillmentChoice("marketplace") === true,
    "Marketplace allows fulfillment choice");
  assert(categoryAllowsFulfillmentChoice("p2p-trade") === false,
    "p2p-trade does NOT allow fulfillment choice");
  assert(categoryAllowsFulfillmentChoice("bill-pay") === false,
    "bill-pay does NOT allow fulfillment choice");

  // Marketplace — three fulfillments × buyer/seller × release/refund
  assert(getVoteLabel("marketplace", "physical", Role.BUYER, Outcome.RELEASE) === "I received it",
    "marketplace/physical/buyer/release = 'I received it'");
  assert(getVoteLabel("marketplace", "physical", Role.SELLER, Outcome.RELEASE) === "Item delivered",
    "marketplace/physical/seller/release = 'Item delivered'");
  assert(getVoteLabel("marketplace", "physical", Role.BUYER, Outcome.REFUND) === "I didn't get it",
    "marketplace/physical/buyer/refund = 'I didn't get it'");
  assert(getVoteLabel("marketplace", "service", Role.BUYER, Outcome.RELEASE) === "I received the service",
    "marketplace/service/buyer/release");
  assert(getVoteLabel("marketplace", "service", Role.SELLER, Outcome.RELEASE) === "Service rendered",
    "marketplace/service/seller/release");
  assert(getVoteLabel("marketplace", "digital", Role.BUYER, Outcome.RELEASE) === "I received the file",
    "marketplace/digital/buyer/release");
  assert(getVoteLabel("marketplace", "digital", Role.SELLER, Outcome.RELEASE) === "Delivered",
    "marketplace/digital/seller/release");
  assert(getVoteLabel("marketplace", "digital", Role.BUYER, Outcome.REFUND) === "File never arrived",
    "marketplace/digital/buyer/refund");

  // P2P (always service)
  assert(getVoteLabel("p2p-trade", "service", Role.BUYER, Outcome.RELEASE) === "I sent the fiat",
    "p2p/buyer/release = 'I sent the fiat'");
  assert(getVoteLabel("p2p-trade", "service", Role.SELLER, Outcome.RELEASE) === "Fiat received",
    "p2p/seller/release = 'Fiat received'");

  // Bill Pay — payer is the seller (sats-receiver), payee is the buyer (bill-holder)
  assert(getVoteLabel("bill-pay", "service", Role.BUYER, Outcome.RELEASE) === "My bill was paid",
    "bill-pay/buyer/release = 'My bill was paid'");
  assert(getVoteLabel("bill-pay", "service", Role.SELLER, Outcome.RELEASE) === "Bill has been paid",
    "bill-pay/seller/release = 'Bill has been paid'");

  // Lending (placeholder labels for v1)
  assert(getVoteLabel("lending", "service", Role.BUYER, Outcome.RELEASE) === "I got the loan",
    "lending/buyer/release = 'I got the loan'");
  assert(getVoteLabel("lending", "service", Role.SELLER, Outcome.RELEASE) === "Loan disbursed",
    "lending/seller/release = 'Loan disbursed'");

  // Arbiter neutral fallback
  assert(getVoteLabel("marketplace", "physical", Role.ARBITER, Outcome.RELEASE) === "Side with buyer",
    "Arbiter RELEASE = 'Side with buyer' (neutral)");
  assert(getVoteLabel("p2p-trade", "service", Role.ARBITER, Outcome.REFUND) === "Side with seller",
    "Arbiter REFUND = 'Side with seller' (neutral)");

  // Unknown category falls through to neutral
  assert(getVoteLabel("raw-escrow", "service", Role.BUYER, Outcome.RELEASE) === "Release sats",
    "Unknown category → neutral 'Release sats'");
  assert(getVoteLabel(undefined, undefined, Role.SELLER, Outcome.REFUND) === "Refund sats",
    "Undefined category+fulfillment → neutral 'Refund sats'");

  // Marketplace + missing fulfillment falls back to neutral (the dictionary
  // requires an explicit fulfillment for marketplace; defaultFulfillmentFor
  // is what callers should use to fill it in beforehand).
  // Sanity: when callers DO use the default, marketplace/buyer/release lands.
  assert(getVoteLabel("marketplace", defaultFulfillmentFor("marketplace"), Role.BUYER, Outcome.RELEASE)
    === "I received it",
    "Using defaultFulfillmentFor('marketplace') yields the physical labels");
}

// ══════════════════════════════════════════════════════════════════════════
// PR 3 — saved payment handles + handle reveal in LOCK
// ══════════════════════════════════════════════════════════════════════════

// ── 18. RAIL REGISTRY + allowPublicHandle ─────────────────────────────────
console.log("\n── RAIL REGISTRY ──");
{
  // Sanity: registry loaded with v1 seeds
  assert(RAIL_REGISTRY.length > 0, "Rail registry has entries");

  // Sensitive rails (phone-number-based, bank, email-based) MUST NOT
  // allow public handles. This is the defense-in-depth invariant.
  assert(railAllowsPublicHandle("wave") === false,
    "Wave (Senegal mobile money) does NOT allow public handles");
  assert(railAllowsPublicHandle("orange-money") === false,
    "Orange Money does NOT allow public handles");
  assert(railAllowsPublicHandle("m-pesa") === false,
    "M-Pesa does NOT allow public handles");
  assert(railAllowsPublicHandle("bank-transfer") === false,
    "Bank transfer does NOT allow public handles");
  assert(railAllowsPublicHandle("paypal") === false,
    "PayPal (email-based) does NOT allow public handles");
  assert(railAllowsPublicHandle("zelle") === false,
    "Zelle does NOT allow public handles");
  assert(railAllowsPublicHandle("venmo") === false,
    "Venmo defaults to private (handle-can-be-PII-adjacent)");

  // Public-by-design tags MUST allow public handles (the username IS
  // the address — opt-in publishing is the whole point).
  assert(railAllowsPublicHandle("revtag") === true,
    "Revtag allows public handles (public-by-design)");
  assert(railAllowsPublicHandle("cashtag") === true,
    "$cashtag allows public handles");
  assert(railAllowsPublicHandle("zbd") === true,
    "ZBD username allows public handles");
  assert(railAllowsPublicHandle("wise-tag") === true,
    "Wise tag allows public handles");
  assert(railAllowsPublicHandle("strike") === true,
    "Strike allows public handles");

  // Unknown rail → conservative refusal (don't promote unfamiliar
  // handles to public by accident).
  assert(railAllowsPublicHandle("never-heard-of-it") === false,
    "Unknown rail conservatively refuses public");
  assert(railAllowsPublicHandle(null) === false,
    "Null rail conservatively refuses public");

  // railsForCommunity: region-scoped + cross-community filtering
  const senegal = railsForCommunity("sn-cfa");
  assert(senegal.some(r => r.key === "wave"),
    "sn-cfa community shows Wave");
  assert(senegal.some(r => r.key === "orange-money"),
    "sn-cfa community shows Orange Money");
  assert(senegal.some(r => r.key === "revtag"),
    "sn-cfa community ALSO shows global rails (Revtag)");
  assert(!senegal.some(r => r.key === "m-pesa"),
    "sn-cfa community does NOT show m-pesa (Kenya-only)");

  const kenya = railsForCommunity("ke-kes");
  assert(kenya.some(r => r.key === "m-pesa"),
    "ke-kes community shows M-Pesa");
  assert(!kenya.some(r => r.key === "wave"),
    "ke-kes community does NOT show Wave (Senegal-only)");

  // Lookup
  assert(getRailByKey("revtag")?.displayName === "Revtag (Revolut)",
    "getRailByKey returns the right rail");
  assert(getRailByKey("xyz") === null, "Unknown key → null");
  assert(getRailByKey(null) === null, "Null key → null");
}

// ── 19. SAVED HANDLES — CRUD + visibility refusal ────────────────────────
console.log("\n── SAVED HANDLES (CRUD + visibility) ──");
{
  // Reset storage so this section starts clean
  (globalThis as any).localStorage.clear();
  assert(listSavedHandles().length === 0, "Fresh storage starts empty");

  // Add — defaults to private
  const a = addSavedHandle("revtag", "@alice");
  assert(a.id.startsWith("h_"), "addSavedHandle returns a generated ID");
  assert(a.rail === "revtag", "Saved rail matches");
  assert(a.handle === "@alice", "Saved handle matches");
  assert(a.visibility === "private", "New handles default to private");
  assert(typeof a.createdAt === "number", "createdAt set");

  // Round-trip: reading back returns the same shape
  const list1 = listSavedHandles();
  assert(list1.length === 1, "List shows 1 entry after add");
  assert(list1[0].id === a.id, "Round-trip ID matches");

  // Whitespace trimmed
  const trimmed = addSavedHandle("revtag", "  @bob  ");
  assert(trimmed.handle === "@bob", "addSavedHandle trims whitespace");

  // Empty handle rejected
  let threw = false;
  try { addSavedHandle("revtag", "   "); } catch { threw = true; }
  assert(threw, "addSavedHandle rejects empty handle (post-trim)");

  // getSavedHandle by ID
  assert(getSavedHandle(a.id)?.handle === "@alice",
    "getSavedHandle returns matching entry");
  assert(getSavedHandle("h_nope") === null,
    "getSavedHandle returns null for unknown ID");

  // getSavedHandlesByRail filters and orders newest-first
  const senegal = addSavedHandle("wave", "+221 77 555 1234");
  const byRevtag = getSavedHandlesByRail("revtag");
  assert(byRevtag.length === 2, "Two revtag handles");
  assert(byRevtag.every(h => h.rail === "revtag"),
    "getSavedHandlesByRail filters correctly");
  assert(getSavedHandlesByRail("wave").length === 1, "One wave handle");

  // Update
  const updated = updateSavedHandle(a.id, { handle: "@alice.new" });
  assert(updated?.handle === "@alice.new", "updateSavedHandle changes handle");
  assert(updated?.id === a.id, "ID preserved on update");
  assert(getSavedHandle(a.id)?.handle === "@alice.new",
    "Update persisted to storage");

  // Visibility — public allowed for revtag (allowPublicHandle: true)
  const setPublic = setHandleVisibility(a.id, "public");
  assert(setPublic.ok === true, "Setting Revtag handle to public succeeds");
  if (setPublic.ok) {
    assert(setPublic.handle.visibility === "public",
      "Returned handle shows public");
  }
  assert(getSavedHandle(a.id)?.visibility === "public",
    "Public visibility persisted");

  // Visibility — public REJECTED for wave (allowPublicHandle: false).
  // Defense in depth: even if the UI accidentally renders the toggle,
  // this layer refuses the change.
  const setPublicSensitive = setHandleVisibility(senegal.id, "public");
  assert(setPublicSensitive.ok === false,
    "Setting Wave handle to public is REJECTED (defense in depth)");
  if (!setPublicSensitive.ok) {
    assert(/doesn't allow public/i.test(setPublicSensitive.error),
      "Refusal carries an explanatory message");
  }
  // And the storage is unchanged
  assert(getSavedHandle(senegal.id)?.visibility === "private",
    "Sensitive handle remains private after rejected upgrade");

  // Setting back to private is always allowed
  const back = setHandleVisibility(a.id, "private");
  assert(back.ok === true, "Setting back to private always allowed");
  assert(getSavedHandle(a.id)?.visibility === "private",
    "Private downgrade persisted");

  // Visibility on unknown ID errors cleanly
  const setMissing = setHandleVisibility("h_does_not_exist", "private");
  assert(setMissing.ok === false, "Visibility on unknown ID returns error");

  // Delete
  deleteSavedHandle(a.id);
  assert(getSavedHandle(a.id) === null, "deleteSavedHandle removes the entry");
  assert(listSavedHandles().length === 2, "Other entries unaffected by delete");
}

// ── 20. MASKING + handleDisplayForViewer ─────────────────────────────────
console.log("\n── MASKING + viewer-aware display ──");
{
  // Phone-shaped: keep prefix + last 4
  assert(maskHandle("+221 77 123 4567").includes("•••"),
    "Phone handle gets masked");
  assert(maskHandle("+221 77 123 4567").endsWith("4567"),
    "Phone handle keeps last 4 digits");
  assert(maskHandle("+221 77 123 4567").startsWith("+221"),
    "Phone handle keeps country prefix");

  // Email-shaped: mask local + domain
  const masked = maskHandle("alice@example.com");
  assert(masked.includes("@"), "Email handle keeps the @");
  assert(masked.startsWith("a•••"), "Email keeps first char of local");

  // Generic short handle
  assert(maskHandle("@x") === "•••", "Very short handle fully masked");
  assert(maskHandle("@username").includes("•••"),
    "Generic handle gets masked");

  // handleDisplayForViewer — viewer-context decides everything
  assert(handleDisplayForViewer("+221 77 555 1234", true) === "+221 77 555 1234",
    "Participant viewer sees cleartext");
  assert(handleDisplayForViewer("+221 77 555 1234", false).includes("•••"),
    "Non-participant viewer sees masked output");
  // Critical invariant: non-participants see masked REGARDLESS of how
  // the data got into client state (e.g. legacy plaintext on wire).
  // The flag the seller set is irrelevant to viewer-side rendering.
  assert(handleDisplayForViewer("@public-handle", false).includes("•••"),
    "Non-participants see masked even for public-by-design handles");

  // publicHandleDisplay — visibility flag + rail policy gate
  (globalThis as any).localStorage.clear();
  const publicTag = addSavedHandle("revtag", "@bob");
  setHandleVisibility(publicTag.id, "public");
  const publicTagAfter = getSavedHandle(publicTag.id)!;
  assert(publicHandleDisplay(publicTagAfter) === "@bob",
    "publicHandleDisplay returns cleartext when public + allowed");

  const sensitive = addSavedHandle("wave", "+221 77 555 1234");
  // setHandleVisibility refused public above, so it's still private
  const sensitiveAfter = getSavedHandle(sensitive.id)!;
  assert(publicHandleDisplay(sensitiveAfter).includes("•••"),
    "publicHandleDisplay masks private (and sensitive-by-policy) handles");
}

// ── 21. LOCK PAYLOAD HANDLE PROPAGATION ──────────────────────────────────
console.log("\n── LOCK HANDLE PROPAGATION (atomic-funding flow) ──");
{
  // CREATE → LOCK with handleId/handle/rail in payload, verify state
  // captures the resolved handle on EscrowState.lock.handle.
  eventCounter = 400;

  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  assert(state.lock.handle === null,
    "Pre-LOCK: state.lock.handle is null");

  // Build a LOCK payload with handle fields
  const lockWithHandle = makeParsedEvent(EscrowEventKind.LOCK, SELLER_PK, {
    type: "escrow:lock" as const,
    notesHash: "hash_of_ecash_notes_abc123",
    shares: [
      { shareIndex: 0, encryptedFor: { [BUYER_PK]: "x", [SELLER_PK]: "x", [ARBITER_PK]: "x" } },
      { shareIndex: 1, encryptedFor: { [BUYER_PK]: "x", [SELLER_PK]: "x", [ARBITER_PK]: "x" } },
      { shareIndex: 2, encryptedFor: { [BUYER_PK]: "x", [SELLER_PK]: "x", [ARBITER_PK]: "x" } },
    ],
    sellerReceivesMsats: 99_000_000,
    arbiterFeeMsats: 1_000_000,
    buyerPubkey: BUYER_PK,
    arbiterPubkey: ARBITER_PK,
    handleId: "h_seller_local_id_xyz",
    handle: "+221 77 555 1234",
    rail: "wave",
    lockedAt: NOW,
  }, create.raw.id);

  const r = applyEvent(state, lockWithHandle);
  if (assertOk(r, "LOCK with handle/rail/handleId → LOCKED")) {
    assert(r.state.status === EscrowStatus.LOCKED, "Status is LOCKED");
    assert(r.state.lock.handle !== null,
      "state.lock.handle populated by LOCK payload");
    assert(r.state.lock.handle?.value === "+221 77 555 1234",
      "Resolved handle cleartext stored on EscrowState");
    assert(r.state.lock.handle?.id === "h_seller_local_id_xyz",
      "handleId audit reference preserved");
    assert(r.state.lock.handle?.rail === "wave",
      "Rail key preserved");
  }

  // LOCK without handle fields (non-fiat trade) leaves lock.handle null
  eventCounter = 500;
  const create2 = createEvent();
  let state2 = (applyEvent(null, create2) as any).state;
  const lockBare = lockEvent(create2.raw.id);
  const r2 = applyEvent(state2, lockBare);
  if (assertOk(r2, "LOCK without handle fields → LOCKED")) {
    assert(r2.state.lock.handle === null,
      "state.lock.handle stays null when LOCK omits handle");
  }

  // Defense-in-depth: the masking gate at the render boundary still
  // applies even when state has cleartext locally. Non-participant
  // sees masked output regardless of what's in state.lock.handle.value.
  if (r.ok && r.state.lock.handle) {
    const cleartext = r.state.lock.handle.value;
    assert(handleDisplayForViewer(cleartext, true) === cleartext,
      "Participant view: full cleartext from LOCK");
    assert(handleDisplayForViewer(cleartext, false).includes("•••"),
      "Non-participant view: masked even though cleartext sits in state");
  }
}

// ── 22. EVENT PARSER — handle field validation ────────────────────────────
console.log("\n── EVENT PARSER (PR 3 LOCK handle fields) ──");
{
  const baseLock = {
    type: "escrow:lock" as const,
    notesHash: "h",
    shares: [
      { shareIndex: 0, encryptedFor: { x: "y" } },
      { shareIndex: 1, encryptedFor: { x: "y" } },
      { shareIndex: 2, encryptedFor: { x: "y" } },
    ],
    sellerReceivesMsats: 99_000_000,
    arbiterFeeMsats: 1_000_000,
    buyerPubkey: BUYER_PK,
    arbiterPubkey: ARBITER_PK,
    lockedAt: NOW,
  };
  const raw = {
    id: "lock_parse_test",
    pubkey: SELLER_PK,
    created_at: NOW,
    kind: EscrowEventKind.LOCK,
    tags: [["d", "lock-parse"]],
    content: "x",
    sig: "s",
  };

  // Valid: with all PR 3 fields
  const okWith = parseEscrowEvent(raw, JSON.stringify({
    ...baseLock, handleId: "h_x", handle: "@alice", rail: "revtag",
  }), true);
  assert(okWith.ok === true, "Parser accepts LOCK with handle fields");

  // Valid: without (optional)
  const okWithout = parseEscrowEvent(raw, JSON.stringify(baseLock), true);
  assert(okWithout.ok === true, "Parser accepts LOCK without handle fields");

  // Invalid: empty-string handle
  const badEmpty = parseEscrowEvent(raw, JSON.stringify({
    ...baseLock, handle: "",
  }), true);
  assert(!badEmpty.ok, "Parser rejects LOCK with empty-string handle");

  // Invalid: non-string rail
  const badRailType = parseEscrowEvent(raw, JSON.stringify({
    ...baseLock, rail: 123,
  }), true);
  assert(!badRailType.ok, "Parser rejects LOCK with non-string rail");
}

// ══════════════════════════════════════════════════════════════════════════
// PR 4 — LOCK 3-recipient envelope encryption
// ══════════════════════════════════════════════════════════════════════════

// ── 23. ENVELOPE HELPER (encrypt/decrypt round-trip) ─────────────────────
console.log("\n── ENVELOPE HELPER ──");
{
  // Generate three real keypairs. The locker (seller) is the sender;
  // each recipient decrypts their own entry.
  const sellerPriv  = generateSecretKey();
  const buyerPriv   = generateSecretKey();
  const arbiterPriv = generateSecretKey();
  const strangerPriv = generateSecretKey();
  const sellerPub   = getPublicKey(sellerPriv);
  const buyerPub    = getPublicKey(buyerPriv);
  const arbiterPub  = getPublicKey(arbiterPriv);
  const strangerPub = getPublicKey(strangerPriv);

  const sellerCrypto   = makeNip44(sellerPriv);
  const buyerCrypto    = makeNip44(buyerPriv);
  const arbiterCrypto  = makeNip44(arbiterPriv);
  const strangerCrypto = makeNip44(strangerPriv);

  // Run async assertions in a top-level await IIFE-like block.
  // tsx supports top-level await, so we just await directly.
  const cleartext = JSON.stringify({
    handleId: "h_seller_local_xyz",
    handle: "+221 77 555 1234",
    rail: "wave",
  });

  const env = await createEnvelope(
    cleartext,
    [buyerPub, sellerPub, arbiterPub],
    sellerCrypto.encrypt,
  );

  // Three entries, one per recipient
  assert(Object.keys(env.encryptedFor).length === 3,
    "Envelope has exactly 3 entries for 3 distinct recipients");
  assert(env.encryptedFor[buyerPub] !== undefined,
    "Envelope has buyer entry");
  assert(env.encryptedFor[sellerPub] !== undefined,
    "Envelope has seller entry");
  assert(env.encryptedFor[arbiterPub] !== undefined,
    "Envelope has arbiter entry");

  // Each ciphertext is non-empty and not the cleartext itself
  for (const [pk, ct] of Object.entries(env.encryptedFor)) {
    assert(ct !== cleartext,
      `Entry for ${pk.slice(0, 8)}… is encrypted (not raw cleartext)`);
    assert(ct.length > 0,
      `Entry for ${pk.slice(0, 8)}… is non-empty`);
  }

  // envelopeHasRecipient is the cheap check
  assert(envelopeHasRecipient(env, buyerPub) === true,
    "envelopeHasRecipient: buyer is in");
  assert(envelopeHasRecipient(env, strangerPub) === false,
    "envelopeHasRecipient: stranger is not in");

  // Each participant decrypts their entry to the SAME cleartext
  const buyerSees = await decryptFromEnvelope(env, buyerPub, sellerPub, buyerCrypto.decrypt);
  assert(buyerSees === cleartext,
    "Buyer decrypts their entry → matching cleartext");

  const sellerSees = await decryptFromEnvelope(env, sellerPub, sellerPub, sellerCrypto.decrypt);
  assert(sellerSees === cleartext,
    "Seller (locker) decrypts their own entry → matching cleartext");

  const arbiterSees = await decryptFromEnvelope(env, arbiterPub, sellerPub, arbiterCrypto.decrypt);
  assert(arbiterSees === cleartext,
    "Arbiter decrypts their entry → matching cleartext");

  // Non-participant: lookup miss → null
  const strangerSees = await decryptFromEnvelope(env, strangerPub, sellerPub, strangerCrypto.decrypt);
  assert(strangerSees === null,
    "Stranger (not in envelope) → null, no throw");

  // Even if a stranger somehow had a ciphertext to attempt, NIP-44 auth
  // would fail and decryptFromEnvelope returns null cleanly. Simulate
  // by giving them buyer's ciphertext; their decrypt with seller as
  // sender will fail because their ECDH(stranger_priv, seller_pub) is
  // a different shared secret than ECDH(buyer_priv, seller_pub).
  const tamperedEnv = { encryptedFor: { [strangerPub]: env.encryptedFor[buyerPub] } };
  const tamperedResult = await decryptFromEnvelope(tamperedEnv, strangerPub, sellerPub, strangerCrypto.decrypt);
  assert(tamperedResult === null,
    "Stranger handed buyer's ciphertext → null (NIP-44 auth fails cleanly, no throw)");

  // Empty recipients → empty envelope
  const emptyEnv = await createEnvelope("anything", [], sellerCrypto.encrypt);
  assert(Object.keys(emptyEnv.encryptedFor).length === 0,
    "Empty recipients list → empty envelope");

  // Duplicate recipients collapse
  const dupEnv = await createEnvelope("x", [buyerPub, buyerPub, buyerPub], sellerCrypto.encrypt);
  assert(Object.keys(dupEnv.encryptedFor).length === 1,
    "Duplicate recipient pubkeys collapse to a single entry");
}

// ── 24. LOCK WITH ENVELOPE — through the state machine ───────────────────
console.log("\n── LOCK WITH ENVELOPE (state machine) ──");
{
  // Build a real-crypto LOCK envelope, then simulate what escrow-client's
  // resolveLockEnvelope() does on each participant's side: decrypt their
  // entry, synthesize top-level handle fields, apply through the state
  // machine. End state: state.lock.handle.value matches cleartext for
  // each of the 3 participants.

  const sellerPriv  = generateSecretKey();
  const buyerPriv   = generateSecretKey();
  const arbiterPriv = generateSecretKey();
  const sellerPub   = getPublicKey(sellerPriv);
  const buyerPub    = getPublicKey(buyerPriv);
  const arbiterPub  = getPublicKey(arbiterPriv);

  const sellerCrypto  = makeNip44(sellerPriv);
  const buyerCrypto   = makeNip44(buyerPriv);
  const arbiterCrypto = makeNip44(arbiterPriv);

  const handleData = {
    handleId: "h_pr4_test",
    handle: "+221 77 555 1234",
    rail: "wave",
  };
  const handleJson = JSON.stringify(handleData);
  const envelope = await createEnvelope(
    handleJson,
    [buyerPub, sellerPub, arbiterPub],
    sellerCrypto.encrypt,
  );

  // Build CREATE (seller initiates a p2p-trade)
  eventCounter = 600;
  const create = makeParsedEvent(EscrowEventKind.CREATE, sellerPub, {
    type: "escrow:create",
    description: "PR 4 envelope test",
    amountMsats: 100_000_000,
    fiatAmount: 50,
    fiatCurrency: "USD",
    category: "p2p-trade",
    mintUrl: "fed11q...",
    platformFeeBps: 50,
    platformFeePubkey: PLATFORM_PK,
    arbiterFeeMsats: 1_000_000,
    expirySeconds: 86400,
    createdAt: NOW,
  });

  // Build LOCK with envelope only (no top-level handle fields — the wire
  // format that escrow-client.lockEscrow now emits in PR 4).
  const wireLock = makeParsedEvent(EscrowEventKind.LOCK, sellerPub, {
    type: "escrow:lock" as const,
    notesHash: "hash_of_ecash_notes_pr4",
    shares: [
      { shareIndex: 0, encryptedFor: { [buyerPub]: "x", [sellerPub]: "x", [arbiterPub]: "x" } },
      { shareIndex: 1, encryptedFor: { [buyerPub]: "x", [sellerPub]: "x", [arbiterPub]: "x" } },
      { shareIndex: 2, encryptedFor: { [buyerPub]: "x", [sellerPub]: "x", [arbiterPub]: "x" } },
    ],
    sellerReceivesMsats: 99_000_000,
    arbiterFeeMsats: 1_000_000,
    buyerPubkey: buyerPub,
    arbiterPubkey: arbiterPub,
    handleEnvelope: envelope,
    lockedAt: NOW,
  }, create.raw.id);

  // Each participant resolves the envelope on their side. This is what
  // escrow-client.resolveLockEnvelope does internally; here we exercise
  // the same shape directly.
  async function resolveAndApply(
    viewerPub: string,
    viewerCrypto: { decrypt: (ct: string, sender: string) => Promise<string> },
    label: string,
  ) {
    let createState: any;
    {
      const r = applyEvent(null, create);
      assert(r.ok, `${label}: CREATE applies`);
      createState = (r as any).state;
    }

    // Resolve viewer's entry
    const cleartext = await decryptFromEnvelope(
      envelope, viewerPub, sellerPub, viewerCrypto.decrypt,
    );
    assert(cleartext === handleJson,
      `${label}: envelope decrypt yields original cleartext`);

    const resolved = JSON.parse(cleartext!);
    const synthesizedLock = {
      ...wireLock,
      payload: {
        ...wireLock.payload,
        handleId: resolved.handleId,
        handle: resolved.handle,
        rail: resolved.rail,
      },
    };

    const r = applyEvent(createState, synthesizedLock);
    if (assertOk(r, `${label}: synthesized LOCK applies`)) {
      assert(r.state.status === EscrowStatus.LOCKED,
        `${label}: status is LOCKED`);
      assert(r.state.lock.handle?.value === handleData.handle,
        `${label}: state.lock.handle.value matches cleartext`);
      assert(r.state.lock.handle?.id === handleData.handleId,
        `${label}: handleId preserved`);
      assert(r.state.lock.handle?.rail === handleData.rail,
        `${label}: rail preserved`);
    }
  }

  await resolveAndApply(buyerPub,   buyerCrypto,   "BUYER");
  await resolveAndApply(sellerPub,  sellerCrypto,  "SELLER");
  await resolveAndApply(arbiterPub, arbiterCrypto, "ARBITER");

  // Non-participant view: a stranger trying to resolve the envelope
  // gets null, leaving state.lock.handle null after apply (the state
  // machine sees no top-level handle on the synthesized payload).
  const strangerPriv = generateSecretKey();
  const strangerPub = getPublicKey(strangerPriv);
  const strangerCrypto = makeNip44(strangerPriv);
  const strangerSees = await decryptFromEnvelope(
    envelope, strangerPub, sellerPub, strangerCrypto.decrypt,
  );
  assert(strangerSees === null, "Non-participant decrypt returns null");

  // What would happen if the stranger applied the wire LOCK as-is
  // (without any synthesis)? state.lock.handle stays null because
  // there's no top-level handle field. The cleartext is unreachable.
  {
    eventCounter = 700;
    const create2 = makeParsedEvent(EscrowEventKind.CREATE, sellerPub, {
      type: "escrow:create",
      description: "non-participant view test",
      amountMsats: 100_000_000,
      category: "p2p-trade",
      mintUrl: "fed11q...",
      platformFeeBps: 50,
      platformFeePubkey: PLATFORM_PK,
      arbiterFeeMsats: 1_000_000,
      expirySeconds: 86400,
      createdAt: NOW,
    });
    const wireOnly = makeParsedEvent(EscrowEventKind.LOCK, sellerPub, {
      type: "escrow:lock" as const,
      notesHash: "h",
      shares: [
        { shareIndex: 0, encryptedFor: { [buyerPub]: "x", [sellerPub]: "x", [arbiterPub]: "x" } },
        { shareIndex: 1, encryptedFor: { [buyerPub]: "x", [sellerPub]: "x", [arbiterPub]: "x" } },
        { shareIndex: 2, encryptedFor: { [buyerPub]: "x", [sellerPub]: "x", [arbiterPub]: "x" } },
      ],
      sellerReceivesMsats: 99_000_000,
      arbiterFeeMsats: 1_000_000,
      buyerPubkey: buyerPub,
      arbiterPubkey: arbiterPub,
      handleEnvelope: envelope,
      lockedAt: NOW,
    }, create2.raw.id);

    const r1 = applyEvent(null, create2);
    if (r1.ok) {
      const r2 = applyEvent(r1.state, wireOnly);
      if (r2.ok) {
        assert(r2.state.lock.handle === null,
          "Wire-only LOCK without resolution leaves state.lock.handle null (handleLock has no top-level fields to read)");
      }
    }
  }
}

// ── 25. BACKWARDS COMPAT — PR 3 top-level handle still works ────────────
console.log("\n── BACKWARDS COMPAT (PR 3 top-level handle on replay) ──");
{
  // A LOCK from a v0.1.78 deployment has handle/handleId/rail at the
  // top of the payload (no envelope). PR 4 must still apply these
  // correctly so existing trades on relays don't break.
  eventCounter = 800;

  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;

  const legacyLock = makeParsedEvent(EscrowEventKind.LOCK, SELLER_PK, {
    type: "escrow:lock" as const,
    notesHash: "hash_legacy_pr3",
    shares: [
      { shareIndex: 0, encryptedFor: { [BUYER_PK]: "x", [SELLER_PK]: "x", [ARBITER_PK]: "x" } },
      { shareIndex: 1, encryptedFor: { [BUYER_PK]: "x", [SELLER_PK]: "x", [ARBITER_PK]: "x" } },
      { shareIndex: 2, encryptedFor: { [BUYER_PK]: "x", [SELLER_PK]: "x", [ARBITER_PK]: "x" } },
    ],
    sellerReceivesMsats: 99_000_000,
    arbiterFeeMsats: 1_000_000,
    buyerPubkey: BUYER_PK,
    arbiterPubkey: ARBITER_PK,
    // PR 3 wire format: top-level fields, no envelope
    handleId: "h_legacy_pr3_xyz",
    handle: "@alice-legacy",
    rail: "revtag",
    lockedAt: NOW,
  }, create.raw.id);

  const r = applyEvent(state, legacyLock);
  if (assertOk(r, "Legacy PR 3 LOCK (top-level handle, no envelope) applies")) {
    assert(r.state.status === EscrowStatus.LOCKED, "Status LOCKED on legacy LOCK");
    assert(r.state.lock.handle?.value === "@alice-legacy",
      "Legacy top-level handle stored on state.lock.handle.value");
    assert(r.state.lock.handle?.id === "h_legacy_pr3_xyz",
      "Legacy handleId preserved");
    assert(r.state.lock.handle?.rail === "revtag",
      "Legacy rail preserved");
  }
}

// ── 26. PROD ENCRYPTION END-TO-END — flip config, run cycle ──────────────
console.log("\n── PROD ENCRYPTION CYCLE (config flip) ──");
{
  // Capture original config, flip to PROD-ish state, run a full
  // CREATE → JOIN → LOCK → VOTE → VOTE → RESOLVE → CLAIM → COMPLETE
  // cycle with a real-crypto handle envelope, verify all 3 participants
  // see the revealed handle, then restore the original config.
  //
  // The flip is the critical part of this test: it asserts that PR 4's
  // envelope path is independent of ENCRYPTION_CONFIG.encryptLock —
  // the flag's old "single-recipient outer wrap" behavior is gone, and
  // the envelope path always works. If a future PR re-introduces a
  // flag-conditional outer wrap, this test should catch it.

  const origEnabled    = ENCRYPTION_CONFIG.enabled;
  const origEncryptLock = ENCRYPTION_CONFIG.encryptLock;
  ENCRYPTION_CONFIG.enabled = true;
  ENCRYPTION_CONFIG.encryptLock = true;

  try {
    const sellerPriv  = generateSecretKey();
    const buyerPriv   = generateSecretKey();
    const arbiterPriv = generateSecretKey();
    const sellerPub   = getPublicKey(sellerPriv);
    const buyerPub    = getPublicKey(buyerPriv);
    const arbiterPub  = getPublicKey(arbiterPriv);

    const sellerCrypto  = makeNip44(sellerPriv);
    const buyerCrypto   = makeNip44(buyerPriv);
    const arbiterCrypto = makeNip44(arbiterPriv);

    eventCounter = 900;

    // 1. CREATE
    const create = makeParsedEvent(EscrowEventKind.CREATE, sellerPub, {
      type: "escrow:create",
      description: "PROD cycle test",
      amountMsats: 100_000_000,
      fiatAmount: 50,
      fiatCurrency: "USD",
      category: "p2p-trade",
      mintUrl: "fed11q...",
      platformFeeBps: 50,
      platformFeePubkey: PLATFORM_PK,
      arbiterFeeMsats: 1_000_000,
      expirySeconds: 86400,
      createdAt: NOW,
    });
    const r1 = applyEvent(null, create);
    assertOk(r1, "[PROD] CREATE → CREATED");
    let state = (r1 as any).state;

    // 2 + 3. JOINs (ACK only) — buyer first, then arbiter
    const j1 = makeParsedEvent(EscrowEventKind.JOIN, buyerPub, {
      type: "escrow:join",
      role: Role.BUYER,
      joinedAt: NOW,
    }, create.raw.id);
    const r2 = applyEvent(state, j1);
    assertOk(r2, "[PROD] Buyer JOIN ACK");
    state = (r2 as any).state;

    const j2 = makeParsedEvent(EscrowEventKind.JOIN, arbiterPub, {
      type: "escrow:join",
      role: Role.ARBITER,
      joinedAt: NOW,
    }, j1.raw.id);
    const r3 = applyEvent(state, j2);
    assertOk(r3, "[PROD] Arbiter JOIN ACK");
    state = (r3 as any).state;
    assert(state.status === EscrowStatus.CREATED,
      "[PROD] After JOINs status is still CREATED (atomic-funding model)");

    // 4. LOCK with real envelope (encrypts handle JSON to all 3 via NIP-44)
    const handleData = {
      handleId: "h_prod_cycle",
      handle: "+221 77 999 0000",
      rail: "wave",
    };
    const envelope = await createEnvelope(
      JSON.stringify(handleData),
      [buyerPub, sellerPub, arbiterPub],
      sellerCrypto.encrypt,
    );
    const wireLock = makeParsedEvent(EscrowEventKind.LOCK, sellerPub, {
      type: "escrow:lock" as const,
      notesHash: "hash_of_ecash_prod",
      shares: [
        { shareIndex: 0, encryptedFor: { [buyerPub]: "x", [sellerPub]: "x", [arbiterPub]: "x" } },
        { shareIndex: 1, encryptedFor: { [buyerPub]: "x", [sellerPub]: "x", [arbiterPub]: "x" } },
        { shareIndex: 2, encryptedFor: { [buyerPub]: "x", [sellerPub]: "x", [arbiterPub]: "x" } },
      ],
      sellerReceivesMsats: 99_000_000,
      arbiterFeeMsats: 1_000_000,
      buyerPubkey: buyerPub,
      arbiterPubkey: arbiterPub,
      handleEnvelope: envelope,
      lockedAt: NOW,
    }, j2.raw.id);

    // Each participant simulates resolveLockEnvelope on their side.
    async function viewerState(
      viewerPub: string,
      viewerCrypto: { decrypt: (ct: string, sender: string) => Promise<string> },
    ): Promise<any> {
      const ct = await decryptFromEnvelope(envelope, viewerPub, sellerPub, viewerCrypto.decrypt);
      const resolved = ct ? JSON.parse(ct) : {};
      const synth = {
        ...wireLock,
        payload: {
          ...wireLock.payload,
          handleId: resolved.handleId,
          handle: resolved.handle,
          rail: resolved.rail,
        },
      };
      // Each viewer replays from CREATE → JOIN×2 → LOCK; we can reuse
      // the shared `state` (post-JOINs) and apply their synthesized LOCK.
      const r = applyEvent(state, synth);
      if (!r.ok) throw new Error("Viewer LOCK apply failed: " + r.error.message);
      return r.state;
    }

    const buyerState   = await viewerState(buyerPub,   buyerCrypto);
    const sellerState  = await viewerState(sellerPub,  sellerCrypto);
    const arbiterState = await viewerState(arbiterPub, arbiterCrypto);

    // All three see the cleartext handle on their state.lock.handle
    assert(buyerState.lock.handle?.value === handleData.handle,
      "[PROD] Buyer sees revealed handle cleartext");
    assert(sellerState.lock.handle?.value === handleData.handle,
      "[PROD] Seller sees revealed handle cleartext");
    assert(arbiterState.lock.handle?.value === handleData.handle,
      "[PROD] Arbiter sees revealed handle cleartext");
    assert(buyerState.lock.handle?.value === arbiterState.lock.handle?.value,
      "[PROD] Buyer and arbiter agree on handle (3-recipient envelope works)");

    // 5 + 6. VOTEs (use buyerState as the converged chain head — all
    // viewers' states are identical at this point besides the synthesized
    // wire ID, which doesn't affect downstream).
    state = buyerState;
    const v1 = makeParsedEvent(EscrowEventKind.VOTE, buyerPub, {
      type: "escrow:vote",
      outcome: Outcome.RELEASE,
      role: Role.BUYER,
      votedAt: NOW,
    }, wireLock.raw.id);
    const r4 = applyEvent(state, v1);
    assertOk(r4, "[PROD] Buyer votes RELEASE");
    state = (r4 as any).state;

    const v2 = makeParsedEvent(EscrowEventKind.VOTE, sellerPub, {
      type: "escrow:vote",
      outcome: Outcome.RELEASE,
      role: Role.SELLER,
      votedAt: NOW,
    }, v1.raw.id);
    const r5 = applyEvent(state, v2);
    assertOk(r5, "[PROD] Seller votes RELEASE");
    state = (r5 as any).state;

    // 7. RESOLVE
    const resolve = makeParsedEvent(EscrowEventKind.RESOLVE, buyerPub, {
      type: "escrow:resolve",
      outcome: Outcome.RELEASE,
      majority: [Role.BUYER, Role.SELLER],
      arbiterInvolved: false,
      resolvedAt: NOW,
    }, v2.raw.id);
    const r6 = applyEvent(state, resolve);
    assertOk(r6, "[PROD] RESOLVE → APPROVED");
    state = (r6 as any).state;

    // 8. CLAIM (buyer wins on RELEASE in p2p)
    const claim = makeParsedEvent(EscrowEventKind.CLAIM, buyerPub, {
      type: "escrow:claim",
      claimerRole: Role.BUYER,
      notesHashVerification: "hash_of_ecash_prod",
      claimedAt: NOW,
    }, resolve.raw.id);
    const r7 = applyEvent(state, claim);
    assertOk(r7, "[PROD] Buyer CLAIM → CLAIMED");
    state = (r7 as any).state;

    // 9. COMPLETE
    const complete = makeParsedEvent(EscrowEventKind.COMPLETE, buyerPub, {
      type: "escrow:complete",
      completedAt: NOW,
    }, claim.raw.id);
    const r8 = applyEvent(state, complete);
    assertOk(r8, "[PROD] COMPLETE → terminal");
    state = (r8 as any).state;
    assert(state.status === EscrowStatus.COMPLETED,
      "[PROD] Final state COMPLETED");
    assert(state.lock.handle?.value === handleData.handle,
      "[PROD] Handle preserved through full cycle to terminal");
  } finally {
    // Restore original config so other tests aren't poisoned
    ENCRYPTION_CONFIG.enabled = origEnabled;
    ENCRYPTION_CONFIG.encryptLock = origEncryptLock;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// PR — UI shell decisions (v0.1.85 hotfix: picker gate + community-tap)
// ══════════════════════════════════════════════════════════════════════════
//
// These exercise the pure decision functions that drive the App.tsx
// shell's two recently-broken behaviors:
//   - Federation picker should not appear for returning users
//   - Community-pill taps should change federation membership, not just
//     filter Browse
//
// Importing src/ui from the harness is fine because decisions.ts is
// pure (no React, no DOM) — it's domain logic that happens to sit in
// the UI directory.

import {
  decideCommunityTapEffect,
  decideAutoInitTarget,
  shouldShowBrowserSupportBanner,
  displayCounterpartyName,
} from "../ui/decisions.js";
// BP_FEDERATION_INVITE / BLF_FEDERATION_INVITE already imported above
// from federation-config (which re-exports from federation-invites).

// (NOTE: shouldShowFirstTimePicker was retired in v0.1.85 — the on-shell
// picker is gone; community pills are the primary first-time join
// surface and Sandbox mode hosts the power-user picker.)

// ── 28. COMMUNITY-PILL TAP EFFECT ───────────────────────────────────────
console.log("\n── COMMUNITY-PILL TAP EFFECT ──");
{
  // v0.1.87: the "All communities" pill (and its filter-only effect)
  // are gone — every user has a home, so every tap is an identity
  // choice. The decision function returns one of three kinds:
  // identity-only / switch-silent / destroy-confirm.

  // First-time user (no current invite) tapping a community → switch-silent.
  // v0.1.85 update: the community pill IS the first-time join, no separate
  // picker step. The handler dispatches initFedimint (vs switchFederation)
  // based on whether a fed is already loaded.
  const firstTime = decideCommunityTapEffect({
    slug: "sn-cfa", currentInvite: null, balanceMsats: 0,
  });
  assert(firstTime.kind === "switch-silent",
    "First-time user tap → switch-silent (one-tap join, no picker step)");
  if (firstTime.kind === "switch-silent") {
    assert(firstTime.targetInvite === BP_FEDERATION_INVITE,
      "First-time tap on sn-cfa targets BP (its pinned invite)");
    assert(firstTime.displayName === "Senegal · CFA",
      "First-time tap carries the community displayName");
  }

  // Returning user already on the community's federation → identity-only.
  const sameFed = decideCommunityTapEffect({
    slug: "sn-cfa", currentInvite: BP_FEDERATION_INVITE, balanceMsats: 0,
  });
  assert(sameFed.kind === "identity-only",
    "Tap a community whose pinned invite matches current → identity-only");

  // Returning user on a different fed, balance == 0 → silent switch.
  const switchSilent = decideCommunityTapEffect({
    slug: "us-blf", currentInvite: BP_FEDERATION_INVITE, balanceMsats: 0,
  });
  assert(switchSilent.kind === "switch-silent",
    "Tap different-fed community with balance=0 → switch-silent");
  if (switchSilent.kind === "switch-silent") {
    assert(switchSilent.targetInvite === BLF_FEDERATION_INVITE,
      "Switch-silent targets the community's pinned invite (us-blf → BLF)");
    assert(switchSilent.displayName === "US · Bitcoin Life · USD",
      "Switch-silent carries the community's displayName");
  }

  // Returning user on a different fed, balance > 0 → destroy-confirm modal.
  const destroyConfirm = decideCommunityTapEffect({
    slug: "us-blf", currentInvite: BP_FEDERATION_INVITE, balanceMsats: 50_000,
  });
  assert(destroyConfirm.kind === "destroy-confirm",
    "Tap different-fed community with balance>0 → destroy-confirm");
  if (destroyConfirm.kind === "destroy-confirm") {
    assert(destroyConfirm.targetInvite === BLF_FEDERATION_INVITE,
      "Destroy-confirm targets the community's pinned invite");
    assert(destroyConfirm.balanceMsats === 50_000,
      "Destroy-confirm carries the live balance for the modal copy");
    assert(destroyConfirm.currentInvite === BP_FEDERATION_INVITE,
      "Destroy-confirm carries the active invite for cancel-revert");
  }

  // Custom-invite override is bypassed — community-tap honors the
  // community's pinned invite even if a custom override is set elsewhere.
  // (We pass currentInvite as an arbitrary custom string and verify the
  // target is still the community's pin, not the custom override.)
  const customOverride = decideCommunityTapEffect({
    slug: "ke-kes",
    currentInvite: "fed1qcustom_invite_user_pasted_in_sandbox",
    balanceMsats: 0,
  });
  assert(customOverride.kind === "switch-silent",
    "Custom-invite override doesn't pin the user — tapping a community switches");
  if (customOverride.kind === "switch-silent") {
    const keKesInvite = getCommunityBySlug("ke-kes")!.federationInvite!;
    assert(customOverride.targetInvite === keKesInvite,
      "Community-tap target is the community's pin, not the custom override");
  }

  // Unknown slug → falls through to BP fallback. Edge case: a wire-stale
  // slug somehow surfacing in the UI. We still treat it as a valid
  // identity choice (better than a no-op silent failure).
  const unknownSlug = decideCommunityTapEffect({
    slug: "xx-unknown", currentInvite: BLF_FEDERATION_INVITE, balanceMsats: 0,
  });
  assert(unknownSlug.kind === "switch-silent",
    "Unknown slug → switch-silent against BP fallback");
  if (unknownSlug.kind === "switch-silent") {
    assert(unknownSlug.targetInvite === BP_FEDERATION_INVITE,
      "Unknown slug targets BP (universal fallback)");
    assert(unknownSlug.displayName === "xx-unknown",
      "Unknown slug uses the slug itself as displayName");
  }
}

// ── 28b. AUTO-INIT TARGET (sticky-community routing, v0.1.87) ──────────
//
// decideAutoInitTarget drives the App.tsx auto-init useEffect. Per
// PHILOSOPHY.md §2.1 "every user has a home" doctrine, refresh always
// lands the user on their home community's federation — except when
// an in-flight trade with funds at risk requires preserving the
// OPFS-bound fed so the trade can resume.
//
// Decision tree:
//   1. hasCurrentEscrow && balanceMsats > 0 && activeInvite → use-active
//   2. else with homeCommunity set → use-home
//   3. else → skip
console.log("\n── AUTO-INIT TARGET ──");
{
  // 1) In-flight trade with funds at stake → preserve active fed.
  const inFlight = decideAutoInitTarget({
    activeInvite: BLF_FEDERATION_INVITE,
    homeCommunity: "sn-cfa",
    hasCurrentEscrow: true,
    balanceMsats: 50_000,
  });
  assert(inFlight.kind === "use-active",
    "currentEscrow + balance>0 → use-active (preserves in-flight fed)");
  if (inFlight.kind === "use-active") {
    assert(inFlight.invite === BLF_FEDERATION_INVITE,
      "use-active carries the OPFS-bound active invite");
  }

  // 2) currentEscrow recorded but balance is zero → trade post-claimed
  //    or recovered out-of-band. Strands the user if we preserve. Use-home.
  const claimedOrRecovered = decideAutoInitTarget({
    activeInvite: BLF_FEDERATION_INVITE,
    homeCommunity: "sn-cfa",
    hasCurrentEscrow: true,
    balanceMsats: 0,
  });
  assert(claimedOrRecovered.kind === "use-home",
    "currentEscrow + balance==0 → use-home (no funds to preserve)");
  if (claimedOrRecovered.kind === "use-home") {
    assert(claimedOrRecovered.slug === "sn-cfa",
      "use-home carries the home community slug");
    assert(claimedOrRecovered.invite === BP_FEDERATION_INVITE,
      "use-home invite is the home community's pinned invite (sn-cfa → BP)");
  }

  // 3) Returning user, no active trade → sticky-community.
  const steady = decideAutoInitTarget({
    activeInvite: BLF_FEDERATION_INVITE,
    homeCommunity: "ke-kes",
    hasCurrentEscrow: false,
    balanceMsats: 0,
  });
  assert(steady.kind === "use-home",
    "No active trade + home set → use-home (sticky-community)");
  if (steady.kind === "use-home") {
    const keKesInvite = getCommunityBySlug("ke-kes")!.federationInvite!;
    assert(steady.invite === keKesInvite,
      "Sticky-community lands on home's pinned invite even if active differs");
  }

  // 4) Returning user already on home's fed → still use-home (idempotent).
  const alreadyHome = decideAutoInitTarget({
    activeInvite: BP_FEDERATION_INVITE,
    homeCommunity: "sn-cfa",
    hasCurrentEscrow: false,
    balanceMsats: 0,
  });
  assert(alreadyHome.kind === "use-home",
    "Already on home fed → still use-home (idempotent dispatch)");

  // 5) Orphan ecash without an active trade. v0.1.87 falls to use-home;
  //    the data-layer reconciliation guard catches the balance>0 conflict
  //    and surfaces the destroy-confirm modal. v0.2.0's recovery banner
  //    will intercept this state before sticky-community fires.
  const orphan = decideAutoInitTarget({
    activeInvite: BLF_FEDERATION_INVITE,
    homeCommunity: "sn-cfa",
    hasCurrentEscrow: false,
    balanceMsats: 50_000,
  });
  assert(orphan.kind === "use-home",
    "Balance>0 without currentEscrow → use-home (data-layer guard handles conflict)");

  // 6) Truly first-time user — no home, no anything → skip, let pills run.
  const firstTime = decideAutoInitTarget({
    activeInvite: null,
    homeCommunity: null,
    hasCurrentEscrow: false,
    balanceMsats: 0,
  });
  assert(firstTime.kind === "skip",
    "First-time user (no home, no active) → skip");

  // 7) Sandbox-style user — active invite without a community pick.
  //    Per the user's spec ("else with home → use-home; else skip"),
  //    no-home + active falls through to skip. Sandbox users reconnect
  //    manually or by tapping a community pill.
  const sandboxNoHome = decideAutoInitTarget({
    activeInvite: BLF_FEDERATION_INVITE,
    homeCommunity: null,
    hasCurrentEscrow: false,
    balanceMsats: 0,
  });
  assert(sandboxNoHome.kind === "skip",
    "Sandbox user with active invite but no home → skip (manual reconnect)");
}

// ── 29. BROWSER SUPPORT BANNER GATE ─────────────────────────────────────
//
// One-time-per-account honest disclosure for browser users. v0.1.85
// hotfix: gate dropped the fedimintJoined requirement so first-time
// users see the banner BEFORE committing to a federation — that's the
// right educational moment per Pillar 2.7.
console.log("\n── BROWSER SUPPORT BANNER GATE ──");
{
  // Browser, never dismissed → show (regardless of join state)
  assert(
    shouldShowBrowserSupportBanner({
      isBrowser: true, dismissed: false,
    }) === true,
    "Browser user (not yet dismissed) sees the banner",
  );

  // Native platform — no iroh issue, never show
  assert(
    shouldShowBrowserSupportBanner({
      isBrowser: false, dismissed: false,
    }) === false,
    "Native (APK) user does NOT see the banner — iroh transport works there",
  );

  // Dismissed earlier — never re-show
  assert(
    shouldShowBrowserSupportBanner({
      isBrowser: true, dismissed: true,
    }) === false,
    "Once dismissed, the banner stays dismissed across sessions",
  );
}

// ── 29b. COUNTERPARTY DISPLAY NAME (v0.1.87 / v0.2.0+v0.2.1 helper) ─────
//
// Used by the v0.2.0 recovery banner ("Your trade with [counterparty]
// didn't finish") and the arbiter-attention warnings ("Trade between
// [npub-A] and [npub-B]"). Pure function: returns the kind:0 name only
// when the user has opted in AND the counterparty has self-published
// a usable kind:0 name. v0.2.0 ships the helper with kind0Name=null
// across the board (no fetcher yet); v0.2.1 wires the fetcher.
console.log("\n── COUNTERPARTY DISPLAY NAME ──");
{
  const npubA = "1c6abd8a7f3e9b22d45c1f0a8e7b6c5d4f3e2a1b0c9d8e7f6a5b4c3d2e1f0987";

  // Default: truncated npub regardless of name presence when toggle off.
  const defaultDisplay = displayCounterpartyName({
    npub: npubA, fetchKind0Enabled: false, kind0Name: "Alice",
  });
  assert(defaultDisplay === "1c6abd8a…0987",
    "Toggle off → truncated npub even if a kind:0 name is supplied");

  // Toggle on but kind0Name is null (v0.2.0 default before fetcher ships).
  const noFetcherYet = displayCounterpartyName({
    npub: npubA, fetchKind0Enabled: true, kind0Name: null,
  });
  assert(noFetcherYet === "1c6abd8a…0987",
    "Toggle on but no kind:0 name → truncated npub fallback");

  // Both conditions met → render the name.
  const happyPath = displayCounterpartyName({
    npub: npubA, fetchKind0Enabled: true, kind0Name: "Alice from Dakar",
  });
  assert(happyPath === "Alice from Dakar",
    "Toggle on + kind:0 name present → render the name");

  // Empty/whitespace-only kind:0 name → fall back (don't render whitespace).
  const emptyName = displayCounterpartyName({
    npub: npubA, fetchKind0Enabled: true, kind0Name: "   ",
  });
  assert(emptyName === "1c6abd8a…0987",
    "Whitespace-only kind:0 name doesn't render — falls back to npub");

  // Name with surrounding whitespace gets trimmed (defensive against
  // sloppy kind:0 publishers).
  const trimsName = displayCounterpartyName({
    npub: npubA, fetchKind0Enabled: true, kind0Name: "  Bob  ",
  });
  assert(trimsName === "Bob", "kind:0 name is trimmed before render");

  // Short pubkey (shorter than the truncation window) — return as-is
  // so we don't produce a degenerate "ab…cd" of an 8-char string.
  const shortNpub = displayCounterpartyName({
    npub: "abcd1234", fetchKind0Enabled: false, kind0Name: null,
  });
  assert(shortNpub === "abcd1234",
    "Short npub passes through unchanged (no truncation degeneracy)");
}

// ── 29c. CREATE FED TAGS — probe-decoupled (v0.1.87 item 9) ─────────────
//
// Per Pillar 2.3 ("federation follows the listing"), every CREATE
// event must carry enough federation context for buyers to resolve
// regardless of seller-side probe outcome. deriveCreateFedTags is
// the pure derivation: probe-success contributes both fedPrefix and
// fed; probe-failure still surfaces fed via the cached client state;
// truly disconnected (no client) yields neither tag.
console.log("\n── CREATE FED TAGS (probe-decoupled) ──");
{
  // Probe success → both tags present.
  const probeOk = deriveCreateFedTags({
    cachedFedId: "abcdef0123456789",
    probeResult: { prefix: "fed1abcdef", fed: "abcdef0123456789" },
  });
  assert(probeOk.fedPrefix === "fed1abcdef",
    "Probe-success → fedPrefix populated");
  assert(probeOk.fed === "abcdef0123456789",
    "Probe-success → fed populated");

  // Probe FAILED but client knows its fed ID → fed survives, fedPrefix
  // omitted. This is the load-bearing fix for item 9: pre-v0.1.87 a
  // probe failure stripped fed too, cascading into buyer-side filtering.
  const probeFail = deriveCreateFedTags({
    cachedFedId: "abcdef0123456789",
    probeResult: null,
  });
  assert(probeFail.fed === "abcdef0123456789",
    "Probe-fail with cached fed ID → fed tag survives");
  assert(probeFail.fedPrefix === undefined,
    "Probe-fail → fedPrefix omitted (no ecash to derive prefix from)");

  // No client + no probe (truly disconnected) → neither tag.
  // Listing still gets community + mintUrl from upstream params, so
  // it's resolvable; this branch just means the probe-derived
  // safety nets are absent.
  const noClient = deriveCreateFedTags({
    cachedFedId: null,
    probeResult: null,
  });
  assert(noClient.fed === undefined,
    "No client, no probe → no fed tag");
  assert(noClient.fedPrefix === undefined,
    "No client, no probe → no fedPrefix tag");

  // Probe with null fed (edge case where the WASM probe returned a
  // prefix but couldn't capture the fed ID) — fallback to cachedFedId.
  const probePartial = deriveCreateFedTags({
    cachedFedId: "abcdef0123456789",
    probeResult: { prefix: "fed1abcdef", fed: null },
  });
  assert(probePartial.fedPrefix === "fed1abcdef",
    "Partial probe still surfaces fedPrefix");
  assert(probePartial.fed === "abcdef0123456789",
    "Partial probe falls back to cachedFedId for fed");
}

// ── 30. setUserCommunitySlug LOCALSTORAGE ROUNDTRIP ─────────────────────
//
// The community-tap handler in App.tsx calls actions.setCommunity(slug),
// which delegates to setUserCommunitySlug. Confirm the localStorage
// write side effect explicitly so that "tap → identity stored" is
// covered as a unit, not implied via section 14.
console.log("\n── setUserCommunitySlug PERSISTENCE ──");
{
  (globalThis as any).localStorage.clear();
  setUserCommunitySlug("ke-kes");
  const raw = (globalThis as any).localStorage.getItem(COMMUNITY_STORAGE_KEY);
  assert(raw === "ke-kes",
    "setUserCommunitySlug writes the slug to chama_community key");
  setUserCommunitySlug("sn-cfa");
  const raw2 = (globalThis as any).localStorage.getItem(COMMUNITY_STORAGE_KEY);
  assert(raw2 === "sn-cfa",
    "Subsequent setUserCommunitySlug overwrites the prior value");
}

// ── 31. getUserCommunitySlugRaw — null for first-timers ─────────────────
//
// Bug A from v0.1.85 smoke testing: first-time users were seeing the
// "Global · USD" pill highlighted because `getUserCommunitySlug` falls
// back to global-usd when nothing is stored. The Raw variant returns
// null in that case so the UI can distinguish "explicit choice" from
// "default fallback" — pill highlight reads from Raw, resolution paths
// (createEscrow, initFedimint) keep using the non-null helper.
console.log("\n── getUserCommunitySlugRaw ──");
{
  // First-timer: nothing stored → null
  (globalThis as any).localStorage.clear();
  assert(getUserCommunitySlugRaw() === null,
    "First-time user (nothing stored) → null (no pill highlight)");
  assert(getUserCommunitySlug() === "global-usd",
    "Resolution path still falls back to global-usd default");

  // After picking: returns the slug
  setUserCommunitySlug("sn-cfa");
  assert(getUserCommunitySlugRaw() === "sn-cfa",
    "After pick: raw returns the explicit slug");
  assert(getUserCommunitySlug() === "sn-cfa",
    "Resolution path matches");

  // Stale/invalid stored slug: raw returns null (consistent with the
  // non-Raw helper's fallback) so the picker doesn't highlight a
  // nonexistent community.
  (globalThis as any).localStorage.setItem(COMMUNITY_STORAGE_KEY, "ghost-fed");
  assert(getUserCommunitySlugRaw() === null,
    "Unknown stored slug → null (no stale-pill highlight)");
  assert(getUserCommunitySlug() === "global-usd",
    "Resolution path falls back to default for stale slug");

  // Cleanup
  (globalThis as any).localStorage.clear();
}

// ── 31b. SEED RECOVERY RETRY (v0.1.85 Bug G fix) ────────────────────────
//
// queryUntilFound is the retry helper getOrCreateSeed wraps around the
// recovery-query call. When the initial query (outside the helper)
// returns zero events AND a seed-published marker exists locally
// (we KNOW a seed should be there), the caller invokes the helper to
// retry with backoff before triggering the v0.1.74 refuse-fresh
// safety guard.
//
// Semantics: delays[i] is the sleep duration BEFORE attempt i.
// delays.length = total attempts. With [1000,2000,4000] the helper
// sleeps 1s before attempt 1, then runs query → if empty, sleeps 2s
// before attempt 2 → if empty, sleeps 4s before attempt 3. Tests use
// a mock sleepFn so the suite runs without real timers.
console.log("\n── SEED RECOVERY RETRY ──");
{
  // First-attempt success — one sleep (1s before attempt), one query.
  {
    const sleepCalls: number[] = [];
    let queryCalls = 0;
    const result = await queryUntilFound(
      async () => {
        queryCalls++;
        return ["event1"];
      },
      [1000, 2000, 4000],
      async (ms) => { sleepCalls.push(ms); },
    );
    assert(result.length === 1 && result[0] === "event1",
      "Returns the first non-empty result");
    assert(queryCalls === 1, "Stops after first success");
    assert(sleepCalls.length === 1 && sleepCalls[0] === 1000,
      "Sleeps 1s before the first retry attempt");
  }

  // Second-attempt success — two sleeps (1s, 2s), two queries.
  {
    const sleepCalls: number[] = [];
    let queryCalls = 0;
    const result = await queryUntilFound(
      async () => {
        queryCalls++;
        return queryCalls < 2 ? [] : ["event-on-retry"];
      },
      [1000, 2000, 4000],
      async (ms) => { sleepCalls.push(ms); },
    );
    assert(result.length === 1 && result[0] === "event-on-retry",
      "Returns events found on second retry attempt");
    assert(queryCalls === 2, "Stops after first non-empty result");
    assert(sleepCalls.length === 2
      && sleepCalls[0] === 1000
      && sleepCalls[1] === 2000,
      "Backoff sequence so far: 1s, 2s");
  }

  // Third-attempt success — three sleeps (1s, 2s, 4s), three queries.
  {
    const sleepCalls: number[] = [];
    let queryCalls = 0;
    const result = await queryUntilFound(
      async () => {
        queryCalls++;
        return queryCalls < 3 ? [] : ["seed-late"];
      },
      [1000, 2000, 4000],
      async (ms) => { sleepCalls.push(ms); },
    );
    assert(result.length === 1, "Recovers on third retry attempt");
    assert(queryCalls === 3, "Three queries before success");
    assert(sleepCalls.length === 3
      && sleepCalls[0] === 1000
      && sleepCalls[1] === 2000
      && sleepCalls[2] === 4000,
      "Full backoff sequence: 1s, 2s, 4s");
  }

  // All attempts empty — exhausts retries, returns []. This is the
  // signal that triggers the v0.1.74 refuse-fresh safety guard in
  // getOrCreateSeed (when a marker exists).
  {
    let queryCalls = 0;
    const result = await queryUntilFound(
      async () => {
        queryCalls++;
        return [];
      },
      [1000, 2000, 4000],
      async () => { /* swallow sleeps */ },
    );
    assert(result.length === 0,
      "Returns empty after exhausting all retries");
    assert(queryCalls === 3,
      "Total 3 query attempts (matches delays.length)");
  }

  // Default retry schedule shape (the constant exported alongside).
  assert(SEED_RECOVERY_RETRY_DELAYS_MS.length === 3,
    "Default retry schedule has 3 attempts");
  assert(SEED_RECOVERY_RETRY_DELAYS_MS[0] === 1000
    && SEED_RECOVERY_RETRY_DELAYS_MS[1] === 2000
    && SEED_RECOVERY_RETRY_DELAYS_MS[2] === 4000,
    "Default retry schedule is 1s / 2s / 4s");
}

// ── 32. CreateForm derives mintUrl from community (no manual fed input) ─
//
// v0.1.85 cleanup: the federation invite input field was removed from
// CreateForm. Listings now derive mintUrl from the user's current
// community via resolveFederationForCommunity. This test pins the
// behavior so a future regression that re-adds a manual fed picker
// gets caught.
console.log("\n── CreateForm-derived mintUrl ──");
{
  (globalThis as any).localStorage.clear();
  // sn-cfa pins BP — listings in sn-cfa go to BP.
  assert(resolveFederationForCommunity("sn-cfa") === BP_FEDERATION_INVITE,
    "sn-cfa listing → BP invite (community-derived mintUrl)");
  // us-blf pins BLF — listings in us-blf go to BLF.
  assert(resolveFederationForCommunity("us-blf") === BLF_FEDERATION_INVITE,
    "us-blf listing → BLF invite");
  // Unknown community → BP fallback.
  assert(resolveFederationForCommunity("xx-unknown") === BP_FEDERATION_INVITE,
    "Unknown community → BP fallback (no listing stranded)");
}

// ══════════════════════════════════════════════════════════════════════════
// RESULTS
// ══════════════════════════════════════════════════════════════════════════

console.log(`\n${"═".repeat(60)}`);
console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${"═".repeat(60)}\n`);

if (failed > 0) {
  process.exit(1);
}
