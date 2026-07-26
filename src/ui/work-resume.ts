import { Role, type EscrowState } from "../escrow-engine/types.js";

/** Resolve the economic worker, not merely the event author. This remains
 * correct if a future Work order is buyer-authored like storefront children. */
export function workerPubkeyForListing(listing: EscrowState): string | null {
  return listing.participants[Role.SELLER]
    ?? (listing.initiator.role === Role.SELLER ? listing.initiator.pubkey : null);
}

/** A worker résumé is derived from public live offers. No profile database and
 * no mandatory taxonomy: publishing work is enough to create the résumé. */
export function workOffersForWorker(
  listings: readonly EscrowState[],
  workerPubkey: string,
): EscrowState[] {
  const wanted = workerPubkey.toLowerCase();
  const seen = new Set<string>();
  return listings.filter(listing => {
    if (listing.listingKind !== "work" || seen.has(listing.id)) return false;
    const worker = workerPubkeyForListing(listing);
    if (worker?.toLowerCase() !== wanted) return false;
    seen.add(listing.id);
    return true;
  });
}
