# Bond Multisig — RESUME HERE (build status + verifier handoff)

> ⚠️ **SUPERSEDED 2026-07-03 — the 2-of-3 cabinet-custody bond below was RETIRED.** A skeptic's
> adversarial pass proved it self-dealing among three founders (any two control all bonds; the MAD
> deterrent was cryptographically false). After reasoning to the root, the bond was redesigned as a
> **single-key TIMELOCK COMMITMENT**: each arbiter locks their OWN sats to their OWN key until term-end
> T (one Taproot CLTV leaf, no cabinet, collusion-impossible by construction). It's a *commitment
> signal*, not a seizure pool — deterrent = locked capital + reputation + non-renewal + trade caps.
> **BUILT + tested + harnessed 2026-07-03:** `src/bond-multisig/commitment-bond.ts` (module),
> `5b-BONDCLTV` (10 unit tests green, suite 2829✅), `scripts/mutinynet-commitment-harness.ts` +
> `chama-bond-commitment-runbook.md` (the "reclaim-before-T → REJECTED" proof, mirror of owner-alone
> Row 1). **The real decision + rationale: DECISIONS 2026-07-03 "BOND MODEL SEALED" + PHILOSOPHY §2.11
> + `chama-bond-collusion-closure-brief.md`.** Optional future teeth = Tier 2 (open stranger ceremony).
> Most of the 2-of-3 machinery below (attestation, descriptor transport, custody inbox, co-sign) is
> now vestigial — kept for reference / possible Tier-2 reuse, not the shipping bond. The fund-watcher
> + lock + the 3-npub e2e seam still apply (funding lands the same way).

**For a fresh chat picking up the cryptographic-custody bond work. Read this + the two docs it points
to + CC's memory, and you're current.**

