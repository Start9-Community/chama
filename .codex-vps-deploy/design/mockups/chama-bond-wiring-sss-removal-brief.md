# CC Brief — Wire the multisig bond custody into the live engine + REMOVE the SSS path

**Status:** ready for CC, **fund-critical, STAGED with hard STOP gates.** This is the step that retires the
broken SSS/vote-envelope bond custody and makes the multisig lifecycle the real one. It is NOT a pure module
— it's surgery on the live escrow engine. Leave everything **uncommitted** (Jetty does the git split).
`BONDS_ENFORCED` stays **false** throughout. **The verifier does NOT move money; Jetty funds every real-sats
moment; STOP before Stage 3.**

## The one thing that de-risks this whole step
`BONDS_ENFORCED = false` and bonds are Phase-1 **declaration-only** in production. **There are NO live
SSS-custodied bonds holding real sats.** So this is NOT a fund migration — it is code surgery. The real
hazard is **regressing the TRADE path**: the SSS bond custody is interwoven with `handleCreate`,
`recipients.ts`, and the bridge, so removing it carelessly can break trades. **The full test suite (the trade
cases) is the guard — it must stay green at every step.**

## Target architecture (the rationale — read before touching code)
The SSS bond was modeled AS an escrow (`category === "bond"`) because its custody was ecash SSS — the same
mechanic as a trade. **The multisig bond's custody is on-chain; it does not fit the ecash-escrow model at
all** (no ecash lock, no VOTE/RESOLVE reconstruction). So bonds move **OFF the escrow state machine** onto the
standalone `BondCustody` lifecycle (`src/bond-multisig/lifecycle.ts`, CC-PASSED). After this:
- **The escrow state machine handles TRADES ONLY.** No `category === "bond"`, no `isBondEscrow`, no bond
  fields on `EscrowState`.
- **A bond = two separable things:** (1) the **38130 declaration** (the exposure claim — STAYS on Nostr,
  `arbiters/bonds.ts` + `exposure.ts`), and (2) the **multisig custody** (`lifecycle.ts` + a new store +
  Nostr transport — NEW). 2B later gates (1) on (2); not now.
- **This is the answer to the one-custody-per-bond flag:** by DELETING the `category === "bond"` path, a bond
  can only ever exist as a `BondCustody` — no dual path is structurally possible. Enforcement by construction.

## KEEP vs REMOVE (exact)
**KEEP (declaration / exposure / cabinet / attestation — not custody):**
- `arbiters/bonds.ts` (38130 declarations), `arbiters/exposure.ts` (ledger + `BONDS_ENFORCED`),
  `arbiters/pool.ts` (`cabinetPubkeysForCommunity`, `BLF_CABINET_PUBKEYS`, the DEV-only test-cabinet seam),
  `arbiters/victim-attestation.ts` (38131). The multisig lifecycle already reuses these.

**REMOVE (the SSS custody woven into the trade engine — trace every touchpoint):**
- `escrow-engine/state-machine.ts`: the `category === "bond"` branch in `handleCreate` (~276–400);
  `handleBondLock` (~661–740) — the SSS keystone (`BOND_CUSTODIAN_NOT_CABINET`, `BOND_SHARE_POLICY`,
  `BOND_SHARE_MISKEYED`) + share seating; the LOCK dispatch `if (isBondEscrow) handleBondLock` (~785);
  and the bond branches in the VOTE/RESOLVE/refund path (~1123, 1248, 1333, 1473, 1538).
- `escrow-engine/recipients.ts`: `isBondEscrow` (20) + the bond routing in `payoutRecipientFor` (~51).
- `escrow-engine/types.ts`: `owner`, `bondCustodians`, `bondTermSeconds` on `EscrowState` + `CreatePayload`
  (223–240, 720–733) and the `"bond"` category doc.
- `fedimint/escrow-bridge.ts`: the bond share production (`isBondEscrow` branches ~150–283) + reconstruction.
- `escrow-engine/escrow-client.ts`: the bond auto-refund suppression (~2242–2243) — becomes moot once bonds
  aren't escrows (keep the trade/contested-standing suppression, drop the bond arm).
- `escrow-engine/arbiter-substitution.ts`: the `isBondEscrow` exclusion (~245) — moot once bonds aren't escrows.
- `sim/bond-rig.ts`: the SSS plumbing rig — **replaced** by the multisig loop (Stage 0), then deleted.
- `escrow-engine/tests.ts`: the SSS `bond CREATE/LOCK` + `bridge bond LOCK` blocks — replaced by the
  lifecycle blocks (`5b-BONDLC`, already present) once the SSS path is gone.
> Grep `isBondEscrow`, `category === "bond"`, `bondCustodians`, `handleBondLock`, `holder-only` and confirm
> ZERO live references remain outside the lifecycle module + the declaration/exposure layer when done.

## Staged plan (each stage ends GREEN; hard STOP before Stage 3)

