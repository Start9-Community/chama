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
//                    error paths). We poll up to a 90s grace (extended
//                    while the federation can't even be READ — a failed
//                    balance read proves nothing about non-arrival on a
//                    slow link) before falling back to the absolute-
//                    balance cover check below.
//
//                    v2.1.1 (the sm_mq1cmq6p_a2arwi0x incident): growth-
//                    from-baseline is structurally blind to settlement
//                    that happened on a PREVIOUS attempt. On a slow link
//                    the first attempt's redeem can land *after* its 60s
//                    window expired; every retry then re-baselines WITH
//                    the landed sats included, the re-redeem reports
//                    already-spent (treated as success), and growth can
//                    never be observed again → infinite claim-pending
//                    loop, while the sats sit invisibly in the wallet
//                    (sub-material amounts surface nowhere else). The
//                    fix: when growth times out, judge settlement by the
//                    ABSOLUTE balance — if the wallet can cover the
//                    payout right now, pay it out. Sats are fungible,
//                    the destination is the winner's own wallet, and the
//                    pending-redemption stash stays intact for the boot
//                    drain to reconcile the genuinely-pending case.
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
//                    hasn't landed within the confirm window AND the
//                    absolute balance can't cover the payout. Genuinely
//                    in-flight — sats may still arrive from the
//                    federation. The pending-redemption stash stays
//                    intact so boot can retry redeeming the notes; if
//                    balance later lands, the next claim retry's cover
//                    check pays it out (this is what makes "try the
//                    claim again" honest copy). RESERVED for the
//                    no-throw / balance-stalled case ONLY. A post-CLAIM
//                    terminal mint reissue failure routes to
//                    claim-failed — but only after the cover check has
//                    had a chance to rescue it: consumed notes + a
//                    covering balance means a previous attempt already
//                    credited this wallet.
// `payout-failed`    TERMINAL — claim succeeded, balance landed, but
//                    payInvoice threw. The trade is deliberately left
//                    un-COMPLETEd so the Claim button stays the retry
//                    path, including for sub-material payouts that the
//                    main recovery banner keeps quiet.
//
// The four-way split lets the modal surface UX that matches reality:
// `claim-bridge-threw` shows the actual error + retry; `claim-pending`
// shows "still arriving" reassurance; `claim-failed` shows terminal
// no-recovery framing; `payout-failed` points at retrying Claim while
// the recovered balance remains safely local.

import { markSatsTracesDrained, recordSatsTrace } from "./sats-trace.js";
import { maxLightningPayoutSats } from "./lightning-fees.js";

// ── Phase types ──────────────────────────────────────────────────────────

export type ClaimAndPayoutPhase =
  | { kind: "claiming" }
  | { kind: "confirming" }
  | { kind: "paying-invoice" }
  | { kind: "paying-onchain" }
  | { kind: "done" }
  | { kind: "claim-failed"; error: string }
  | { kind: "claim-bridge-threw"; error: string }
  | { kind: "claim-pending"; error: string }
  | { kind: "payout-failed"; error: string; claimCompleted?: boolean };

export type ClaimAndPayoutTerminal =
  | { kind: "done" }
  | { kind: "claim-failed"; error: string }
  | { kind: "claim-bridge-threw"; error: string }
  | { kind: "claim-pending"; error: string }
  /** `claimCompleted`: false when COMPLETE was deliberately not yet
   *  published because the outbound payout failed. The trade's Claim
   *  button is still alive, so "tap Claim again" is the honest retry
   *  path. Kept optional for older callers/terminals. */
  | { kind: "payout-failed"; error: string; claimCompleted?: boolean };

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

/** v0.1.62 watchdog, widened in v2.1.1: 90s grace for the federation to
 *  credit the user's wallet after CLAIM publishes. The original 60s was
 *  calibrated on good links; the sm_mq1cmq6p_a2arwi0x field incident
 *  (South Africa, high-latency mobile data) showed real redeems landing
 *  after the window closed. A too-short window costs a claim-pending
 *  bounce; with the cover check it no longer costs a stuck trade. */
export const DEFAULT_CONFIRM_TIMEOUT_MS = 90 * 1000;

