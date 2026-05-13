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
        // prefix matches probeFederation's expectations so the gate
        // passes for sim trades.
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
        const invoice = `lnbcsim${amountMsats}n1p${tag}${opId}`;
        // Auto-settle after a randomized delay. This stands in for the
        // payer's LN wallet completing the hop. The randomization is
        // load-bearing for surfacing race conditions in the UI's
        // "waiting for payment" states.
        setTimeout(() => {
          state.balanceMsats += amountMsats;
          persist();
          notifyBalance();
        }, MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS)));
        return { invoice, operationId: opId };
      },
      async payInvoice(_bolt11: string) {
        // We don't currently parse the bolt11 amount in sim — LN-out
        // in the trade flow goes through wallet.mint.spendNotes
        // (lockAndPublish), not through payInvoice. The sandbox-fund
        // path is the only payInvoice caller and it's not part of the
        // trade-critical path. Real-amount-deduction would require
        // bolt11 parsing; the testnet mock punts on this for the same
        // reason and the world hasn't ended.
        await simDelay();
        return { operationId: `sim_pay_${Date.now()}` };
      },
    },

    federation: {
      async getFederationId() { return SIM_FEDERATION_ID; },
      async getInviteCode() { return SIM_INVITE; },
    },

    async cleanup() {
      subscribers.clear();
      open = false;
      // Note: we deliberately do not reset state.joined or balance on
      // cleanup. cleanup() runs on tab close / hot reload; the persisted
      // state must outlive it.
    },
  };
}
