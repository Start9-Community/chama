// ══════════════════════════════════════════════════════════════════════════
// Chama — relay backfill (hand recovered history back to the relay)
// ══════════════════════════════════════════════════════════════════════════
//
// WHY: a trade's chain can go missing from the relays while this device still
// holds it. Field survey of one arbiter's 124 remembered trades: 16 of the 77
// post-relay trades had holes in their chain on relay.chama.community (9
// missing both VOTEs, 5 missing the CREATE, 2 missing the LOCK), and the
// device's durable event cache held MORE events than the relay for 50 of the
// 124. A chain missing its VOTEs can't replay (RESOLVE dies on
// THRESHOLD_NOT_MET), so the trade is unopenable for EVERY participant — not
// just this one.
//
// Escrow events are signed Nostr events: anyone holding one can republish it
// and the relay can verify it. So when a load only succeeded because the
// durable cache filled a gap, the honest move is to give those events back.
// The selection is pure and testable here; the transport lives in
// relay-manager.republishToPreferredRelay.

import type { NostrEvent } from "./types.js";

/** Cap per repaired trade. A whole chain is ~5-20 events; this bounds a
 *  pathological record (or a corrupted cache) from turning one tap into a
 *  publish flood. */
export const MAX_BACKFILL_EVENTS = 50;

/** Ceiling on distinct trades backfilled in one session. Republished events
 *  are REDELIVERED by the relay to every client with a matching live
 *  subscription, so a burst is other people's bandwidth and re-render work,
 *  not just ours. Repair is opportunistic: what this session doesn't fix, a
 *  later session (or another participant's device) will. */
export const MAX_BACKFILL_TRADES_PER_SESSION = 25;

/** Floor on the gap between batches, so rapidly tapping through a list of
 *  archived trades paces the repair instead of stacking it. */
export const MIN_BACKFILL_INTERVAL_MS = 3_000;

/**
 * Whether a repaired trade may hand its recovered events back right now.
 * ONE-SHOT per trade (a re-tap must not re-offer: either the relay took them
 * — in which case the next load isn't even a repair — or it's refusing them,
 * and retrying on every tap just burns round-trips), plus the session ceiling
 * and the pacing floor. Pure.
 */
export function shouldBackfillNow(opts: {
  alreadyBackfilled: boolean;
  sessionCount: number;
  lastBackfillAt: number;
  now?: number;
}): boolean {
  if (opts.alreadyBackfilled) return false;
  if (opts.sessionCount >= MAX_BACKFILL_TRADES_PER_SESSION) return false;
  const now = opts.now ?? Date.now();
  return now - opts.lastBackfillAt >= MIN_BACKFILL_INTERVAL_MS;
}

/**
 * Events we hold locally that the relay's answer did NOT include — the gap to
 * hand back. Oldest first (a relay that receives CREATE before LOCK indexes a
 * sane chain), deduped, capped.
 *
 * ⚠ Only meaningful for a FULL (cursor-less) fetch. With a `since` cursor the
 * relay is answering a delta, so "not returned" means "already had it", not
 * "missing" — callers must not backfill from a delta fetch.
 */
export function selectBackfillEvents(
  local: readonly NostrEvent[],
  relayReturned: readonly NostrEvent[],
  max: number = MAX_BACKFILL_EVENTS,
): NostrEvent[] {
  const known = new Set<string>();
  for (const e of relayReturned) {
    if (e && typeof e.id === "string") known.add(e.id);
  }
  const out: NostrEvent[] = [];
  const seen = new Set<string>();
  for (const e of local) {
    if (!e || typeof e.id !== "string" || typeof e.sig !== "string") continue;
    if (known.has(e.id) || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  out.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
  return out.slice(0, max);
}
