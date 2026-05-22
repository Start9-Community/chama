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

/** Read the user's selected community slug. Falls back to the default
 *  (us-blf, shown as Global · USD) when nothing is stored or storage is unreachable. An
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
    else setScopedStorageItem(COMMUNITY_STORAGE_KEY, slug);
  } catch {
    // localStorage unavailable (private mode, etc.) — silently no-op.
  }
}
