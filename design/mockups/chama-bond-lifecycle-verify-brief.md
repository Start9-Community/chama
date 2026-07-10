# CC Brief — Independent adversarial pass: bond custody lifecycle (`lifecycle.ts`)

**Mission.** An INDEPENDENT adversarial verification of `src/bond-multisig/lifecycle.ts` — the pure state
machine (CREATE → LOCK → return / strand → restore) that is the multisig REPLACEMENT for the SSS/vote-
envelope bond custody. It was written by the **verifier chat**, so it is unverified by anyone but its author.
**Try to BREAK it, not confirm it.** Distrust the builder's account and the builder's own tests; write your
own. Leave everything **uncommitted**. Signet/tiny-sats posture; **you do NOT move money.**

## Why this matters
This is the layer that finally moves **real, long-lived, multi-party custody** through a lifecycle. It sits
on two already-passed modules — `multisig.ts` (custody core, verifier-PASSED) and `attestation.ts` (keystone,
CC-PASSED). If a lifecycle transition lets the owner move the bond alone, or lets a return reach a non-owner,
or lets a strand be escaped without a 2-of-3, the whole bond is theater.

## Read first
- `src/bond-multisig/lifecycle.ts` — the module under test.
- `src/bond-multisig/multisig.ts` + `attestation.ts` — the primitives it composes (both already passed;
  `chama-bond-multisig-VERIFIER-REVIEW.md`, `chama-bond-attestation-verify-brief.md`).
- `chama-bond-mvp-multisig-brief.md` (**LOCKED** + "Lifecycle" section) — the authoritative CREATE/LOCK/
  return/strand/restore semantics; and `chama-arbiter-bond-phase2-brief.md` §11.8 (restorative strand),
  §11.1 (the collusion residual), §11.5 (NO owner recovery — locked).
- The SSS lifecycle being replaced (for contrast / dual-path check): `sim/bond-rig.ts`, the `bond CREATE/LOCK`
  + `holder-only-v1` path in `escrow-engine/state-machine.ts` + `escrow-engine/holder-shares.ts`.
- The builder's tests to distrust + exceed: `tests.ts` block `5b-BONDLC`; standalone
  `tmp/verifier-lifecycle-probe.ts`.

## How to run
On the Mac, `npm test` runs the suite via tsx; `npm run predeploy` adds `tsc --noEmit`. Write your own
adversarial cases as a fresh scratch file. *(The Linux-sandbox esbuild snag in the builder's probe does not
apply on the Mac.)*

## The builder's claims — try to FALSIFY each
1. **"No owner self-return, EVER."** From LOCKED and from STRANDED, find ANY sequence that produces a
   broadcastable return the owner alone authorized. Attack `finalizeReturn` (does it truly require m sigs? try
   the owner's sig duplicated, an owner sig + a garbage PSBT, an owner sig under a lied sighash). Confirm
   `combineAndFinalize` is the only path to a raw tx and it can't be reached below threshold.
2. **"Strand is permanent without a custodian."** From STRANDED, find any transition that returns funds
   without a real 2-of-3. Confirm there is NO owner-recovery path and no timelock escape (the locked decision
   is: owner never alone). Try re-strand, strand→lock, strand→create.
3. **"Return only to the owner."** Get `verifyReturnProposal` to pass a PSBT paying anything other than the
   recorded `ownerReturnAddress` — a third address, a second (siphon) output, an inflated fee, a swapped UTXO,
   a blank-check sighash. (It wraps `verifyReturnPsbt`; confirm the wrapper binds to the RECORDED state, so a
   caller can't pass attacker-chosen expectations.)
4. **"CREATE is keystone-gated."** CREATE an unsound bond: a non-cabinet custodian, m<2, a stale/unattested/
   revoked key, a tampered descriptor (address or script), a return address == the bond address or one that
   doesn't decode, a non-positive amount, an empty/inverted term. All must reject BEFORE any state exists.
5. **"LOCK integrity."** Lock a UTXO that funds a DIFFERENT address (the `fundingScript` guard — see contract
   below), a wrong amount, an expired term, from the wrong phase, or twice. Confirm each rejects.
6. **"Restore = a late co-sign; the victim attestation INFORMS, never COMPELS."** Prove `madeWholeSignal`
   changes no state and triggers no return; find any path where an attestation (or its absence) auto-heals or
   blocks a legitimate custodian co-sign. Confirm a paid victim who refuses to sign cannot strand the owner
   (the cabinet still acts).
7. **"Phase integrity."** No double-return (recordReturn twice), no return from CREATED/RETURNED, no strand of
   a live or returned bond, no re-lock. Try to drive the state machine into an inconsistent state.
8. **"Purity / no dual custody path."** Confirm the module imports/mutates the escrow engine NOT AT ALL, and
   that the same bond can't be simultaneously SSS-custodied and multisig-custodied (the SSS path is a separate
   lifecycle; this one is standalone). Flag any place they could collide once wired.

## Load-bearing CONTRACTS for the wiring layer (verify they're stated + necessary, like attestation's verify-stub)
- **LOCK `fundingScript` must be the REAL on-chain output script** at (txid, index), read from the confirmed
  funding tx — not `bond.script` re-passed. The check is only meaningful if the wiring passes the true script.
- **`recordReturn` trusts the caller's txid** (post-broadcast). The wiring MUST broadcast exactly
  `finalizeReturn`'s raw tx and record that txid. The module cannot verify broadcast.
- **No key custody / no broadcast in the module** — co-signing and broadcast happen at the edges.
- **Same-seed dependency** (carried from attestation): the bond key derives from the Fedimint BIP-39 mnemonic.

## Out of scope (don't build; note if blocking)
The **live-engine wiring + SSS removal** (replacing the `bond CREATE/LOCK`/holder-shares path with this
module — fund-critical state-machine surgery, its own step), Nostr NIP-44 transport, the funding rail
(ecash→on-chain / Boltz), the Mutinynet signet harness.

## Report back
Per claim: **PASS/FAIL + the adversarial test that proves it**. Any NEW gap with a minimal repro. A
**verdict**: is the lifecycle core sound enough to wire into the live engine (and remove SSS) on? Note whether
full `predeploy` `Results:` came up green on the Mac.

## Posture
`BONDS_ENFORCED` stays **false**. Signet / tiny-sats only, supervised. **The verifier does NOT move money.**
Test-cabinet seam stays **DEV-only**. Confirm-first on anything fund-critical/irreversible. Leave uncommitted.
