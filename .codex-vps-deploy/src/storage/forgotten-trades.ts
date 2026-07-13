// ══════════════════════════════════════════════════════════════════════════
// Chama — Forgotten-trade denylist (localStorage)
// ══════════════════════════════════════════════════════════════════════════
//
// "Forget this trade" must STICK across restarts. Dropping the saved pointer
// isn't enough on its own: the Browse / public-listings feed re-delivers every
// trade's (public) CREATE, which flows through updateEscrow and would silently
// re-add a forgotten ghost on the next reload. So a forgotten id is also kept
// in this persistent denylist that updateEscrow honors.
//
// Scoped per-pubkey (a hide is one signer's local choice). Mirrors the
// saved-escrow-ids storage shape (a JSON string array under a pubkey-suffixed
// key). Explicitly loading a trade by ID clears it here — the deliberate
// "bring it back."

const FORGOTTEN_STORAGE_KEY = "chama_forgotten_ids";
const MAX_FORGOTTEN_IDS = 200;

function forgottenKey(pubkey?: string | null): string {
  return pubkey ? `${FORGOTTEN_STORAGE_KEY}:${pubkey}` : FORGOTTEN_STORAGE_KEY;
}

function parseIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** All forgotten ids for a pubkey (empty if none / storage unavailable). */
export function getForgottenEscrowIds(pubkey?: string | null): string[] {
  try {
    return parseIds(localStorage.getItem(forgottenKey(pubkey)));
  } catch {
    return [];
  }
}

/** Whether an id is on the forgotten denylist for this pubkey. */
export function isForgottenEscrowId(id: string, pubkey?: string | null): boolean {
  return getForgottenEscrowIds(pubkey).includes(id);
}

/** Add an id to the denylist (idempotent; newest first; capped). */
export function addForgottenEscrowId(id: string, pubkey?: string | null): void {
  try {
    const ids = getForgottenEscrowIds(pubkey);
    if (!ids.includes(id)) {
      ids.unshift(id);
      localStorage.setItem(forgottenKey(pubkey), JSON.stringify(ids.slice(0, MAX_FORGOTTEN_IDS)));
    }
  } catch {
    /* storage unavailable — denylist is best-effort */
  }
}

/** Remove an id from the denylist (the deliberate "bring it back" on load). */
export function unforgetEscrowId(id: string, pubkey?: string | null): void {
  try {
    const ids = getForgottenEscrowIds(pubkey).filter(i => i !== id);
    if (ids.length > 0) localStorage.setItem(forgottenKey(pubkey), JSON.stringify(ids));
    else localStorage.removeItem(forgottenKey(pubkey));
  } catch {
    /* storage unavailable — denylist is best-effort */
  }
}
