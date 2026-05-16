// ══════════════════════════════════════════════════════════════════════════
// Chama — Atomic fund-and-lock orchestrator (v0.3.0 Phase 2)
// ══════════════════════════════════════════════════════════════════════════
//
// Per PHILOSOPHY.md §2.1 Option B: ecash exists only during LOCK→CLAIM.
// The user never sees an intermediate "you have N sats in your Chama"
// surface. v0.3.0 collapses the prior two-step "fund wallet then LOCK"
// into a single atomic flow: tap Fund on a listing → AtomicFundingModal
// generates a BOLT11 invoice for the exact trade amount → user pays from
// any external Lightning wallet → ecash mints into the wallet → LOCK
// fires automatically → the modal auto-closes.
//
// This module is the pure orchestrator (testable without React or a
// running Fedimint). The hook (useEscrow.ts) binds the dependencies
// to the live wallet; the AtomicFundingModal renders phase transitions
// to the user.
//
// ── Phase model ────────────────────────────────────────────────────────
//
// `creating-invoice`     transient — bridge call to mint BOLT11
// `invoice-created`      transient — fires once, hands BOLT11 to the UI
// `awaiting-payment`     polling — balance unchanged from baseline
// `mint-confirming`      polling — balance moved partial; waiting for
//                        federation to credit the rest
// `payment-confirmed`    transient — full threshold met; LOCK next
// `locking`              transient — calling lockAndPublish
// `locked`               TERMINAL — LOCK published, modal closes
// `expired`              TERMINAL — 15-min payment deadline elapsed
// `mint-timeout`         TERMINAL — partial credit got stuck for 60s
// `aborted`              TERMINAL — caller cancelled via AbortSignal
// `lock-failed`          TERMINAL — invoice creation or LOCK threw
//
// The two timeouts are independent (per the v0.3.0 brief Q1 + addition
// #2): paymentDeadline is the wall-clock budget for the user to pay
// (15 minutes — long enough to scan + walk to a different room + open
// Phoenix); mintConfirmTimeout is the additional grace once we see
// SOMETHING land but not the full amount, modeled on the v0.1.62
// claim-watchdog pattern.

// ── Phase types ──────────────────────────────────────────────────────────

/** Phases emitted during the polling loop (a sub-set of the orchestrator's
 *  full phase set). pollForFunding emits these.
 *
 *  v0.5.1: `mint-confirming-slow` is an in-flight hint, not a terminal —
 *  it fires once after `mintSlowWarnMs` of mint-confirming with no further
 *  progress, so the UI can switch from the optimistic "crediting…" copy
 *  to a "federation is slow · keep waiting or cancel" surface. The poll
 *  loop keeps running; only `mint-timeout` (the hard cap) terminates. */
export type FundingPhase =
  | { kind: "awaiting-payment" }
  | { kind: "mint-confirming" }
  | { kind: "mint-confirming-slow" }
  | { kind: "payment-confirmed" }
  | { kind: "expired" }
  | { kind: "mint-timeout" }
  | { kind: "aborted" };

/** Full phase model emitted by runFundAndLock. Includes invoice creation
 *  and lock dispatch in addition to FundingPhase. */
export type FundAndLockPhase =
  | { kind: "creating-invoice" }
  | { kind: "invoice-created"; bolt11: string; expiresAt: number }
  | FundingPhase
  | { kind: "locking" }
  | { kind: "locked" }
  | { kind: "lock-failed"; error: string };

/** Terminal phase kinds — pollForFunding / runFundAndLock resolve to one
 *  of these. */
export type FundingTerminal = Extract<
  FundingPhase,
  { kind: "payment-confirmed" | "expired" | "mint-timeout" | "aborted" }
>;

export type FundAndLockTerminal =
  | { kind: "locked" }
  | { kind: "expired" }
  | { kind: "mint-timeout" }
  | { kind: "aborted" }
  | { kind: "lock-failed"; error: string };

// ── Tunables ─────────────────────────────────────────────────────────────

/** v0.3.0 Q1: 15 minutes. Long enough for scan + walk to another room +
 *  open Phoenix; short enough that abandoned-mid-flow invoices clear. */
export const DEFAULT_PAYMENT_DEADLINE_MS = 15 * 60 * 1000;

/** v0.5.1: 5 minutes. The original 60s grace (v0.3.0) was modeled on
 *  the claim-watchdog cadence, but production smoke on browser Fedimint
 *  (v0.5.0 commit message, "Out of scope" notes) showed real federation
 *  mints regularly take longer than 60s after the gateway acks the
 *  receive — preimage flows back to the payer instantly, but the
 *  multi-guardian mint protocol that actually credits the user's wallet
 *  can take minutes. 60s was too aggressive and killed otherwise-good
 *  trades. The new cap is paired with `DEFAULT_MINT_SLOW_WARN_MS`
 *  (below) which surfaces an honest "still waiting — keep waiting or
 *  cancel" UI well before this hard timeout fires. */
export const DEFAULT_MINT_CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;