**Last updated:** 2026-07-02 — custody core + attestation + lifecycle + SSS removal + Stage-2 coordination &
ceremony ALL DONE + verifier/CC-confirmed (`predeploy` 2944/0; trade engine byte-identical to HEAD; ceremony
flag-gated OFF). **Stage 3a (Mutinynet live-attack) ✅ COMPLETE — all six rows proven on a real independent
network**: owner-alone REJECTED by consensus, return/restore/residual ACCEPTED (distinct destinations verified
on-chain), strand held, restore-after-strand thawed it. The cryptographic bond spine is built + independently
verified + proven live + hard-stopped at the funding boundary, trade path untouched throughout. The custodian
receive-side **verification inbox is built** (2026-07-02; "Bonds you hold", recompute-don't-trust), and the
**Stage-3b v1 direct-on-chain fund-watcher is built** (Mutinynet-safe: confirmed-deposit → LOCKED, recompute-
don't-trust to the UTXO). **Next: Stage 3b real-sats funding** (a live deposit, or the Boltz v2 reverse-swap
integration — Jetty's ⛔ HARD STOP), which also lights up the receive-side co-sign-a-return flow (already
built + Mutinynet-proven, just needs a funded bond).

## The one-paragraph state
The SSS-of-bearer-notes bond had a foundational flaw — the funder holds the complete bearer ecash at
lock, so the owner can self-reclaim; "no-self-return" was a *request*, not a law (caught by a live-attack,
before any real sats moved). **Decision: Chama goes cryptographic.** The bond's custody is now a **2-of-3
(m-of-n) Taproot multisig** where the owner is 1-of-3 → Bitcoin consensus itself refuses an owner-alone
spend. CC has **built + proven the custody core**; attestation, lifecycle, Nostr coordination, and the
signet live-attack harness remain.

## Locked decisions (Jetty-confirmed, verifier-recommended)
1. **No owner recovery leaf** — owner can NEVER self-return (strand stays permanent); custodian-loss
   resilience via cabinet size. *(Irreversible per funded bond.)*
2. **Owner IS a signer** — flat 2-of-3 `[owner, custA, custB]`.
3. **2-custodian-collusion residual: accepted + documented** — same §11.1 residual (now on-chain visible);
   the live-attack matrix must prove it exists; cryptographic closure (nesting/FROST/module) is a later
   layer.
4. **Mutinynet** for the signet harness.

## Spec (research-decided)
- Address: **Taproot script-path `p2tr_ms`** (BIP342 `OP_CHECKSIGADD`, NUMS internal key) — mandatory.
  Generic m/n.
- Library: **`@scure/btc-signer@2.0.1`** (pinned — dedupes with the noble/scure 2.0.x family; NOT 2.2.0).
- Attestation: **Nostr kind 38132** — npub binds its BTC key + a Schnorr cross-sig (possession),
  term-gated/replaceable, BIP86-derived from the existing seed.
- Keys = an attested, npub-bound **ordered list** — NOT the buyer/seller/arbiter role map. Do NOT reuse
  `holder-shares.ts`.
- The **custodian PSBT checklist** is the real security layer (see Done).

## Done + green (uncommitted; typecheck clean; **CC independent pass: `predeploy` = 2914 passed / 0 failed on the Mac**; +1 script-regression test applied since → 2915, re-run to reconfirm)
- `src/bond-multisig/multisig.ts` — the custody core: build the Taproot m-of-n address from attested keys;
  **`recomputeAddress`** (verify-don't-trust); the return-PSBT flow (`buildReturnPsbt` → `coSignPsbt` →
  `combineAndFinalize`); **`verifyReturnPsbt`** (the custodian checklist).
- Proven with **real Bitcoin validation** (14 assertions): owner-alone (1-of-3) **cannot finalize** ⭐;
  owner+1 and both-custodians finalize; the checklist rejects blind-cosign-to-non-owner, fee-grief,
  wrong-UTXO, siphon-output, blank-check sighash; 3-of-5 works as config.
- **Verifier review of the custody core: PASSED** — see `chama-bond-multisig-VERIFIER-REVIEW.md` (independent
  17-case probe reproduced the headline + 3 attacks beyond CC's suite; five documented notes, no blockers).
- `src/bond-multisig/attestation.ts` — the ⭐ KEYSTONE + kind-38132 attestation (**built by the verifier
  chat, 2026-06-30 — so it OWES an independent pass, see below**). Binds each on-chain multisig key to a
  cabinet identity: build/parse/verify a 38132 event with **BOTH sigs** (Nostr event sig + a BIP340 **BTC
  cross-sig** = possession, *identity-bound* so it can't be lifted onto another npub); **term-gated +
  newest-wins** (rotation supersedes a stale key); a **revocation tombstone**; **BIP86** derivation of the
  bond-signing key from Chama's existing BIP-39 seed (`m/86'/1'/0'/0/0`); and **`verifyMultisigKeystone`**
  (each seat = the current in-term attested key of a distinct signer; custodians ∈ cabinet; owner in exactly
  one seat; **m ≥ 2** so the owner can't spend alone; **address recompute-don't-trust**). 19 adversarial
  assertions. **Two self-review catches folded in:** the keystone now rejects **m=1** (identity checks are
  worthless if the threshold lets the owner sign alone) and a **tampered descriptor address** (honest keys,
  attacker address).
- **CC independent adversarial pass (2026-06-30): PASSED** — all 7 claims held under fresh cases (both-sigs
  load-bearing, identity-bound cross-sig, stale/rotation/revocation, keystone m≥2 + descriptor integrity +
  cabinet gates, parse fails-safe on 11 malformed inputs, derivation correct/separate). `predeploy` **2914
  green** on the Mac. **Fixes applied post-review (by the verifier chat, this module's author):**
  (1) **GAP-1** — the keystone now recomputes the FULL descriptor (address **+ script**), not just the
  address (rebuild-and-compare the `BondMultisig`); a tampered `script` was self-DoS only, no theft, now
  closed + regression-tested. (2) **GAP-2, hardened past the recommendation** — removed the `verifyEvent`
  override from the keystone entirely, so the production gate can NEVER be stubbed (a stub would seat an
  attacker's key as a victim's); parse/select keep the injectable verify for unit tests only. (3) **dep
  hygiene** — `@scure/bip32` + `@scure/bip39` added as direct deps (2.0.1); were transitive-only.
  **Deliberately NOT changed:** the cross-sig binding stays a domain-prefixed `sha256` (CC assessed it
  sound) — a BIP340 tagged-hash is a possible *separately-reviewed* future hardening, not a unilateral
  post-review crypto change. **Flagged for Jetty:** same-seed dependency — the bond key BIP86-derives from
  the same BIP-39 mnemonic as the Fedimint wallet (paths don't collide, no key reuse, but one seed
  compromise = both).
- `src/bond-multisig/lifecycle.ts` — the **pure bond lifecycle** over the multisig (**built by the verifier
  chat, 2026-06-30 — owes a CC independent pass**; brief: `chama-bond-lifecycle-verify-brief.md`). The state
  machine that ties custody + keystone + victim-attestation into CREATE → LOCK → return / strand → restore,
  the multisig REPLACEMENT for the SSS/vote-envelope mechanic. ⭐ No owner self-return (keystone m≥2 at
  CREATE + `combineAndFinalize` threshold at finalize — the owner's lone sig can't produce a return tx);
  **strand permanent without a custodian** (no owner-recovery path, term-gated); **restore = a late 2-of-3
  co-sign** (flagged `restoredFromStrand`); the victim "made-whole" attestation **informs, never compels** a
  heal. CREATE is keystone-gated; LOCK requires the real funding output script (recompute-don't-trust); the
  return checklist is bound to the recorded UTXO/owner-address. ~30 adversarial assertions (probe +
  `tests.ts` `5b-BONDLC`), green in-suite. **Two self-review hardenings folded in:** LOCK's `fundingScript`
  is now **required** (a caller can't record a UTXO that funded a different address), and CREATE **validates
  the owner return address decodes** before any funding (fail fast — never fund a bond whose return address
  is unusable). PURE: funding/broadcast/NIP-44 transport/co-signing are edge seams; **touches the escrow
  engine not at all** (the SSS bond path still lives beside it — removal is the wiring step, below).
- **CC independent adversarial pass of the lifecycle (2026-06-30): PASSED** — all 8 claims held (no owner
  self-return from LOCKED or STRANDED, strand permanent, return-only-to-owner bound to recorded state,
  CREATE keystone-gated, LOCK integrity, victim-attestation informs-never-compels, phase integrity, purity).
  `predeploy` **2939 green** on the Mac. **Hardening applied post-review (verifier chat):** `finalizeReturn`
  now **re-checks the destination** (re-runs `verifyReturnPsbt` bound to the recorded UTXO/owner-address) and
  refuses to hand back a raw tx paying anyone but the owner — so the "return only to owner" invariant holds at
  the finalize layer too, not just the custodian's pre-sign step (defense-in-depth; does NOT close the §11.1
  two-custodian residual, which bypasses the module by broadcasting its own tx). +1 regression test.
  **Contracts CC verified as load-bearing (for the wiring):** LOCK gets the REAL on-chain funding script;
  broadcast-then-`recordReturn`; `verifyReturnProposal` must actually be called pre-co-sign.
- CC memory `project_bond_multisig.md` records the SSS custody as **KNOWN-BROKEN + superseded**.

## Remaining (toward the STOP point)
0. ~~Attestation primitive~~ — **DONE + CC-independent-PASSED**; 2 fixes + 1 hardening applied (see Done + green).
1. **Live-engine wiring + SSS removal** (brief: `chama-bond-wiring-sss-removal-brief.md`):
   - **Stage 0 (port the sim rig to the multisig lifecycle) — DONE + verifier-confirmed green.** `bond-rig.ts`
     drives CREATE→LOCK→strand→restore over `lifecycle.ts` with real PSBTs, no escrow-engine runtime import.
   - **Stage 1 (remove the SSS path from the escrow engine) — DONE + verifier-confirmed.** ⭐ The six engine
     files (`state-machine.ts` · `types.ts` · `recipients.ts` · `escrow-client.ts` · `arbiter-substitution.ts`
     · `escrow-bridge.ts`) are **byte-identical to HEAD** (`git diff HEAD` empty) — the trade engine is
     *provably* unchanged (the SSS bond additions were all uncommitted additive gates; stripping them reverts
     to the shipped v4.2.1 trade path). Zero live refs to `isBondEscrow`/`category==="bond"`/`bondCustodians`/
     `handleBondLock`/`bondTermSeconds`. `tests.ts` is **+366/−0** vs HEAD (multisig blocks only; SSS blocks
     gone). typecheck clean, 0 failures. **One-custody-per-bond achieved by CONSTRUCTION.** ⚠ Verifier caveat
     for Jetty: byte-clean-to-HEAD means any OTHER uncommitted non-bond work in those 6 files would also have
     reverted — confirm none was in flight.
   - **Stage 2 (BondCustody store + NIP-44 transport + ceremony UX) — DONE + green + verifier/CC-confirmed
     (2026-07-01).** Store (`custody-store.ts`, recompute-on-load tamper gate) + transport (`bond-transport.ts`:
     kinds **38133** descriptor-encrypted-to-trio + **38134** PSBTs; `verifyReceivedDescriptor` re-derives trust
     from live-fetched 38132 — never the wire) + relay adapters + the ceremony (two `useEscrow` actions —
     `publishBondKeyAttestation` [seed→38132] + `createBondCeremony` [keystone→descriptor→recomputed funding
     address] — + `BondCeremonyModal` on the Me tab, cabinet-gated, `SHOW_BOND_CEREMONY=false`). Hard-stops at
     the funding address (no sats). **CC's independent adversarial pass: 6 findings, all fixed + regression-tested;
     recompute-don't-trust held against every wire tamper.** Verifier-confirmed: opaque bondId (no address leak in
     the clear `d`-tag), encrypted content, the actions use the real seed→attest→keystone path, `predeploy`
     **2944/0**, and ⭐ the trade engine is STILL **byte-identical to HEAD** (bonds fully off the escrow engine).
     Decisions logged: `DECISIONS.md` 2026-07-01. **Custodian RECEIVE-side inbox — ✅ BUILT 2026-07-02**
     (`BondCustodyInboxModal.tsx` "Bonds you hold" on the Me tab, same `SHOW_BOND_CEREMONY`+cabinet gate as
     the ceremony): `discoverCustodianBonds()` (useEscrow) queries 38133 descriptors `#p`-tagged to me,
     decrypts each, and RECOMPUTES-DON'T-TRUST — rebuilds the 2-of-3 from the trio's LIVE-fetched 38132
     attestations + keystone; verified bonds store + show the locally-recomputed address, rejected ones show
     the reason + aren't stored. Typecheck clean; the security path (`verifyReceivedDescriptor` tamper matrix)
     is covered by 5b-BONDTX; `predeploy` green (2808 assertions ✅, 0 fail). **Still owed at Stage 3 (rides
     funding):** the co-sign-a-RETURN flow — `verifyReturnProposal` → `coSignPsbt` → publish a 38134 partial;
     built + tested + Mutinynet-proven in the lifecycle, but there's no funded bond to co-sign for until 3b.
   - **Stage 3a (Mutinynet live-attack gate) — ✅ COMPLETE: ALL 6 ROWS PROVEN on-network 2026-07-02.**
     On UTXO `b2027ae1…5a83:1` (100k signet sats): ⭐ **owner-alone REJECTED by Mutinynet consensus** —
     `-26 mempool-script-verify-flag-failed ("finished with a false/empty top stack element")` = CHECKSIGADD
     tallied 1 valid sig, OP_NUMEQUAL vs required 2 pushed false. Then the **co-signed return ACCEPTED**
     (txid `b5d21f3ced1a83ce…`). Telling detail: the rejected owner-alone shares that SAME txid (identical
     tx body — same input/output/amount) but a different wtxid (`954a834f…`); the ONLY difference between
     rejected and accepted is the witness signatures. **Row 3 restore ACCEPTED** (txid `44f9183f…`, A+B→owner,
     no owner key) + **Row 4 residual ACCEPTED** (txid `e52f3743…`, A+B→third party) — destinations verified
     on-chain: restore's output = owner-return scriptPubKey, residual's = the distinct third-party one, so the
     cabinet provably controls where a bond goes. **Row 5 strand**: UTXO `8239cb77…a33a9:1` sat unspent
     (confirmed via `utxos` — no single party could produce a spend) → **Row 6 restore-after-strand ACCEPTED**
     (txid `954c9e9c…`, a late A+B co-sign thawed it). **ALL SIX ROWS GREEN — the full custody guarantee is
     enforced by Bitcoin consensus, not by our code.** Evidence txids above are on mutinynet.com. Signet test
     sats only; no app code, no real sats touched. The `scripts/mutinynet-bond-harness.ts` tool builds all six scenarios from the
     SHIPPING module (`multisig.ts`) + a funding UTXO — incl. the forged owner-alone (owner's real sig + blanked custodian
     slots + public script/cb; `combineAndFinalize` rightly refuses it, so the witness is hand-assembled).
     Constructions verified locally (owner-alone = 1 sig/303 B → will be rejected; the 3 valid spends = 2
     sig/367 B). Signet TEST sats only — no app code, no real sats. **Owed = Jetty's live run:** fund the
     2-of-3 via the faucet, broadcast each row, record the matrix (⭐ owner-alone REJECTED by consensus, then
     the same UTXO's co-signed return ACCEPTED). Runbook: `chama-bond-mutinynet-runbook.md`.
   - **Stage 3b (funding rail).** Decision brief: `chama-bond-stage3b-funding-rail-brief.md` — staged rails,
     all feeding ONE watcher+lock: **v1 direct on-chain** (Mutinynet-safe) → **v2 Boltz reverse swap** (LN→
     on-chain, paid via NWC so the fed gateway/#9 stays out of funding; regtest then tiny mainnet — Boltz
     killed public testnet) → **v3 fed peg-out** — **CODE-CONFIRMED ALREADY PLUMBED 2026-07-02** (native
     bridge `/onchain/withdraw` → `native-bridge-adapter` → `FedimintClient.withdrawOnchain(addr,sats)→{txid}`;
     the wallet module ships by default, LN is the add-on). Wired: `fundBondViaPegout`/`bondPegoutFees`
     (useEscrow) send the exact bond amount ecash→the 2-of-3, fund-watcher confirms+locks; ceremony "Fund
     from my Chama balance" button (fee preview + moves-real-sats confirm). Native-only (browser WASM lacks
     the module → falls back to direct-address). **minConfs reorg-safety added** (`defaultMinConfs`: 2 signet
     / 6 mainnet; too-shallow → keep polling; 3 tests). **v1 fund-watcher ✅ BUILT 2026-07-02**
     (`fund-watcher.ts`: `findBondFundingUtxo` polls Esplora for a confirmed exact-amount UTXO at the
     recomputed address, reads the REAL scriptPubKey off the funding tx; `checkBondFunding` action →
     `lockBondCustody` → LOCKED; wired into `BondCeremonyModal`'s "I've sent it — check for the deposit"
     button → 🔒 locked stage). ⭐ recompute-don't-trust reaches the deposit: the lock refuses a UTXO whose
     real script ≠ the bond script (tested, +8 assertions in 5b-BONDFUND; typecheck clean, suite 2816✅/0).
     All Mutinynet-safe, no real sats. ⛔ **Still Jetty's hard stop:** the actual mainnet/real-sats funding
     (a live deposit, or the Boltz v2 integration's tiny-mainnet go-live). `BONDS_ENFORCED` stays false (the
     2B enforcement flip is separate). Target architecture: bonds live OFF the escrow engine as `BondCustody`;
     38130 declarations + exposure + cabinet + victim-attestation all stay.

## Verifier's open items (check independently of CC's own account)
- ~~Independent read of `multisig.ts` / `verifyReturnPsbt`~~ — **DONE, PASSED** (`chama-bond-multisig-VERIFIER-REVIEW.md`).
- ~~Attestation independent pass~~ — **DONE, PASSED by CC** (`chama-bond-attestation-verify-brief.md` was the
  brief; results hashed by the verifier chat; 2 fixes + 1 hardening applied — see Done + green).
- **The SSS custody must be FULLY SUPERSEDED** — no reachable old-flaw fallback / dual-path.
- ~~**The signet broadcast** is the ultimate proof (a real independent network rejecting the owner-alone
  spend)~~ — **DONE 2026-07-02, PASSED.** All six rows broadcast to Mutinynet: owner-alone REJECTED
  (`-26 script-verify-flag-failed`), return/restore/residual/restore-after-strand ACCEPTED, strand held.
  Evidence txids in the Stage-3a note. Harness: `scripts/mutinynet-bond-harness.ts`; runbook:
  `chama-bond-mutinynet-runbook.md`. The library-level green is now backed by live consensus.
- Minor: the localized `p2tr_ms` type-cast (library type quirk) — comment it against a future library
  upgrade.

## Doc pointers
- `chama-bond-cryptographic-custody-decision.md` — the foundational decision (the finding, Option 1, the
  construction spectrum §9, the arc-correction note: multisig = permanent top tier, module = ecash lane).
- `chama-bond-mvp-multisig-brief.md` — the build spec (the **LOCKED** section = authoritative decisions +
  PSBT checklist + attack matrix).
- CC memory: `project_bond_multisig.md`.

## Posture (unchanged)
`BONDS_ENFORCED` stays **false**. Signet / tiny-sats only, supervised. Leave changes **uncommitted**
(Jetty does the git split). Confirm-first on fund-critical/irreversible moves. **The verifier does NOT move
money.** The test-cabinet seam stays **DEV-only** (never weaken the prod keystone).
