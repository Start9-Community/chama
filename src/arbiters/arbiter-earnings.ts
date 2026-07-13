// ══════════════════════════════════════════════════════════════════════════
// Chama — Arbiter-premium ledger (task #53 E1)
// ══════════════════════════════════════════════════════════════════════════
//
// Two small durable, user-scoped stores, cloned from trade-index.ts
// (best-effort, sync, never blocks a money path):
//
//   1. PAYER OUTBOX (`chama_premium_outbox_v1`) — one record per trade I
//      owe a premium on. Doubles as the decline preference and the
//      double-pay guard: "sending" is written BEFORE the spend (V7-style
//      intent) so a crash between spend and publish never re-spends —
//      the stranded note auto-refunds via its try_cancel horizon.
//
//   2. ARBITER EARNINGS (`chama_arbiter_earnings_v1`) — one record per
//      redeemed (or given-up) premium note, keyed by the 38113 event id.
//      Feeds the Dashboard EARNINGS tile.

import {
  getScopedStorageItem,
  setScopedStorageItem,
  removeScopedStorageItem,
} from "../storage/user-scope.js";

// ── Payer outbox ──────────────────────────────────────────────────────────

export const PREMIUM_OUTBOX_KEY = "chama_premium_outbox_v1";
export const PREMIUM_OUTBOX_MAX = 500;

export type PremiumOutboxStatus = "sending" | "paid" | "declined";

export interface PremiumOutboxRecord {
  escrowId: string;
  amountMsats: number;
  status: PremiumOutboxStatus;
  operationId?: string;
  updatedAt: number; // ms
}

type Outbox = Record<string, PremiumOutboxRecord>;

function loadStore<T>(key: string): Record<string, T> {
  try {
    const raw = getScopedStorageItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, T>;
  } catch (e) {
    console.warn(`[chama] arbiter-earnings: load ${key} failed:`, e);
    return {};
  }
}

function saveStore<T extends { updatedAt: number }>(
  key: string,
  store: Record<string, T>,
  max: number,
): void {
  try {
    const ids = Object.keys(store);
    if (ids.length > max) {
      const byOldest = ids.sort((a, b) => store[a].updatedAt - store[b].updatedAt);
      for (const id of byOldest.slice(0, ids.length - max)) delete store[id];
    }
    setScopedStorageItem(key, JSON.stringify(store));
  } catch (e) {
    // Best-effort ledger. NEVER block a money path on it.
    console.warn(`[chama] arbiter-earnings: save ${key} failed:`, e);
  }
}

export function getPremiumOutboxRecord(escrowId: string): PremiumOutboxRecord | null {
  return loadStore<PremiumOutboxRecord>(PREMIUM_OUTBOX_KEY)[escrowId] ?? null;
}

export function hasPremiumOutboxRecord(escrowId: string): boolean {
  return getPremiumOutboxRecord(escrowId) !== null;
}

function putOutbox(record: PremiumOutboxRecord): void {
  const store = loadStore<PremiumOutboxRecord>(PREMIUM_OUTBOX_KEY);
  store[record.escrowId] = record;
  saveStore(PREMIUM_OUTBOX_KEY, store, PREMIUM_OUTBOX_MAX);
}

/** V7-style pre-spend intent: written BEFORE the wallet spend so a crash
 *  in the spend→publish gap can never license a second spend. */
export function recordPremiumSending(escrowId: string, amountMsats: number): void {
  putOutbox({ escrowId, amountMsats, status: "sending", updatedAt: Date.now() });
}

export function recordPremiumPaid(
  escrowId: string,
  amountMsats: number,
  operationId?: string,
): void {
  putOutbox({ escrowId, amountMsats, status: "paid", operationId, updatedAt: Date.now() });
}

/** The decline toggle. Declining writes a durable record (blocks the pay
 *  sweep); re-enabling clears it — but only a "declined" record, never a
 *  paid/sending one. */
export function setPremiumDeclined(escrowId: string, declined: boolean): void {
  const store = loadStore<PremiumOutboxRecord>(PREMIUM_OUTBOX_KEY);
  const prev = store[escrowId];
  if (declined) {
    if (prev && prev.status !== "declined") return; // never overwrite paid/sending
    store[escrowId] = {
      escrowId,
      amountMsats: prev?.amountMsats ?? 0,
      status: "declined",
      updatedAt: Date.now(),
    };
  } else {
    if (!prev || prev.status !== "declined") return;
    delete store[escrowId];
  }
  saveStore(PREMIUM_OUTBOX_KEY, store, PREMIUM_OUTBOX_MAX);
}

