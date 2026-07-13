# Chama bond — collusion closure ladder (decision brief)

> ✅ **RESOLVED 2026-07-03 — we walked *around* the ladder, not up it.** The bond was redesigned as a
> **single-key timelock COMMITMENT** (each arbiter locks their own sats to their own key until T; no
> cabinet, no 2-of-3, collusion-impossible by construction). That retires 0.2 / 0.3 / Tier 1 / Tier 3
> and keeps only **Tier 2** (open stranger ceremony + presigned slash, keys deleted) as an *optional
> future* upgrade if reputation ever proves too soft. See DECISIONS 2026-07-03 "BOND MODEL SEALED".
> The ladder below is preserved as the reasoning that led there.

**Status:** decision brief (2026-07-03), from CC's adversarial pass + the verifier's independent
confirmation + Jetty's rulings. Captures the finding, the mechanics (for a non-cryptographer), the
ladder, and what's IN / OUT / STAGED. No enforcement code shipped yet. `BONDS_ENFORCED` stays false.

## The finding (confirmed independently, grounded in the code)

The OG cabinet is **three people**, so `cabinetPeersFor` makes **every bond the same keyset {A,B,C}**,
and `multisig.ts` builds a **bare 2-of-3 with no timelock**, with the term living in `lifecycle.ts`
(app code, not consensus). Consequences, all real:

- **Any TWO arbiters control all three bonds** — return their own (owner+custodian) AND outright steal
  the third's (they're its two custodians). Stage-3a **Row 4 already proved this exact spend on
  Mutinynet.** We proved the attack ourselves and shipped it as a feature.
- **The MAD deterrent is false.** A defecting pair {A,B} recovers both their own bonds via each other's
  signatures — capital cost of full defection ≈ **zero**. Honest C cannot retaliate.
- **Strand = extortion.** {A,B} can permanently strand honest C's bond by refusing to sign (no
  owner-recovery leaf), and use it as leverage: "co-sign our clawbacks or your bond strands forever."
- **No app code can fix this.** `verifyReturnPsbt`, the keystone, NIP-44 — all protect an *honest*
  custodian from being *tricked*. A dishonest custodian hand-signs and ignores the app, exactly like
  the Mutinynet harness did. Once funded, the script is law.

⚠ **MUST-FIX NOW (independent of the roadmap):** the ceremony trust copy (`BondCeremonyModal.tsx`
264–265) tells the user collusion "costs them their own bonds — held by mutual stake." That is
**cryptographically false** in the trio. Kill/replace it before it's shown to a real person.

✅ **Not a live drain:** `BONDS_ENFORCED`=false, zero real bonds funded, ceremony dev-only, e2e is
test-sats. Caught before any real OG bond funds. **New invariant: no real-sats OG bond funds until at
least Tier 0.1 ships AND the honest disclosure replaces the false MAD copy.**

## Mechanics, for the non-cryptographer (so a future chat isn't lost)

- **Taproot leaf.** One address = a door with several independent locks; you open it through any one
  lock and only ever reveal which lock you used. Today the bond has ONE leaf: `2-of-3, anytime,
  anywhere` — that single fact is the whole hole.
- **CLTV (`OP_CHECKLOCKTIMEVERIFY`).** A lock that literally won't turn until date T, enforced by
  every Bitcoin node (early attempt → consensus `-26` rejection, same as owner-alone Row 1).
- **The key truth:** a multisig leaf can send ANYWHERE, so more/other keys only change *who must
  collude*. Only a **covenant** (presigned templates / CTV) can restrict *where the coin may go* —
  that's the difference between *redistributing* trust and *removing* the ability to cheat.

## The ladder — Jetty's rulings

### Tier 0.1 — term in the script (two leaves). ✅ MANDATORY, TOP PRIORITY, before real OG bonds.
Rebuild the bond with two Taproot leaves: **(A) during the term — no return path** (only a slash path
if/when one exists); **(B) after the term — CLTV-gated — the 2-of-3 return unlocks.** Buildable in the
existing `@scure` stack, no new deps, no CTV. **What it buys:** the term becomes consensus-law; covert
early-clawback is impossible; the bond genuinely *sits* committed for the full term. **What it does NOT
buy (stated plainly, to not repeat the MAD overclaim):** it does not stop collusion — a 2-coalition
just waits until T and leaf B lets them send anywhere. Necessary, not sufficient. It is the elegant,
mandatory *foundation*.

### Tier 0.2 — break the shared keyset / ≥5-person cabinets. ❌ REJECTED.
Forcing every chama to recruit five rare bitcoiners is unacceptable friction, and it isn't even the
elegant fix (a bigger *local* cabinet still self-deals). Do not pursue.

