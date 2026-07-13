# CC brief — commitment bond: on-chain verification + UI/UX consolidation

**For CC.** The verifier chat built + wired the single-key **timelock commitment** bond and proved its
core on Mutinynet (a live reclaim confirmed). But the ceremony UI was iterated *reactively* against a
flaky testnet explorer and has accumulated funk. Two asks, one pass:

- **Part A — independently VERIFY the on-chain correctness** (the assurance Jetty wants).
- **Part B — REBUILD the ceremony UI/UX cleanly** (kill the reactive-patch funk properly).

Division: CC does both; the verifier chat hashes CC's results (same pattern as the 2-of-3 work).
Constraints throughout: `BONDS_ENFORCED` stays false; `SHOW_BOND_CEREMONY` is dev-only; **signet/
Mutinynet test sats only, never real sats**; leave changes uncommitted (Jetty does the git split).

## The model (what "commitment bond" is)

An arbiter locks THEIR OWN sats to THEIR OWN key until a term-end block height T. One Taproot leaf,
NUMS internal key (key-path dead), so every spend goes through:

    <T> OP_CHECKLOCKTIMEVERIFY OP_DROP <ownerXonly> OP_CHECKSIG

Collusion-impossible by construction (no cabinet, no shared custody). Deterrent = locked capital +
reputation + non-renewal (PHILOSOPHY §2.11, DECISIONS 2026-07-03). It is a COMMITMENT signal, not a
seizure pool. Reclaim = owner-alone, after T, sweeping every UTXO at the address to the owner's key.

Files: `src/bond-multisig/commitment-bond.ts` (module), `commitment-store.ts` (store),
`fund-watcher.ts` (funding + tip + broadcast), `src/hooks/useEscrow.ts` (3 actions:
`createCommitmentBond`, `checkCommitmentFunding`, `reclaimCommitmentBond`, + `getBondChainTip`),
`src/ui/panels/BondCeremonyModal.tsx` (ceremony), `scripts/mutinynet-commitment-harness.ts` (harness),
tests `5b-BONDCLTV` + `5b-BONDCOMMIT` in `src/escrow-engine/tests.ts`.

## Part A — on-chain verification (adversarial pass)

**The three invariants to hammer** (the harness proved 1+2 once each; make them bulletproof):
1. **Spend BEFORE T → REJECTED by consensus.** A reclaim with `nLockTime < T` (or broadcast while the
   tip < T) must be rejected (`-26` "Locktime requirement not satisfied" / non-final). Confirm on
   Mutinynet + assert the tx *builds* but consensus refuses it.
2. **Spend AFTER T → ACCEPTED.** Once tip ≥ T, the owner-signed reclaim confirms. (Jetty did this
   live: reclaim `74c2ebbb…abf29d`, Locktime = the unlock block.)
3. **ONLY the owner can ever spend.** No key-path (NUMS), and the script requires the owner's sig.
   Assert a wrong key cannot produce a spendable witness; assert there is no other leaf.

