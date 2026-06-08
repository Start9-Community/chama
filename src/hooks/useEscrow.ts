// ══════════════════════════════════════════════════════════════════════════
// useEscrow — React hook connecting UI to the Nostr escrow engine
// ══════════════════════════════════════════════════════════════════════════

// ── localStorage helpers for escrow ID persistence ────────────────────────
const LEGACY_STORAGE_KEY = "chama_escrow_ids";
const MAX_SAVED_ESCROW_IDS = 50;
const FEDIMINT_WALLET_NOT_READY =
  "Chama wallet disconnected. Tap Reconnect and try again.";
const FEDI_ECASH_UNAVAILABLE =
  "Fedi wallet ecash funding is not available in this Fedi build. Chama did not create a Lightning invoice. Update Fedi, or use the Android APK/Tauri for this trade.";

function describeError(error: unknown, fallback: string): string {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (error && typeof error === "object") {
    try {
      const json = JSON.stringify(error);
      if (json && json !== "{}") return json;
    } catch {}
  }
  return fallback;
}

function isFediMiniAppRuntime(): boolean {
  if (typeof window !== "undefined" && Boolean((window as any).fediInternal)) return true;
  if (typeof navigator === "undefined") return false;
  return /\bFedi\b/i.test(navigator.userAgent || "");
}

function escrowStorageKey(pubkey?: string | null): string {
  return pubkey ? `${LEGACY_STORAGE_KEY}:${pubkey}` : LEGACY_STORAGE_KEY;
}

function parseSavedEscrowIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch { return []; }
}

function getSavedEscrowIds(pubkey?: string | null): string[] {
  try {
    return parseSavedEscrowIds(localStorage.getItem(escrowStorageKey(pubkey)));
  } catch { return []; }
}

function saveEscrowId(id: string, pubkey?: string | null) {
  try {
    const ids = getSavedEscrowIds(pubkey);
    if (!ids.includes(id)) {
      ids.unshift(id); // newest first
      localStorage.setItem(escrowStorageKey(pubkey), JSON.stringify(ids.slice(0, MAX_SAVED_ESCROW_IDS)));
    }

    // Once a scoped user touches the trade, remove that ID from the old
    // global bucket so multi-npub browsers do not briefly resurrect past
    // active-trade pills for the wrong signer on reload.
    if (pubkey) {
      const legacy = parseSavedEscrowIds(localStorage.getItem(LEGACY_STORAGE_KEY))
        .filter(savedId => savedId !== id);
      if (legacy.length > 0) {
        localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(legacy.slice(0, MAX_SAVED_ESCROW_IDS)));
      } else {
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      }
    }
  } catch {}
}

function removeEscrowId(id: string, pubkey?: string | null) {
  try {
    for (const key of new Set([escrowStorageKey(pubkey), LEGACY_STORAGE_KEY])) {
      const ids = parseSavedEscrowIds(localStorage.getItem(key)).filter(i => i !== id);
      if (ids.length > 0) localStorage.setItem(key, JSON.stringify(ids));
      else localStorage.removeItem(key);
    }
  } catch {}
}

// Forgotten-trade denylist lives in its own testable module (storage/
// forgotten-trades.ts).

import { useState, useEffect, useCallback, useRef } from "react";
import {
  getForgottenEscrowIds,
  addForgottenEscrowId,
  unforgetEscrowId,
} from "../storage/forgotten-trades.js";
import {
  EscrowClient,
  type EscrowClientConfig,
  type EscrowClientCallbacks,
  type Signer,
  detectSigner,
  NIP07Signer,
} from "../escrow-engine/index.js";
import {
  type EscrowState,
  type ParsedEscrowEvent,
  type ChatPayload,
  type ChatImageAttachment,
  type SelectedMenuItem,
  EscrowStatus,
  Role,
  Outcome,
} from "../escrow-engine/types.js";
import {
  FedimintClient,
  EscrowFedimintBridge,
  resolveFederationForCommunity,
  setCustomFederationInvite,
  hasCustomFederation,
  BP_FEDERATION_NAME,
  getOrCreateSeed,
  clearSeedCache,
  isTestnetMode,
  resetLocalFedimintWallet,
  drainPendingRedemptions,
  checkAndMaybeRepublishSeed,
  getActiveInvite,
  setActiveInvite,
  clearActiveInvite,
  shouldReconcileFederation,
  federationNameForInvite,
  deriveCreateFedTags,
  generateFediEcash,
  hasFediInternalEcash,
  hasFediInternalGenerateEcash,
} from "../fedimint/index.js";
import { Capacitor } from "@capacitor/core";
import type { LnReceiveStateKind, OnchainInfo } from "../fedimint/index.js";
import { clearPendingRedemption } from "../fedimint/pending-redemptions.js";
import { getUserCommunitySlug, setUserCommunitySlug } from "../communities/storage.js";
import { getCommunityBySlug, type Community } from "../communities/registry.js";
import {
  buildArbiterRosterEvent,
  fetchAndCacheCommunityRoster,
  resolveRosterAuthority,
  writeCachedRosterEvent,
} from "../arbiters/roster.js";
import {
  ARBITER_APPLICATION_KIND,
  buildArbiterApplicationEvent,
  collectArbiterApplications,
} from "../arbiters/applications.js";
import { DEFAULT_RELAYS } from "../escrow-engine/default-relays.js";
import { isSimModeOn } from "../sim/simMode.js";
import { addOrTouchPayoutDestination } from "../payments/payout-destinations.js";
import { payInvoiceWithNwc } from "../payments/nwc.js";
import { balanceBlocksFederationSwitch } from "../payments/lightning-fees.js";

/** Test/sandbox-only CREATE expiry override (see the createEscrow call site).
 *  Returns null unless chama_create_expiry_seconds holds a sane number. */
function readCreateExpiryOverride(): number | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem("chama_create_expiry_seconds");
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 300 && n <= 30 * 86400 ? Math.floor(n) : null;
  } catch {
    return null;
  }
}

/** v2.3 power-user substitution-grace override (parallels the CREATE expiry
 *  override). Committed into the LOCK so it's consensus-safe — every client
 *  replays the same eligibility moment. Returns null unless
 *  chama_substitution_grace_seconds holds a value in [0, 4h]; the reducer
 *  clamps again, so this is just the device-side sanity gate. Lets a tester
 *  drive short backup floors without waiting hours. */
function readSubstitutionGraceOverride(): number | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem("chama_substitution_grace_seconds");
    if (raw === null || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 && n <= 4 * 3600 ? Math.floor(n) : null;
  } catch {
    return null;
  }
}
import { buildChamaOperationMeta, type ChamaOperationMeta } from "../payments/sats-trace.js";
import {
  MIN_REAL_ATOMIC_FUNDING_MSATS,
  minimumAtomicFundingMessage,
} from "../payments/funding-limits.js";
import { setLocalStorageUserScope } from "../storage/user-scope.js";
import { extractNostrProfileName, type NostrProfileNameMap } from "../ui/nostr-profiles.js";

function isExpiredUnfundedEscrow(escrowState: EscrowState, nowSec = Math.floor(Date.now() / 1000)): boolean {
  return (
    escrowState.status === EscrowStatus.CREATED
    && typeof escrowState.expiresAt === "number"
    && escrowState.expiresAt > 0
    && nowSec > escrowState.expiresAt
  );
}

// ── Hook state ────────────────────────────────────────────────────────────

/**
 * Phases of a claim operation as seen by the UI.
 *
 * `submitted`  — user tapped claim, the bridge call is running.
 * `watching`   — the bridge call rejected with a probably-transient error,
 *                but the federation may still be processing. We're polling
 *                balance for up to 120s to see if sats actually arrive.
 * `success`    — either the bridge resolved cleanly, or the watchdog saw
 *                the balance go up by the expected amount.
 * `timeout`    — 120s elapsed during watching and balance didn't move
 *                enough. The sats may still arrive later; we just stopped
 *                watching. Not a red-toast failure.
 * `failure`    — a genuine hard error (hash mismatch, state precondition
 *                failed, etc.). Safe to show as red.
 */
export type ClaimPhase =
  | { phase: "submitted"; escrowId: string }
  | { phase: "watching"; escrowId: string; reason: string }
  | { phase: "success"; escrowId: string; deltaMsats: number; viaWatchdog: boolean }
  | { phase: "timeout"; escrowId: string }
  | { phase: "failure"; escrowId: string; reason: string };

export interface FedimintState {
  /** Wallet initialized (WASM loaded, transport ready) */
  initialized: boolean;
  /** Joined a federation */
  joined: boolean;
  /** Active federation ID (hex) */
  federationId: string | null;
  /** Human-friendly federation name for display */
  federationName: string;
  /** Whether the user is on a custom (non-default) federation */
  isCustom: boolean;
  /** Balance in msats */
  balanceMsats: number;
  /** True while init/join/fund operations are in flight */
  busy: boolean;
  /** Latest Fedimint error (separate from escrow error) */
  error: string | null;
  /**
   * PR 5: cached federation health probe result.
   * `true`  = last probe succeeded (or last join/switch succeeded — that
   *           also proves reachability).
   * `false` = last probe failed; receive operations should refuse until
   *           a fresh probe succeeds.
   * `null`  = no probe yet (e.g. just after fresh init, before first
   *           receive). Receive ops trigger a fresh probe in this case.
   */
  lastHealthOk: boolean | null;
  /** PR 5: ms-since-epoch of the last probe. Used for the 30s cache TTL. */
  lastHealthAt: number | null;
  /**
   * v0.3.1 Phase 3: cold-boot federation probe state.
   *
   * Sequential to initFedimint: runs once after a successful init/switch,
   * before the user can compose a trade. Eliminates the
   * "compose-then-fail-at-lock" UX where the user only discovers fed
   * unreachability after 90 seconds of trade composition.
   *
   *   "pending" — probe1 has not yet completed. Initial state on app
   *                load; brief transient state between initFedimint
   *                resolving and probe1 result. Action surfaces are
   *                NOT gated on pending (only on failed).
   *   "ok"      — probe1 succeeded this session. Lock + Claim actions
   *                are unblocked.
   *   "failed"  — probe1 threw. ChamaBar surfaces "⚠ Chama unreachable
   *                · Reconnect →"; Fund + Claim buttons render
   *                disabled with the "Federation unreachable" subtitle.
   *
   * Reset to "pending" at the start of each initFedimint() call; set
   * to "ok"/"failed" after the post-init probe resolves. The Phase 1
   * probeFederation() action also updates this state, so the
   * claim-bridge-threw Try-Again flow naturally unblocks the boot
   * gate on a successful retry.
   *
   * If initFedimint() itself throws (init failed), the probe never
   * runs and bootProbeState stays "pending" — but fedimint.joined is
   * false in that case, so the existing not-joined Reconnect surface
   * in ChamaBar handles UX, not the new unreachable variant.
   */
  bootProbeState: "pending" | "ok" | "failed";
}

export interface UseEscrowState {
  /** Whether the client is connected to relays */
  connected: boolean;
  /** User's Nostr pubkey (hex) */
  pubkey: string | null;
  /** All loaded escrow states */
  escrows: Map<string, EscrowState>;
  /** Relay connection statuses */
  relayStatuses: Map<string, string>;
  /** Number of connected relays */
  connectedRelays: number;
  /** Latest error */
  error: string | null;
  /** Loading state */
  loading: boolean;
  /** Fedimint wallet state */
  fedimint: FedimintState;
  /**
   * v0.6.5: true while runFundAndLock is mid-flight (between
   * creating-invoice and a terminal phase). Drives the funding-
   * operation gate that replaces the old one-trade-at-a-time block:
   * Fund taps grey out, but Create + Browse remain open. Suppresses
   * the recovery banner so the atomic flow owns the transient balance.
   */
  fundingInProgress: boolean;
  /**
   * v0.6.5: true while runClaimAndPayout is between claim and the
   * outbound LN send. Suppresses the recovery banner — the claim
   * flow owns the redeemed balance until the sweep completes.
   */
  claimPayoutInProgress: boolean;
}

