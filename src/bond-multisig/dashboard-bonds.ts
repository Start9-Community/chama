// ══════════════════════════════════════════════════════════════════════════
// Chama — Dashboard "YOUR BOND" merge (#77: bond is cross-device)
// ══════════════════════════════════════════════════════════════════════════
//
// The Dashboard's "YOUR BOND" section used to read the DEVICE-LOCAL
// commitment-store only, so a fresh device (a new PWA install) with the same
// npub showed "Post a bond" even though the user has a live, on-chain,
// announced (kind-38135) bond. This pure helper MERGES the local commitment
// records with the user's own chain-verified announcements so a bond shows
// wherever the user signs in.
//
// ⚠ An announced-only bond has NO local reclaim material (the reclaim key is
// device-local, derived from the seed on the device that created it). So a
// merged entry carries `local` — the caller renders a real Reclaim/Manage
// affordance ONLY for local bonds, and a "reclaim from the creating device"
// note for announced-only ones (never a reclaim button that can't run here).

import type { CommitmentRecord } from "./commitment-store.js";
import type { VerifiedBond } from "./bond-announcement.js";

export interface DashboardBond {
  /** Stable identity across sources: the bond's on-chain address. */
  key: string;
  amountSats: number;
  /** Still timelocked / committed (local `locked` phase, or announced active). */
  locked: boolean;
  /** True ⇒ this device holds the local record → reclaimable here. False ⇒
   *  known only from the announcement → visible but not reclaimable here. */
  local: boolean;
}

const samePubkey = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/** Merge the device-local commitment records with the user's own chain-verified
 *  announcements, deduped by bond ADDRESS. Local records win the identity (they
 *  carry reclaim material); an announced bond only adds an entry when no local
 *  record already covers that address. Only FUNDED + ACTIVE announced bonds authored
 *  by `myPubkey` are added (an unfunded/expired announcement is not a live bond). */
export function mergeDashboardBonds(
  localActive: readonly CommitmentRecord[],
  announced: readonly VerifiedBond[],
  myPubkey: string,
): DashboardBond[] {
  const out: DashboardBond[] = [];
  const seen = new Set<string>();
  for (const b of localActive) {
    const key = b.bond.address;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, amountSats: Number(b.amountSats), locked: b.phase === "locked", local: true });
  }
  for (const v of announced) {
    if (!v.funded || !v.active) continue;
    if (!samePubkey(v.npub, myPubkey)) continue;
    const key = v.address;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, amountSats: Number(v.actualSats), locked: v.active, local: false });
  }
  return out;
}
