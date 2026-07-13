// ══════════════════════════════════════════════════════════════════════════
// Chama — Discovery diagnostics (Fedi round 3, INSTRUMENT-FIRST)
// ══════════════════════════════════════════════════════════════════════════
//
// On-device, read-only instrumentation for the "My Trades empty/partial in the
// Fedi webview" defect. Relays are connected and the data is provably present
// on them, yet `discoverMyEscrowIds` returns empty/partial and Refresh×15 does
// nothing. The failure is INSIDE the fetch, in the webview, and we can't see a
// console there — so we surface the last fetch's anatomy on screen.
//
// The single most decisive signal is `resolvedBy`:
//   • eose    + 0 events → every connected relay affirmatively answered "no
//                          events for this filter" → the QUERY KEY is wrong
//                          (candidate 1: a FediSigner that returns the wrong
//                          pubkey). The relays did their job.
//   • timeout + 0 events → REQs went out, no EVENT/EOSE frames came back →
//                          the webview WS message path is throttled/blocked
//                          (candidate 2/3: transport). The key is irrelevant.
//
// A `FetchProbe` is attached to a single `fetchOnce` call. It is PURELY
// observational: it records per-relay REQ/EVENT/EOSE counts and how the fetch
// resolved, and changes no fetch logic. Only discovery (authors ∪ #p) and the
// pubkey-independent `#d` transport control attach a probe; seed-recovery and
// Browse pass none and are untouched.

/** How a probed `fetchOnce` finished. `eose` = every connected relay answered;
 *  `eose-quorum` = a quorum answered and we resolved after a short grace rather
 *  than wait on a hung relay (round 3b step 2); `timeout` = the full budget
 *  elapsed without a quorum (blocked transport). */
export type ResolvedBy = "eose" | "eose-quorum" | "timeout" | "no-relays" | "pending";

/** Per-relay anatomy of one probed fetch. */
export interface RelayProbeRow {
  url: string;
  /** Was this relay CONNECTED at the moment REQs were dispatched? */
  connected: boolean;
  /** Did the REQ frame actually get written to this relay's socket? */
  reqSent: boolean;
  /** EVENT frames this relay delivered for this fetch (pre-dedup — counts
   *  frames received, so a relay that lost the dedup race still shows > 0). */
  events: number;
  /** Did this relay send EOSE for this fetch? */
  eose: boolean;
}

/** Snapshot of one probed `fetchOnce` leg. */
export interface FetchLegDiag {
  /** Human label, e.g. "authored", "tagged", "#d sm_…". */
  label: string;
  /** One-line filter summary, e.g. "authors:65a0c7… kinds:38100-38108". */
  filterSummary: string;
  perRelay: RelayProbeRow[];
  /** Unique events the fetch returned (post-dedup). */
  totalEvents: number;
  resolvedBy: ResolvedBy;
  /** REQ-dispatch → resolution, in ms (includes the quorum wait). */
  elapsedMs: number;
}

/** A full `discoverMyEscrowIds` run: the two legs plus what they produced. */
export interface DiscoveryRunDiag {
  /** Date.now() when the run was recorded. */
  at: number;
  /** The EXACT pubkey (full hex) discovery queried — i.e. what was passed to
   *  discoverMyEscrowIds. Compare against a fresh signer read + the pin. */
  queriedPubkey: string;
  /** [authored leg, tagged leg]. */
  legs: FetchLegDiag[];
  idsDiscovered: number;
  eventsFetched: number;
}

/**
 * One observational probe attached to a single `fetchOnce`. The relay manager
 * calls the `note*` methods; nothing here influences the fetch. Rows are
 * created lazily on first touch so a late relay that delivers a frame without
 * having been seen at dispatch still appears (connected:false, events>0 — a
 * signal in itself).
 */
export class FetchProbe {
  readonly label: string;
  readonly filterSummary: string;
  resolvedBy: ResolvedBy = "pending";
  private readonly rows = new Map<string, RelayProbeRow>();
  private readonly startedAt: number;
  private resolvedAt: number | null = null;

  constructor(label: string, filterSummary: string) {
    this.label = label;
    this.filterSummary = filterSummary;
    this.startedAt = Date.now();
  }

  private row(url: string): RelayProbeRow {
    let r = this.rows.get(url);
    if (!r) {
      r = { url, connected: false, reqSent: false, events: 0, eose: false };
      this.rows.set(url, r);
    }
    return r;
  }