export interface UseEscrowActions {
  /** Connect to relays and initialize signer */
  connect: () => Promise<void>;
  /** Disconnect from relays */
  disconnect: () => void;
  /** Create a new escrow trade */
  createEscrow: (params: {
    description: string;
    amountMsats: number;
    fiatAmount?: number;
    fiatCurrency?: string;
    category: string;
    mintUrl: string;
    paymentMethods?: string[];
    items?: Parameters<EscrowClient["createEscrow"]>[0]["items"];
    arbiterFeeMsats?: number;
    expirySeconds?: number;
    communityArbiters?: string[];
  }) => Promise<{ escrowId: string; state: EscrowState }>;
  /** Join an existing escrow as buyer or arbiter; menu buyers can later
   *  re-publish JOIN with selectedItems to save their order. */
  joinEscrow: (
    escrowId: string,
    role: Role,
    opts?: { selectedItems?: SelectedMenuItem[]; amountMsats?: number; orderFinalized?: boolean },
  ) => Promise<EscrowState>;
  /**
   * Lock ecash into 2-of-3 SSS escrow.
   * Atomic-funding flow: triggered as a side-effect of payment landing.
   *   spendNotes → Shamir split → NIP-44 encrypt shares → publish LOCK
   * The LOCK event self-describes buyer + arbiter; no prior READY ceremony.
   *
   * PR 3: optional savedHandleId names which of the seller's saved
   * payment handles to reveal in the LOCK payload. Bridge resolves
   * to cleartext at lock time. Omit for non-fiat trades.
   */
  lockAndPublish: (escrowId: string, opts?: {
    savedHandleId?: string;
    selectedItems?: SelectedMenuItem[];
  }) => Promise<EscrowState>;
  /** Cast a vote */
  vote: (escrowId: string, outcome: Outcome) => Promise<EscrowState>;
  /**
   * Claim ecash as the winner — leaves sats in the user's Chama wallet.
   * Runs the full real-Fedimint flow:
   *   decrypt shares → Shamir combine → verify hash → redeemEcash → publish CLAIM
   *
   * v0.3.0: production code paths must use claimAndPayout, which
   * additionally dispatches an outbound Lightning payment to a
   * user-chosen destination. claimAndRedeem leaves sats orphaned in
   * the user's local Chama (Pillar 2.1 Option B violation). It stays
   * exported as a building block for claimAndPayout and for Sandbox-
   * mode testing. Phase 5 will demote this to Sandbox-only by gating
   * its production callsites; do NOT add new direct callers.
   */
  claimAndRedeem: (escrowId: string) => Promise<EscrowState>;
  /**
   * v0.3.0 Phase 3 — atomic claim-and-payout. Composes
   *   claimAndRedeem → wait-for-balance → payInvoice → optional handle save
   * into one user-facing flow. The user picks a destination via
   * DestinationPicker; this action carries it through to settlement.
   * The user never holds an intermediate balance (Pillar 2.1 Option B,
   * send side).
   *
   * Resolves with the terminal kind — never throws. Failure modes are
   * split for the recovery banner UX:
   *   claim-failed   — claim threw hard; no orphan
   *   claim-pending  — claim returned but balance hasn't landed in 60s;
   *                    pending redemption stash remains for boot retry
   *   payout-failed  — claim landed but LN send failed; orphan balance
   *                    (recovery banner is the next stop)
   *   done           — payout sent
   */
  claimAndPayout: (
    escrowId: string,
    args: {
      bolt11?: string;
      onchainAddress?: string;
      expectedDeltaMsats: number;
      saveAfter: boolean;
      addressUsed?: string;
      onPhase: (phase: import("../payments/claim-and-payout.js").ClaimAndPayoutPhase) => void;
    },
  ) => Promise<import("../payments/claim-and-payout.js").ClaimAndPayoutTerminal>;
  /** Release a subscription period */
  releasePeriod: (escrowId: string, periodIndex: number) => Promise<EscrowState>;
  /** Send a chat message */
  sendChat: (
    escrowId: string,
    message: string | { message: string; attachments?: ChatImageAttachment[] },
  ) => Promise<void>;
  /** Cancel a trade (initiator only, pre-lock) */
  cancel: (escrowId: string, reason?: string) => Promise<EscrowState>;
  /** Load an escrow from relays by ID */
  loadEscrow: (escrowId: string) => Promise<EscrowState | null>;
  /** Re-broadcast a trade's cached event chain to today's relays — heals a
   *  "ghost" trade the counterparty can't see. Returns how many events landed. */
  rebroadcastEscrow: (escrowId: string) => Promise<{ published: number; total: number }>;
  /** Forget a trade locally (drop saved pointer + hide from the list). Safe:
   *  money stays in escrow and the trade is re-loadable by ID. */
  forgetEscrow: (escrowId: string) => void;
  /** #7 multi-unit storefront: spawn a CHILD purchase escrow for `quantity`
   *  units of a multi-unit parent listing and return it (the buyer then locks
   *  the child via the normal flow). */
  purchaseFromListing: (parent: EscrowState, quantity: number) => Promise<{ escrowId: string; state: EscrowState }>;
  /** Fetch self-published kind:0 profile names for visible participants. */
  fetchNostrProfiles: (pubkeys: string[]) => Promise<NostrProfileNameMap>;
  /** Trigger haptic feedback */
  vibrate: (pattern?: number | number[]) => void;

  // ── Fedimint actions ───────────────────────────────────────────────────
  /**
   * Initialize the Fedimint WASM wallet and join a federation.
   * If no invite code is provided, uses the stored custom invite (if any)
   * or falls back to the community-default (which falls back to BP).
   * Idempotent: safe to call multiple times.
   *
   * v0.1.82+: throws `RECONCILE_REFUSED_NONZERO_BALANCE` if the OPFS-bound
   * federation differs from the desired one AND the local wallet holds a
   * Lightning-withdrawable balance (or the balance can't be verified). The
   * UI must surface a destroy-confirm modal before retrying with
   * `{ force: true }`.
   */
  initFedimint: (inviteCode?: string, options?: { force?: boolean; persistCustom?: boolean }) => Promise<void>;
  /**
   * Persist a custom federation invite code for future sessions.
   * Pass empty string to clear and revert to the default.
   * Does NOT automatically re-join — call initFedimint() after if you
   * want to switch federations immediately.
   */
  setCustomInvite: (inviteCode: string) => void;
  /**
   * Create a Lightning invoice to fund the Fedimint wallet.
   * Returns the BOLT11 string for the user to pay from another wallet.
   *
   * v0.6.5: `onReceiveState` (optional) fires on every state
   * transition of the underlying LN receive operation
   * (`created` → `funded` → `awaiting_funds` → `claimed`). The
   * atomic-funding orchestrator uses this to advance the modal UI
   * the moment the gateway acknowledges the HTLC, instead of waiting
   * for the 5s balance poll to notice. v0.6.4 production logs prove
   * this state machine is the source of truth for "did the payment
   * land?" — balance polling is the LOCK-readiness gate, the watch
   * is the UX gate.
   */
  createFundingInvoice: (
    amountMsats: number,
    description?: string,
    onReceiveState?: (kind: LnReceiveStateKind) => void,
    meta?: ChamaOperationMeta,
  ) => Promise<string>;
  /**
   * v0.3.0 atomic funding: compose createFundingInvoice → balance-watcher
   * → lockAndPublish into one user-facing flow. The user pays a BOLT11
   * for exactly the trade amount; the moment ecash mints, LOCK fires
   * automatically. The user never holds an intermediate wallet balance
   * (Pillar 2.1 Option B). AtomicFundingModal renders phase events for
   * granular UI updates; the action resolves with the terminal phase.
   *
   * Resolves with the terminal kind — never throws. Callers branch on
   * the returned kind for post-modal navigation. Per-phase UI lives in
   * the modal via opts.onPhase.
   */
  fundAndLock: (
    escrowId: string,
    opts: {
      amountMsats: number;
      description: string;
      fundingMethod?: "lightning" | "onchain" | "nwc";
      nwcConnectionString?: string;
      rememberNwc?: boolean;
      savedHandleId?: string;
      selectedItems?: SelectedMenuItem[];
      onPhase: (phase: import("../payments/fund-and-lock.js").FundAndLockPhase) => void;
      signal?: AbortSignal;
    },
  ) => Promise<import("../payments/fund-and-lock.js").FundAndLockTerminal>;
  payInvoice: (bolt11: string, meta?: ChamaOperationMeta) => Promise<void>;
  spendNotes: (amountMsats: number, meta?: ChamaOperationMeta) => Promise<string>;
  redeemEcash: (oobNotes: string, meta?: ChamaOperationMeta) => Promise<void>;
  /** Read federation wallet-module onchain fees and confirmation policy. */
  getOnchainInfo: () => Promise<OnchainInfo>;
  /**
   * v0.3.1 Phase 1: explicit federation probe. Returns
   * `{ ok: true }` if the federation responds to the standard probe,
   * `{ ok: false, error: msg }` otherwise. Used by the
   * ClaimPayoutModal's retry path on the `claim-bridge-threw`
   * terminal — re-probe before re-dispatch so the user gets a clean
   * "Chama reachable → claim retried" sequence rather than "retry →
   * same error instantly". Never throws.
   */
  probeFederation: () => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Quietly warm the Fedimint/WASM path before a likely funding action. */
  prewarmFunding: () => Promise<void>;
  /** Refresh the current balance from the wallet */
  refreshBalance: () => Promise<void>;
  /** Read and store the current wallet balance. */
  getBalance: () => Promise<number>;
  /** V3 roster keystone: fetch + verify + cache the community's signed
   *  kind:38120 arbiter roster. No-op when the community has no authority
   *  anchor or no client. Safe to fire-and-forget on community changes. */
  refreshCommunityRoster: (community: string) => Promise<void>;
  /** Steward path: build, sign, publish, and cache this community's roster.
   *  Throws when not connected. Authority is enforced by VERIFIERS — an
   *  unauthorized publish is simply ignored by every other client. */
  publishCommunityRoster: (community: string, arbiters: string[]) => Promise<void>;
  /** V3 #74: publish a signed arbiter application (kind:38121) for a
   *  community. Anyone signed-in may apply; the steward reviews. */
  applyAsArbiter: (community: string, statement: string) => Promise<void>;
  /** V3 #74 steward review: fetch + verify a community's applications,
   *  newest per applicant, already-rostered keys excluded. */
  fetchArbiterApplications: (
    community: string,
    excludePubkeys?: string[],
  ) => Promise<{ applicant: string; statement: string; createdAt: number }[]>;
  /**
   * Wipe the local Fedimint wallet's IndexedDB and reset in-memory state.
   * Use this to recover from a "No modification allowed" seed-mismatch error
   * or any other stuck-state issue. Destructive to *local* state only — the
   * Nostr-backed seed survives and will be re-installed on next initFedimint().
   */
  resetLocalWallet: () => Promise<void>;
  /**
   * Switch the Fedimint wallet to a different federation. Atomically:
   *   1. Cleans up the in-memory FedimintClient (terminates worker)
   *   2. Wipes the current OPFS file + rotates to a fresh filename
   *   3. Re-initializes with the new invite code
   *
   * Destructive: any ecash held in the previous federation becomes
   * stranded until you switch back. The v0.1.76 balance guard refuses
   * the switch if the current balance is Lightning-withdrawable unless
   * `{ force: true }` is passed, which the UI must only do after explicit
   * user confirmation. The Nostr-backed seed survives — trade history,
   * escrows, and signer are unaffected.
   */
  switchFederation: (inviteCode: string, options?: { force?: boolean; persistCustom?: boolean }) => Promise<void>;
  /** (Re-)start the Browse feed subscription for public listings. */
  watchPublicListings: (since?: number) => void;
  /**
   * v0.6.5: subscribe to live updates for a specific escrow. Idempotent —
   * a label-keyed map de-duplicates per escrow id. Used by Browse to
   * re-attach a sub for every visible listing on mount/reload, so JOIN
   * events flow live even when the listing was hydrated in a prior
   * session and the cold-start path skipped the implicit
   * loadEscrow→watchEscrow chain.
   */
  watchEscrow: (escrowId: string) => void;
  /** PR 2: read the user's selected community slug (always returns
   *  a valid slug from the registry — defaults to us-blf / Global USD). */
  getCommunity: () => string;
  /** PR 2: persist the user's community choice. Pass empty string to
   *  clear and revert to default. Does NOT auto re-init the wallet —
   *  call initFedimint() afterward to switch federations immediately. */
  setCommunity: (slug: string) => void;
}

// ── Haptic feedback ───────────────────────────────────────────────────────
//
// Web: navigator.vibrate, which honours pattern arrays natively.
//
// Native (Capacitor/Android): navigator.vibrate is gated behind a FRESH
// WebView user-activation, so the boot "Chama ready" buzz was silently
// dropped — on the no-gesture auto-login path it can never fire, and on
// tap-to-connect the relay handshake routinely outlives the ~5s sticky
// activation window (the v2.1 "lost my vibration" regression). The
// native Haptics plugin calls the system vibrator straight through the
// Capacitor bridge with no activation requirement, so on-device we route
// there and FAITHFULLY REPLAY the same pattern every existing call site
// passes — one native pulse per "on" segment — so [50,30,50] et al. feel
// identical to the web version, and no call site changes.

function vibrate(pattern: number | number[] = 50) {
  if (typeof Capacitor !== "undefined" && Capacitor.isNativePlatform()) {
    nativeHapticPattern(pattern);
    return;
  }
  if (typeof navigator !== "undefined" && navigator.vibrate) {
    try {
      navigator.vibrate(pattern);
    } catch {}
  }
}

/** Replay a web-style vibration pattern through the native Haptics
 *  plugin. Web patterns are [on, off, on, off, …] ms; we schedule a
 *  native vibrate for each ON (even-index) segment at its cumulative
 *  time offset so the felt rhythm matches the browser exactly. The
 *  plugin is lazy-imported so it never loads on web or under the
 *  Node/esbuild test runtime (isNativePlatform() is false there, so the
 *  import is never reached). */
function nativeHapticPattern(pattern: number | number[]) {
  const segments = typeof pattern === "number" ? [pattern] : pattern;
  void import("@capacitor/haptics")
    .then(({ Haptics }) => {
      let offset = 0;
      for (let i = 0; i < segments.length; i++) {
        const ms = Math.max(0, Math.floor(segments[i] ?? 0));
        if (i % 2 === 0 && ms > 0) {
          const at = offset;
          setTimeout(() => {
            Haptics.vibrate({ duration: ms }).catch(() => {});
          }, at);
        }
        offset += ms;
      }
    })
    .catch(() => {});
}

// ══════════════════════════════════════════════════════════════════════════
// HOOK
// ══════════════════════════════════════════════════════════════════════════

/**
 * Config accepted by useEscrow. Extends EscrowClientConfig (relays, fees, etc.)
 * with UI-facing callbacks that let the hook communicate multi-phase events
 * back to the UI without the UI having to drive complex promise chains.
 */
export interface UseEscrowConfig extends Partial<EscrowClientConfig> {
  /** Called at each phase of a claim operation — see ClaimPhase. */
  onClaimProgress?: (phase: ClaimPhase) => void;
}

