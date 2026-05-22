// ══════════════════════════════════════════════════════════════════════════
// Chama — Atomic claim-and-payout orchestrator (v0.3.0 Phase 3)
// ══════════════════════════════════════════════════════════════════════════
//
// Per PHILOSOPHY.md §2.7: claim time is when the user provides a destination
// to receive sats. v0.3.0 collapses the prior two-step "claim then withdraw"
// into a single atomic flow: tap Claim → DestinationPicker presents saved
// LN handles + new-address input + BOLT11 paste → user picks destination
// → claimAndPayout dispatches decrypt-shares → SSS-combine → redeemEcash
// → outbound LN payment → modal closes. The user never holds an
// intermediate balance (Pillar 2.1 Option B, send side).
//
// This module is the pure orchestrator (testable without React or a
// running Fedimint). The hook (useEscrow.ts) binds the dependencies
// to the live wallet; the ClaimPayoutModal renders phase transitions
// to the user.
//
// ── Phase model ────────────────────────────────────────────────────────
//
// `claiming`         transient — bridge.claimAndRedeem call (decrypt
//                    shares, SSS-combine, redeem ecash, publish CLAIM)
// `confirming`       polling — waiting for balance to land. Same
//                    v0.1.62 watchdog principle as Phase 2's mint-
//                    confirming: claimAndRedeem may return before the
//                    balance fully settles (partial-success / transient
//                    error paths). We poll up to a 60s grace before
//                    declaring "claim-pending".
// `paying-invoice`   transient — outbound LN to the user's destination
// `done`             TERMINAL — payout sent, optional handle saved
// `claim-failed`     TERMINAL — claim threw a HARD failure (bad shares,
//                    not the winner, hash mismatch). No orphan, no
//                    retry semantic. User cannot recover from this
//                    without protocol-level repair.
// `claim-bridge-threw` TERMINAL — claim threw a typed bridge error
//                    (FED_PROBE_FAILED, FED_MISMATCH). Structural,
//                    retry-able once the federation becomes reachable
//                    or the user switches feds. No orphan (the bridge
//                    bails before any redeem or CLAIM publish). User
//                    sees the underlying error + a Try-again button
//                    in the modal that re-probes before re-dispatch.
//                    v0.3.1 fix: previously this case silently fell
//                    through to claim-pending, hanging the user with
//                    "your sats are still arriving" while nothing was
//                    actually arriving.
// `claim-pending`    TERMINAL — claim returned (no throw) but balance
//                    hasn't landed within 60s. Genuinely in-flight —
//                    sats may still arrive from the federation. The
//                    pending-redemption stash stays intact so boot can
//                    retry redeeming the notes; if balance later lands
//                    but payout does not, the recovery banner takes over.
//                    RESERVED for the no-throw / balance-stalled case
//                    ONLY. A post-CLAIM terminal mint reissue failure
//                    routes to claim-failed so we do not invite retries
//                    against already-consumed notes.
// `payout-failed`    TERMINAL — claim succeeded, balance landed, but
//                    payInvoice threw. ORPHAN balance — the recovery
//                    banner catches it.
//
// The four-way split lets the modal surface UX that matches reality:
// `claim-bridge-threw` shows the actual error + retry; `claim-pending`
// shows "still arriving" reassurance; `claim-failed` shows terminal
// no-recovery framing; `payout-failed` points at the recovery banner.

// ── Phase types ──────────────────────────────────────────────────────────

export type ClaimAndPayoutPhase =
  | { kind: "claiming" }
  | { kind: "confirming" }
  | { kind: "paying-invoice" }
  | { kind: "done" }
  | { kind: "claim-failed"; error: string }
  | { kind: "claim-bridge-threw"; error: string }
  | { kind: "claim-pending"; error: string }
  | { kind: "payout-failed"; error: string };

export type ClaimAndPayoutTerminal =
  | { kind: "done" }
  | { kind: "claim-failed"; error: string }
  | { kind: "claim-bridge-threw"; error: string }
  | { kind: "claim-pending"; error: string }
  | { kind: "payout-failed"; error: string };

/** Error codes the bridge tags on typed retry-able failures. Defined
 *  alongside the orchestrator so test mocks + downstream consumers
 *  reference the same string source-of-truth. */
