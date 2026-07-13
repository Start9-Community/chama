# Verifier Review — Bond Multisig custody core (`src/bond-multisig/multisig.ts`)

**Reviewer:** fresh-chat verifier (independent of CC's own account). **Date:** 2026-06-30.
**Scope:** the STATUS doc's "ideal first task" — independent read of `multisig.ts`, especially
`verifyReturnPsbt` (checklist completeness) + threshold enforcement. **Money:** none moved (verifier
does not move money). **Posture:** signet/library-level only; `BONDS_ENFORCED` stays false.

## Verdict: ✅ custody core is sound — no blockers to proceeding to attestation + lifecycle

The checklist is **complete against the brief's five mandated checks and the six-row attack matrix**;
threshold enforcement is real (NUMS key-path unspendable + `finalize()` + consensus); typecheck clean.
I did **not** take CC's "14 assertions / green" on trust — I re-ran the headline guarantee and threw
**three attacks CC's suite does not cover**; all held. Five notes below, none fund-critical.

## What I ran independently (not CC's tests)
- Bypassed `tsx` (repo `node_modules` ships macOS esbuild; sandbox is Linux) via
  `node --experimental-strip-types` on a **17-case adversarial probe** importing the module directly →
  **17/17 pass**. (Harness: `tmp/verifier-multisig-probe.ts`.)
- `tsc --noEmit` over the whole project → **exit 0** (typecheck clean, independently reproduced).
- Confirmed the module is imported **only by `tests.ts`** — see "SSS superseded" below.

## Threshold enforcement — independently reproduced
- `NUMS_INTERNAL_KEY` **== the canonical BIP341 `H`** (`50929b74…03ac0`) → key-path is provably
  unspendable, so the 2-of-3 leaf is the only spend path. ✔ (my probe A)
- **owner-alone (1-of-3) cannot `finalize()`** — the headline guarantee, reproduced. ✔
- owner+custA **and** custA+custB (no owner) both finalize; 3-of-5 needs 3 not 2 → parameterization is
  real, not theater. ✔
- `assertKeys` rejects wrong count, non-32-byte, and **duplicate** keys (a repeat would let one holder
  count twice toward `m`). ✔

## `verifyReturnPsbt` checklist — complete vs the brief + matrix

| Brief requirement | Code | Proven by |
|---|---|---|
| exactly the bond UTXO as input (nothing else) | `inputsLength===1` + txid/index + witnessUtxo.script == `bond.script` + amount == bond value | CC (wrong-UTXO) **+ my D1 (rejects a 2nd input), D6 (wrong vout), D7 (lied amount)** |
| output ONLY to owner's address, **recomputed, never read from PSBT** | decode `out.script` → compare to `expect.ownerReturnAddress` | CC (non-owner addr) + residual test E |
| no extra outputs | `outputsLength===1` | **my D2 (rejects 2 outputs even when BOTH pay the owner)** |
| sane, bounded fee | `fee<0` and `fee>maxFeeSats` | CC (inflated fee) **+ my D5 (== max ok, max+1 rejected — boundary correct)** |
| `SIGHASH_DEFAULT` only | `sighashType !== undefined && !== 0` | CC (SINGLE\|ANYONECANPAY) **+ my D4 (rejects explicit SIGHASH_ALL(1))** |
| fail-safe on absent metadata | `witnessUtxo?` optional-chained everywhere | **my D3 (no-witnessUtxo input rejected)** |

All checks are made against **locally-known values** (`expect.bond`, `expect.utxo`,
`expect.ownerReturnAddress`) — never values read out of the PSBT. This is the property that kills
blind-cosign self-reclaim.

## The §11.1 residual is correctly on the record
My probe (E) proves both halves of the accepted-and-documented residual: **custA+custB CAN finalize a
spend to a third address** (Bitcoin consensus permits any 2-of-3), **and** `verifyReturnPsbt` **refuses
to co-sign** a non-owner destination. Exactly the brief's "deterred + on-chain visible, NOT
cryptographically blocked" row. The signet matrix should reproduce this on-chain.

## Notes (none are blockers)
1. **`expect.*` is load-bearing and trusted-by-contract.** The module cannot enforce that the caller
   recomputed `bond`/`ownerReturnAddress` from attested keys / the CREATE record — that guarantee must
   live in the **attestation + lifecycle** layer. This is where a future bug could silently re-open
   blind-cosign. Make it explicit when wiring: `expect.bond` from `buildBondMultisig(attested keys)`,
   `ownerReturnAddress` from the CREATE-time owner record — never from the PSBT or the wire.
2. **Bare NUMS point (no per-bond `r·G` tweak).** Safe against key-path spend (all that matters for
   custody) and addresses still differ across bonds. Only a minor on-chain *linkability* nuance
   (observers can spot the bare-`H` script-path pattern). If per-bond internal-key unlinkability is ever
   wanted, tweak `H` deterministically per bond. One-line code comment suffices.
3. **DEFAULT(0)-only is stricter than strictly necessary** (explicit `SIGHASH_ALL(1)` is equally safe on
   a 1-in/1-out pinned tx). Harmless — `buildReturnPsbt` always emits DEFAULT, so the normal flow never
   trips it. Conservatism is the right call; just documented.
4. **Sequence / nLockTime unchecked — not a redirect vector.** Any RBF replacement needs a fresh 2-of-3
   signature set over a new sighash, which the owner can't produce alone; destination/amount/fee are all
   pinned and `SIGHASH_DEFAULT` commits to them. Documented, not a hole.
5. **The `p2tr_ms as unknown as …` cast** (the STATUS open item): localized, already commented, runtime
   behavior validated by real Taproot build+finalize (my probe + CC's tests). Genuine @scure
   type-narrowness quirk, not a logic issue. Suggest a `// revisit on @scure/btc-signer > 2.0.1` marker
   (it's pinned to 2.0.1). **Optional defense-in-depth:** `verifyReturnPsbt` could also assert the input's
   `tapInternalKey === NUMS` and `tapLeafScript` == the expected 2-of-3 leaf — today a mismatched leaf
   just wastes the custodian's signature (consensus rejects a non-committed leaf, so it's fund-safe), but
   asserting gives a clean fast-fail instead of a silently-useless signature.

## "SSS custody must be FULLY SUPERSEDED" — status: **not yet, and that's expected**
`bond-multisig/multisig.ts` is currently referenced **only by `tests.ts`** — it is **not wired into the
bond lifecycle**. The old SSS / bearer-note custody is still the only path the app runs. So
"fully superseded / no dual path" **cannot be true until Remaining #2 (lifecycle over the multisig)
lands** — and there's no dual-path risk today precisely because the new path isn't reachable. **Action
for the lifecycle step:** replace/remove the SSS custody, don't leave it as a reachable fallback.

## Recommendation
Proceed to **attestation (kind 38132)** and **lifecycle**. The library-level proof is **necessary but
not sufficient** — I agree with the handoff that the **Mutinynet live-attack broadcast is the
conviction-clincher** (a real independent network rejecting the owner-alone spend). Before any real sats:
(a) the six-row signet matrix, (b) lifecycle wiring that sources `expect.*` from attested/CREATE values
and removes the SSS path, (c) adversarial review of attestation — both sigs (npub attest + BTC
cross-sig), term-gating, and the rotation/revocation path (a superseded attestation must be rejected).
