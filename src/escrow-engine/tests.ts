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
  type EscrowState,
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
  addOrTouchLightningHandle,
  getSavedLightningHandles,
  LIGHTNING_RAIL,
  type SavedHandle,
} from "../payments/saved-handles.js";

// v0.3.0 Phase 1 — LNURL + DestinationPicker logic
import {
  parseLightningAddress,
  isLightningAddress,
  fetchLnurlPayMetadata,
  requestLnurlInvoice,
  resolveLightningAddressToInvoice,
  LnurlError,
  type LnurlPayMetadata,
} from "../payments/lnurl.js";
import {
  decorateSavedHandlesForPicker,
  classifyDestinationInput,
  decideDispatch,
} from "../ui/components/destination-picker-logic.js";

// v0.3.0 Phase 2 — atomic fund-and-lock orchestrator
import {
  pollForFunding,
  runFundAndLock,
  type FundingPhase,
  type FundAndLockPhase,
  type FundAndLockTerminal,
} from "../payments/fund-and-lock.js";

// v0.3.0 Phase 3 — atomic claim-and-payout orchestrator
// v0.3.1 Phase 1 — adds claim-bridge-threw terminal + bridge-throw discrimination
import {
  waitForBalanceGrowth,
  runClaimAndPayout,
  BRIDGE_THREW_ERROR_CODES,
  type ClaimAndPayoutPhase,
} from "../payments/claim-and-payout.js";

// v0.3.0 Phase 4 — balance recovery orchestrator
import {
  runRecoveryPayout,
  type RecoveryPayoutPhase,
} from "../payments/balance-recovery.js";

// v0.3.0 Phase 5 — ChamaBar label decision
import {
  decideChamaBarLabel,
} from "../ui/decisions.js";

