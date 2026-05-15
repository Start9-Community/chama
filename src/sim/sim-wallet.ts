// ══════════════════════════════════════════════════════════════════════════
// Chama — Sim mode wallet (IFedimintWallet implementation)
// ══════════════════════════════════════════════════════════════════════════
//
// In-memory mock wallet that satisfies the IFedimintWallet contract so
// it slots into the existing FedimintClient + escrow-bridge wiring
// without touching the trade-crypto code paths above it.
//
// Differences from `mock-wallet.ts` (testnet=1 scaffold):
//   - Starts at 0 msats. Testers fund via the LN-IN flow exactly as a
//     real user would.
//   - State persists to localStorage keyed by the user's npub. A
//     fresh-load picks up where the user left off; switching identity
//     in the same browser swaps to a different sim wallet cleanly.
//   - Realistic 3-8s timing on all money operations. The testnet mock
//     completes instantly, which makes the UX feel arcade-y and hides
//     race conditions. Sim mode is product-facing; it must feel like
//     real ecash latency.
//   - LN invoices auto-credit on a randomized 3-8s delay. The bolt11
//     is a recognizable `lnbcsim…` string so testers can tell at a
//     glance that they're holding a sim invoice, not a real one.
//
// Crypto: none. OOB note strings are unforgeable only inside the same
// sim session — they encode the amount and a counter, parseable in
// plaintext. Do not connect a real federation client to these strings.

import type { IFedimintWallet } from "../fedimint/fedimint-client.js";

// ── Constants ─────────────────────────────────────────────────────────────

const SIM_FEDERATION_PREFIX = "SBX_sim0v1";
const SIM_FEDERATION_ID = "sim_fed_" + "0".repeat(56);
const SIM_INVITE = "fed1sim" + "0".repeat(80);
const STARTING_BALANCE_MSATS = 0;

const STORAGE_PREFIX = "chama_sim_wallet_";

// 3-8s with uniform jitter — feels like a slow federation roundtrip
const MIN_DELAY_MS = 3000;
const MAX_DELAY_MS = 8000;

// ── Persistent state shape (per-npub localStorage value) ──────────────────

interface PersistedSimState {
  balanceMsats: number;
  noteCounter: number;
  joined: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function storageKey(npub: string | null): string {
  // Anonymous testers (no signer yet) share a single key. Once a signer
  // initializes and npub is known, future loads pick up the per-npub
  // entry. The unkeyed bucket is intentionally not migrated — fresh
  // identity → fresh wallet.
  return STORAGE_PREFIX + (npub || "anonymous");
}

function loadState(npub: string | null): PersistedSimState {
  try {
    if (typeof localStorage === "undefined") return defaultState();
    const raw = localStorage.getItem(storageKey(npub));
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw) as Partial<PersistedSimState>;
    return {
      balanceMsats: Number.isFinite(parsed.balanceMsats!) ? parsed.balanceMsats! : STARTING_BALANCE_MSATS,
      noteCounter: Number.isFinite(parsed.noteCounter!) ? parsed.noteCounter! : 0,
      joined: parsed.joined === true,
    };
  } catch {
    return defaultState();
  }
}

function saveState(npub: string | null, state: PersistedSimState): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(storageKey(npub), JSON.stringify(state));
  } catch { /* no-op */ }
}

function defaultState(): PersistedSimState {
  return { balanceMsats: STARTING_BALANCE_MSATS, noteCounter: 0, joined: false };
}

function simDelay(): Promise<void> {
  const ms = MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
  return new Promise(r => setTimeout(r, ms));
}