/** v0.5.1: 60s into mint-confirming with no further progress, flip
 *  the UI from the optimistic "crediting…" copy to a "federation is
 *  slow — keep waiting or cancel" surface. The poll loop keeps running
 *  until either the threshold lands or the hard `mintConfirmTimeoutMs`
 *  cap fires. Decoupling the soft warn from the hard cap is what
 *  v0.5.0's brief asked for: an explicit wait-vs-cancel choice for the
 *  user, instead of a silent terminal that ate good trades. */
export const DEFAULT_MINT_SLOW_WARN_MS = 60 * 1000;

/** Same cadence as startClaimWatchdog (5s ticks). Keeps the wallet's
 *  Fedimint state consistent across watchdogs. */
export const DEFAULT_POLL_INTERVAL_MS = 5_000;

/** Accept any delta ≥ 90% of expected as "fully landed". Matches
 *  startClaimWatchdog's tolerance — Fedimint settles can have tiny
 *  variance from gateway routing fees, and we'd rather false-positive
 *  a success than false-negative into timeout territory. */
export const DEFAULT_THRESHOLD_PCT = 0.9;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const defaultNow = () => Date.now();

// ── pollForFunding ───────────────────────────────────────────────────────

export interface PollFundingOpts {
  /** Wallet balance in msats just before the invoice was created. The
   *  delta from this baseline is what we're watching for. */
  baselineMsats: number;
  /** Trade amount in msats. Threshold = expectedMsats * thresholdPct. */
  expectedMsats: number;
  /** Async balance reader. Bound to fedimint.getBalance() in the hook. */
  getBalance: () => Promise<number>;
  /** Phase callback — fires once for each transition. */
  onPhase: (phase: FundingPhase) => void;
  /** Caller-controlled abort (modal cancel button, unmount, etc.). */
  signal?: AbortSignal;
  /** Defaults to DEFAULT_PAYMENT_DEADLINE_MS (15 min). */
  paymentDeadlineMs?: number;
  /** Defaults to DEFAULT_MINT_CONFIRM_TIMEOUT_MS (5 min). Hard cap on
   *  how long the orchestrator stays in mint-confirming before
   *  resolving with `mint-timeout`. */
  mintConfirmTimeoutMs?: number;
  /** Defaults to DEFAULT_MINT_SLOW_WARN_MS (60s). Time into
   *  mint-confirming after which `mint-confirming-slow` fires once so
   *  the UI can show the wait-vs-cancel surface. The loop continues
   *  polling until mintConfirmTimeoutMs is reached. */
  mintSlowWarnMs?: number;
  /** Defaults to DEFAULT_POLL_INTERVAL_MS (5s). */
  pollIntervalMs?: number;
  /** Defaults to DEFAULT_THRESHOLD_PCT (0.9). */
  thresholdPct?: number;
  /** Test seam: inject a fast/synchronous sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: inject a synthetic clock. */
  now?: () => number;
}

/** Poll for inbound payment, emitting phases as it goes. Resolves with
 *  the terminal phase. Never rejects — caller branches on the returned
 *  kind to decide what to do next. */
export async function pollForFunding(opts: PollFundingOpts): Promise<FundingTerminal> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? defaultNow;
  const paymentDeadlineMs = opts.paymentDeadlineMs ?? DEFAULT_PAYMENT_DEADLINE_MS;
  const mintConfirmTimeoutMs = opts.mintConfirmTimeoutMs ?? DEFAULT_MINT_CONFIRM_TIMEOUT_MS;
  const mintSlowWarnMs = opts.mintSlowWarnMs ?? DEFAULT_MINT_SLOW_WARN_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const thresholdPct = opts.thresholdPct ?? DEFAULT_THRESHOLD_PCT;
  const requiredDelta = Math.floor(opts.expectedMsats * thresholdPct);

  const start = now();
  let mintStartedAt: number | null = null;
  let inMintPhase = false;
  let slowWarnFired = false;

  // Initial phase fire so the UI immediately reflects "waiting".
  opts.onPhase({ kind: "awaiting-payment" });

  // Loop until terminal.
  while (true) {
    if (opts.signal?.aborted) {
      const result: FundingTerminal = { kind: "aborted" };
      opts.onPhase(result);
      return result;
    }

    // Read balance with defensive try/catch — transient federation
    // hiccups during polling shouldn't crash the orchestrator.
    let balance = opts.baselineMsats;
    try {
      balance = await opts.getBalance();
    } catch {
      // Ignore — next tick will retry.
    }
    const delta = balance - opts.baselineMsats;

    // Full threshold met → done.
    if (delta >= requiredDelta) {
      const result: FundingTerminal = { kind: "payment-confirmed" };
      opts.onPhase(result);
      return result;
    }

    // First evidence of inbound funds → flip to mint-confirming.
    if (delta > 0 && !inMintPhase) {
      inMintPhase = true;
      mintStartedAt = now();
      opts.onPhase({ kind: "mint-confirming" });
    }

    // Timeout checks — evaluated AFTER the threshold check so a
    // last-tick payment that lands exactly at the deadline still
    // succeeds.
    const elapsed = now() - start;
    if (!inMintPhase && elapsed >= paymentDeadlineMs) {
      const result: FundingTerminal = { kind: "expired" };
      opts.onPhase(result);
      return result;
    }
    if (inMintPhase) {
      const mintElapsed = now() - (mintStartedAt ?? start);
      // Soft warn — one-time UI flip so the user knows the federation
      // is slow but we're still waiting. Not a terminal.
      if (!slowWarnFired && mintElapsed >= mintSlowWarnMs) {
        slowWarnFired = true;
        opts.onPhase({ kind: "mint-confirming-slow" });
      }
      // Hard cap — terminal.
      if (mintElapsed >= mintConfirmTimeoutMs) {
        const result: FundingTerminal = { kind: "mint-timeout" };
        opts.onPhase(result);
        return result;
      }
    }

    await sleep(pollIntervalMs);
  }
}

