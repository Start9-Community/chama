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
// Tapping a community pill (other than "All communities") must:
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
// "All communities" is filter-only — does NOT change identity.
//
// Effect kinds:
//   - filter-only      — slug === "all"
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
  | { kind: "filter-only" }
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
  if (inputs.slug === "all") {
    return { kind: "filter-only" };
  }

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
