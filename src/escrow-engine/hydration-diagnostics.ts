// Chama — bounded escrow-hydration diagnostics
//
// Records quantities and timings only: never event content, keys, chat text,
// handles, or ecash. The small ring survives a renderer crash so a subsequent
// session can explain what the last load generation was doing.

export const HYDRATION_DIAGNOSTICS_KEY = "chama_hydration_diagnostics_v1";
export const MAX_HYDRATION_DIAGNOSTICS = 40;

export interface HydrationDiagnostic {
  escrowId: string;
  startedAt: number;
  durationMs: number;
  attempts: number;
  coalescedCallers: number;
  fetchedEvents: number;
  replayEvents: number;
  totalContentBytes: number;
  maxContentBytes: number;
  longestStepMs: number;
  longestStep: string | null;
  heapStartBytes: number | null;
  heapEndBytes: number | null;
  longTasks: number;
  longestTaskMs: number;
  outcome: string;
}

type PerformanceWithMemory = Performance & {
  memory?: { usedJSHeapSize?: number };
};

let observedLongTasks = 0;
let observedLongestTaskMs = 0;
let observerInstalled = false;

function installLongTaskObserver(): void {
  if (observerInstalled) return;
  observerInstalled = true;
  try {
    if (typeof PerformanceObserver === "undefined") return;
    const supported = (PerformanceObserver as typeof PerformanceObserver & {
      supportedEntryTypes?: readonly string[];
    }).supportedEntryTypes;
    if (supported && !supported.includes("longtask")) return;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        observedLongTasks++;
        observedLongestTaskMs = Math.max(observedLongestTaskMs, entry.duration);
      }
    });
    observer.observe({ entryTypes: ["longtask"] });
  } catch {
    // Diagnostics must never affect trade loading.
  }
}

function heapBytes(): number | null {
  try {
    const value = (globalThis.performance as PerformanceWithMemory | undefined)
      ?.memory?.usedJSHeapSize;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function nowMs(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

export function readHydrationDiagnostics(): HydrationDiagnostic[] {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(HYDRATION_DIAGNOSTICS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.slice(-MAX_HYDRATION_DIAGNOSTICS) : [];
  } catch {
    return [];
  }
}

function persistDiagnostic(diagnostic: HydrationDiagnostic): void {
  try {
    const entries = readHydrationDiagnostics();
    const existing = entries.findIndex((entry) =>
      entry.escrowId === diagnostic.escrowId
      && entry.startedAt === diagnostic.startedAt
    );
    if (existing >= 0) entries[existing] = diagnostic;
    else entries.push(diagnostic);
    globalThis.localStorage?.setItem(
      HYDRATION_DIAGNOSTICS_KEY,
      JSON.stringify(entries.slice(-MAX_HYDRATION_DIAGNOSTICS)),
    );
  } catch {
    // Storage may be disabled/full; loading must remain unaffected.
  }
}

export interface HydrationDiagnosticRun {
  coalesced(): void;
  attempt(fetched: Array<{ content?: string }>, replayCount: number): void;
  step(label: string, durationMs: number): void;
  finish(outcome: string): void;
}

export function beginHydrationDiagnostic(escrowId: string): HydrationDiagnosticRun {
  installLongTaskObserver();
  const startedAt = Date.now();
  const started = nowMs();
  const heapStartBytes = heapBytes();
  const longTasksAtStart = observedLongTasks;
  let attempts = 0;
  let coalescedCallers = 0;
  let fetchedEvents = 0;
  let replayEvents = 0;
  let totalContentBytes = 0;
  let maxContentBytes = 0;
  let longestStepMs = 0;
  let longestStep: string | null = null;
  let finished = false;

  const snapshot = (outcome: string) => persistDiagnostic({
    escrowId,
    startedAt,
    durationMs: Math.max(0, nowMs() - started),
    attempts,
    coalescedCallers,
    fetchedEvents,
    replayEvents,
    totalContentBytes,
    maxContentBytes,
    longestStepMs,
    longestStep,
    heapStartBytes,
    heapEndBytes: heapBytes(),
    longTasks: Math.max(0, observedLongTasks - longTasksAtStart),
    longestTaskMs: observedLongTasks > longTasksAtStart ? observedLongestTaskMs : 0,
    outcome,
  });

  // Persist the owner before network/decrypt work begins. If Chrome aborts,
  // the next session sees which generation never reached finish().
  snapshot("in-flight");

  return {
    coalesced() {
      coalescedCallers++;
      snapshot("in-flight");
    },
    attempt(fetched, replayCount) {
      attempts++;
      fetchedEvents += fetched.length;
      replayEvents += replayCount;
      for (const event of fetched) {
        const size = typeof event.content === "string" ? event.content.length : 0;
        totalContentBytes += size;
        maxContentBytes = Math.max(maxContentBytes, size);
      }
      snapshot("in-flight");
    },
    step(label, durationMs) {
      if (durationMs > longestStepMs) {
        longestStepMs = durationMs;
        longestStep = label;
      }
      snapshot("in-flight");
    },
    finish(outcome) {
      if (finished) return;
      finished = true;
      snapshot(outcome);
    },
  };
}
