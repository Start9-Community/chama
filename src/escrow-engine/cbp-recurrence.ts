// ══════════════════════════════════════════════════════════════════════════
// Chama — Monthly recurring Community Bill Pay (CBP) — client-side recurrence
// ══════════════════════════════════════════════════════════════════════════
//
// A Community Bill Pay listing is a bill an OWNER posts in local fiat that a
// VOLUNTEER pays (keeping the sats + a bonus). Real bills recur — rent, water,
// electricity, school fees land every month. "Monthly CBP" lets an owner mark a
// bill (or a bundle of bills) as recurring so the client AUTO-RE-POSTS it on a
// ~monthly cadence, without the owner re-typing it each month.
//
// DESIGN (frozen — see Jetty's decisions):
//  • NO BOND. CBP is self-limiting — a volunteer chooses to pay; an unpaid bill
//    is zero harm — so recurrence works for ANY user, unlike a farmable
//    storefront (store-permanence Tier 3 gated auto-renew on a bond; CBP does
//    NOT). This divergence is intentional.
//  • HOME-COMMUNITY ONLY. A re-post goes strictly to the listing's OWN community
//    (which is the owner's home — local money). It never fans out to other
//    chamas. This is inherent: the re-post reuses buildRenewCreateParams, which
//    copies state.community verbatim.
//  • ONLINE-GATED. Re-posting requires the owner's client alive (the App effect
//    only runs while connected). A vanished owner's recurring bill simply
//    lapses — natural anti-abuse without a bond.
//  • RE-PUBLISH, NEVER TRANSFER. A re-post is a fresh CREATE (Option B, §2.1) —
//    it moves ZERO sats and adds NO consensus field. This module is a purely
//    CLIENT-SIDE localStorage bookkeeper (mirrors trade-index / listing-renewal
//    storage) — no reducer, no state-machine, no money path touched.
//
// A "series" is identified by the escrowId of the FIRST listing published with
// recurrence on (`seriesId`). Each monthly re-post is a new CREATE with a new
// escrowId; the config tracks the most recent instance (`lastPostId`) and when
// it was posted (`lastPostAt`) so the cadence timer + the anti-stacking gate can
// reason about it.

import {
  getScopedStorageItem,
  setScopedStorageItem,
  removeScopedStorageItem,
} from "../storage/user-scope.js";
import { type EscrowState, EscrowStatus } from "./types.js";
import { listingIdentityKey } from "./listing-renewal-ledger.js";

/** Versioned, user-scoped localStorage key. */
export const CBP_RECURRENCE_KEY = "chama_cbp_recurrence_v1";

/** Cadence: re-post ~30 days after the last post. Whole-month feel; the App
 *  effect fires it the first time the client is online past this horizon. */
export const RECURRENCE_PERIOD_SECONDS = 30 * 24 * 60 * 60;

/** Bound growth — a real user has a handful of recurring bills; a heavy tester
 *  eventually rolls the oldest tail. */
export const CBP_RECURRENCE_MAX = 100;

/** Statuses that mean a bill instance is DONE (paid, lapsed, or cancelled) and
 *  therefore no longer a live/unpaid instance for anti-stacking purposes. */
const TERMINAL_STATUSES: ReadonlySet<EscrowStatus> = new Set([
  EscrowStatus.COMPLETED,
  EscrowStatus.EXPIRED,
  EscrowStatus.CANCELLED,
]);

export interface CbpRecurrenceConfig {
  /** The FIRST listing in the series — its escrowId is the stable series id. */
  seriesId: string;
  /** The community the series re-posts to (the owner's home). Stored for the UI
   *  + a defensive home-only check; the actual re-post inherits it from state. */
  community: string | null;
  /** The most recently published instance's escrowId. */
  lastPostId: string;
  /** When `lastPostId` was posted (Unix SECONDS) — drives the 30-day cadence. */
  lastPostAt: number;
  /** When the series was first created (Unix SECONDS) — display/sort. */
  createdAt: number;
  /** Owner toggled it off ⇒ inactive (kept for history; never re-posts). */
  active: boolean;
}

type Store = Record<string, CbpRecurrenceConfig>;