export function useEscrow(config?: UseEscrowConfig): [UseEscrowState, UseEscrowActions] {
  const clientRef = useRef<EscrowClient | null>(null);
  const fedimintRef = useRef<FedimintClient | null>(null);
  const bridgeRef = useRef<EscrowFedimintBridge | null>(null);
  const signerRef = useRef<Signer | null>(null);
  // Forgotten-trade denylist, in memory. Loaded at connect from the persistent
  // store with the RELIABLE pubkey (the local `pubkey` var) so updateEscrow can
  // honor it the instant Browse events arrive — before `state.pubkey` has even
  // re-rendered. Kept in sync by forgetEscrow / loadEscrow.
  const forgottenIdsRef = useRef<Set<string>>(new Set());
  // PR 5: federation health cache. Mirrored into React state for the UI;
  // the ref is the source of truth read inside createFundingInvoice so
  // we don't depend on the latest closure of `state`.
  const healthRef = useRef<{ ok: boolean | null; at: number | null }>({ ok: null, at: null });
  // PR 5: latest state mirror. Lets callbacks read current values
  // (e.g. federationName for error copy) without re-creating the
  // callback on every state change.
  const stateRef = useRef<UseEscrowState | null>(null);
  // v0.6.5: synchronous mirrors of the in-progress flags. setState
  // updates are async — without these refs, two near-simultaneous Fund
  // taps could both pass the gate before React's next render. The ref
  // is the authoritative read at entry; the setState call drives the UI.
  //
  // v0.6.5 follow-up: fundingInProgressRef holds the AbortSignal of
  // the live run (or null when idle), not just a boolean. React
  // StrictMode double-mounts effects in dev: first mount starts run#1
  // and aborts it, then second mount synchronously starts run#2.
  // Between those two, run#1's finally hasn't fired (the awaited
  // promise sits in the microtask queue past the abort), so a
  // boolean ref still reads "in progress" and the second mount
  // gets a false-positive lock-failed. By checking signal.aborted
  // on the held ref, we can let run#2 proceed when run#1 is already
  // dead, while still blocking a real concurrent user Fund tap.
  const fundingInProgressRef = useRef<AbortSignal | null>(null);
  const claimPayoutInProgressRef = useRef(false);

  const [state, setState] = useState<UseEscrowState>({
    connected: false,
    pubkey: null,
    escrows: new Map(),
    relayStatuses: new Map(),
    connectedRelays: 0,
    error: null,
    loading: false,
    fundingInProgress: false,
    claimPayoutInProgress: false,
    fedimint: {
      initialized: false,
      joined: false,
      federationId: null,
      federationName: hasCustomFederation() ? "External route" : BP_FEDERATION_NAME,
      isCustom: hasCustomFederation(),
      balanceMsats: 0,
      busy: false,
      error: null,
      lastHealthOk: null,
      lastHealthAt: null,
      // v0.3.1 Phase 3: cold-boot probe state. Starts "pending" until
      // initFedimint runs probe1 sequentially after a successful init.
      bootProbeState: "pending",
    },
  });

  const updateFedimint = useCallback((partial: Partial<FedimintState>) => {
    setState(prev => ({ ...prev, fedimint: { ...prev.fedimint, ...partial } }));
  }, []);

  // PR 5: keep stateRef in sync with state on every render so callbacks
  // can read the latest values without taking `state` as a dependency.
  stateRef.current = state;

  // ── State updater helpers ───────────────────────────────────────────────

  const updateEscrow = useCallback((escrowId: string, escrowState: EscrowState) => {
    // A locally-forgotten ghost stays gone: don't let the Browse/public-
    // listings feed (or any re-delivery) re-add it after a restart. The ref is
    // loaded at connect with the reliable pubkey, so this works even before
    // state.pubkey re-renders. Loading it by ID un-forgets it (see loadEscrow).
    if (forgottenIdsRef.current.has(escrowId)) return;
    if (isExpiredUnfundedEscrow(escrowState)) {
      setState(prev => {
        if (!prev.escrows.has(escrowId)) return prev;
        const next = new Map(prev.escrows);
        next.delete(escrowId);
        return { ...prev, escrows: next };
      });
      console.info(`[chama] Hid expired unfunded escrow ${escrowId} from local state; saved pointer kept for relay recovery`);
      return;
    }

    setState(prev => {
      const next = new Map(prev.escrows);
      next.set(escrowId, escrowState);
      return { ...prev, escrows: next };
    });
  }, []);

  const updateRelayStatus = useCallback((relayUrl: string, status: string) => {
    setState(prev => {
      const next = new Map(prev.relayStatuses);
      next.set(relayUrl, status);
      const connected = [...next.values()].filter(s => s === "connected").length;
      return { ...prev, relayStatuses: next, connectedRelays: connected };
    });
  }, []);

  // ── Connect ─────────────────────────────────────────────────────────────

  const connect = useCallback(async () => {
    setState(prev => ({ ...prev, loading: true, error: null }));

    try {
      // Detect signer (NIP-07 extension or Fedi runtime)
      let signer: Signer;
      try {
        // Check for pre-connected NIP-46 signer (set by App component)
        if ((window as any).__chama_nip46_signer) {
          signer = (window as any).__chama_nip46_signer;
          delete (window as any).__chama_nip46_signer;
        }
        // Check for nsec login
        else if ((window as any).__chama_connect_nsec) {
          const nsec = (window as any).__chama_connect_nsec;
          delete (window as any).__chama_connect_nsec;
          const { NsecSigner } = await import("../escrow-engine/nsec-signer.js");
          signer = new NsecSigner(nsec);
        }
        // Default: NIP-07 extension
        else {
          signer = detectSigner();
        }
      } catch {
        // Fallback: try NIP-07 with a delay (extensions sometimes load late)
        await new Promise(r => setTimeout(r, 500));
        try {
          signer = detectSigner();
        } catch (e) {
          throw new Error("No Nostr signer found. Use the Signer QR option, paste an nsec, or install a NIP-07 extension.");
        }
      }

      const pubkey = await signer.getPublicKey();
      signerRef.current = signer;
      setLocalStorageUserScope(pubkey);
      // Hydrate the forgotten-trade denylist NOW, with the reliable pubkey, so
      // the Browse feed (which starts below, before state.pubkey re-renders)
      // can't re-add a ghost the user forgot on a prior run.
      forgottenIdsRef.current = new Set(getForgottenEscrowIds(pubkey));

      const callbacks: EscrowClientCallbacks = {
        onStateUpdate: (id, s) => updateEscrow(id, s),
        onChatMessage: (id, msg) => {
          // Chat messages are embedded in escrow state via the engine.
          // Force React re-render with the updated chatMessages.
          updateEscrow(id, client.getState(id)!);
          vibrate([20, 30, 20]);
        },
        onValidationError: (id, error, eventId) => {
          console.debug(`[escrow] Validation error on ${id}: ${error} (event: ${eventId})`);
        },
        onRelayStatus: (url, status) => updateRelayStatus(url, status),
      };

      const client = new EscrowClient(signer, {
        relays: config?.relays || DEFAULT_RELAYS,
        defaultPlatformFeeBps: config?.defaultPlatformFeeBps ?? 50,
        platformFeePubkey: config?.platformFeePubkey,
        defaultExpirySeconds: config?.defaultExpirySeconds ?? 86_400,
        ...config,
      }, callbacks);

      client.connect();
      clientRef.current = client;

      // Start Browse feed — subscribe to public CREATE events from the last 7 days.
      // These flow through the same onStateUpdate callback and land in `escrows`;
      // the UI filters by "am I a participant" to split Browse from My trades.
      client.watchPublicListings();

      setState(prev => ({
        ...prev,
        connected: true,
        pubkey,
        loading: false,
      }));

      vibrate([50, 30, 50]); // Connected haptic

      // Start periodic balance refresh — every 30 seconds
      const balanceInterval = setInterval(() => {
        refreshBalanceRef.current?.().catch(() => {});
      }, 30_000);

      // Start periodic expiry checker — every 60 seconds, check all loaded escrows
      // v0.1.65: periodic heal — also scan EXPIRED so stuck chains get
      // healed by any online participant, not just those who happened
      // to open the specific trade. The client-side guard inside
      // maybeAutoRefundExpired filters by role + vote-state, so this
      // is safe to call broadly.
      const expiryInterval = setInterval(async () => {
        if (!clientRef.current) return;
        const escrowClient = clientRef.current;
        const now = Math.floor(Date.now() / 1000);
        for (const [escrowId, escrowState] of (escrowClient as any).states || []) {
          const isStuckLocked =
            escrowState.status === "LOCKED" && now > escrowState.expiresAt;
          const isStuckExpired =
            escrowState.status === "EXPIRED" &&
            !escrowState.eventChain?.some?.((e: any) => e.kind === 38104);
          if (isStuckLocked || isStuckExpired) {
            try {
              await (escrowClient as any).maybeAutoRefundExpired?.(escrowId);
            } catch {}
            // Belt-and-suspenders for the resolve-starvation gap: if the
            // healing votes already meet 2-of-3 but the RESOLVE never landed,
            // publish it from here too (its guards no-op safely otherwise).
            try {
              await (escrowClient as any).maybeAutoResolve?.(escrowId);
            } catch {}
          }
        }
      }, 60_000);
      // Store interval for cleanup
      (clientRef as any)._expiryInterval = expiryInterval;

      // ── v0.1.67: Mechanism B sentinel ─────────────────────────────
      //
      // Background heal for stuck trades the user is a participant in.
      // Two heals: stuck-LOCKED-past-expiry (publish my REFUND vote)
      // and stuck-FUNDED-past-expiry as initiator (publish CANCEL).
      // COMPLETE is deliberately not auto-healed here: it is a money
      // statement and must wait for the claim balance to actually land.
      //
      // In-memory dedup prevents retrying the same heal every tick.
      // Accepts duplicates across clients (state machine dedupes at
      // replay via ALREADY_VOTED / TERMINAL_STATE / INVALID_STATE).
      //
      // Scope: escrowClient.states where the user's pubkey appears in
      // state.participants. Ground-truth filter — independent of
      // savedIds localStorage state.
      const sentinelDedup = new Map<string, Set<string>>();
      const markAttempted = (escrowId: string, healKind: string) => {
        const set = sentinelDedup.get(escrowId) ?? new Set<string>();
        set.add(healKind);
        sentinelDedup.set(escrowId, set);
      };
      const alreadyAttempted = (escrowId: string, healKind: string): boolean =>
        sentinelDedup.get(escrowId)?.has(healKind) ?? false;

      const sentinelInterval = setInterval(async () => {
        if (!mountedRef.current) return;
        if (!clientRef.current || !signerRef.current) return;
        const escrowClient = clientRef.current;
        let myPubkey: string;
        try {
          myPubkey = await signerRef.current.getPublicKey();
        } catch {
          // Signer not ready — skip this tick silently.
          return;
        }

        const nowSec = Math.floor(Date.now() / 1000);
        let scanned = 0;
        let heals = 0;

        for (const [escrowId, escrowState] of (escrowClient as any).states || []) {
          scanned++;

          // Determine my role in this trade, if any. If I'm not a
          // participant, skip entirely — this is the scope guard.
          const p = escrowState.participants;
          let myRole: Role | null = null;
          if (p.buyer === myPubkey) myRole = Role.BUYER;
          else if (p.seller === myPubkey) myRole = Role.SELLER;
          else if (p.arbiter === myPubkey) myRole = Role.ARBITER;
          if (!myRole) continue;

          // ── Heal #1: LOCKED past expiry, I haven't voted REFUND ──
          if (
            escrowState.status === "LOCKED" &&
            nowSec > escrowState.expiresAt &&
            escrowState.votes?.[myRole] === undefined &&
            !alreadyAttempted(escrowId, "refund-vote")
          ) {
            markAttempted(escrowId, "refund-vote");
            try {
              await escrowClient.vote(escrowId, Outcome.REFUND);
              heals++;
              console.log(`[chama] sentinel: published REFUND vote on ${escrowId}`);
            } catch (e) {
              console.debug(`[chama] sentinel: REFUND vote on ${escrowId} suppressed:`, (e as Error)?.message);
            }
            continue;
          }

          // ── Heal #2: CREATED past expiry, no LOCK, I'm the initiator ──
          // Atomic-funding model: trades sit in CREATED until LOCK fires.
          // If a buyer never paid by the deadline, the initiator cancels.
          const isInitiator = escrowState.initiator?.pubkey === myPubkey;
          if (
            escrowState.status === "CREATED" &&
            nowSec > escrowState.expiresAt &&
            isInitiator &&
            !alreadyAttempted(escrowId, "cancel")
          ) {
            markAttempted(escrowId, "cancel");
            try {
              await escrowClient.cancel(escrowId, "never_locked_past_expiry");
              heals++;
              console.log(`[chama] sentinel: published CANCEL on ${escrowId} (stuck CREATED past expiry)`);
            } catch (e) {
              console.debug(`[chama] sentinel: CANCEL on ${escrowId} suppressed:`, (e as Error)?.message);
            }
          }
        }

        console.log(`[chama] sentinel: scanned ${scanned} escrows, ${heals} heals`);
      }, 5 * 60_000);
      (clientRef as any)._sentinelInterval = sentinelInterval;

      // Auto-reload saved escrows — wait for relays to connect first
      const savedIds = getSavedEscrowIds(pubkey);
      if (savedIds.length > 0) {
        // Wait for at least 2 relays to connect (up to 5 seconds)
        let waited = 0;
        while (waited < 5000) {
          const connectedCount = [...(client as any).relayManager.relays.values()]
            .filter((r: any) => r.status === "connected").length;
          if (connectedCount >= 2) break;
          await new Promise(r => setTimeout(r, 500));
          waited += 500;
        }
        const finalConnected = [...(client as any).relayManager.relays.values()]
          .filter((r: any) => r.status === "connected").length;
        console.log(`[chama] Reloading ${savedIds.length} saved escrow(s) with ${finalConnected} relays connected...`);
        // v0.1.66.32: cap raised 10 → 50 to match save cap.
        // Users with >10 saved trades were silently having older
        // escrows skipped on cold start, causing stale-forever state.
        for (const id of savedIds.slice(0, 50)) {
          try {
            const loaded = await client.loadEscrow(id);
            if (loaded && isExpiredUnfundedEscrow(loaded)) {
              (client as any).states?.delete?.(id);
              (client as any).rawEvents?.delete?.(id);
            }
          } catch (e) {
            console.debug(`[chama] Could not reload ${id}:`, e);
          }
        }
      }
    } catch (e) {
      setState(prev => ({
        ...prev,
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      }));
    }
  }, [config, updateEscrow, updateRelayStatus]);

  // ── Disconnect ──────────────────────────────────────────────────────────

  const disconnect = useCallback(() => {
    clientRef.current?.disconnect();
    clientRef.current = null;
    fedimintRef.current?.cleanup().catch((e) =>
      console.debug("[chama] fedimint cleanup error:", e)
    );
    fedimintRef.current = null;
    bridgeRef.current = null;
    signerRef.current = null;
    fundingInProgressRef.current = null;
    claimPayoutInProgressRef.current = false;
    setLocalStorageUserScope(null);
    clearSeedCache();
    setState({
      connected: false,
      pubkey: null,
      escrows: new Map(),
      relayStatuses: new Map(),
      connectedRelays: 0,
      error: null,
      loading: false,
      fundingInProgress: false,
      claimPayoutInProgress: false,
      fedimint: {
        initialized: false,
        joined: false,
        federationId: null,
        federationName: hasCustomFederation() ? "External route" : BP_FEDERATION_NAME,
        isCustom: hasCustomFederation(),
        balanceMsats: 0,
        busy: false,
        error: null,
        lastHealthOk: null,
        lastHealthAt: null,
        // v0.3.1 Phase 3: matches the primary initial state above.
        // disconnect() resets to pre-init shape; bootProbeState resets
        // with it.
        bootProbeState: "pending",
      },
    });
  }, []);

  // ── Cleanup on unmount ──────────────────────────────────────────────────
  //
  // v0.1.66.34: mountedRef is the kill-switch for long-lived async polls
  // (the claim watchdog in particular). setTimeout-driven polls hold
  // closures over fedimintRef/updateFedimint, and firing those after
  // unmount produces React "state update on unmounted component" warnings
  // — worse, calling updateFedimint() on a stale instance can race a
  // freshly-mounted hook's state and clobber a real balance update with
  // a stale read.

	  const mountedRef = useRef(true);

	  useEffect(() => {
	    mountedRef.current = true;
	    return () => {
	      mountedRef.current = false;
	      if ((import.meta as any).env?.DEV && (import.meta as any).hot) {
	        console.debug("[chama] preserving live Fedimint session across Vite hot reload cleanup");
	        return;
	      }
	      clientRef.current?.disconnect();
	      const fedimint = fedimintRef.current;
	      fedimint?.cleanup().catch(() => {});
	      if (fedimintRef.current === fedimint) fedimintRef.current = null;
	      if (bridgeRef.current) bridgeRef.current = null;
      setLocalStorageUserScope(null);
    };
  }, []);

  // ── Trade actions ───────────────────────────────────────────────────────

  const requireClient = (): EscrowClient => {
    if (!clientRef.current) throw new Error("Not connected — call connect() first");
    return clientRef.current;
  };

  const createEscrow = useCallback(async (params: Parameters<EscrowClient["createEscrow"]>[0]) => {
    const client = requireClient();

    // v0.4.4: CREATE no longer probes the federation. Pillar 2.3
    // ("federation follows the listing") only requires the `fed` tag
    // (federation ID), which the running client always knows from
    // init — no roundtrip needed. The legacy fedPrefix tag is no
    // longer emitted (probeResult is always null here), so new CREATE
    // events carry only the fed-ID. Buyers gate JOIN on fed-ID
    // equality (useEscrow.joinEscrow) and the LOCK bridge gates on
    // the same fed-ID, so the prefix path is structurally dead.
    //
    // deriveCreateFedTags handles probeResult: null cleanly: it emits
    // `fed` from cachedFedId alone and omits `fedPrefix`.
    const cachedFedId = fedimintRef.current?.getFederationId() ?? null;
    const fedTags = deriveCreateFedTags({ cachedFedId, probeResult: null });

    // Sandbox/test lever: override the default trade expiry for CREATEs made
    // on THIS device. Consensus-safe by construction — expirySeconds becomes
    // committed wire data in the CREATE event, so every client derives the
    // same expiry and the same arbiter-substitution floor (min(4h, half the
    // remaining life)) from it. Example: localStorage.setItem(
    // "chama_create_expiry_seconds", "1800") → 30-minute trades whose
    // backup-arbiter floor opens after ~15 minutes. Remove the key for the
    // 24h default. Clamped to [5 minutes, 30 days].
    const expiryOverride = readCreateExpiryOverride();
    const result = await client.createEscrow({
      ...params,
      ...(params.expirySeconds === undefined && expiryOverride !== null
        ? { expirySeconds: expiryOverride }
        : {}),
      fedPrefix: fedTags.fedPrefix,
      fed: fedTags.fed,
    });
    saveEscrowId(result.escrowId, stateRef.current?.pubkey ?? null);
    vibrate([40, 20, 40, 20, 80]); // Celebratory haptic
    return result;
  }, []);

  const joinEscrow = useCallback(async (
    escrowId: string,
    role: Role,
    opts: { selectedItems?: SelectedMenuItem[]; amountMsats?: number; orderFinalized?: boolean } = {},
  ) => {
    const client = requireClient();

    // v0.4.4 federation gate (fed-ID equality) ─────────────────────────
    // Pre-flight: if the trade's CREATE event carries a `fed` tag
    // (federation ID hex), compare it to the joiner's wallet federation.
    // Refuse the join on mismatch BEFORE any money operation.
    //
    // The v0.1.72-era fedPrefix gate spent 1 sat as a probe to extract
    // a 10-char identifier — incompatible with v0.1.76 Option B
    // ("wallets always at 0 between trades"). The fed-ID is captured
    // from the running client at init and surfaced into CREATE via
    // deriveCreateFedTags; no spend needed.
    //
    // Legacy trades without payload.fed: allow the join. The LOCK gate
    // (escrow-bridge.lockAndPublish) remains the load-bearing
    // money-move defense — it gates on the same fed-ID.
    const state = client.getState(escrowId);
    const createEvent = state?.eventChain?.[0];
    const expectedFed: string | undefined =
      (createEvent?.payload as any)?.fed;

    if (expectedFed && fedimintRef.current) {
      const walletFed = fedimintRef.current.getFederationId();
      if (walletFed && walletFed !== expectedFed) {
        const err: any = new Error(
          `This trade requires federation ${expectedFed}. ` +
            `Your wallet is on ${walletFed}. ` +
            `Sign out and rejoin with the correct federation, then try again.`
        );
        err.code = "FED_MISMATCH";
        err.expected = expectedFed;
        err.got = walletFed;
        throw err;
      }
    }

    try {
      const result = await client.joinEscrow(escrowId, role, opts);
      saveEscrowId(escrowId, stateRef.current?.pubkey ?? null);
      vibrate([30, 20, 30]);
      return result;
    } catch (e: any) {
      // Swallow known duplicate/stale errors — they fire when a user reloads
      // a trade they already joined and the state has advanced past OPEN.
      // Engine strings: "Cannot JOIN in state <x>" and
      // same-role duplicate JOIN echoes. Opposite-role self-joins must
      // surface as real errors; otherwise a seller can tap "Join as Buyer"
      // and see a false-success path on their own listing.
      const msg = e?.message || "";
      const latest = client.getState(escrowId);
      const currentPubkey = stateRef.current?.pubkey ?? null;
      const alreadyInRequestedRole =
        !!currentPubkey && latest?.participants?.[role] === currentPubkey;
      if (msg.includes("Cannot JOIN") || msg.includes("TERMINAL") ||
          ((e?.code === "ALREADY_PARTICIPANT" || msg.includes("already a participant")) &&
            alreadyInRequestedRole)) {
        console.debug("[chama] Join suppressed:", msg);
        saveEscrowId(escrowId, stateRef.current?.pubkey ?? null);
        return client.getState(escrowId)!;
      }
      throw e;
    }
  }, []);

	  const requireBridge = (): EscrowFedimintBridge => {
	    if (!bridgeRef.current && clientRef.current && fedimintRef.current && signerRef.current) {
	      const fedimint = fedimintRef.current;
	      if (fedimint.isInitialized() && fedimint.isJoined()) {
	        console.debug("[chama] Rebuilding missing Fedimint bridge from live wallet refs");
	        bridgeRef.current = new EscrowFedimintBridge(
	          clientRef.current,
	          fedimint,
	          signerRef.current,
	        );
	      }
	    }
	    if (!bridgeRef.current) {
	      throw new Error(
	        "Fedimint wallet not ready — join a federation before locking or claiming"
	      );
	    }
    return bridgeRef.current;
  };

  const lockAndPublishAction = useCallback(async (
    escrowId: string,
    opts: { savedHandleId?: string; selectedItems?: SelectedMenuItem[] } = {},
  ) => {
    const client = requireClient();
    const bridge = requireBridge();
    try {
      // v2.3: fold in the consensus-safe substitution-grace override (if the
      // power-user card set one) so it rides into the signed LOCK. Absent ⇒
      // legacy 4h default.
      const graceOverride = readSubstitutionGraceOverride();
      const result = await bridge.lockAndPublish(escrowId, {
        ...opts,
        ...(graceOverride !== null ? { substitutionGraceSeconds: graceOverride } : {}),
      });
      vibrate([60, 30, 60, 30, 120]);
      // Refresh balance after spending ecash
      refreshBalanceRef.current?.().catch(() => {});
      return result;
    } catch (e: any) {
      const msg = e?.message || "";
      if (msg.includes("Cannot LOCK") || msg.includes("TERMINAL")) {
        console.debug("[chama] Lock suppressed:", msg);
        return client.getState(escrowId)!;
      }
      throw e;
    }
  }, []);

  const lockAndPublishWithEcashAction = useCallback(async (
    escrowId: string,
    oobNotes: string,
    opts: { savedHandleId?: string; selectedItems?: SelectedMenuItem[] } = {},
  ) => {
    const client = requireClient();
    const bridge = requireBridge();
    try {
      const graceOverride = readSubstitutionGraceOverride();
      const result = await bridge.lockAndPublishWithEcash(escrowId, oobNotes, {
        ...opts,
        ...(graceOverride !== null ? { substitutionGraceSeconds: graceOverride } : {}),
      });
      vibrate([60, 30, 60, 30, 120]);
      refreshBalanceRef.current?.().catch(() => {});
      return result;
    } catch (e: any) {
      const msg = e?.message || "";
      if (msg.includes("Cannot LOCK") || msg.includes("TERMINAL")) {
        console.debug("[chama] Lock suppressed:", msg);
        return client.getState(escrowId)!;
      }
      throw e;
    }
  }, []);

  // Hard-failure signatures — errors we treat as red-toast worthy.
  // These mean the claim will NEVER succeed; retrying won't help.
  // Anything NOT on this list is assumed transient (federation may settle later).
  const isHardClaimFailure = (msg: string): boolean => {
    return msg.includes("not the winner") ||
           msg.includes("not APPROVED") ||
           msg.includes("Not enough shares") ||
           msg.includes("No lock data") ||
           msg.includes("hash mismatch") ||
           msg.includes("Notes hash mismatch") ||
           msg.includes("shares may be corrupted") ||
           msg.includes("You are not");
  };

  // Stale-state signatures — these mean the action was a no-op because state
  // already advanced. Suppress silently (same behavior as pre-v0.1.62).
  //
  // v0.1.66.34: tightened from substring matches on "already"/"Cannot"
  // to specific state-machine error signatures. The previous predicate
  // matched JavaScript TypeErrors like "Cannot read properties of
  // undefined" — those are real bugs we want surfaced, not staleness.
  const isStaleClaim = (msg: string): boolean => {
    return msg.includes("already claimed") ||
           msg.includes("Cannot claim in state") ||
           msg.includes("Cannot CLAIM") ||
           msg.includes("TERMINAL_STATE");
  };

  /**
   * Poll the wallet balance, watching for an inbound delta that looks like
   * the claim settling. Runs for ~120 seconds or until we see it.
   *
   * Resolves once with either "success" (if balance grew by expected amount)
   * or "timeout" (if it didn't). Never rejects — this is a best-effort check.
   */
  const startClaimWatchdog = useCallback((
    escrowId: string,
    balanceBefore: number,
    expectedDeltaMsats: number,
  ): Promise<"success" | "timeout"> => {
    return new Promise((resolve) => {
      const fedimint = fedimintRef.current;
      if (!fedimint) { resolve("timeout"); return; }

      // Tolerance: accept any delta >= 90% of expected. Fedimint settles can
      // have tiny variances from fee routing, and we'd rather false-positive
      // a success than false-negative it into timeout territory.
      const threshold = Math.floor(expectedDeltaMsats * 0.9);
      const maxTicks = 24;       // 24 * 5s = 120s
      const tickMs = 5_000;
      let ticks = 0;

      const check = async () => {
        // v0.1.66.34: bail out if the hook unmounted while we were
        // asleep. Resolving as "timeout" keeps the promise chain in
        // the claim action sane without leaking state updates into a
        // stale component.
        if (!mountedRef.current) { resolve("timeout"); return; }
        ticks++;
        try {
          const now = await fedimint.getBalance();
          if (!mountedRef.current) { resolve("timeout"); return; }
          updateFedimint({ balanceMsats: now });
          const delta = now - balanceBefore;
          if (delta >= threshold) {
            resolve("success");
            return;
          }
        } catch (e) {
          console.debug("[chama] watchdog getBalance threw:", e);
        }
        if (ticks >= maxTicks) {
          resolve("timeout");
          return;
        }
        setTimeout(check, tickMs);
      };

      setTimeout(check, tickMs);
    });
  }, [updateFedimint]);

  const claimAndRedeemAction = useCallback(async (escrowId: string) => {
    const client = requireClient();
    const bridge = requireBridge();
    const fedimint = fedimintRef.current;
    // v0.1.66.31: wrap notify so phase:success triggers COMPLETE publish.
    // Best-effort — errors are swallowed (COMPLETE is advisory; the
    // reconciliation hook in loadEscrow will retry on next app reload).
    const userNotify = config?.onClaimProgress;
    const notify = (progress: ClaimPhase) => {
      userNotify?.(progress);
      if (progress.phase === "success") {
        clientRef.current?.complete(progress.escrowId).catch(e =>
          console.debug("[chama] post-claim COMPLETE publish failed:", (e as Error)?.message || e)
        );
      }
    };

    // Snapshot balance before we touch anything, so the watchdog knows
    // what "before" meant. If we can't read balance, the watchdog just
    // times out and the user sees the neutral info toast. No drama.
    let balanceBefore = 0;
    try {
      if (fedimint) balanceBefore = await fedimint.getBalance();
    } catch {}

    // Expected amount back: current Fedi/ecash claims settle the whole
    // reconstructed token. Fee fields remain part of the protocol record,
    // but must not reduce this expectation until actual payout fan-out can
    // split proceeds safely.
    const state = client.getState(escrowId);
    const expectedDeltaMsats = state ? state.amountMsats : 0;

    const finishWhenBalanceConfirms = (viaWatchdog: boolean) => {
      startClaimWatchdog(escrowId, balanceBefore, expectedDeltaMsats).then(
        (outcome) => {
          if (outcome === "success") {
            vibrate([100, 50, 100, 50, 200]);
            refreshBalanceRef.current?.().catch(() => {});
            notify?.({
              phase: "success",
              escrowId,
              deltaMsats: expectedDeltaMsats,
              viaWatchdog,
            });
          } else {
            notify?.({ phase: "timeout", escrowId });
          }
        },
        (err) => {
          console.warn("[chama] watchdog rejected unexpectedly:", err);
          notify?.({ phase: "timeout", escrowId });
        },
      );
    };

    notify?.({ phase: "submitted", escrowId });

    try {
      const result = await bridge.claimAndRedeem(escrowId);
      // The bridge can resolve as soon as redeemEcash is accepted, before
      // the wallet balance stream has fully caught up. Keep legacy callers
      // from auto-publishing COMPLETE until the same watchdog sees money.
      refreshBalanceRef.current?.().catch(() => {});
      notify?.({
        phase: "watching",
        escrowId,
        reason: "Waiting for federation balance confirmation",
      });
      finishWhenBalanceConfirms(false);
      return result;
    } catch (e: any) {
      const msg = e?.message || String(e);

      // v0.1.63: partial-success claim — chain correct, redeem in flight
      // ─────────────────────────────────────────────────────────────────
      // The bridge publishes CLAIM before calling redeemWithRetry. If the
      // redeem throws after CLAIM is on relays, the bridge wraps the error
      // with {claimPublished: true}. Treat this as "watching" — the chain
      // is correct, and the balance watchdog will either see the sats
      // land or time out gracefully. No red toast.
      if (e?.claimPublished) {
        console.warn(
          "[chama] Claim published, redeem failed — starting balance watchdog:",
          msg,
        );
        notify?.({ phase: "watching", escrowId, reason: msg });
        finishWhenBalanceConfirms(true);
        return client.getState(escrowId)!;
      }

      // Stale state (escrow already past APPROVED from a relay echo, etc.)
      // — silently return the current local state. No toast.
      if (isStaleClaim(msg)) {
        console.debug("[chama] Claim suppressed (stale):", msg);
        return client.getState(escrowId)!;
      }

      // Hard failure — notify, then re-throw for the UI to red-toast.
      if (isHardClaimFailure(msg)) {
        notify?.({ phase: "failure", escrowId, reason: msg });
        throw e;
      }

      // v0.3.1 Phase 1: typed bridge errors propagate. FED_PROBE_FAILED
      // (federation unreachable at probe time) and FED_MISMATCH (wallet
      // is on a different fed than the trade's notes) are structural
      // bridge failures, not network hiccups. They have a clean retry
      // semantic — once the fed is reachable / the user switches feds,
      // the same claim works. Propagating them as throws lets
      // claim-and-payout route them to the new `claim-bridge-threw`
      // terminal with a Try-again affordance, instead of silently
      // dropping into the in-flight watchdog (which is useless here
      // because the bridge bailed before any redeem happened).
      if (e?.code === "FED_PROBE_FAILED" || e?.code === "FED_MISMATCH") {
        notify?.({ phase: "failure", escrowId, reason: msg });
        throw e;
      }

      // Probably transient (worker timeout, RPC hiccup, "fetch failed", etc.)
      // The federation very likely IS processing the redeem. Start watching
      // balance instead of throwing.
      console.warn(
        "[chama] Claim bridge threw — treating as in-flight, watching balance.",
        msg,
      );
      notify?.({ phase: "watching", escrowId, reason: msg });

      // Kick the watchdog off, but return immediately so the UI doesn't hang.
      // When watchdog resolves, we notify success/timeout.
      finishWhenBalanceConfirms(true);

      // Return the local state so the UI doesn't show an error state.
      // The state will update naturally as the CLAIM event echoes back
      // from relays (if the bridge managed to publish it before the
      // timeout) or from the next loadEscrow.
      return client.getState(escrowId)!;
    }
  }, [config?.onClaimProgress, startClaimWatchdog]);

  // Forward-reference refreshBalance from within lock/claim actions
  const refreshBalanceRef = useRef<(() => Promise<void>) | null>(null);

  const voteAction = useCallback(async (escrowId: string, outcome: Outcome) => {
    const client = requireClient();
    try {
      const result = await client.vote(escrowId, outcome);
      vibrate(outcome === Outcome.RELEASE ? [80, 40, 80] : [60, 30, 60, 30, 60]);
      return result;
    } catch (e: any) {
      // v1.2.2 vote-freeze fix: previously this branch silently
      // returned the current state on duplicate/stale errors, which
      // fired the App's success toast as if the tap had published
      // a vote — leaving sellers staring at the same screen wondering
      // if anything happened. Now we re-throw a typed error so the
      // App's onVote handler can show an info toast distinct from a
      // real publish error. State-machine semantics are unchanged:
      // the duplicate/stale event was rejected, and the caller can
      // still recover the current state via getState if needed.
      const msg = e?.message || "";
      if (msg.includes("already voted") || msg.includes("Cannot vote") ||
          msg.includes("TERMINAL") || msg.includes("not LOCKED")) {
        console.debug("[chama] Vote suppressed:", msg);
        const swallowed = new Error(
          msg.includes("already voted")
            ? "Vote already recorded for this trade."
            : msg.includes("not LOCKED")
              ? "Trade is no longer accepting votes."
              : msg.includes("TERMINAL")
                ? "Trade has already settled — no further votes accepted."
                : "This vote can no longer be cast.",
        ) as Error & { voteSuppressed?: true; code?: string; originalMessage?: string; currentState?: EscrowState | null };
        swallowed.voteSuppressed = true;
        swallowed.code = "VOTE_SUPPRESSED";
        swallowed.originalMessage = msg;
        swallowed.currentState = client.getState(escrowId);
        throw swallowed;
      }
      throw e;
    }
  }, []);

  const sendChat = useCallback(async (
    escrowId: string,
    message: string | { message: string; attachments?: ChatImageAttachment[] },
  ) => {
    const client = requireClient();
    await client.sendChat(escrowId, message);
    vibrate(15); // Subtle tap
  }, []);

  const cancelAction = useCallback(async (escrowId: string, reason?: string) => {
    const client = requireClient();
    const result = await client.cancel(escrowId, reason);
    vibrate([50, 100]);
    return result;
  }, []);

  const loadEscrow = useCallback(async (escrowId: string) => {
    const client = requireClient();
    // Loading a trade by ID is a deliberate "bring it back" — clear any
    // forgotten-denylist entry so it can surface and persist again.
    unforgetEscrowId(escrowId, stateRef.current?.pubkey ?? null);
    forgottenIdsRef.current.delete(escrowId);
    setState(prev => ({ ...prev, loading: true }));
    try {
      const result = await client.loadEscrow(escrowId);
      if (result) saveEscrowId(escrowId, stateRef.current?.pubkey ?? null);
      setState(prev => ({ ...prev, loading: false }));
      return result;
    } catch (e) {
      setState(prev => ({
        ...prev,
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      }));
      return null;
    }
  }, []);

  const rebroadcastEscrow = useCallback(async (escrowId: string) => {
    const client = requireClient();
    return client.rebroadcastEscrow(escrowId);
  }, []);

  const purchaseFromListing = useCallback(async (parent: EscrowState, quantity: number) => {
    const client = requireClient();
    const result = await client.purchaseFromListing(parent, quantity);
    saveEscrowId(result.escrowId, stateRef.current?.pubkey ?? null);
    return result;
  }, []);

  /** Forget a trade locally: drop its saved pointer and hide it from the
   *  in-memory list. For unrecoverable "ghost" trades the user wants out of
   *  their view. Non-custodial-safe — money lives in 2-of-3 escrow regardless,
   *  and the trade can always be re-loaded by ID, which re-saves the pointer. */
  const forgetEscrow = useCallback((escrowId: string) => {
    const pk = stateRef.current?.pubkey ?? null;
    removeEscrowId(escrowId, pk);
    // Persistently deny-list it so the Browse feed can't re-add it on the next
    // restart; updateEscrow honors this (via the in-memory ref). Cleared when
    // the user loads it by ID.
    addForgottenEscrowId(escrowId, pk);
    forgottenIdsRef.current.add(escrowId);
    // Stop watching it too, so a late relay event can't silently re-add a
    // ghost the user just dismissed. Re-loading by ID re-subscribes.
    clientRef.current?.unwatchEscrow(escrowId);
    setState(prev => {
      if (!prev.escrows.has(escrowId)) return prev;
      const next = new Map(prev.escrows);
      next.delete(escrowId);
      return { ...prev, escrows: next };
    });
  }, []);

  const fetchNostrProfiles = useCallback(async (pubkeys: string[]): Promise<NostrProfileNameMap> => {
    const client = clientRef.current;
    if (!client) return {};

    const authors = Array.from(new Set(
      pubkeys
        .map(pk => pk.trim().toLowerCase())
        .filter(pk => /^[0-9a-f]{64}$/.test(pk)),
    ));
    if (authors.length === 0) return {};

    const events = await client.queryOnce(
      { kinds: [0], authors, limit: Math.max(1, authors.length * 2) },
      3_000,
    );

    const profiles: NostrProfileNameMap = {};
    const newestFirst = [...events].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
    for (const event of newestFirst) {
      const author = event.pubkey?.toLowerCase();
      if (!author || profiles[author]) continue;
      const name = extractNostrProfileName(event.content ?? "");
      if (name) profiles[author] = name;
    }

    return profiles;
  }, []);

  // ── Fedimint actions ────────────────────────────────────────────────────

  const refreshBalance = useCallback(async () => {
    const fedimint = fedimintRef.current;
    if (!fedimint || !fedimint.isJoined()) return;
    try {
      const balanceMsats = await fedimint.getBalance();
      updateFedimint({ balanceMsats });
    } catch (e) {
      console.debug("[chama] refreshBalance error:", e);
    }
  }, [updateFedimint]);

  const readBalance = useCallback(async (): Promise<number> => {
    const fedimint = fedimintRef.current;
    if (!fedimint || !fedimint.isJoined()) {
      return stateRef.current?.fedimint.balanceMsats ?? 0;
    }
    const balanceMsats = await fedimint.getBalance();
    updateFedimint({ balanceMsats });
    return balanceMsats;
  }, [updateFedimint]);

  // Keep the ref in sync so lock/claim actions can call it without
  // recreating their callbacks.
  refreshBalanceRef.current = refreshBalance;

  const markFedimintWalletNotReady = useCallback((message = FEDIMINT_WALLET_NOT_READY) => {
    const at = Date.now();
    healthRef.current = { ok: false, at };
    updateFedimint({
      initialized: false,
      joined: false,
      busy: false,
      error: message,
      lastHealthOk: false,
      lastHealthAt: at,
      bootProbeState: "failed",
    });
  }, [updateFedimint]);

  const initFedimint = useCallback(async (
    inviteCode?: string,
    options?: { force?: boolean; persistCustom?: boolean },
  ) => {
    if (!clientRef.current || !signerRef.current) {
      throw new Error("Connect to relays before initializing Fedimint");
    }

    const force = options?.force === true;
    const persistCustom = options?.persistCustom !== false;

    updateFedimint({ busy: true, error: null });

    try {
      // PR 2: resolve via the community-aware path. Precedence is
      // explicit arg > custom stored invite > community.federationInvite
      // > BLF default.
      const userCommunity = getUserCommunitySlug();
      const explicitInvite = inviteCode?.trim() || "";
      const communityInvite = getCommunityBySlug(userCommunity)?.federationInvite ?? null;
      const desiredInvite = explicitInvite
        || resolveFederationForCommunity(userCommunity);
      const previousActiveInvite = getActiveInvite();

      // Wait for at least one relay to actually accept publishes before
      // running the seed round-trip. `state.connected` flips true
      // synchronously when client.connect() is dispatched, but the
      // relay WebSocket handshakes happen async — racing this gate
      // sends getOrCreateSeed's publishRaw into "No connected relays —
      // cannot publish" on first-launch (no seed marker) users. Match
      // the saved-escrow-reload pattern (line ~671): bounded wait, ≥1
      // relay is enough since seed publish goes to all of them.
      if (!isTestnetMode() && !isSimModeOn()) {
        const client: any = clientRef.current;
        let waited = 0;
        while (waited < 5000) {
          const connectedCount = [...client.relayManager.relays.values()]
            .filter((r: any) => r.status === "connected").length;
          if (connectedCount >= 1) break;
          await new Promise(r => setTimeout(r, 250));
          waited += 250;
        }
      }

      // Fetch (or generate + publish) the Fedimint seed from Nostr
      // *before* initializing the wallet. The seed is encrypted to the
      // user's own pubkey and stored as a replaceable kind-30078 event,
      // so the wallet is recoverable on any device with access to the
      // user's signer. In testnet/sim mode the mock wallets ignore the
      // mnemonic, so we skip the Nostr round-trip.
      const skipMnemonic = isTestnetMode() || isSimModeOn();
      const mnemonic = skipMnemonic
        ? undefined
        : await getOrCreateSeed(clientRef.current!, signerRef.current!);
      // Sim wallet keys its persisted state by npub so multiple
      // identities in the same browser don't share a sim balance.
      const activePubkey = await signerRef.current!.getPublicKey().catch(() => null);
      const simNpub = isSimModeOn()
        ? activePubkey
        : null;
      const storageScope = !skipMnemonic
        ? activePubkey
        : null;

      const buildClient = () => new FedimintClient({
        onBalanceUpdate: (balance) => updateFedimint({ balanceMsats: balance }),
        onFederationJoined: (fedId) =>
          updateFedimint({ joined: true, federationId: fedId }),
        onError: (err, ctx) => {
          console.warn(`[chama] fedimint error (${ctx}):`, err);
          updateFedimint({ error: `${ctx}: ${err.message}` });
        },
      });

      // Reuse the in-memory client if init already ran this session;
      // otherwise create + init a fresh one against whatever the OPFS
      // currently holds.
      let fedimint = fedimintRef.current;
      if (fedimint && !fedimint.isInitialized()) {
        fedimintRef.current = null;
        bridgeRef.current = null;
        fedimint = null;
      }
      if (!fedimint) {
        fedimint = buildClient();
        await fedimint.init({ mnemonic, storageScope, simNpub });
        fedimintRef.current = fedimint;
        updateFedimint({ initialized: true });
      }

      // PR 5 (v0.1.82+): cold-start reconciliation with balance guard.
      // ───────────────────────────────────────────────────────────────
      // After init, the in-memory client mirrors whatever the OPFS
      // holds. If the user's preferred invite differs from the
      // last-joined invite (drift — typically from a previous-session
      // paste that the old "case (b) silent no-op" stored without
      // actually switching), we may need to wipe + rejoin.
      //
      // CRITICAL: ecash on the OPFS-bound fed is bearer cash. A silent
      // wipe destroys it. So before wiping, peek the balance:
      //   - no Lightning-withdrawable balance → safe to wipe + rejoin
      //                                        silently. Tiny dust cannot
      //                                        be recovered through the UI.
      //   - withdrawable balance && !force    → REFUSE; throw structured
      //                                        error that the UI catches and
      //                                        surfaces as a destroy-confirm
      //                                        modal.
      //   - withdrawable balance && force     → user-confirmed destruction;
      //                                        proceed.
      //
      // This is the load-bearing safety. Without it, a refresh + wrong
      // fed pick destroys notes purely and simply (reproduced twice
      // during v0.1.81 testing).
      const walletIsJoined = fedimint.isJoined();
      const walletFederationId = fedimint.getFederationId();
      const driftDetected = shouldReconcileFederation({
        previousActiveInvite,
        desiredInvite,
        walletIsJoined,
        walletFederationId,
      });
      if ((import.meta as any).env?.DEV) {
        console.info("[chama] initFedimint route", {
          userCommunity,
          explicitInvite: explicitInvite ? explicitInvite.slice(0, 24) + "…" : null,
          communityInvite: communityInvite ? communityInvite.slice(0, 24) + "…" : null,
          desiredInvite: desiredInvite.slice(0, 24) + "…",
          previousActiveInvite: previousActiveInvite ? previousActiveInvite.slice(0, 24) + "…" : null,
          walletIsJoined,
          walletFederationId,
          driftDetected,
        });
      }

      if (driftDetected) {
        const fundingSignal = fundingInProgressRef.current;
        const fundingInFlight = !!fundingSignal && !fundingSignal.aborted;
        if (fundingInFlight || claimPayoutInProgressRef.current) {
          const err = new Error(
            fundingInFlight
              ? "Refusing to switch federations while a funding operation is in progress."
              : "Refusing to switch federations while a claim payout is in progress.",
          );
          (err as Error & { code?: string }).code = "RECONCILE_REFUSED_MONEY_FLOW_IN_PROGRESS";
          throw err;
        }

        let opfsBalanceMsats = 0;
        try {
          opfsBalanceMsats = await fedimint.getBalance();
        } catch (e) {
          // If we can't read the balance, treat as unknown — refuse
          // without force rather than risk silent destruction.
          console.debug("[chama] reconcile: balance read failed:", e);
          opfsBalanceMsats = -1;
        }

        const balanceUnknown = opfsBalanceMsats < 0;
        // Material dust line: only a recoverable-worth balance blocks the switch
        // (same predicate the UI decision + modal use). Sub-material dust — e.g.
        // ~1 sat that costs more than itself to recover — switches silently.
        const balanceWithdrawable = balanceBlocksFederationSwitch(opfsBalanceMsats);
        if (!force && (balanceUnknown || balanceWithdrawable)) {
          const sats = opfsBalanceMsats > 0
            ? Math.floor(opfsBalanceMsats / 1000)
            : null;
          const refuseErr = new Error(
            sats !== null
              ? `Refusing to switch federations: ${sats} sats are held on ` +
                `your current federation and would be permanently destroyed ` +
                `when the local wallet is wiped. Move funds out (Lightning ` +
                `withdrawal) before switching, or confirm destruction explicitly.`
              : `Refusing to switch federations: couldn't verify the local ` +
                `wallet balance. Try again, or confirm destruction explicitly.`,
          );
          (refuseErr as Error & {
            code?: string;
            balanceMsats?: number;
            previousActiveInvite?: string;
            desiredInvite?: string;
          }).code = "RECONCILE_REFUSED_NONZERO_BALANCE";
          (refuseErr as Error & {
            code?: string;
            balanceMsats?: number;
            previousActiveInvite?: string;
            desiredInvite?: string;
          }).balanceMsats = opfsBalanceMsats > 0 ? opfsBalanceMsats : 0;
          (refuseErr as Error & {
            code?: string;
            balanceMsats?: number;
            previousActiveInvite?: string;
            desiredInvite?: string;
          }).previousActiveInvite = previousActiveInvite ?? "";
          (refuseErr as Error & {
            code?: string;
            balanceMsats?: number;
            previousActiveInvite?: string;
            desiredInvite?: string;
          }).desiredInvite = desiredInvite;
          throw refuseErr;
        }

        // Safe-to-wipe path: balance is 0, OR force === true.
        console.warn(
          "[chama] reconcile: wiping OPFS to switch federations",
          {
            previous: previousActiveInvite
              ? previousActiveInvite.slice(0, 24) + "…"
              : "(untracked OPFS)",
            desired: desiredInvite.slice(0, 24) + "…",
            balanceMsats: opfsBalanceMsats,
            forced: force,
          },
        );
        try { await fedimint.cleanup(); } catch {}
        fedimintRef.current = null;
        bridgeRef.current = null;
        healthRef.current = { ok: null, at: null };
        try {
          await resetLocalFedimintWallet({ storageScope });
        } catch (e) {
          console.warn("[chama] reconcile wipe threw (non-fatal):", e);
        }
        clearActiveInvite();

        // Re-create + init against the now-empty OPFS so joinFederation
        // below lands on the desired fed cleanly (no v0.1.69 case-c
        // throw, no case-b silent no-op).
        fedimint = buildClient();
        await fedimint.init({ mnemonic, storageScope, simNpub });
        fedimintRef.current = fedimint;
      }

      const effectiveInvite = desiredInvite;
      const usingCommunityPinnedInvite =
        !!communityInvite && effectiveInvite === communityInvite && !persistCustom;
      const staleCustomOverriddenByCommunity =
        !!communityInvite && effectiveInvite === communityInvite && !explicitInvite;
      const usingCustom =
        persistCustom
        && !staleCustomOverriddenByCommunity
        && (!!explicitInvite || hasCustomFederation());

      // Join federation (idempotent in the SDK when already on the
      // same fed; lands cleanly on the new fed when post-wipe).
      const federationId = await fedimint.joinFederation(effectiveInvite);

      // PR 5: record the actually-joined invite so the next cold start
      // can reconcile if the user later switches preference.
      setActiveInvite(effectiveInvite);
      if (usingCustom && explicitInvite && persistCustom) {
        setCustomFederationInvite(effectiveInvite);
      } else if (usingCommunityPinnedInvite || staleCustomOverriddenByCommunity) {
        setCustomFederationInvite("");
      }

      // Construct the bridge now that we have a working wallet
      bridgeRef.current = new EscrowFedimintBridge(
        clientRef.current,
        fedimint,
        signerRef.current
      );

      // Read initial balance
      let balanceMsats = 0;
      try {
        balanceMsats = await fedimint.getBalance();
      } catch {
        // fresh wallet — balance fetch may fail briefly after join
      }

      // v0.1.68: Drain any pending-redemption stash in the background.
      // ─────────────────────────────────────────────────────────────────
      // If a previous session died between CLAIM publish and redeem
      // complete (the sm_moadjfkb_9ue9pd5p failure mode), oobNotes are
      // sitting in localStorage waiting to be redeemed. Fire the drain
      // fire-and-forget: onBalanceUpdate (wired above) will push the
      // new balance into state as redemptions land, so the user sees
      // balance tick up without a blocking spinner on init.
      //
      // Drain errors are already logged inside drainPendingRedemptions;
      // the outer .catch here is defense-in-depth against an unexpected
      // throw outside the per-entry try blocks.
      drainPendingRedemptions(fedimint).catch((e) =>
        console.warn("[chama] pending-redemption drain error:", e)
      );

      // v0.1.69: Seed health check + staleness republish.
      // ─────────────────────────────────────────────────────────────────
      // Query relays for the current seed event and republish if it's
      // older than SEED_REPUBLISH_INTERVAL_MS (7 days). Also records
      // health info (relay count, timestamps) to localStorage for UI
      // consumption in a future release.
      //
      // Fresh-generation case: if getOrCreateSeed just generated a new
      // seed this session, its created_at ≈ now, so the staleness check
      // returns false and no republish happens — satisfying the "only
      // republish on recovery, not fresh generation" rule naturally.
      //
      // Fire-and-forget, matches the v0.1.68 drain pattern. Non-blocking
      // so UI transitions to the "joined" state without waiting.
      if (!isTestnetMode() && !isSimModeOn()) {
        checkAndMaybeRepublishSeed(
          clientRef.current!,
          signerRef.current!
        ).catch((e) =>
          console.warn("[chama] seed health check error:", e)
        );
      }

      // PR 5: a successful join is itself proof of reachability — seed
      // the health cache so the first invoice doesn't have to probe.
      // v0.3.1 Phase 3 caveat: this optimism is WRONG in the
      // broken-quorum case (Bitcoin Principles production smoke: join
      // succeeded against a federation with 3-of-4 guardians dead,
      // because join only requires reading public federation info
      // which any single guardian can serve; but mint operations need
      // the threshold and fail downstream). The boot probe below
      // overrides this seed when it actually exercises mint-touching
      // RPC — that's the only check that catches broken-quorum.
      const joinedAt = Date.now();
      healthRef.current = { ok: true, at: joinedAt };
      updateFedimint({
        initialized: true,
        joined: true,
        federationId,
        federationName: federationNameForInvite(effectiveInvite)
          ?? (usingCustom ? "External route" : BP_FEDERATION_NAME),
        isCustom: usingCustom,
        balanceMsats,
        busy: false,
        error: null,
        lastHealthOk: true,
        lastHealthAt: joinedAt,
        // Reset boot probe to pending; the probe below sets ok/failed.
        bootProbeState: "pending",
      });

      vibrate([40, 20, 40, 20, 80]);

      // v0.3.1 Phase 3: cold-boot federation probe. Sequential — runs
      // AFTER initFedimint has resolved init successfully. If init
      // throws (preceding catch), this block is skipped and
      // bootProbeState stays "pending" (but fedimint.joined === false
      // in that case, so the existing not-joined Reconnect surface in
      // ChamaBar handles the UX, not the new "unreachable" variant).
      //
      // Probe1 vs probe2:
      //   probe1 — this block, fires once per initFedimint
      //   probe2 — the just-in-time check inside createFundingInvoice
      //            (line ~1614) and escrow-bridge probes at lock/claim.
      //   Probe2 sites are unchanged; the boot gate ensures probe2
      //   never has to surface the first "federation unreachable"
      //   error to the user mid-trade-composition.
      try {
        await fedimint.probeReachable();
        const probeOkAt = Date.now();
        healthRef.current = { ok: true, at: probeOkAt };
        updateFedimint({
          bootProbeState: "ok",
          lastHealthOk: true,
          lastHealthAt: probeOkAt,
        });
      } catch (probeErr) {
        // Probe failed — joined the fed but it's structurally broken
        // (e.g., quorum dead). Override the optimistic ok seed above.
        // The ChamaBar "⚠ Chama unreachable · Reconnect →" pill picks
        // up bootProbeState=failed and the Fund + Claim buttons gate
        // themselves on the same flag.
        const probeFailedAt = Date.now();
        const probeMsg = probeErr instanceof Error ? probeErr.message : String(probeErr);
        console.warn("[chama] boot probe failed:", probeMsg);
        healthRef.current = { ok: false, at: probeFailedAt };
        updateFedimint({
          bootProbeState: "failed",
          lastHealthOk: false,
          lastHealthAt: probeFailedAt,
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      updateFedimint({ busy: false, error: message });
      throw e;
    }
  }, [updateFedimint]);

  const setCustomInvite = useCallback((inviteCode: string) => {
    setCustomFederationInvite(inviteCode);
    const trimmed = inviteCode.trim();
    updateFedimint({
      isCustom: !!trimmed,
      federationName: federationNameForInvite(trimmed)
        ?? (trimmed ? "External route" : BP_FEDERATION_NAME),
    });
  }, [updateFedimint]);

  // v0.1.76 fund-loss protection: resetLocalWallet refuses to wipe
  // OPFS if there is a non-zero balance, unless caller passes
  // `force: true`. The UI layer is responsible for surfacing the
  // destruction explicitly to the user before passing force.
  const resetLocalWallet = useCallback(async (
    options: { force?: boolean } = {},
  ) => {
    const { force = false } = options;

    // Read the current balance from the live wallet, if any. If we
    // can't read it, treat as "unknown" and refuse without force —
    // we'd rather false-positive than destroy bearer notes.
    let currentBalanceMsats: number | null = null;
    try {
      if (fedimintRef.current) {
        currentBalanceMsats = await fedimintRef.current.getBalance();
      }
    } catch (e) {
      console.debug("[chama] balance read during reset:", e);
    }

    if (!force && currentBalanceMsats !== null && currentBalanceMsats > 0) {
      const sats = Math.floor(currentBalanceMsats / 1000);
      const err = new Error(
        `Refusing to reset local wallet: ${sats} sats would be ` +
        `permanently destroyed (Fedimint ecash is bearer cash and ` +
        `lives only in the local wallet file). Use force=true to ` +
        `override after explicit user confirmation.`,
      );
      (err as Error & { code?: string; balanceMsats?: number }).code =
        "RESET_REFUSED_NONZERO_BALANCE";
      (err as Error & { code?: string; balanceMsats?: number })
        .balanceMsats = currentBalanceMsats;
      throw err;
    }

    // Tear down the in-memory wallet first so the OPFS delete isn't
    // blocked by the WASM worker holding the database open.
    try {
      await fedimintRef.current?.cleanup();
    } catch (e) {
      console.debug("[chama] fedimint cleanup during reset:", e);
    }
    fedimintRef.current = null;
    bridgeRef.current = null;
    clearSeedCache();
    healthRef.current = { ok: null, at: null };
    clearActiveInvite();

    const activePubkey = await signerRef.current?.getPublicKey().catch(() => null) ?? null;
    await resetLocalFedimintWallet({ storageScope: activePubkey });

    updateFedimint({
      initialized: false,
      joined: false,
      federationId: null,
      balanceMsats: 0,
      busy: false,
      error: null,
      lastHealthOk: null,
      lastHealthAt: null,
    });
  }, [updateFedimint]);

  // PR 5: switchFederation — production-grade fed switching.
  // ──────────────────────────────────────────────────────────────────────
  // Composed action: reset + reinit-with-new-invite, as one user-facing
  // operation. Promoted from devSwitchFederation in PR 5 — the prior
  // localStorage.chama_dev_fed_switch gate has been dropped.
  //
  // Safety: the v0.1.76 fund-loss guard refuses if the balance is
  // Lightning-withdrawable unless `{ force: true }` is passed. Fedimint
  // ecash is bearer cash and lives only in the local OPFS file — wiping
  // it without checking has destroyed real user sats in the past. Callers
  // (UI) must only pass force after explicit user confirmation.
  const switchFederation = useCallback(async (
    inviteCode: string,
    options: { force?: boolean; persistCustom?: boolean } = {},
  ) => {
    const { force = false } = options;
    const persistCustom = options.persistCustom !== false;

    const trimmed = inviteCode.trim();
    if (!trimmed.startsWith("fed1")) {
      throw new Error("Invite code must start with 'fed1'");
    }

    // v0.1.76 fund-loss protection: balance-aware refusal. v0.7.2
    // aligns this with the recovery UI: sub-fee dust cannot be sent out
    // through Lightning, so it should not strand users behind a
    // "Recover 0 sats" modal.
    let currentBalanceMsats: number | null = null;
    try {
      if (fedimintRef.current) {
        currentBalanceMsats = await fedimintRef.current.getBalance();
      }
    } catch (e) {
      console.debug("[chama] switch-fed: balance read failed:", e);
    }
    if (
      !force
      && currentBalanceMsats !== null
      && balanceBlocksFederationSwitch(currentBalanceMsats)
    ) {
      const sats = Math.floor(currentBalanceMsats / 1000);
      const err = new Error(
        `Refusing federation switch: ${sats} sats would be permanently ` +
        `destroyed when the OPFS file is wiped for the new federation. ` +
        `Move funds out (Lightning withdrawal) before switching, or ` +
        `confirm destruction explicitly in the UI.`,
      );
      (err as Error & { code?: string; balanceMsats?: number }).code =
        "SWITCH_REFUSED_NONZERO_BALANCE";
      (err as Error & { code?: string; balanceMsats?: number })
        .balanceMsats = currentBalanceMsats;
      throw err;
    }

    console.info("[chama] switching federation to", trimmed.slice(0, 24) + "...");
    updateFedimint({ busy: true, error: null });

    try {
      // Step 1 — tear down the current wallet (terminates worker, releases OPFS handle)
      try {
        await fedimintRef.current?.cleanup();
      } catch (e) {
        console.debug("[chama] switch-fed: cleanup threw (non-fatal):", e);
      }
      fedimintRef.current = null;
      bridgeRef.current = null;
      // NOTE: do NOT clearSeedCache() here. The Fedimint seed is per-pubkey
      // (encrypted to the user's own Nostr identity), not per-federation —
      // it survives a fed switch unchanged. Clearing it forces the next
      // initFedimint to re-query Nostr for the seed, which races against
      // post-teardown relay warmup and trips the v0.1.74 seed-safety
      // guard. v0.1.85 smoke testing showed this caused a 100% federation-
      // switch failure rate (every community-pill tap re-fetched the seed
      // from cold relays). The cache stays valid through the switch.
      healthRef.current = { ok: null, at: null };
      // Clear the active-invite record now; initFedimint(trimmed) below
      // will write the new one once the join succeeds.
      clearActiveInvite();

      // Step 2 — wipe OPFS file + rotate filename so init() opens a fresh DB
      const activePubkey = await signerRef.current?.getPublicKey().catch(() => null) ?? null;
      await resetLocalFedimintWallet({ storageScope: activePubkey });

      // Step 3 — persist only Advanced/Sandbox/custom switches as custom
      // overrides. Community taps pass persistCustom:false; those should
      // clear stale custom state so the selected community's pinned invite
      // remains the source of truth on reload.
      if (persistCustom) setCustomFederationInvite(trimmed);
      else setCustomFederationInvite("");

      // Step 4 — clear React state so initFedimint can rebuild from scratch.
      // Reset health probe cache too — the new fed needs its own probe.
      updateFedimint({
        initialized: false,
        joined: false,
        federationId: null,
        balanceMsats: 0,
        lastHealthOk: null,
        lastHealthAt: null,
        busy: true,
        error: null,
      });

      // Step 5 — re-init with the new invite. Reuses the existing
      // initFedimint flow which probes the Nostr seed, joins the new
      // fed, and wires up the balance subscriber.
      await initFedimint(trimmed, { persistCustom });

      console.info("[chama] federation switch complete");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("[chama] federation switch failed:", message);
      updateFedimint({ busy: false, error: message });
      throw e;
    }
  }, [updateFedimint, initFedimint]);

  // PR 5: federation health gate.
  // ──────────────────────────────────────────────────────────────────────
  // Invoice generation is the moment users discover whether the federation
  // can actually transact. A successful join proves reachability at join
  // time, but mid-session the federation may go unreachable (the iroh-
  // canary failure mode) without producing any other surface signal. If
  // we let the user generate an invoice against an unreachable federation,
  // payments to it become orphaned.
  //
  // Cache discipline: 30s TTL. After a successful join/switch we seed
  // ok=true so the first invoice within 30s is fast. Failed probes are
  // also cached — repeat clicks within 30s see the same refusal without
  // hammering the federation.
  const HEALTH_TTL_MS = 30_000;

  const createFundingInvoice = useCallback(async (
    amountMsats: number,
    description: string = "Chama wallet top-up",
    onReceiveState?: (kind: LnReceiveStateKind) => void,
    meta?: ChamaOperationMeta,
  ) => {
    const fedimint = fedimintRef.current;
    if (!fedimint || !fedimint.isInitialized() || !fedimint.isJoined()) {
      markFedimintWalletNotReady();
      throw new Error(FEDIMINT_WALLET_NOT_READY);
    }

    // Health gate: refuse if the most recent probe failed and is still
    // fresh; probe now if the cache is stale or empty.
    const cached = healthRef.current;
    const now = Date.now();
    const fresh = cached.at !== null && (now - cached.at) < HEALTH_TTL_MS;

    let healthy: boolean;
    if (fresh && cached.ok !== null) {
      healthy = cached.ok;
    } else {
      try {
        await fedimint.probeReachable();
        healthy = true;
        healthRef.current = { ok: true, at: now };
        updateFedimint({ lastHealthOk: true, lastHealthAt: now });
      } catch (e) {
        healthy = false;
        healthRef.current = { ok: false, at: now };
        updateFedimint({ lastHealthOk: false, lastHealthAt: now });
        console.warn("[chama] federation probe failed:", e);
      }
    }

    if (!healthy) {
      const fedName = stateRef.current?.fedimint.federationName ?? "(unknown)";
      throw new Error(
        `Wallet temporarily can't receive — federation ${fedName} unreachable. ` +
        `Try again in a moment.`,
      );
    }

    try {
      const invoice = await fedimint.createInvoice(amountMsats, description, onReceiveState, meta);
      const receiveOkAt = Date.now();
      healthRef.current = { ok: true, at: receiveOkAt };
      updateFedimint({ lastHealthOk: true, lastHealthAt: receiveOkAt });
      return invoice;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const receiveFailedAt = Date.now();
      healthRef.current = { ok: false, at: receiveFailedAt };
      updateFedimint({
        lastHealthOk: false,
        lastHealthAt: receiveFailedAt,
        error: message,
      });
      throw e;
    }
  }, [markFedimintWalletNotReady, updateFedimint]);

  // v0.3.0 Phase 2: atomic fund-and-lock orchestrator. Composes the
  // existing createFundingInvoice + lockAndPublishAction into a single
  // flow with a phase callback for granular UI updates. The pure
  // orchestrator lives in src/payments/fund-and-lock.ts (testable
  // without React); this binding wires it to the live wallet.
  const fundAndLockAction = useCallback(async (
    escrowId: string,
    opts: {
      amountMsats: number;
      description: string;
      fundingMethod?: "lightning" | "onchain" | "nwc";
      nwcConnectionString?: string;
      rememberNwc?: boolean;
      savedHandleId?: string;
      selectedItems?: SelectedMenuItem[];
      onPhase: (phase: import("../payments/fund-and-lock.js").FundAndLockPhase) => void;
      signal?: AbortSignal;
    },
  ): Promise<import("../payments/fund-and-lock.js").FundAndLockTerminal> => {
    const fedimint = fedimintRef.current;
    if (!fedimint || !fedimint.isInitialized() || !fedimint.isJoined()) {
      markFedimintWalletNotReady();
      const err = FEDIMINT_WALLET_NOT_READY;
      opts.onPhase({ kind: "lock-failed", error: err });
      return { kind: "lock-failed", error: err };
    }
    if (
      !isSimModeOn() &&
      !isTestnetMode() &&
      opts.amountMsats < MIN_REAL_ATOMIC_FUNDING_MSATS
    ) {
      const err = `${minimumAtomicFundingMessage()} Enter a positive amount for a real Lightning escrow.`;
      opts.onPhase({ kind: "lock-failed", error: err });
      return { kind: "lock-failed", error: err };
    }
    // v0.6.5 funding-operation gate. The shared OPFS wallet's
    // spendNotes call cannot safely overlap with a second runFundAndLock.
    // The ref is the authoritative synchronous read at entry (setState
    // propagation is async — without this, two near-simultaneous Fund
    // taps could both pass the UI gate before React re-renders the
    // disabled button). The setState call drives the UI; the ref
    // stops the race.
    //
    // v0.6.5 follow-up: the ref now holds the AbortSignal of the
    // live run (or null when idle). A non-null + non-aborted ref
    // means a real concurrent call is in flight — reject. A non-null
    // + aborted ref means the previous run was cancelled (the most
    // common cause being React StrictMode's intentional double-mount
    // in dev: first effect mounts run#1, cleanup aborts it, second
    // effect synchronously starts run#2 BEFORE run#1's finally fires
    // and clears the ref). In that case the previous run is dead;
    // let the new run through.
    const inflight = fundingInProgressRef.current;
    if (inflight && !inflight.aborted) {
      const err = "Another funding operation is in progress. Complete it first.";
      opts.onPhase({ kind: "lock-failed", error: err });
      return { kind: "lock-failed", error: err };
    }
    // Capture the signal we'll write to the ref so the finally can
    // compare by identity. If the caller didn't supply one, we mint
    // an internal AbortController so we still have a stable identity
    // to match against.
    const ownSignal = opts.signal ?? new AbortController().signal;
    fundingInProgressRef.current = ownSignal;
    setState(prev => prev.fundingInProgress
      ? prev
      : { ...prev, fundingInProgress: true });
    try {
      if (hasFediInternalGenerateEcash()) {
        opts.onPhase({ kind: "requesting-fedi-ecash" });
        await requireBridge().preflightLock(escrowId);
        let notes: string;
        try {
          ({ notes } = await generateFediEcash(opts.amountMsats, opts.description));
        } catch (error) {
          throw new Error(`Fedi ecash funding failed: ${describeError(error, "Fedi wallet did not return ecash.")}`);
        }
        if (opts.signal?.aborted) {
          opts.onPhase({ kind: "aborted" });
          return { kind: "aborted" };
        }
        opts.onPhase({ kind: "fedi-ecash-created" });
        opts.onPhase({ kind: "locking" });
        await lockAndPublishWithEcashAction(escrowId, notes, {
          savedHandleId: opts.savedHandleId,
          selectedItems: opts.selectedItems,
        });
        opts.onPhase({ kind: "locked" });
        return { kind: "locked" };
      }

      if (opts.fundingMethod === "onchain") {
        const meta = buildChamaOperationMeta({
          flow: "fund_receive",
          escrowId,
          amountMsats: opts.amountMsats,
        });
        opts.onPhase({ kind: "creating-onchain-address" });
        const amountSats = Math.floor(opts.amountMsats / 1000);
        const onchainInfo = await fedimint.getOnchainInfo();
        const pegInFeeSats = Math.max(0, Math.trunc(onchainInfo.pegInFeeSats));
        const minimumDepositSats = Math.max(
          1,
          Math.trunc(onchainInfo.minimumDepositSats || pegInFeeSats + 1),
        );
        if (amountSats < minimumDepositSats) {
          throw new Error(
            `Onchain funding requires at least ${minimumDepositSats.toLocaleString()} sats. ` +
            `Use Lightning for smaller trades.`
          );
        }
        const depositAmountSats = amountSats + pegInFeeSats;
        const baselineMsats = await fedimint.getBalance();
        const deposit = await fedimint.createOnchainDepositAddress(meta);
        if (opts.signal?.aborted) {
          opts.onPhase({ kind: "aborted" });
          return { kind: "aborted" };
        }
        opts.onPhase({
          kind: "onchain-address-created",
          address: deposit.address,
          operationId: deposit.operationId,
          finalityDelay: deposit.finalityDelay,
          pegInFeeSats,
          depositAmountSats,
          minimumDepositSats,
        });
        opts.onPhase({
          kind: "awaiting-onchain-confirmations",
          address: deposit.address,
          operationId: deposit.operationId,
          finalityDelay: deposit.finalityDelay,
          pegInFeeSats,
          depositAmountSats,
          minimumDepositSats,
        });

        let removeAbortListener: (() => void) | undefined;
        const aborted = new Promise<{ kind: "aborted" }>((resolve) => {
          if (!opts.signal) return;
          const listener = () => resolve({ kind: "aborted" });
          opts.signal.addEventListener("abort", listener, { once: true });
          removeAbortListener = () => opts.signal?.removeEventListener("abort", listener);
        });
        const settledDepositPromise = fedimint.awaitOnchainDeposit(deposit.operationId);
        const settled = settledDepositPromise.then(
          (value) => ({ kind: "settled" as const, value }),
          (error) => ({ kind: "error" as const, error }),
        );
        const result = await Promise.race([settled, aborted]);
        if (removeAbortListener) removeAbortListener();
        if (result.kind === "aborted" || opts.signal?.aborted) {
          opts.onPhase({ kind: "aborted" });
          return { kind: "aborted" };
        }
        if (result.kind === "error") {
          throw result.error;
        }
        const settledDeposit = result.value;
        if (
          typeof settledDeposit.amountSats === "number" &&
          settledDeposit.amountSats - pegInFeeSats < amountSats
        ) {
          const netSats = Math.max(0, settledDeposit.amountSats - pegInFeeSats);
          throw new Error(
            `Onchain deposit credited ${netSats.toLocaleString()} sats after federation fee, ` +
            `but this trade needs ${amountSats.toLocaleString()} sats. ` +
            `Send the full ${depositAmountSats.toLocaleString()} sats shown by Chama.`
          );
        }

        opts.onPhase({ kind: "onchain-deposit-confirmed" });

        const requiredBalanceMsats = baselineMsats + Math.floor(opts.amountMsats * 0.9);
        const start = Date.now();
        let balanceReady = false;
        while (Date.now() - start < 120_000) {
          if (opts.signal?.aborted) {
            opts.onPhase({ kind: "aborted" });
            return { kind: "aborted" };
          }
          const balance = await fedimint.getBalance();
          if (balance >= requiredBalanceMsats) {
            balanceReady = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 3_000));
        }
        if (!balanceReady) {
          throw new Error("Onchain deposit was claimed, but Chama balance has not refreshed enough to lock yet. Try again shortly.");
        }

        opts.onPhase({ kind: "locking" });
        await lockAndPublishAction(escrowId, {
          savedHandleId: opts.savedHandleId,
          selectedItems: opts.selectedItems,
        });
        opts.onPhase({ kind: "locked" });
        return { kind: "locked" };
      }

      if (isFediMiniAppRuntime() || hasFediInternalEcash()) {
        opts.onPhase({ kind: "lock-failed", error: FEDI_ECASH_UNAVAILABLE });
        return { kind: "lock-failed", error: FEDI_ECASH_UNAVAILABLE };
      }

      const { runFundAndLock } = await import("../payments/fund-and-lock.js");
      return await runFundAndLock({
        escrowId,
        amountMsats: opts.amountMsats,
        description: opts.description,
        savedHandleId: opts.savedHandleId,
        selectedItems: opts.selectedItems,
        getBalance: () => fedimint.getBalance(),
        createFundingInvoice: (amountMsats, description, onReceiveState) =>
          createFundingInvoice(
            amountMsats,
            description,
            onReceiveState,
            buildChamaOperationMeta({
              flow: "fund_receive",
              escrowId,
              amountMsats,
            }),
          ),
        autoPayInvoice: opts.fundingMethod === "nwc"
          ? async (bolt11) => {
              const connectionString = opts.nwcConnectionString?.trim();
              if (!connectionString) throw new Error("Paste an NWC connection");
              await payInvoiceWithNwc(connectionString, bolt11);
            }
          : undefined,
        lockAndPublish: lockAndPublishAction,
        onPhase: opts.onPhase,
        signal: opts.signal,
      });
    } catch (e: unknown) {
      const err = describeError(e, "Funding failed");
      opts.onPhase({ kind: "lock-failed", error: err });
      return { kind: "lock-failed", error: err };
    } finally {
      // Only clear the ref if THIS run still owns it. In the StrictMode
      // double-mount case, run#1's finally fires AFTER run#2 has
      // already replaced the ref with its own signal — clearing
      // unconditionally would strand run#2 in a state where the UI
      // thinks it's idle while a real fund flow is in progress.
      if (fundingInProgressRef.current === ownSignal) {
        fundingInProgressRef.current = null;
      }
      setState(prev => prev.fundingInProgress
        ? { ...prev, fundingInProgress: false }
        : prev);
    }
  }, [createFundingInvoice, lockAndPublishAction, lockAndPublishWithEcashAction, markFedimintWalletNotReady]);

  // v0.3.0 Phase 3: atomic claim-and-payout orchestrator. Composes the
  // existing claimAndRedeemAction with a balance watchdog and outbound
  // payInvoice into a single flow with phase callbacks. The pure
  // orchestrator lives in src/payments/claim-and-payout.ts (testable
  // without React); this binding wires it to the live wallet.
  const claimAndPayoutAction = useCallback(async (
    escrowId: string,
    args: {
      bolt11?: string;
      onchainAddress?: string;
      expectedDeltaMsats: number;
      saveAfter: boolean;
      addressUsed?: string;
      onPhase: (phase: import("../payments/claim-and-payout.js").ClaimAndPayoutPhase) => void;
    },
  ): Promise<import("../payments/claim-and-payout.js").ClaimAndPayoutTerminal> => {
    const fedimint = fedimintRef.current;
    if (!fedimint) {
      const err = "Wallet not initialized";
      args.onPhase({ kind: "claim-bridge-threw", error: err });
      return { kind: "claim-bridge-threw", error: err };
    }
    let bridge: EscrowFedimintBridge;
    let client: EscrowClient;
    try {
      bridge = requireBridge();
      client = requireClient();
    } catch (e: any) {
      const err = e?.message || "Fedimint wallet not ready";
      args.onPhase({ kind: "claim-bridge-threw", error: err });
      return { kind: "claim-bridge-threw", error: err };
    }
    // v0.6.5: mirror the funding-operation gate for the claim sweep.
    // Between claim-redeems and the outbound LN send, the OPFS balance
    // is transiently > 0 with no active trade explaining it. Without
    // this flag the recovery banner would race the very flow that's
    // about to drain the balance. Ref-mirror matches the funding side.
    claimPayoutInProgressRef.current = true;
    setState(prev => prev.claimPayoutInProgress
      ? prev
      : { ...prev, claimPayoutInProgress: true });
    try {
      if (hasFediInternalEcash()) {
        args.onPhase({ kind: "claiming" });
        try {
          await bridge.claimAndReceiveFedi(escrowId, { clearPendingOnRedeem: true });
          await client.complete(escrowId);
          refreshBalanceRef.current?.().catch(() => {});
          args.onPhase({ kind: "done" });
          return { kind: "done" };
        } catch (e: any) {
          const msg = e?.message || String(e);
          if (isStaleClaim(msg)) {
            console.debug("[chama] Fedi claim suppressed (stale):", msg);
            args.onPhase({ kind: "done" });
            return { kind: "done" };
          }
          if (e?.code === "FED_PROBE_FAILED" || e?.code === "FED_MISMATCH") {
            args.onPhase({ kind: "claim-bridge-threw", error: msg });
            return { kind: "claim-bridge-threw", error: msg };
          }
          args.onPhase({ kind: "claim-failed", error: msg });
          return { kind: "claim-failed", error: msg };
        }
      }

      const { runClaimAndPayout } = await import("../payments/claim-and-payout.js");
      const onchainAddress = args.onchainAddress?.trim();
      return await runClaimAndPayout({
        escrowId,
        bolt11: args.bolt11 ?? "onchain-payout",
        expectedDeltaMsats: args.expectedDeltaMsats,
        saveAfter: args.saveAfter,
        addressUsed: args.addressUsed,
        payoutKind: onchainAddress ? "onchain" : "lightning",
        getBalance: () => fedimint.getBalance(),
        // Production claim+payout uses the raw bridge claim, not
        // claimAndRedeemAction, because claimAndRedeemAction emits the
        // legacy success progress that auto-publishes COMPLETE. COMPLETE
        // belongs after the balance-confirming watchdog below, not merely
        // after redeemEcash returns.
        claimAndRedeem: async (id: string) => {
          try {
            return await bridge.claimAndRedeem(id, { clearPendingOnRedeem: false });
          } catch (e: any) {
            const msg = e?.message || String(e);
            if (isStaleClaim(msg)) {
              console.debug("[chama] Claim suppressed (stale):", msg);
              return client.getState(id)!;
            }
            throw e;
          }
        },
        completeClaim: async (id: string) => {
          await client.complete(id);
        },
        clearPendingRedemption,
        payInvoice: async (bolt11: string) => {
          await bridge.payInvoice(
            bolt11,
            buildChamaOperationMeta({
              flow: "claim_payout",
              escrowId,
              amountMsats: args.expectedDeltaMsats,
            }),
          );
          refreshBalanceRef.current?.().catch(() => {});
        },
        payOnchain: async (grossAmountSats: number) => {
          if (!onchainAddress) throw new Error("Paste a bitcoin onchain address");
          let sendSats = grossAmountSats;
          let fees = await bridge.getOnchainWithdrawFees(onchainAddress, sendSats);
          sendSats = grossAmountSats - fees.feesSats;
          if (sendSats <= 0) {
            throw new Error("Onchain network fee exceeds this claim amount. Use Lightning for this payout.");
          }
          fees = await bridge.getOnchainWithdrawFees(onchainAddress, sendSats);
          sendSats = grossAmountSats - fees.feesSats;
          if (sendSats <= 0) {
            throw new Error("Onchain network fee exceeds this claim amount. Use Lightning for this payout.");
          }
          await bridge.withdrawOnchain(
            onchainAddress,
            sendSats,
            buildChamaOperationMeta({
              flow: "claim_payout",
              escrowId,
              amountMsats: args.expectedDeltaMsats,
            }),
          );
          refreshBalanceRef.current?.().catch(() => {});
        },
        addOrTouchLightningHandle: addOrTouchPayoutDestination,
        onPhase: args.onPhase,
      });
    } finally {
      claimPayoutInProgressRef.current = false;
      setState(prev => prev.claimPayoutInProgress
        ? { ...prev, claimPayoutInProgress: false }
        : prev);
    }
  }, []);

  // ── Return ──────────────────────────────────────────────────────────────

  const actions: UseEscrowActions = {
    connect,
    disconnect,
    createEscrow,
    joinEscrow,
    lockAndPublish: lockAndPublishAction,
    vote: voteAction,
    releasePeriod: async (escrowId: string, periodIndex: number) => {
      if (!clientRef.current) throw new Error("Not connected");
      const newState = await clientRef.current.releasePeriod(escrowId, periodIndex);
      updateEscrow(escrowId, newState);
      return newState;
    },
    claimAndRedeem: claimAndRedeemAction,
    claimAndPayout: claimAndPayoutAction,
    sendChat,
    cancel: cancelAction,
    loadEscrow,
    rebroadcastEscrow,
    forgetEscrow,
    purchaseFromListing,
    fetchNostrProfiles,
    vibrate,
    initFedimint,
    setCustomInvite,
    createFundingInvoice,
    fundAndLock: fundAndLockAction,
    payInvoice: async (bolt11: string, meta?: ChamaOperationMeta) => {
      const bridge = requireBridge();
      await bridge.payInvoice(bolt11, meta);
      refreshBalanceRef.current?.().catch(() => {});
    },
    refreshCommunityRoster: async (community: string) => {
      const client = clientRef.current;
      if (!client || !community) return;
      const entry = getCommunityBySlug(community);
      const authority = resolveRosterAuthority({
        stewardPubkey: entry?.stewardPubkey ?? null,
        creatorPubkey: entry?.creatorPubkey ?? null,
      });
      if (authority.length === 0) return;
      await fetchAndCacheCommunityRoster({
        community,
        authority,
        query: (filter, timeoutMs) => client.queryOnce(filter as any, timeoutMs),
      });
    },
    publishCommunityRoster: async (community: string, arbiters: string[]) => {
      const client = clientRef.current;
      const signer = signerRef.current;
      if (!client || !signer) throw new Error("Not connected");
      const unsigned = buildArbiterRosterEvent({ community, arbiters });
      const signed = await signer.signEvent(unsigned as any);
      await client.publishRaw(signed);
      writeCachedRosterEvent(community, signed);
    },
    applyAsArbiter: async (community: string, statement: string) => {
      const client = clientRef.current;
      const signer = signerRef.current;
      if (!client || !signer) throw new Error("Not connected");
      const unsigned = buildArbiterApplicationEvent({ community, statement });
      const signed = await signer.signEvent(unsigned as any);
      await client.publishRaw(signed);
    },
    fetchArbiterApplications: async (community: string, excludePubkeys?: string[]) => {
      const client = clientRef.current;
      if (!client || !community) return [];
      const events = await client.queryOnce(
        { kinds: [ARBITER_APPLICATION_KIND], "#d": [community], limit: 50 } as any,
        5_000,
      );
      return collectArbiterApplications(events, { excludePubkeys }).map(app => ({
        applicant: app.applicant,
        statement: app.statement,
        createdAt: app.createdAt,
      }));
    },
    spendNotes: async (amountMsats: number, meta?: ChamaOperationMeta) => {
      const bridge = requireBridge();
      const notes = await bridge.spendNotes(amountMsats, meta);
      refreshBalanceRef.current?.().catch(() => {});
      return notes;
    },
    redeemEcash: async (oobNotes: string, meta?: ChamaOperationMeta) => {
      const bridge = requireBridge();
      await bridge.redeemEcash(oobNotes, meta);
      refreshBalanceRef.current?.().catch(() => {});
    },
    getOnchainInfo: async () => {
      const fedimint = fedimintRef.current;
      if (!fedimint || !fedimint.isInitialized() || !fedimint.isJoined()) {
        markFedimintWalletNotReady();
        throw new Error(FEDIMINT_WALLET_NOT_READY);
      }
      return fedimint.getOnchainInfo();
    },
    probeFederation: async () => {
      // v0.3.1 Phase 1: explicit probe seam for the Try-again path on
      // claim-bridge-threw. Doesn't pass through the HEALTH_TTL_MS cache
      // (createFundingInvoice does) — a retry intentionally wants a
      // fresh read. Returns a structured result; never throws.
      //
      // v0.3.1 Phase 3: also updates bootProbeState so a successful
      // retry-probe naturally unblocks the boot gate. If the user
      // reaches claim-bridge-threw → taps Try Again → probe succeeds,
      // the ChamaBar "⚠ unreachable" pill clears AND the Fund/Claim
      // buttons un-disable across the rest of the UI — single source
      // of truth.
      const fedimint = fedimintRef.current;
      if (!fedimint || !fedimint.isInitialized() || !fedimint.isJoined()) {
        markFedimintWalletNotReady();
        return { ok: false as const, error: FEDIMINT_WALLET_NOT_READY };
      }
      try {
        await fedimint.probeReachable();
        const at = Date.now();
        healthRef.current = { ok: true, at };
        updateFedimint({
          lastHealthOk: true,
          lastHealthAt: at,
          bootProbeState: "ok",
        });
        return { ok: true as const };
      } catch (e: any) {
        const message = e?.message || "Federation unreachable";
        if (/FedimintClient not initialized/i.test(message)) {
          markFedimintWalletNotReady();
          return { ok: false as const, error: FEDIMINT_WALLET_NOT_READY };
        }
        const at = Date.now();
        healthRef.current = { ok: false, at };
        updateFedimint({
          lastHealthOk: false,
          lastHealthAt: at,
          bootProbeState: "failed",
        });
        return { ok: false as const, error: message };
      }
    },
    prewarmFunding: async () => {
      const fedimint = fedimintRef.current;
      if (!fedimint || !fedimint.isInitialized() || !fedimint.isJoined()) return;
      try {
        await fedimint.probeReachable();
        const at = Date.now();
        healthRef.current = { ok: true, at };
        updateFedimint({
          lastHealthOk: true,
          lastHealthAt: at,
          bootProbeState: "ok",
        });
      } catch (e) {
        console.debug("[chama] prewarmFunding skipped:", e);
      }
    },
    refreshBalance,
    getBalance: readBalance,
    resetLocalWallet,
    switchFederation,
    watchPublicListings: (since?: number) => {
      clientRef.current?.watchPublicListings(since);
    },
    watchEscrow: (escrowId: string) => {
      clientRef.current?.watchEscrow(escrowId);
    },
    getCommunity: getUserCommunitySlug,
    setCommunity: setUserCommunitySlug,
  };

  return [state, actions];
}