**Reclaim-tx construction checklist** (`buildReclaimTx`):
- Multi-UTXO **sweep**: N inputs (all the same leaf), one output = Σamounts − fee, `nLockTime =
  lockUntil`, each input `sequence = 0xfffffffe` (so nLockTime is enforced). Witness per input is
  hand-assembled `[sig, leaf, controlBlock]` (@scure won't finalize a custom leaf). Verify a REAL
  multi-input reclaim confirms on Mutinynet (fund the address 2–3×, then one reclaim sweeps all).
- **Fees**: currently a flat `300n`. Verify it's sane vs. tx vsize at 1 sat/vB, and that a large
  multi-input sweep doesn't underpay. Consider size-based fee estimation.
- **Recompute-don't-trust**: `buildCommitmentBond`/`recomputeCommitmentAddress` deterministic;
  `commitment-store` deserialize REJECTS a record whose stored address doesn't reproduce from
  (ownerXonly, lockUntil, network) — confirm the tamper gate holds.
- **Broadcast path** (`esploraBroadcast`) surfaces the node's rejection reason; the reclaim translates
  a genuine too-early/non-final rejection into a calm message. Confirm no double-spend / no
  broadcast-then-lost-state hole (the store flips to `reclaimed` only after a txid returns).

## Part B — UI/UX rebuild (the funk, fixed properly)

The reactive patches landed but the shape needs one clean pass. Known issues + the target:

- **Multi-bond flow is broken.** The ceremony resume picks the first `locked` bond and can't create a
  *new* one while one exists. Target: a small **"your bonds" list** (post another · each shows
  status/amount/term/countdown · reclaim each), not a single-bond funnel.
- **Funding = ONE on-chain address/QR, any source. Do NOT expose "peg out from your Chama balance" or
  any in-app funding mechanism (LOCKED, Jetty 2026-07-03).** Chama is Option B (PHILOSOPHY §2.1): no
  persistent balance — funding only exists atomically inside a trade — so "peg out from your Chama
  balance" is *wrong*, not just scary (there's no standing balance to peg out), and it implies a wallet
  Chama deliberately isn't. The bond address is a **universal endpoint**: any wallet, exchange, a Boltz
  claim, a manual peg-out — all just *send to the address*, so one QR covers every path implicitly. Copy
  stays plain: "Send X sats or more to this address from any Bitcoin wallet." Don't mention ecash. (This
  is *why* `bondPegoutFees`/`fundBondViaPegout` are on the vestigial-removal list — they don't fit the
  bond's Option-B funding.)
  - **Optional future (captured, not v1):** the reclaim is an on-chain spend to the owner's own key. A
    nice symmetric option later — let the reclaim pay directly into an on-chain→LN submarine swap so the
    arbiter's sats arrive back on Lightning in one step "if they want" (Jetty). Not needed for v1; the
    core reclaim stays plain on-chain, self-custody, no fed.
- **Funding detection** — now accepts any amount + multiple UTXOs + signet-`minConfs=1` (fixed), but
  make it **auto-poll** on the funding screen (Jetty: "it should detect automatically") instead of a
  manual button, with a clear "found N deposits totaling X" state.
- **Countdown/tip** against Mutinynet's **load-balanced, jittery** Esplora: keep it monotonic +
  network-authoritative reclaim (done reactively — bake it in cleanly). Don't gate critical buttons on
  a single jittery height read.
- **Reclaim is a deliberate, confirmed action** (guard just added: primary button is "Done", reclaim
  is secondary + a "Yes, reclaim" confirm). Keep that; never make reclaim the reflexive primary.
- **Minimum term**: a 10-block (~5 min) term can EXPIRE before the user finishes funding, so the bond
  locks already-reclaimable (confusing, and defeats "commitment"). Enforce a sane minimum (and/or warn
  if the term would elapse near funding time).
- **Copy buttons**: a reusable `src/ui/components/CopyButton.tsx` exists ("✓ Copied!" feedback) —
  sweep it across the ~14 remaining `navigator.clipboard.writeText` sites app-wide (Jetty's "animate
  all of them").
- **Vestigial 2-of-3 removal** (queued): delete the dead test blocks `5b-BONDATT/LC/TX/STORE` + the 6
  dead hook actions (`createBondCeremony`, `publishBondKeyAttestation`, `discoverCustodianBonds`,
  `checkBondFunding`, `bondPegoutFees`, `fundBondViaPegout`), then `git rm` the orphan files
  (`attestation.ts`, `bond-transport.ts`, `lifecycle.ts`, `custody-store.ts`,
  `BondCustodyInboxModal.tsx`, `mutinynet-bond-harness.ts`). **Keep `multisig.ts`** — the commitment
  bond still imports its types (SIGNET/BtcNetwork/BondUtxo). Verify the full suite after each removal.

## Acceptance

- Part A: the three invariants confirmed on Mutinynet (incl. a real multi-input sweep) + the reclaim
  checklist green + tests extended. A short findings report the verifier can hash.
- Part B: one clean ceremony (multi-bond list, auto-poll funding, robust countdown, confirmed reclaim,
  min-term, copy sweep) + vestigial removal, `predeploy` green, `SHOW_BOND_CEREMONY` still dev-only.
- Nothing moves real sats; nothing is committed.
