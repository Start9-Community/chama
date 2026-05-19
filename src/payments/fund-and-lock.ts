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
// `mint-confirming`      polling — receive-watch saw gateway funding or
//                        balance moved partial; waiting for federation
//                        to credit the wallet
// `payment-confirmed`    transient — full threshold met; LOCK next
// `locking`              transient — calling lockAndPublish
// `locked`               TERMINAL — LOCK published, modal closes
// `expired`              TERMINAL — 15-min payment deadline elapsed
// `mint-timeout`         TERMINAL — gateway/partial credit got stuck
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
 *  and lock dispatch in addition to FundingPhase.
 *  v0.6.5: `creating-invoice-slow` fires when invoice creation has been
 *  in flight for more than DEFAULT_INVOICE_SLOW_WARN_MS without
 *  resolving — typically because the federation's WebSocket transport
 *  is flaky and the gateway-lookup call is hanging. The poll loop
 *  keeps trying until the hard timeout (DEFAULT_INVOICE_TIMEOUT_MS)
 *  fires. */
export type FundAndLockPhase =
  | { kind: "creating-invoice" }
  | { kind: "creating-invoice-slow" }
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

/** v0.6.5: hard cap on createFundingInvoice. The Fedimint WASM
 *  client's gateway-lookup + invoice-create chain can hang silently
 *  when the federation's WebSocket transport is unreliable (see the
 *  iroh-canary failure spam in cold-start reports). Without a cap the
 *  modal sits forever on the small "GENERATING INVOICE…" spinner with
 *  no QR and no error — a black-hole UX. 45s is generous enough for a
 *  warm federation while still failing fast on a broken one. */
export const DEFAULT_INVOICE_TIMEOUT_MS = 45_000;

/** v0.6.5: at 10s into invoice creation, flip the modal to a
 *  "creating-invoice-slow" surface so the user sees we're still
 *  trying. The poll loop keeps going until the hard cap above. */
