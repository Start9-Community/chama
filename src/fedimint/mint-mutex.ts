// ══════════════════════════════════════════════════════════════════════════
// Chama — Mint-Op Mutex (v3.4.0, audit C12)
// ══════════════════════════════════════════════════════════════════════════
//
// One async mutex over EVERY mint operation on the shared OPFS wallet:
// Fund's spend (createEscrowLock / spendNotes), the boot-drain redeem,
// and the claim redeem (redeemWithRetry / redeemEcash).
//
// Why: two browser tabs on the same origin share ONE OPFS wallet file.
// Before v3.4.0 the only guard was useEscrow's fundingInProgressRef,
// which (a) covered Fund alone — the boot-time drainPendingRedemptions
// redeem ran with no lock held — and (b) was per-tab, so it could not
// see a Fund in another tab at all. A boot-drain redeem racing a
// concurrent spendNotes on the same wallet is the Pillar-2.1 "two
// concurrent spendNotes on one OPFS wallet" corruption risk.
//
// The Web Locks API (navigator.locks) is the cross-tab primitive: locks
// are origin-scoped, exclusive by default, FIFO-granted, and auto-
// released when the holding tab dies. The lock NAME is keyed on the
// OPFS wallet filename (registered by sdk-adapter at init), so two
// identities with separate wallet files in one browser profile do not
// serialize against each other.
//
// Environments without Web Locks (Node tests, native shells, very old
// WebKit) fall back to an in-process FIFO queue with identical
// semantics minus cross-tab coverage — exactly the coverage those
// environments don't need (no second tab shares the wallet there).
//
// ── Non-reentrancy (C12 trap a) ───────────────────────────────────────────
// The lock is NOT reentrant: withMintLock inside withMintLock on the
// same wallet stalls until the acquire timeout, then throws. The
// FedimintClient keeps nesting impossible by wrapping only its PUBLIC
// mint entry points, all of which call the raw wallet (wallet.mint.*)
// directly — never each other. If you add a new mint entry point,
// preserve that shape.
//
// ── Stuck-tab protection (C12 trap b) ─────────────────────────────────────
// The acquire timeout bounds WAITING, not the op itself: a tab whose
// mint op hangs forever keeps the lock (by design — releasing it under
// a live op is the corruption we're preventing), and every waiter fails
// loudly after MINT_LOCK_ACQUIRE_TIMEOUT_MS instead of freezing
// silently. A tab that dies releases the lock immediately (browser
// behavior). Callers may also pass an AbortSignal to give up waiting —
// an abort after the lock is granted is deliberately ignored here; the
// running op observes its own signal and the lock releases when the op
// settles.

/** How long a mint op will wait for the wallet lock before failing
 *  loudly. Generous: a legitimate Fund spend in another tab can hold
 *  the lock for tens of seconds against a slow federation. */
export const MINT_LOCK_ACQUIRE_TIMEOUT_MS = 120_000;

const LOCK_NAME_PREFIX = "chama-mint-op";

// The OPFS wallet filename this session operates on. "default" until
// sdk-adapter registers the real filename; sim/mock/native wallets never
// register one, which is fine — they don't share an OPFS file across
// tabs, and a single origin-wide queue is harmless there.
let mintLockScope = "default";

/** Register the OPFS wallet filename as the lock scope. Called by
 *  sdk-adapter once the wallet file is settled (including after a
 *  filename rotation or fresh-file reset). */
export function setMintLockScope(scope: string | null | undefined): void {
  const clean = scope?.trim();
  mintLockScope = clean || "default";
}

/** The Web Locks resource name every mint op serializes on. Exported
 *  for tests and diagnostics. */
export function mintLockName(): string {
  return `${LOCK_NAME_PREFIX}:${mintLockScope}`;
}

