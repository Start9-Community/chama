// ══════════════════════════════════════════════════════════════════════════
// Chama — Payout Destinations (localStorage)
// ══════════════════════════════════════════════════════════════════════════
//
// Payout destinations are where the user sends sats after a claim or
// recovery. They are NOT counterparty payment handles and must never flow
// into listing/payment-handle reveal surfaces.
//
// Storage format (localStorage["chama_payout_destinations[:pubkey]"] is JSON):
//   [{ id, address, createdAt, lastUsedAt }, ...]

import { SAVED_HANDLES_STORAGE_KEY, LIGHTNING_RAIL, type SavedHandle } from "./saved-handles.js";
import {
  getScopedStorageItem,
  setScopedStorageItem,
} from "../storage/user-scope.js";

export const PAYOUT_DESTINATIONS_STORAGE_KEY = "chama_payout_destinations";

export interface PayoutDestination {
  id: string;
  /** Lightning Address, normalized lowercase. */
  address: string;
  /** Unix seconds — first saved. */
  createdAt: number;
  /** Unix seconds — last successful claim/recovery use. */
  lastUsedAt?: number;
}

function isPayoutDestination(x: any): x is PayoutDestination {
  return (
    x && typeof x === "object" &&
    typeof x.id === "string" &&
    typeof x.address === "string" &&
    typeof x.createdAt === "number"
  );
}

function isLegacyLightningHandle(x: any): x is SavedHandle {
  return (
    x && typeof x === "object" &&
    typeof x.id === "string" &&
    x.rail === LIGHTNING_RAIL &&
    typeof x.handle === "string" &&
    typeof x.createdAt === "number"
  );
}

function generateId(): string {
  return `pd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function readRaw(): PayoutDestination[] {
  try {
    const raw = getScopedStorageItem(PAYOUT_DESTINATIONS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPayoutDestination);
  } catch {
    return [];
  }
}

function writeRaw(destinations: PayoutDestination[]): void {
  try {
    setScopedStorageItem(PAYOUT_DESTINATIONS_STORAGE_KEY, JSON.stringify(destinations));
  } catch {
    // localStorage unavailable / quota exceeded — cosmetic persistence
    // failure. The payout itself has already happened.
  }
}

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

/** One-time lazy migration from pre-v0.6.3 saved_handles rows where
 *  rail="lightning". After migration, the legacy rows are removed so
 *  trade-time handle reveal cannot accidentally offer a payout address. */
export function migrateLegacyLightningHandles(): number {
  try {
    const raw = getScopedStorageItem(SAVED_HANDLES_STORAGE_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return 0;

    const existing = readRaw();
    const seen = new Set(existing.map(d => d.address.toLowerCase()));
    const migrated: PayoutDestination[] = [];
    const keptHandles: unknown[] = [];

    for (const item of parsed) {
      if (!isLegacyLightningHandle(item)) {
        keptHandles.push(item);
        continue;
      }
      const address = normalizeAddress(item.handle);
      if (!address) continue;
      if (!seen.has(address)) {
        seen.add(address);
        migrated.push({
          id: `pd_${item.id}`,
          address,
          createdAt: item.createdAt,
          lastUsedAt: item.lastUsedAt ?? item.createdAt,
        });
      }
    }

    if (migrated.length === 0 && keptHandles.length === parsed.length) return 0;
    writeRaw([...migrated, ...existing]);
    setScopedStorageItem(SAVED_HANDLES_STORAGE_KEY, JSON.stringify(keptHandles));
    return migrated.length;
  } catch {
    return 0;
  }
}

export function listPayoutDestinations(): PayoutDestination[] {
  migrateLegacyLightningHandles();
  return readRaw().sort((a, b) => {
    const aTime = a.lastUsedAt ?? a.createdAt;
    const bTime = b.lastUsedAt ?? b.createdAt;
    return bTime - aTime;
  });
}

export function deletePayoutDestination(id: string): void {
  migrateLegacyLightningHandles();
  writeRaw(readRaw().filter(d => d.id !== id));
}

/** Idempotent save/touch for a Lightning Address used as a payout
 *  destination. First use creates a row; later uses bump lastUsedAt. */
export function addOrTouchPayoutDestination(address: string): PayoutDestination {
  const normalized = normalizeAddress(address);
  if (!normalized) {
    throw new Error("Lightning Address cannot be empty");
  }

  migrateLegacyLightningHandles();
  const destinations = readRaw();
  const nowSec = Math.floor(Date.now() / 1000);
  const idx = destinations.findIndex(d => d.address.toLowerCase() === normalized);
  if (idx !== -1) {
    const next: PayoutDestination = { ...destinations[idx], lastUsedAt: nowSec };
    destinations[idx] = next;
    writeRaw(destinations);
    return next;
  }

  const entry: PayoutDestination = {
    id: generateId(),
    address: normalized,
    createdAt: nowSec,
    lastUsedAt: nowSec,
  };
  writeRaw([entry, ...destinations]);
  return entry;
}
