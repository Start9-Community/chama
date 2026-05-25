// ══════════════════════════════════════════════════════════════════════════
// Chama Nostr Escrow Engine — Types & Constants
// ══════════════════════════════════════════════════════════════════════════
//
// Pure type definitions. No runtime dependencies. No server. No database.
// This file is the single source of truth for the escrow protocol.
//
// Design principles:
//   1. Non-custodial by design — 2-of-3 SSS, no server can move funds
//   2. Relay-native — state lives as Nostr events, reconstructable by any client
//   3. NIP-44 encrypted content — only the 3 participants can read trade details
//   4. Immutable audit log — non-replaceable events, chained via e-tags

// ── Escrow States ─────────────────────────────────────────────────────────
// Atomic-funding model: there is no FUNDED state. The instant the BOLT11
// invoice is paid, the locker mints internally and publishes LOCK in one
// atomic side-effect. CREATED → LOCKED is the only pre-vote transition.
// JOIN events still exist as participant ACKs (carry the pubkey of buyer
// or arbiter pre-LOCK if available) but they do not gate the state
// machine. READY and KICK are gone — they were ceremony around the dead
// FUNDED state.

export enum EscrowStatus {
  /** Trade terms published, waiting for payment to land and trigger LOCK */
  CREATED = "CREATED",
  /** Ecash locked in 2-of-3 SSS escrow (atomic side-effect of payment landing) */
  LOCKED = "LOCKED",
  /** 2-of-3 votes agree on outcome */
  APPROVED = "APPROVED",
  /** Winner has claimed the ecash */
  CLAIMED = "CLAIMED",
  /** Payout confirmed — terminal */
  COMPLETED = "COMPLETED",
  /** Timeout reached — terminal */
  EXPIRED = "EXPIRED",
  /** Cancelled before lock — terminal */
  CANCELLED = "CANCELLED",
}

// ── Terminal states (no further transitions allowed) ──────────────────────

export const TERMINAL_STATES: ReadonlySet<EscrowStatus> = new Set([
  EscrowStatus.COMPLETED,
  EscrowStatus.EXPIRED,
  EscrowStatus.CANCELLED,
]);

// TRULY_TERMINAL_STATES — v0.1.66.26 (expiry heal / Mechanism A)
// ────────────────────────────────────────────────────────────────
// EXPIRED is NOT truly terminal in our model. It's a transient state
// that represents "the escrow timed out while participants were
// offline, but can heal via 2-of-3 REFUND votes once anyone comes
// back online." The state machine (applyEvent) uses this stricter
// set so that post-expiry VOTE events reach their handler instead of
// being rejected with TERMINAL_STATE.
//
// TERMINAL_STATES is kept unchanged for UI purposes where EXPIRED
// should still read as "this trade is done" in listings, filters,
// and chat blocking — healing is a background process the user
// doesn't need to see mid-flight.
//
// Only COMPLETED (money moved successfully) and CANCELLED (trade
// aborted pre-lock) are genuinely unrecoverable.
export const TRULY_TERMINAL_STATES: ReadonlySet<EscrowStatus> = new Set([
  EscrowStatus.COMPLETED,
  EscrowStatus.CANCELLED,
]);

// ── Participant Roles ─────────────────────────────────────────────────────

export enum Role {
  BUYER = "buyer",
  SELLER = "seller",
  ARBITER = "arbiter",
}

export const JOIN_HOLD_SECONDS = 15 * 60;
export const JOIN_HOLD_LOCK_GRACE_SECONDS = 2 * 60;

// ── Vote Outcomes ─────────────────────────────────────────────────────────

export enum Outcome {
  RELEASE = "release", // Sats go to buyer (trade completed successfully)
  REFUND = "refund",   // Sats return to seller (trade failed/disputed)
}

// ── Nostr Event Kinds ─────────────────────────────────────────────────────
// Application-specific range (30000+). Non-replaceable for immutable audit.
// Using 38100–38109 block for Chama escrow protocol.