**Stage 0 — Port the loop (prove the NEW custody before deleting the OLD).**
Replace `sim/bond-rig.ts`'s SSS loop with a multisig-lifecycle loop: CREATE → LOCK → strand → restore over
`lifecycle.ts`, driving real keys through the PSBT co-sign, seating the trio via the DEV-only test-cabinet
seam (`__installTestCabinet`, cleared on exit). No fed, no money. This is the replacement plumbing proof.

**Stage 1 — Remove the SSS bond path from the escrow engine (⚠ the trade-regression-risk step).**
Delete every REMOVE touchpoint above so the escrow engine is TRADES-ONLY and clean. Success = the full suite
green with the trade cases **unchanged in behavior** (diff the trade-path tests: they must not move), the SSS
bond tests gone, and the lifecycle tests carrying bond coverage. **Recommend: this diff gets an independent
review pass** (fresh chat / the verifier chat) specifically for trade-path regression + confirming no
`category === "bond"` path survives.

**Stage 2 — Bond-custody store + Nostr transport + ceremony UX (no real sats yet).**
Persist `BondCustody`; publish/consume the **descriptor + PSBTs over NIP-44** on the existing relay layer
(the coordination layer above `lifecycle.ts`); wire the bonding ceremony (ConnectScreen / the §2A UX) to
`createBondCustody` + the co-sign flow. **⭐ Recompute-don't-trust on the wire:** a descriptor received over
Nostr MUST be re-derived locally (`recomputeAddress` / the keystone) before funding — never trust a
wire-supplied address. LOCK stops at the funding boundary: the descriptor, keystone, and the return/restore
PSBT flow all work; only the actual funding is Stage 3.

**Stage 3 — ⛔ STOP. Funding rail + the Mutinynet gate (real sats, supervised, JETTY-DRIVEN).**
Do NOT start without Jetty. The funding rail (ecash→on-chain: Boltz reverse-swap or fed peg-out — Jetty's
call, see Open decisions) + the **Mutinynet signet live-attack harness**: fund the address, broadcast an
owner-alone spend → **rejected by the real network**, then the full six-row matrix (incl. the honest §11.1
two-custodian-to-third-address residual). The library-level green is necessary but NOT sufficient — the
independent-network broadcast is the conviction-clincher. Tiny throwaway sats; Jetty funds every real lock.

## Invariants (must hold at every stage)
- **The TRADE escrow path is unaffected** — same states, same events, same recipients. The suite's trade
  tests are the regression guard; they must not change behavior.
- 38130 declarations + the exposure ledger + the cabinet roster + victim-attestation all keep working.
- **No owner self-return** (the lifecycle enforces it: keystone m ≥ 2 at CREATE, threshold at finalize, the
  finalize-layer destination re-check, consensus on broadcast).
- `BONDS_ENFORCED` stays **false** (the 2B enforcement flip is a separate, later decision — NOT this step).
- The test-cabinet seam stays **DEV-only** (never weaken the prod keystone).
- One-custody-per-bond **by construction** (the SSS path is deleted, not flag-gated).

## Verification
- Full `predeploy` green after Stage 0, Stage 1, Stage 2 (typecheck + the whole suite; the trade cases are
  the regression guard).
- The ported multisig sim loop (Stage 0) runs the full CREATE→lock→strand→restore.
- Adversarial pass on the transport (Stage 2): a tampered descriptor / PSBT over NIP-44 is caught by
  recompute + the keystone + the custodian checklist (fund-safe by construction).
- Stage 3 (with Jetty): the Mutinynet six-row matrix on the real network.

## Open decisions for Jetty (surface at the stage, don't assume)
- **Funding rail (Stage 3):** Boltz reverse submarine swap (ecash→LN→on-chain, non-custodial, atomic) vs
  Fedimint peg-out (if the fed supports arbitrary-address peg-out) vs direct on-chain (owner already holds
  BTC). Default recommendation: Boltz reverse-swap (Jetty's original idea). Decide at Stage 3.
- **Removal ordering:** Stage 0 (prove new loop) before Stage 1 (delete SSS) — recommended so a working
  custody loop always exists in tests. (Deleting first is *safe* since bonds are dormant, but port-first is
  cleaner.)
- **Whether Stage 1's removal diff gets an independent review** before Stage 2 (recommended — it's the
  trade-regression-risk step).

## Report back (per stage)
Stage 0/1/2: what changed, `predeploy` `Results:` line, and for Stage 1 the trade-path-regression evidence
(the trade tests' behavior is unchanged) + a grep proving no `category === "bond"` path survives. Then STOP
and hand to Jetty before Stage 3.

## Posture
`BONDS_ENFORCED` false. Signet / tiny-sats only, supervised, at Stage 3. **The verifier does NOT move money.**
Confirm-first on anything fund-critical/irreversible. **Hard STOP before Stage 3.** Leave uncommitted.