// ── BOLT11 amount parser ──────────────────────────────────────────────────
//
// Extracts the msat amount encoded in the human-readable prefix of a
// BOLT11 invoice. BIP-21 / BOLT-11 §amount: `ln<chain>[amount][multiplier]`
// where multiplier is one of:
//   m = milli-BTC (10^-3 BTC = 1e8 msat)
//   u = micro-BTC (10^-6 BTC = 1e5 msat)
//   n = nano-BTC  (10^-9 BTC = 1e2 msat)
//   p = pico-BTC  (10^-12 BTC = 0.1 msat — must be multiple of 10)
//   ε = whole BTC (1e11 msat)
//
// The amount field is OPTIONAL; donation-style invoices have none. Returns
// null on parse failure (caller decides what to do — sim's payInvoice
// throws because we can't debit an unknown amount).
//
// This is sim-only. Real Fedimint clients parse BOLT11 via the WASM SDK;
// we don't ship a general-purpose parser to production callers.
export function parseBolt11Msats(bolt11: string): number | null {
  if (typeof bolt11 !== "string") return null;
  const lower = bolt11.toLowerCase().trim();
  // Anchored at start, allow any ln<chain> prefix (lnbc, lntb, lnbcrt,
  // lnbcsim, etc.). `[a-z]+?` is non-greedy so it consumes only the
  // chain prefix; then digits = amount; then optional multiplier.
  const m = /^ln[a-z]+?(\d+)([munp]?)1/.exec(lower);
  if (!m) return null;
  const amount = parseInt(m[1], 10);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const mult = m[2];
  switch (mult) {
    case "m": return amount * 100_000_000;
    case "u": return amount * 100_000;
    case "n": return amount * 100;
    case "p":
      // pico-BTC must yield integer msat (BOLT-11 spec requires the
      // value to be a multiple of 10 for `p`). Floor for safety.
      return Math.floor(amount / 10);
    case "":  return amount * 100_000_000_000;
    default:  return null;
  }
}

// ── Factory ───────────────────────────────────────────────────────────────

export interface CreateSimWalletOptions {
  /** Hex pubkey of the active signer. Used to key persistent state so
   *  multiple identities in the same browser don't share a sim balance. */
  npub: string | null;
}

