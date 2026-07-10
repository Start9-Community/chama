# Chama bond — Mutinynet live-attack runbook

**Purpose.** Prove the 2-of-3 bond custody against a *real, independent* Bitcoin
network — Mutinynet signet, test sats, no value — not just against @scure's library.
The library tests (2944 green) show *our* code enforces the threshold; this shows the
*network's* consensus enforces it too, using the exact shipping module
(`src/bond-multisig/multisig.ts`). When Mutinynet rejects the owner-alone spend, the
"owner can never self-return" invariant stops being a claim we make and becomes a fact
the network enforces.

**Division of labour.** The harness (`scripts/mutinynet-bond-harness.ts`) *builds* the
transactions from the trio's keys + a funding UTXO. **You drive the funding (faucet) and
the broadcast.** Every `spend` prints the raw hex *and* a paste-ready `curl`, so you can
broadcast from any machine even if the build box has no network.

> ⚠ **Signet test keys / test sats only.** The keyfile
> (`scripts/.mutinynet-bond-keys.json`, gitignored) holds throwaway keys. Never put a
> real-fund key in it. `BONDS_ENFORCED` stays `false` in the app throughout — this is
> validation, not custody. This is the last step *before* the funding-rail work, and it
> touches no app code and no real sats.

## Setup

From the repo root:

```
node --experimental-strip-types scripts/mutinynet-bond-harness.ts address
```

This prints three addresses: the **2-of-3 bond address** (fund this), the **owner-return
address** (where returns/restores land), and a **third-party address** (the residual
destination). Roles are fixed: owner = key 0, custodian A = key 1, custodian B = key 2.

Fund the **bond address** from the faucet — https://faucet.mutinynet.com/ — a few times
(you'll want ~4 separate UTXOs to walk the whole matrix; ~20k sats each is plenty).
Mutinynet mines ~30s blocks, so confirmations are quick. Then:

```
node --experimental-strip-types scripts/mutinynet-bond-harness.ts utxos
```

lists each `txid:vout value` at the bond address. You feed those into `spend`.

## The six-row matrix

Each `spend` builds one scenario against one UTXO you name. Build → broadcast the printed
`curl` (or `... broadcast <hex>`) → record the result. A spend **consumes** its UTXO on
acceptance, so the sequencing below reuses UTXOs where a scenario leaves them intact.

| # | Scenario | Command (`spend …`) | Expected | Proves |
|---|----------|---------------------|----------|--------|
| 1 | ⭐ **owner-alone** | `spend owner-alone <utxo1>` | **REJECTED** | owner acting alone (1-of-3) cannot move the bond — consensus refuses it |
| 2 | **return** (O+A→owner) | `spend return <utxo1>` | ACCEPTED → owner | owner + one custodian returns the bond to the owner |
| 3 | **restore** (A+B→owner) | `spend restore <utxo2>` | ACCEPTED → owner | the two custodians restore to the owner *without* the owner's key |
| 4 | **residual** (A+B→third) | `spend residual <utxo3>` | ACCEPTED → third | §11.1 honest residual: custodians divert to a made-whole payee, on-chain visible |
| 5 | **strand** | *(broadcast nothing)* | UTXO sits unspent | with no co-signer, `utxo4` stays frozen — owner still can't touch it |
| 6 | **restore-after-strand** | `spend restore <utxo4>` | ACCEPTED → owner | a late co-sign unfreezes the stranded bond — reversibility holds |

`<utxoN>` is one whole **`txid:vout`** token copied straight from the `utxos` list
(e.g. `b2027ae1…5a83:1`); the amount is auto-fetched. So a row is literally:
`spend owner-alone b2027ae1…5a83:1`. (You can still pass `<txid> <vout> <amountSats>`
as three explicit args if you ever want to.)

The headline is rows **1 → 2 on the same UTXO**: broadcast owner-alone, watch Mutinynet
reject it, then broadcast the co-signed return against the *same still-unspent* UTXO and
watch it confirm. Rejected-then-accepted on one funding is the whole thesis in two commands.

### Reading the results

- **Acceptance** — `broadcast` prints `✅ ACCEPTED — broadcast txid: …`. Confirm it with
  `status <txid>` (`confirmed: true` after a block) or on the explorer at
  `https://mutinynet.com/tx/<txid>`.
- **Rejection** (the expected owner-alone result) — `broadcast` prints
  `⛔ REJECTED by Mutinynet …` with the node's reason, typically a
  `mandatory-script-verify-flag-failed` / script-eval error. That error *is* the proof:
  the network's script engine tallied one valid signature against a required two and
  refused the spend.
- **Strand** — after funding `utxo4`, just run `utxos`/`status` and confirm it remains
  unspent for as long as you like; there is simply no transaction that a single party can
  produce to move it. Then row 6 spends it with a real co-sign.

## What this does and doesn't cover

It covers the **custody guarantee** end-to-end on a live network: threshold enforcement,
the cabinet's owner-independent restore, the visible residual, and the strand/restore
reversibility — all from the shipping module. It deliberately does **not** touch the
**funding rail** (how ecash becomes the on-chain UTXO in production) or any real sats;
that is the next, Jetty-driven stage, and it should only begin once this matrix is green.

## One-glance command reference

```
scripts/mutinynet-bond-harness.ts address                              # addresses + faucet
scripts/mutinynet-bond-harness.ts utxos                                # list funding UTXOs
scripts/mutinynet-bond-harness.ts spend <scenario> <txid> <vout> <sats>  # build one tx
scripts/mutinynet-bond-harness.ts broadcast <rawhex>                   # send it (or use the printed curl)
scripts/mutinynet-bond-harness.ts status <txid>                        # confirmation status
```

(Prefix each with `node --experimental-strip-types`. Override the endpoint with
`MUTINYNET_API=…` or the fee with `BOND_FEE_SATS=…` if needed.)