export enum EscrowEventKind {
  /** Initiator publishes trade terms */
  CREATE = 38100,
  /** Participant ACK — records buyer or arbiter pubkey on the chain
   *  before LOCK lands. Pure acknowledgment; does NOT transition state. */
  JOIN = 38101,
  /** Ecash locked in 2-of-3 SSS — shares distributed. Atomic side-effect
   *  of BOLT11 payment landing; transitions CREATED → LOCKED directly. */
  LOCK = 38102,
  /** Participant casts a vote (release or refund) */
  VOTE = 38103,
  /** 2-of-3 threshold met — outcome resolved */
  RESOLVE = 38104,
  /** Winner claims ecash (publishes proof of reconstruction) */
  CLAIM = 38105,
  /** Trade completed — final confirmation */
  COMPLETE = 38106,
  /** Trade cancelled before lock */
  CANCEL = 38107,
  /** Chat message within escrow context (NIP-44 encrypted) */
  CHAT = 38108,
  // 38109 (READY) and 38110 (KICK) retired — atomic funding eliminated
  // the FUNDED ceremony those events gated. Numbers reserved.
  /** Create a subscription escrow with periodic releases */
  SUBSCRIBE = 38111,
  /** Release one period's sats to the seller */
  PERIOD_RELEASE = 38112,
}

// ── Valid State Transitions ───────────────────────────────────────────────
// Maps each state to the set of states it can transition to.
// The state machine enforces these — any event that would cause an
// invalid transition is rejected during replay.

export const VALID_TRANSITIONS: ReadonlyMap<EscrowStatus, ReadonlySet<EscrowStatus>> = new Map([
  [EscrowStatus.CREATED,   new Set([EscrowStatus.LOCKED, EscrowStatus.CANCELLED, EscrowStatus.EXPIRED])],
  [EscrowStatus.LOCKED,    new Set([EscrowStatus.APPROVED, EscrowStatus.EXPIRED])],
  [EscrowStatus.APPROVED,  new Set([EscrowStatus.CLAIMED])],
  [EscrowStatus.CLAIMED,   new Set([EscrowStatus.COMPLETED])],
  // Terminal — no transitions out
  [EscrowStatus.COMPLETED, new Set()],
  [EscrowStatus.EXPIRED,   new Set()],
  [EscrowStatus.CANCELLED, new Set()],
]);

// ── Event Kind → Transition Mapping ───────────────────────────────────────
// Which event kinds can trigger which state transitions.
// JOIN is intentionally absent — it's an ACK that records a participant
// pubkey but does not move the state machine forward.

export const EVENT_KIND_TRANSITIONS: ReadonlyMap<EscrowEventKind, { from: EscrowStatus[]; to: EscrowStatus }> = new Map([
  [EscrowEventKind.LOCK,     { from: [EscrowStatus.CREATED],  to: EscrowStatus.LOCKED }],
  // VOTE doesn't directly transition — RESOLVE does when 2-of-3 is met
  [EscrowEventKind.RESOLVE,  { from: [EscrowStatus.LOCKED],   to: EscrowStatus.APPROVED }],
  [EscrowEventKind.CLAIM,    { from: [EscrowStatus.APPROVED], to: EscrowStatus.CLAIMED }],
  [EscrowEventKind.COMPLETE, { from: [EscrowStatus.CLAIMED],  to: EscrowStatus.COMPLETED }],
  [EscrowEventKind.CANCEL,   { from: [EscrowStatus.CREATED],  to: EscrowStatus.CANCELLED }],
]);

// ── Nostr Event Tag Constants ─────────────────────────────────────────────

export const TAGS = {
  /** Escrow identifier (d-tag for filtering) */
  ESCROW_ID: "d",
  /** Participant pubkey */
  PARTICIPANT: "p",
  /** Reference to previous event in chain */
  PREV_EVENT: "e",
  /** Event type label */
  TYPE: "t",
  /** Fedimint federation invite code or mint URL */
  MINT: "mint",
  /** SSS share index (0, 1, or 2) */
  SHARE_INDEX: "share_idx",
  /** Platform fee pubkey */
  FEE_PUBKEY: "fee_pk",
  /** Trade amount in msats */
  AMOUNT: "amount",
  /** Fiat currency code */
  CURRENCY: "currency",
  /** Category tag for marketplace filtering */
  CATEGORY: "cat",
  /** Community slug — drives Browse filtering and currency context.
   *  Lower-case slug from the static communities registry. */
  COMMUNITY: "community",
  /** Fulfillment type: "physical" | "service" | "digital". Generic to
   *  any listing; users only pick at create time for marketplace —
   *  other categories auto-set in handleCreate. */
  FULFILLMENT: "fulfillment",
  // v0.1.72 federation gates ───────────────────────────────────────────
  /** Federation prefix (first 10 chars of an ecash probe). Fast compare. */
  FED_PREFIX: "fedPrefix",
  /** Full federation ID (hex). Canonical record. */
  FED: "fed",
} as const;

