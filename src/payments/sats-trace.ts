// ══════════════════════════════════════════════════════════════════════════
// Chama — Local sats provenance trace
// ══════════════════════════════════════════════════════════════════════════
//
// Fedimint ecash is bearer cash. The SDK can attach `extra_meta` to the
// underlying mint/lightning operations, but the UI also needs a durable,
// per-npub local label for any OPFS balance that survives a trade flow.
// This store is intentionally small and local: it is not a source of
// funds, only an audit trail that answers "why does this wallet still
// have sats?" for the user and for debugging.

import {
  getScopedStorageItem,
  setScopedStorageItem,
} from "../storage/user-scope.js";
import { randomId } from "../storage/random-id.js";

export const SATS_TRACE_STORAGE_KEY = "chama_sats_trace_v1";

export type SatsTraceSource = "funding" | "claim" | "recovery";
export type SatsTraceStatus = "open" | "drained";

export type ChamaOperationMetaValue = string | number | boolean | null;
export type ChamaOperationMeta = Record<string, ChamaOperationMetaValue>;

export interface SatsTraceEntry {
  id: string;
  source: SatsTraceSource;
  status: SatsTraceStatus;
  escrowId?: string;
  amountMsats?: number;
  balanceMsats?: number;
  notesHashPrefix?: string;
  reason?: string;
  operationIds?: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function isTraceEntry(x: any): x is SatsTraceEntry {
  return (
    x && typeof x === "object" &&
    typeof x.id === "string" &&
    (x.source === "funding" || x.source === "claim" || x.source === "recovery") &&
    (x.status === "open" || x.status === "drained") &&
    typeof x.createdAt === "number" &&
    typeof x.updatedAt === "number"
  );
}

function readRaw(): SatsTraceEntry[] {
  try {
    const raw = getScopedStorageItem(SATS_TRACE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isTraceEntry);
  } catch {
    return [];
  }
}

function writeRaw(entries: SatsTraceEntry[]): void {
  try {
    const trimmed = [...entries]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 40);
    setScopedStorageItem(SATS_TRACE_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Best-effort audit trail only. Never block money movement.
  }
}

function makeTraceId(source: SatsTraceSource, escrowId?: string): string {
  // SECURITY: when there's no escrowId to scope the trace, use crypto
  // randomness for the basis so a same-device script cannot predict
  // trace IDs and read another user's trail off shared storage.
  const basis = escrowId ? escrowId.slice(0, 18) : randomId(8);
  return `sat_${source}_${basis}_${Date.now().toString(36)}`;
}

function mergeOperationIds(
  current: Record<string, string> | undefined,
  incoming: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const merged = { ...(current ?? {}), ...(incoming ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function listSatsTraces(): SatsTraceEntry[] {
  return readRaw().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function listOpenSatsTraces(): SatsTraceEntry[] {
  return listSatsTraces().filter(e => e.status === "open");
}

export function recordSatsTrace(input: {
  source: SatsTraceSource;
  escrowId?: string;
  amountMsats?: number;
  balanceMsats?: number;
  notesHashPrefix?: string;
  reason?: string;
  operationIds?: Record<string, string>;
  status?: SatsTraceStatus;
}): SatsTraceEntry {
  const entries = readRaw();
  const ts = nowSec();
  const idx = entries.findIndex(e =>
    e.status === "open" &&
    e.source === input.source &&
    (input.escrowId ? e.escrowId === input.escrowId : !e.escrowId)
  );

  const existing = idx >= 0 ? entries[idx] : null;
  const next: SatsTraceEntry = {
    id: existing?.id ?? makeTraceId(input.source, input.escrowId),
    source: input.source,
    status: input.status ?? existing?.status ?? "open",
    escrowId: input.escrowId ?? existing?.escrowId,
    amountMsats: input.amountMsats ?? existing?.amountMsats,
    balanceMsats: input.balanceMsats ?? existing?.balanceMsats,
    notesHashPrefix: input.notesHashPrefix ?? existing?.notesHashPrefix,
    reason: input.reason ?? existing?.reason,
    operationIds: mergeOperationIds(existing?.operationIds, input.operationIds),
    createdAt: existing?.createdAt ?? ts,
    updatedAt: ts,
  };

  if (idx >= 0) entries[idx] = next;
  else entries.push(next);
  writeRaw(entries);
  return next;
}

export function markSatsTracesDrained(reason = "balance-drained"): void {
  const entries = readRaw();
  const ts = nowSec();
  let changed = false;
  const next = entries.map(e => {
    if (e.status !== "open") return e;
    changed = true;
    return { ...e, status: "drained" as const, reason, balanceMsats: 0, updatedAt: ts };
  });
  if (changed) writeRaw(next);
}

export function getBestSatsTrace(balanceMsats: number): SatsTraceEntry | null {
  if (Math.floor(Math.max(0, balanceMsats) / 1000) <= 0) return null;
  const open = listOpenSatsTraces();
  return open[0] ?? null;
}

export function describeSatsTrace(trace: SatsTraceEntry | null): string | null {
  if (!trace) return null;
  const trade = trace.escrowId ? `trade ${trace.escrowId.slice(0, 10)}` : "an unknown trade";
  if (trace.source === "claim") return `Left over from your claim on ${trade}.`;
  if (trace.source === "funding") return `Left over from funding ${trade}.`;
  return trace.escrowId
    ? `Recovery balance tied to ${trade}.`
    : "Recovery balance from a previous local Chama payout.";
}

export function buildChamaOperationMeta(input: {
  flow: string;
  escrowId?: string;
  amountMsats?: number;
  notesHashPrefix?: string;
  reason?: string;
}): ChamaOperationMeta {
  const meta: ChamaOperationMeta = {
    chama_app: "chama",
    chama_flow: input.flow,
  };
  if (input.escrowId) meta.chama_escrow_id = input.escrowId;
  if (typeof input.amountMsats === "number") meta.chama_amount_msats = Math.floor(input.amountMsats);
  if (input.notesHashPrefix) meta.chama_notes_hash_prefix = input.notesHashPrefix;
  if (input.reason) meta.chama_reason = input.reason;
  return meta;
}