  /** Dispatch-time snapshot: was the relay connected, and did the REQ send? */
  noteDispatch(url: string, connected: boolean, reqSent: boolean): void {
    const r = this.row(url);
    r.connected = connected;
    r.reqSent = reqSent;
  }

  /** An EVENT frame arrived from this relay for the probed fetch. */
  noteEvent(url: string): void {
    this.row(url).events++;
  }

  /** EOSE arrived from this relay for the probed fetch. */
  noteEose(url: string): void {
    this.row(url).eose = true;
  }

  /** Record how the fetch finished (first wins — the resolving event). */
  noteResolved(by: ResolvedBy): void {
    if (this.resolvedBy === "pending") {
      this.resolvedBy = by;
      this.resolvedAt = Date.now();
    }
  }

  /** Freeze into a plain object for the UI. `totalEvents` is the deduped
   *  count the fetch actually returned (authoritative); per-relay `events`
   *  are raw frame counts. */
  snapshot(totalEvents: number): FetchLegDiag {
    return {
      label: this.label,
      filterSummary: this.filterSummary,
      perRelay: [...this.rows.values()],
      totalEvents,
      resolvedBy: this.resolvedBy,
      elapsedMs: (this.resolvedAt ?? Date.now()) - this.startedAt,
    };
  }
}

// ── Last-run store ──────────────────────────────────────────────────────────
// A module-level singleton holding the most recent discovery run, with a tiny
// subscribe so the debug card reflects auto-runs (connect + relay-growth), not
// just button presses.

let lastRun: DiscoveryRunDiag | null = null;
const listeners = new Set<() => void>();

export function recordDiscoveryRun(run: DiscoveryRunDiag): void {
  lastRun = run;
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* a listener throwing must not break discovery */
    }
  }
}

export function getLastDiscoveryRun(): DiscoveryRunDiag | null {
  return lastRun;
}

export function subscribeDiscoveryRun(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// ── Hydrate-path diagnostics (Fedi round 3b) ─────────────────────────────────
// Discovery FINDS the trades (round 3 proved: 15 ids · 73 events on real
// relays, identity + transport clean). They still don't show because
// discoverAndLoadMyTrades hydrates 0 of them. Two ways that happens, and this
// captures which:
//   • skipped-because-known — the id is already in the saved list, so it's
//     filtered out of `fresh` and loadEscrow never re-runs to heal it; its
//     in-memory status is stuck non-terminal/EXPIRED. (Refresh only hydrates
//     NEW ids — it can't re-heal known ones.)
//   • loaded-then-discarded — a fresh id replays partially to CREATED-past-
//     expiry and the expired-unfunded guard deletes it (a real COMPLETED trade
//     eaten off a partial fetch).

export type HydrateClass = "known" | "forgotten" | "fresh";

/** Per-id fate during a hydrate run. */
export interface HydrateIdDiag {
  id: string;
  cls: HydrateClass;
  /** What happened / what we observed:
   *  • fresh   → loadEscrow outcome: "loaded:STATUS", "discarded:expired-
   *              unfunded (was STATUS)", "load-null", "load-failed:…",
   *              or "(over cap — not attempted)".
   *  • known   → "in-memory:STATUS" (snapshot via getState) or
   *              "not-in-memory".
   *  • forgotten → "(forgotten — skipped)". */
  outcome: string;
  /** Whether the observed status is terminal per the engine (COMPLETED /
   *  CANCELLED / EXPIRED — note EXPIRED counts as terminal, which is exactly
   *  why a stuck-EXPIRED known trade never re-heals). */
  terminal?: boolean;
  /** True when the expired-unfunded guard deleted this fresh id. */
  discarded?: boolean;
}

/** One run of discoverAndLoadMyTrades, from discovered ids to hydrate result. */
export interface HydrateRunDiag {
  at: number;
  pubkey: string;
  discovered: number;
  knownCount: number;
  forgottenCount: number;
  freshCount: number;
  /** How many fresh ids actually hydrated (the function's return value). */
  added: number;
  ids: HydrateIdDiag[];
}

let lastHydrate: HydrateRunDiag | null = null;
const hydrateListeners = new Set<() => void>();

export function recordHydrateRun(run: HydrateRunDiag): void {
  lastHydrate = run;
  for (const l of hydrateListeners) {
    try {
      l();
    } catch {
      /* a listener throwing must not break hydration */
    }
  }
}

export function getLastHydrateRun(): HydrateRunDiag | null {
  return lastHydrate;
}

export function subscribeHydrateRun(cb: () => void): () => void {
  hydrateListeners.add(cb);
  return () => {
    hydrateListeners.delete(cb);
  };
}
