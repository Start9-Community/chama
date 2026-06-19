// ══════════════════════════════════════════════════════════════════════════
// Chama — User Community Selection (localStorage)
// ══════════════════════════════════════════════════════════════════════════
//
// The user's chosen community persists across sessions in localStorage
// under `chama_community:<pubkey>` once a signer is connected. First-run
// onboarding may write the legacy `chama_community` key before the pubkey is
// known; the scoped storage helper claims that value after connect. v2 will
// migrate this to a NIP-78 application-data event so the choice follows the
// npub across devices.
//
// The slug stored here flows into:
//   - createEscrow: tags listings with the user's community
//   - initFedimint: resolves which federation backs this community's wallet
//   - Browse filter: defaults to listings that match this community

import { DEFAULT_COMMUNITY_SLUG, getCommunityBySlug } from "./registry.js";
import {
  claimLegacyStorageItem,
  getScopedStorageItem,
  removeScopedStorageItem,
  setScopedStorageItem,
} from "../storage/user-scope.js";

export const COMMUNITY_STORAGE_KEY = "chama_community";

// v3.5.1 #6 — UNSCOPED "last home" display hint. The per-npub home lives at
// the scoped `chama_community:<pubkey>` key, which is UNREADABLE before a
// signer connects (no scope yet). On web there is no auto-login, so every
// reload lands on the disconnected ConnectScreen — and with the scoped home
// unreadable, a returning user was dropped onto the first-run globe.
//
// This hint is written whenever the home is set/known and read ONLY by the
// ConnectScreen, purely to keep a returning user past the globe pre-signin.
// It is deliberately NOT consulted by getUserCommunitySlug /
// claimLegacyStorageItem, so it can never flow into a *different* npub's
// committed community — the v3.5.1 onboarding-leak fix stays intact. Worst
// case on a shared browser is cosmetic: a fresh npub briefly sees the prior
// user's home name on the pre-signin welcome screen; their actual home is
// still resolved from their own (empty) scope after sign-in.
const LAST_HOME_KEY = "chama_last_home";

/** Persist the unscoped "last home" display hint (see LAST_HOME_KEY). */
export function setLastHomeHint(slug: string): void {
  try {
    if (typeof localStorage === "undefined" || !slug) return;
    localStorage.setItem(LAST_HOME_KEY, slug);
  } catch {
    // localStorage unavailable — silently no-op.
  }
}

/** Read the unscoped "last home" hint, or null. Unknown slugs (stale
 *  registry) resolve to null rather than flowing onward. */
export function getLastHomeHint(): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(LAST_HOME_KEY);
    if (!raw) return null;
    return getCommunityBySlug(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Read the user's selected community slug. Falls back to the default
 *  (us-blf, the silent Global · Bitcoin / BLF backup) when nothing is stored or storage is unreachable. An
 *  unknown slug (stale entry from an older registry version) also
 *  falls back to default rather than silently flowing into new listings. */
export function getUserCommunitySlug(): string {
  try {
    const raw = claimLegacyStorageItem(COMMUNITY_STORAGE_KEY);
    if (!raw) return DEFAULT_COMMUNITY_SLUG;
    return getCommunityBySlug(raw) ? raw : DEFAULT_COMMUNITY_SLUG;
  } catch {
    return DEFAULT_COMMUNITY_SLUG;
  }
}

/** Read the raw stored community slug, returning `null` when the user
 *  hasn't picked one yet. Use this for UI affordances that should
 *  distinguish "explicit choice" from "default fallback" — e.g. the
 *  community pill highlight, where a first-time user should see no
 *  pill highlighted rather than a misleading default. For resolution
 *  paths (createEscrow, initFedimint) keep using `getUserCommunitySlug`,
 *  which guarantees a non-null slug. */
export function getUserCommunitySlugRaw(): string | null {
  try {
    const raw = claimLegacyStorageItem(COMMUNITY_STORAGE_KEY);
    if (!raw) return null;
    return getCommunityBySlug(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Persist the user's community choice. Pass empty string to clear and
 *  revert to the default on next read. */
export function setUserCommunitySlug(slug: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (!slug) removeScopedStorageItem(COMMUNITY_STORAGE_KEY);
    else {
      setScopedStorageItem(COMMUNITY_STORAGE_KEY, slug);
      // Keep the unscoped pre-signin display hint in sync (v3.5.1 #6).
      setLastHomeHint(slug);
    }
  } catch {
    // localStorage unavailable (private mode, etc.) — silently no-op.
  }
}

// ── Pre-signer onboarding selection (v3.5.1 onboarding-leak fix) ──────────
//
// The globe picker runs BEFORE a signer is known, so it cannot write the
// per-npub scoped community key. The old flow wrote the legacy global
// `chama_community` directly; the FIRST npub to connect then claimed that
// value (claimLegacyStorageItem), so fresh/secondary npubs on the same
// browser/profile raced to the BLF default instead of the user's pick —
// the cross-instance "landed on different federations" symptom.
//
// Instead, stash the pre-signer pick under its OWN key and commit it to the
// connecting npub's scope via applyPendingCommunitySelection(), called the
// moment the signer is known (right after setLocalStorageUserScope) and
// before initFedimint resolves community → federation.
const PENDING_COMMUNITY_KEY = "chama_pending_community";

/** Stash the globe-picker choice before a signer exists. */
export function setPendingCommunitySelection(slug: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (!slug) localStorage.removeItem(PENDING_COMMUNITY_KEY);
    else localStorage.setItem(PENDING_COMMUNITY_KEY, slug);
  } catch {
    // localStorage unavailable (private mode, etc.) — silently no-op.
  }
}

/** Read the stashed pre-signer choice, or null. Unknown slugs (stale
 *  registry) resolve to null rather than flowing onward. */
export function getPendingCommunitySelection(): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(PENDING_COMMUNITY_KEY);
    if (!raw) return null;
    return getCommunityBySlug(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Drop the stash without committing it (the "Change" affordance). */
export function clearPendingCommunitySelection(): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(PENDING_COMMUNITY_KEY);
    }
  } catch {
    // no-op
  }
}

/** Commit a deferred onboarding pick to the now-known npub scope, then drop
 *  the stash. Overwrites (matching the pre-fix claim-legacy semantics, so a
 *  returning npub re-picking on the globe still takes effect); clearing on
 *  apply is what prevents the pick from leaking to a later npub on shared
 *  storage. The stash is only ever written by the pre-signer globe picker,
 *  so when none exists this is a no-op and a returning npub keeps its own
 *  community. Call right after setLocalStorageUserScope(pubkey) and before
 *  any community → federation resolution. */
export function applyPendingCommunitySelection(): void {
  try {
    const pending = getPendingCommunitySelection();
    if (pending) setUserCommunitySlug(pending);
  } catch {
    // best-effort — fall through to clearing the stash
  }
  clearPendingCommunitySelection();
}
