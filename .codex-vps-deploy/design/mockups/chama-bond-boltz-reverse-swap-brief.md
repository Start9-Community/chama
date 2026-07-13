# Chama bond — Boltz reverse-swap funding (v2, the private rail)

**Status:** researched integration brief (2026-07-03), built from the Boltz v2 docs. No code yet.
This is the ⛔ real-sats rail (no public Boltz testnet), so it lands as a **testable no-sats core +
gated live execution Jetty drives**. It feeds the SAME fund-watcher + `lockBondCustody` as v1/v3.

## Where it sits

The three funding rails, all landing an on-chain UTXO at the recomputed 2-of-3, all feeding one
watcher+lock:

| Rail | Path | Convenience | Privacy | 2M LN cap? |
|------|------|-------------|---------|-----------|
| v3 peg-out (built) | LN→ecash→peg-out→2-of-3 | highest (in-app) | low (fed→addr on-chain) | yes (LN-in hop) |
| v1 direct (built) | your wallet→2-of-3 | — | medium (your coins) | **no** (pure on-chain) |
| **v2 Boltz (this)** | LN/ecash→Boltz reverse swap→2-of-3 | medium | **highest** (UTXO originates from Boltz's swap) | yes, unless paid via external NWC |

Boltz's privacy edge: the funding UTXO is a **Boltz swap output**, so on-chain there's no link back
to your fed or wallet. Paid from an external NWC wallet, it also dodges the fed's 2M gateway cap.

## The flow (Reverse Submarine Swap = Lightning → chain), verified against the v2 docs

1. **Client invents the secret.** Generate a 32-byte preimage `p`; `H = SHA256(p)`. Generate a claim
   keypair `C`. Send only `H`, `C`, and the amount to Boltz (`POST /v2/swap/reverse`).
2. **Boltz returns** a **hold invoice** (settles only once `p` is revealed), its pubkey `B`, the
   Taproot **lockup address** (Musig2 of `C`+`B` tweaked by the swap tree), a timeout, and the tree.
3. **⭐ Recompute-don't-trust** (Boltz has a whole "Don't trust. Verify!" doc for this): rebuild the
   lockup address locally from `C`, `B`, `H`, timeout and check it matches; check the invoice's
   amount and that its payment hash **is** `H`. Never trust Boltz's returned address/invoice blindly.
4. **Pay the hold invoice** — via **NWC** (the user's Alby/NWC wallet; keeps the fed gateway + its 2M
   cap out) or the fed's LN gateway. Boltz now *holds* the payment (state `transaction.mempool` comes
   next), unable to settle without `p`.
5. **Boltz locks up on-chain** → `transaction.mempool` → `transaction.confirmed`.
6. **Claim straight to the bond 2-of-3.** Build a claim tx spending the swap UTXO whose **output is
   the bond address**. Cooperative path (normal): send `p` + a partial sig to Boltz, Boltz returns its
   partial, do the Musig2 **key-path** spend (cheap, private — `p` never hits the chain). Fallback:
   **script-path** claim revealing `p` (always available while Boltz's lockup is spendable).
7. **Boltz settles the LN** (`invoice.settled`) with `p`. The claim tx confirms; the fund-watcher
   sees the confirmed UTXO at the bond address → `lockBondCustody` → LOCKED. Done.

**Fail-safe (matches Chama's ethos), from the state table:**
- Boltz can't lock after you paid → `transaction.failed`, the pending LN HTLC is **cancelled, sats
  bounce back, no fee**.
- You pay but never claim → Boltz **self-refunds** its lockup (`transaction.refunded`); your held LN
  invoice expires and returns. Worst case is a timeout, never a loss.

## Build shape — SDK-wrapped, testable core + gated live leg

**Use the official Boltz SDK / `boltz-core`** for the Musig2 aggregation + claim-tx construction —
do NOT hand-roll the swap tree or Musig2 (the docs steer integrators to the SDK; hand-rolling the
tweak is exactly where funds get stuck). Chama wraps it.

- **`boltz-reverse-swap.ts` — testable no-sats core** (injectable HTTP, like `fund-watcher.ts`):
  preimage/hash generation, the `POST /v2/swap/reverse` request body, and the **recompute-don't-trust
  checks** (lockup address rebuilt locally == returned; invoice hash == `H`; invoice amount; the
  claim destination == the bond's own 2-of-3). All unit-testable against a fake Boltz response with
  zero sats and no network — this is where the security lives, so it gets the tests.
- **Live leg (gated, Jetty-driven):** the actual `create → pay-via-NWC → poll state → SDK-claim →
  broadcast` wiring. Real sats, so it sits behind the ceremony's funding options with a
  moves-real-sats confirm, and its first exercise is **self-hosted regtest** (full control, no real
  sats) then **one tiny mainnet swap** (the true go-live — Boltz killed public testnet).
- **Reuse:** the resulting UTXO feeds the existing `findBondFundingUtxo` + `lockBondCustody` +
  `minConfs` — Boltz is just another *source*; the watcher/lock is unchanged.

## Open questions before the live leg

- **Musig2 in our stack:** confirm `boltz-core`/SDK bundles cleanly into the Tauri/Android build (its
  crypto deps vs. our `@scure` stack); if the SDK is heavy, lazy-import it (same idiom as cobe/QR).
- **NWC payment of the hold invoice:** wire to the user's existing NWC path (Jetty's default) so the
  fed gateway (and its 2M cap) stays out; fall back to the fed gateway only if no NWC.
- **Amount math:** request the on-chain output = the exact bond amount; the LN invoice = output +
  Boltz service fee + claim miner fee. Land the bond amount exactly (what `lockBondCustody` needs).
- **Claim liveness:** the client must claim before the timeout (else refund). A background watcher on
  `transaction.confirmed` → auto-claim; surface a clear "reclaiming" state if it lapses.

## Sources
- [Boltz — Swap Types & States (reverse swap lifecycle)](https://api.docs.boltz.exchange/lifecycle.html)
- [Boltz — Claims & Refunds](https://api.docs.boltz.exchange/claiming-swaps.html)
- [Boltz — Don't trust. Verify!](https://api.docs.boltz.exchange/dont-trust-verify.html)
- [Boltz — Clients, SDKs & Libraries](https://api.docs.boltz.exchange/libraries.html)