// ── runFundAndLock ───────────────────────────────────────────────────────

export interface RunFundAndLockDeps {
  /** Bound to fedimint.getBalance() in the hook. */
  getBalance: () => Promise<number>;
  /** Bound to actions.createFundingInvoice in the hook. Returns BOLT11. */
  createFundingInvoice: (amountMsats: number, description: string) => Promise<string>;
  /** Bound to actions.lockAndPublish in the hook. */
  lockAndPublish: (escrowId: string, opts: { savedHandleId?: string }) => Promise<unknown>;
}

export interface RunFundAndLockOpts extends RunFundAndLockDeps {
  /** Trade ID being funded. */
  escrowId: string;
  /** Trade amount in msats. */
  amountMsats: number;
  /** Description embedded in the BOLT11 invoice. Shows in the payer's
   *  Lightning wallet — keep readable. */
  description: string;
  /** Optional handle to reveal in the LOCK payload. */
  savedHandleId?: string;
  /** Phase callback. */
  onPhase: (phase: FundAndLockPhase) => void;
  /** Caller-controlled abort. */
  signal?: AbortSignal;
  // Polling tunables (passthrough to pollForFunding).
  paymentDeadlineMs?: number;
  mintConfirmTimeoutMs?: number;
  mintSlowWarnMs?: number;
  pollIntervalMs?: number;
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Compose createFundingInvoice → pollForFunding → lockAndPublish into
 *  one atomic flow. Resolves with the terminal phase. Never rejects.
 *
 *  Callers (the AtomicFundingModal via useEscrow) get phase events for
 *  granular UI updates; the return value is just the terminal kind for
 *  post-modal navigation. */
export async function runFundAndLock(
  opts: RunFundAndLockOpts,
): Promise<FundAndLockTerminal> {
  const emit = (p: FundAndLockPhase) => opts.onPhase(p);

  emit({ kind: "creating-invoice" });
  if (opts.signal?.aborted) {
    const result: FundAndLockTerminal = { kind: "aborted" };
    emit({ kind: "aborted" });
    return result;
  }

  // Snapshot baseline BEFORE creating the invoice. If the user already
  // had ecash from a prior failed flow, the recovery banner should have
  // gated this surface upstream — we proceed defensively, treating the
  // existing balance as baseline so the threshold check measures only
  // the new inbound payment.
  let baseline: number;
  try {
    baseline = await opts.getBalance();
  } catch (e: any) {
    const err = e?.message || "Couldn't read wallet balance";
    emit({ kind: "lock-failed", error: err });
    return { kind: "lock-failed", error: err };
  }

  let bolt11: string;
  try {
    bolt11 = await opts.createFundingInvoice(opts.amountMsats, opts.description);
  } catch (e: any) {
    const err = e?.message || "Couldn't create funding invoice";
    emit({ kind: "lock-failed", error: err });
    return { kind: "lock-failed", error: err };
  }
  const expiresAt = (opts.now ?? defaultNow)() +
    (opts.paymentDeadlineMs ?? DEFAULT_PAYMENT_DEADLINE_MS);
  emit({ kind: "invoice-created", bolt11, expiresAt });

  const polled = await pollForFunding({
    baselineMsats: baseline,
    expectedMsats: opts.amountMsats,
    getBalance: opts.getBalance,
    onPhase: emit,
    signal: opts.signal,
    paymentDeadlineMs: opts.paymentDeadlineMs,
    mintConfirmTimeoutMs: opts.mintConfirmTimeoutMs,
    mintSlowWarnMs: opts.mintSlowWarnMs,
    pollIntervalMs: opts.pollIntervalMs,
    sleep: opts.sleep,
    now: opts.now,
  });

  if (polled.kind !== "payment-confirmed") {
    return polled;
  }

  emit({ kind: "locking" });
  if (opts.signal?.aborted) {
    emit({ kind: "aborted" });
    return { kind: "aborted" };
  }

  try {
    await opts.lockAndPublish(opts.escrowId, { savedHandleId: opts.savedHandleId });
    emit({ kind: "locked" });
    return { kind: "locked" };
  } catch (e: any) {
    const err = e?.message || "LOCK failed";
    emit({ kind: "lock-failed", error: err });
    return { kind: "lock-failed", error: err };
  }
}