/** Same cadence as the existing claim watchdog and Phase 2. */
export const DEFAULT_POLL_INTERVAL_MS = 5_000;

/** Failed balance reads extend the confirm deadline (they prove nothing
 *  about non-arrival), but never past this multiple of the nominal
 *  timeout — the loop must terminate even when the federation stays
 *  unreadable for the whole window. */
export const CONFIRM_HARD_CAP_MULTIPLIER = 3;

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

// ── balanceCoversPayout ──────────────────────────────────────────────────

/** Absolute-balance settlement check: can the wallet, RIGHT NOW, pay the
 *  payout this claim promised? Used when balance GROWTH can't be observed
 *  — either the confirm window timed out, or the mint reported the notes
 *  already consumed (a previous attempt's redeem landed after its own
 *  window closed; re-baselining hides the credit forever).
 *
 *  Lightning: the modal sized the invoice as
 *  maxLightningPayoutSats(expectedDeltaMsats), so the wallet covers it
 *  exactly when its own max payout reaches that figure (fee headroom
 *  included — maxLightningPayoutSats is monotone).
 *  Onchain: payOnchain receives gross sats and re-deducts peg-out fees
 *  itself, so whole-sat coverage of the gross amount suffices.
 *
 *  Safety: sats are fungible and the destination is the winner's OWN
 *  wallet. In the worst case (claim genuinely still pending + the cover
 *  came from pre-existing funds) the user is paid from money that was
 *  already theirs, the pending-redemption stash stays intact, and the
 *  boot drain reconciles the late credit. The user can only come out
 *  whole or ahead — never behind. */