export const BRIDGE_THREW_ERROR_CODES = ["FED_PROBE_FAILED", "FED_MISMATCH"] as const;
export type BridgeThrewErrorCode = typeof BRIDGE_THREW_ERROR_CODES[number];

function isBridgeThrewError(e: unknown): e is { code: BridgeThrewErrorCode; message: string } {
  const code = (e as { code?: string } | null)?.code;
  return typeof code === "string" && (BRIDGE_THREW_ERROR_CODES as readonly string[]).includes(code);
}

// ── Tunables ─────────────────────────────────────────────────────────────

/** v0.1.62 watchdog: 60s grace for the federation to credit the user's
 *  wallet after CLAIM publishes. Mirrors the claim-side timeout in
 *  Phase 2's pollForFunding (mint-confirm). */
export const DEFAULT_CONFIRM_TIMEOUT_MS = 60 * 1000;

/** Same cadence as the existing claim watchdog and Phase 2. */
export const DEFAULT_POLL_INTERVAL_MS = 5_000;

/** Accept any delta ≥ 90% of expected as "fully landed". Matches the
 *  Fedimint settlement tolerance baked into startClaimWatchdog. */
export const DEFAULT_THRESHOLD_PCT = 0.9;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const defaultNow = () => Date.now();

function moneyDebugEnabled(): boolean {
  try {
    return typeof localStorage !== "undefined"
      && localStorage.getItem("chama_debug_money") !== null;
  } catch {
    return false;
  }
}

function moneyLog(checkpoint: string, fields: Record<string, unknown>): void {
  if (!moneyDebugEnabled()) return;
  const parts: string[] = [`[$$] ${checkpoint}`];
  for (const [k, v] of Object.entries(fields)) {
    let val: string;
    if (v === undefined) val = "undef";
    else if (v === null) val = "null";
    else if (typeof v === "string") val = v.length > 64 ? `${v.slice(0, 60)}...(${v.length})` : v;
    else if (typeof v === "number" || typeof v === "boolean") val = String(v);
    else val = JSON.stringify(v).slice(0, 80);
    parts.push(`${k}=${val}`);
  }
  // eslint-disable-next-line no-console
  console.info(parts.join(" "));
}

function claimTrace(checkpoint: string, fields: Record<string, unknown>): void {
  if (!moneyDebugEnabled()) return;
  const parts: string[] = [`[claim-trace] ${checkpoint}`];
  for (const [k, v] of Object.entries(fields)) {
    let val: string;
    if (v === undefined) val = "undef";
    else if (v === null) val = "null";
    else if (typeof v === "string") val = v.length > 64 ? `${v.slice(0, 60)}...(${v.length})` : v;
    else if (typeof v === "number" || typeof v === "boolean") val = String(v);
    else val = JSON.stringify(v).slice(0, 80);
    parts.push(`${k}=${val}`);
  }
  // eslint-disable-next-line no-console
  console.info(parts.join(" "));
}

function errorMessage(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "string" && e) return e;
  if (
    e &&
    typeof e === "object" &&
    typeof (e as { message?: unknown }).message === "string" &&
    (e as { message: string }).message
  ) {
    return (e as { message: string }).message;
  }
  return fallback;
}

// ── waitForBalanceGrowth ─────────────────────────────────────────────────

export interface WaitForBalanceGrowthOpts {
  debugId?: string;
  baselineMsats: number;
  expectedDeltaMsats: number;
  getBalance: () => Promise<number>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  thresholdPct?: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Poll the wallet balance until it grows by ≥ thresholdPct * expected,
 *  or the timeout elapses, or the signal aborts. Resolves with the
 *  outcome — never throws. Used as the "claim-confirming" loop in
 *  runClaimAndPayout. */
export async function waitForBalanceGrowth(
  opts: WaitForBalanceGrowthOpts,
): Promise<"grew" | "timeout" | "aborted"> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? defaultNow;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const thresholdPct = opts.thresholdPct ?? DEFAULT_THRESHOLD_PCT;
  const requiredDelta = Math.floor(opts.expectedDeltaMsats * thresholdPct);
  const start = now();
  let polls = 0;