function load(): Store {
  try {
    const raw = getScopedStorageItem(CBP_RECURRENCE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Store;
  } catch (e) {
    console.warn("[chama] cbp-recurrence: load failed:", e);
    return {};
  }
}

function save(store: Store): void {
  try {
    setScopedStorageItem(CBP_RECURRENCE_KEY, JSON.stringify(store));
  } catch (e) {
    // Best-effort bookkeeping. NEVER block a publish or a money path on it.
    console.warn("[chama] cbp-recurrence: save failed:", e);
  }
}

/** All recurrence configs (active + inactive), newest-created first. */
export function listCbpRecurrence(): CbpRecurrenceConfig[] {
  return Object.values(load()).sort((a, b) => b.createdAt - a.createdAt);
}

/** Only the still-active series. */
export function activeCbpRecurrence(): CbpRecurrenceConfig[] {
  return listCbpRecurrence().filter((c) => c.active);
}

/** Register a NEW recurring series when the owner publishes a CBP with the
 *  monthly toggle on. `escrowId` is the just-published listing = the series id
 *  and its first instance. No-op-safe to call twice (idempotent upsert). */
export function registerCbpRecurrence(opts: {
  escrowId: string;
  community: string | null;
  nowSec?: number;
}): void {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const store = load();
  store[opts.escrowId] = {
    seriesId: opts.escrowId,
    community: opts.community,
    lastPostId: opts.escrowId,
    lastPostAt: nowSec,
    createdAt: store[opts.escrowId]?.createdAt ?? nowSec,
    active: true,
  };
  // Evict oldest-created past the cap.
  const ids = Object.keys(store);
  if (ids.length > CBP_RECURRENCE_MAX) {
    const byOldest = ids.sort((a, b) => store[a].createdAt - store[b].createdAt);
    for (const id of byOldest.slice(0, ids.length - CBP_RECURRENCE_MAX)) delete store[id];
  }
  save(store);
}

/** Record a completed monthly re-post: point the series at the fresh instance
 *  and reset its cadence clock. */
export function recordCbpRepost(seriesId: string, newPostId: string, nowSec?: number): void {
  const store = load();
  const cfg = store[seriesId];
  if (!cfg) return;
  cfg.lastPostId = newPostId;
  cfg.lastPostAt = nowSec ?? Math.floor(Date.now() / 1000);
  save(store);
}

/** Stop a series (owner cancelled recurrence). Marks inactive; keeps the row so
 *  the current instance still shows a badge until it settles/lapses. */
export function cancelCbpRecurrence(seriesId: string): void {
  const store = load();
  const cfg = store[seriesId];
  if (!cfg) return;
  cfg.active = false;
  save(store);
}

/** Find the series a given listing id belongs to (as the original series listing
 *  OR its most recent re-post) — powers the "🔁 monthly" badge + the Stop
 *  control on whichever instance is currently shown. */
export function findSeriesByInstanceId(escrowId: string): CbpRecurrenceConfig | null {
  const store = load();
  if (store[escrowId]) return store[escrowId];
  for (const cfg of Object.values(store)) {
    if (cfg.lastPostId === escrowId) return cfg;
  }
  return null;
}

/** True when the listing id is a currently-active recurring series/instance. */
export function isListingRecurring(escrowId: string): boolean {
  const cfg = findSeriesByInstanceId(escrowId);
  return !!cfg && cfg.active;
}

/** The series' cadence has elapsed (≥ 30 days since the last post). Pure. */
export function isDueForRepost(cfg: CbpRecurrenceConfig, nowSec: number): boolean {
  return cfg.active && nowSec >= cfg.lastPostAt + RECURRENCE_PERIOD_SECONDS;
}

/** Anti-stacking gate: block a re-post while the prior instance is still a LIVE
 *  (non-terminal) bill — never pile up multiple unpaid rent bills (concurrent
 *  unpaid cap = 1). A prior instance that's COMPLETED (paid), EXPIRED (lapsed)
 *  or CANCELLED no longer blocks. An instance we can't see this session (aged
 *  off the relay) is treated as NOT blocking: 30-day cadence ≫ the 24h listing
 *  expiry, so an unloaded prior is virtually always long-lapsed, and any live
 *  instance the owner is a party to is loaded from saved pointers on boot. */
export function priorInstanceBlocks(
  cfg: CbpRecurrenceConfig,
  statesById: ReadonlyMap<string, EscrowState>,
): boolean {
  const s = statesById.get(cfg.lastPostId);
  return !!s && !TERMINAL_STATUSES.has(s.status);
}

/** Series that should re-post NOW: active, cadence elapsed, and not blocked by a
 *  still-live prior instance. The App effect maps these to a repost action. */
export function dueRecurringSeries(
  statesById: ReadonlyMap<string, EscrowState>,
  nowSec: number,
): CbpRecurrenceConfig[] {
  return activeCbpRecurrence().filter(
    (cfg) => isDueForRepost(cfg, nowSec) && !priorInstanceBlocks(cfg, statesById),
  );
}

/**
 * Historical test cycles could register the same bill as several independent
 * active series. When all became due, one innocent state update woke every
 * copy and produced a repost burst. Collapse only byte-identical bill series
 * whose source state is loaded, keeping the newest registration. Distinct
 * bills—even in the same community—remain independent.
 */
export function supersededRecurringSeriesIds(
  configs: readonly CbpRecurrenceConfig[],
  statesById: ReadonlyMap<string, EscrowState>,
): string[] {
  const groups = new Map<string, CbpRecurrenceConfig[]>();
  for (const cfg of configs) {
    const state = statesById.get(cfg.lastPostId) ?? statesById.get(cfg.seriesId);
    if (!state) continue;
    const key = listingIdentityKey(state);
    const group = groups.get(key);
    if (group) group.push(cfg);
    else groups.set(key, [cfg]);
  }
  const out: string[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    let newest = group[0];
    for (const cfg of group) {
      if (cfg.createdAt > newest.createdAt) newest = cfg;
    }
    for (const cfg of group) {
      if (cfg.seriesId !== newest.seriesId) out.push(cfg.seriesId);
    }
  }
  return out;
}

/** The next-post timestamp (Unix SECONDS) for display. */
export function nextRepostAt(cfg: CbpRecurrenceConfig): number {
  return cfg.lastPostAt + RECURRENCE_PERIOD_SECONDS;
}

/** Wipe the whole store. Tests + a future advanced-settings action only. */
export function clearCbpRecurrence(): void {
  try {
    removeScopedStorageItem(CBP_RECURRENCE_KEY);
  } catch (e) {
    console.warn("[chama] cbp-recurrence: clear failed:", e);
  }
}
