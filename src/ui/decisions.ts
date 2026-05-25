// ══════════════════════════════════════════════════════════════════════════
// Chama — Pure UI decision helpers
// ══════════════════════════════════════════════════════════════════════════
//
// Decisions that the UI shell needs to make about routing/rendering, factored
// out as pure functions so they can be unit-tested without React, the
// fedimint client, or relays in scope. The shell consumes them and dispatches
// the relevant side-effects (state updates, action calls, modal toggles).
//
// Both are domain-pure: no DOM, no React. Imports are limited to registry
// data + invite constants.

import {
  getCommunityBySlug,
  getPickerCommunities,
  DEFAULT_COMMUNITY_SLUG,
} from "../communities/registry.js";
import { BP_FEDERATION_INVITE } from "../fedimint/federation-invites.js";
import { hasLightningWithdrawableBalance } from "../payments/lightning-fees.js";
import {
  type EscrowState,
  EscrowStatus,
  EscrowEventKind,
  Role,
  Outcome,
  TERMINAL_STATES,
  getEffectiveParticipantsAt,
} from "../escrow-engine/types.js";

export const MAIN_SURFACE_RECOVERY_MIN_SATS = 2_000;

function hasMainSurfaceRecoveryBalance(balanceMsats: number): boolean {
  const sats = Math.floor(Math.max(0, balanceMsats) / 1000);
  return sats >= MAIN_SURFACE_RECOVERY_MIN_SATS && hasLightningWithdrawableBalance(balanceMsats);
}

// ──────────────────────────────────────────────────────────────────────────
// Community-pill tap → identity + federation effect
// ──────────────────────────────────────────────────────────────────────────
//
// Per PHILOSOPHY.md §2.3, communities are the user's identity layer.
// v0.1.85 update: tapping a community is also THE join — there is no
// "stage identity then commit via picker" intermediate step. The pills
// are the primary first-time join surface; the picker is a Sandbox-only
// power-user escape hatch.
//
// Tapping a community pill must:
//   1. Update the user's chama_community localStorage
//   2. Filter Browse to that community
//   3. Switch (or first-time init) the backing federation client
//
// The target federation is the community's pinned invite (or BP if the
// registry entry has federationInvite === null). We deliberately bypass
// the user's pasted-custom-invite override here: tapping a community is
// a direct identity choice that should take precedence over an earlier
// sandbox-mode override.
//
// v0.1.87: the synthetic "All communities" pill (and the filter-only
// effect kind it produced) was removed. Per Pillar 2.1 every user has
// a home community, so there is no community-less state to filter from.
//
// Effect kinds:
//   - identity-only    — currentInvite === targetInvite (already on the
//                        right fed; just update community + filter)
//   - switch-silent    — needs to (re-)init/switch the client. Used for
//                        first-time-join AND returning-user-different-fed
//                        with balance == 0. Caller dispatches init vs
//                        switch based on whether a fed is already loaded.
//   - destroy-confirm  — returning user with balance > 0 trying to switch
//                        away from a fed that holds sats; surface the
//                        existing fund-loss-guard modal.

export type CommunityTapEffect =
  | { kind: "identity-only"; slug: string }
  | {
      kind: "switch-silent";
      slug: string;
      targetInvite: string;
      displayName: string;
    }
  | {
      kind: "destroy-confirm";
      slug: string;
      targetInvite: string;
      displayName: string;
      balanceMsats: number;
      currentInvite: string;
    };

export interface CommunityTapInputs {
  slug: string;
  /** The OPFS-bound invite the wallet currently lives on. `null` means
   *  the user has never joined a federation. */
  currentInvite: string | null;
  /** Live balance from fedimint state. */
  balanceMsats: number;
}

