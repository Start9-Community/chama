// Device-local "show my own listings in Browse" preference + ownership helpers.
//
// A seller authors listings (CREATE), so their own listings show up in the
// public Browse feed — which is confusing (they can't/shouldn't shop their own
// shop, and it muddles telling a parent storefront from a live child order).
// By DEFAULT we hide the viewer's own authored listings from Browse. Turning
// on "My listings" switches to an owner-only mode (not an additive reveal):
// public listings disappear until the mode is turned off.
//
// Client-only, no reducer/consensus/money-path involvement.
import { Role, type EscrowState } from "../escrow-engine/types.js";

const SHOW_OWN_KEY = "chama_browse_show_own_v1";

/** True if owner-only Browse mode is ON. Default OFF. */
export function getBrowseShowOwn(): boolean {
  try {
    return localStorage.getItem(SHOW_OWN_KEY) === "1";
  } catch {
    return false;
  }
}

/** Persist the toggle. */
export function setBrowseShowOwn(show: boolean): void {
  try {
    localStorage.setItem(SHOW_OWN_KEY, show ? "1" : "0");
  } catch {
    /* private mode / storage disabled — non-fatal, defaults to hidden */
  }
}

/**
 * The pubkey that authored a listing: the seller if seated, else the CREATE
 * initiator (a listing is CREATED with no counterparty yet, so the initiator
 * IS the author). Returns null if unknowable.
 */
export function listingOwnerPubkey(listing: EscrowState): string | null {
  return listing.participants?.[Role.SELLER] ?? listing.initiator?.pubkey ?? null;
}

/** True when the viewer authored this listing. Fails CLOSED (never "mine") when
 *  either pubkey is missing, so a buyer's feed is never wrongly hidden. */
export function isOwnListing(listing: EscrowState, viewerPubkey: string | null | undefined): boolean {
  if (!viewerPubkey) return false;
  const owner = listingOwnerPubkey(listing);
  return owner !== null && owner === viewerPubkey;
}

/**
 * Split Browse into mutually-exclusive modes. Owner mode shows ONLY listings
 * authored by the viewer; public mode shows everything EXCEPT theirs. If the
 * viewer identity is unavailable, fail open to the public set.
 */
export function filterOwnListings<T extends EscrowState>(
  listings: readonly T[],
  viewerPubkey: string | null | undefined,
  showOwn: boolean,
): T[] {
  if (!viewerPubkey) return [...listings];
  return listings.filter((l) => isOwnListing(l, viewerPubkey) === showOwn);
}

/** Count of the viewer's own listings within a set (for the "N of yours hidden" hint). */
export function countOwnListings(listings: readonly EscrowState[], viewerPubkey: string | null | undefined): number {
  if (!viewerPubkey) return 0;
  return listings.reduce((n, l) => n + (isOwnListing(l, viewerPubkey) ? 1 : 0), 0);
}
