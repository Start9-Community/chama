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
  DEFAULT_COMMUNITY_SLUG,
} from "../communities/registry.js";
import { BP_FEDERATION_INVITE } from "../fedimint/federation-invites.js";
import {
  type EscrowState,
  EscrowStatus,
  EscrowEventKind,
  Role,
  TRULY_TERMINAL_STATES,
} from "../escrow-engine/types.js";

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

  // Returning user, fed differs. Balance == 0 → silent re-init is safe;
  // balance > 0 → must surface the destroy-confirm modal.
  if (inputs.balanceMsats === 0) {
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
//      BP + global-usd silently so the user lands on Browse with a
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
      reason: "first-time-npub";
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

  // First-time-npub: no home AND no active. Assign BP + global-usd
  // silently. The defaultCommunity slug becomes the user's home (the
  // shell calls actions.setCommunity with it), so subsequent reloads
  // land them in branch 2 (use-home) — first-time-default fires
  // exactly once per npub.
  if (!inputs.activeInvite) {
    const defaultCommunity = getCommunityBySlug(DEFAULT_COMMUNITY_SLUG);
    const defaultInvite = defaultCommunity?.federationInvite ?? BP_FEDERATION_INVITE;
    return {
      kind: "use-default",
      invite: defaultInvite,
      defaultCommunity: DEFAULT_COMMUNITY_SLUG,
      reason: "first-time-npub",
    };
  }

  // Sandbox-style: active invite without home. Manual reconnect /
  // community-pill tap is the right path.
  return { kind: "skip" };
}

// ──────────────────────────────────────────────────────────────────────────
// Browser-support honesty banner
// ──────────────────────────────────────────────────────────────────────────
//
// Per Pillar 2.7 (educate at every opportunity) + the v0.1.85 reality
// that every Fedimint federation we currently have access to relies on
// iroh-relay infrastructure with known browser-WebSocket flakiness. Web
// users see a one-time honest disclosure regardless of whether they've
// committed to a federation yet — first-time users encounter it as
// they're about to tap a community pill, which is the right educational
// moment.
//
// Render only when ALL of:
//   - we're in a browser (native APK has no iroh issue)
//   - the user hasn't dismissed the banner before (one-time-per-account)

export interface BrowserBannerInputs {
  isBrowser: boolean;
  dismissed: boolean;
}

export function shouldShowBrowserSupportBanner(inputs: BrowserBannerInputs): boolean {
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
// Active-trade detection (item 3 — one-trade-at-a-time gate)
// ──────────────────────────────────────────────────────────────────────────
//
// Per the v0.2.0 brief + Q3 evolution: hard-block Create + Fund when
// the user is a participant (buyer or seller) in a non-terminal
// escrow. Arbiter status doesn't trigger the hard block — it triggers
// the soft/hard arbiter warnings via decideArbiterWarning.
//
// "Non-terminal" here means status not in TRULY_TERMINAL_STATES
// (COMPLETED / CANCELLED). EXPIRED is included as an active state
// because per types.ts the engine treats EXPIRED as a transient
// healing state, not a settled terminal one.

export function hasActiveBuyerSellerCommitment(inputs: {
  escrows: Iterable<EscrowState>;
  userPubkey: string;
}): boolean {
  for (const e of inputs.escrows) {
    const isBuyerOrSeller =
      e.participants.buyer === inputs.userPubkey
      || e.participants.seller === inputs.userPubkey;
    if (!isBuyerOrSeller) continue;
    if (TRULY_TERMINAL_STATES.has(e.status)) continue;
    return true;
  }
  return false;
}

/** The most-recent active buyer/seller trade. Used by the shell to
 *  drive the "go to active trade" pill's tap target. Returns null if
 *  no active trade exists. */
export function findActiveTrade(inputs: {
  escrows: Iterable<EscrowState>;
  userPubkey: string;
}): EscrowState | null {
  let best: EscrowState | null = null;
  for (const e of inputs.escrows) {
    const isBuyerOrSeller =
      e.participants.buyer === inputs.userPubkey
      || e.participants.seller === inputs.userPubkey;
    if (!isBuyerOrSeller) continue;
    if (TRULY_TERMINAL_STATES.has(e.status)) continue;
    if (!best || e.createdAt > best.createdAt) best = e;
  }
  return best;
}

// ──────────────────────────────────────────────────────────────────────────
// Recovery banner (item 2)
// ──────────────────────────────────────────────────────────────────────────
//
// Per Pillar 2.1's "no sats stranded, ever" promise: when the user's
// OPFS holds a balance but they have no active trade, that's a
// recovery state — surface a banner that replaces Browse and forces
// resolution before any other commitment can be created. The banner
// shows the user's last counterparty (resolved via the most recent
// CLAIM event they signed) and a "withdraw via Lightning" CTA.

export function shouldShowRecoveryBanner(inputs: {
  balanceMsats: number;
  hasCurrentEscrow: boolean;
}): boolean {
  return inputs.balanceMsats > 0 && !inputs.hasCurrentEscrow;
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

export function decideListingTapEffect(inputs: ListingTapInputs): ListingTapEffect {
  const targetInvite = resolveListingInvite(inputs.listing);
  const community = inputs.listing.community ? getCommunityBySlug(inputs.listing.community) : null;
  const displayName = community?.displayName ?? "the listing's community";

  if (inputs.currentInvite === targetInvite) {
    return { kind: "matching" };
  }
  if (!inputs.currentInvite || inputs.balanceMsats === 0) {
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