export function balanceCoversPayout(
  balanceMsats: number,
  expectedDeltaMsats: number,
  payoutKind: "lightning" | "onchain" = "lightning",
): boolean {
  const balance = Math.max(0, Math.floor(balanceMsats));
  const expected = Math.max(0, Math.floor(expectedDeltaMsats));
  if (expected <= 0) return false;
  if (payoutKind === "onchain") {
    const grossSats = Math.floor(expected / 1000);
    return grossSats > 0 && Math.floor(balance / 1000) >= grossSats;
  }
  const invoiceSats = maxLightningPayoutSats(expected);
  return invoiceSats > 0 && maxLightningPayoutSats(balance) >= invoiceSats;
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
  // v2.1.1 slow-link rule: a FAILED balance read proves nothing about
  // non-arrival, so it must not consume the confirm window. Each failed
  // read extends the deadline by one poll interval, hard-capped at
  // CONFIRM_HARD_CAP_MULTIPLIER × the nominal timeout so an unreachable
  // federation still terminates the loop.
  const hardCapMs = timeoutMs * CONFIRM_HARD_CAP_MULTIPLIER;
  let failedReadExtensionMs = 0;

  while (true) {
    if (opts.signal?.aborted) return "aborted";
    polls++;
    let balance = opts.baselineMsats;
    let balanceReadOk = true;
    try {
      balance = await opts.getBalance();
    } catch {
      balanceReadOk = false;
      // Transient federation hiccups during polling — retry on next tick,
      // and push the deadline out by the interval this read wasted.
      failedReadExtensionMs = Math.min(
        failedReadExtensionMs + pollIntervalMs,
        Math.max(0, hardCapMs - timeoutMs),
      );
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
    const effectiveTimeoutMs = Math.min(timeoutMs + failedReadExtensionMs, hardCapMs);
    if (elapsedMs >= effectiveTimeoutMs) {
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
  /** Optional native on-chain payout. Amount is the gross claimed sats
   *  available before wallet-module peg-out fees. */
  payOnchain?: (grossAmountSats: number) => Promise<void>;
  payoutKind?: "lightning" | "onchain";
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
 *   - payout-failed: claim landed (balance grew or covered), but the
 *     outbound send failed; sats remain local and Claim stays retryable */
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
  // v2.1.1: when the mint reports the notes terminally consumed, balance
  // GROWTH is impossible by definition — either a previous attempt's
  // redeem already credited this wallet (the sm_mq1cmq6p_a2arwi0x loop)
  // or the credit is unprovable. Skip the growth poll and judge by the
  // absolute-balance cover check; only if that also fails do we surface
  // the terminal claim-failed.
  let settlementFailedHard = false;
  let settlementFailedError = "";
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
    // reissue failure. Growth polling is pointless (the notes are gone),
    // but the wallet may ALREADY hold the credit from a previous attempt
    // whose confirm window expired before settlement — the cover check
    // below decides. Only a non-covering balance keeps this terminal.
    if (e?.claimPublished && e?.settlementFailed) {
      claimTrace("orchestrator-claim-settle-failed", {
        escrowId: opts.escrowId,
        errMsg: error.slice(0, 120),
      });
      settlementFailedHard = true;
      settlementFailedError = error;
      // Fall through to the settlement verdict below (poll skipped).
    } else if (e?.claimPublished) {
      // CLAIM already hit relays, but redeem/balance settlement is still
      // uncertain. This is not a hard claim failure; continue into the
      // balance-confirming watchdog. If the balance lands, payout proceeds.
      // If it does not, the terminal remains claim-pending.
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

  // Phase 2: settlement verdict. Two independent proofs, tried in order:
  //
  //   growth — balance grew from this attempt's baseline (the classic
  //            watchdog; cryptographically tied to THIS redeem landing).
  //   cover  — the absolute balance can pay the promised payout right
  //            now. Catches every settlement the baseline can't see:
  //            a previous attempt's redeem landing late, the boot
  //            drain landing it, or a resumed historical operation.
  //            Without this, a retry after late settlement loops on
  //            claim-pending FOREVER (baseline includes the credit, so
  //            growth can never be observed again).
  const payoutKind = opts.payoutKind ?? "lightning";
  emit({ kind: "confirming" });
  let grew: "grew" | "timeout" | "aborted" = "timeout";
  if (!settlementFailedHard) {
    grew = await waitForBalanceGrowth({
      debugId: opts.escrowId,
      baselineMsats: baseline,
      expectedDeltaMsats: opts.expectedDeltaMsats,
      getBalance: opts.getBalance,
      timeoutMs: opts.confirmTimeoutMs,
      pollIntervalMs: opts.pollIntervalMs,
      sleep: opts.sleep,
      now: opts.now,
    });
  }
  let settledBy: "growth" | "cover" | null = grew === "grew" ? "growth" : null;
  let coverBalanceMsats: number | undefined;
  if (!settledBy) {
    try { coverBalanceMsats = await opts.getBalance(); } catch {}
    if (
      coverBalanceMsats !== undefined &&
      balanceCoversPayout(coverBalanceMsats, opts.expectedDeltaMsats, payoutKind)
    ) {
      settledBy = "cover";
    }
  }
  moneyLog("CLAIM-CONFIRM-OUT", {
    escrowId: opts.escrowId,
    result: grew,
    settledBy: settledBy ?? "none",
    coverBalance: coverBalanceMsats,
    settlementFailedHard,
  });
  claimTrace("orchestrator-confirm-out", {
    escrowId: opts.escrowId,
    result: grew,
    settledBy: settledBy ?? "none",
    coverBalance: coverBalanceMsats,
    settlementFailedHard,
  });
  if (!settledBy) {
    if (settlementFailedHard) {
      // Notes consumed AND the wallet can't cover the payout: this is
      // the honest terminal failure. Do not invite retries against
      // already-consumed notes with comforting "still arriving" copy.
      emit({ kind: "claim-failed", error: settlementFailedError });
      return { kind: "claim-failed", error: settlementFailedError };
    }
    const error =
      "Your sats are still arriving from the federation. They'll land shortly. If this trade stays settling, try the claim again.";
    emit({ kind: "claim-pending", error });
    return { kind: "claim-pending", error };
  }

  let balanceAfterClaim: number | undefined;
  if (coverBalanceMsats !== undefined) {
    balanceAfterClaim = coverBalanceMsats;
  } else {
    try { balanceAfterClaim = await opts.getBalance(); } catch {}
  }

  // Stash discipline: GROWTH proves this attempt's redeem landed — clear.
  // COVER is circumstantial (the credit may predate this attempt, or the
  // redeem may still be genuinely pending while pre-existing funds cover
  // the payout) — KEEP the stash. If the notes already redeemed, the next
  // boot drain's already-spent → success path clears it; if they're still
  // pending, the drain retries them. Self-reconciling either way.
  if (settledBy === "growth" && opts.clearPendingRedemption) {
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

  // Phase 3: outbound payout. Pay the user's destination.
  // If this throws, COMPLETE has not been published yet, so re-tapping
  // Claim retries cleanly (picker → fresh invoice → cover check →
  // payout). This matters for tiny claims too: the balance can be real
  // but below the main recovery banner's material line.
  emit({ kind: payoutKind === "onchain" ? "paying-onchain" : "paying-invoice" });
  try {
    moneyLog("CLAIM-PAY-IN", {
      escrowId: opts.escrowId,
      kind: payoutKind,
      invoicePrefix: payoutKind === "lightning" ? opts.bolt11.slice(0, 24) : "onchain",
    });
    claimTrace("orchestrator-pay-in", {
      escrowId: opts.escrowId,
      kind: payoutKind,
      invoicePrefix: payoutKind === "lightning" ? opts.bolt11.slice(0, 24) : "onchain",
    });
    if (payoutKind === "onchain") {
      if (!opts.payOnchain) throw new Error("Onchain payout is not available");
      await opts.payOnchain(Math.floor(opts.expectedDeltaMsats / 1000));
    } else {
      await opts.payInvoice(opts.bolt11);
    }
  } catch (e: any) {
    const error = errorMessage(e, payoutKind === "onchain" ? "Onchain payout failed" : "Lightning payment failed");
    recordSatsTrace({
      source: "claim",
      escrowId: opts.escrowId,
      amountMsats: opts.expectedDeltaMsats,
      balanceMsats: balanceAfterClaim,
      reason: "claim-payout-failed",
    });
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
    const claimCompleted = false;
    emit({ kind: "payout-failed", error, claimCompleted });
    return { kind: "payout-failed", error, claimCompleted };
  }
  moneyLog("CLAIM-PAY-OUT", {
    escrowId: opts.escrowId,
    result: "success",
  });
  claimTrace("orchestrator-pay-out", {
    escrowId: opts.escrowId,
    result: "success",
  });

  // COMPLETE is deferred until the user is demonstrably made whole
  // (payout sent). At this point the attestation is materially true
  // whether settlement was proven by fresh growth or by a covering
  // balance from an earlier/late redeem. Best-effort: the money path
  // succeeded, so a relay publish failure must not undo the payout.
  if (opts.completeClaim) {
    try {
      moneyLog("CLAIM-COMPLETE-IN", {
        escrowId: opts.escrowId,
        via: settledBy,
      });
      claimTrace("orchestrator-complete-in", {
        escrowId: opts.escrowId,
        via: settledBy,
      });
      await opts.completeClaim(opts.escrowId);
      moneyLog("CLAIM-COMPLETE-OUT", {
        escrowId: opts.escrowId,
        result: "success",
        via: settledBy,
      });
      claimTrace("orchestrator-complete-out", {
        escrowId: opts.escrowId,
        result: "success",
        via: settledBy,
      });
    } catch (e: any) {
      moneyLog("CLAIM-COMPLETE-OUT", {
        escrowId: opts.escrowId,
        result: "error",
        via: settledBy,
        errMsg: (e?.message || String(e)).slice(0, 120),
      });
      claimTrace("orchestrator-complete-out", {
        escrowId: opts.escrowId,
        result: "error",
        via: settledBy,
        errMsg: (e?.message || String(e)).slice(0, 120),
      });
      // Advisory protocol event only; the user already has their sats.
    }
  }

  let balanceAfterPayout: number | undefined;
  try { balanceAfterPayout = await opts.getBalance(); } catch {}
  if (balanceAfterPayout !== undefined && Math.floor(Math.max(0, balanceAfterPayout) / 1000) > 0) {
    recordSatsTrace({
      source: "claim",
      escrowId: opts.escrowId,
      amountMsats: opts.expectedDeltaMsats,
      balanceMsats: balanceAfterPayout,
      reason: "claim-payout-leftover",
    });
  } else if (balanceAfterPayout !== undefined) {
    markSatsTracesDrained("claim-payout-drained");
  }

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
