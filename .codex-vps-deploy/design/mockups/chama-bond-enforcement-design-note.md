# Chama bond — the enforcement model: stranding-threat, not a lock (design note)

**Status:** design decision LOCKED (2026-07-03). Captures why the 2-of-3 stays, why a timelock is
NOT adopted for enforcement, and what's parked for bond-v2. No code change — this pins the *reasoning*
so a future chat doesn't re-litigate it.

## ⭐ The core insight (Jetty, 2026-07-03): the enforcement is the THREAT, not the lock

The bond's teeth are **not** that the sats sit at an address — they're that a **misbehaving arbiter's
own sats get STRANDED**. Because the owner can never self-return (proven on Mutinynet: owner-alone is
rejected by consensus), a bad actor cannot pull their bond back; it's recoverable only with a
custodian's co-signature the cabinet will withhold if they misbehaved. **That conditional-on-behavior
stranding is the deterrent.** Behave badly → your money is stuck. That's the genius, and it's what a
newbie arbiter feels before they ever consider cheating.

## Why a timelock adds nothing here

A timelock (CSV/CLTV on the funding UTXO for the bond term) **locks the UTXO and nothing else.** It's
*unconditional* — it applies the same whether the arbiter is honest or a crook, so it exerts **zero
leverage over behavior.** It can't strand a cheater any harder than it "strands" an honest party;
there's no if-you-misbehave clause a raw timelock can express. So it cannot replace, or even
strengthen, the multisig's deterrent. (Jetty's words: "it just locks the utxo and NOTHING ELSE.")

Worse, if it *replaced* the multisig, you'd lose the whole point: no custodian gate → nothing to
withhold → no stranding threat → no deterrent. A timelock-only bond is a returnable deposit, not a
bond.

## The trilemma (why there's no free lunch)

During the term you can pick two of three; you cannot have all three:

- **No collusion** — not even the custodians can move it (a full freeze).
- **Instant enforcement** — the bond can be slashed / a victim made whole at any moment.
- **No custodian dependency** — the owner isn't reliant on custodian liveness to ever get it back.

The shipped design chose **instant enforcement + no-collusion-of-the-owner** (the 2-of-3), and
accepted the §11.1 residual (two colluding custodians could divert) and permanent-strand-if-custodians-
vanish. A full-duration freeze would buy *no collusion* but forfeit *instant enforcement* — you
couldn't make a mid-term victim whole until the term ends. For an arbiter bond, enforcement-now wins.

## Parked for bond-v2 (explicitly NOT now)

- **Owner-recovery-after-T tapleaf** (`<owner> CHECKSIG <T> CSV` added to the tree): a liveness
  backstop so a bond isn't stranded *forever* if both custodians vanish. Real, and it slots into the
  current design without Musig2. **But** it trades a sliver of deterrence — the strand becomes "until
  T," and a cheater whose custodians happen to be offline at T could recover un-slashed. So it's a
  liveness/UX choice, not an enforcement gain. Deferred; revisit only if permanent-strand bites.
- **Musig2 / FROST key-path privacy**: cooperative spends that look like a plain single-sig (extreme
  on-chain privacy). Musig2 = private 3-of-3 happy path; a truly-private 2-of-3 needs FROST (younger
  tooling). Significant redesign of the Mutinynet-proven core, and the enforcement/dispute paths stay
  script-path (visible) anyway — so happy-path-only privacy. Pairs with Boltz-at-the-door for the full
  private story. **Bond-v2 research track, after the current design is verified end-to-end.**

## Decision

The **2-of-3 stranding-threat design is the enforcement model, LOCKED.** Timelock is **not** adopted
(no behavioral leverage). Owner-recovery leaf + key-path privacy are captured as optional bond-v2,
gated behind end-to-end verification of the current design. Proceed to the small-sats 3-npub e2e test.