export function decideCommunityTapEffect(inputs: CommunityTapInputs): CommunityTapEffect {
  const community = getCommunityBySlug(inputs.slug);
  // Community-tap honors the community's pinned invite (or BP fallback).
  // We bypass any custom-invite override on purpose.
  const targetInvite = community?.federationInvite ?? BP_FEDERATION_INVITE;
  const displayName = community?.displayName ?? inputs.slug;

  // Already on the right fed — pure identity update, no client work.
  if (inputs.currentInvite === targetInvite) {
    return { kind: "identity-only", slug: inputs.slug };
  }

  // First-time user (no current invite) — silent INIT. No balance check
  // needed: a wallet that doesn't exist yet can't hold funds.
  if (!inputs.currentInvite) {
    return { kind: "switch-silent", slug: inputs.slug, targetInvite, displayName };
  }

  // Returning user, fed differs. Sub-fee dust is not recoverable through
  // the Lightning payout UI, so treat it as zero for switch safety and
  // recovery blockers until small balances accumulate into something
  // withdrawable.
  if (!hasLightningWithdrawableBalance(inputs.balanceMsats)) {
    return { kind: "switch-silent", slug: inputs.slug, targetInvite, displayName };
  }

  return {
    kind: "destroy-confirm",
    slug: inputs.slug,
    targetInvite,
    displayName,
    balanceMsats: inputs.balanceMsats,
    currentInvite: inputs.currentInvite,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Auto-init target on app load (sticky-community routing)
// ──────────────────────────────────────────────────────────────────────────
//
// Per Pillar 2.1's "every user has a home" doctrine: every user — first-
// time or returning — gets dropped on a real federation at boot. The
// decision tree (priority order):
//
//   1. In-flight trade with balance > 0 → use-active
//      (Funds at stake; preserve the fed they live on. Refresh during
//      an active trade is a recovery scenario, not a navigation one.)
//
//   2. Home community known (with or without active invite) → use-home
//      (Sticky-community: even if the user session-time-switched to
//      another fed via listing-tap, refresh re-anchors to home. If
//      hasCurrentEscrow is true but balance is zero, the trade
//      post-claimed or recovered out-of-band — preserving the active
//      fed in that case strands the user on something they no longer
//      need.)
//
//   3. v0.2.0 first-time-npub auto-init → use-default
//      No home AND no active invite means a truly fresh npub (first
//      sign-in). Pre-v0.2.0 this fell to "skip" and the user landed
//      in "No Chama" limbo, which violates Pillar 2.1. v0.2.0 assigns
//      BLF + Global USD silently so the user lands on Browse with a
//      working federation; they can switch communities anytime via
//      the pills, after which sticky-community takes over.
//
//   4. Else (active invite without home community — sandbox-style
//      power-user setup) → skip. We don't auto-default these because
//      we don't know which community the user intended; manual
//      reconnect via Sandbox or a community-pill tap is the right
//      path.
//
// Pure: the helper reads no localStorage and no fedimint state. The
// shell collects the inputs and dispatches based on the result.

export type AutoInitTarget =
  | { kind: "skip" }
  | { kind: "use-active"; invite: string }
  | { kind: "use-home"; invite: string; slug: string }
  | {
      kind: "use-default";
      invite: string;
      defaultCommunity: string;
      reason: "first-time-npub" | "active-invite-without-home";
    };

export interface AutoInitInputs {
  /** chama_active_invite — the OPFS-bound invite, or `null` if none. */
  activeInvite: string | null;
  /** chama_community — the user's home community slug, or `null` for
   *  a truly first-time user. */
  homeCommunity: string | null;
  /** True iff the user is a participant (buyer or seller) in a
   *  non-terminal escrow per the local replay. Arbiter-only
   *  participation does not count for this gate. */
  hasCurrentEscrow: boolean;
  /** Live OPFS balance from fedimint state. */
  balanceMsats: number;
}

export function decideAutoInitTarget(inputs: AutoInitInputs): AutoInitTarget {
  if (
    inputs.hasCurrentEscrow
    && inputs.balanceMsats > 0
    && inputs.activeInvite
  ) {
    return { kind: "use-active", invite: inputs.activeInvite };
  }

  if (inputs.homeCommunity) {
    const community = getCommunityBySlug(inputs.homeCommunity);
    // Honor the community's pinned invite (or BP fallback) — bypass
    // any pasted-custom-invite override the user might have set in
    // Sandbox. Sticky-community is intentionally rigid: refresh =
    // come home.
    const homeInvite = community?.federationInvite ?? BP_FEDERATION_INVITE;
    return { kind: "use-home", invite: homeInvite, slug: inputs.homeCommunity };
  }

  // First-time-npub: no home AND no active. Assign BLF + Global USD
  // silently. Active-known-without-home is the same repair path when
  // the invite maps to a visible community: every user needs a scoped
  // home, and refresh must not preserve a route with no identity pill.
  const inferredCommunity = inputs.activeInvite
    ? inferCommunitySlugForInvite(inputs.activeInvite)
    : DEFAULT_COMMUNITY_SLUG;
  if (inferredCommunity) {
    const defaultCommunity = getCommunityBySlug(inferredCommunity);
    const defaultInvite = defaultCommunity?.federationInvite ?? BP_FEDERATION_INVITE;
    return {
      kind: "use-default",
      invite: defaultInvite,
      defaultCommunity: inferredCommunity,
      reason: inputs.activeInvite ? "active-invite-without-home" : "first-time-npub",
    };
  }

  // Unknown custom invite without a home remains Sandbox-style: manual
  // reconnect / community-pill tap is the right path because no visible
  // community identity can be inferred.
  return { kind: "skip" };
}

function inferCommunitySlugForInvite(invite: string | null): string | null {
  const trimmed = invite?.trim();
  if (!trimmed) return null;

  const defaultCommunity = getCommunityBySlug(DEFAULT_COMMUNITY_SLUG);
  if (defaultCommunity?.federationInvite === trimmed) {
    return DEFAULT_COMMUNITY_SLUG;
  }

  return [...getPickerCommunities()]
    .find((community) => community.federationInvite === trimmed)
    ?.slug ?? null;
}

// ──────────────────────────────────────────────────────────────────────────
// Browser-support announcement banner
// ──────────────────────────────────────────────────────────────────────────
//
// Per Pillar 2.7 (educate at every opportunity). v0.5.0 reframes this
// from a "temporarily blocked" warning to a positive current-state
// announcement — the Fedimint canary iroh-relay 0.90 bump cleared the
// browser-WebSocket gate, so end-to-end browser flows work. Web users
// see a one-time honest announcement regardless of whether they've
// committed to a federation yet.
//
// Render only when ALL of:
//   - we're in a browser (native APK doesn't need the announcement)
//   - the user hasn't dismissed the banner before (one-time-per-account)

export interface BrowserBannerInputs {
  isBrowser: boolean;
  dismissed: boolean;
  /** v0.4.2: sim mode swaps the WASM Fedimint client for a localStorage
   *  mock, so the browser-Fedimint announcement is moot. The copy
   *  directly contradicts the SIM MODE pill if shown alongside it.
   *  Hide unconditionally when sim mode is on. */
  simModeOn?: boolean;
}

export function shouldShowBrowserSupportBanner(inputs: BrowserBannerInputs): boolean {
  if (inputs.simModeOn) return false;
  if (!inputs.isBrowser) return false;
  if (inputs.dismissed) return false;
  return true;
}

// ──────────────────────────────────────────────────────────────────────────
// Counterparty display name
// ──────────────────────────────────────────────────────────────────────────
//
// Used by the v0.2.0 recovery banner ("Your trade with [counterparty]
// didn't finish") and the arbiter-attention warning copy ("Trade
// between [npub-A] and [npub-B]"). Pure function — given the raw npub
// + a "fetch counterparty kind:0" toggle state + the kind:0 name (if
// any), it returns the right string for the surface.
//
// Privacy default: truncated npub. The full name only appears when the
// user has explicitly opted into kind:0 fetching (Me → Nostr Profile,
// v0.2.0) AND the counterparty has self-published a kind:0 with a name
// field. Both conditions must hold; either alone falls back to the
// truncated npub. This honors the buyer/seller's right to use Chama
// without surfacing their broader Nostr identity to other Chama
// participants who haven't asked to fetch it.
//
// The kind:0 fetcher itself ships in v0.2.1 — for v0.2.0 the helper is
// callable with `kind0Name: null` and renders truncated npubs across
// the board. Wiring the fetcher in later doesn't change this contract.

const TRUNCATED_NPUB_HEAD = 8;
const TRUNCATED_NPUB_TAIL = 4;

export interface CounterpartyDisplayInputs {
  /** The counterparty's hex pubkey or bech32 npub (string is opaque to
   *  this helper — we just take the head/tail for truncation). */
  npub: string;
  /** Whether the user has enabled "fetch counterparty kind:0" in Me →
   *  Nostr Profile. v0.2.0 surfaces this toggle but doesn't fetch yet;
   *  v0.2.1 wires the fetcher. */
  fetchKind0Enabled: boolean;
  /** The counterparty's self-published kind:0 name, if known. `null`
   *  when fetch is disabled, when the counterparty hasn't published
   *  kind:0, or when their kind:0 lacks a name field. */
  kind0Name: string | null;
}

export function displayCounterpartyName(inputs: CounterpartyDisplayInputs): string {
  if (
    inputs.fetchKind0Enabled
    && typeof inputs.kind0Name === "string"
    && inputs.kind0Name.trim().length > 0
  ) {
    return inputs.kind0Name.trim();
  }
  // Truncated npub fallback. The 8/4 split is wide enough that two
  // distinct npubs are visually distinguishable in the recovery banner
  // and arbiter warnings without leaking more than necessary.
  if (inputs.npub.length <= TRUNCATED_NPUB_HEAD + TRUNCATED_NPUB_TAIL + 1) {
    return inputs.npub;
  }
  return (
    inputs.npub.slice(0, TRUNCATED_NPUB_HEAD)
    + "…"
    + inputs.npub.slice(-TRUNCATED_NPUB_TAIL)
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Subscription-mode graduation gate (item 7)
// ──────────────────────────────────────────────────────────────────────────
//
// Per Pillar 2.6 (reputation as backbone primitive): subscription /
// recurring-payments is a graduated capability earned via positive-
// rating accumulation, mirroring the auto-assigned → manual-pickable →
// community-elected progression for arbiters. The toggle is invisible
// to users who haven't earned it; they learn it exists by seeing other
// users use it.
//
// v1 placeholder threshold (per the addendum): 5+ positive ratings,
// 0 negative. Documented in PHILOSOPHY.md §State 8 / Recurring as a
// v1 default; the real threshold will emerge from observed seller
// behavior post-launch.
//
// In v0.2.0 with no rating events being published yet, the aggregator
// returns null for every npub and this gate returns false universally.
// That's correct behavior — nobody has graduated, nobody sees the
// toggle. When ratings ship in v0.2.1+, the gate naturally opens for
// qualifying sellers without any further wiring.

export interface AggregateRatings {
  count: number;
  positive: number;
  negative: number;
  // No vertical breakdown in v0.2.0 (per Q5 confirmation); add later.
}

const SUBSCRIPTION_MIN_POSITIVE = 5;
const SUBSCRIPTION_MAX_NEGATIVE = 0;

export function canOfferSubscription(inputs: {
  ratings: AggregateRatings | null;
}): boolean {
  if (!inputs.ratings) return false;
  return (
    inputs.ratings.positive >= SUBSCRIPTION_MIN_POSITIVE
    && inputs.ratings.negative <= SUBSCRIPTION_MAX_NEGATIVE
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Active-trade detection (v0.6.5 — informational, not a gate)
// ──────────────────────────────────────────────────────────────────────────
//
// History: through v0.6.4 these helpers backed a hard "one trade at a
// time" gate on Create + Fund. v0.6.5 retires that gate. With Option B
// fully wired (BOLT11 IN → mint → spendNotes → LOCK → OPFS drains to 0),
// the wallet sits at zero between trades; ecash exists only for the
// milliseconds spanning runFundAndLock. There is no architectural
// reason a seller can't serve three buyers, or a buyer can't browse
// for the next trade while a previous one is in LOCKED/voting/approved.
//
// What blocks now: one *funding operation* at a time (isMidFunding
// below). The AtomicFundingModal is already an exclusive modal, so the
// UI guarantees this in practice; isMidFunding is the programmatic
// backstop that protects the shared OPFS wallet from two concurrent
// spendNotes calls racing.
//
// hasActiveBuyerSellerCommitment + findActiveTrade survive as display
// helpers: ChamaBar's "X sats in escrow" pill and the ActiveTradePill
// strip both need to know about live money-moving commitments. CREATED
// listings stay in Browse/Me as inventory; they should not light up the
// global purple attention banner until LOCK moves sats into escrow.

function isPastEscrowDeadline(e: EscrowState, nowSec: number): boolean {
  return typeof e.expiresAt === "number" && e.expiresAt > 0 && nowSec > e.expiresAt;
}

function isLiveBuyerSellerCommitment(e: EscrowState, nowSec: number): boolean {
  if (TERMINAL_STATES.has(e.status)) return false;
  // CLAIMED means the trade has left the live escrow phase. Successful
  // claims move on to COMPLETED; locally failed redemptions stay visible on
  // the detail screen as "Claim failed", but should not keep the global
  // ActiveTradePill alive.
  if (e.status === EscrowStatus.CLAIMED) return false;
  // Open listings are public inventory, not active money movement. They
  // remain browsable and visible in Me, including JOINed-but-not-LOCKED
  // holds, but the global active-trade pill is reserved for LOCKED and
  // APPROVED flows where sats are already in escrow or ready to claim.
  if (e.status === EscrowStatus.CREATED) return false;
  if (e.status !== EscrowStatus.LOCKED && e.status !== EscrowStatus.APPROVED) return false;
  if (isPastEscrowDeadline(e, nowSec)) {
    return false;
  }
  return true;
}

function isEffectiveBuyerOrSeller(e: EscrowState, userPubkey: string, nowSec: number): boolean {
  const p = getEffectiveParticipantsAt(e, nowSec);
  return p.buyer === userPubkey || p.seller === userPubkey;
}

export function hasActiveBuyerSellerCommitment(inputs: {
  escrows: Iterable<EscrowState>;
  userPubkey: string;
  nowSec?: number;
}): boolean {
  const nowSec = inputs.nowSec ?? Math.floor(Date.now() / 1000);
  for (const e of inputs.escrows) {
    const isBuyerOrSeller = isEffectiveBuyerOrSeller(e, inputs.userPubkey, nowSec);
    if (!isBuyerOrSeller) continue;
    if (!isLiveBuyerSellerCommitment(e, nowSec)) continue;
    return true;
  }
  return false;
}

/**
 * v0.6.5: how many live buyer/seller commitments the user is in. Drives
 * the plural-aware ActiveTradePill copy ("1 active trade" vs "3 active
 * trades") now that multiple concurrent trades are allowed.
 */
export function countActiveBuyerSellerCommitments(inputs: {
  escrows: Iterable<EscrowState>;
  userPubkey: string;
  nowSec?: number;
}): number {
  const nowSec = inputs.nowSec ?? Math.floor(Date.now() / 1000);
  let n = 0;
  for (const e of inputs.escrows) {
    const isBuyerOrSeller = isEffectiveBuyerOrSeller(e, inputs.userPubkey, nowSec);
    if (!isBuyerOrSeller) continue;
    if (!isLiveBuyerSellerCommitment(e, nowSec)) continue;
    n += 1;
  }
  return n;
}

/**
 * v0.6.5: total msats across all live buyer/seller commitments the
 * user is in. Drives the ActiveTradePill's amount headline.
 *
 * Distinct from `activeCommittedMsats` (which sums only LOCKED +
 * APPROVED - money *actually* in escrow). This sums every live
 * trade's amountMsats for LOCKED + APPROVED flows only. Open listings
 * are inventory and stay off the attention banner. Two surfaces, two
 * truthful readings:
 *   ActiveTradePill   → "what's the gravitational weight of my live
 *                        trade activity right now?"     (this helper)
 *   ChamaBar in-trade → "how many sats are actually locked in
 *                        escrow?"                       (activeCommittedMsats)
 */
export function sumActiveBuyerSellerTradeMsats(inputs: {
  escrows: Iterable<EscrowState>;
  userPubkey: string;
  nowSec?: number;
}): number {
  const nowSec = inputs.nowSec ?? Math.floor(Date.now() / 1000);
  let sum = 0;
  for (const e of inputs.escrows) {
    const isBuyerOrSeller = isEffectiveBuyerOrSeller(e, inputs.userPubkey, nowSec);
    if (!isBuyerOrSeller) continue;
    if (!isLiveBuyerSellerCommitment(e, nowSec)) continue;
    sum += e.amountMsats;
  }
  return sum;
}

/**
 * Browse is the public market surface, not only "things I am not in".
 * A listing remains browsable while it is CREATED, including:
 *   - the seller's own freshly-created listing
 *   - a buyer/arbiter JOIN ACK that has not produced LOCK yet
 *
 * LOCK is the actual money-moving transition. Once LOCK lands, the trade
 * leaves Browse and lives on the active-trade/detail surfaces. Expired
 * CREATED listings are hidden while the sentinel catches up and publishes
 * CANCEL.
 */
export function shouldShowOnBrowse(inputs: {
  escrow: EscrowState;
  browseCategory: string;
  nowSec?: number;
}): boolean {
  const { escrow, browseCategory } = inputs;
  if (escrow.status !== EscrowStatus.CREATED) return false;
  if (isPastEscrowDeadline(escrow, inputs.nowSec ?? Math.floor(Date.now() / 1000))) {
    return false;
  }
  if (browseCategory === "all") return true;
  if (browseCategory === "subscription") return escrow.subscription !== null;
  return escrow.category === browseCategory;
}

/**
 * v0.6.5 funding-operation gate. True while runFundAndLock is mid-flight
 * (between creating-invoice and the locked/lock-failed/expired/aborted
 * terminal phases). The only condition that should disable a second
 * Fund tap.
 *
 * This is a UI-layer concern, not a state-machine concern: each trade's
 * event chain is independent. The gate exists because the Fedimint WASM
 * client shares one OPFS wallet, and two concurrent spendNotes calls on
 * that wallet could race.
 *
 * Accepts either `fundAndLockInProgress` (literal brief name) or
 * `fundingInProgress` (the state-field name used in useEscrow) so
 * callers don't need to translate.
 */
export function isMidFunding(inputs: {
  fundAndLockInProgress?: boolean;
  fundingInProgress?: boolean;
}): boolean {
  return inputs.fundAndLockInProgress ?? inputs.fundingInProgress ?? false;
}

/**
 * v0.4.2 hotfix round 3: msats the user has committed to active escrows
 * as buyer or seller. Returns the SUM across all active funded
 * commitments (LOCKED / APPROVED). Used by decideChamaBarLabel to drive
 * the "X sats in escrow" pill during LOCKED state when the wallet
 * balance is correctly 0 (the user has SPENT the ecash into SSS shares).
 *
 * Why this matters: the previous decision read only wallet balance,
 * which is correctly 0 after LOCK (the seller's ecash got split into
 * encrypted shares on Nostr — none of it sits in the local wallet).
 * The pill went silent at exactly the moment users most need to see
 * "your money is committed." Pillar 2.1 Option B.
 *
 * Status set:
 *   CREATED  → 0 (no commitment yet — the listing exists but no money moved)
 *   LOCKED   → amountMsats (sats are in escrow as SSS shares)
 *   APPROVED → amountMsats (still in escrow until claim+redeem completes)
 *   CLAIMED  → 0 (winner has redeemed; commitment over, balance reflects it)
 *   COMPLETED/CANCELLED → 0 (terminal, no commitment)
 *   EXPIRED  → 0 (healing transient — the commitment is already resolving
 *                 via auto-refund; not load-bearing for the pill)
 */
export function activeCommittedMsats(inputs: {
  escrows: Iterable<EscrowState>;
  userPubkey: string;
  nowSec?: number;
}): number {
  const nowSec = inputs.nowSec ?? Math.floor(Date.now() / 1000);
  let sum = 0;
  for (const e of inputs.escrows) {
    const isBuyerOrSeller = isEffectiveBuyerOrSeller(e, inputs.userPubkey, nowSec);
    if (!isBuyerOrSeller) continue;
    if (e.status !== EscrowStatus.LOCKED && e.status !== EscrowStatus.APPROVED) continue;
    if (e.status === EscrowStatus.LOCKED && isPastEscrowDeadline(e, nowSec)) continue;
    sum += e.amountMsats;
  }
  return sum;
}

// ── ChamaBar label decision (v0.3.0 Phase 5 + v0.3.1 Phase 3) ─────────────
//
// Four states the top-bar's right-side surface can be in:
//   - unreachable : bootProbeState === "failed" (v0.3.1 Phase 3 —
//                   federation joined but unreachable; "⚠ Chama
//                   unreachable · Reconnect →"; tappable). Wins over
//                   all other states because reachability is the
//                   floor for any other meaningful state.
//   - in-trade    : user has a LOCKED/APPROVED buyer/seller commitment
//                   ("Active funds in escrow: N sats")
//   - stranded    : material balance AND no active commitment (failure-mode;
//                   tappable → opens RecoveryPayoutModal directly)
//   - ready       : balance == 0 OR only tiny post-payout dust
//                   (neutral, "Chama: ready")
//
// Per Phase 5 reminder #3: arbiter-only commitments do NOT count as
// active. Arbiters mid-arbitration see "Chama: ready" because the
// balance, if any, isn't theirs to commit. The predicate
// hasActiveBuyerSellerCommitment is the same one Q3 of v0.2.0 locked
// in for Create-blocking.
//
// v0.3.1 Phase 3 ordering rationale: unreachable wins over stranded
// and in-trade because if the user can't reach the federation, they
// also can't recover stranded sats or progress an in-trade flow —
// the actionable next step is Reconnect, not Recover or Vote. The
// "pending" bootProbeState does NOT override the existing kinds; it's
// a transient state between initFedimint resolving and probe1 result,
// and the UI is fine with the (brief) optimistic rendering during it.

export type ChamaBarLabel =
  | { kind: "ready" }
  | { kind: "in-trade"; sats: number; activeTradeCount: number }
  | { kind: "stranded"; sats: number }
  | { kind: "unreachable" };

export function decideChamaBarLabel(opts: {
  balanceMsats: number;
  hasActiveBuyerSellerCommitment: boolean;
  /** v0.3.1 Phase 3 — when "failed", overrides all other kinds and
   *  returns `{ kind: "unreachable" }`. "pending" and "ok" pass
   *  through to the existing three-state decision. Optional/defaulted
   *  for backwards compatibility — pre-Phase-3 callsites continue to
   *  render the three-state surface as if probe is ok. */
  bootProbeState?: "pending" | "ok" | "failed";
  /** v0.4.2 hotfix round 3: msats committed to active LOCKED/APPROVED
   *  trades as buyer or seller. When the wallet balance is 0 but this
   *  is > 0, the pill reflects the escrowed amount instead of going
   *  silent. Pillar 2.1 Option B: "your money is in escrow" must be
   *  visible during the LOCKED state, where balance is correctly 0
   *  (ecash was spent into SSS shares). Pure helper above:
   *  `activeCommittedMsats`. Optional for backwards compatibility. */
  activeCommittedMsats?: number;
  /** v0.6.5: count of live buyer/seller commitments. Drives plural-
   *  aware in-trade pill copy ("1 active trade" vs "3 active trades").
   *  Optional/defaulted to 1 for backwards compatibility. */
  activeTradeCount?: number;
}): ChamaBarLabel {
  if (opts.bootProbeState === "failed") return { kind: "unreachable" };
  const activeTradeCount = Math.max(1, opts.activeTradeCount ?? 1);
  // Floor to whole sats — the bar always speaks in sats, never msats.
  const sats = Math.floor(opts.balanceMsats / 1000);
  // If there's an active LOCKED/APPROVED commitment, surface that ledger
  // amount as the in-trade pill. CREATED listings are intentionally not
  // enough to explain a wallet balance: no money has moved yet.
  const committedSats = Math.floor((opts.activeCommittedMsats ?? 0) / 1000);
  if (committedSats > 0) return { kind: "in-trade", sats: committedSats, activeTradeCount };
  if (sats > 0 && sats >= MAIN_SURFACE_RECOVERY_MIN_SATS) return { kind: "stranded", sats };
  return { kind: "ready" };
}

/** The most-recent active buyer/seller trade. Used by the shell to
 *  drive the "go to active trade" pill's tap target. Returns null if
 *  no active trade exists. */
export function findActiveTrade(inputs: {
  escrows: Iterable<EscrowState>;
  userPubkey: string;
  nowSec?: number;
}): EscrowState | null {
  const nowSec = inputs.nowSec ?? Math.floor(Date.now() / 1000);
  let best: EscrowState | null = null;
  for (const e of inputs.escrows) {
    const isBuyerOrSeller = isEffectiveBuyerOrSeller(e, inputs.userPubkey, nowSec);
    if (!isBuyerOrSeller) continue;
    if (!isLiveBuyerSellerCommitment(e, nowSec)) continue;
    if (!best || e.createdAt > best.createdAt) best = e;
  }
  return best;
}

// ──────────────────────────────────────────────────────────────────────────
// Recovery banner (item 2; v0.6.5 narrowing)
// ──────────────────────────────────────────────────────────────────────────
//
// Per Pillar 2.1's "no sats stranded, ever" promise: when the user's
// OPFS holds a material Lightning-withdrawable balance but they have no
// active trade, that's a recovery state. Tiny post-payout dust may
// accumulate quietly in Me; the main-flow banner reappears once the
// aggregate balance is large enough to deserve interrupting the user.
//
// v0.6.5: also suppress while expected-transient flows hold a balance
// briefly — mid-runFundAndLock (the ecash that's about to be SSS-split)
// and mid-claim-payout (winnings between redemption and outbound LN
// sweep). Either of those firing the banner would race with the flow
// that's about to drain the balance.

export function shouldShowRecoveryBanner(inputs: {
  balanceMsats: number;
  /** v0.6.5 preferred name. Callers should pass true only for an actual
   *  LOCKED/APPROVED commitment that can explain local OPFS balance.
   *  CREATED listings do not count because no money has moved yet. The
   *  pre-v0.6.5 alias `hasCurrentEscrow` is still honored for callers
   *  that haven't migrated. */
  hasAnyActiveEscrow?: boolean;
  /** Deprecated alias for `hasAnyActiveEscrow`. Kept so older callers
   *  (and tests) continue to work without touching every site. */
  hasCurrentEscrow?: boolean;
  /** v0.6.5: true while runFundAndLock is between creating-invoice and
   *  a terminal phase. Suppresses the banner — the atomic flow owns
   *  the balance. Optional/defaulted for backwards compatibility. */
  fundingInProgress?: boolean;
  /** v0.6.5: true while runClaimAndPayout is between claim and the
   *  outbound LN send. Suppresses the banner — the claim flow owns
   *  the balance. Optional/defaulted for backwards compatibility. */
  claimPayoutInProgress?: boolean;
}): boolean {
  if (!hasMainSurfaceRecoveryBalance(inputs.balanceMsats)) return false;
  const hasActiveEscrow = inputs.hasAnyActiveEscrow ?? inputs.hasCurrentEscrow ?? false;
  if (hasActiveEscrow) return false;
  if (inputs.fundingInProgress) return false;
  if (inputs.claimPayoutInProgress) return false;
  return true;
}

export interface StrandedEcashSource {
  escrowId: string;
  /** The other non-self participant in the trade (buyer/seller, NOT
   *  arbiter). When the user IS the arbiter (rare for a stranded-
   *  ecash scenario), falls back to whichever party is present. */
  counterpartyPubkey: string;
  /** The user's role in that trade. */
  role: Role;
  /** Trade amount (msats) for the banner's withdraw CTA. */
  amountMsats: number;
  /** Trade description for the banner's identity card. */
  description: string;
}

/** Walk the local event replay to find the most recent CLAIM event
 *  signed by the user. The escrow that CLAIM lives on is the source
 *  of the stranded ecash; the counterparty is the other non-self
 *  participant. Returns null if no CLAIM event exists locally — the
 *  shell falls back to "Trade with unknown counterparty" copy + a
 *  generic withdraw flow. */
export function identifyStrandedEcashSource(inputs: {
  escrows: Iterable<EscrowState>;
  userPubkey: string;
}): StrandedEcashSource | null {
  let best: { escrow: EscrowState; claimAt: number } | null = null;
  for (const e of inputs.escrows) {
    for (const evt of e.eventChain) {
      if (
        evt.kind === EscrowEventKind.CLAIM
        && evt.pubkey === inputs.userPubkey
      ) {
        if (!best || evt.timestamp > best.claimAt) {
          best = { escrow: e, claimAt: evt.timestamp };
        }
      }
    }
  }
  if (!best) return null;

  const e = best.escrow;
  let role: Role;
  let counterparty: string;
  if (e.participants.buyer === inputs.userPubkey) {
    role = Role.BUYER;
    counterparty = e.participants.seller ?? "";
  } else if (e.participants.seller === inputs.userPubkey) {
    role = Role.SELLER;
    counterparty = e.participants.buyer ?? "";
  } else {
    // User claimed but isn't buyer/seller — defensive fallback.
    role = Role.ARBITER;
    counterparty = e.participants.buyer ?? e.participants.seller ?? "";
  }
  return {
    escrowId: e.id,
    counterpartyPubkey: counterparty,
    role,
    amountMsats: e.amountMsats,
    description: e.description,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Listing-tap effect (items 1 + 4 — federation-follows-listing dispatch)
// ──────────────────────────────────────────────────────────────────────────
//
// Per Pillar 2.3 ("federation follows the listing"): when a user taps
// a listing whose federation differs from their current OPFS-bound
// fed, the client silently re-inits against the listing's fed before
// the detail screen renders. Per Jetty's Q1 confirmation: the re-init
// happens at LISTING-TAP time, not at Fund-CTA time — the detail
// screen always opens on the right fed, so every render is coherent
// regardless of whether Fund is tapped.
//
// Effect kinds:
//   - matching         — listing's fed === current; render State A
//                        immediately, no client work
//   - switch-silent    — listing's fed differs and balance is 0 OR
//                        no current invite; the shell tears down +
//                        re-inits, then renders State B (past-tense
//                        narration: "Running on BLF · we switched
//                        you in for this trade")
//   - destroy-confirm  — listing's fed differs and balance > 0; the
//                        existing fund-loss-guard modal surfaces
//                        before any switch happens
//
// State C (cross-fed with non-zero balance + auto-route) was
// explicitly abandoned during v0.1.85 design — the destroy-confirm
// path is the only way to handle non-zero balances.

export type ListingTapEffect =
  | { kind: "matching" }
  | { kind: "switch-silent"; targetInvite: string; displayName: string }
  | {
      kind: "destroy-confirm";
      targetInvite: string;
      displayName: string;
      balanceMsats: number;
      currentInvite: string;
    };

export interface ListingTapInputs {
  /** The listing's CREATE-event-derived fed identity. After PR A's
   *  item 9 fix, every listing carries both mintUrl and community.
   *  Pre-v0.1.87 listings may have stale/missing mintUrl; community
   *  is the more reliable source there. */
  listing: { mintUrl: string; community: string | null };
  /** chama_active_invite — null if the user has no fed loaded. */
  currentInvite: string | null;
  /** Live OPFS balance. */
  balanceMsats: number;
}

function resolveListingInvite(listing: { mintUrl: string; community: string | null }): string {
  if (listing.mintUrl && listing.mintUrl.startsWith("fed1")) {
    return listing.mintUrl;
  }
  if (listing.community) {
    const c = getCommunityBySlug(listing.community);
    if (c?.federationInvite) return c.federationInvite;
  }
  return BP_FEDERATION_INVITE;
}

export interface ListingRouteMatchInputs {
  listingMintUrl: string;
  listingFedId?: string | null;
  activeInvite: string | null;
  activeFedId?: string | null;
}

function normalizeFedId(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed && /^[0-9a-f]{64}$/.test(trimmed) ? trimmed : null;
}

export function listingMatchesActiveRoute(inputs: ListingRouteMatchInputs): boolean {
  const listingFedId = normalizeFedId(inputs.listingFedId);
  const activeFedId = normalizeFedId(inputs.activeFedId);

  if (listingFedId) {
    return !!activeFedId && listingFedId === activeFedId;
  }

  return !!inputs.activeInvite && inputs.listingMintUrl === inputs.activeInvite;
}

export function resolveCreateMintUrl(inputs: {
  activeInvite: string | null;
  community: string | null;
}): string {
  if (inputs.activeInvite?.startsWith("fed1")) {
    return inputs.activeInvite;
  }
  return resolveListingInvite({ mintUrl: "", community: inputs.community });
}

export function decideListingTapEffect(inputs: ListingTapInputs): ListingTapEffect {
  const targetInvite = resolveListingInvite(inputs.listing);
  const community = inputs.listing.community ? getCommunityBySlug(inputs.listing.community) : null;
  const displayName = community?.displayName ?? "the listing's community";

  if (inputs.currentInvite === targetInvite) {
    return { kind: "matching" };
  }
  if (!inputs.currentInvite || !hasLightningWithdrawableBalance(inputs.balanceMsats)) {
    return { kind: "switch-silent", targetInvite, displayName };
  }
  return {
    kind: "destroy-confirm",
    targetInvite,
    displayName,
    balanceMsats: inputs.balanceMsats,
    currentInvite: inputs.currentInvite,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Trade detail framing — State A vs State B (item 1, listing-detail half)
// ──────────────────────────────────────────────────────────────────────────
//
// When a user taps a listing, the shell silently re-inits to that
// listing's fed before the detail screen renders (per Q1). The detail
// screen then chooses framing based on whether the listing's fed
// matches the user's HOME community's fed:
//
//   - state-a: listing's fed === home's fed. Standard "runs on
//     [name] · same as your Chama" narration. CTA: "Fund trade".
//
//   - state-b: listing's fed differs from home's fed. The user
//     session-switched on tap; the narration is past-tense:
//     "Running on [listing-fed] · we switched you in for this
//     trade. Your home is on [home-fed]." CTA: "Fund trade".
//
// Same CTA in both states: by the time detail renders, the silent
// switch has already happened, so the user is funding from the
// listing's fed regardless. State B's job is to NARRATE the
// transition honestly (Pillar 2.7), not to dispatch it.

export type DetailFraming =
  | { kind: "state-a"; sameFedSameCommunity: boolean }
  | {
      kind: "state-b";
      listingCommunityName: string;
      listingFlagEmoji: string;
      homeCommunityName: string;
      homeFlagEmoji: string;
    };

export interface DetailFramingInputs {
  /** Listing's mintUrl (fed1 invite) from the CREATE event. */
  listingMintUrl: string;
  /** Listing's community slug (may be null for pre-registry listings). */
  listingCommunity: string | null;
  /** User's home community slug (chama_community), or null for first-
   *  time-npub edge case (handled defensively). */
  homeCommunity: string | null;
}

export function decideTradeDetailFraming(inputs: DetailFramingInputs): DetailFraming {
  const homeCom = inputs.homeCommunity ? getCommunityBySlug(inputs.homeCommunity) : null;
  const homeFedInvite = homeCom?.federationInvite ?? BP_FEDERATION_INVITE;
  const sameFed = inputs.listingMintUrl === homeFedInvite;

  if (sameFed) {
    const sameCommunity = inputs.listingCommunity === inputs.homeCommunity;
    return { kind: "state-a", sameFedSameCommunity: sameCommunity };
  }

  const listingCom = inputs.listingCommunity ? getCommunityBySlug(inputs.listingCommunity) : null;
  return {
    kind: "state-b",
    listingCommunityName: listingCom?.displayName ?? "another community",
    listingFlagEmoji: listingCom?.flagEmoji ?? "🌐",
    homeCommunityName: homeCom?.displayName ?? "your community",
    homeFlagEmoji: homeCom?.flagEmoji ?? "🌐",
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Vote prompt turn-gate (v0.7.0)
// ──────────────────────────────────────────────────────────────────────────
//
// Protocol stays permissive: the state machine still accepts buyer/seller
// votes in either order. This helper is the UI safety layer that prevents
// the happy-path counterparty from seeing high-stakes vote buttons before
// their turn.
//
// Category order:
//   - p2p-trade / bill-pay / lending: buyer first
//   - marketplace: seller first
//
// Once either buyer or seller votes, the other participant gets their
// buttons. Arbiter remains observer-only until buyer and seller both vote
// and disagree.

export type VotePrompt =
  | { kind: "none"; reason: string }
  | { kind: "waiting"; waitingOn: Role | "dispute"; message: string }
  | { kind: "buttons"; role: Role; outcomes: Outcome[] };

function samePubkey(a?: string | null, b?: string | null): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

function participantRoleForPubkey(state: EscrowState, pubkey: string): Role | null {
  if (samePubkey(state.participants[Role.BUYER], pubkey)) return Role.BUYER;
  if (samePubkey(state.participants[Role.SELLER], pubkey)) return Role.SELLER;
  if (samePubkey(state.participants[Role.ARBITER], pubkey)) return Role.ARBITER;
  return null;
}

function firstHappyPathVoter(state: EscrowState): Role {
  return state.category === "marketplace" ? Role.SELLER : Role.BUYER;
}

function waitingForFirstVoteCopy(state: EscrowState, role: Role): string {
  if (role === Role.SELLER) {
    if (state.category !== "marketplace") return "Waiting on seller to confirm";
    if (state.fulfillment === "digital") return "Waiting on seller to deliver the file";
    if (state.fulfillment === "service") return "Waiting on seller to deliver the service";
    return "Waiting on seller to ship";
  }
  if (state.category === "bill-pay") return "Waiting on buyer to confirm the bill was paid";
  if (state.category === "lending") return "Waiting on buyer to confirm the loan arrived";
  return "Waiting on buyer to confirm payment sent";
}

export function decideVotePrompt(state: EscrowState, pubkey: string): VotePrompt {
  if (state.status !== EscrowStatus.LOCKED && state.status !== EscrowStatus.EXPIRED) {
    return { kind: "none", reason: "not-votable-state" };
  }

  const role = participantRoleForPubkey(state, pubkey);
  if (!role) return { kind: "none", reason: "not-participant" };
  if (state.votes[role] !== undefined) return { kind: "none", reason: "already-voted" };

  // Expiry healing votes should only drive REFUND. Ordering is deliberately
  // skipped here, matching the state-machine's healing path.
  if (state.status === EscrowStatus.EXPIRED) {
    return { kind: "buttons", role, outcomes: [Outcome.REFUND] };
  }

  const buyerVote = state.votes[Role.BUYER];
  const sellerVote = state.votes[Role.SELLER];
  const buyerSellerBothVoted = buyerVote !== undefined && sellerVote !== undefined;
  const standardOutcomes = state.subscription
    ? [Outcome.REFUND]
    : [Outcome.RELEASE, Outcome.REFUND];

  if (role === Role.ARBITER) {
    if (!buyerSellerBothVoted) {
      return {
        kind: "waiting",
        waitingOn: "dispute",
        message: "Waiting for buyer and seller; arbiter only acts on a dispute",
      };
    }
    if (buyerVote === sellerVote) {
      return {
        kind: "waiting",
        waitingOn: "dispute",
        message: "Buyer and seller agree; no arbiter action needed",
      };
    }
    return { kind: "buttons", role, outcomes: standardOutcomes };
  }

  if (buyerSellerBothVoted) return { kind: "none", reason: "buyer-seller-voted" };

  const noBuyerSellerVotes = buyerVote === undefined && sellerVote === undefined;
  if (noBuyerSellerVotes) {
    const firstRole = firstHappyPathVoter(state);
    if (role !== firstRole) {
      return {
        kind: "waiting",
        waitingOn: firstRole,
        message: waitingForFirstVoteCopy(state, firstRole),
      };
    }
  }

  return { kind: "buttons", role, outcomes: standardOutcomes };
}

// ──────────────────────────────────────────────────────────────────────────
// Arbiter attention warning (item 10)
// ──────────────────────────────────────────────────────────────────────────
//
// Per the Q3 evolution: arbiter status does NOT hard-block Create.
// Instead, fire one of two warnings at Create time:
//
//   - soft (informational, equal-weight buttons): user is arbiter on
//     a LOCKED escrow with no votes-in-disagreement yet. Happy-path
//     trade may never need them, but their attention could be
//     required quickly.
//
//   - hard (conflict-explicit, asymmetric CTA): user is arbiter on
//     a LOCKED escrow where buyer and seller voted differently. The
//     arbiter's tiebreaker decides where the sats go — splitting
//     attention here can cost someone real money.
//
// Why warn but not block: arbitration on a happy-path trade is
// light-touch (you may never act). The protocol doesn't have a
// backup-arbiter swap mechanism at v1, so awareness is the safety
// net. Pillar 2.7: teach the weight of the role through the surface,
// every time.
//
// Multi-arbitration tiebreaking: hard > soft (any hard wins). Within
// tier, most recent escrow by createdAt desc is the displayed one.

export type ArbiterWarning =
  | { kind: "none" }
  | {
      kind: "soft";
      escrowId: string;
      counterpartyA: string;
      counterpartyB: string;
      createdAt: number;
    }
  | {
      kind: "hard";
      escrowId: string;
      counterpartyA: string;
      counterpartyB: string;
      createdAt: number;
    };

export interface ArbiterWarningInputs {
  userPubkey: string;
  escrows: Iterable<EscrowState>;
}

export function decideArbiterWarning(inputs: ArbiterWarningInputs): ArbiterWarning {
  const arbitered: EscrowState[] = [];
  for (const e of inputs.escrows) {
    if (e.participants.arbiter !== inputs.userPubkey) continue;
    if (e.status !== EscrowStatus.LOCKED) continue;
    arbitered.push(e);
  }
  if (arbitered.length === 0) return { kind: "none" };

  const isHard = (e: EscrowState): boolean => {
    const buyerVote = e.votes[Role.BUYER];
    const sellerVote = e.votes[Role.SELLER];
    return !!buyerVote && !!sellerVote && buyerVote !== sellerVote;
  };

  const hard = arbitered
    .filter(isHard)
    .sort((a, b) => b.createdAt - a.createdAt);
  if (hard.length > 0) {
    const e = hard[0];
    return {
      kind: "hard",
      escrowId: e.id,
      counterpartyA: e.participants.buyer ?? "",
      counterpartyB: e.participants.seller ?? "",
      createdAt: e.createdAt,
    };
  }

  const soft = [...arbitered].sort((a, b) => b.createdAt - a.createdAt);
  const e = soft[0];
  return {
    kind: "soft",
    escrowId: e.id,
    counterpartyA: e.participants.buyer ?? "",
    counterpartyB: e.participants.seller ?? "",
    createdAt: e.createdAt,
  };
}