export function createSimWallet(opts: CreateSimWalletOptions = { npub: null }): IFedimintWallet {
  const npub = opts.npub;
  const state = loadState(npub);
  let open = false;
  const subscribers = new Set<(balance: number) => void>();
  // v0.4.2 hotfix round 2/3: track pending invoice auto-credit timers
  // so cleanup() can cancel them. Without this, a stale funding-invoice
  // timer fires AFTER a trade completes and re-credits the wallet —
  // the "Recovery pill after DONE" failure mode.
  //
  // Map<symbol, TimerHandle> instead of Set<TimerHandle>: the callback
  // needs a stable key it can use to remove itself from the registry,
  // but referencing the timer handle from inside the callback hits a
  // temporal-dead-zone error if setTimeout fires synchronously
  // (which it does in our deterministic tests with a setTimeout
  // trampoline). The symbol is created before setTimeout, so the
  // callback can always reference it.
  const pendingCreditTimers = new Map<symbol, ReturnType<typeof setTimeout>>();

  const persist = () => saveState(npub, state);
  const notifyBalance = () => {
    for (const cb of subscribers) {
      try { cb(state.balanceMsats); } catch { /* swallow */ }
    }
  };

  return {
    async open() {
      open = true;
    },
    isOpen() {
      return open && state.joined;
    },
    recovery: {
      async hasPendingRecoveries() { return false; },
      async waitForAllRecoveries() {},
    },

    async joinFederation(_inviteCode: string) {
      // Joining is the only operation that's fast — it mirrors the fact
      // that in real Fedimint joining is mostly a key-fetch, not an
      // ecash roundtrip.
      state.joined = true;
      persist();
      notifyBalance();
    },

    balance: {
      async getBalance() {
        return state.balanceMsats;
      },
      subscribeBalance(callback: (balance: number) => void) {
        subscribers.add(callback);
        setTimeout(() => callback(state.balanceMsats), 0);
        return () => { subscribers.delete(callback); };
      },
    },

    mint: {
      async spendNotes(amountMsats: number) {
        await simDelay();
        if (amountMsats > state.balanceMsats) {
          throw new Error(
            `Sim wallet: insufficient balance ` +
            `(have ${state.balanceMsats} msat, need ${amountMsats} msat). ` +
            `Generate a sim invoice and pay it from anywhere to fund.`
          );
        }
        state.balanceMsats -= amountMsats;
        state.noteCounter++;
        persist();
        notifyBalance();
        // OOB string format: prefix + counter + amount. The 10-char
        // prefix matches the sim federation's identifier so reconstructed
        // notes round-trip cleanly for sim trades.
        return `${SIM_FEDERATION_PREFIX}_${state.noteCounter}_${amountMsats}`;
      },
      async redeemEcash(oobNotes: string) {
        await simDelay();
        const m = oobNotes.match(/^SBX_sim0v1_\d+_(\d+)$/);
        if (!m) {
          throw new Error("Sim wallet: invalid sim notes format");
        }
        const amount = parseInt(m[1], 10);
        state.balanceMsats += amount;
        persist();
        notifyBalance();
      },
      async parseNotes(oobNotes: string) {
        const m = oobNotes.match(/^SBX_sim0v1_\d+_(\d+)$/);
        if (!m) {
          throw new Error("Sim wallet: invalid sim notes format");
        }
        return { total_amount: parseInt(m[1], 10) };
      },
    },

    lightning: {
      async createInvoice(amountMsats: number, description: string) {
        // No delay on invoice creation — real LN invoices are local.
        const opId = `sim_op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const tag = description.replace(/\W/g, "").slice(0, 10) || "trade";
        // Encode msats in the BOLT11 amount field so parseBolt11Msats
        // can recover it later for refunds / accounting.
        //
        // v0.4.2 hotfix round 3: previously used `${amountMsats}n` which
        // is off by 100x — 'n' multiplier in BOLT-11 is 100 msat, not
        // 1 msat. A 50k-sat invoice generated as `lnbcsim50000000n1...`
        // would parse back as 5M sats. Using `p` multiplier with
        // `amountMsats * 10` gives an exact msat round-trip
        // (p = 0.1 msat, encoded N * p = msats N/10; we use N = msats*10
        // so encoded N/10 = msats).
        const invoice = `lnbcsim${amountMsats * 10}p1p${tag}${opId}`;
        // Auto-settle after a randomized delay. Stands in for the
        // payer's LN wallet completing the hop. Track the timer
        // handle so cleanup() can cancel any in-flight credit — a
        // funding invoice that fires AFTER the trade completes would
        // otherwise leave a stranded balance and trip the Recovery
        // Banner even though COMPLETE published.
        const delay = MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
        const key = Symbol("sim-credit-timer");
        const timer = setTimeout(() => {
          pendingCreditTimers.delete(key);
          state.balanceMsats += amountMsats;
          persist();
          notifyBalance();
        }, delay);
        pendingCreditTimers.set(key, timer);
        return { invoice, operationId: opId };
      },
      async payInvoice(bolt11: string) {
        // v0.4.2 hotfix round 2: claim-and-payout's LN-out leg lands
        // here. Without a debit, the winner's wallet shows the
        // redeemed claim amount as "stranded" after payout (Recovery
        // Banner fires even though COMPLETE published). Parse the
        // BOLT11 amount and decrement so the post-payout balance
        // matches reality.
        await simDelay();
        const debit = parseBolt11Msats(bolt11);
        if (debit === null) {
          throw new Error(
            "Sim wallet: couldn't parse BOLT11 amount. " +
            "Sim only supports amount-encoded invoices (lnbc<amount><multiplier>1…)."
          );
        }
        if (debit > state.balanceMsats) {
          throw new Error(
            `Sim wallet: insufficient balance for payout ` +
            `(have ${state.balanceMsats} msat, need ${debit} msat).`
          );
        }
        state.balanceMsats -= debit;
        persist();
        notifyBalance();
        return { operationId: `sim_pay_${Date.now()}` };
      },
    },

    federation: {
      async getFederationId() { return SIM_FEDERATION_ID; },
      async getInviteCode() { return SIM_INVITE; },
    },

    async cleanup() {
      // v0.4.2 hotfix round 2/3: cancel pending invoice auto-credit
      // timers so a stale funding invoice doesn't fire post-cleanup
      // and stamp a phantom balance into a freshly-reset wallet.
      for (const t of pendingCreditTimers.values()) clearTimeout(t);
      pendingCreditTimers.clear();
      subscribers.clear();
      open = false;
      // Note: we deliberately do not reset state.joined or balance on
      // cleanup. cleanup() runs on tab close / hot reload; the persisted
      // state must outlive it.
    },
  };
}