  while (true) {
    if (opts.signal?.aborted) return "aborted";
    polls++;
    let balance = opts.baselineMsats;
    let balanceReadOk = true;
    try {
      balance = await opts.getBalance();
    } catch {
      balanceReadOk = false;
      // Transient federation hiccups during polling — retry on next tick.
    }
    const elapsedMs = now() - start;
    const delta = balance - opts.baselineMsats;
    const grew = delta >= requiredDelta;
    moneyLog("CLAIM-WAIT", {
      escrowId: opts.debugId,
      poll: polls,
      balanceReadOk,
      balance,
      baseline: opts.baselineMsats,
      delta,
      requiredDelta,
      elapsedMs,
      result: grew ? "grew" : "waiting",
    });
    claimTrace("orchestrator-balance-poll", {
      escrowId: opts.debugId,
      poll: polls,
      balanceReadOk,
      balance,
      baseline: opts.baselineMsats,
      delta,
      requiredDelta,
      elapsedMs,
      result: grew ? "grew" : "waiting",
    });
    if (grew) return "grew";
    if (elapsedMs >= timeoutMs) {
      moneyLog("CLAIM-WAIT", {
        escrowId: opts.debugId,
        poll: polls,
        delta,
        requiredDelta,
        elapsedMs,
        result: "timeout",
      });
      claimTrace("orchestrator-balance-timeout", {
        escrowId: opts.debugId,
        poll: polls,
        delta,
        requiredDelta,
        elapsedMs,
      });
      return "timeout";
    }
    await sleep(pollIntervalMs);
  }
}

// ── runClaimAndPayout ────────────────────────────────────────────────────

export interface RunClaimAndPayoutDeps {
  /** Bound to fedimint.getBalance() in the hook. */
  getBalance: () => Promise<number>;
  /** Bound to the raw bridge claim path (decrypt + SSS + publish CLAIM
   *  + redeem). May resolve before balance has fully settled — the
   *  orchestrator polls separately to handle the watchdog case. */
  claimAndRedeem: (escrowId: string) => Promise<unknown>;
  /** Bound to bridge.payInvoice. Outbound Lightning send. */
  payInvoice: (bolt11: string) => Promise<void>;
  /** Publish escrow COMPLETE after the wallet balance has actually
   *  confirmed. Best-effort: failure must not block payout/recovery. */
  completeClaim?: (escrowId: string) => Promise<void>;
  /** Clear the crash-recovery OOB note stash after balance growth proves
   *  the redeem landed locally. Atomic claim+payout keeps the stash until
   *  this point so a claim-pending timeout can be retried on next boot. */
  clearPendingRedemption?: (escrowId: string) => void;
  /** Bound to addOrTouchLightningHandle. Best-effort post-success save. */
  addOrTouchLightningHandle: (address: string) => void;
}

export interface RunClaimAndPayoutOpts extends RunClaimAndPayoutDeps {
  escrowId: string;
  /** BOLT11 invoice the user's destination resolved to. */
  bolt11: string;
  /** Expected post-fee payout in msats. The wallet's balance after CLAIM
   *  should grow by this much, give or take 10% threshold tolerance. */
  expectedDeltaMsats: number;
  /** Whether to call addOrTouchLightningHandle on success. Set by the
   *  DestinationPicker — true when user tapped a saved row OR typed an
   *  address with the "Save for next time" toggle on. */
  saveAfter: boolean;
  /** The Lightning Address to save (if saveAfter). Unset for BOLT11
   *  paste — there's no address to save. */
  addressUsed?: string;

  onPhase: (phase: ClaimAndPayoutPhase) => void;