// ── Encrypted Content Payloads ────────────────────────────────────────────
// These are the JSON structures inside NIP-44 encrypted `content` fields.

/**
 * v0.1.72 federation gates: CreatePayload now optionally carries the
 * locker's federation identity, captured via a 1-sat probe at create
 * time. Both fields are optional for backwards compatibility with
 * pre-.72 trades; participants warn-and-allow when they're missing.
 *
 *   fedPrefix — first 10 chars of an OOB ecash probe. Cheap to compare.
 *   fed       — full federation ID (hex). Canonical, used for display
 *               and registry matching.
 */
/** Content of a CREATE event */
export interface CreatePayload {
  type: "escrow:create";
  description: string;
  amountMsats: number;
  /** Fiat amount if applicable */
  fiatAmount?: number;
  fiatCurrency?: string;
  /** Category: p2p-trade, bill-pay, marketplace, lending */
  category: string;
  /** Fulfillment type: "physical" | "service" | "digital". Generic to
   *  every listing per PR 2 call #3. The user picks only for
   *  marketplace; for p2p-trade / bill-pay / lending, handleCreate
   *  rewrites this to the canonical "service" if supplied (or fills
   *  it in if missing) so the chain is consistent. */
  fulfillment?: "physical" | "service" | "digital";
  /** Community slug from the static registry (PR 2). Optional for
   *  backwards compatibility with pre-registry trades — those flow
   *  through Browse as cross-community listings without a pill. */
  community?: string;
  /** Fedimint federation invite code */
  mintUrl: string;
  /** Platform fee in basis points */
  platformFeeBps: number;
  /** Platform fee recipient pubkey */
  platformFeePubkey: string;
  /** Arbiter fee in msats (if pre-agreed) */
  arbiterFeeMsats?: number;
  /** Payment methods accepted (for P2P) */
  paymentMethods?: string[];
  /** Optional menu/listing items. Absent means the legacy single-offer
   *  listing shape; present means LOCK must snapshot the selected basket
   *  into selectedItems so the trade amount is fixed by the order. */
  items?: MenuItem[];
  /** Expiry duration in seconds */
  expirySeconds: number;
  /** Community arbiter pool — all pubkeys that receive the arbiter SSS share */
  communityArbiters?: string[];
  // v0.1.72 federation gates — payload fields ───────────────────────────
  /** Federation prefix (first 10 chars of an OOB ecash probe). Locker
   *  captures via FedimintClient.probeFederation() at create time.
   *  Optional for backwards compatibility with pre-.72 trades. */
  fedPrefix?: string;
  /** Full federation ID (hex). Same probe captures both. Used for
   *  display and registry matching. Optional for pre-.72 trades. */
  fed?: string;
  /** Timestamp */
  createdAt: number;
}

/** Content of a JOIN event — pure ACK, does not transition state.
 *  Records the joining participant's pubkey on the chain so other
 *  clients can discover them before LOCK lands. The locker may also
 *  read participants from JOIN events to populate the LOCK payload's
 *  buyerPubkey / arbiterPubkey, but is not required to — LOCK is
 *  self-describing. */
export interface JoinPayload {
  type: "escrow:join";
  role: Role;
  /** Optional: arbiter's fee terms */
  arbiterFeeMsats?: number;
  joinedAt: number;
  /** Buyer/seller slot hold deadline. New clients set this to
   *  joinedAt + JOIN_HOLD_SECONDS; legacy JOINs omit it and remain
   *  first-writer-wins for backwards compatibility. */
  holdExpiresAt?: number;
  /** Optional menu/order selection. For menu listings the buyer can
   *  publish a follow-up JOIN with selectedItems after joining; the
   *  locker snapshots the same basket into LOCK. */
  selectedItems?: SelectedMenuItem[];
  /** Cached selected total for browse/detail UI. LOCK still recomputes
   *  from selectedItems so this is display metadata, not accounting. */
  amountMsats?: number;
  /** Optional final acknowledgement that freezes the menu/order cart.
   *  Cross-role lockers must wait for this before publishing LOCK. */
  orderFinalizedAt?: number;
}

/** Single share in a LOCK event's shares[] array.
 *  `encryptedFor` is keyed by participant pubkey → NIP-44 ciphertext. */
export interface LockShareEntry {
  shareIndex: number;
  encryptedFor: Record<string, string>;
}