/** A failed spend moved no money — clear the intent so a later sweep can
 *  retry. Only clears "sending" (never a paid record). */
export function clearPremiumSending(escrowId: string): void {
  const store = loadStore<PremiumOutboxRecord>(PREMIUM_OUTBOX_KEY);
  if (store[escrowId]?.status === "sending") {
    delete store[escrowId];
    saveStore(PREMIUM_OUTBOX_KEY, store, PREMIUM_OUTBOX_MAX);
  }
}

// ── Arbiter earnings ──────────────────────────────────────────────────────

export const ARBITER_EARNINGS_KEY = "chama_arbiter_earnings_v1";
export const ARBITER_EARNINGS_MAX = 1000;

/** How many redeem failures before we stop retrying a note (its payer
 *  horizon has almost certainly refunded it by then). */
export const PREMIUM_REDEEM_MAX_ATTEMPTS = 6;

export interface ArbiterEarningRecord {
  /** The 38113 event id — the natural per-note key. */
  eventId: string;
  escrowId: string;
  payer: string;
  amountMsats: number;
  noteKind: "ambient" | "dispute";
  status: "redeemed" | "failed";
  attempts: number;
  updatedAt: number; // ms
}

export function getEarningRecord(eventId: string): ArbiterEarningRecord | null {
  return loadStore<ArbiterEarningRecord>(ARBITER_EARNINGS_KEY)[eventId] ?? null;
}

/** Settled = no further redeem attempts wanted: redeemed, or failed past
 *  the attempt cap (note refunded to payer / unrecoverable). */
export function isEarningSettled(eventId: string): boolean {
  const rec = getEarningRecord(eventId);
  if (!rec) return false;
  if (rec.status === "redeemed") return true;
  return rec.attempts >= PREMIUM_REDEEM_MAX_ATTEMPTS;
}

export function recordEarningRedeemed(entry: {
  eventId: string;
  escrowId: string;
  payer: string;
  amountMsats: number;
  noteKind: "ambient" | "dispute";
}): void {
  const store = loadStore<ArbiterEarningRecord>(ARBITER_EARNINGS_KEY);
  store[entry.eventId] = {
    ...entry,
    status: "redeemed",
    attempts: store[entry.eventId]?.attempts ?? 0,
    updatedAt: Date.now(),
  };
  saveStore(ARBITER_EARNINGS_KEY, store, ARBITER_EARNINGS_MAX);
}

/** Bump the failure counter (never downgrades a redeemed record). */
export function recordEarningAttemptFailed(entry: {
  eventId: string;
  escrowId: string;
  payer: string;
  amountMsats: number;
  noteKind: "ambient" | "dispute";
}): void {
  const store = loadStore<ArbiterEarningRecord>(ARBITER_EARNINGS_KEY);
  const prev = store[entry.eventId];
  if (prev?.status === "redeemed") return;
  store[entry.eventId] = {
    ...entry,
    status: "failed",
    attempts: (prev?.attempts ?? 0) + 1,
    updatedAt: Date.now(),
  };
  saveStore(ARBITER_EARNINGS_KEY, store, ARBITER_EARNINGS_MAX);
}

export interface ArbiterEarningsSummary {
  /** Redeemed premiums only — what actually landed in the wallet. */
  totalMsats: number;
  /** Distinct trades with at least one redeemed premium. */
  tradeCount: number;
  noteCount: number;
}

export function summarizeArbiterEarnings(): ArbiterEarningsSummary {
  const store = loadStore<ArbiterEarningRecord>(ARBITER_EARNINGS_KEY);
  let totalMsats = 0;
  let noteCount = 0;
  const trades = new Set<string>();
  for (const rec of Object.values(store)) {
    if (rec.status !== "redeemed") continue;
    totalMsats += rec.amountMsats;
    noteCount += 1;
    trades.add(rec.escrowId);
  }
  return { totalMsats, tradeCount: trades.size, noteCount };
}

/** Tests + a future advanced-settings action only. */
export function clearArbiterEarningStores(): void {
  try {
    removeScopedStorageItem(PREMIUM_OUTBOX_KEY);
    removeScopedStorageItem(ARBITER_EARNINGS_KEY);
  } catch (e) {
    console.warn("[chama] arbiter-earnings: clear failed:", e);
  }
}
