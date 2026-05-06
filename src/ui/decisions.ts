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

import { getCommunityBySlug } from "../communities/registry.js";
import { BP_FEDERATION_INVITE } from "../fedimint/federation-invites.js";

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
// Per Pillar 2.1's "every user has a home" doctrine + the v0.1.87
// sticky-community design: a refresh always lands the user on their
// home community's federation, EXCEPT when an in-flight trade with
// funds at risk requires preserving the OPFS-bound fed so the trade
// can resume. The decision tree:
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
//   3. Else (no home, no in-flight-with-balance) → skip
//      (Truly first-time user; community pills are the join surface.)
//
// Pure: the helper reads no localStorage and no fedimint state. The
// shell collects the inputs and dispatches based on the result.

export type AutoInitTarget =
  | { kind: "skip" }
  | { kind: "use-active"; invite: string }
  | { kind: "use-home"; invite: string; slug: string };

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