export type MenuItemKind = "exchange-bracket" | "bill" | "loan" | "market-item";

export interface MenuItem {
  id: string;
  label: string;
  amountMsats: number;
  kind?: MenuItemKind;
  minAmountMsats?: number;
  maxAmountMsats?: number;
  description?: string;
  fiatAmount?: number;
  fiatCurrency?: string;
  fulfillment?: "physical" | "service" | "digital";
  imageDataUrl?: string;
  dueAt?: number;
  termDays?: number;
  aprBps?: number;
  trustTier?: number;
}

export interface SelectedMenuItem {
  itemId: string;
  label: string;
  amountMsats: number;
  quantity: number;
  kind?: MenuItemKind;
  minAmountMsats?: number;
  maxAmountMsats?: number;
  description?: string;
  fiatAmount?: number;
  fiatCurrency?: string;
  fulfillment?: "physical" | "service" | "digital";
  imageDataUrl?: string;
  dueAt?: number;
  termDays?: number;
  aprBps?: number;
  trustTier?: number;
}

/** PR 4: 3-recipient envelope structure for LOCK-time data that needs
 *  to reach all three participants. Mirrors LockShareEntry.encryptedFor.
 *  Each value is a NIP-44 ciphertext encrypted by the locker (sender)
 *  to the corresponding recipient pubkey. Any recipient decrypts their
 *  entry using the locker's pubkey as the sender for ECDH.
 *
 *  General-purpose: today used for handle reveal; v1.5+ may reuse for
 *  CHAT 3-recipient encryption or other pre-share fields. The helper
 *  in src/escrow-engine/envelope.ts owns construction/decryption. */
export interface HandleEnvelope {
  encryptedFor: Record<string, string>;
}

/** Content of a LOCK event.
 *
 *  Current browser/Fedi milestone: the escrow token is one reconstructed
 *  ecash payload, so LOCK math is a 2-way split: winner-share + optional
 *  pre-agreed arbiter share must equal amountMsats. The fee policy in
 *  src/arbiters/fees.ts is intentionally separate until a dedicated
 *  multi-party payout path can enforce ambient/dispute fees without
 *  making Fedi claims show the wrong amount.
 */
export interface LockPayload {
  type: "escrow:lock";
  /** Hash of the full ecash notes (for verification) */
  notesHash: string;
  /** SSS shares — each encrypted to ALL participants for dual-encryption.
   *  Every share is NIP-44 encrypted separately to each participant's
   *  pubkey, so any participant can decrypt any share. */
  shares: LockShareEntry[];
  /** Breakdown of amounts (2-way split since v0.1.71) */
  sellerReceivesMsats: number;
  arbiterFeeMsats: number;
  /** Snapshot of the buyer-selected menu basket. For menu listings,
   *  this is required at LOCK and its sum becomes the escrow amount. */
  selectedItems?: SelectedMenuItem[];
  /** Atomic-funding fields (PR 1): LOCK is self-describing about who
   *  the buyer and arbiter are. The chain no longer relies on prior
   *  JOIN events to populate the participant slots — JOINs are ACKs.
   *
   *  buyerPubkey: the npub whose BOLT11 payment triggered this LOCK.
   *  arbiterPubkey: the locker's pick from the trade's communityArbiters
   *    pool (or any pubkey if the pool is empty / pre-community trades). */
  buyerPubkey: string;
  arbiterPubkey: string;
  /** PR 4 wire format: 3-recipient encrypted handle reveal. The locker
   *  encrypts a JSON {handleId?, handle, rail?} blob to each of buyer /
   *  seller / arbiter via NIP-44, mirroring how SSS shares are
   *  distributed via LockShareEntry.encryptedFor. Each participant
   *  decrypts their own entry; non-participants get a null lookup.
   *
   *  Optional: marketplace digital trades, raw escrows, and trades
   *  where the seller didn't pick a saved handle leave this undefined.
   *  When the envelope IS present, the top-level handle/handleId/rail
   *  fields below should be omitted on the wire — escrow-client's
   *  receive pipeline resolves the envelope and synthesizes those
   *  top-level fields on the parsed event before applyEvent runs. */
  handleEnvelope?: HandleEnvelope;
  /** PR 3 (deprecated wire format) + PR 4 transient apply-time fields.
   *
   *  On the wire: pre-PR-4 LOCKs carry handle/handleId/rail at the top
   *  level (single-recipient via the now-removed outer NIP-44 wrap).
   *  Replay still accepts those for backwards compat; new emitters use
   *  handleEnvelope instead.
   *
   *  At apply time: escrow-client populates these from the envelope
   *  (decrypts the viewer's entry) before passing to handleLock. The
   *  state machine reads them as cleartext regardless of how they
   *  arrived — wire-legacy or envelope-resolved. */
  handleId?: string;
  handle?: string;
  rail?: string;
  /** v0.6.5: optional mobile-money networks the locker accepts on this
   *  handle (e.g. ["m-pesa", "airtel-money"] for a Kenyan phone number).
   *  Carried inside the same NIP-44 envelope as handle/rail, never on
   *  the wire as cleartext. Apply-time field — escrow-client populates
   *  it from the envelope JSON before applyEvent. Only meaningful for
   *  phone-number rails; other rails leave it undefined. */
  handleNetworks?: string[];
  lockedAt: number;
}