function mintLockTimeoutError(label: string, timeoutMs: number): Error {
  const err = new Error(
    `Your wallet is busy with another operation (possibly in another tab) — ` +
    `"${label}" gave up waiting after ${Math.round(timeoutMs / 1000)}s. ` +
    `No sats moved in this operation. Close other Chama tabs and retry.`
  );
  (err as Error & { code?: string }).code = "MINT_LOCK_TIMEOUT";
  return err;
}

function mintLockAbortError(label: string): Error {
  const err = new Error(`"${label}" was cancelled before the wallet lock was acquired. No sats moved.`);
  (err as Error & { code?: string }).code = "MINT_LOCK_ABORTED";
  return err;
}

// ── In-process fallback queue ──────────────────────────────────────────────
// Per lock name, the tail every new waiter must wait behind. Each holder
// appends `prev.then(() => gate)`, so an abandoned waiter (timeout/abort)
// resolves its gate immediately without ever letting the next waiter
// jump ahead of the still-running holder in `prev`.
const fallbackTails = new Map<string, Promise<void>>();

async function waitForTurn(
  prev: Promise<void>,
  label: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw mintLockAbortError(label);
  await new Promise<void>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(mintLockTimeoutError(label, timeoutMs));
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    const onAbort = () => {
      if (done) return;
      done = true;
      cleanup();
      reject(mintLockAbortError(label));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    prev.then(() => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    });
  });
}

type WebLocksLike = {
  request: (
    name: string,
    options: { mode: "exclusive"; signal?: AbortSignal },
    callback: () => Promise<unknown>,
  ) => Promise<unknown>;
};

function webLocks(): WebLocksLike | null {
  const locks = (globalThis as { navigator?: { locks?: WebLocksLike } }).navigator?.locks;
  return locks && typeof locks.request === "function" ? locks : null;
}

/**
 * Run `fn` while holding the exclusive mint-op lock for this wallet.
 *
 * INVARIANT(mint-mutex): every operation that spends from or redeems
 * into the shared OPFS wallet runs under this lock — across tabs where
 * Web Locks exists, within the process otherwise. Callers must never
 * nest withMintLock (see file header).
 *
 * @param label  Human label for error copy/diagnostics ("fund-spend",
 *               "claim-redeem", …).
 * @param fn     The mint op. The lock is held until its promise settles.
 * @param opts.signal           Abort WAITING for the lock (granted ops run to completion).
 * @param opts.acquireTimeoutMs Override the acquire timeout (tests).
 */
export async function withMintLock<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { signal?: AbortSignal; acquireTimeoutMs?: number } = {},
): Promise<T> {
  const name = mintLockName();
  const timeoutMs = opts.acquireTimeoutMs ?? MINT_LOCK_ACQUIRE_TIMEOUT_MS;
  const locks = webLocks();

  if (locks) {
    if (opts.signal?.aborted) throw mintLockAbortError(label);
    const acquireCtl = new AbortController();
    let granted = false;
    let timedOut = false;
    let callerAborted = false;
    const timer = setTimeout(() => {
      if (granted) return;
      timedOut = true;
      acquireCtl.abort();
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    const onAbort = () => {
      if (granted) return;
      callerAborted = true;
      acquireCtl.abort();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return (await locks.request(name, { mode: "exclusive", signal: acquireCtl.signal }, async () => {
        granted = true;
        clearTimeout(timer);
        return await fn();
      })) as T;
    } catch (e) {
      if (timedOut && !granted) throw mintLockTimeoutError(label, timeoutMs);
      if (callerAborted && !granted) throw mintLockAbortError(label);
      throw e;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  // Fallback: in-process FIFO queue.
  const prev = fallbackTails.get(name) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  fallbackTails.set(name, prev.then(() => gate));
  try {
    await waitForTurn(prev, label, timeoutMs, opts.signal);
    return await fn();
  } finally {
    // Releases our slot whether we ran or abandoned the wait — the
    // chained `prev.then(() => gate)` keeps later waiters behind any
    // still-running holder either way.
    release();
  }
}