export const DEFAULT_INVOICE_SLOW_WARN_MS = 10_000;

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
  /** v0.6.5 follow-up: low-latency receive-watch hint. True once the
   *  gateway reports `funded`/`awaiting_funds`/`claimed`, even before
   *  wallet balance changes. This starts the mint-confirming watchdog
   *  from the gateway's evidence of payment instead of waiting for a
   *  partial balance delta that may never arrive on rejected receives. */
  mintDetected?: () => boolean;
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
    // Balance deltas are strongest, but the SDK receive watcher can
    // report `funded` before balance credit is observable. Treat that
    // as mint-confirming too so the watchdog starts even if the mint
    // later rejects without ever moving wallet balance.
    const mintDetected = delta > 0 || Boolean(opts.mintDetected?.());
    if (mintDetected && !inMintPhase) {
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

/** v0.6.5: receive-watch state, narrowed to a stable string union for
 *  this orchestrator. The full SDK state union lives in sdk-adapter;
 *  this is the public-facing shape callers (the orchestrator) work
 *  with. Mirrors LnReceiveStateKind in fedimint/sdk-adapter but
 *  redefined here to keep fund-and-lock.ts free of any Fedimint
 *  imports — it stays a pure orchestrator, testable in isolation. */
export type LnReceiveWatchKind =
  | "created"
  | "waiting_for_payment"
  | { canceled: { reason: string } }
  | "funded"
  | "awaiting_funds"
  | "claimed";

export interface RunFundAndLockDeps {
  /** Bound to fedimint.getBalance() in the hook. */
  getBalance: () => Promise<number>;
  /** Bound to actions.createFundingInvoice in the hook. Returns BOLT11.
   *  v0.6.5: optional `onReceiveState` listener — the SDK fires the
   *  LN receive watch on every state transition (created → funded →
   *  awaiting_funds → claimed). We use this to advance the modal to
   *  mint-confirming the instant the gateway acks the HTLC, rather
   *  than waiting up to 5s for the balance poll loop to notice. */
  createFundingInvoice: (
    amountMsats: number,
    description: string,
    onReceiveState?: (kind: LnReceiveWatchKind) => void,
  ) => Promise<string>;
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
  /** v0.6.5: createFundingInvoice tunables. */
  invoiceTimeoutMs?: number;
  invoiceSlowWarnMs?: number;
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

  // v0.6.5: race createFundingInvoice against a hard timeout. The
  // Fedimint WASM client's gateway-lookup + invoice-create chain can
  // hang silently when the federation's WebSocket transport is broken
  // (iroh-canary relay failures in cold-start reports). Without this
  // race the modal sat forever on the tiny "GENERATING INVOICE…"
  // spinner with no QR and no error. A slow-warn at 10s gives the
  // user honest progress while we keep trying; the hard timeout at
  // 45s fails fast with a recoverable lock-failed error.
  const invoiceTimeoutMs = opts.invoiceTimeoutMs ?? DEFAULT_INVOICE_TIMEOUT_MS;
  const invoiceSlowWarnMs = opts.invoiceSlowWarnMs ?? DEFAULT_INVOICE_SLOW_WARN_MS;
  let slowWarnTimer: ReturnType<typeof setTimeout> | null = null;
  let hardTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  // v0.6.5: receive-watch listener. Fires as the SDK observes the
  // LN receive operation transition states. We emit mint-confirming
  // the moment `funded` lands (gateway received the HTLC) so the
  // modal stops sitting on the QR — pollForFunding would have
  // noticed the same fact within 5s, but the watch is the lower-
  // latency signal. Deduped so re-fires (awaiting_funds, claimed
  // arriving after funded) don't spam onPhase.
  //
  // Cancellation handling is deliberately conservative. Production v0.6.4
  // let the balance poll remain the source of truth, and BLF payments could
  // still succeed even when the receive watch later reported
  // canceled:rejected. So: before the gateway reports `funded`, a cancel is
  // terminal. After `funded`, keep polling for actual balance credit; only the
  // balance gate decides whether we can LOCK.
  let mintConfirmingEmittedByWatch = false;
  let watchOverride: FundAndLockTerminal | null = null;
  let postFundedCancelReason: string | null = null;
  const watchAbort = new AbortController();
  const onReceiveState = (kind: LnReceiveWatchKind) => {
    if (typeof kind === "object" && "canceled" in kind) {
      // Already overridden — keep the first reason; subsequent
      // events from the SDK after a cancel are no-ops anyway.
      if (watchOverride) return;
      const reason = kind.canceled.reason;
      if (mintConfirmingEmittedByWatch) {
        // The gateway already saw the HTLC. Keep the v0.6.4 behavior:
        // continue polling balance instead of treating the receive stream's
        // cancel as authoritative. Some browser/Fedimint receive paths emit
        // canceled:rejected before balance credit is observable.
        postFundedCancelReason = postFundedCancelReason ?? reason;
        return;
      }
      if (reason === "expired") {
        watchOverride = { kind: "expired" };
        emit({ kind: "expired" });
      } else {
        const msg =
          `Federation didn't accept the payment (reason: ${reason}). ` +
          "Do not pay another invoice for this trade. Your sending wallet " +
          "may refund automatically; if it doesn't, contact the gateway or " +
          "switch communities before trying again.";
        watchOverride = { kind: "lock-failed", error: msg };
        emit({ kind: "lock-failed", error: msg });
      }
      // Force pollForFunding to bail on its next tick. We can't
      // touch opts.signal (caller owns it); the local watchAbort is
      // chained into pollForFunding's signal below.
      watchAbort.abort();
      return;
    }
    if (mintConfirmingEmittedByWatch) return;
    if (kind === "funded" || kind === "awaiting_funds" || kind === "claimed") {
      mintConfirmingEmittedByWatch = true;
      emit({ kind: "mint-confirming" });
    }
  };
  let bolt11: string;
  try {
    const slowWarnPromise = new Promise<void>((resolve) => {
      slowWarnTimer = setTimeout(() => {
        emit({ kind: "creating-invoice-slow" });
        resolve();
      }, invoiceSlowWarnMs);
    });
    void slowWarnPromise; // suppress unused-warning; emits a side-effect phase

    const timeoutPromise = new Promise<never>((_, reject) => {
      hardTimeoutTimer = setTimeout(() => {
        reject(new Error(
          "Couldn't reach the federation to generate an invoice. " +
          "The connection looks unreliable right now — try again in a moment, " +
          "or switch communities if it persists.",
        ));
      }, invoiceTimeoutMs);
    });

    bolt11 = await Promise.race([
      opts.createFundingInvoice(opts.amountMsats, opts.description, onReceiveState),
      timeoutPromise,
    ]);
  } catch (e: any) {
    const err = e?.message || "Couldn't create funding invoice";
    emit({ kind: "lock-failed", error: err });
    return { kind: "lock-failed", error: err };
  } finally {
    if (slowWarnTimer) clearTimeout(slowWarnTimer);
    if (hardTimeoutTimer) clearTimeout(hardTimeoutTimer);
  }
  const expiresAt = (opts.now ?? defaultNow)() +
    (opts.paymentDeadlineMs ?? DEFAULT_PAYMENT_DEADLINE_MS);
  emit({ kind: "invoice-created", bolt11, expiresAt });

  // v0.6.5: pollForFunding's signal is the OR of the caller's signal
  // and watchAbort (set when the receive watch reports a pre-funded
  // terminal cancellation).
  // Whichever fires first ends the poll loop; runFundAndLock then
  // returns either the caller-initiated `aborted` or the watch-
  // initiated terminal (lock-failed / expired) — whichever is set.
  if (opts.signal) {
    if (opts.signal.aborted) watchAbort.abort();
    else opts.signal.addEventListener(
      "abort",
      () => watchAbort.abort(),
      { once: true },
    );
  }
  const polled = await pollForFunding({
    baselineMsats: baseline,
    expectedMsats: opts.amountMsats,
    getBalance: opts.getBalance,
    onPhase: emit,
    signal: watchAbort.signal,
    paymentDeadlineMs: opts.paymentDeadlineMs,
    mintConfirmTimeoutMs: opts.mintConfirmTimeoutMs,
    mintSlowWarnMs: opts.mintSlowWarnMs,
    pollIntervalMs: opts.pollIntervalMs,
    mintDetected: () => mintConfirmingEmittedByWatch,
    sleep: opts.sleep,
    now: opts.now,
  });

  // Receive watch override takes precedence for pre-funded terminal states.
  // Post-funded cancel reports are intentionally ignored above so balance
  // polling can preserve the known-working v0.6.4 behavior.
  if (watchOverride) return watchOverride;

  if (polled.kind === "mint-timeout" && postFundedCancelReason) {
    const err =
      `Payment reached the gateway, but the federation later reported ` +
      `canceled:${postFundedCancelReason} and no ecash credit arrived. ` +
      "Do not pay another invoice for this trade yet. Your sending wallet " +
      "may refund automatically; if sats later appear in Chama, use the " +
      "recovery prompt or try the lock again from the trade.";
    emit({ kind: "lock-failed", error: err });
    return { kind: "lock-failed", error: err };
  }

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