/** Content of a VOTE event */
export interface VotePayload {
  type: "escrow:vote";
  outcome: Outcome;
  role: Role;
  /** Optional reason */
  reason?: string;
  /** The voter's SSS share (encrypted to winner once outcome is known) */
  votedAt: number;
}

/** Content of a RESOLVE event */
export interface ResolvePayload {
  type: "escrow:resolve";
  outcome: Outcome;
  /** Which 2 roles formed the majority */
  majority: [Role, Role];
  /** Was arbiter needed? */
  arbiterInvolved: boolean;
  resolvedAt: number;
}

/** Content of a CLAIM event */
export interface ClaimPayload {
  type: "escrow:claim";
  /** Role of the claimant */
  claimerRole: Role;
  /** Proof: hash of reconstructed notes matches original lock */
  notesHashVerification: string;
  claimedAt: number;
}

/** Content of a COMPLETE event */
export interface CompletePayload {
  type: "escrow:complete";
  completedAt: number;
}

/** Content of a CANCEL event */
export interface CancelPayload {
  type: "escrow:cancel";
  cancellerRole: Role;
  reason?: string;
  cancelledAt: number;
}

/** Content of a CHAT event */
export interface ChatImageAttachment {
  id: string;
  kind: "image";
  mimeType: string;
  dataUrl: string;
  name?: string;
  width?: number;
  height?: number;
  sizeBytes?: number;
}

export interface ChatBody {
  message: string;
  attachments?: ChatImageAttachment[];
}

export interface ChatPayload {
  type: "escrow:chat";
  /** Cleartext message after envelope resolution. On new wire events,
   *  this is intentionally empty and the readable body lives inside
   *  bodyEnvelope. Legacy plaintext chat keeps using this field. */
  message: string;
  /** Cleartext attachments after envelope resolution. New wire events
   *  carry these inside bodyEnvelope so receipts remain participant-only. */
  attachments?: ChatImageAttachment[];
  /** v0.7.x: participant-only encrypted chat body. The sender encrypts
   *  JSON ChatBody to buyer, seller, and arbiter using the same
   *  per-recipient envelope pattern as LOCK handle reveal. */
  bodyEnvelope?: HandleEnvelope;
  senderRole: Role;
  sentAt: number;
}

/** Content of a SUBSCRIBE event — buyer creates subscription terms */
export interface SubscribePayload {
  type: "escrow:subscribe";
  /** Total number of periods (e.g. 3 months) */
  totalPeriods: number;
  /** Amount per period in msats */
  periodAmountMsats: number;
  /** Duration of each period in seconds (e.g. 2592000 = 30 days) */
  periodDurationSeconds: number;
  /** What the subscription is for */
  description: string;
  /** When the subscription starts */
  startsAt: number;
}

/** Content of a PERIOD_RELEASE event — release one period's sats */
export interface PeriodReleasePayload {
  type: "escrow:period_release";
  /** Which period (0-indexed) */
  periodIndex: number;
  /** Amount released in msats */
  amountMsats: number;
  /** Who triggered the release (seller claim, arbiter auto-release, or buyer early release) */
  triggeredBy: Role;
  releasedAt: number;
}

/** Status of a single subscription period */
export type PeriodStatus = "pending" | "active" | "released" | "disputed" | "refunded";