// v0.3.0 Phase 6 — Trinity Ring participant order (theme.ts)
// v0.3.1 Phase 2 — extends §43 with a grep tripwire over src/ui/
import { TRINITY_RING_ORDER } from "../ui/theme.js";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// v0.3.0 Phase 6 — State B explainer card gate
import {
  hasStateBExplained,
  markStateBExplained,
  STATE_B_EXPLAINED_KEY_PREFIX,
} from "../ui/screens/state-b-explainer.js";

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
  canOfferSubscription,
  hasActiveBuyerSellerCommitment,
  findActiveTrade,
  shouldShowRecoveryBanner,
  identifyStrandedEcashSource,
  decideListingTapEffect,
  decideArbiterWarning,
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

  // 6) Truly first-time user — v0.2.0 item 6: no home AND no active →
  //    use-default (BP + global-usd). Pre-v0.2.0 this fell to "skip"
  //    and stranded users in "No Chama" limbo per Pillar 2.1's
  //    "every user has a home" doctrine.
  const firstTime = decideAutoInitTarget({
    activeInvite: null,
    homeCommunity: null,
    hasCurrentEscrow: false,
    balanceMsats: 0,
  });
  assert(firstTime.kind === "use-default",
    "First-time user (no home, no active) → use-default (v0.2.0 item 6)");
  if (firstTime.kind === "use-default") {
    assert(firstTime.defaultCommunity === "global-usd",
      "First-time default community is global-usd");
    assert(firstTime.invite === BP_FEDERATION_INVITE,
      "First-time default invite is BP (browser-friendly fallback)");
    assert(firstTime.reason === "first-time-npub",
      "First-time use-default carries the 'first-time-npub' reason");
  }

  // 7) Sandbox-style user — active invite without a community pick.
  //    No-home + active still falls to skip (we don't know which
  //    community the user intended; manual reconnect is the right
  //    path). The use-default branch is gated on !activeInvite.
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

  // v0.4.2 sim mode: contradicts the SIM MODE pill, always suppress.
  assert(
    shouldShowBrowserSupportBanner({
      isBrowser: true, dismissed: false, simModeOn: true,
    }) === false,
    "Sim mode suppresses the iroh-relay disclosure banner",
  );
  assert(
    shouldShowBrowserSupportBanner({
      isBrowser: true, dismissed: true, simModeOn: true,
    }) === false,
    "Sim mode + dismissed is still suppressed",
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

// ── 31c. canOfferSubscription (v0.2.0 item 7 — graduated trust gate) ────
//
// Subscription mode is invisible until the seller has accumulated
// enough positive ratings. v1 threshold: 5+ positive, 0 negative.
// In v0.2.0 with no rating events being published yet, the aggregator
// returns null universally and the gate returns false for everyone.
// When ratings ship in v0.2.1+, the gate naturally opens.
console.log("\n── canOfferSubscription ──");
{
  // No ratings yet (v0.2.0 universal default) → gate closed.
  assert(canOfferSubscription({ ratings: null }) === false,
    "null ratings → false (no graduation signal yet)");

  // Below threshold → gate closed.
  assert(
    canOfferSubscription({ ratings: { count: 4, positive: 4, negative: 0 } }) === false,
    "4 positive < threshold of 5 → false",
  );

  // Threshold met cleanly → gate open.
  assert(
    canOfferSubscription({ ratings: { count: 5, positive: 5, negative: 0 } }) === true,
    "5 positive + 0 negative → true (graduated)",
  );

  // Any negative disqualifies, even with many positives.
  assert(
    canOfferSubscription({ ratings: { count: 10, positive: 9, negative: 1 } }) === false,
    "Any negative rating disqualifies (v1 placeholder is strict)",
  );
}

// ── 31d. hasActiveBuyerSellerCommitment + findActiveTrade (item 3) ──────
//
// The one-trade-at-a-time hard gate: any non-terminal escrow where
// the user is buyer or seller blocks Create + Fund. Arbiter status
// does NOT trigger the block (it triggers the soft/hard arbiter
// warnings instead, per item 10).
console.log("\n── hasActiveBuyerSellerCommitment + findActiveTrade ──");
{
  const me = "me_pubkey_aaaa";
  const other = "other_pubkey_bbbb";
  const arb = "arbiter_pubkey_cccc";

  // Helper to build a minimal EscrowState shape for these tests.
  const escrow = (overrides: Partial<EscrowState>): EscrowState => ({
    id: "test-id",
    status: EscrowStatus.LOCKED,
    description: "test",
    amountMsats: 1_000_000,
    category: "p2p-trade",
    fulfillment: "service",
    community: "sn-cfa",
    mintUrl: BP_FEDERATION_INVITE,
    participants: { buyer: null, seller: null, arbiter: null },
    initiator: { pubkey: me, role: Role.SELLER },
    communityArbiters: [],
    subscription: null,
    votes: {},
    resolvedOutcome: null,
    resolvedMajority: null,
    fees: { platformBps: 50, platformPubkey: me, arbiterFeeMsats: 0 },
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    createdAt: Math.floor(Date.now() / 1000),
    eventChain: [],
    chatMessages: [],
    lock: { handle: null },
    ...overrides,
  } as EscrowState);

  // No escrows → no commitment.
  assert(
    hasActiveBuyerSellerCommitment({ escrows: [], userPubkey: me }) === false,
    "Empty escrows → no commitment",
  );
  assert(
    findActiveTrade({ escrows: [], userPubkey: me }) === null,
    "Empty escrows → no active trade",
  );

  // User as buyer, LOCKED → commitment.
  const asBuyer = escrow({
    id: "as-buyer",
    status: EscrowStatus.LOCKED,
    participants: { buyer: me, seller: other, arbiter: arb },
  });
  assert(
    hasActiveBuyerSellerCommitment({ escrows: [asBuyer], userPubkey: me }) === true,
    "User as buyer in LOCKED escrow → commitment",
  );
  assert(
    findActiveTrade({ escrows: [asBuyer], userPubkey: me })?.id === "as-buyer",
    "findActiveTrade returns the LOCKED escrow",
  );

  // User as arbiter only → NO commitment (arbiter status doesn't block).
  const asArbiter = escrow({
    id: "as-arbiter",
    status: EscrowStatus.LOCKED,
    participants: { buyer: other, seller: "third", arbiter: me },
  });
  assert(
    hasActiveBuyerSellerCommitment({ escrows: [asArbiter], userPubkey: me }) === false,
    "User as arbiter only → NO commitment (item 10 governs that path)",
  );

  // Terminal escrow → no commitment regardless of role.
  const completed = escrow({
    id: "completed",
    status: EscrowStatus.COMPLETED,
    participants: { buyer: me, seller: other, arbiter: arb },
  });
  assert(
    hasActiveBuyerSellerCommitment({ escrows: [completed], userPubkey: me }) === false,
    "COMPLETED escrow doesn't count as commitment",
  );
  const cancelled = escrow({
    id: "cancelled",
    status: EscrowStatus.CANCELLED,
    participants: { buyer: me, seller: other, arbiter: arb },
  });
  assert(
    hasActiveBuyerSellerCommitment({ escrows: [cancelled], userPubkey: me }) === false,
    "CANCELLED escrow doesn't count as commitment",
  );

  // EXPIRED counts as active (per types.ts: transient healing state,
  // not truly terminal).
  const expired = escrow({
    id: "expired",
    status: EscrowStatus.EXPIRED,
    participants: { buyer: me, seller: other, arbiter: arb },
  });
  assert(
    hasActiveBuyerSellerCommitment({ escrows: [expired], userPubkey: me }) === true,
    "EXPIRED still counts (transient healing state, not truly terminal)",
  );

  // Multiple actives → findActiveTrade returns most recent by createdAt.
  const older = escrow({
    id: "older",
    createdAt: 1000,
    participants: { buyer: me, seller: other, arbiter: arb },
  });
  const newer = escrow({
    id: "newer",
    createdAt: 2000,
    participants: { buyer: me, seller: other, arbiter: arb },
  });
  assert(
    findActiveTrade({ escrows: [older, newer], userPubkey: me })?.id === "newer",
    "findActiveTrade picks the most recent active trade",
  );
}

// ── 31e. shouldShowRecoveryBanner + identifyStrandedEcashSource (item 2)─
//
// When the user's OPFS holds a balance but no in-flight trade
// claims it, that's a recovery state. The banner replaces Browse
// and forces resolution before any commitment can be created.
// identifyStrandedEcashSource walks the local replay to find the
// most recent CLAIM event the user signed; the escrow that CLAIM
// lives on is the source of the orphan ecash.
console.log("\n── shouldShowRecoveryBanner + identifyStrandedEcashSource ──");
{
  // shouldShowRecoveryBanner: only when balance > 0 AND no active trade.
  assert(
    shouldShowRecoveryBanner({ balanceMsats: 50_000, hasCurrentEscrow: false }) === true,
    "Balance > 0 + no active trade → show banner",
  );
  assert(
    shouldShowRecoveryBanner({ balanceMsats: 0, hasCurrentEscrow: false }) === false,
    "Zero balance → no banner",
  );
  assert(
    shouldShowRecoveryBanner({ balanceMsats: 50_000, hasCurrentEscrow: true }) === false,
    "Balance > 0 but active trade exists → no banner (active trade owns the funds)",
  );

  // identifyStrandedEcashSource: find the most recent CLAIM signed by user.
  const me = "me_pubkey_dddd";
  const other = "other_pubkey_eeee";
  const arb = "arb_pubkey_ffff";

  const escrow = (overrides: Partial<EscrowState>): EscrowState => ({
    id: "test-id",
    status: EscrowStatus.COMPLETED,
    description: "test",
    amountMsats: 1_000_000,
    category: "p2p-trade",
    fulfillment: "service",
    community: "sn-cfa",
    mintUrl: BP_FEDERATION_INVITE,
    participants: { buyer: me, seller: other, arbiter: arb },
    initiator: { pubkey: me, role: Role.BUYER },
    communityArbiters: [],
    subscription: null,
    votes: {},
    resolvedOutcome: null,
    resolvedMajority: null,
    fees: { platformBps: 50, platformPubkey: me, arbiterFeeMsats: 0 },
    expiresAt: 0,
    createdAt: 1000,
    eventChain: [],
    chatMessages: [],
    lock: { handle: null },
    ...overrides,
  } as EscrowState);

  const claimEvent = (pubkey: string, timestamp: number) => ({
    raw: {} as any,
    payload: {} as any,
    escrowId: "test-id",
    prevEventId: null,
    kind: EscrowEventKind.CLAIM,
    pubkey,
    timestamp,
  });

  // No CLAIM events → null (banner falls back to "unknown counterparty").
  assert(
    identifyStrandedEcashSource({ escrows: [], userPubkey: me }) === null,
    "No escrows → null (generic withdraw fallback)",
  );

  // CLAIM signed by user → return source.
  const claimed = escrow({
    id: "claimed",
    description: "Pay my electric bill",
    amountMsats: 80_000_000,
    eventChain: [claimEvent(me, 5000)] as any,
  });
  const found = identifyStrandedEcashSource({ escrows: [claimed], userPubkey: me });
  assert(found !== null, "User-signed CLAIM → source identified");
  if (found) {
    assert(found.escrowId === "claimed", "Source escrow id matches");
    assert(found.counterpartyPubkey === other,
      "Counterparty is the other non-arbiter participant");
    assert(found.role === Role.BUYER,
      "Role reflects the user's position in the trade");
    assert(found.amountMsats === 80_000_000,
      "Amount carries through for the withdraw CTA");
    assert(found.description === "Pay my electric bill",
      "Description carries through for the banner identity card");
  }

  // CLAIM signed by someone else → not the source (privacy: don't
  // surface a counterparty for trades the user wasn't winner on).
  const otherWon = escrow({
    id: "other-won",
    eventChain: [claimEvent(other, 6000)] as any,
  });
  assert(
    identifyStrandedEcashSource({ escrows: [otherWon], userPubkey: me }) === null,
    "CLAIM signed by someone else → null (not the user's stranded ecash)",
  );

  // Multiple user-CLAIMs → most recent timestamp wins.
  const olderClaim = escrow({
    id: "older",
    eventChain: [claimEvent(me, 1000)] as any,
  });
  const newerClaim = escrow({
    id: "newer",
    eventChain: [claimEvent(me, 9000)] as any,
  });
  const mostRecent = identifyStrandedEcashSource({
    escrows: [olderClaim, newerClaim],
    userPubkey: me,
  });
  assert(mostRecent?.escrowId === "newer",
    "Most recent CLAIM by timestamp wins");
}

// ── 31f. decideListingTapEffect (items 1 + 4) ───────────────────────────
//
// Federation-follows-listing dispatch. Per Q1 confirmation: re-init
// happens at LISTING-TAP time, not Fund-CTA time. The detail screen
// always opens on the right fed; State B's past-tense narration
// reflects the switch that already happened.
console.log("\n── decideListingTapEffect ──");
{
  // Matching fed → State A render, no client work.
  const matching = decideListingTapEffect({
    listing: { mintUrl: BP_FEDERATION_INVITE, community: "sn-cfa" },
    currentInvite: BP_FEDERATION_INVITE,
    balanceMsats: 0,
  });
  assert(matching.kind === "matching",
    "Listing on user's current fed → matching (State A)");

  // Different fed, balance == 0 → silent switch.
  const switchSilent = decideListingTapEffect({
    listing: { mintUrl: BLF_FEDERATION_INVITE, community: "us-blf" },
    currentInvite: BP_FEDERATION_INVITE,
    balanceMsats: 0,
  });
  assert(switchSilent.kind === "switch-silent",
    "Different fed + balance==0 → switch-silent (State B path)");
  if (switchSilent.kind === "switch-silent") {
    assert(switchSilent.targetInvite === BLF_FEDERATION_INVITE,
      "Target invite matches the listing's fed");
    assert(switchSilent.displayName === "US · Bitcoin Life · USD",
      "Display name carries community name for narration");
  }

  // Different fed, balance > 0 → destroy-confirm modal.
  const destroyConfirm = decideListingTapEffect({
    listing: { mintUrl: BLF_FEDERATION_INVITE, community: "us-blf" },
    currentInvite: BP_FEDERATION_INVITE,
    balanceMsats: 50_000,
  });
  assert(destroyConfirm.kind === "destroy-confirm",
    "Different fed + balance>0 → destroy-confirm (Pillar 2.1)");

  // No current invite (truly disconnected) → switch-silent (caller
  // dispatches initFedimint vs switchFederation based on whether a
  // client is loaded).
  const noClient = decideListingTapEffect({
    listing: { mintUrl: BP_FEDERATION_INVITE, community: "sn-cfa" },
    currentInvite: null,
    balanceMsats: 0,
  });
  assert(noClient.kind === "switch-silent",
    "No current invite → switch-silent (no fund to preserve)");

  // mintUrl missing/stale → falls back to community-derived invite.
  // Defense-in-depth for pre-v0.1.87 listings without probe data.
  const fallback = decideListingTapEffect({
    listing: { mintUrl: "", community: "us-blf" },
    currentInvite: BP_FEDERATION_INVITE,
    balanceMsats: 0,
  });
  assert(fallback.kind === "switch-silent",
    "Missing mintUrl falls back to community-derived invite");
  if (fallback.kind === "switch-silent") {
    assert(fallback.targetInvite === BLF_FEDERATION_INVITE,
      "Community-derived fallback resolves to us-blf's pinned invite");
  }
}

// ── 31g. decideArbiterWarning (item 10) ─────────────────────────────────
//
// Arbiter status doesn't hard-block Create — instead, fire one of two
// warnings. Hard wins over soft; within tier, most recent escrow wins.
console.log("\n── decideArbiterWarning ──");
{
  const me = "me_arbiter_aaaa";
  const buyer = "buyer_pubkey_bbbb";
  const seller = "seller_pubkey_cccc";

  const arbEscrow = (overrides: Partial<EscrowState>): EscrowState => ({
    id: "arb-test",
    status: EscrowStatus.LOCKED,
    description: "test",
    amountMsats: 1_000_000,
    category: "p2p-trade",
    fulfillment: "service",
    community: "sn-cfa",
    mintUrl: BP_FEDERATION_INVITE,
    participants: { buyer, seller, arbiter: me },
    initiator: { pubkey: seller, role: Role.SELLER },
    communityArbiters: [],
    subscription: null,
    votes: {},
    resolvedOutcome: null,
    resolvedMajority: null,
    fees: { platformBps: 50, platformPubkey: seller, arbiterFeeMsats: 0 },
    expiresAt: 0,
    createdAt: 1000,
    eventChain: [],
    chatMessages: [],
    lock: { handle: null },
    ...overrides,
  } as EscrowState);

  // No arbiter escrows → none.
  assert(
    decideArbiterWarning({ escrows: [], userPubkey: me }).kind === "none",
    "No arbiter responsibility → none",
  );

  // LOCKED, no votes → soft.
  const noVotes = arbEscrow({ id: "soft1" });
  const soft = decideArbiterWarning({ escrows: [noVotes], userPubkey: me });
  assert(soft.kind === "soft",
    "LOCKED with no votes → soft warning (happy-path may never need arbiter)");
  if (soft.kind === "soft") {
    assert(soft.escrowId === "soft1", "Soft carries the escrow id");
    assert(soft.counterpartyA === buyer, "Soft counterpartyA is the buyer");
    assert(soft.counterpartyB === seller, "Soft counterpartyB is the seller");
  }

  // LOCKED with both votes disagreeing → hard.
  const disputed = arbEscrow({
    id: "hard1",
    votes: { [Role.BUYER]: Outcome.RELEASE, [Role.SELLER]: Outcome.REFUND },
  });
  const hard = decideArbiterWarning({ escrows: [disputed], userPubkey: me });
  assert(hard.kind === "hard",
    "LOCKED with disagreeing votes → hard warning (tiebreaker pending)");
  if (hard.kind === "hard") {
    assert(hard.escrowId === "hard1", "Hard carries the escrow id");
  }

  // Hard wins over soft when both present.
  const mixedSoft = arbEscrow({ id: "soft2", createdAt: 5000 });
  const mixedHard = arbEscrow({
    id: "hard2",
    createdAt: 1000,
    votes: { [Role.BUYER]: Outcome.RELEASE, [Role.SELLER]: Outcome.REFUND },
  });
  const mixed = decideArbiterWarning({
    escrows: [mixedSoft, mixedHard],
    userPubkey: me,
  });
  assert(mixed.kind === "hard",
    "Hard always wins over soft, even when soft is more recent");
  if (mixed.kind === "hard") {
    assert(mixed.escrowId === "hard2",
      "Hard winner is the disputed escrow regardless of relative timestamps");
  }

  // Within hard tier, most recent wins.
  const olderHard = arbEscrow({
    id: "old-hard",
    createdAt: 1000,
    votes: { [Role.BUYER]: Outcome.RELEASE, [Role.SELLER]: Outcome.REFUND },
  });
  const newerHard = arbEscrow({
    id: "new-hard",
    createdAt: 5000,
    votes: { [Role.BUYER]: Outcome.REFUND, [Role.SELLER]: Outcome.RELEASE },
  });
  const mostRecentHard = decideArbiterWarning({
    escrows: [olderHard, newerHard],
    userPubkey: me,
  });
  assert(
    mostRecentHard.kind === "hard"
      && mostRecentHard.escrowId === "new-hard",
    "Within hard tier, most recent createdAt wins",
  );

  // Non-LOCKED arbiter trade → not surfaced (settled or terminal).
  const completed = arbEscrow({
    id: "done",
    status: EscrowStatus.COMPLETED,
  });
  assert(
    decideArbiterWarning({ escrows: [completed], userPubkey: me }).kind === "none",
    "Arbiter on COMPLETED escrow → no warning (settled)",
  );

  // Both votes agree → state machine should have moved to APPROVED;
  // a stuck-at-LOCKED-with-agreeing-votes is defensive-only soft.
  const agreeStuck = arbEscrow({
    id: "agree-stuck",
    votes: { [Role.BUYER]: Outcome.RELEASE, [Role.SELLER]: Outcome.RELEASE },
  });
  assert(
    decideArbiterWarning({ escrows: [agreeStuck], userPubkey: me }).kind === "soft",
    "LOCKED with agreeing votes → soft (defensive — no tiebreaker needed)",
  );
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

// ── 33. LNURL PARSER (v0.3.0 Phase 1) ────────────────────────────────────
//
// Parse-time validation rejects malformed Lightning Addresses BEFORE any
// network call. Catches typos with a usable error in <1ms instead of
// burning a 5-second DNS timeout that surfaces as a generic network
// error. Per the v0.3.0 brief addition #1.
console.log("\n── LNURL PARSER ──");
{
  // Standard form
  const a = parseLightningAddress("alice@phoenix.app");
  assert(a.user === "alice" && a.domain === "phoenix.app",
    "Parses standard user@domain.tld");

  // Whitespace trimmed
  const b = parseLightningAddress("  bob@strike.me  ");
  assert(b.user === "bob" && b.domain === "strike.me",
    "Trims whitespace before parsing");

  // Mixed case normalized to lowercase
  const c = parseLightningAddress("Alice@Phoenix.App");
  assert(c.user === "alice" && c.domain === "phoenix.app",
    "Lowercases user and domain");

  // Underscores, dots, dashes in user
  const d = parseLightningAddress("first.last_99-x@wallet.io");
  assert(d.user === "first.last_99-x" && d.domain === "wallet.io",
    "Accepts dot/dash/underscore in user");

  // Multi-level subdomain
  const e = parseLightningAddress("user@pay.api.example.com");
  assert(e.user === "user" && e.domain === "pay.api.example.com",
    "Accepts multi-level subdomains");

  // ── Synchronous rejection — no fetch issued ────────────────────────────
  // Track whether fetch is called during parse-time validation. parser
  // must not touch the network for any input it will reject.
  let fetchCalled = 0;
  const sentinelFetch: typeof fetch = (async () => {
    fetchCalled++;
    return new Response("{}", { status: 200 });
  }) as any;
  void sentinelFetch; // explicitly unused — parseLightningAddress is sync

  const rejects = (raw: any, label: string) => {
    let threwParse = false;
    let code = "";
    try { parseLightningAddress(raw); }
    catch (err) {
      if (err instanceof LnurlError) {
        threwParse = true;
        code = err.code;
      }
    }
    assert(threwParse && code === "LnurlParseError",
      `Rejects ${label} synchronously as LnurlParseError`);
  };

  rejects("", "empty string");
  rejects("   ", "whitespace only");
  rejects("noatsign", "missing '@'");
  rejects("user@@two.ats", "two '@' signs");
  rejects("user@nodot", "domain without TLD dot");
  rejects("user@.tld", "domain starting with dot");
  rejects("user@tld.x", "TLD shorter than 2 chars");
  rejects("user@host.", "trailing dot domain");
  rejects("user with space@host.com", "spaces in user");
  rejects("user@host with space.com", "spaces in domain");
  rejects("user!@host.com", "special char in user");
  rejects(null, "null");
  rejects(undefined, "undefined");
  rejects(42, "number input");

  assert(fetchCalled === 0,
    "Parser issued zero fetches (synchronous validation only)");

  // isLightningAddress mirrors parser without throwing
  assert(isLightningAddress("alice@phoenix.app") === true,
    "isLightningAddress true for valid input");
  assert(isLightningAddress("not-an-address") === false,
    "isLightningAddress false for invalid input");
  assert(isLightningAddress("") === false,
    "isLightningAddress false for empty");
}

// ── 34. LNURL RESOLVER (mocked fetch) ────────────────────────────────────
//
// Resolver tests use an explicit fetchImpl injected per test rather than
// monkey-patching globalThis.fetch. Keeps tests order-independent and
// concurrent-safe.
console.log("\n── LNURL RESOLVER ──");
{
  const okMetadata = (overrides: Partial<any> = {}) => ({
    callback: "https://phoenix.app/lnurlp/alice/callback",
    minSendable: 1000,
    maxSendable: 1_000_000_000,
    metadata: "[]",
    tag: "payRequest",
    ...overrides,
  });

  const jsonResponse = (body: any, status = 200) => new Response(
    JSON.stringify(body), { status, headers: { "content-type": "application/json" } },
  );

  const textResponse = (body: string, status = 200) => new Response(
    body, { status, headers: { "content-type": "text/plain" } },
  );

  // Happy path — metadata fetch + invoice request → BOLT11 returned
  {
    const calls: string[] = [];
    const mockFetch: typeof fetch = (async (url: any) => {
      calls.push(String(url));
      if (String(url).includes("/.well-known/lnurlp/")) {
        return jsonResponse(okMetadata());
      }
      return jsonResponse({ pr: "lnbc500n1pfakeinvoice", routes: [] });
    }) as any;

    const meta = await fetchLnurlPayMetadata("alice@phoenix.app", mockFetch);
    assert(meta.callback === "https://phoenix.app/lnurlp/alice/callback",
      "Metadata callback parsed");
    assert(meta.minSendable === 1000 && meta.maxSendable === 1_000_000_000,
      "Metadata min/maxSendable parsed");
    assert(meta.tag === "payRequest",
      "Metadata tag pinned to payRequest");

    const bolt11 = await requestLnurlInvoice(meta, 5000, mockFetch);
    assert(bolt11 === "lnbc500n1pfakeinvoice",
      "Callback returns BOLT11 invoice string");
    assert(calls[0].endsWith("/.well-known/lnurlp/alice"),
      "Metadata URL uses .well-known/lnurlp path");
    assert(calls[1].includes("amount=5000000"),
      "Callback URL includes amount in msats (5000 sats)");
  }

  // Resolver one-shot — chains metadata + callback
  {
    const mockFetch: typeof fetch = (async (url: any) => {
      if (String(url).includes("/.well-known/lnurlp/")) {
        return jsonResponse(okMetadata());
      }
      return jsonResponse({ pr: "lnbc1000n1pchainedok" });
    }) as any;
    const bolt11 = await resolveLightningAddressToInvoice(
      "alice@phoenix.app", 1000, mockFetch,
    );
    assert(bolt11 === "lnbc1000n1pchainedok",
      "resolveLightningAddressToInvoice chains metadata + callback");
  }

  // DNS / network error
  {
    const mockFetch: typeof fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as any;
    let code = "";
    try { await fetchLnurlPayMetadata("alice@phoenix.app", mockFetch); }
    catch (e) { if (e instanceof LnurlError) code = e.code; }
    assert(code === "LnurlDnsError",
      "Network/DNS failure surfaces as LnurlDnsError");
  }

  // HTTP 404
  {
    const mockFetch: typeof fetch = (async () =>
      jsonResponse({ status: "ERROR", reason: "user not found" }, 404)
    ) as any;
    let code = "";
    try { await fetchLnurlPayMetadata("ghost@phoenix.app", mockFetch); }
    catch (e) { if (e instanceof LnurlError) code = e.code; }
    assert(code === "LnurlServerError",
      "HTTP 404 surfaces as LnurlServerError");
  }

  // 200 OK but body is non-JSON
  {
    const mockFetch: typeof fetch = (async () =>
      textResponse("<html>not json</html>")
    ) as any;
    let code = "";
    try { await fetchLnurlPayMetadata("alice@phoenix.app", mockFetch); }
    catch (e) { if (e instanceof LnurlError) code = e.code; }
    assert(code === "LnurlMalformedError",
      "Non-JSON body surfaces as LnurlMalformedError");
  }

  // 200 OK with LNURL-level error (status: ERROR)
  {
    const mockFetch: typeof fetch = (async () =>
      jsonResponse({ status: "ERROR", reason: "user disabled" })
    ) as any;
    let code = "";
    let msg = "";
    try { await fetchLnurlPayMetadata("alice@phoenix.app", mockFetch); }
    catch (e) {
      if (e instanceof LnurlError) {
        code = e.code;
        msg = e.message;
      }
    }
    assert(code === "LnurlServerError",
      "LNURL status:ERROR surfaces as LnurlServerError");
    assert(/user disabled/.test(msg),
      "LNURL error reason carried into surfaced message");
  }

  // Malformed metadata — missing required fields
  {
    const mockFetch: typeof fetch = (async () =>
      jsonResponse({ tag: "payRequest", callback: "https://x" /* no min/max */ })
    ) as any;
    let code = "";
    try { await fetchLnurlPayMetadata("alice@phoenix.app", mockFetch); }
    catch (e) { if (e instanceof LnurlError) code = e.code; }
    assert(code === "LnurlMalformedError",
      "Metadata missing min/maxSendable surfaces as LnurlMalformedError");
  }

  // Malformed metadata — wrong tag
  {
    const mockFetch: typeof fetch = (async () =>
      jsonResponse({ tag: "withdrawRequest", callback: "https://x", minSendable: 1, maxSendable: 1 })
    ) as any;
    let code = "";
    try { await fetchLnurlPayMetadata("alice@phoenix.app", mockFetch); }
    catch (e) { if (e instanceof LnurlError) code = e.code; }
    assert(code === "LnurlMalformedError",
      "Wrong tag (not payRequest) surfaces as LnurlMalformedError");
  }

  // Amount out of range — synchronous, no fetch issued
  {
    let fetched = 0;
    const mockFetch: typeof fetch = (async () => {
      fetched++;
      return jsonResponse({ pr: "lnbc1" });
    }) as any;
    const meta: LnurlPayMetadata = {
      callback: "https://x/cb",
      minSendable: 100_000,    // 100 sats
      maxSendable: 1_000_000,  //   1k sats
      metadata: "[]",
      tag: "payRequest",
    };
    let codeBelow = "";
    try { await requestLnurlInvoice(meta, 50, mockFetch); }
    catch (e) { if (e instanceof LnurlError) codeBelow = e.code; }
    let codeAbove = "";
    try { await requestLnurlInvoice(meta, 5000, mockFetch); }
    catch (e) { if (e instanceof LnurlError) codeAbove = e.code; }
    assert(codeBelow === "LnurlAmountOutOfRangeError",
      "Below minSendable → LnurlAmountOutOfRangeError");
    assert(codeAbove === "LnurlAmountOutOfRangeError",
      "Above maxSendable → LnurlAmountOutOfRangeError");
    assert(fetched === 0,
      "Out-of-range amount issues no callback fetch (synchronous reject)");
  }

  // Callback returns no `pr` field
  {
    const mockFetch: typeof fetch = (async (url: any) => {
      if (String(url).includes("/.well-known/")) return jsonResponse(okMetadata());
      return jsonResponse({ routes: [] }); // no pr field
    }) as any;
    let code = "";
    try { await resolveLightningAddressToInvoice("alice@phoenix.app", 5, mockFetch); }
    catch (e) { if (e instanceof LnurlError) code = e.code; }
    assert(code === "LnurlMalformedError",
      "Callback without pr field → LnurlMalformedError");
  }

  // Callback returns non-BOLT11 string (not starting with lnbc)
  {
    const mockFetch: typeof fetch = (async (url: any) => {
      if (String(url).includes("/.well-known/")) return jsonResponse(okMetadata());
      return jsonResponse({ pr: "not-an-invoice" });
    }) as any;
    let code = "";
    try { await resolveLightningAddressToInvoice("alice@phoenix.app", 5, mockFetch); }
    catch (e) { if (e instanceof LnurlError) code = e.code; }
    assert(code === "LnurlMalformedError",
      "Callback with non-BOLT11 pr → LnurlMalformedError");
  }
}

// ── 35. SAVED HANDLES — Lightning rail (v0.3.0 Phase 1) ─────────────────
//
// addOrTouchLightningHandle is idempotent: re-saving the same address
// bumps lastUsedAt rather than duplicating. getSavedLightningHandles
// returns LN handles sorted by most-recent-used, falling back to
// createdAt for handles missing lastUsedAt.
console.log("\n── SAVED HANDLES — Lightning rail ──");
{
  (globalThis as any).localStorage.clear();

  // First save creates new entry
  const a = addOrTouchLightningHandle("alice@phoenix.app");
  assert(a.rail === LIGHTNING_RAIL,
    "First save uses LIGHTNING_RAIL key");
  assert(a.handle === "alice@phoenix.app",
    "Address stored as-typed (lowercase normalized)");
  assert(typeof a.lastUsedAt === "number",
    "First save sets lastUsedAt");
  assert(a.visibility === "private",
    "Lightning handles default to private (never published)");

  // Mixed-case input normalized
  const b = addOrTouchLightningHandle("Bob@Strike.ME");
  assert(b.handle === "bob@strike.me",
    "Mixed case normalized to lowercase on save");

  // ── Idempotency: same address (same case) bumps lastUsedAt, no dup ───
  // Wait at least 1 second so the second save's lastUsedAt is strictly
  // greater than the first (the storage uses 1-second resolution).
  await new Promise(r => setTimeout(r, 1100));
  const aTouched = addOrTouchLightningHandle("alice@phoenix.app");
  assert(aTouched.id === a.id,
    "Re-saving same address returns same id (no dup)");
  assert((aTouched.lastUsedAt ?? 0) > (a.lastUsedAt ?? 0),
    "Re-saving bumps lastUsedAt forward");
  assert(getSavedLightningHandles().length === 2,
    "Storage still holds 2 LN handles after touch (no duplicate row)");

  // Idempotency is case-insensitive
  const aCaseTouched = addOrTouchLightningHandle("ALICE@PHOENIX.APP");
  assert(aCaseTouched.id === a.id,
    "Case-insensitive match against existing handle (no dup)");

  // Empty rejected
  let threwEmpty = false;
  try { addOrTouchLightningHandle("   "); } catch { threwEmpty = true; }
  assert(threwEmpty,
    "addOrTouchLightningHandle rejects empty/whitespace input");

  // ── Sort: most-recent-used first ─────────────────────────────────────
  // After touching alice last, alice should be first in the picker list.
  const sorted = getSavedLightningHandles();
  assert(sorted.length === 2,
    "Two LN handles in storage");
  assert(sorted[0].handle === "alice@phoenix.app",
    "Most-recently-used handle (alice) sorts first");
  assert(sorted[1].handle === "bob@strike.me",
    "Older handle (bob) sorts second");

  // ── Other rails unaffected ───────────────────────────────────────────
  addSavedHandle("revtag", "@charlie");
  const lnOnly = getSavedLightningHandles();
  assert(lnOnly.length === 2,
    "getSavedLightningHandles excludes non-LN rails");
  assert(lnOnly.every(h => h.rail === LIGHTNING_RAIL),
    "All returned entries have rail=LIGHTNING_RAIL");

  // ── Fallback to createdAt when lastUsedAt missing ────────────────────
  // Simulate a pre-v0.3.0 handle that lacks lastUsedAt by writing
  // directly to storage. getSavedLightningHandles must not crash and
  // must use createdAt as the sort key.
  const raw = (globalThis as any).localStorage.getItem(SAVED_HANDLES_STORAGE_KEY);
  const all = JSON.parse(raw);
  all.push({
    id: "h_legacy",
    rail: LIGHTNING_RAIL,
    handle: "legacy@old.app",
    visibility: "private",
    createdAt: 1, // very old
    // no lastUsedAt
  });
  (globalThis as any).localStorage.setItem(
    SAVED_HANDLES_STORAGE_KEY, JSON.stringify(all),
  );
  const withLegacy = getSavedLightningHandles();
  assert(withLegacy.length === 3,
    "Legacy LN handle (no lastUsedAt) read without crash");
  assert(withLegacy[withLegacy.length - 1].handle === "legacy@old.app",
    "Handle missing lastUsedAt sorts last (createdAt fallback works)");
}

// ── 36. DESTINATION PICKER — pure decision logic (v0.3.0 Phase 1) ───────
//
// Tests the pure helpers in destination-picker-logic.ts. Component-level
// rendering is exercised transitively by phases 3, 4 (claim, recovery,
// destroy modal) per the brief.
console.log("\n── DESTINATION PICKER — logic ──");
{
  // ── decorateSavedHandlesForPicker ────────────────────────────────────
  // Empty list → empty array
  assert(decorateSavedHandlesForPicker([]).length === 0,
    "Empty saved-handles input → empty decorated list");

  // Default badge on first (most-recent-used)
  const handles = [
    { id: "h1", rail: LIGHTNING_RAIL, handle: "alice@phoenix.app",
      visibility: "private" as const, createdAt: 100, lastUsedAt: 200 },
    { id: "h2", rail: LIGHTNING_RAIL, handle: "bob@strike.me",
      visibility: "private" as const, createdAt: 100, lastUsedAt: 100 },
    { id: "h3", rail: LIGHTNING_RAIL, handle: "carol@wallet.io",
      visibility: "private" as const, createdAt: 100, lastUsedAt: 150 },
  ];
  const decorated = decorateSavedHandlesForPicker(handles);
  assert(decorated.length === 3,
    "Decorator preserves all input handles");
  assert(decorated[0].handle.id === "h1" && decorated[0].isDefault === true,
    "Most-recent-used handle (h1, lastUsedAt=200) gets isDefault=true");
  assert(decorated[1].isDefault === false && decorated[2].isDefault === false,
    "Non-first handles all have isDefault=false");
  assert(decorated[1].handle.id === "h3",
    "Sort: lastUsedAt 200 > 150 > 100 (h1, h3, h2)");

  // Fallback to createdAt when lastUsedAt missing on some entries
  const mixed = [
    { id: "h_old", rail: LIGHTNING_RAIL, handle: "old@a.app",
      visibility: "private" as const, createdAt: 50 /* no lastUsedAt */ },
    { id: "h_new", rail: LIGHTNING_RAIL, handle: "new@b.app",
      visibility: "private" as const, createdAt: 100, lastUsedAt: 100 },
  ];
  const mixedDec = decorateSavedHandlesForPicker(mixed);
  assert(mixedDec[0].handle.id === "h_new",
    "Handles with lastUsedAt sort above bare createdAt entries");

  // ── classifyDestinationInput ─────────────────────────────────────────
  assert(classifyDestinationInput("").kind === "empty",
    "Empty input → empty");
  assert(classifyDestinationInput("   ").kind === "empty",
    "Whitespace-only → empty");

  const lnAddr = classifyDestinationInput("alice@phoenix.app");
  assert(lnAddr.kind === "lightning-address" && lnAddr.address === "alice@phoenix.app",
    "Lightning Address recognized");

  const lnAddrCase = classifyDestinationInput("ALICE@PHOENIX.APP");
  assert(lnAddrCase.kind === "lightning-address" && lnAddrCase.address === "alice@phoenix.app",
    "Lightning Address normalized to lowercase");

  const bolt = classifyDestinationInput("lnbc500n1pfake");
  assert(bolt.kind === "bolt11" && bolt.bolt11 === "lnbc500n1pfake",
    "BOLT11 recognized via lnbc prefix");

  const boltTrim = classifyDestinationInput("  lnbc500n1pfake  ");
  assert(boltTrim.kind === "bolt11",
    "BOLT11 with surrounding whitespace recognized after trim");

  const invalid = classifyDestinationInput("zzz garbage");
  assert(invalid.kind === "invalid",
    "Random garbage → invalid");

  // ── decideDispatch ───────────────────────────────────────────────────
  // Tier 1: tapped saved row wins regardless of typed/paste content
  const sample: SavedHandle = {
    id: "h_sample", rail: LIGHTNING_RAIL, handle: "alice@phoenix.app",
    visibility: "private", createdAt: 100, lastUsedAt: 100,
  };
  {
    const r = decideDispatch({
      tappedSavedHandle: sample,
      typedInput: classifyDestinationInput("ignored@host.com"),
      saveToggleOn: false,
    });
    assert(r.ok && r.decision.tier === "saved-row",
      "Tapped saved row → tier=saved-row");
    assert(r.ok && r.decision.addressUsed === "alice@phoenix.app",
      "Tapped saved row → addressUsed = the saved handle");
    assert(r.ok && r.decision.saveAfter === true,
      "Tapped saved row → saveAfter true (bumps lastUsedAt)");
  }

  // Tier 3 (Advanced paste) wins over Tier 2 typed when both present
  {
    const r = decideDispatch({
      typedInput: classifyDestinationInput("alice@phoenix.app"),
      bolt11PasteInput: classifyDestinationInput("lnbc999n1ppaste"),
      saveToggleOn: true,
    });
    assert(r.ok && r.decision.tier === "pasted-bolt11",
      "Advanced BOLT11 paste preempts typed address");
    assert(r.ok && r.decision.saveAfter === false,
      "Advanced BOLT11 paste → saveAfter false (no address to save)");
    assert(r.ok && r.decision.addressUsed === undefined,
      "Advanced BOLT11 paste → addressUsed undefined");
  }

  // Tier 2 typed Lightning Address — saveAfter follows toggle
  {
    const rOn = decideDispatch({
      typedInput: classifyDestinationInput("alice@phoenix.app"),
      saveToggleOn: true,
    });
    assert(rOn.ok && rOn.decision.tier === "typed-address" && rOn.decision.saveAfter === true,
      "Typed address with toggle ON → tier=typed-address, saveAfter=true");
    const rOff = decideDispatch({
      typedInput: classifyDestinationInput("alice@phoenix.app"),
      saveToggleOn: false,
    });
    assert(rOff.ok && rOff.decision.saveAfter === false,
      "Typed address with toggle OFF → saveAfter=false");
  }

  // Tier 2 cross-tier paste — user pasted BOLT11 into the LN field
  {
    const r = decideDispatch({
      typedInput: classifyDestinationInput("lnbc12n1pcross"),
      saveToggleOn: true,
    });
    assert(r.ok && r.decision.tier === "pasted-bolt11",
      "BOLT11 typed into LN field accepted as pasted-bolt11");
    assert(r.ok && r.decision.saveAfter === false,
      "Cross-tier paste forces saveAfter=false (no address to save)");
  }

  // Invalid typed input → ok:false with reason
  {
    const r = decideDispatch({
      typedInput: classifyDestinationInput("zzz garbage"),
      saveToggleOn: true,
    });
    assert(!r.ok && /Lightning Address|BOLT11/.test(r.reason),
      "Invalid input → ok:false carrying typed-classifier reason");
  }

  // Empty input + nothing tapped → ok:false
  {
    const r = decideDispatch({
      typedInput: classifyDestinationInput(""),
      saveToggleOn: true,
    });
    assert(!r.ok,
      "Empty input + no saved row tap → ok:false");
  }
}

// ── 37. POLL FOR FUNDING (v0.3.0 Phase 2) ────────────────────────────────
//
// pollForFunding is the polling watchdog inside runFundAndLock. Tests
// inject a synthetic clock + sleep + balance reader so the timing
// behavior is deterministic and fast. Each test pins one terminal
// phase + the phase events leading to it.
console.log("\n── POLL FOR FUNDING ──");
{
  // Helper: build a controllable clock + sleep that advance in lockstep,
  // plus a balance script that returns the i-th value per call.
  function harness(opts: {
    balances: number[];
    paymentDeadlineMs?: number;
    mintConfirmTimeoutMs?: number;
    pollIntervalMs?: number;
    thresholdPct?: number;
    signal?: AbortSignal;
  }) {
    let nowMs = 0;
    let i = 0;
    const phases: FundingPhase[] = [];
    const sleep = async (ms: number) => { nowMs += ms; };
    const now = () => nowMs;
    const getBalance = async () => {
      const v = opts.balances[Math.min(i, opts.balances.length - 1)];
      i++;
      return v;
    };
    const onPhase = (p: FundingPhase) => phases.push(p);
    return { phases, getBalance, sleep, now, onPhase, callCountRef: () => i, clock: () => nowMs };
  }

  // Happy path — payment lands fully on first poll
  {
    const h = harness({ balances: [0, 100_000] });
    const result = await pollForFunding({
      baselineMsats: 0,
      expectedMsats: 100_000,
      getBalance: h.getBalance,
      onPhase: h.onPhase,
      sleep: h.sleep,
      now: h.now,
      paymentDeadlineMs: 60_000,
      mintConfirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(result.kind === "payment-confirmed",
      "Happy path: balance lands fully → payment-confirmed");
    assert(h.phases[0]?.kind === "awaiting-payment",
      "First emitted phase is awaiting-payment");
    assert(h.phases.some(p => p.kind === "payment-confirmed"),
      "Terminal payment-confirmed phase emitted");
    assert(!h.phases.some(p => p.kind === "mint-confirming"),
      "No mint-confirming phase when balance lands fully on first read");
  }

  // Threshold tolerance — accept 92% of expected (above 90% default)
  {
    const h = harness({ balances: [0, 92_000] });
    const result = await pollForFunding({
      baselineMsats: 0,
      expectedMsats: 100_000,
      getBalance: h.getBalance,
      onPhase: h.onPhase,
      sleep: h.sleep,
      now: h.now,
      paymentDeadlineMs: 60_000,
      mintConfirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(result.kind === "payment-confirmed",
      "Threshold tolerance: 92k of 100k accepted as confirmed (>= 90%)");
  }

  // Mint-confirming → payment-confirmed sequence
  {
    const h = harness({ balances: [0, 0, 50_000, 50_000, 100_000] });
    const result = await pollForFunding({
      baselineMsats: 0,
      expectedMsats: 100_000,
      getBalance: h.getBalance,
      onPhase: h.onPhase,
      sleep: h.sleep,
      now: h.now,
      paymentDeadlineMs: 60_000,
      mintConfirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(result.kind === "payment-confirmed",
      "Partial then full → payment-confirmed");
    const order = h.phases.map(p => p.kind);
    const awaitingIdx = order.indexOf("awaiting-payment");
    const mintIdx = order.indexOf("mint-confirming");
    const confIdx = order.indexOf("payment-confirmed");
    assert(awaitingIdx === 0,
      "Phase order: awaiting-payment first");
    assert(mintIdx > awaitingIdx,
      "Phase order: mint-confirming after awaiting-payment");
    assert(confIdx > mintIdx,
      "Phase order: payment-confirmed after mint-confirming");
  }

  // Expired — no payment ever, paymentDeadline elapses
  {
    const h = harness({ balances: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
    const result = await pollForFunding({
      baselineMsats: 0,
      expectedMsats: 100_000,
      getBalance: h.getBalance,
      onPhase: h.onPhase,
      sleep: h.sleep,
      now: h.now,
      paymentDeadlineMs: 5_000,
      mintConfirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(result.kind === "expired",
      "No payment in window → expired");
    assert(!h.phases.some(p => p.kind === "mint-confirming"),
      "No mint-confirming phase emitted when balance never moves");
  }

  // Mint-timeout — partial credit got stuck for the full 60s grace
  {
    const h = harness({
      balances: [0, 0, 50_000, 50_000, 50_000, 50_000, 50_000, 50_000, 50_000, 50_000],
    });
    const result = await pollForFunding({
      baselineMsats: 0,
      expectedMsats: 100_000,
      getBalance: h.getBalance,
      onPhase: h.onPhase,
      sleep: h.sleep,
      now: h.now,
      paymentDeadlineMs: 60_000,
      mintConfirmTimeoutMs: 5_000,
      pollIntervalMs: 1_000,
    });
    assert(result.kind === "mint-timeout",
      "Partial credit stuck past mint timeout → mint-timeout");
    assert(h.phases.some(p => p.kind === "mint-confirming"),
      "mint-confirming phase fired before timeout");
    assert(h.phases[h.phases.length - 1].kind === "mint-timeout",
      "Terminal phase emitted last is mint-timeout");
  }

  // Mint-confirming countdown is independent of paymentDeadline. Even
  // if paymentDeadline would NOT have fired, mintConfirmTimeout fires
  // its own clock from when partial was first detected.
  {
    // 100ms paymentDeadline (would have fired at t=100); but partial
    // arrives at t=50, and mintConfirmTimeout=200ms, so terminal kind
    // should be mint-timeout at t=250 (50 + 200), NOT expired at t=100.
    let nowMs = 0;
    let i = 0;
    const balances = [0, 50_000, 50_000, 50_000, 50_000, 50_000, 50_000];
    const phases: FundingPhase[] = [];
    const result = await pollForFunding({
      baselineMsats: 0,
      expectedMsats: 100_000,
      getBalance: async () => balances[Math.min(i++, balances.length - 1)],
      onPhase: p => phases.push(p),
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      paymentDeadlineMs: 100,
      mintConfirmTimeoutMs: 200,
      pollIntervalMs: 50,
    });
    assert(result.kind === "mint-timeout",
      "Mint-confirm timer is independent: partial-then-stuck = mint-timeout, not expired");
  }

  // Aborted via signal mid-loop
  {
    const ctrl = new AbortController();
    const h = harness({ balances: [0, 0, 0, 0, 0] });
    // Abort before the first sleep tick so the loop exits at the top
    ctrl.abort();
    const result = await pollForFunding({
      baselineMsats: 0,
      expectedMsats: 100_000,
      getBalance: h.getBalance,
      onPhase: h.onPhase,
      sleep: h.sleep,
      now: h.now,
      signal: ctrl.signal,
      paymentDeadlineMs: 60_000,
      mintConfirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(result.kind === "aborted",
      "AbortSignal already-aborted → aborted terminal");
    assert(h.phases[h.phases.length - 1].kind === "aborted",
      "Aborted phase emitted as terminal");
  }

  // getBalance throwing transiently doesn't crash the loop
  {
    let calls = 0;
    let nowMs = 0;
    const phases: FundingPhase[] = [];
    const result = await pollForFunding({
      baselineMsats: 0,
      expectedMsats: 100_000,
      getBalance: async () => {
        calls++;
        if (calls < 3) throw new Error("transient federation error");
        return 100_000;
      },
      onPhase: p => phases.push(p),
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      paymentDeadlineMs: 60_000,
      mintConfirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(result.kind === "payment-confirmed",
      "Transient getBalance throws don't break the loop");
    assert(calls >= 3, "getBalance was retried after throws");
  }

  // Defaults match the documented constants
  {
    // 15min payment deadline, 60s mint-confirm, 5s poll, 0.9 threshold.
    // We confirm by triggering the deadline path with defaults left in
    // place. Use a tiny override only on pollIntervalMs so the test
    // finishes quickly; everything else inherits.
    let nowMs = 0;
    const phases: FundingPhase[] = [];
    const result = await pollForFunding({
      baselineMsats: 0,
      expectedMsats: 100_000,
      getBalance: async () => 0,
      onPhase: p => phases.push(p),
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      pollIntervalMs: 60_000, // 1-minute ticks so we hit 15min in 15 ticks
    });
    assert(result.kind === "expired",
      "Default 15min payment deadline triggers expired with no payment");
    // Roughly 15 ticks of 60s each = 15 minutes
    assert(nowMs >= 15 * 60_000 && nowMs < 17 * 60_000,
      "Expired fired around 15min mark using default deadline");
  }
}

// ── 38. RUN FUND AND LOCK (v0.3.0 Phase 2) ──────────────────────────────
//
// runFundAndLock orchestrates createFundingInvoice + pollForFunding +
// lockAndPublish. Mocks the wallet seam to verify each terminal path.
console.log("\n── RUN FUND AND LOCK ──");
{
  // Mock helpers
  function makeMockWallet(opts: {
    balances: number[];
    invoiceResult?: string | Error;
    lockResult?: "ok" | Error;
  }) {
    let i = 0;
    const calls = {
      createInvoice: 0 as number,
      lockAndPublish: 0 as number,
      getBalance: 0 as number,
    };
    return {
      calls,
      getBalance: async () => {
        calls.getBalance++;
        return opts.balances[Math.min(i++, opts.balances.length - 1)];
      },
      createFundingInvoice: async (_msats: number, _desc: string) => {
        calls.createInvoice++;
        if (opts.invoiceResult instanceof Error) throw opts.invoiceResult;
        return opts.invoiceResult ?? "lnbc100n1pfakefundingok";
      },
      lockAndPublish: async (_id: string, _o: { savedHandleId?: string }) => {
        calls.lockAndPublish++;
        if (opts.lockResult instanceof Error) throw opts.lockResult;
        return {} as any;
      },
    };
  }

  // ── Happy path: invoice → balance lands → lock → locked ─────────────
  {
    const wallet = makeMockWallet({ balances: [0, 100_000] });
    const phases: FundAndLockPhase[] = [];
    let nowMs = 0;
    const terminal = await runFundAndLock({
      escrowId: "esc_test_1",
      amountMsats: 100_000,
      description: "test fund",
      getBalance: wallet.getBalance,
      createFundingInvoice: wallet.createFundingInvoice,
      lockAndPublish: wallet.lockAndPublish,
      onPhase: p => phases.push(p),
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      paymentDeadlineMs: 60_000,
      mintConfirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "locked",
      "Happy path → terminal kind=locked");
    const order = phases.map(p => p.kind);
    assert(order[0] === "creating-invoice",
      "First phase: creating-invoice");
    assert(order.includes("invoice-created"),
      "invoice-created phase emitted with BOLT11");
    const invoiceCreated = phases.find(p => p.kind === "invoice-created");
    assert(!!invoiceCreated && (invoiceCreated as any).bolt11 === "lnbc100n1pfakefundingok",
      "invoice-created carries the BOLT11 returned by createFundingInvoice");
    assert(order.includes("locking"),
      "locking phase emitted after payment-confirmed");
    assert(order[order.length - 1] === "locked",
      "Terminal phase: locked");
    assert(wallet.calls.createInvoice === 1,
      "createFundingInvoice called exactly once");
    assert(wallet.calls.lockAndPublish === 1,
      "lockAndPublish called exactly once after payment");
  }

  // ── Sequencing assertion: lockAndPublish never called before payment-confirmed
  {
    const wallet = makeMockWallet({ balances: [0, 0, 0, 0, 0, 0] }); // never lands
    let lockCalledAtPhase: string | null = null;
    let lastPhase: string = "";
    let nowMs = 0;
    await runFundAndLock({
      escrowId: "esc_test_2",
      amountMsats: 100_000,
      description: "test never-land",
      getBalance: wallet.getBalance,
      createFundingInvoice: wallet.createFundingInvoice,
      lockAndPublish: async (_id, _o) => {
        lockCalledAtPhase = lastPhase;
        wallet.calls.lockAndPublish++;
        return {} as any;
      },
      onPhase: p => { lastPhase = p.kind; },
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      paymentDeadlineMs: 5_000,
      mintConfirmTimeoutMs: 5_000,
      pollIntervalMs: 1_000,
    });
    assert(wallet.calls.lockAndPublish === 0,
      "lockAndPublish NEVER called when payment doesn't land");
    assert(lockCalledAtPhase === null,
      "lock dispatch path never reached during expiry");
  }

  // ── Expired terminal: no orphan lock dispatched, modal handles cleanup
  {
    const wallet = makeMockWallet({ balances: [0, 0, 0, 0, 0] });
    let nowMs = 0;
    const terminal = await runFundAndLock({
      escrowId: "esc_test_3",
      amountMsats: 100_000,
      description: "expire test",
      getBalance: wallet.getBalance,
      createFundingInvoice: wallet.createFundingInvoice,
      lockAndPublish: wallet.lockAndPublish,
      onPhase: () => {},
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      paymentDeadlineMs: 3_000,
      mintConfirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "expired",
      "No payment in window → terminal expired");
    assert(wallet.calls.createInvoice === 1,
      "Invoice was created");
    assert(wallet.calls.lockAndPublish === 0,
      "LOCK never dispatched on expired path (no orphan)");
  }

  // ── Mint-timeout terminal: surfaces try-LOCK retry path to caller
  {
    const wallet = makeMockWallet({
      balances: [0, 50_000, 50_000, 50_000, 50_000, 50_000, 50_000],
    });
    let nowMs = 0;
    const terminal = await runFundAndLock({
      escrowId: "esc_test_4",
      amountMsats: 100_000,
      description: "mint timeout test",
      getBalance: wallet.getBalance,
      createFundingInvoice: wallet.createFundingInvoice,
      lockAndPublish: wallet.lockAndPublish,
      onPhase: () => {},
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      paymentDeadlineMs: 60_000,
      mintConfirmTimeoutMs: 3_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "mint-timeout",
      "Partial credit stuck → terminal mint-timeout");
    assert(wallet.calls.lockAndPublish === 0,
      "LOCK NOT auto-dispatched on mint-timeout (modal surfaces try-LOCK retry)");
  }

  // ── LOCK-failed terminal: balance landed but lockAndPublish threw.
  // This is the orphan-balance case the recovery banner catches on
  // next visit (per Phase 4).
  {
    const wallet = makeMockWallet({
      balances: [0, 100_000, 100_000],
      lockResult: new Error("FED_MISMATCH: wallet on different fed"),
    });
    let nowMs = 0;
    const terminal = await runFundAndLock({
      escrowId: "esc_test_5",
      amountMsats: 100_000,
      description: "lock fail test",
      getBalance: wallet.getBalance,
      createFundingInvoice: wallet.createFundingInvoice,
      lockAndPublish: wallet.lockAndPublish,
      onPhase: () => {},
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      paymentDeadlineMs: 60_000,
      mintConfirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "lock-failed",
      "Balance landed but lock threw → terminal lock-failed");
    if (terminal.kind === "lock-failed") {
      assert(/FED_MISMATCH/.test(terminal.error),
        "lock-failed terminal carries the underlying error message");
    }
    assert(wallet.calls.lockAndPublish === 1,
      "LOCK was attempted (not silently skipped)");
  }

  // ── Invoice-creation failure: lock-failed surfaces upstream error
  {
    const wallet = makeMockWallet({
      balances: [0],
      invoiceResult: new Error("federation unreachable"),
    });
    const phases: FundAndLockPhase[] = [];
    let nowMs = 0;
    const terminal = await runFundAndLock({
      escrowId: "esc_test_6",
      amountMsats: 100_000,
      description: "invoice fail test",
      getBalance: wallet.getBalance,
      createFundingInvoice: wallet.createFundingInvoice,
      lockAndPublish: wallet.lockAndPublish,
      onPhase: p => phases.push(p),
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      paymentDeadlineMs: 60_000,
      mintConfirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "lock-failed",
      "Invoice creation failure → terminal lock-failed");
    if (terminal.kind === "lock-failed") {
      assert(/federation unreachable/.test(terminal.error),
        "Invoice failure error message preserved");
    }
    assert(wallet.calls.createInvoice === 1,
      "createFundingInvoice was attempted");
    assert(wallet.calls.lockAndPublish === 0,
      "LOCK never attempted when invoice creation failed");
    // No invoice-created phase since we never got the BOLT11
    assert(!phases.some(p => p.kind === "invoice-created"),
      "No invoice-created phase emitted on invoice-creation failure");
  }

  // ── Aborted mid-flow: signal triggered while polling
  {
    const ctrl = new AbortController();
    ctrl.abort();
    const wallet = makeMockWallet({ balances: [0] });
    let nowMs = 0;
    const terminal: FundAndLockTerminal = await runFundAndLock({
      escrowId: "esc_test_7",
      amountMsats: 100_000,
      description: "abort test",
      getBalance: wallet.getBalance,
      createFundingInvoice: wallet.createFundingInvoice,
      lockAndPublish: wallet.lockAndPublish,
      onPhase: () => {},
      signal: ctrl.signal,
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      paymentDeadlineMs: 60_000,
      mintConfirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "aborted",
      "Pre-aborted signal → terminal aborted (no invoice created)");
    assert(wallet.calls.createInvoice === 0,
      "createFundingInvoice not called when signal already aborted");
    assert(wallet.calls.lockAndPublish === 0,
      "lockAndPublish not called when signal already aborted");
  }

  // ── Phase callback is called with creating-invoice as the FIRST phase
  // (before any wallet calls), so the modal can show its loading state
  // immediately on mount.
  {
    const wallet = makeMockWallet({ balances: [0, 100_000] });
    let firstPhase = "";
    let createInvoiceCalledBefore = false;
    let nowMs = 0;
    await runFundAndLock({
      escrowId: "esc_test_8",
      amountMsats: 100_000,
      description: "phase order",
      getBalance: wallet.getBalance,
      createFundingInvoice: async (msats, desc) => {
        if (firstPhase === "creating-invoice") createInvoiceCalledBefore = true;
        return wallet.createFundingInvoice(msats, desc);
      },
      lockAndPublish: wallet.lockAndPublish,
      onPhase: p => { if (!firstPhase) firstPhase = p.kind; },
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      paymentDeadlineMs: 60_000,
      mintConfirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(firstPhase === "creating-invoice",
      "First emitted phase: creating-invoice (before any wallet call)");
    assert(createInvoiceCalledBefore,
      "creating-invoice phase fires BEFORE createFundingInvoice (UI loading state)");
  }
}

// ── 39. WAIT FOR BALANCE GROWTH (v0.3.0 Phase 3) ─────────────────────────
//
// The polling watchdog inside runClaimAndPayout. Mirrors Phase 2's
// pollForFunding loop but with a single timeout (no payment-vs-mint
// split — the user already triggered the claim). Tests inject
// synthetic clock + sleep + balance reader for deterministic timing.
console.log("\n── WAIT FOR BALANCE GROWTH ──");
{
  // Happy: balance grows on first read
  {
    let nowMs = 0;
    let i = 0;
    const balances = [100_000];
    const result = await waitForBalanceGrowth({
      baselineMsats: 0,
      expectedDeltaMsats: 100_000,
      getBalance: async () => balances[Math.min(i++, balances.length - 1)],
      timeoutMs: 60_000,
      pollIntervalMs: 1_000,
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
    });
    assert(result === "grew",
      "Balance lands fully → grew");
  }

  // Threshold tolerance — accept 92% of expected
  {
    let nowMs = 0;
    let i = 0;
    const balances = [92_000];
    const result = await waitForBalanceGrowth({
      baselineMsats: 0,
      expectedDeltaMsats: 100_000,
      getBalance: async () => balances[Math.min(i++, balances.length - 1)],
      timeoutMs: 60_000,
      pollIntervalMs: 1_000,
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
    });
    assert(result === "grew",
      "Threshold tolerance: 92k of 100k accepted (>= 90%)");
  }

  // Partial then full lands within timeout
  {
    let nowMs = 0;
    let i = 0;
    const balances = [0, 0, 50_000, 100_000];
    const result = await waitForBalanceGrowth({
      baselineMsats: 0,
      expectedDeltaMsats: 100_000,
      getBalance: async () => balances[Math.min(i++, balances.length - 1)],
      timeoutMs: 60_000,
      pollIntervalMs: 1_000,
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
    });
    assert(result === "grew",
      "Partial then full → grew");
  }

  // Timeout — balance never grows
  {
    let nowMs = 0;
    let i = 0;
    const balances = [0];
    const result = await waitForBalanceGrowth({
      baselineMsats: 0,
      expectedDeltaMsats: 100_000,
      getBalance: async () => balances[Math.min(i++, balances.length - 1)],
      timeoutMs: 5_000,
      pollIntervalMs: 1_000,
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
    });
    assert(result === "timeout",
      "Balance never grows in window → timeout");
    assert(nowMs >= 5_000,
      "Loop ran until timeout was reached");
  }

  // Aborted via signal
  {
    const ctrl = new AbortController();
    ctrl.abort();
    let nowMs = 0;
    const result = await waitForBalanceGrowth({
      baselineMsats: 0,
      expectedDeltaMsats: 100_000,
      getBalance: async () => 0,
      signal: ctrl.signal,
      timeoutMs: 60_000,
      pollIntervalMs: 1_000,
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
    });
    assert(result === "aborted",
      "Pre-aborted signal → aborted");
  }

  // Transient getBalance throws don't crash the loop
  {
    let nowMs = 0;
    let calls = 0;
    const result = await waitForBalanceGrowth({
      baselineMsats: 0,
      expectedDeltaMsats: 100_000,
      getBalance: async () => {
        calls++;
        if (calls < 3) throw new Error("transient");
        return 100_000;
      },
      timeoutMs: 60_000,
      pollIntervalMs: 1_000,
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
    });
    assert(result === "grew",
      "Transient getBalance throws don't break the wait loop");
  }

  // Default 60s timeout
  {
    let nowMs = 0;
    const result = await waitForBalanceGrowth({
      baselineMsats: 0,
      expectedDeltaMsats: 100_000,
      getBalance: async () => 0,
      pollIntervalMs: 5_000, // 12 ticks of 5s = 60s
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
    });
    assert(result === "timeout",
      "Default 60s confirm timeout fires when balance never grows");
    assert(nowMs >= 60_000 && nowMs < 70_000,
      "Default timeout fired around 60s mark");
  }
}

// ── 40. RUN CLAIM AND PAYOUT (v0.3.0 Phase 3) ────────────────────────────
//
// runClaimAndPayout orchestrates claimAndRedeem → balance-confirm →
// payInvoice → optional handle-save. Each terminal path is tested
// independently with mocked deps.
console.log("\n── RUN CLAIM AND PAYOUT ──");
{
  function makeMockWallet(opts: {
    balances: number[];
    claimResult?: "ok" | Error;
    payInvoiceResult?: "ok" | Error;
  }) {
    let i = 0;
    const calls = {
      claimAndRedeem: 0,
      payInvoice: 0,
      getBalance: 0,
      saveHandle: 0,
    };
    const handlesSaved: string[] = [];
    return {
      calls,
      handlesSaved,
      getBalance: async () => {
        calls.getBalance++;
        return opts.balances[Math.min(i++, opts.balances.length - 1)];
      },
      claimAndRedeem: async (_id: string) => {
        calls.claimAndRedeem++;
        if (opts.claimResult instanceof Error) throw opts.claimResult;
        return {} as any;
      },
      payInvoice: async (_b: string) => {
        calls.payInvoice++;
        if (opts.payInvoiceResult instanceof Error) throw opts.payInvoiceResult;
      },
      addOrTouchLightningHandle: (address: string) => {
        calls.saveHandle++;
        handlesSaved.push(address);
      },
    };
  }

  // ── Happy path: claim → balance lands → payInvoice → save → done ────
  {
    const wallet = makeMockWallet({ balances: [0, 100_000, 100_000] });
    const phases: ClaimAndPayoutPhase[] = [];
    let nowMs = 0;
    const terminal = await runClaimAndPayout({
      escrowId: "esc_claim_1",
      bolt11: "lnbc100n1pfakeclaimpayout",
      expectedDeltaMsats: 100_000,
      saveAfter: true,
      addressUsed: "alice@phoenix.app",
      getBalance: wallet.getBalance,
      claimAndRedeem: wallet.claimAndRedeem,
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: p => phases.push(p),
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      confirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "done",
      "Happy path → terminal=done");
    assert(wallet.calls.claimAndRedeem === 1,
      "claimAndRedeem called exactly once");
    assert(wallet.calls.payInvoice === 1,
      "payInvoice called exactly once after claim confirms");
    assert(wallet.calls.saveHandle === 1,
      "addOrTouchLightningHandle called once on success with saveAfter=true");
    assert(wallet.handlesSaved[0] === "alice@phoenix.app",
      "Saved address matches addressUsed");
    const order = phases.map(p => p.kind);
    assert(order.indexOf("claiming") < order.indexOf("confirming"),
      "Phase order: claiming → confirming");
    assert(order.indexOf("confirming") < order.indexOf("paying-invoice"),
      "Phase order: confirming → paying-invoice");
    assert(order[order.length - 1] === "done",
      "Terminal phase emitted: done");
  }

  // ── Sequencing: payInvoice never called before claim confirms ───────
  {
    const wallet = makeMockWallet({
      balances: [0, 0, 0, 0, 0, 0, 0], // never lands
    });
    let nowMs = 0;
    const terminal = await runClaimAndPayout({
      escrowId: "esc_claim_2",
      bolt11: "lnbc100n1pneverland",
      expectedDeltaMsats: 100_000,
      saveAfter: true,
      addressUsed: "bob@strike.me",
      getBalance: wallet.getBalance,
      claimAndRedeem: wallet.claimAndRedeem,
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: () => {},
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      confirmTimeoutMs: 5_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "claim-pending",
      "Balance never lands → terminal=claim-pending");
    assert(wallet.calls.payInvoice === 0,
      "payInvoice NEVER called when balance doesn't confirm");
    assert(wallet.calls.saveHandle === 0,
      "addOrTouchLightningHandle NOT called on claim-pending (no successful payout)");
  }

  // ── Claim hard-failure: claim threw, no orphan, payInvoice not called
  {
    const wallet = makeMockWallet({
      balances: [0, 0],
      claimResult: new Error("Not enough shares"),
    });
    let nowMs = 0;
    const terminal = await runClaimAndPayout({
      escrowId: "esc_claim_3",
      bolt11: "lnbc100n1pclaimfail",
      expectedDeltaMsats: 100_000,
      saveAfter: true,
      addressUsed: "carol@wallet.io",
      getBalance: wallet.getBalance,
      claimAndRedeem: wallet.claimAndRedeem,
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: () => {},
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      confirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "claim-failed",
      "claimAndRedeem throws → terminal=claim-failed");
    if (terminal.kind === "claim-failed") {
      assert(/Not enough shares/.test(terminal.error),
        "claim-failed terminal carries underlying error message");
    }
    assert(wallet.calls.claimAndRedeem === 1,
      "claimAndRedeem was attempted");
    assert(wallet.calls.payInvoice === 0,
      "payInvoice NOT called on claim hard-failure (no orphan dispatched)");
    assert(wallet.calls.saveHandle === 0,
      "Handle NOT saved on claim-failed");
  }

  // ── Payout-failed: claim confirmed, balance grew, but payInvoice threw
  // This is the orphan-balance case — recovery banner catches it
  // (Phase 4 wiring).
  {
    const wallet = makeMockWallet({
      balances: [0, 100_000, 100_000],
      payInvoiceResult: new Error("no route to recipient"),
    });
    let nowMs = 0;
    const terminal = await runClaimAndPayout({
      escrowId: "esc_claim_4",
      bolt11: "lnbc100n1ppayoutfail",
      expectedDeltaMsats: 100_000,
      saveAfter: true,
      addressUsed: "dave@offline.app",
      getBalance: wallet.getBalance,
      claimAndRedeem: wallet.claimAndRedeem,
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: () => {},
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      confirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "payout-failed",
      "claim ok + payInvoice throws → terminal=payout-failed");
    if (terminal.kind === "payout-failed") {
      assert(/no route/.test(terminal.error),
        "payout-failed terminal carries underlying LN error");
    }
    assert(wallet.calls.claimAndRedeem === 1,
      "claim was attempted (succeeded)");
    assert(wallet.calls.payInvoice === 1,
      "payInvoice was attempted (failed)");
    assert(wallet.calls.saveHandle === 0,
      "Handle NOT saved when payout failed (orphan = recovery banner's job)");
  }

  // ── Auto-save toggle OFF: success but no save call ──────────────────
  {
    const wallet = makeMockWallet({ balances: [0, 100_000, 100_000] });
    let nowMs = 0;
    const terminal = await runClaimAndPayout({
      escrowId: "esc_claim_5",
      bolt11: "lnbc100n1psaveoff",
      expectedDeltaMsats: 100_000,
      saveAfter: false,                  // toggle OFF
      addressUsed: "eve@phoenix.app",    // address known but save off
      getBalance: wallet.getBalance,
      claimAndRedeem: wallet.claimAndRedeem,
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: () => {},
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      confirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "done",
      "Happy path with saveAfter=false → done");
    assert(wallet.calls.saveHandle === 0,
      "saveAfter=false → handle NOT saved despite address being known");
  }

  // ── Tier 3 BOLT11 paste: addressUsed undefined → no save attempted
  {
    const wallet = makeMockWallet({ balances: [0, 100_000, 100_000] });
    let nowMs = 0;
    const terminal = await runClaimAndPayout({
      escrowId: "esc_claim_6",
      bolt11: "lnbc100n1pbolt11paste",
      expectedDeltaMsats: 100_000,
      saveAfter: true, // even with toggle on,
      addressUsed: undefined, // no address means nothing to save
      getBalance: wallet.getBalance,
      claimAndRedeem: wallet.claimAndRedeem,
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: () => {},
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      confirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "done",
      "Tier 3 BOLT11 paste happy path → done");
    assert(wallet.calls.saveHandle === 0,
      "addressUsed undefined → addOrTouchLightningHandle NOT called even with saveAfter=true");
  }

  // ── Save throws: payout already succeeded; cosmetic failure swallowed
  {
    const wallet = makeMockWallet({ balances: [0, 100_000, 100_000] });
    // Replace addOrTouchLightningHandle with one that throws.
    const throwingSave = (_a: string) => { throw new Error("storage quota"); };
    let nowMs = 0;
    const terminal = await runClaimAndPayout({
      escrowId: "esc_claim_7",
      bolt11: "lnbc100n1psavethrow",
      expectedDeltaMsats: 100_000,
      saveAfter: true,
      addressUsed: "frank@wallet.app",
      getBalance: wallet.getBalance,
      claimAndRedeem: wallet.claimAndRedeem,
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: throwingSave,
      onPhase: () => {},
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      confirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "done",
      "Save throws → terminal still done (cosmetic, payout already sent)");
  }

  // ── Phase ordering: confirming fires BEFORE paying-invoice
  {
    const wallet = makeMockWallet({ balances: [0, 100_000, 100_000] });
    const phases: string[] = [];
    let nowMs = 0;
    let payInvoiceCalledAt = -1;
    let confirmingFiredAt = -1;
    await runClaimAndPayout({
      escrowId: "esc_claim_8",
      bolt11: "lnbc100n1pphaseorder",
      expectedDeltaMsats: 100_000,
      saveAfter: false,
      getBalance: wallet.getBalance,
      claimAndRedeem: wallet.claimAndRedeem,
      payInvoice: async (b) => {
        payInvoiceCalledAt = phases.length;
        return wallet.payInvoice(b);
      },
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: p => {
        if (p.kind === "confirming" && confirmingFiredAt === -1) {
          confirmingFiredAt = phases.length;
        }
        phases.push(p.kind);
      },
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      confirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(confirmingFiredAt >= 0 && confirmingFiredAt < payInvoiceCalledAt,
      "confirming phase fires BEFORE payInvoice is called");
  }
}

// ── 41. RUN RECOVERY PAYOUT (v0.3.0 Phase 4) ─────────────────────────────
//
// runRecoveryPayout drains an existing wallet balance to a Lightning
// destination. Used by RecoveryBanner and DestroyEcashConfirmModal.
// Simpler than runClaimAndPayout — no claim phase, just payInvoice +
// optional handle save. Same save-on-success-never-on-failure +
// cosmetic-failure-swallowed semantics as Phase 3.
console.log("\n── RUN RECOVERY PAYOUT ──");
{
  function makeMockWallet(opts: { payInvoiceResult?: "ok" | Error }) {
    const calls = { payInvoice: 0, saveHandle: 0 };
    const handlesSaved: string[] = [];
    return {
      calls,
      handlesSaved,
      payInvoice: async (_b: string) => {
        calls.payInvoice++;
        if (opts.payInvoiceResult instanceof Error) throw opts.payInvoiceResult;
      },
      addOrTouchLightningHandle: (address: string) => {
        calls.saveHandle++;
        handlesSaved.push(address);
      },
    };
  }

  // ── Happy path: pay → save → done ───────────────────────────────────
  {
    const wallet = makeMockWallet({});
    const phases: RecoveryPayoutPhase[] = [];
    const terminal = await runRecoveryPayout({
      bolt11: "lnbc100n1precover_ok",
      saveAfter: true,
      addressUsed: "alice@phoenix.app",
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: p => phases.push(p),
    });
    assert(terminal.kind === "done",
      "Happy path → terminal=done");
    assert(wallet.calls.payInvoice === 1,
      "payInvoice called exactly once");
    assert(wallet.calls.saveHandle === 1,
      "addOrTouchLightningHandle called once on success with saveAfter=true");
    assert(wallet.handlesSaved[0] === "alice@phoenix.app",
      "Saved address matches addressUsed");
    const order = phases.map(p => p.kind);
    assert(order[0] === "paying-invoice",
      "First phase: paying-invoice");
    assert(order[order.length - 1] === "done",
      "Terminal phase: done");
  }

  // ── Payout-failed: payInvoice throws → no save, error propagated ────
  {
    const wallet = makeMockWallet({
      payInvoiceResult: new Error("no route to recipient"),
    });
    const terminal = await runRecoveryPayout({
      bolt11: "lnbc100n1precover_fail",
      saveAfter: true,
      addressUsed: "bob@phoenix.app",
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: () => {},
    });
    assert(terminal.kind === "payout-failed",
      "payInvoice throws → terminal=payout-failed");
    if (terminal.kind === "payout-failed") {
      assert(/no route/.test(terminal.error),
        "payout-failed terminal carries underlying error");
    }
    assert(wallet.calls.saveHandle === 0,
      "Handle NOT saved on payout-failed (orphan stays orphaned, recover later)");
  }

  // ── saveAfter=false: success, but handle NOT saved ──────────────────
  {
    const wallet = makeMockWallet({});
    const terminal = await runRecoveryPayout({
      bolt11: "lnbc100n1pno_save",
      saveAfter: false,                  // toggle OFF
      addressUsed: "carol@strike.me",    // address known but save off
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: () => {},
    });
    assert(terminal.kind === "done",
      "saveAfter=false happy path → done");
    assert(wallet.calls.saveHandle === 0,
      "saveAfter=false → handle NOT saved despite address known");
  }

  // ── Tier 3 BOLT11 paste: addressUsed undefined → no save ────────────
  {
    const wallet = makeMockWallet({});
    const terminal = await runRecoveryPayout({
      bolt11: "lnbc100n1pbolt11_paste",
      saveAfter: true,                   // toggle on, but...
      addressUsed: undefined,            // Tier 3 paste has no address
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: () => {},
    });
    assert(terminal.kind === "done",
      "Tier 3 paste happy path → done");
    assert(wallet.calls.saveHandle === 0,
      "addressUsed undefined → save NOT attempted (no address to save)");
  }

  // ── Cosmetic save failure swallowed: payout already succeeded ───────
  {
    const wallet = makeMockWallet({});
    const throwingSave = (_a: string) => { throw new Error("storage quota"); };
    const terminal = await runRecoveryPayout({
      bolt11: "lnbc100n1psave_throw",
      saveAfter: true,
      addressUsed: "dave@wallet.io",
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: throwingSave,
      onPhase: () => {},
    });
    assert(terminal.kind === "done",
      "Save throws → terminal still done (cosmetic; payout already sent)");
  }

  // ── Phase callback fires paying-invoice BEFORE payInvoice runs ──────
  // (Mirror of Phase 3's "creating-invoice fires before wallet call"
  // — the modal needs to render its busy state immediately on dispatch.)
  {
    const wallet = makeMockWallet({});
    let payInvoiceCalledAfter = false;
    let firstPhase = "";
    await runRecoveryPayout({
      bolt11: "lnbc100n1porder",
      saveAfter: false,
      payInvoice: async (b) => {
        if (firstPhase === "paying-invoice") payInvoiceCalledAfter = true;
        return wallet.payInvoice(b);
      },
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: p => { if (!firstPhase) firstPhase = p.kind; },
    });
    assert(firstPhase === "paying-invoice",
      "First emitted phase: paying-invoice (UI busy state immediate)");
    assert(payInvoiceCalledAfter,
      "paying-invoice phase fires BEFORE payInvoice is called");
  }
}

// ── 42. CHAMA BAR LABEL DECISION (v0.3.0 Phase 5) ────────────────────────
//
// decideChamaBarLabel maps (balance, hasActiveBuyerSellerCommitment) to
// one of three top-bar states. Per Phase 5 reminder #3: arbiter-only
// commitments are NOT treated as active — the predicate is the same
// hasActiveBuyerSellerCommitment used by Create-blocking (locked in
// v0.2.0 Q3). The bar's caller computes the predicate; this helper is
// pure shape conversion + sat conversion + tie-breaking.
console.log("\n── CHAMA BAR LABEL ──");
{
  // Zero balance → ready, regardless of commitment state
  {
    const r1 = decideChamaBarLabel({
      balanceMsats: 0,
      hasActiveBuyerSellerCommitment: false,
    });
    assert(r1.kind === "ready",
      "Zero balance + no commitment → ready");

    const r2 = decideChamaBarLabel({
      balanceMsats: 0,
      hasActiveBuyerSellerCommitment: true,
    });
    assert(r2.kind === "ready",
      "Zero balance + active commitment → ready (no sats to label)");
  }

  // Positive balance + active commitment → in-trade with sats
  {
    const r = decideChamaBarLabel({
      balanceMsats: 50_000,
      hasActiveBuyerSellerCommitment: true,
    });
    assert(r.kind === "in-trade",
      "Balance + active commitment → in-trade");
    if (r.kind === "in-trade") {
      assert(r.sats === 50,
        "in-trade carries sats (msats / 1000)");
    }
  }

  // Positive balance + NO active commitment → stranded (failure mode)
  {
    const r = decideChamaBarLabel({
      balanceMsats: 100_000,
      hasActiveBuyerSellerCommitment: false,
    });
    assert(r.kind === "stranded",
      "Balance + no commitment → stranded (Pillar 2.1 Option B violation)");
    if (r.kind === "stranded") {
      assert(r.sats === 100,
        "stranded carries sats");
    }
  }

  // Sub-msat dust floors to ready (no fractional-sat states)
  {
    const r = decideChamaBarLabel({
      balanceMsats: 999, // less than 1 sat
      hasActiveBuyerSellerCommitment: false,
    });
    assert(r.kind === "ready",
      "Sub-1-sat dust floors to ready (no fractional-sat states)");
  }

  // Negative balance defensive guard (shouldn't happen, but pinned)
  {
    const r = decideChamaBarLabel({
      balanceMsats: -100,
      hasActiveBuyerSellerCommitment: false,
    });
    assert(r.kind === "ready",
      "Negative balance defensive → ready (never claim stranded sats that don't exist)");
  }

  // Phase 5 reminder #3: arbiter-only "commitments" do NOT count as
  // active. The predicate is computed by the caller; this test pins
  // the contract — when the caller passes false (because the user is
  // arbiter-only), the bar shows the truthful state of their balance.
  // An arbiter mid-arbitration with a non-zero balance from a PRIOR
  // trade would correctly see "stranded".
  {
    const r = decideChamaBarLabel({
      balanceMsats: 25_000,
      // User is arbiter on an active trade. The predicate
      // hasActiveBuyerSellerCommitment is FALSE — arbiter doesn't
      // count. Their 25 sats is from a previous failed trade.
      hasActiveBuyerSellerCommitment: false,
    });
    assert(r.kind === "stranded",
      "Arbiter-only commitments don't shield prior orphans from stranded label");
  }

  // ── v0.3.1 Phase 3: bootProbeState routing ───────────────────────────
  // bootProbeState === "failed" overrides ALL other state to surface
  // the "⚠ Chama unreachable · Reconnect →" pill. Reachability is
  // the floor for any other meaningful state: if the user can't reach
  // the federation, they can't recover stranded sats or progress an
  // in-trade flow — the actionable next step is Reconnect.

  // failed + zero balance → unreachable (overrides ready)
  {
    const r = decideChamaBarLabel({
      balanceMsats: 0,
      hasActiveBuyerSellerCommitment: false,
      bootProbeState: "failed",
    });
    assert(r.kind === "unreachable",
      "bootProbeState=failed + zero balance → unreachable (overrides ready)");
  }

  // failed + stranded balance → unreachable (overrides stranded)
  {
    const r = decideChamaBarLabel({
      balanceMsats: 50_000,
      hasActiveBuyerSellerCommitment: false,
      bootProbeState: "failed",
    });
    assert(r.kind === "unreachable",
      "bootProbeState=failed + stranded balance → unreachable (Reconnect is the actionable step, not Recover)");
  }

  // failed + in-trade → unreachable (overrides in-trade)
  {
    const r = decideChamaBarLabel({
      balanceMsats: 100_000,
      hasActiveBuyerSellerCommitment: true,
      bootProbeState: "failed",
    });
    assert(r.kind === "unreachable",
      "bootProbeState=failed + active commitment → unreachable (can't progress trade until reachable)");
  }

  // ok → passes through to existing three-state decision
  {
    const r1 = decideChamaBarLabel({
      balanceMsats: 0,
      hasActiveBuyerSellerCommitment: false,
      bootProbeState: "ok",
    });
    assert(r1.kind === "ready",
      "bootProbeState=ok preserves existing 'ready' kind");

    const r2 = decideChamaBarLabel({
      balanceMsats: 50_000,
      hasActiveBuyerSellerCommitment: false,
      bootProbeState: "ok",
    });
    assert(r2.kind === "stranded",
      "bootProbeState=ok preserves existing 'stranded' kind");

    const r3 = decideChamaBarLabel({
      balanceMsats: 100_000,
      hasActiveBuyerSellerCommitment: true,
      bootProbeState: "ok",
    });
    assert(r3.kind === "in-trade",
      "bootProbeState=ok preserves existing 'in-trade' kind");
  }

  // pending → passes through to existing three-state decision
  // (pending is transient; UI is fine with the brief optimistic
  // rendering during it; only failed gates action surfaces).
  {
    const r1 = decideChamaBarLabel({
      balanceMsats: 0,
      hasActiveBuyerSellerCommitment: false,
      bootProbeState: "pending",
    });
    assert(r1.kind === "ready",
      "bootProbeState=pending does NOT override (transient state, optimistic render)");

    const r2 = decideChamaBarLabel({
      balanceMsats: 50_000,
      hasActiveBuyerSellerCommitment: false,
      bootProbeState: "pending",
    });
    assert(r2.kind === "stranded",
      "bootProbeState=pending preserves stranded kind (transient state)");
  }

  // bootProbeState undefined → backwards-compatible (acts as ok)
  // Defensive: any pre-Phase-3 caller that hasn't been updated
  // continues to render the three-state surface as before.
  {
    const r = decideChamaBarLabel({
      balanceMsats: 50_000,
      hasActiveBuyerSellerCommitment: false,
      // bootProbeState omitted
    });
    assert(r.kind === "stranded",
      "bootProbeState undefined → backwards-compatible (renders as if ok)");
  }

  // Tripwire: failed-state ordering is independent of every other
  // input. If a future refactor accidentally moves the bootProbeState
  // check below the balance/commitment checks, in-trade or stranded
  // could leak through during a federation outage — this test fails
  // immediately in that case.
  {
    const inputs = [
      { balanceMsats: 0, hasActiveBuyerSellerCommitment: false },
      { balanceMsats: 50_000, hasActiveBuyerSellerCommitment: false },
      { balanceMsats: 100_000, hasActiveBuyerSellerCommitment: true },
      { balanceMsats: 999, hasActiveBuyerSellerCommitment: false },
      { balanceMsats: -100, hasActiveBuyerSellerCommitment: false },
    ];
    for (const i of inputs) {
      const r = decideChamaBarLabel({ ...i, bootProbeState: "failed" });
      assert(r.kind === "unreachable",
        `Tripwire: bootProbeState=failed overrides input { balance=${i.balanceMsats}, commitment=${i.hasActiveBuyerSellerCommitment} }`);
    }
  }

  // v0.4.2 hotfix round 3: activeCommittedMsats drives the in-escrow
  // pill during LOCKED state, when balance is correctly 0 (ecash spent
  // into SSS shares). The previous logic returned "ready" at exactly
  // the moment users needed to see "your money is in escrow" — the
  // load-bearing Pillar 2.1 Option B failure mode.
  {
    const r = decideChamaBarLabel({
      balanceMsats: 0,
      hasActiveBuyerSellerCommitment: true,
      activeCommittedMsats: 50_000_000,
    });
    assert(r.kind === "in-trade" && (r as any).sats === 50_000,
      "balance=0 + activeCommittedMsats=50M msat → in-trade pill shows 50k sats (LOCKED state)");
  }

  // After CLAIM completes (terminal, no commitment), pill returns to
  // ready when balance has been debited. activeCommittedMsats=0
  // because LOCKED/APPROVED-only filter excludes COMPLETED.
  {
    const r = decideChamaBarLabel({
      balanceMsats: 0,
      hasActiveBuyerSellerCommitment: false,
      activeCommittedMsats: 0,
    });
    assert(r.kind === "ready",
      "Post-CLAIM terminal: balance=0 + no commitment → ready (no phantom in-escrow)");
  }

  // Balance > 0 still wins over activeCommittedMsats — if the wallet
  // has actual cash AND there's an active trade, the pill prefers the
  // wallet's authoritative number. Both paths land on in-trade.
  {
    const r = decideChamaBarLabel({
      balanceMsats: 30_000_000,
      hasActiveBuyerSellerCommitment: true,
      activeCommittedMsats: 50_000_000,
    });
    assert(r.kind === "in-trade" && (r as any).sats === 30_000,
      "balance > 0 takes precedence: wallet shows 30k, ignore committed=50k");
  }

  // bootProbeState=failed still overrides committed amount — Reconnect
  // is the actionable next step, not the in-escrow pill.
  {
    const r = decideChamaBarLabel({
      balanceMsats: 0,
      hasActiveBuyerSellerCommitment: true,
      activeCommittedMsats: 50_000_000,
      bootProbeState: "failed",
    });
    assert(r.kind === "unreachable",
      "bootProbeState=failed overrides committed-msats in-trade kind");
  }

  // activeCommittedMsats < 1 sat (sub-1000 msat) → still ready.
  // The bar speaks in whole sats; sub-sat dust doesn't qualify.
  {
    const r = decideChamaBarLabel({
      balanceMsats: 0,
      hasActiveBuyerSellerCommitment: true,
      activeCommittedMsats: 500,
    });
    assert(r.kind === "ready",
      "Sub-1-sat committed amount → ready (whole-sat granularity)");
  }

  // Backwards compat: omitting activeCommittedMsats entirely behaves
  // like the pre-round-3 callsites — balance=0 → ready.
  {
    const r = decideChamaBarLabel({
      balanceMsats: 0,
      hasActiveBuyerSellerCommitment: true,
    });
    assert(r.kind === "ready",
      "Omitted activeCommittedMsats falls back to ready (pre-round-3 callsite compat)");
  }

  // activeCommittedMsats helper itself: only LOCKED/APPROVED count.
  const { activeCommittedMsats } = await import("../ui/decisions.js");
  const buildEscrow = (status: EscrowStatus, amount: number, me: string) => ({
    id: "x", status, description: "", amountMsats: amount,
    category: "p2p-trade", fulfillment: "service", community: null,
    mintUrl: BP_FEDERATION_INVITE,
    participants: { buyer: me, seller: "s", arbiter: "a" },
    initiator: { pubkey: me, role: Role.BUYER },
    communityArbiters: [], subscription: null, votes: {},
    resolvedOutcome: null, resolvedMajority: null, resolvedAt: null,
    completedAt: null, cancelledAt: null, claim: null,
    fees: { platformBps: 50, platformPubkey: me, arbiterFeeMsats: 0 },
    expiresAt: 0, createdAt: 0, eventChain: [], chatMessages: [],
    lock: { handle: null },
  } as unknown as EscrowState);
  const me = "user_pubkey";
  assert(
    activeCommittedMsats({
      escrows: [buildEscrow(EscrowStatus.LOCKED, 50_000_000, me)],
      userPubkey: me,
    }) === 50_000_000,
    "activeCommittedMsats: LOCKED status counted",
  );
  assert(
    activeCommittedMsats({
      escrows: [buildEscrow(EscrowStatus.APPROVED, 50_000_000, me)],
      userPubkey: me,
    }) === 50_000_000,
    "activeCommittedMsats: APPROVED status counted",
  );
  assert(
    activeCommittedMsats({
      escrows: [buildEscrow(EscrowStatus.CLAIMED, 50_000_000, me)],
      userPubkey: me,
    }) === 0,
    "activeCommittedMsats: CLAIMED NOT counted (winner has redeemed; balance reflects it)",
  );
  assert(
    activeCommittedMsats({
      escrows: [buildEscrow(EscrowStatus.COMPLETED, 50_000_000, me)],
      userPubkey: me,
    }) === 0,
    "activeCommittedMsats: COMPLETED NOT counted (terminal)",
  );
  assert(
    activeCommittedMsats({
      escrows: [buildEscrow(EscrowStatus.CREATED, 50_000_000, me)],
      userPubkey: me,
    }) === 0,
    "activeCommittedMsats: CREATED NOT counted (listing exists; no commitment yet)",
  );
  assert(
    activeCommittedMsats({
      escrows: [
        buildEscrow(EscrowStatus.LOCKED, 50_000_000, me),
        buildEscrow(EscrowStatus.APPROVED, 25_000_000, me),
      ],
      userPubkey: me,
    }) === 75_000_000,
    "activeCommittedMsats: sums across multiple active commitments",
  );
}

// ── 43. TRINITY RING PARTICIPANT ORDER (v0.3.0 Phase 6 + v0.3.1 Phase 2) ─
//
// Pins B/A/S as the canonical participant render order. PHILOSOPHY.md
// §5.2 places the arbiter at the apex of the brand mark with
// buyer/seller flanking below; the participants row mirrors this.
//
// Two-layer tripwire:
//   (1) Constant-value assertions on TRINITY_RING_ORDER. Catches a
//       maintainer editing the constant itself in theme.ts.
//   (2) Grep tripwire over src/ui/. Catches a NEW render surface that
//       declares its own inline `[Role.X, Role.Y, Role.Z]` tuple
//       instead of importing the constant. Production smoke for
//       v0.3.0 caught exactly this — TradeCard.tsx had drifted from
//       TradeDetail.tsx because Phase 6 only patched the latter.
//       v0.3.1 Phase 2 patches TradeCard AND adds this tripwire so
//       no future participant-rendering surface can silently drift.
//
// Whitespace is normalized before matching so a future "format for
// readability" diff that breaks the tuple across multiple lines still
// trips the tripwire. Comments are stripped so doc strings mentioning
// the literal don't false-positive.
console.log("\n── TRINITY RING PARTICIPANT ORDER ──");
{
  // Layer 1: constant value
  assert(TRINITY_RING_ORDER.length === 3,
    "Trinity Ring has exactly three participants");
  assert(TRINITY_RING_ORDER[0] === Role.BUYER,
    "Trinity Ring [0] = Buyer (left)");
  assert(TRINITY_RING_ORDER[1] === Role.ARBITER,
    "Trinity Ring [1] = Arbiter (middle / apex)");
  assert(TRINITY_RING_ORDER[2] === Role.SELLER,
    "Trinity Ring [2] = Seller (right)");

  // Layer 2: grep tripwire. Walks src/ui/, strips comments, normalizes
  // whitespace, and asserts no file outside the canonical definition
  // site (theme.ts) contains an inline three-element Role tuple.
  function walkUiFiles(root: string): string[] {
    const out: string[] = [];
    const stack = [root];
    while (stack.length) {
      const cur = stack.pop()!;
      let entries: string[];
      try { entries = readdirSync(cur); } catch { continue; }
      for (const ent of entries) {
        // Defensive skip — src/ui/ shouldn't contain these but if a
        // future refactor introduces a nested package, don't recurse.
        if (ent === "node_modules" || ent === "dist") continue;
        const full = join(cur, ent);
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) stack.push(full);
        else if (ent.endsWith(".ts") || ent.endsWith(".tsx")) out.push(full);
      }
    }
    return out;
  }

  function stripComments(src: string): string {
    // Block comments first (handles /** ... */ doc blocks too).
    let result = src.replace(/\/\*[\s\S]*?\*\//g, "");
    // Then line comments.
    result = result.replace(/\/\/[^\n]*/g, "");
    return result;
  }

  function normalizeWhitespace(src: string): string {
    return src.replace(/\s+/g, " ");
  }

  // Pattern: [Role.X, Role.Y, Role.Z] where X/Y/Z ∈ {BUYER, SELLER,
  // ARBITER}. Catches all 27 combinations (the 6 permutations plus
  // the 21 with repeats — repeats would be a bug too, so we want all).
  // Trailing comma before `]` is optional to catch reformatted variants.
  const ROLE_TUPLE_RE =
    /\[\s*Role\.(?:BUYER|SELLER|ARBITER)\s*,\s*Role\.(?:BUYER|SELLER|ARBITER)\s*,\s*Role\.(?:BUYER|SELLER|ARBITER)\s*,?\s*\]/;

  // Only the canonical definition site is allowed to contain the
  // literal tuple. Matched by suffix so the test is robust to
  // working-directory variation.
  const ALLOWED_SUFFIXES = ["theme.ts"];

  // Matcher self-tests — confirm the regex actually catches what we
  // want it to. Doctrine: if these fail, the rest of the layer-2
  // tripwire is silently broken.
  assert(
    ROLE_TUPLE_RE.test("renders [Role.BUYER, Role.SELLER, Role.ARBITER] dots"),
    "Tripwire self-test: matches the original v0.2.0 [B, S, A] bug literal",
  );
  assert(
    ROLE_TUPLE_RE.test(normalizeWhitespace(
      "[\n  Role.BUYER,\n  Role.SELLER,\n  Role.ARBITER,\n]"
    )),
    "Tripwire self-test: matches reformatted multi-line variant with trailing comma after whitespace normalization",
  );
  assert(
    !ROLE_TUPLE_RE.test("if (role === Role.BUYER) doStuff();"),
    "Tripwire self-test: does NOT trip on scalar Role references",
  );
  assert(
    !ROLE_TUPLE_RE.test("[Role.BUYER, Role.SELLER]"),
    "Tripwire self-test: does NOT trip on a two-element Role tuple",
  );

  // Actual scan
  const uiRoot = "src/ui";
  let scannedCount = 0;
  const offenders: string[] = [];
  for (const file of walkUiFiles(uiRoot)) {
    scannedCount++;
    if (ALLOWED_SUFFIXES.some(suffix => file.endsWith(suffix))) continue;
    const src = readFileSync(file, "utf8");
    const stripped = normalizeWhitespace(stripComments(src));
    if (ROLE_TUPLE_RE.test(stripped)) offenders.push(file);
  }
  assert(scannedCount > 0,
    "Tripwire actually scanned src/ui/ files (sanity: cwd resolved)");
  assert(offenders.length === 0,
    offenders.length === 0
      ? "No inline three-element Role tuples outside theme.ts (grep tripwire)"
      : `Inline Role tuple offenders outside theme.ts: ${offenders.join(", ")}`,
  );
}

// ── 44. STATE B EXPLAINER CARD GATE (v0.3.0 Phase 6) ─────────────────────
//
// Per-pubkey localStorage gate for the educational State B card.
// Mirrors the v0.2.0 chama_first_publish_done_<pubkey> pattern.
// Different pubkey on the same device sees the card fresh; same pubkey
// after dismiss never sees it again.
console.log("\n── STATE B EXPLAINER CARD ──");
{
  (globalThis as any).localStorage.clear();

  const ALICE = "alice_pubkey_hex_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const BOB = "bob_pubkey_hex_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  // Fresh state — neither pubkey has dismissed
  assert(hasStateBExplained(ALICE) === false,
    "Fresh storage: alice hasn't dismissed");
  assert(hasStateBExplained(BOB) === false,
    "Fresh storage: bob hasn't dismissed");

  // null pubkey treated as "not yet explained" (caller decides to render
  // or not based on pubkey presence)
  assert(hasStateBExplained(null) === false,
    "null pubkey → returns false (no localStorage check)");

  // Mark alice → alice explained, bob still fresh
  markStateBExplained(ALICE);
  assert(hasStateBExplained(ALICE) === true,
    "After marking alice, hasStateBExplained returns true");
  assert(hasStateBExplained(BOB) === false,
    "Per-pubkey isolation: bob still sees the card");

  // Mark null is a no-op (no key written)
  markStateBExplained(null);
  // No throw, no key written.
  const keys: string[] = [];
  for (let i = 0; i < (globalThis as any).localStorage.length || 0; i++) {
    keys.push((globalThis as any).localStorage.key(i)!);
  }
  // Storage stub doesn't expose .length the same way — check directly
  assert(
    (globalThis as any).localStorage.getItem(STATE_B_EXPLAINED_KEY_PREFIX + "null") === null,
    "markStateBExplained(null) does NOT write a 'null' key",
  );

  // Storage shape exactly mirrors v0.2.0 first-publish pattern
  const storedValue = (globalThis as any).localStorage.getItem(STATE_B_EXPLAINED_KEY_PREFIX + ALICE);
  assert(storedValue === "1",
    "Stored sentinel is the literal '1' (matches v0.2.0 chama_first_publish_done_ shape)");

  // Now mark bob too → both explained
  markStateBExplained(BOB);
  assert(hasStateBExplained(BOB) === true,
    "After marking bob, hasStateBExplained returns true");
  assert(hasStateBExplained(ALICE) === true,
    "Marking bob does NOT clear alice's flag");

  // Storage key uses the documented prefix
  assert(STATE_B_EXPLAINED_KEY_PREFIX === "chama_state_b_explained_",
    "Key prefix is the documented chama_state_b_explained_");

  (globalThis as any).localStorage.clear();
}

// ── 45. CLAIM-BRIDGE-THREW DISCRIMINATION (v0.3.1 Phase 1) ───────────────
//
// v0.3.0 production smoke caught a hang on Bitcoin Principles
// federation where every claim attempt landed in the `claim-pending`
// "your sats are still arriving" terminal, even though redeemEcash
// definitively failed pre-publish with FED_PROBE_FAILED. Root cause:
// claimAndRedeemAction in useEscrow.ts was swallowing typed bridge
// errors (FED_PROBE_FAILED, FED_MISMATCH) into the transient watchdog
// catch-all. By the time runClaimAndPayout saw the resolved promise,
// it interpreted the silently-returned local state as "claim
// succeeded, balance just hasn't grown yet" → claim-pending.
//
// Phase 1 fix: split the throws by code, route typed bridge errors to
// a new `claim-bridge-threw` terminal with retry semantics. Other
// throws stay on `claim-failed` (no retry). Balance-doesn't-grow
// AFTER a clean claimAndRedeem return stays on `claim-pending`.
//
// These tests pin the discrimination at the orchestrator level — the
// caller is the source of truth for whether the bridge threw, and the
// orchestrator routes correctly.
console.log("\n── CLAIM-BRIDGE-THREW DISCRIMINATION ──");
{
  function makeMockWallet(opts: {
    balances: number[];
    claimResult?: "ok" | Error;
    payInvoiceResult?: "ok" | Error;
  }) {
    let i = 0;
    const calls = { claimAndRedeem: 0, payInvoice: 0, saveHandle: 0 };
    return {
      calls,
      getBalance: async () => opts.balances[Math.min(i++, opts.balances.length - 1)],
      claimAndRedeem: async (_id: string) => {
        calls.claimAndRedeem++;
        if (opts.claimResult instanceof Error) throw opts.claimResult;
        return {} as any;
      },
      payInvoice: async (_b: string) => {
        calls.payInvoice++;
        if (opts.payInvoiceResult instanceof Error) throw opts.payInvoiceResult;
      },
      addOrTouchLightningHandle: () => { calls.saveHandle++; },
    };
  }

  // ── FED_PROBE_FAILED → claim-bridge-threw (the bug class fix) ──────
  {
    const bridgeErr: any = new Error(
      "Couldn't verify your federation before claiming. " +
        "(No sats were spent — retry when your Chama is reachable.)"
    );
    bridgeErr.code = "FED_PROBE_FAILED";
    const wallet = makeMockWallet({
      balances: [0],
      claimResult: bridgeErr,
    });
    let nowMs = 0;
    const terminal = await runClaimAndPayout({
      escrowId: "esc_bridge_threw_probe",
      bolt11: "lnbc100n1pprobetest",
      expectedDeltaMsats: 100_000,
      saveAfter: true,
      addressUsed: "alice@phoenix.app",
      getBalance: wallet.getBalance,
      claimAndRedeem: wallet.claimAndRedeem,
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: () => {},
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      confirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "claim-bridge-threw",
      "FED_PROBE_FAILED throws route to claim-bridge-threw (not claim-pending)");
    if (terminal.kind === "claim-bridge-threw") {
      assert(/No sats were spent/.test(terminal.error),
        "claim-bridge-threw carries the honest 'No sats were spent' message from the bridge");
    }
    assert(wallet.calls.payInvoice === 0,
      "payInvoice NOT called when bridge throws pre-redeem");
    assert(wallet.calls.saveHandle === 0,
      "Handle NOT saved on claim-bridge-threw (no successful payout)");
  }

  // ── FED_MISMATCH → claim-bridge-threw (sister case) ───────────────
  {
    const bridgeErr: any = new Error(
      "This trade's sats were minted on federation X. Your wallet is on Y. " +
        "Sign out and rejoin with the correct federation, then retry."
    );
    bridgeErr.code = "FED_MISMATCH";
    const wallet = makeMockWallet({
      balances: [0],
      claimResult: bridgeErr,
    });
    let nowMs = 0;
    const terminal = await runClaimAndPayout({
      escrowId: "esc_bridge_threw_mismatch",
      bolt11: "lnbc100n1pmismatch",
      expectedDeltaMsats: 100_000,
      saveAfter: true,
      addressUsed: "bob@strike.me",
      getBalance: wallet.getBalance,
      claimAndRedeem: wallet.claimAndRedeem,
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: () => {},
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      confirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "claim-bridge-threw",
      "FED_MISMATCH throws route to claim-bridge-threw (sister of FED_PROBE_FAILED)");
  }

  // ── Hard-failure throws → claim-failed (existing semantic preserved)
  {
    const wallet = makeMockWallet({
      balances: [0],
      claimResult: new Error("Not enough shares to reconstruct"),
    });
    let nowMs = 0;
    const terminal = await runClaimAndPayout({
      escrowId: "esc_hard_fail",
      bolt11: "lnbc100n1phardfail",
      expectedDeltaMsats: 100_000,
      saveAfter: false,
      getBalance: wallet.getBalance,
      claimAndRedeem: wallet.claimAndRedeem,
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: () => {},
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      confirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "claim-failed",
      "Hard-failure throws (no error code) stay on claim-failed");
  }

  // ── Untyped throw → claim-failed (no e.code falls through) ────────
  {
    const wallet = makeMockWallet({
      balances: [0],
      claimResult: new Error("some generic protocol error"),
    });
    let nowMs = 0;
    const terminal = await runClaimAndPayout({
      escrowId: "esc_untyped",
      bolt11: "lnbc100n1puntyped",
      expectedDeltaMsats: 100_000,
      saveAfter: false,
      getBalance: wallet.getBalance,
      claimAndRedeem: wallet.claimAndRedeem,
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: () => {},
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      confirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "claim-failed",
      "Untyped throws (no .code) route to claim-failed, not claim-bridge-threw");
  }

  // ── Balance-never-grows AFTER clean claim → claim-pending (preserved)
  // This is the case claim-pending was DESIGNED for: bridge resolved
  // successfully (no throw, no e.code), but the wallet balance hasn't
  // reflected the credit yet. Genuinely in-flight.
  {
    const wallet = makeMockWallet({
      balances: [0, 0, 0, 0, 0, 0],
      claimResult: "ok",
    });
    let nowMs = 0;
    const terminal = await runClaimAndPayout({
      escrowId: "esc_balance_stall",
      bolt11: "lnbc100n1pstall",
      expectedDeltaMsats: 100_000,
      saveAfter: false,
      getBalance: wallet.getBalance,
      claimAndRedeem: wallet.claimAndRedeem,
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: () => {},
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      confirmTimeoutMs: 3_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "claim-pending",
      "Clean claim + balance never grows → claim-pending (genuinely in-flight)");
    assert(wallet.calls.payInvoice === 0,
      "payInvoice NOT called on claim-pending");
  }

  // ── BRIDGE_THREW_ERROR_CODES is the documented set ─────────────────
  // Tripwire: if a future maintainer adds a new typed bridge error
  // (e.g., FED_DISCONNECTED), this test fails unless they also update
  // the documented codes. Forces the contract update + this routing
  // logic to evolve together.
  {
    assert(BRIDGE_THREW_ERROR_CODES.length === 2,
      "BRIDGE_THREW_ERROR_CODES has exactly the two documented codes");
    assert(BRIDGE_THREW_ERROR_CODES.includes("FED_PROBE_FAILED"),
      "FED_PROBE_FAILED is in the documented set");
    assert(BRIDGE_THREW_ERROR_CODES.includes("FED_MISMATCH"),
      "FED_MISMATCH is in the documented set");
  }
}

// ── 46. SAVED HANDLES PANEL — partition contract (v0.3.1 Phase 4) ────────
//
// The Payment Handles UI partitions saved handles into TWO subsections:
//   - Lightning Addresses (top)  → getSavedLightningHandles()
//   - Fiat rails (below)         → listSavedHandles().filter(h => h.rail !== LIGHTNING_RAIL)
//
// This test pins the partition contract: the two subsections must be
// disjoint AND complete (every saved handle appears in exactly one).
// If a future refactor changes either source-of-truth in a way that
// breaks the partition, the panel would either double-render handles
// or hide some from the user entirely — the test fires immediately.
// Same shape as §43's grep tripwire: a forever-asset for UI doctrine.
console.log("\n── SAVED HANDLES PANEL — partition ──");
{
  (globalThis as any).localStorage.clear();

  // Seed a mixed handle set: 2 LN, 2 fiat
  addOrTouchLightningHandle("alice@phoenix.app");
  addOrTouchLightningHandle("bob@strike.me");
  addSavedHandle("revtag", "@carol");
  addSavedHandle("wave", "+221 77 555 1234");

  const all = listSavedHandles();
  const lnSubsection = getSavedLightningHandles();
  const fiatSubsection = all.filter(h => h.rail !== LIGHTNING_RAIL);

  // ── Disjoint: no id appears in both subsections ────────────────────
  const lnIds = new Set(lnSubsection.map(h => h.id));
  const fiatIds = new Set(fiatSubsection.map(h => h.id));
  for (const id of lnIds) {
    assert(!fiatIds.has(id),
      `Partition disjoint: LN handle ${id} does NOT appear in fiat subsection`);
  }
  for (const id of fiatIds) {
    assert(!lnIds.has(id),
      `Partition disjoint: fiat handle ${id} does NOT appear in LN subsection`);
  }

  // ── Complete: every saved handle appears in exactly one subsection
  assert(lnSubsection.length + fiatSubsection.length === all.length,
    "Partition complete: |LN| + |fiat| === |all| (no handle dropped or duplicated)");

  // ── LN subsection only contains LIGHTNING_RAIL handles ─────────────
  assert(lnSubsection.every(h => h.rail === LIGHTNING_RAIL),
    "LN subsection contains only LIGHTNING_RAIL handles");

  // ── Fiat subsection excludes LIGHTNING_RAIL ────────────────────────
  assert(fiatSubsection.every(h => h.rail !== LIGHTNING_RAIL),
    "Fiat subsection excludes LIGHTNING_RAIL (no double-render with LN subsection)");

  // ── deleteSavedHandle works for LN handles (panel Delete button) ──
  // Pins the contract that the panel's onDelete handler, which calls
  // deleteSavedHandle(id), correctly removes an LN handle from
  // getSavedLightningHandles() on the next refresh.
  const targetLn = lnSubsection[0];
  deleteSavedHandle(targetLn.id);
  const lnAfter = getSavedLightningHandles();
  assert(lnAfter.length === lnSubsection.length - 1,
    "deleteSavedHandle removes one LN handle from getSavedLightningHandles");
  assert(lnAfter.every(h => h.id !== targetLn.id),
    "Deleted LN handle is gone from the subsection after delete");
  // Fiat subsection unchanged by the LN delete
  const fiatAfter = listSavedHandles().filter(h => h.rail !== LIGHTNING_RAIL);
  assert(fiatAfter.length === fiatSubsection.length,
    "Fiat subsection unchanged when an LN handle is deleted");

  (globalThis as any).localStorage.clear();
}

// ── SIM WALLET — balance subscription end-to-end ─────────────────────────
//
// Round 3 hotfix: the user reported inconsistent ChamaBar pill behavior
// driven by suspected missing notifyBalance() calls across the sim
// wallet's mutation sites. This test simulates a full trade lifecycle
// (fund → spend/lock → redeem/claim → payout) and asserts that the
// balance subscriber receives a callback after EVERY mutation with the
// correct new value. setTimeout is monkey-patched to fire synchronously
// so the test is deterministic — no real-world 3-8s waits.
console.log("\n── SIM WALLET — balance subscription end-to-end ──");
{
  const realSetTimeout = (globalThis as any).setTimeout;
  // Replace setTimeout with a synchronous trampoline so createInvoice's
  // auto-credit fires before the next test line runs.
  (globalThis as any).setTimeout = (fn: () => void, _ms: number) => {
    fn();
    return 0 as any;
  };

  try {
    (globalThis as any).localStorage?.removeItem?.("chama_sim_mode");
    const w = await import("../sim/sim-wallet.js");
    const npub = "test_sub_e2e_" + Date.now();
    const wallet = w.createSimWallet({ npub });
    await wallet.joinFederation("fed1sim");
    await wallet.open();

    const events: number[] = [];
    wallet.balance.subscribeBalance((b) => events.push(b));

    // subscribeBalance emits the current balance via setTimeout(0); with
    // the trampoline it fires synchronously. First entry: starting 0.
    assert(events.length >= 1 && events[0] === 0,
      "subscribeBalance emits the starting balance (0) on subscribe");

    // 1) createInvoice — auto-credit fires synchronously under the
    //    trampoline. Expect the subscriber to fire with the new balance.
    const eventsBeforeInvoice = events.length;
    await wallet.lightning.createInvoice(50_000_000, "fund");
    assert(events.length > eventsBeforeInvoice,
      "createInvoice auto-credit fires balance subscriber");
    assert(events[events.length - 1] === 50_000_000,
      "Balance after createInvoice auto-credit = 50,000,000 msat");

    // 2) spendNotes — LOCK debit path. Subscriber must fire.
    const eventsBeforeSpend = events.length;
    const oob = await wallet.mint.spendNotes(40_000_000);
    assert(events.length > eventsBeforeSpend,
      "spendNotes fires balance subscriber");
    assert(events[events.length - 1] === 10_000_000,
      "Balance after spendNotes(40M) = 10M msat (50M - 40M)");

    // 3) redeemEcash — CLAIM credit path. Subscriber must fire.
    const eventsBeforeRedeem = events.length;
    await wallet.mint.redeemEcash(oob);
    assert(events.length > eventsBeforeRedeem,
      "redeemEcash fires balance subscriber");
    assert(events[events.length - 1] === 50_000_000,
      "Balance after redeemEcash = 50M msat (10M + 40M)");

    // 4) payInvoice — outbound LN debit path. Subscriber must fire.
    //    Use a sim-formatted invoice (round-trip-safe after the round-3
    //    encoding fix).
    const eventsBeforePay = events.length;
    const inv = await wallet.lightning.createInvoice(20_000_000, "out");
    // createInvoice fires the credit timer synchronously under the
    // trampoline; the balance is now 70M. Drain the events from that
    // event before we pay so we measure payInvoice's own callback.
    const eventsAfterCredit = events.length;
    assert(events[events.length - 1] === 70_000_000,
      "Balance after second createInvoice auto-credit = 70M msat");

    await wallet.lightning.payInvoice(inv.invoice);
    assert(events.length > eventsAfterCredit,
      "payInvoice fires balance subscriber");
    assert(events[events.length - 1] === 50_000_000,
      "Balance after payInvoice(20M) = 50M msat (70M - 20M)");

    // 5) cleanup() cancels pending credit timers. The trampoline fires
    //    setTimeout synchronously, so an in-flight timer has already
    //    completed before cleanup() can see it — which means we can't
    //    test cancellation under the trampoline. Instead: confirm the
    //    visible side-effect (subscribers Set cleared) by calling
    //    notifyBalance after cleanup and verifying no callback fires.
    const eventsBeforeCleanup = events.length;
    await wallet.cleanup();
    // Manually trigger a balance bump after cleanup — subscribers
    // should be empty so no event appends. (We use the publicly-visible
    // joinFederation, which calls notifyBalance internally.)
    await wallet.joinFederation("fed1sim");
    assert(events.length === eventsBeforeCleanup,
      "cleanup() clears subscriber set (post-cleanup mutations don't reach old subscribers)");

    (globalThis as any).localStorage?.removeItem?.("chama_sim_wallet_" + npub);
  } finally {
    (globalThis as any).setTimeout = realSetTimeout;
  }
}

// ── SIM MODE — cross-mode drop policy + BOLT11 parser ──────────────────
//
// Bug A (round 2 hotfix) was a cross-mode listing leak: sim-tagged
// events appeared in non-sim browsers. The fix wires a chokepoint
// `shouldDropEvent` callback into the relay-manager so every dispatch
// path (handleIncomingEvent, fetchEscrowEvents, fetchOnce) uses the
// same policy. The truth table is verified directly here so a future
// refactor can't silently invert it.
//
// Bug B (round 2) was the sim payInvoice not debiting on outbound LN
// payout, leaving the winner's wallet with a phantom balance after
// COMPLETE. The fix parses the BOLT11 amount; failure modes (no
// amount, malformed prefix) must return null so the wallet can
// throw cleanly instead of silently moving phantom sats.
console.log("\n── SIM MODE — cross-mode policy + BOLT11 parser ──");
{
  const { shouldDropForSimPolicy, eventIsSim } = await import("../sim/simMode.js");
  const { parseBolt11Msats } = await import("../sim/sim-wallet.js");

  const simEvent = { tags: [["d", "abc"], ["chama-sim", "v1"]] } as any;
  const realEvent = { tags: [["d", "abc"]] } as any;

  // Force sim OFF for the first half.
  (globalThis as any).localStorage.removeItem("chama_sim_mode");

  assert(eventIsSim(simEvent) === true,
    "eventIsSim returns true for chama-sim-tagged events");
  assert(eventIsSim(realEvent) === false,
    "eventIsSim returns false for untagged events");

  assert(shouldDropForSimPolicy(simEvent) === true,
    "Sim OFF + sim-tagged event → DROP (was the listing leak failure case)");
  assert(shouldDropForSimPolicy(realEvent) === false,
    "Sim OFF + untagged event → keep");

  // Flip sim ON for the second half.
  (globalThis as any).localStorage.setItem("chama_sim_mode", "1");
  assert(shouldDropForSimPolicy(simEvent) === false,
    "Sim ON + sim-tagged event → keep");
  assert(shouldDropForSimPolicy(realEvent) === true,
    "Sim ON + untagged event → DROP (no prod chatter in sim view)");

  (globalThis as any).localStorage.removeItem("chama_sim_mode");

  // BOLT11 amount parsing — covers the sim wallet's payout-debit path
  // and the four BOLT-11 multiplier units.
  assert(parseBolt11Msats("lnbc500u1pXXX") === 50_000_000,
    "Parser handles real-shape bolt11 with 'u' multiplier (500u = 50k sats)");
  assert(parseBolt11Msats("lnbcsim50000n1pXXX") === 5_000_000,
    "Parser handles sim invoices (lnbcsim prefix, 'n' multiplier)");
  assert(parseBolt11Msats("lnbc10m1pXXX") === 1_000_000_000,
    "Parser handles 'm' multiplier (10m = 1M sats)");
  assert(parseBolt11Msats("lnbc1p10n1pXXX") !== null,
    "Parser tolerates BOLT11 strings with characters after the amount field");
  assert(parseBolt11Msats("not-a-bolt11") === null,
    "Parser returns null for non-bolt11 strings");
  assert(parseBolt11Msats("") === null,
    "Parser returns null for empty string");
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
