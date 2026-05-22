// ══════════════════════════════════════════════════════════════════════════
// Chama Nostr Escrow Engine — Escrow Client
// ══════════════════════════════════════════════════════════════════════════
//
// High-level orchestrator that connects:
//   - Relay manager (network)
//   - Event parser (Nostr → typed events)
//   - State machine (typed events → state)
//   - NIP-44 encryption (content privacy)
//   - Event signing (Nostr identity)
//
// This is the API the UI layer calls. One method per user action.
//
// The client is agnostic about WHERE keys/signing come from:
//   - NIP-07 browser extension (window.nostr)
//   - Fedi Mini-App runtime (fediInternal)
//   - Local keypair (for testing)
//   - Amber / remote signer
//
// Signing and encryption are injected via the Signer interface.

import {
  EscrowEventKind,
  EscrowStatus,
  Role,
  Outcome,
  TAGS,
  type NostrEvent,
  type EscrowState,
  type ParsedEscrowEvent,
  type CreatePayload,
  type JoinPayload,
  type LockPayload,
  type LockShareEntry,
  type HandleEnvelope,
  type VotePayload,
  type ResolvePayload,
  type ClaimPayload,
  type CompletePayload,
  type CancelPayload,
  type PeriodReleasePayload,
  type ChatBody,
  type ChatImageAttachment,
  type ChatPayload,
  type EscrowPayload,
} from "./types.js";

import { applyEvent, replayEventChain, canVote, getWinner, type TransitionResult } from "./state-machine.js";
import { EscrowNotifier } from "./notifier.js";
import { ENCRYPTION_CONFIG, maybeEncrypt } from "./encryption-config.js";
import { parseEscrowEvent, sortEventChain } from "./event-parser.js";
import { createEnvelope, decryptFromEnvelope } from "./envelope.js";
import { RelayManager, type NostrFilter } from "./relay-manager.js";
import { simTagOrNull, shouldDropForSimPolicy } from "../sim/simMode.js";

// ══════════════════════════════════════════════════════════════════════════
// SIGNER INTERFACE — Injected dependency for key operations
// ══════════════════════════════════════════════════════════════════════════

/**
 * Abstract signing/encryption interface.
 *
 * Implementations:
 *   - NIP07Signer: uses window.nostr (browser extension)
 *   - FediSigner: uses fediInternal APIs (Fedi Mini-App)
 *   - LocalSigner: uses a local keypair (testing / CLI)
 */
export interface Signer {
  /** Get the user's public key (hex) */
  getPublicKey(): Promise<string>;

  /**
   * Sign a Nostr event (set pubkey, id, sig fields).
   * Input is an unsigned event (no id, no sig, no pubkey).
   * Returns a fully signed event.
   */
  signEvent(event: UnsignedEvent): Promise<NostrEvent>;

  /**
   * NIP-44 encrypt content for a recipient.
   * Returns the encrypted string to put in event.content.
   */
  nip44Encrypt(plaintext: string, recipientPubkey: string): Promise<string>;

  /**
   * NIP-44 decrypt content from a sender.
   * Returns the plaintext string.
   */
  nip44Decrypt(ciphertext: string, senderPubkey: string): Promise<string>;
}

/** Unsigned event template — the client builds these, the signer completes them */
export interface UnsignedEvent {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

// ══════════════════════════════════════════════════════════════════════════
// ESCROW CLIENT EVENTS — Callbacks for the UI layer
// ══════════════════════════════════════════════════════════════════════════

export interface EscrowClientCallbacks {
  /** Called when any escrow state changes (new event processed) */
  onStateUpdate?: (escrowId: string, state: EscrowState) => void;
  /** Called when a new chat message arrives */
  onChatMessage?: (escrowId: string, message: ParsedEscrowEvent<ChatPayload>) => void;
  /** Called when an event fails validation */
  onValidationError?: (escrowId: string, error: string, eventId?: string) => void;
  /** Called when relay connectivity changes */
  onRelayStatus?: (relayUrl: string, status: string) => void;
}

// ══════════════════════════════════════════════════════════════════════════
// ESCROW CLIENT CONFIG
// ══════════════════════════════════════════════════════════════════════════

export interface EscrowClientConfig {
  /** Relay URLs to connect to */
  relays: string[];
  /** Default platform fee in basis points */
  defaultPlatformFeeBps?: number;
  /** Platform fee recipient pubkey */
  platformFeePubkey?: string;
  /** Default expiry in seconds */
  defaultExpirySeconds?: number;
  /** WebSocket implementation (for Node.js) */
  wsImpl?: typeof WebSocket;
}

// ══════════════════════════════════════════════════════════════════════════
// ESCROW CLIENT
// ══════════════════════════════════════════════════════════════════════════

export class EscrowClient {
  private relayManager: RelayManager;
  private signer: Signer;
  private config: EscrowClientConfig;
  private notifier: EscrowNotifier | null = null;
  /** Track which escrows are currently being reloaded to avoid duplicate reloads */
  private _reloading: Set<string> = new Set();
  /** CREATE-only public listings being hydrated before they reach Browse. */
  private _listingHydration: Set<string> = new Set();
  /** Buffer for events that arrived before their predecessors */
  private retryBuffer: Map<string, { event: NostrEvent; relay: string; attempts: number }[]> = new Map();
  private callbacks: EscrowClientCallbacks;

  /** Cached escrow states — escrowId → state */
  private states: Map<string, EscrowState> = new Map();

  /** Raw events per escrow — escrowId → events[] */
  private rawEvents: Map<string, NostrEvent[]> = new Map();

  /** Active subscriptions */
  private subscriptions: Map<string, string> = new Map(); // label → subId

  /** Our pubkey (cached after first call) */
  private _pubkey: string | null = null;

  /** Buffered events waiting for their predecessors — escrowId → events[] */
  private eventBuffer: Map<string, { event: NostrEvent; relay: string; attempts: number }[]> = new Map();