/** Subscription metadata stored in EscrowState */
export interface SubscriptionMeta {
  /** Total periods in the subscription */
  totalPeriods: number;
  /** Amount per period in msats */
  periodAmountMsats: number;
  /** Duration of each period in seconds */
  periodDurationSeconds: number;
  /** When each period starts (computed from startsAt + index * duration) */
  periodStartTimes: number[];
  /** Status of each period */
  periodStatuses: PeriodStatus[];
  /** Number of periods released so far */
  releasedCount: number;
  /** Number of periods disputed */
  disputedCount: number;
  /** Total msats released so far */
  totalReleasedMsats: number;
  /** When the subscription started */
  startsAt: number;
}

// ── Union type for all payloads ───────────────────────────────────────────

export type EscrowPayload =
  | CreatePayload
  | JoinPayload
  | LockPayload
  | VotePayload
  | ResolvePayload
  | ClaimPayload
  | CompletePayload
  | CancelPayload
  | ChatPayload
  | SubscribePayload
  | PeriodReleasePayload;

// ── Raw Nostr Event (minimal, from nostr-tools) ──────────────────────────

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

// ── Parsed Escrow Event ───────────────────────────────────────────────────
// A NostrEvent that has been validated, decrypted, and typed.

export interface ParsedEscrowEvent<T extends EscrowPayload = EscrowPayload> {
  /** Original Nostr event */
  raw: NostrEvent;
  /** Decrypted and parsed payload */
  payload: T;
  /** Escrow ID extracted from d-tag */
  escrowId: string;
  /** Previous event ID from e-tag (null for CREATE) */
  prevEventId: string | null;
  /** Event kind as our enum */
  kind: EscrowEventKind;
  /** Signer's pubkey */
  pubkey: string;
  /** Event timestamp */
  timestamp: number;
}

// ── Escrow State (reconstructed from event chain) ─────────────────────────
// This is the "database row" but built entirely from replaying Nostr events.

export interface EscrowState {
  /** Unique escrow identifier (d-tag value) */
  id: string;
  /** Current status */
  status: EscrowStatus;
  /** Trade description */
  description: string;
  /** Amount in msats */
  amountMsats: number;
  /** Fiat amount and currency (if applicable) */
  fiatAmount?: number;
  fiatCurrency?: string;
  /** Category */
  category: string;
  /** Optional menu/listing items. Undefined keeps legacy single-offer
   *  listings small on replay. */
  items?: MenuItem[];
  /** Fulfillment type: "physical" | "service" | "digital". Always set
   *  after handleCreate runs — defaults to "service" for non-marketplace
   *  categories, "physical" for marketplace when not specified. */
  fulfillment: "physical" | "service" | "digital";
  /** Community slug. Null for pre-registry trades (no community tag
   *  on CREATE) — Browse renders these without a community pill. */
  community: string | null;
  /** Fedimint mint URL / invite code */
  mintUrl: string;

  /** Participants — pubkeys mapped to roles */
  participants: {
    [Role.BUYER]: string | null;
    [Role.SELLER]: string | null;
    [Role.ARBITER]: string | null;
  };

  /** Timed buyer/seller reservations created by JOIN ACKs. The
   *  initiator role and arbiter auto-assignment do not use timed holds. */
  joinHolds?: Partial<Record<Role, {
    role: Role;
    pubkey: string;
    joinedAt: number;
    expiresAt: number;
    eventId: string;
    selectedItems?: SelectedMenuItem[];
    amountMsats?: number;
    orderFinalizedAt?: number;
  }>>;

  /** Who initiated the trade (and their role) */
  initiator: { pubkey: string; role: Role };

  /** Community arbiter pool — backup arbiters who also receive the SSS share */
  communityArbiters: string[];

  /** Subscription metadata (null for non-subscription escrows) */
  subscription: SubscriptionMeta | null;

  /** Votes cast so far */
  votes: {
    [Role.BUYER]?: Outcome;
    [Role.SELLER]?: Outcome;
    [Role.ARBITER]?: Outcome;
  };

  /** Resolved outcome (set when 2-of-3 agree) */
  resolvedOutcome: Outcome | null;
  /** Which two roles formed the majority */
  resolvedMajority: [Role, Role] | null;

  /** Fee structure */
  fees: {
    platformBps: number;
    platformPubkey: string;
    platformMsats: number;
    arbiterMsats: number;
  };