  // Polling tunables.
  confirmTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Compose claimAndRedeem → balance-confirm → payInvoice → optional
 *  handle-save into one atomic flow. Resolves with the terminal phase.
 *  Never rejects.
 *
 *  Failure modes are split so the recovery banner UX is clean:
 *   - claim-failed: claim threw HARD; balance unchanged; no orphan
 *   - claim-pending: claim returned but balance never landed in 60s;
 *     keep pending-redemption stash so boot can retry the redeem
 *   - payout-failed: claim landed (balance grew), but Lightning send
 *     failed; CONFIRMED orphan — recovery banner is the next stop */
export async function runClaimAndPayout(
  opts: RunClaimAndPayoutOpts,
): Promise<ClaimAndPayoutTerminal> {
  const emit = (p: ClaimAndPayoutPhase) => opts.onPhase(p);

  // Snapshot baseline before we dispatch anything. The polling phase
  // measures growth from here.
  let baseline: number;
  try {
    baseline = await opts.getBalance();
  } catch (e: any) {
    const error = errorMessage(e, "Couldn't read wallet balance");
    emit({ kind: "claim-failed", error });
    return { kind: "claim-failed", error };
  }
  moneyLog("CLAIM-BASELINE", {
    escrowId: opts.escrowId,
    baseline,
    expectedDeltaMsats: opts.expectedDeltaMsats,
  });
  claimTrace("orchestrator-baseline", {
    escrowId: opts.escrowId,
    baseline,
    expectedDeltaMsats: opts.expectedDeltaMsats,
  });

  // Phase 1: claim. Decrypt shares, SSS-combine, redeem ecash, publish
  // CLAIM. May resolve via:
  //   - synchronous success (balance already grew)
  //   - watchdog success (balance grows during polling)
  //   - hard failure (throws non-bridge error — surfaced as claim-failed)
  //   - typed bridge error (throws with code FED_PROBE_FAILED or
  //     FED_MISMATCH — surfaced as claim-bridge-threw, retry-able)
  emit({ kind: "claiming" });
  try {
    await opts.claimAndRedeem(opts.escrowId);
    claimTrace("orchestrator-claim-returned", {
      escrowId: opts.escrowId,
    });
  } catch (e: any) {
    const error = errorMessage(e, "Claim failed");
    // v0.3.1 Phase 1: typed bridge errors get their own retry-able
    // terminal. Discrimination is on e.code (the bridge tags
    // FED_PROBE_FAILED + FED_MISMATCH at throw sites in
    // escrow-bridge.ts). Other throws — hard claim failures, generic
    // protocol errors — stay on claim-failed (no retry semantic).
    if (isBridgeThrewError(e)) {
      claimTrace("orchestrator-claim-bridge-threw", {
        escrowId: opts.escrowId,
        errMsg: error.slice(0, 120),
      });
      emit({ kind: "claim-bridge-threw", error });
      return { kind: "claim-bridge-threw", error };
    }
    // CLAIM already hit relays, but the SDK has reported a terminal mint
    // reissue failure. Do not fall through to the comforting "still
    // arriving" copy: repeating the same consumed notes cannot help.
    if (e?.claimPublished && e?.settlementFailed) {
      claimTrace("orchestrator-claim-settle-failed", {
        escrowId: opts.escrowId,
        errMsg: error.slice(0, 120),
      });
      emit({ kind: "claim-failed", error });
      return { kind: "claim-failed", error };
    }

    // CLAIM already hit relays, but redeem/balance settlement is still
    // uncertain. This is not a hard claim failure; continue into the
    // balance-confirming watchdog. If the balance lands, payout proceeds.
    // If it does not, the terminal remains claim-pending.
    if (e?.claimPublished) {
      moneyLog("CLAIM-PUBLISHED-THROW", {
        escrowId: opts.escrowId,
        errMsg: error.slice(0, 120),
      });
      claimTrace("orchestrator-claim-published-throw", {
        escrowId: opts.escrowId,
        errMsg: error.slice(0, 120),
      });
      // Fall through to confirming below.
    } else {
      claimTrace("orchestrator-claim-failed", {
        escrowId: opts.escrowId,
        errMsg: error.slice(0, 120),
      });
      emit({ kind: "claim-failed", error });
      return { kind: "claim-failed", error };
    }
  }

  // Phase 2: confirm balance landed. Poll for up to confirmTimeoutMs.
  // This handles BOTH the synchronous-success case (poll sees grown
  // balance immediately on first read) and the watchdog case (poll
  // waits while the federation settles).
  emit({ kind: "confirming" });
  const grew = await waitForBalanceGrowth({
    debugId: opts.escrowId,
    baselineMsats: baseline,
    expectedDeltaMsats: opts.expectedDeltaMsats,
    getBalance: opts.getBalance,
    timeoutMs: opts.confirmTimeoutMs,
    pollIntervalMs: opts.pollIntervalMs,
    sleep: opts.sleep,
    now: opts.now,
  });
  moneyLog("CLAIM-CONFIRM-OUT", {
    escrowId: opts.escrowId,
    result: grew,
  });
  claimTrace("orchestrator-confirm-out", {
    escrowId: opts.escrowId,
    result: grew,
  });
  if (grew !== "grew") {
    const error =
      "Your sats are still arriving from the federation. They'll land shortly. If this trade stays settling, try the claim again.";
    emit({ kind: "claim-pending", error });
    return { kind: "claim-pending", error };
  }

  if (opts.clearPendingRedemption) {
    try {
      opts.clearPendingRedemption(opts.escrowId);
      moneyLog("CLAIM-STASH-CLEAR", {
        escrowId: opts.escrowId,
        result: "success",
      });
      claimTrace("orchestrator-stash-clear", {
        escrowId: opts.escrowId,
        result: "success",
      });
    } catch (e: any) {
      moneyLog("CLAIM-STASH-CLEAR", {
        escrowId: opts.escrowId,
        result: "error",
        errMsg: (e?.message || String(e)).slice(0, 120),
      });
      claimTrace("orchestrator-stash-clear", {
        escrowId: opts.escrowId,
        result: "error",
        errMsg: (e?.message || String(e)).slice(0, 120),
      });
    }
  }

  // COMPLETE is a statement that the escrow sats are under the winner's
  // control. Publish it only after balance growth confirms that reality.
  // If the relay publish fails, the money path still continues; the
  // trade can be healed manually/retried later without blocking payout.
  if (opts.completeClaim) {
    try {
      moneyLog("CLAIM-COMPLETE-IN", {
        escrowId: opts.escrowId,
      });
      claimTrace("orchestrator-complete-in", {
        escrowId: opts.escrowId,
      });
      await opts.completeClaim(opts.escrowId);
      moneyLog("CLAIM-COMPLETE-OUT", {
        escrowId: opts.escrowId,
        result: "success",
      });
      claimTrace("orchestrator-complete-out", {
        escrowId: opts.escrowId,
        result: "success",
      });
    } catch (e: any) {
      moneyLog("CLAIM-COMPLETE-OUT", {
        escrowId: opts.escrowId,
        result: "error",
        errMsg: (e?.message || String(e)).slice(0, 120),
      });
      claimTrace("orchestrator-complete-out", {
        escrowId: opts.escrowId,
        result: "error",
        errMsg: (e?.message || String(e)).slice(0, 120),
      });
      // Advisory protocol event only; money movement already confirmed.
    }
  }

  // Phase 3: outbound Lightning. Pay the user's destination invoice.
  // If this throws, the balance is now orphaned in the user's Chama —
  // recovery banner is the next stop.
  emit({ kind: "paying-invoice" });
  try {
    moneyLog("CLAIM-PAY-IN", {
      escrowId: opts.escrowId,
      invoicePrefix: opts.bolt11.slice(0, 24),
    });
    claimTrace("orchestrator-pay-in", {
      escrowId: opts.escrowId,
      invoicePrefix: opts.bolt11.slice(0, 24),
    });
    await opts.payInvoice(opts.bolt11);
  } catch (e: any) {
    const error = errorMessage(e, "Lightning payment failed");
    moneyLog("CLAIM-PAY-OUT", {
      escrowId: opts.escrowId,
      result: "error",
      errMsg: error.slice(0, 120),
    });
    claimTrace("orchestrator-pay-out", {
      escrowId: opts.escrowId,
      result: "error",
      errMsg: error.slice(0, 120),
    });
    emit({ kind: "payout-failed", error });
    return { kind: "payout-failed", error };
  }
  moneyLog("CLAIM-PAY-OUT", {
    escrowId: opts.escrowId,
    result: "success",
  });
  claimTrace("orchestrator-pay-out", {
    escrowId: opts.escrowId,
    result: "success",
  });

  // Phase 4: best-effort handle save. Failures here are cosmetic —
  // the payout already succeeded.
  if (opts.saveAfter && opts.addressUsed) {
    try {
      opts.addOrTouchLightningHandle(opts.addressUsed);
    } catch {
      // ignore
    }
  }

  emit({ kind: "done" });
  moneyLog("CLAIM-DONE", {
    escrowId: opts.escrowId,
  });
  claimTrace("orchestrator-done", {
    escrowId: opts.escrowId,
  });
  return { kind: "done" };
}
