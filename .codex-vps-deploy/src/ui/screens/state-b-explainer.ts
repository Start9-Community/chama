// ══════════════════════════════════════════════════════════════════════════
// Chama — State B explainer card gate (v0.3.0 Phase 6)
// ══════════════════════════════════════════════════════════════════════════
//
// Per-pubkey gate for the educational State B card on TradeDetail.
// Mirrors the v0.2.0 chama_first_publish_done_<pubkey> shape (declared
// in CreateForm.tsx) — same key-prefix-plus-pubkey storage layout, same
// "1" sentinel, same defensive try/catch.
//
// Phase 6 reminder #1: per-pubkey not per-device. Different keypair on
// the same browser sees its own first-State-B encounter; same keypair
// on a different device starts fresh (no Nostr-backed sync of dismiss
// flags — these are local UX preferences).
//
// Difference from v0.2.0 first-publish: that pattern auto-marks on
// publish (the act IS the dismissal). This pattern surfaces a card with
// an explicit dismiss button — the brief calls for "dismissible". The
// localStorage shape is identical so future maintainers can follow the
// same precedent.

export const STATE_B_EXPLAINED_KEY_PREFIX = "chama_state_b_explained_";

/** True iff the user has already dismissed the State B card on this
 *  device with this pubkey. Returns false for null pubkey (treat as
 *  "not yet explained" — caller's render gate decides what to do). */
export function hasStateBExplained(pubkey: string | null): boolean {
  if (!pubkey) return false;
  try {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(STATE_B_EXPLAINED_KEY_PREFIX + pubkey) === "1";
  } catch {
    return false;
  }
}

/** Mark this pubkey as having seen + dismissed the State B card. No-op
 *  for null pubkey or when localStorage is unavailable (we'd rather
 *  show the card again than crash). */
export function markStateBExplained(pubkey: string | null): void {
  if (!pubkey) return;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STATE_B_EXPLAINED_KEY_PREFIX + pubkey, "1");
    }
  } catch {
    /* no-op */
  }
}