  /** Lock details */
  lock: {
    notesHash: string | null;
    lockedAt: number | null;
    /** Encrypted SSS shares, keyed by share index (stringified).
     *  Each entry contains the encryptedFor map so any participant can
     *  decrypt any share they need for Shamir reconstruction. */
    shares: Map<string, LockShareEntry>;
    /** PR 3: revealed payment handle for the trade. Populated by
     *  handleLock when the LockPayload carried handle/rail fields.
     *  null when the trade is a non-fiat vertical (marketplace digital,
     *  raw-escrow) or a pre-PR-3 trade. The render layer applies
     *  handleDisplayForViewer() to gate cleartext display on viewer
     *  context — non-participants see masked output even when this
     *  field is populated locally.
     *  v0.6.5: `networks` carries the mobile-money networks the seller
     *  tagged on a phone-number handle ("M-Pesa", "Wave", etc.). Empty
     *  array means the seller didn't tag any; that's distinct from
     *  null (no handle at all). Render layer shows them as chips
     *  alongside the cleartext number during active trade. */
    handle: {
      id: string | null;
      value: string;
      rail: string | null;
      networks: string[];
    } | null;
    /** Menu basket captured by LOCK. Null/undefined means legacy
     *  single-offer escrow. */
    selectedItems?: SelectedMenuItem[];
  };

  /** Claim details */
  claim: {
    claimerRole: Role | null;
    claimedAt: number | null;
  };

  /** Timestamps */
  createdAt: number;
  /** Deadline for the unlocked Browse listing. Once LOCK lands, the
   *  active trade deadline moves to lock.lockedAt + tradeTimeoutSeconds. */
  listingExpiresAt?: number;
  /** Duration applied to the locked trade after LOCK. Defaults to the
   *  CREATE expirySeconds for backwards-compatible replays. */
  tradeTimeoutSeconds?: number;
  /** Active deadline for the current state: listing deadline while
   *  CREATED, locked trade deadline after LOCK. */
  expiresAt: number;
  resolvedAt: number | null;
  completedAt: number | null;
  cancelledAt: number | null;

  /** Full ordered event chain (for verification / replay) */
  eventChain: ParsedEscrowEvent[];

  /** Chat messages (separate from state transitions) */
  chatMessages: ParsedEscrowEvent<ChatPayload>[];
}

export function roleUsesJoinHold(role: Role, initiatorRole: Role): boolean {
  return (role === Role.BUYER || role === Role.SELLER) && role !== initiatorRole;
}

export function joinHoldExpiresAt(joinedAt: number): number {
  return joinedAt + JOIN_HOLD_SECONDS;
}

export function getEffectiveParticipantAt(
  state: EscrowState,
  role: Role,
  atSec = Math.floor(Date.now() / 1000),
  opts: { includeLockGrace?: boolean } = {},
): string | null {
  const pubkey = state.participants[role];
  if (!pubkey) return null;
  if (state.status !== EscrowStatus.CREATED) return pubkey;

  const hold = state.joinHolds?.[role];
  if (!hold || hold.pubkey !== pubkey) return pubkey;

  const graceSeconds = opts.includeLockGrace ? JOIN_HOLD_LOCK_GRACE_SECONDS : 0;
  return hold.expiresAt + graceSeconds > atSec ? pubkey : null;
}

export function getEffectiveParticipantsAt(
  state: EscrowState,
  atSec = Math.floor(Date.now() / 1000),
): EscrowState["participants"] {
  return {
    [Role.BUYER]: getEffectiveParticipantAt(state, Role.BUYER, atSec),
    [Role.SELLER]: getEffectiveParticipantAt(state, Role.SELLER, atSec),
    [Role.ARBITER]: getEffectiveParticipantAt(state, Role.ARBITER, atSec),
  };
}

export function getJoinHoldRemainingSeconds(
  state: EscrowState,
  role: Role,
  atSec = Math.floor(Date.now() / 1000),
): number | null {
  const hold = state.joinHolds?.[role];
  if (!hold || state.participants[role] !== hold.pubkey) return null;
  return Math.max(0, hold.expiresAt - atSec);
}

export function selectedMenuItemsTotalMsats(items: SelectedMenuItem[] | undefined): number {
  if (!items || items.length === 0) return 0;
  return items.reduce((sum, item) => sum + item.amountMsats * item.quantity, 0);
}

// ── Validation Error ──────────────────────────────────────────────────────

export interface ValidationError {
  code: string;
  message: string;
  eventId?: string;
  details?: Record<string, unknown>;
}

export type ValidationResult =
  | { valid: true }
  | { valid: false; error: ValidationError };
