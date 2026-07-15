// ══════════════════════════════════════════════════════════════════════════
// Chama — attention-triage store (Me-screen hero queue management)
// ══════════════════════════════════════════════════════════════════════════
//
// Device-local, purely presentational state for the "needs your attention"
// hero on the Me screen. It NEVER hides money-critical work indefinitely:
//   • PINS reorder the queue (attend these first), they never remove items.
//   • SNOOZE hides an item ONLY while its status is unchanged AND < 12h old.
//     Any new event on the trade (a status change) OR the 12h cap resurfaces
//     it — a snoozed trade can never disappear "forever" while it still needs
//     the user to act (money-safety).
//
// Client-only, no reducer/consensus/money-path involvement. All helpers are
// pure + testable; the localStorage layer degrades to a no-op when storage is
// unavailable (SSR / private mode / Node tests).

import {
  EscrowStatus,
  Role,
  type EscrowState,
} from "../escrow-engine/types.js";

const STORE_KEY = "chama_attention_triage_v1";

/**
 * #69 The soonest active join-hold expiry (unix seconds) for a PRE-LOCK trade,
 * or null when there is no live hold to count down. A join-hold is "active"
 * only while the trade is CREATED and the held role's participant still matches
 * the hold's pubkey (a replaced/lapsed hold no longer counts). When more than
 * one role holds, the soonest expiry is the one that matters — that's the seat
 * the seller/buyer must beat. Pure so the attention card can render a live
 * mm:ss ticker without reimplementing hold logic.
 */
export function soonestJoinHoldExpirySec(trade: EscrowState): number | null {
  if (trade.status !== EscrowStatus.CREATED) return null;
  const holds = trade.joinHolds;
  if (!holds) return null;
  let soonest: number | null = null;
  for (const role of [Role.BUYER, Role.SELLER] as const) {
    const hold = holds[role];
    if (!hold) continue;
    if (trade.participants[role] !== hold.pubkey) continue;
    if (soonest === null || hold.expiresAt < soonest) soonest = hold.expiresAt;
  }
  return soonest;
}

/** A snoozed trade resurfaces after this long no matter what — nothing that
 *  needs action stays hidden past half a day. */
export const SNOOZE_MAX_MS = 12 * 60 * 60 * 1000;

/** Cap on stored entries per bucket (evict oldest). Keeps the blob bounded. */
export const TRIAGE_MAX_ENTRIES = 200;

export type SnoozeEntry = { snoozedAtStatus: string; snoozedAtMs: number };
export type TriageState = {
  /** Ordered list of pinned trade ids (pin order = display order). */
  pins: string[];
  /** tradeId → snooze record. */
  snoozes: Record<string, SnoozeEntry>;
};

const EMPTY: TriageState = { pins: [], snoozes: {} };

function safeStorage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

function readState(): TriageState {
  const store = safeStorage();
  if (!store) return { pins: [], snoozes: {} };
  try {
    const raw = store.getItem(STORE_KEY);
    if (!raw) return { pins: [], snoozes: {} };
    const parsed = JSON.parse(raw) as Partial<TriageState>;
    const pins = Array.isArray(parsed.pins)
      ? parsed.pins.filter((id): id is string => typeof id === "string")
      : [];
    const snoozes: Record<string, SnoozeEntry> = {};
    if (parsed.snoozes && typeof parsed.snoozes === "object") {
      for (const [id, entry] of Object.entries(parsed.snoozes)) {
        if (
          entry && typeof entry === "object" &&
          typeof (entry as SnoozeEntry).snoozedAtStatus === "string" &&
          typeof (entry as SnoozeEntry).snoozedAtMs === "number"
        ) {
          snoozes[id] = {
            snoozedAtStatus: (entry as SnoozeEntry).snoozedAtStatus,
            snoozedAtMs: (entry as SnoozeEntry).snoozedAtMs,
          };
        }
      }
    }
    return { pins, snoozes };
  } catch {
    return { pins: [], snoozes: {} };
  }
}

/** Bound both buckets to TRIAGE_MAX_ENTRIES, evicting the OLDEST first (pins:
 *  front of the list; snoozes: smallest snoozedAtMs). Pure. */