  constructor(
    signer: Signer,
    config: EscrowClientConfig,
    callbacks: EscrowClientCallbacks = {}
  ) {
    this.signer = signer;
    this.config = {
      defaultPlatformFeeBps: 50,
      defaultExpirySeconds: 86_400,
      ...config,
    };
    this.callbacks = callbacks;

    this.relayManager = new RelayManager(
      config.relays,
      {
        onEvent: (event, relay) => this.handleIncomingEvent(event, relay),
        onStatusChange: (relay, status) => this.callbacks.onRelayStatus?.(relay, status),
        onError: (err, relay) => console.warn(`[relay] ${relay}: ${err.message}`),
        // v0.4.2 sim mode (hotfix round 2): wire the chokepoint drop so
        // sim-tagged events never enter prod state via fetch-based paths
        // (loadEscrow's fetchEscrowEvents, raw fetchOnce). Defense in
        // depth — handleIncomingEvent still has its own check, but this
        // catches paths that bypass it entirely.
        shouldDropEvent: (event) => shouldDropForSimPolicy(event),
      },
      config.wsImpl
    );
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  connect(): void {
    this.relayManager.connect();

    this.notifier = new EscrowNotifier(this.signer, this.relayManager);
  }

  disconnect(): void {
    this.relayManager.disconnect();
    this.states.clear();
    this.rawEvents.clear();
  }

  async getPubkey(): Promise<string> {
    if (!this._pubkey) {
      this._pubkey = await this.signer.getPublicKey();
    }
    return this._pubkey;
  }

  /** Access the underlying signer (for auxiliary modules like seed-manager) */
  getSigner(): Signer {
    return this.signer;
  }

  /**
   * v0.4.2 sim mode: sign an event, but first stamp a `chama-sim` tag
   * if sim mode is active. The tag rides on every event the escrow
   * engine publishes so the receive side can isolate sim trades from
   * real ones cleanly (see handleIncomingEvent below for the drop
   * policy). Callers that previously used `this.signer.signEvent` for
   * an escrow-chain event should route through here. Raw-publish
   * paths (e.g. seed-manager) intentionally bypass — they don't
   * touch the trade chain and don't need the tag.
   */
  private async signWithSimTag(unsigned: UnsignedEvent): Promise<NostrEvent> {
    const simTag = simTagOrNull();
    if (simTag) {
      unsigned = { ...unsigned, tags: [...unsigned.tags, simTag] };
    }
    return this.signer.signEvent(unsigned);
  }

  // ── Raw Nostr helpers ───────────────────────────────────────────────────
  // These are used by auxiliary modules (e.g. the Fedimint seed manager)
  // that need to publish or query events outside the escrow event chain.

  /** Publish an already-signed Nostr event to all connected relays. */
  async publishRaw(event: NostrEvent): Promise<void> {
    await this.relayManager.publish(event);
  }

  /**
   * One-shot query for events matching a filter. Resolves after EOSE
   * from all connected relays, or after the timeout.
   */
  async queryOnce(
    filter: import("./relay-manager.js").NostrFilter,
    timeoutMs = 5_000
  ): Promise<NostrEvent[]> {
    return this.relayManager.fetchOnce(filter, timeoutMs);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // USER ACTIONS — One method per thing the UI can do
  // ══════════════════════════════════════════════════════════════════════════

  // ── Create a new escrow trade ───────────────────────────────────────────

  async createEscrow(params: {
    description: string;
    amountMsats: number;
    fiatAmount?: number;
    fiatCurrency?: string;
    category: string;
    /** PR 2: marketplace user picks; non-marketplace categories get
     *  "service" written by handleCreate regardless of what's passed. */
    fulfillment?: "physical" | "service" | "digital";
    /** PR 2: community slug from the static registry. Optional —
     *  pre-registry trades work but won't show a community pill. */
    community?: string;
    mintUrl: string;
    paymentMethods?: string[];
    arbiterFeeMsats?: number;
    expirySeconds?: number;
    communityArbiters?: string[];
    subscription?: {
      totalPeriods: number;
      periodAmountMsats: number;
      periodDurationSeconds: number;
    };
    // v0.1.72 federation gates ─────────────────────────────────────────
    /** Federation prefix (first 10 chars of a 1-sat probe). Locker captures via probeFederation(). */
    fedPrefix?: string;
    /** Full federation ID (hex). Locker captures via probeFederation(). */
    fed?: string;
  }): Promise<{ escrowId: string; state: EscrowState }> {
    const pubkey = await this.getPubkey();
    const now = Math.floor(Date.now() / 1000);
    const escrowId = this.generateEscrowId();

    // PR 2: normalize fulfillment so the wire payload matches what
    // handleCreate will store. Marketplace defaults to "physical" when
    // unspecified (form should still force a pick); other categories
    // get "service" regardless of input.
    const fulfillment: "physical" | "service" | "digital" =
      params.category === "marketplace"
        ? (params.fulfillment ?? "physical")
        : "service";

    const payload: CreatePayload = {
      type: "escrow:create",
      description: params.description,
      amountMsats: params.amountMsats,
      fiatAmount: params.fiatAmount,
      fiatCurrency: params.fiatCurrency,
      category: params.category,
      fulfillment,
      community: params.community,
      mintUrl: params.mintUrl,
      platformFeeBps: this.config.defaultPlatformFeeBps!,
      platformFeePubkey: this.config.platformFeePubkey || pubkey,
      arbiterFeeMsats: params.arbiterFeeMsats,
      paymentMethods: params.paymentMethods,
      expirySeconds: params.expirySeconds || this.config.defaultExpirySeconds!,
      communityArbiters: params.communityArbiters,
      // v0.1.72 federation gates: optional locker-fed identity
      fedPrefix: params.fedPrefix,
      fed: params.fed,
      createdAt: now,
    };

    // CREATE content is PLAINTEXT — trade terms are public (marketplace discovery).
    // Only LOCK/VOTE/CLAIM/CHAT events get NIP-44 encrypted.
    const content = JSON.stringify(payload);

    const unsigned: UnsignedEvent = {
      kind: EscrowEventKind.CREATE,
      created_at: now,
      tags: [
        [TAGS.ESCROW_ID, escrowId],
        [TAGS.TYPE, "escrow:create"],
        [TAGS.AMOUNT, String(params.amountMsats)],
        [TAGS.MINT, params.mintUrl],
        ...(params.fiatCurrency ? [[TAGS.CURRENCY, params.fiatCurrency]] : []),
        ...(params.category ? [[TAGS.CATEGORY, params.category]] : []),
        // PR 2: community + fulfillment as relay-filterable tags. Browse
        // can fan out a `#community` filter directly to relays without
        // pulling and decoding every CREATE.
        ...(params.community ? [[TAGS.COMMUNITY, params.community]] : []),
        [TAGS.FULFILLMENT, fulfillment],
        // v0.1.72 federation gates: tag the locker's fed for fast filtering
        ...(params.fedPrefix ? [[TAGS.FED_PREFIX, params.fedPrefix]] : []),
        ...(params.fed ? [[TAGS.FED, params.fed]] : []),
      ],
      content,
    };

    const signed = await this.signWithSimTag(unsigned);
    await this.relayManager.publish(signed);

    // Apply locally immediately (optimistic)
    const parsed = parseEscrowEvent(signed, JSON.stringify(payload), true);
    if (!parsed.ok) throw new Error(`Local parse failed: ${parsed.error.message}`);

    const result = applyEvent(null, parsed.event);
    if (!result.ok) throw new Error(`Local apply failed: ${result.error.message}`);

    this.states.set(escrowId, result.state);
    this.rawEvents.set(escrowId, [signed]);
    this.callbacks.onStateUpdate?.(escrowId, result.state);

    // Subscribe to this escrow's events
    this.watchEscrow(escrowId);

    // If subscription params provided, auto-publish SUBSCRIBE event
    if (params.subscription) {
      try {
        const subNow = Math.floor(Date.now() / 1000);
        const subPayload = {
          type: "escrow:subscribe" as const,
          totalPeriods: params.subscription.totalPeriods,
          periodAmountMsats: params.subscription.periodAmountMsats,
          periodDurationSeconds: params.subscription.periodDurationSeconds,
          description: params.description,
          startsAt: subNow,
        };
        const subContent = JSON.stringify(subPayload);
        const currentState = this.states.get(escrowId)!;
        const lastEvtId = currentState.eventChain[currentState.eventChain.length - 1]?.raw.id;
        const subUnsigned: UnsignedEvent = {
          kind: EscrowEventKind.SUBSCRIBE,
          created_at: subNow,
          tags: [
            [TAGS.ESCROW_ID, escrowId],
            [TAGS.PREV_EVENT, lastEvtId, "", "reply"],
            [TAGS.TYPE, "escrow:subscribe"],
          ],
          content: subContent,
        };
        const subSigned = await this.signWithSimTag(subUnsigned);
        await this.relayManager.publish(subSigned);
        this.applyLocally(escrowId, subSigned, subPayload);
        console.debug("[chama] SUBSCRIBE event published for", escrowId);
      } catch (e) {
        console.warn("[chama] Failed to publish SUBSCRIBE:", e);
      }
    }

    return { escrowId, state: this.states.get(escrowId)! };
  }

  // ── Join an existing escrow ─────────────────────────────────────────────

  async joinEscrow(escrowId: string, role: Role): Promise<EscrowState> {
    const state = this.states.get(escrowId);
    if (!state) throw new Error(`Escrow ${escrowId} not loaded`);

    const pubkey = await this.getPubkey();
    const existingRole = this.getMyRole(state, pubkey);
    if (existingRole) {
      const err: any = new Error(
        existingRole === role
          ? `You are already the ${existingRole} on this trade.`
          : `You are already the ${existingRole} on this trade, so you can't join as ${role}.`
      );
      err.code = "ALREADY_PARTICIPANT";
      err.role = existingRole;
      err.requestedRole = role;
      throw err;
    }
    if (state.initiator.pubkey === pubkey) {
      const err: any = new Error(
        `You created this trade as ${state.initiator.role}, so you can't join it as ${role}.`
      );
      err.code = "ALREADY_PARTICIPANT";
      err.role = state.initiator.role;
      err.requestedRole = role;
      throw err;
    }

    const now = Math.floor(Date.now() / 1000);
    const lastEventId = state.eventChain[state.eventChain.length - 1]?.raw.id;

    const payload: JoinPayload = {
      type: "escrow:join",
      role,
      joinedAt: now,
    };

    // JOIN content is PLAINTEXT — who joined is public info.
    const content = JSON.stringify(payload);

    const unsigned: UnsignedEvent = {
      kind: EscrowEventKind.JOIN,
      created_at: now,
      tags: [
        [TAGS.ESCROW_ID, escrowId],
        [TAGS.PREV_EVENT, lastEventId, "", "reply"],
        [TAGS.TYPE, "escrow:join"],
        [TAGS.PARTICIPANT, pubkey],
      ],
      content,
    };

    const signed = await this.signWithSimTag(unsigned);
    await this.relayManager.publish(signed);

    // JOIN is ACK-only in the atomic-funding model: it records the
    // joiner's pubkey on the chain but does not trigger any state
    // transition or notifier hook. LOCK is what moves the trade.
    return this.applyLocally(escrowId, signed, payload);
  }

  // ── Lock ecash in SSS escrow ────────────────────────────────────────────
  // The real lock flow runs through EscrowFedimintBridge.lockAndPublish,
  // which calls FedimintClient.createEscrowLock (real WASM spendNotes +
  // Shamir split) and then this.lockEscrow with the resulting shares.
  // Use that bridge from the UI layer. This class only handles the
  // Nostr event side.

  // PR 1 atomic funding: lockEscrow now requires buyerPubkey + arbiterPubkey
  // because LOCK is self-describing (no prior JOIN required to populate
  // participant slots). The bridge is responsible for picking the arbiter
  // from state.communityArbiters and supplying the buyer pubkey from
  // whichever source the locker has (prior JOIN ACK, or pre-lock invoice
  // metadata that names the buyer).
  // v0.1.71: lockEscrow no longer takes platformFeeMsats — platform fees
  // are collected via Lightning at trade completion.
  async lockEscrow(escrowId: string, params: {
    notesHash: string;
    shares: LockShareEntry[];
    sellerReceivesMsats: number;
    arbiterFeeMsats: number;
    buyerPubkey: string;
    arbiterPubkey: string;
    /** PR 3 handle reveal — all optional. The bridge resolves these
     *  from the seller's saved handles before calling. None of these
     *  apply to non-fiat trades (marketplace digital, raw escrow). */
    handleId?: string;
    handle?: string;
    rail?: string;
    /** v0.6.5: mobile-money networks the seller accepts on this handle
     *  ("m-pesa", "wave", etc.). Bridge pulls from saved handle. */
    handleNetworks?: string[];
  }): Promise<EscrowState> {
    const state = this.states.get(escrowId);
    if (!state) throw new Error(`Escrow ${escrowId} not loaded`);

    const now = Math.floor(Date.now() / 1000);
    const lastEventId = state.eventChain[state.eventChain.length - 1]?.raw.id;

    // PR 4: build the 3-recipient handle envelope when the locker
    // supplied handle data. Mirrors LockShareEntry.encryptedFor — each
    // participant gets a NIP-44 ciphertext of the handle JSON,
    // decryptable only by them. Locker is the sender (their pubkey is
    // the ECDH counterparty for all three decryption operations).
    const lockerPubkey = await this.getPubkey();
    let handleEnvelope: HandleEnvelope | undefined;
    if (params.handle) {
      const handleData = JSON.stringify({
        handleId: params.handleId,
        handle: params.handle,
        rail: params.rail,
        // v0.6.5: networks ride inside the same encrypted blob — never
        // on the wire as cleartext. Only set when present; absent in
        // pre-v0.6.5 trades and non-phone rails.
        ...(params.handleNetworks && params.handleNetworks.length > 0
          ? { networks: params.handleNetworks }
          : {}),
      });
      handleEnvelope = await createEnvelope(
        handleData,
        [params.buyerPubkey, lockerPubkey, params.arbiterPubkey],
        (pt, pk) => this.signer.nip44Encrypt(pt, pk),
      );
    }

    // Wire payload — envelope only. Top-level handle/handleId/rail are
    // omitted; receivers resolve from the envelope.
    const wirePayload: LockPayload = {
      type: "escrow:lock",
      notesHash: params.notesHash,
      shares: params.shares,
      sellerReceivesMsats: params.sellerReceivesMsats,
      arbiterFeeMsats: params.arbiterFeeMsats,
      buyerPubkey: params.buyerPubkey,
      arbiterPubkey: params.arbiterPubkey,
      handleEnvelope,
      lockedAt: now,
    };

    // PR 4: outer NIP-44 wrap removed for LOCK. The wrap was
    // single-recipient-to-locker — fundamentally incompatible with
    // 3-recipient distribution. Sensitive data is now per-recipient
    // encrypted INSIDE the payload (shares were already; handle joins
    // them via handleEnvelope). Wire content is plaintext JSON, same
    // as DEV mode behavior, now correct in PROD mode too.
    const content = JSON.stringify(wirePayload);

    const unsigned: UnsignedEvent = {
      kind: EscrowEventKind.LOCK,
      created_at: now,
      tags: [
        [TAGS.ESCROW_ID, escrowId],
        [TAGS.PREV_EVENT, lastEventId, "", "reply"],
        [TAGS.TYPE, "escrow:lock"],
      ],
      content,
    };

    const signed = await this.signWithSimTag(unsigned);
    await this.relayManager.publish(signed);

    // For local apply, we have the cleartext in scope — synthesize a
    // payload that includes BOTH the envelope (for wire fidelity in
    // eventChain replay) AND the top-level handle fields (so handleLock
    // can populate state.lock.handle without going through a decrypt
    // round-trip on our own envelope entry).
    const localPayload: LockPayload = {
      ...wirePayload,
      handleId: params.handleId,
      handle: params.handle,
      rail: params.rail,
      ...(params.handleNetworks && params.handleNetworks.length > 0
        ? { handleNetworks: params.handleNetworks }
        : {}),
    };
    const lockResult = this.applyLocally(escrowId, signed, localPayload);

    // Notify all participants that ecash is locked
    this.notifier?.onEscrowLocked(lockResult).catch(() => {});

    return lockResult;
  }

  // ── Cast a vote ─────────────────────────────────────────────────────────

  async vote(escrowId: string, outcome: Outcome): Promise<EscrowState> {
    const state = this.states.get(escrowId);
    if (!state) throw new Error(`Escrow ${escrowId} not loaded`);

    const pubkey = await this.getPubkey();
    const role = this.getMyRole(state, pubkey);
    if (!role) throw new Error("You are not a participant in this escrow");

    const voteCheck = canVote(state, pubkey);
    if (!voteCheck.canVote) throw new Error(`Cannot vote: ${voteCheck.reason}`);

    const now = Math.floor(Date.now() / 1000);
    const lastEventId = state.eventChain[state.eventChain.length - 1]?.raw.id;

    const payload: VotePayload = {
      type: "escrow:vote",
      outcome,
      role,
      votedAt: now,
    };

    // Conditionally encrypt VOTE content
    const content = await maybeEncrypt(
      payload, pubkey,
      (pt, pk) => this.signer.nip44Encrypt(pt, pk),
      ENCRYPTION_CONFIG.encryptVote,
    );

    const unsigned: UnsignedEvent = {
      kind: EscrowEventKind.VOTE,
      created_at: now,
      tags: [
        [TAGS.ESCROW_ID, escrowId],
        [TAGS.PREV_EVENT, lastEventId, "", "reply"],
        [TAGS.TYPE, "escrow:vote"],
      ],
      content,
    };

    const signed = await this.signWithSimTag(unsigned);
    await this.relayManager.publish(signed);

    const newState = this.applyLocally(escrowId, signed, payload);

    // Auto-resolve if 2-of-3 threshold is met.
    // Wrapped in try/catch — resolve failure must not break the vote.
    // If this fails, handleIncomingEvent will retry when the relay
    // delivers the VOTE to other browsers (or back to us).
    try {
      await this.maybeAutoResolve(escrowId);
    } catch (e) {
      console.warn("[escrow] Auto-resolve failed after vote — will retry on relay echo:", e);
      // Retry once after a short delay
      setTimeout(() => {
        this.maybeAutoResolve(escrowId).catch(e2 =>
          console.debug("[escrow] Auto-resolve retry also failed:", e2)
        );
      }, 2000);
    }

    return newState;
  }

  // ── Claim ecash (winner only) ───────────────────────────────────────────

  async claim(escrowId: string, notesHashVerification: string): Promise<EscrowState> {
    const state = this.states.get(escrowId);
    if (!state) throw new Error(`Escrow ${escrowId} not loaded`);

    const pubkey = await this.getPubkey();
    const winner = getWinner(state);
    if (!winner || winner.pubkey !== pubkey) {
      throw new Error("You are not the winner of this escrow");
    }

    const now = Math.floor(Date.now() / 1000);
    const lastEventId = state.eventChain[state.eventChain.length - 1]?.raw.id;

    const payload: ClaimPayload = {
      type: "escrow:claim",
      claimerRole: winner.role,
      notesHashVerification,
      claimedAt: now,
    };

    // Plaintext for testing. TODO: NIP-44 encrypt for production
    const content = JSON.stringify(payload);

    const unsigned: UnsignedEvent = {
      kind: EscrowEventKind.CLAIM,
      created_at: now,
      tags: [
        [TAGS.ESCROW_ID, escrowId],
        [TAGS.PREV_EVENT, lastEventId, "", "reply"],
        [TAGS.TYPE, "escrow:claim"],
      ],
      content,
    };

    const signed = await this.signWithSimTag(unsigned);
    await this.relayManager.publish(signed);

    return this.applyLocally(escrowId, signed, payload);
  }

  // ── Complete (winner confirms settlement finalized) ─────────────────────
  //
  // After a successful CLAIM + redeem, the winner publishes COMPLETE to
  // move the escrow into the terminal COMPLETED state. Without this, the
  // trade stays at CLAIMED forever and never reaches the defined terminal
  // state. COMPLETE takes no action beyond publishing the event and
  // transitioning local state — it's a protocol-level statement that
  // settlement is finalized.
  //
  // Only the winner publishes COMPLETE. Non-winners observe it via relay
  // echo. Duplicate COMPLETE events from multiple devices are benign —
  // replayEventChain classifies INVALID_STATE on COMPLETE as a benign-skip.

  async complete(escrowId: string): Promise<EscrowState> {
    const state = this.states.get(escrowId);
    if (!state) throw new Error(`Escrow ${escrowId} not loaded`);

    if (state.status !== EscrowStatus.CLAIMED) {
      throw new Error(`Cannot complete in state ${state.status} (need CLAIMED)`);
    }

    const pubkey = await this.getPubkey();
    const winner = getWinner(state);
    if (!winner || winner.pubkey !== pubkey) {
      throw new Error("Only the winner can publish COMPLETE");
    }

    const now = Math.floor(Date.now() / 1000);
    const lastEventId = state.eventChain[state.eventChain.length - 1]?.raw.id;

    const payload: CompletePayload = {
      type: "escrow:complete",
      completedAt: now,
    };

    // Plaintext for consistency with CLAIM. COMPLETE reveals nothing
    // beyond "this trade settled" which is already observable via the
    // presence of a kind 38106 event with the escrow's d-tag.
    const content = JSON.stringify(payload);

    const unsigned: UnsignedEvent = {
      kind: EscrowEventKind.COMPLETE,
      created_at: now,
      tags: [
        [TAGS.ESCROW_ID, escrowId],
        [TAGS.PREV_EVENT, lastEventId, "", "reply"],
        [TAGS.TYPE, "escrow:complete"],
      ],
      content,
    };

    const signed = await this.signWithSimTag(unsigned);
    await this.relayManager.publish(signed);

    return this.applyLocally(escrowId, signed, payload);
  }

  // ── Send a chat message ─────────────────────────────────────────────────

  async sendChat(
    escrowId: string,
    input: string | { message: string; attachments?: ChatImageAttachment[] },
  ): Promise<void> {
    const state = this.states.get(escrowId);
    if (!state) throw new Error(`Escrow ${escrowId} not loaded`);

    const pubkey = await this.getPubkey();
    const role = this.getMyRole(state, pubkey);
    if (!role) throw new Error("You are not a participant in this escrow");

    const now = Math.floor(Date.now() / 1000);
    const message = (typeof input === "string" ? input : input.message).trim();
    const attachments = typeof input === "string"
      ? undefined
      : input.attachments?.filter(a =>
          a.kind === "image" &&
          typeof a.id === "string" &&
          a.mimeType.startsWith("image/") &&
          a.dataUrl.startsWith("data:image/"),
        );
    if (!message && (!attachments || attachments.length === 0)) {
      throw new Error("Chat message cannot be empty");
    }

    const chatBody: ChatBody = {
      message,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    };
    const recipients = [
      state.participants.buyer,
      state.participants.seller,
      state.participants.arbiter,
    ].filter((pk): pk is string => typeof pk === "string" && pk.length > 0);
    const bodyEnvelope = await createEnvelope(
      JSON.stringify(chatBody),
      recipients,
      (pt, pk) => this.signer.nip44Encrypt(pt, pk),
    );

    const payload: ChatPayload = {
      type: "escrow:chat",
      message: "",
      bodyEnvelope,
      senderRole: role,
      sentAt: now,
    };

    const content = JSON.stringify(payload);

    const unsigned: UnsignedEvent = {
      kind: EscrowEventKind.CHAT,
      created_at: now,
      tags: [
        [TAGS.ESCROW_ID, escrowId],
        [TAGS.TYPE, "escrow:chat"],
      ],
      content,
    };

    const signed = await this.signWithSimTag(unsigned);
    await this.relayManager.publish(signed);

    // Apply chat locally for instant display (don't wait for relay echo)
    const localPayload: ChatPayload = {
      ...payload,
      message: chatBody.message,
      attachments: chatBody.attachments,
    };
    const chatParsed = parseEscrowEvent(signed, JSON.stringify(localPayload), true);
    if (chatParsed.ok) {
      const currentChatState = this.states.get(escrowId);
      if (currentChatState) {
        const chatResult = applyEvent(currentChatState, chatParsed.event);
        if (chatResult.ok) {
          this.states.set(escrowId, chatResult.state);
          this.callbacks.onStateUpdate?.(escrowId, chatResult.state);
        }
      }
    }
  }

  // ── Cancel (initiator only, pre-lock) ───────────────────────────────────

  async cancel(escrowId: string, reason?: string): Promise<EscrowState> {
    const state = this.states.get(escrowId);
    if (!state) throw new Error(`Escrow ${escrowId} not loaded`);

    const pubkey = await this.getPubkey();
    if (pubkey !== state.initiator.pubkey) {
      throw new Error("Only the initiator can cancel");
    }

    const role = this.getMyRole(state, pubkey);
    const now = Math.floor(Date.now() / 1000);
    const lastEventId = state.eventChain[state.eventChain.length - 1]?.raw.id;

    const payload: CancelPayload = {
      type: "escrow:cancel",
      cancellerRole: role!,
      reason,
      cancelledAt: now,
    };

    // Plaintext for testing. TODO: NIP-44 encrypt for production
    const content = JSON.stringify(payload);

    const unsigned: UnsignedEvent = {
      kind: EscrowEventKind.CANCEL,
      created_at: now,
      tags: [
        [TAGS.ESCROW_ID, escrowId],
        [TAGS.PREV_EVENT, lastEventId, "", "reply"],
        [TAGS.TYPE, "escrow:cancel"],
      ],
      content,
    };

    const signed = await this.signWithSimTag(unsigned);
    await this.relayManager.publish(signed);

    return this.applyLocally(escrowId, signed, payload);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STATE QUERIES — Read-only access for the UI
  // ══════════════════════════════════════════════════════════════════════════

  getState(escrowId: string): EscrowState | null {
    return this.states.get(escrowId) || null;
  }

  getAllStates(): Map<string, EscrowState> {
    return new Map(this.states);
  }

  getMyRole(state: EscrowState, pubkey?: string): Role | null {
    const pk = pubkey || this._pubkey;
    if (!pk) return null;
    if (state.participants[Role.BUYER] === pk) return Role.BUYER;
    if (state.participants[Role.SELLER] === pk) return Role.SELLER;
    if (state.participants[Role.ARBITER] === pk) return Role.ARBITER;
    return null;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ESCROW DISCOVERY — Watch for trades and load state
  // ══════════════════════════════════════════════════════════════════════════

  /** Subscribe to live updates for a specific escrow */
  watchEscrow(escrowId: string): void {
    const label = `escrow:${escrowId}`;
    if (this.subscriptions.has(label)) return;
    const subId = this.relayManager.subscribeToEscrow(escrowId);
    this.subscriptions.set(label, subId);
  }

  /** Stop watching a specific escrow */
  unwatchEscrow(escrowId: string): void {
    const label = `escrow:${escrowId}`;
    const subId = this.subscriptions.get(label);
    if (subId) {
      this.relayManager.unsubscribe(subId);
      this.subscriptions.delete(label);
    }
  }

  /**
   * Subscribe to all public trade listings (CREATE events) across relays.
   * Powers the Browse tab. Events flow through the same onStateUpdate
   * callback as individual escrow watches — the UI filters by "user is
   * not a participant" to split Browse from My trades.
   *
   * Idempotent: safe to call multiple times.
   *
   * @param since Unix timestamp. Default: 7 days ago.
   */
  watchPublicListings(since?: number): void {
    const label = "public-listings";
    if (this.subscriptions.has(label)) return;
    const subId = this.relayManager.subscribeToPublicListings(since);
    this.subscriptions.set(label, subId);
  }

  /** Stop the Browse feed subscription. */
  unwatchPublicListings(): void {
    const label = "public-listings";
    const subId = this.subscriptions.get(label);
    if (subId) {
      this.relayManager.unsubscribe(subId);
      this.subscriptions.delete(label);
    }
  }

  /** Fetch and reconstruct full escrow state from relays */
  async loadEscrow(escrowId: string): Promise<EscrowState | null> {
    const rawEvents = await this.relayManager.fetchEscrowEvents(escrowId);
    console.debug(`[escrow] loadEscrow ${escrowId}: fetched ${rawEvents.length} raw events from relays`);
    if (rawEvents.length === 0) return null;

    // Parse all events — try plaintext JSON first, then NIP-44 decrypt.
    // CREATE and JOIN are plaintext; LOCK/VOTE/CLAIM/CHAT are encrypted.
    const parsed: ParsedEscrowEvent[] = [];
    for (const raw of rawEvents) {
      let content: string | null = null;

      // Try 1: plaintext JSON — accept any valid JSON with a type field
      // The event parser will validate the specific type later.
      try {
        const test = JSON.parse(raw.content);
        if (test && typeof test.type === "string") {
          content = raw.content;
        }
      } catch {
        // Not valid JSON — likely NIP-44 encrypted
      }

      // Try 2: NIP-44 decrypt — only if content looks like actual ciphertext
      if (!content) {
        const looksEncrypted = raw.content.length > 0 
          && !raw.content.startsWith("{") 
          && !raw.content.startsWith("[");
        if (looksEncrypted) {
          try {
            content = await this.signer.nip44Decrypt(raw.content, raw.pubkey);
          } catch {
            console.debug(`[escrow] Decrypt failed for ${raw.id.slice(0, 8)}, skipping`);
            continue;
          }
        } else {
          // Looks like JSON but didn't pass the type check — skip
          console.debug(`[escrow] Skipping non-escrow JSON event ${raw.id.slice(0, 8)}`);
          continue;
        }
      }

      const result = parseEscrowEvent(raw, content, true);
      if (result.ok) parsed.push(result.event);
    }

    console.debug(`[escrow] loadEscrow ${escrowId}: parsed ${parsed.length}/${rawEvents.length} events`,
      parsed.map(e => `kind:${e.kind}`).join(', '));
    if (parsed.length === 0) return null;

    // Resolve only LOCK handle envelopes first, then preflight the
    // state-changing chain before decrypting CHAT bodies. Old invalid
    // escrow histories can contain image receipts; decrypting those before
    // we know the chain is usable causes signer extensions to dump huge
    // base64 payloads into the console.
    const lockResolvedParsed: ParsedEscrowEvent[] = [];
    for (const event of parsed) {
      lockResolvedParsed.push(await this.resolveLockEnvelope(event));
    }
    const preflightSorted = sortEventChain(
      lockResolvedParsed.filter((event) => event.kind !== EscrowEventKind.CHAT),
    );
    const preflight = replayEventChain(preflightSorted);
    if (!preflight.ok) {
      console.debug(`[escrow] loadEscrow ${escrowId}: replay skipped historical invalid chain — ${preflight.error.code}: ${preflight.error.message}`);
      this.callbacks.onValidationError?.(escrowId, preflight.error.message, preflight.error.eventId);
      console.debug(`[escrow] Kept failed escrow ${escrowId} in saved list for later recovery/rehydration`);
      return null;
    }

    // Resolve CHAT body/receipt attachments only after the chain preflight
    // succeeds. Sequential await keeps a slow signer from fanning out into
    // many concurrent NIP-44 calls.
    const readableParsed: ParsedEscrowEvent[] = [];
    for (const event of lockResolvedParsed) {
      const resolved = await this.resolveChatEnvelope(event);
      if (resolved) readableParsed.push(resolved);
    }

    // Sort by dependency chain and replay
    const sorted = sortEventChain(readableParsed);
    console.debug(`[escrow] loadEscrow ${escrowId}: sorted chain`, 
      sorted.map(e => `kind:${e.kind}(${e.raw.id.slice(0,6)})`).join(' → '));
    const result = replayEventChain(sorted);

    if (!result.ok) {
      console.debug(`[escrow] loadEscrow ${escrowId}: replay FAILED — ${result.error.code}: ${result.error.message}`);
      this.callbacks.onValidationError?.(escrowId, result.error.message, result.error.eventId);
      // Money-path safety: a replay failure can be caused by partial relay
      // history, late events, or an invalid remote event. Keep the local
      // pointer so later rehydration or recovery surfaces can still find it.
      console.debug(`[escrow] Kept failed escrow ${escrowId} in saved list for later recovery/rehydration`);
      return null;
    }
    console.debug(`[escrow] loadEscrow ${escrowId}: replay OK — state is ${result.state.status}`);

    this.states.set(escrowId, result.state);
    this.rawEvents.set(escrowId, rawEvents);

    // Notify UI of the reconstructed state
    this.callbacks.onStateUpdate?.(escrowId, result.state);

    // Start watching for live updates
    this.watchEscrow(escrowId);

    // After replay, check if auto-resolve should trigger
    if (result.state.status === EscrowStatus.LOCKED) {
      this.maybeAutoResolve(escrowId).catch(e =>
        console.debug("[escrow] Post-reload auto-resolve:", e?.message || e)
      );
      // Check if the escrow has expired — auto-vote REFUND if so
      this.maybeAutoRefundExpired(escrowId).catch(e =>
        console.debug("[escrow] Post-reload expiry check:", e?.message || e)
      );
    }

    // v0.1.65: also heal EXPIRED on load — for trades that flipped to
    // EXPIRED while everyone was offline. maybeAutoRefundExpired's own
    // guard now accepts EXPIRED-without-RESOLVE, so this is safe.
    if (result.state.status === EscrowStatus.EXPIRED) {
      this.maybeAutoRefundExpired(escrowId).catch(e =>
        console.debug("[escrow] Post-reload heal-on-load:", e?.message || e)
      );
    }

    return result.state;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // INTERNAL — Event processing pipeline
  // ══════════════════════════════════════════════════════════════════════════

  /** Handle an incoming event from any relay */
  private async handleIncomingEvent(event: NostrEvent, relayUrl: string): Promise<void> {
    // Check if this is an escrow event kind
    const validKinds = new Set(Object.values(EscrowEventKind).filter(v => typeof v === "number"));
    if (!validKinds.has(event.kind)) return;

    // v0.4.2 sim mode: a sim-tagged event is only valid for a sim-mode
    // client, and vice versa. We can't filter at the relay-filter level
    // for the "drop sim in prod" direction (NIP-01 has no NOT-has-tag
    // operator), so the drop happens here on receive. Cheap — tag scan
    // happens before any decrypt or state-machine work.
    if (shouldDropForSimPolicy(event)) return;

    // Extract escrow ID from d-tag
    const dTag = event.tags.find(t => t[0] === TAGS.ESCROW_ID);
    if (!dTag?.[1]) return;
    const escrowId = dTag[1];

    // Try plaintext JSON first (CREATE, JOIN), then NIP-44 decrypt (LOCK, VOTE, etc.)
    let decrypted: string | null = null;
    try {
      const test = JSON.parse(event.content);
      if (test && typeof test.type === "string" && test.type.startsWith("escrow:")) {
        decrypted = event.content;
      }
    } catch {
      // Not plaintext JSON — try NIP-44
    }
    if (!decrypted) {
      // Only attempt NIP-44 decrypt if content looks like actual ciphertext
      // (base64-ish string, not plaintext JSON that failed the type check)
      const looksEncrypted = event.content.length > 0 
        && !event.content.startsWith("{") 
        && !event.content.startsWith("[");
      if (looksEncrypted) {
        try {
          decrypted = await this.signer.nip44Decrypt(event.content, event.pubkey);
        } catch {
          // Can't decrypt — encrypted to another participant, ignore
          return;
        }
      } else {
        // Plaintext but didn't pass the type check — skip
        return;
      }
    }

    // Parse
    const parseResult = parseEscrowEvent(event, decrypted, true);
    if (!parseResult.ok) {
      this.callbacks.onValidationError?.(escrowId, parseResult.error.message, event.id);
      return;
    }

    // PR 4: resolve any LOCK handle envelope before applyEvent. The
    // state machine reads handle/handleId/rail at the top level of the
    // payload (whether they came from a legacy PR 3 wire or were
    // synthesized from a PR 4 envelope decrypt). This is the seam.
    const parsed = await this.resolveParticipantEnvelope(parseResult.event);
    if (!parsed) return;

    // Handle chat separately
    if (parsed.kind === EscrowEventKind.CHAT) {
      const state = this.states.get(escrowId);
      if (state) {
        // Dedup: skip if this chat message was already applied locally (sender echo)
        const alreadyHave = state.chatMessages.some(m => m.raw.id === event.id);
        if (alreadyHave) return;

        const result = applyEvent(state, parsed);
        if (result.ok) {
          this.states.set(escrowId, result.state);
          this.callbacks.onChatMessage?.(escrowId, parsed as ParsedEscrowEvent<ChatPayload>);
        }
      }
      return;
    }

    const currentState = this.states.get(escrowId) || null;

    // Public Browse discovery starts from plaintext CREATE events, but a
    // CREATE by itself is not proof the listing is still open. Hydrate the
    // full chain before surfacing a never-seen escrow so completed/cancelled
    // trades do not resurrect as stale OPEN tiles on login.
    if (parsed.kind === EscrowEventKind.CREATE && !currentState) {
      if (!this._listingHydration.has(escrowId)) {
        this._listingHydration.add(escrowId);
        this.loadEscrow(escrowId)
          .catch(e => console.debug(
            `[escrow] Listing hydration failed for ${escrowId}:`,
            (e as Error)?.message || e,
          ))
          .finally(() => this._listingHydration.delete(escrowId));
      }
      return;
    }

    // Apply to state machine
    const result = applyEvent(currentState, parsed);

    if (result.ok) {
      this.states.set(escrowId, result.state);

      // Store raw event
      const existing = this.rawEvents.get(escrowId) || [];
      existing.push(event);
      this.rawEvents.set(escrowId, existing);

      this.callbacks.onStateUpdate?.(escrowId, result.state);

      // Flush retry buffer — previously rejected events may now apply
      this.flushRetryBuffer(escrowId);

      // If we just received a VOTE and the threshold is now met,
      // ANY browser can publish the RESOLVE — not just the voter.
      // This is the key redundancy: if the voter's auto-resolve failed,
      // the next browser to see the vote picks up the slack.
      if (parsed.kind === EscrowEventKind.VOTE) {
        this.maybeAutoResolve(escrowId).catch(e =>
          console.debug("[escrow] Incoming-vote auto-resolve failed:", e)
        );
      }

      // Flush buffered events — predecessors may now be in the chain
      this.flushEventBuffer(escrowId);
    } else if (result.error.code === "NO_STATE") {
      // Event arrived for an escrow we haven't loaded — buffer it
      this.bufferEvent(escrowId, event, relayUrl);
    } else if (["INVALID_STATE", "NOT_PARTICIPANT", "THRESHOLD_NOT_MET"].includes(result.error.code)) {
      // Out-of-order event — reload full state from relays
      // This is more reliable than buffering because it fetches ALL events,
      // sorts by chain order, and replays the complete sequence.
      if (!this._reloading.has(escrowId)) {
        this._reloading.add(escrowId);
        console.debug(`[escrow] Out-of-order event ${event.id.slice(0, 8)} (${result.error.code}) — reloading ${escrowId} from relays`);
        // Small delay to let more events arrive before reloading
        setTimeout(async () => {
          try {
            await this.loadEscrow(escrowId);
            console.debug(`[escrow] Reloaded ${escrowId} from relays — state is now ${this.states.get(escrowId)?.status}`);
          } catch (e) {
            console.warn(`[escrow] Reload failed for ${escrowId}:`, e);
          } finally {
            this._reloading.delete(escrowId);
          }
        }, 1500);
      }
    } else {
      // Permanent rejection (DUPLICATE_CREATE, ALREADY_VOTED, etc.) — just log
      console.debug(`[escrow] Rejected event ${event.id.slice(0, 8)}: ${result.error.code}`);
    }
  }

  /** Buffer an event for later retry */
  private bufferEvent(escrowId: string, event: NostrEvent, relay: string): void {
    const buf = this.eventBuffer.get(escrowId) || [];
    // Don't buffer duplicates
    if (buf.some(b => b.event.id === event.id)) return;
    // Max 20 buffered events per escrow
    if (buf.length >= 20) return;
    buf.push({ event, relay, attempts: 0 });
    this.eventBuffer.set(escrowId, buf);
  }

  /** Try to apply buffered events after a state change */
  private async flushEventBuffer(escrowId: string): Promise<void> {
    const buf = this.eventBuffer.get(escrowId);
    if (!buf || buf.length === 0) return;

    const remaining: typeof buf = [];
    for (const entry of buf) {
      entry.attempts++;
      try {
        await this.handleIncomingEvent(entry.event, entry.relay);
      } catch {
        // Still can't apply — keep in buffer if under retry limit
        if (entry.attempts < 5) remaining.push(entry);
      }
    }

    if (remaining.length > 0) {
      this.eventBuffer.set(escrowId, remaining);
    } else {
      this.eventBuffer.delete(escrowId);
    }
  }

  /** Apply a locally-created event optimistically */
  /**
   * Flush the retry buffer for an escrow — re-process buffered events
   * that were rejected due to out-of-order delivery.
   */
  private async flushRetryBuffer(escrowId: string): Promise<void> {
    const buffer = this.retryBuffer.get(escrowId);
    if (!buffer || buffer.length === 0) return;

    // Take all buffered events and clear the buffer
    const toRetry = [...buffer];
    this.retryBuffer.set(escrowId, []);

    let applied = 0;
    for (const entry of toRetry) {
      entry.attempts++;
      if (entry.attempts > 10) {
        // Too many retries — drop it
        console.warn(`[escrow] Dropping event ${entry.event.id.slice(0, 8)} after ${entry.attempts} retries`);
        continue;
      }
      // Re-process through the full handler
      await this.handleIncomingEvent(entry.event, entry.relay);
      applied++;
    }

    if (applied > 0) {
      console.debug(`[escrow] Flushed ${applied} buffered events for ${escrowId}`);
    }
  }

  private async resolveParticipantEnvelope(parsed: ParsedEscrowEvent): Promise<ParsedEscrowEvent | null> {
    const withLockEnvelope = await this.resolveLockEnvelope(parsed);
    return this.resolveChatEnvelope(withLockEnvelope);
  }

  /** PR 4: resolve a LOCK event's handleEnvelope (if present) into
   *  top-level handle/handleId/rail fields on the parsed payload. The
   *  state machine reads from those top-level fields; this seam lets
   *  the wire format use a 3-recipient envelope without leaking that
   *  detail into the pure handler.
   *
   *  Behavior:
   *   - Non-LOCK events: returned unchanged.
   *   - LOCK without handleEnvelope: unchanged (legacy PR 3 wire format
   *     with top-level handle fields still works; LOCKs without handle
   *     data have no fields to populate).
   *   - LOCK with handleEnvelope: decrypts viewer's entry, parses the
   *     JSON {handleId?, handle, rail?}, returns a payload-mutated copy
   *     with those fields synthesized at the top level.
   *   - Decrypt failure (not a recipient, malformed ciphertext, wrong
   *     sender): returns unchanged. handleLock will see no top-level
   *     handle and leave state.lock.handle null. Non-participants
   *     transit this path silently. */
  private async resolveLockEnvelope(parsed: ParsedEscrowEvent): Promise<ParsedEscrowEvent> {
    if (parsed.kind !== EscrowEventKind.LOCK) return parsed;
    const lockPayload = parsed.payload as LockPayload;
    if (!lockPayload.handleEnvelope) return parsed;
    // Already resolved (locker's local apply path populates both)
    if (lockPayload.handle) return parsed;

    let myPubkey: string;
    try {
      myPubkey = await this.getPubkey();
    } catch {
      return parsed;
    }

    const cleartext = await decryptFromEnvelope(
      lockPayload.handleEnvelope,
      myPubkey,
      parsed.pubkey,
      (ct, sender) => this.signer.nip44Decrypt(ct, sender),
    );
    if (cleartext === null) return parsed;

    let handleData: {
      handleId?: string;
      handle?: string;
      rail?: string;
      networks?: string[];
    };
    try {
      handleData = JSON.parse(cleartext);
    } catch {
      return parsed;
    }
    if (typeof handleData.handle !== "string" || handleData.handle.length === 0) {
      return parsed;
    }
    // v0.6.5: networks is optional; tolerate absent/malformed shapes.
    const networks = Array.isArray(handleData.networks)
      ? handleData.networks.filter((n: unknown): n is string => typeof n === "string")
      : undefined;

    return {
      ...parsed,
      payload: {
        ...lockPayload,
        handleId: handleData.handleId,
        handle: handleData.handle,
        rail: handleData.rail,
        ...(networks && networks.length > 0 ? { handleNetworks: networks } : {}),
      },
    };
  }

  /** Resolve encrypted CHAT bodyEnvelope into cleartext message and
   *  attachments for this viewer. Legacy plaintext CHAT events (no
   *  envelope) pass through unchanged. If an enveloped chat cannot be
   *  decrypted by this signer, return null so replay/live handling skips
   *  it rather than displaying a blank receipt shell. */
  private async resolveChatEnvelope(parsed: ParsedEscrowEvent): Promise<ParsedEscrowEvent | null> {
    if (parsed.kind !== EscrowEventKind.CHAT) return parsed;
    const chatPayload = parsed.payload as ChatPayload;
    if (!chatPayload.bodyEnvelope) return parsed;
    if (chatPayload.message || (chatPayload.attachments?.length ?? 0) > 0) return parsed;

    let myPubkey: string;
    try {
      myPubkey = await this.getPubkey();
    } catch {
      return null;
    }

    const cleartext = await decryptFromEnvelope(
      chatPayload.bodyEnvelope,
      myPubkey,
      parsed.pubkey,
      (ct, sender) => this.signer.nip44Decrypt(ct, sender),
    );
    if (cleartext === null) return null;

    let body: ChatBody;
    try {
      body = JSON.parse(cleartext);
    } catch {
      return null;
    }
    if (typeof body.message !== "string") return null;
    const attachments = Array.isArray(body.attachments)
      ? body.attachments.filter((a): a is ChatImageAttachment =>
          a?.kind === "image" &&
          typeof a.id === "string" &&
          typeof a.mimeType === "string" &&
          a.mimeType.startsWith("image/") &&
          typeof a.dataUrl === "string" &&
          a.dataUrl.startsWith("data:image/"),
        )
      : undefined;

    return {
      ...parsed,
      payload: {
        ...chatPayload,
        message: body.message,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      },
    };
  }

  private applyLocally(escrowId: string, signed: NostrEvent, payload: EscrowPayload): EscrowState {
    const parsed = parseEscrowEvent(signed, JSON.stringify(payload), true);
    if (!parsed.ok) throw new Error(`Local parse failed: ${parsed.error.message}`);

    const currentState = this.states.get(escrowId) || null;
    const result = applyEvent(currentState, parsed.event);
    if (!result.ok) throw new Error(`Local apply failed: ${result.error.message}`);

    this.states.set(escrowId, result.state);

    const existing = this.rawEvents.get(escrowId) || [];
    existing.push(signed);
    this.rawEvents.set(escrowId, existing);

    this.callbacks.onStateUpdate?.(escrowId, result.state);

    return result.state;
  }

  /**
   * Check if a LOCKED escrow has expired and auto-vote REFUND.
   * This is called periodically and after loadEscrow.
   * Any participant (especially community arbiters) can trigger this.
   * 
   * Expiry policy:
   *   - Pre-lock (CREATED/FUNDED): state machine handles → EXPIRED
   *   - Post-lock (LOCKED): arbiter auto-votes REFUND → buyer gets sats back
   *   - APPROVED/CLAIMED: never expire (let the claim complete)
   */
  private async maybeAutoRefundExpired(escrowId: string): Promise<void> {
    const state = this.states.get(escrowId);
    if (!state) return;

    // v0.1.65: heal-on-load — allow EXPIRED without RESOLVE
    // ──────────────────────────────────────────────────────
    // Previously this only fired on LOCKED. But if all participants
    // were offline at expiry, the state machine implicitly advances to
    // EXPIRED via timestamp checks, and this guard would then reject
    // any healing attempt. We now also accept EXPIRED trades that
    // haven't published a RESOLVE yet — the first participant back
    // online after expiry heals the chain by publishing REFUND.
    //
    // CLAIMED/COMPLETED/CANCELLED are still skipped (RESOLVE already
    // happened or the trade never got locked). APPROVED is skipped
    // because the winner's claim is the next legitimate event.
    const isStuckLocked = state.status === EscrowStatus.LOCKED;
    const isStuckExpired =
      state.status === EscrowStatus.EXPIRED &&
      !state.eventChain.some(e => e.kind === EscrowEventKind.RESOLVE);
    if (!isStuckLocked && !isStuckExpired) return;

    const now = Math.floor(Date.now() / 1000);
    if (now <= state.expiresAt) return;

    // Check if we're a participant who can vote
    const myPubkey = await this.signer.getPublicKey();
    const myRole = Object.entries(state.participants).find(([, pk]) => pk === myPubkey)?.[0] as Role | undefined;
    if (!myRole) return;

    // Check if we already voted
    if (state.votes[myRole]) return;

    // Auto-vote REFUND on expired escrow
    console.debug(`[escrow] Escrow ${escrowId} expired — auto-voting REFUND as ${myRole}`);

    try {
      await this.vote(escrowId, Outcome.REFUND);
      console.debug(`[escrow] Auto-REFUND vote published for expired ${escrowId}`);
    } catch (e) {
      console.debug(`[escrow] Auto-REFUND vote failed for ${escrowId}:`, e);
    }
  }

  /** After a vote, check if 2-of-3 threshold is met and auto-publish RESOLVE */
  private async maybeAutoResolve(escrowId: string): Promise<void> {
    const state = this.states.get(escrowId);
    if (!state) return;
    // v0.1.66.26: accept EXPIRED in addition to LOCKED so healing votes
    // that meet 2-of-3 threshold trigger a RESOLVE publish. Without
    // this, healing votes land but never produce a RESOLVE event, and
    // the trade stays stuck in EXPIRED with 2 votes recorded.
    if (state.status !== EscrowStatus.LOCKED && state.status !== EscrowStatus.EXPIRED) return;
    // Skip if a RESOLVE event already exists in the chain
    if (state.eventChain.some(e => e.kind === EscrowEventKind.RESOLVE)) return;

    // Count matching votes
    const votes = Object.entries(state.votes) as [Role, Outcome][];
    if (votes.length < 2) return;

    const releasers = votes.filter(([, o]) => o === Outcome.RELEASE).map(([r]) => r);
    const refunders = votes.filter(([, o]) => o === Outcome.REFUND).map(([r]) => r);

    let outcome: Outcome | null = null;
    let majority: [Role, Role] | null = null;
    let arbiterInvolved = false;

    if (releasers.length >= 2) {
      outcome = Outcome.RELEASE;
      majority = [releasers[0], releasers[1]];
      arbiterInvolved = releasers.includes(Role.ARBITER);
    } else if (refunders.length >= 2) {
      outcome = Outcome.REFUND;
      majority = [refunders[0], refunders[1]];
      arbiterInvolved = refunders.includes(Role.ARBITER);
    }

    if (!outcome || !majority) return;

    // Publish RESOLVE event
    const pubkey = await this.getPubkey();
    const now = Math.floor(Date.now() / 1000);
    const lastEventId = state.eventChain[state.eventChain.length - 1]?.raw.id;

    const payload: ResolvePayload = {
      type: "escrow:resolve",
      outcome,
      majority,
      arbiterInvolved,
      resolvedAt: now,
    };

    const content = JSON.stringify(payload);

    const unsigned: UnsignedEvent = {
      kind: EscrowEventKind.RESOLVE,
      created_at: now,
      tags: [
        [TAGS.ESCROW_ID, escrowId],
        [TAGS.PREV_EVENT, lastEventId, "", "reply"],
        [TAGS.TYPE, "escrow:resolve"],
      ],
      content,
    };

    const signed = await this.signWithSimTag(unsigned);
    await this.relayManager.publish(signed);

    this.applyLocally(escrowId, signed, payload);
  }

  // ── Release a subscription period ─────────────────────────────────────

  async releasePeriod(escrowId: string, periodIndex: number): Promise<EscrowState> {
    const state = this.states.get(escrowId);
    if (!state) throw new Error("Escrow " + escrowId + " not loaded");
    if (!state.subscription) throw new Error("This escrow is not a subscription");

    const pubkey = await this.getPubkey();
    const role = this.getMyRole(state, pubkey);
    if (!role) throw new Error("You are not a participant in this escrow");

    const sub = state.subscription;
    if (periodIndex < 0 || periodIndex >= sub.totalPeriods) {
      throw new Error("Period " + periodIndex + " out of range");
    }
    if (sub.periodStatuses[periodIndex] === "released") {
      throw new Error("Period " + (periodIndex + 1) + " already released");
    }

    const now = Math.floor(Date.now() / 1000);
    const lastEventId = state.eventChain[state.eventChain.length - 1]?.raw.id;

    const payload: PeriodReleasePayload = {
      type: "escrow:period_release",
      periodIndex,
      amountMsats: sub.periodAmountMsats,
      triggeredBy: role,
      releasedAt: now,
    };

    const content = JSON.stringify(payload);

    const unsigned: UnsignedEvent = {
      kind: EscrowEventKind.PERIOD_RELEASE,
      created_at: now,
      tags: [
        [TAGS.ESCROW_ID, escrowId],
        [TAGS.PREV_EVENT, lastEventId, "", "reply"],
        [TAGS.TYPE, "escrow:period_release"],
      ],
      content,
    };

    const signed = await this.signWithSimTag(unsigned);
    await this.relayManager.publish(signed);

    return this.applyLocally(escrowId, signed, payload);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private generateEscrowId(): string {
    // Deterministic-ish but unique: timestamp + random bytes
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 10);
    return `sm_${ts}_${rand}`;
  }
}
