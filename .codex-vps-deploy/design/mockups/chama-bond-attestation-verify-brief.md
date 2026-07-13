# CC Brief — Independent adversarial pass: bond key attestation + keystone (kind 38132)

**Mission.** An INDEPENDENT adversarial verification of `src/bond-multisig/attestation.ts` — the kind-38132
attestation primitive + `verifyMultisigKeystone`. It was written by the **verifier chat**, so it is right
now *unverified by anyone but its author*. **Your job is to try to BREAK it, not to confirm it.** Distrust
the builder's account and the builder's own tests; re-derive the guarantees yourself and write your OWN
adversarial cases. Leave everything **uncommitted**. Signet/tiny-sats posture unchanged; **you do NOT move
money.**

## Why this matters
Bond custody is a 2-of-3 Taproot multisig (`multisig.ts`, already verifier-PASSED — see
`chama-bond-multisig-VERIFIER-REVIEW.md`). It is built from an ORDERED LIST of x-only BTC keys; this
attestation layer is the **keystone** that ties each on-chain key to a real cabinet identity. If the keystone
is wrong, an attacker's key can be seated behind a valid-looking threshold and "the owner can't self-return"
becomes theater.

## Read first
- `src/bond-multisig/attestation.ts` — the module under test.
- `src/bond-multisig/multisig.ts` + `chama-bond-multisig-VERIFIER-REVIEW.md` — the custody core it builds on.
- `chama-bond-mvp-multisig-brief.md` (**LOCKED** section) — the authoritative spec: kind 38132, npub binds
  its BTC key + a Schnorr cross-sig (possession), term-gated/replaceable, BIP86 from the existing seed, keys
  = an attested, npub-bound ordered list (NOT the buyer/seller/arbiter role map).
- `chama-bond-multisig-STATUS.md` — state + the "Verifier's open items" for attestation.
- Siblings the module deliberately mirrors: `src/arbiters/bonds.ts` (38130), `victim-attestation.ts`
  (38131), `src/arbiters/pool.ts` (`cabinetPubkeysForCommunity`, the DEV-only test-cabinet seam),
  `src/fedimint/seed-manager.ts` (the BIP-39 mnemonic the bond key derives from).
- The builder's tests, to distrust + go beyond: `tests.ts` block `5b-BONDATT`; standalone
  `tmp/verifier-attestation-probe.ts` (31 cases). **Do not just re-run these — write new ones.**

## How to run
On the Mac, `npm test` runs the whole suite via tsx; `npm run predeploy` adds `tsc --noEmit`. Put your
adversarial cases in a fresh tsx scratch file (or a temporary `tests.ts` block). *(The Linux-sandbox
esbuild-platform snag mentioned in the builder's probe does NOT apply on the Mac — ignore it.)*

## The builder's claims — try to FALSIFY each (this is the pass)
1. **"Both sigs are load-bearing."** Forge an event with a valid Nostr sig but a bad/absent BTC cross-sig →
   must reject; and the reverse. If EITHER signature alone yields a successful parse, that's a break.
2. **"Possession is identity-bound."** Take a REAL cross-sig that npub A made for itself and get it to
   verify under a different npub / key / term. The binding is
   `DOMAIN"\n"npub"\n"btcKey"\n"termStart"\n"termEnd` → sha256 → BIP340. Hunt for: field-boundary ambiguity
   (can two different tuples serialize/hash equal?); missing domain separation (could this Schnorr sig double
   as a valid signature for a Nostr event, a PSBT/Taproot sighash, or another kind?); the term not actually
   committed (replay across terms).
3. **"Stale keys are impossible to use."** After a rotation, get `currentAttestedKey` /
   `selectLatestKeyAttestation` to return the OLD key. Attack the selector: equal `created_at` ties,
   reordered arrays, a higher-`created_at` but out-of-term event, an older event resurfacing. Confirm the
   tie-break (newest `created_at`, then lexicographically smallest event id) matches `bonds.ts`/roster
   **exactly** — a divergence is a bug.
4. **"Revocation clears the key."** Bypass a tombstone. Can anyone OTHER than the member revoke (signer
   check)? Does a future-dated, malformed, or re-attested-after revocation mis-resolve? Is the "no-expiry"
   revocation semantic exploitable (e.g., a stale revocation wrongly dominating, or a fresh key attestation
   failing to override it when it should)?
5. **"The keystone can't be fooled."** Construct a `multisig` + `signerNpubs` that PASSES
   `verifyMultisigKeystone` but is unsafe. Try: **m=1 / m=0** (owner-alone spend); a tampered `address` or
   `script` with honest keys; the owner smuggled into a custodian slot, or occupying 0 or 2 seats; a
   non-cabinet custodian; a stale/revoked seat; a positional key↔npub swap; duplicate npubs; an empty or
   dev-only cabinet; passing a stubbed `options.verifyEvent` to skip the Nostr check. **The builder ADDED
   `m ≥ 2` and address-recompute during self-review — verify those actually hold and can't be bypassed** (do
   not take them on faith).
6. **"parse never throws / fails safe."** Feed malformed JSON, missing/extra fields, wrong types, non-hex,
   wrong-length keys/sigs, huge inputs, duplicate tags → must return `null`, never throw, never accept.
7. **"Derivation is correct + separate."** Confirm the BIP86 path (coin type 1 signet / 0 mainnet),
   determinism, and — important — that `m/86'/…'` does NOT collide with how the Fedimint wallet derives from
   the SAME mnemonic (`seed-manager.ts`). Flag the same-seed dependency (one seed compromise = bond key +
   Fedi wallet) for Jetty even if you judge it acceptable.

## Also check
- Kind **38132** is collision-free repo-wide (vs 38100–38131 and anything else).
- **No accidental DUAL custody path.** The module is wired into nothing yet — the OLD SSS keystone at LOCK
  (`BOND_CUSTODIAN_NOT_CABINET`) is still the only live one. Confirm nothing here makes both reachable.
- @noble/@scure **2.0.x** pins are consistent (schnorr from `@noble/curves/secp256k1.js`, sha256 from
  `@noble/hashes/sha2.js`, `@scure/btc-signer@2.0.1`); no second crypto stack sneaks in.
- The `p2tr_ms as unknown as` cast note carried over from the custody core.

## Out of scope (don't build; note if blocking)
Lifecycle wiring (CREATE/return/strand/restore over the multisig), Nostr NIP-44 transport, the funding rail
(ecash→on-chain / Boltz), the Mutinynet signet harness. Those come AFTER this pass.

## Report back (what Jetty brings to the verifier chat)
For each of the 7 claims: **PASS/FAIL + the adversarial test that proves it** (paste the case). List any NEW
gap with a minimal repro. End with a **verdict**: is the attestation layer sound enough to build the
lifecycle on, or does it need fixes first? Note whether the full `predeploy` `Results:` line came up green
(the builder couldn't capture it in-sandbox — the slow relay-timeout tail wasn't run to completion).

## Posture
`BONDS_ENFORCED` stays **false**. Signet / tiny-sats only, supervised. **The verifier does NOT move money.**
The test-cabinet seam stays **DEV-only** (never weaken the prod keystone). Confirm-first on anything
fund-critical or irreversible. Leave changes uncommitted (Jetty does the git split).