function prune(state: TriageState): TriageState {
  let pins = state.pins;
  if (pins.length > TRIAGE_MAX_ENTRIES) {
    pins = pins.slice(pins.length - TRIAGE_MAX_ENTRIES);
  }
  let snoozes = state.snoozes;
  const ids = Object.keys(snoozes);
  if (ids.length > TRIAGE_MAX_ENTRIES) {
    const keep = ids
      .sort((a, b) => snoozes[a].snoozedAtMs - snoozes[b].snoozedAtMs)
      .slice(ids.length - TRIAGE_MAX_ENTRIES);
    const next: Record<string, SnoozeEntry> = {};
    for (const id of keep) next[id] = snoozes[id];
    snoozes = next;
  }
  return { pins, snoozes };
}

function writeState(state: TriageState): void {
  const store = safeStorage();
  if (!store) return;
  const pruned = prune(state);
  const next = JSON.stringify(pruned);
  try {
    // No-churn: skip the write when nothing changed.
    if (store.getItem(STORE_KEY) === next) return;
    store.setItem(STORE_KEY, next);
  } catch {
    /* storage full / unavailable — presentation-only, safe to drop */
  }
}

// ── Pins ──────────────────────────────────────────────────────────────────

export function getPins(): string[] {
  return readState().pins;
}

export function isPinned(id: string): boolean {
  return readState().pins.includes(id);
}

export function pinTrade(id: string): void {
  const state = readState();
  if (state.pins.includes(id)) return;
  writeState({ ...state, pins: [...state.pins, id] });
}

export function unpinTrade(id: string): void {
  const state = readState();
  if (!state.pins.includes(id)) return;
  writeState({ ...state, pins: state.pins.filter((p) => p !== id) });
}

// ── Snoozes ─────────────────────────────────────────────────────────────────

export function getSnoozes(): Record<string, SnoozeEntry> {
  return readState().snoozes;
}

export function snoozeTrade(id: string, currentStatus: string, nowMs: number = Date.now()): void {
  const state = readState();
  writeState({
    ...state,
    snoozes: { ...state.snoozes, [id]: { snoozedAtStatus: currentStatus, snoozedAtMs: nowMs } },
  });
}

export function unsnooze(id: string): void {
  const state = readState();
  if (!(id in state.snoozes)) return;
  const { [id]: _drop, ...rest } = state.snoozes;
  writeState({ ...state, snoozes: rest });
}

/**
 * A trade is hidden from the hero ONLY IF it is snoozed AND its status is
 * unchanged from when it was snoozed AND less than SNOOZE_MAX_MS has passed.
 * Any status change (a new event happened) or the 12h cap resurfaces it.
 * Pure.
 */
export function isSnoozedNow(
  id: string,
  currentStatus: string,
  nowMs: number,
  snoozes: Record<string, SnoozeEntry>,
): boolean {
  const entry = snoozes[id];
  if (!entry) return false;
  if (entry.snoozedAtStatus !== currentStatus) return false;
  if (nowMs - entry.snoozedAtMs >= SNOOZE_MAX_MS) return false;
  return true;
}

/**
 * Final ordering for the attention hero. Takes the already urgency-ranked
 * trades (from selectNeedsYouTrades) and:
 *   1. drops any that are snoozed-now,
 *   2. sorts pinned trades first (in pin order),
 *   3. preserves the incoming urgency order for the rest.
 * Pure — pass `nowMs` + the pin/snooze snapshots so it's fully testable.
 */
export function orderAttention<T extends { id: string; status: string }>(
  rankedTrades: readonly T[],
  pins: readonly string[],
  snoozes: Record<string, SnoozeEntry>,
  nowMs: number,
): T[] {
  const visible = rankedTrades.filter((t) => !isSnoozedNow(t.id, t.status, nowMs, snoozes));
  const pinIndex = new Map<string, number>();
  pins.forEach((id, i) => pinIndex.set(id, i));
  // Stable sort: pinned (by pin order) before unpinned; equal keys keep the
  // incoming (urgency) order.
  return visible
    .map((trade, i) => ({ trade, i }))
    .sort((a, b) => {
      const pa = pinIndex.has(a.trade.id) ? pinIndex.get(a.trade.id)! : Infinity;
      const pb = pinIndex.has(b.trade.id) ? pinIndex.get(b.trade.id)! : Infinity;
      if (pa !== pb) return pa - pb;
      return a.i - b.i;
    })
    .map((x) => x.trade);
}