### Tier 0.3 — external key on the return leaf, via CROSS-CHAMA reputation. 🔜 STAGED (the real closer).
Add a non-arbiter key so cabinet collusion alone moves nothing: `owner + 1 custodian + external`. The
external key is **"hidden inside other chamas," chosen by reputation/ratings** — a colluding cabinet
would have to corrupt a reputable OG from another pond who has far more rep to lose than a few sats to
gain. This is the collusion-closer that fits growth WITHOUT forcing big local cabinets. Switched on as
multiple living chamas exist; Tier 0.1 lets us graduate here. (A "3-of-5" only helps if it *requires*
an external key — "must include ≥1 external" — otherwise three local OGs still collude. That's just
0.3 with a bigger number.)

### Tier 1 — oracle-gated slash (DLC-style). ❌ SKIP.
Jetty: no point vs. just requiring external multisig participation. Dropped. (The Fedimint escrow
module stays a cheap ecash lane, never the vault — per the earlier custody decision.)

### Tier 2 — presigned open ceremony + ephemeral-key deletion. 🔥 PURSUE if feasible (mainnet endgame).
At funding, build the address from a MuSig2 aggregate of **ephemeral keys from N diverse parties**,
**presign the only allowed futures** (return-after-term; slash-to-pool), then **everyone deletes their
ephemeral share.** If even ONE of N deleted honestly, the coin is a true covenant: no coalition of any
size can redirect, burn, or strand it. **The move:** make the ceremony *open* — any skeptic contributes
one share and deletes it, becoming the honest-1-of-N themselves. "Don't trust — contribute." Trust
floor = 1-honest-of-N (deletion is unprovable, so not zero — but each participant can *know* it's zero
for them). ⚠ Feasibility caveat: presigning the exhaustive allowed-futures set means fixing exact
amounts + fees at ceremony time (anchor outputs / CPFP for fees) — proven (vaults do it), not trivial.
**Jetty's framing (verbatim, it's the philosophical core):** *"Trust is built over time… there's
always at least one honest arbiter in each chama (usually the one who desires to create it). Like
Bitcoin's on-chain thesis: over time, we build the longest chain of honest arbiters."* The genesis
creator is the natural honest-1-of-N; Tier 2 lets them prove it and shows newbies how it's done.

### Tier 3 — real covenant (OP_CTV). 🧪 TEST ON MUTINYNET NOW; ship to mainnet if/when activated.
The output commits to allowed spend templates (return-after-term, slash-to-pool, nothing else); a theft
tx is consensus-*invalid* — the unqualified word "cannot," for any collusion set of any size. **CTV is
NOT on mainnet (no activation scheduled), but IS live on Mutinynet** (with CSFS) — the exact network our
harness runs on. So we can build a **7th harness row now**: "all three keys sign a redirect → REJECTED
by consensus," at zero cost (fake sats), as the working artifact that ships the day mainnet covenants
activate and as the public proof of where Chama's custody ends up. Needs a CTV-aware tx builder (not in
`@scure`) — a real but bounded experiment.

## The honest end-state (so we never oversell again)

"The 3 OGs cannot cheat" is achievable (0.1 + 0.3). "Nobody, ever, zero-trust, mainnet 2026" is NOT —
multisig quorums can always defect, deletion is unprovable, mainnet covenants aren't activated. The
achievable mainnet endgame is **1-honest-of-N (Tier 2)** — which would make the bond *more trustless
than the trade escrow itself* (Fedimint guardians). v1 launches on honest-cabinet-majority, stated
plainly; 0.1 hardens the term; 0.3-cross-chama closes collusion as we grow; Tier 2 is the endgame;
Tier 3 is the proof.

## Immediate actions

1. Replace the false MAD ceremony copy with an honest line (now).
2. Build **Tier 0.1** (two-leaf CLTV bond) in the module + prove it with a harness row + tests.
3. Lock the invariant: **no real-sats OG bond funds until 0.1 ships + honest copy lands.**
4. (Parallel, zero-cost) the **Tier 3 CTV Mutinynet** 7th row as proof-of-endgame.
5. The test-sats **3-npub e2e** can proceed now — it validates plumbing, not the trust model.

## Sources
- [Bitcoin Optech — OP_CHECKTEMPLATEVERIFY](https://bitcoinops.org/en/topics/op_checktemplateverify/)
- [Bitcoin Optech — Signet (Mutinynet CTV + CSFS)](https://bitcoinops.org/en/topics/signet/)
- [covenants.info — CTV](https://covenants.info/proposals/ctv/)
