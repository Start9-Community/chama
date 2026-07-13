# Chama bond — commitment-bond Mutinynet runbook (the 7th-row proof)

**Purpose.** Prove the sealed **single-key timelock commitment** bond on a real network — the mirror
of the multisig harness's owner-alone Row 1, now for the commitment model:

- ⭐ **reclaim BEFORE term-end T → REJECTED by consensus** (CLTV: the coin cannot move early).
- **reclaim AFTER T → ACCEPTED** — the owner reclaims it, alone, no cabinet.

Reuses the shipping module (`src/bond-multisig/commitment-bond.ts`). Signet test sats only. You drive
funding + broadcast; the harness builds the transactions.

> **Run with tsx**, not `node --strip-types` (it imports `commitment-bond.js` → `multisig.js`; tsx
> resolves the `.js`→`.ts`):
> `npx tsx scripts/mutinynet-commitment-harness.ts <command>`

## Steps

1. **Print the bond address + term.**
   ```
   npx tsx scripts/mutinynet-commitment-harness.ts address
   ```
   It fetches the current tip and sets **T = tip + 6 blocks** (~3 min on Mutinynet), persisted in the
   gitignored keyfile. Copy the BOND address.

2. **Fund it** from the faucet — https://faucet.mutinynet.com/ — one small amount. Then:
   ```
   npx tsx scripts/mutinynet-commitment-harness.ts utxos
   ```
   (shows the UTXO + the current tip vs T).

3. ⭐ **Try to reclaim BEFORE T → expect REJECTED.** Copy the `txid:vout` token from `utxos`:
   ```
   npx tsx scripts/mutinynet-commitment-harness.ts reclaim <txid:vout> --early
   ```
   Broadcast the printed hex (or `... broadcast <hex>`). Mutinynet returns **⛔ REJECTED** —
   `non-mandatory-script-verify-flag ... Locktime requirement not satisfied` (the CLTV opcode). The
   coin is frozen. That rejection *is* the proof, and the UTXO stays untouched.

4. **Wait until the tip reaches T** (a few minutes — check `... tip` or `... utxos`).

5. **Reclaim AFTER T → expect ACCEPTED.** Same UTXO, no `--early`:
   ```
   npx tsx scripts/mutinynet-commitment-harness.ts reclaim <txid:vout>
   ```
   Broadcast it → **✅ ACCEPTED**, the sats land back at your own reclaim address. `... status <txid>`
   to confirm.

## What it proves

The whole commitment model on a live network, in two commands on one funding: **an arbiter's bonded
sats cannot move before the term ends, and after it, only the arbiter can reclaim them — alone, with
no cabinet and nothing to collude over.** Frozen-then-yours, the timelock's entire thesis.

(There is no "steal" row to run, unlike the multisig — because there is no one else who could ever
sign. Collusion-impossible by construction is the point.)

## Cleanup

Delete `scripts/.mutinynet-commitment-keys.json` to reset (or leave it — it's gitignored, test-key only).
