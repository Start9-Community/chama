# Bond 2A — Phase 2 Seed Run (Stage 1) · Run Playbook

**Open this during the run. Tiny sats. Dev build. Full attention.**

---

## What this is, in one breath

The first time **real ecash** locks into a bond. You play **all three cabinet seats**
(owner + custA + custB) with self-controlled keys, on a **dev build**, with **throwaway sats**.
Everything before this — the engine (lock/return/restore/keystone, all three no-self-return legs),
the bridge routing, the rig, the dev-cabinet seam — is built, sim-proven, adversarially cleared,
**zero real sats touched.** This run proves the one thing sim *cannot*: that the bridge's **real
encryption** genuinely makes the owner unable to read the custodian shares.

**Why you watch it live:** the cap bounds the *loss*; your eyes provide the *conviction*. This is the
payoff of the whole track, not a chore to delegate.

---

## Boundaries (don't drift)

- `BONDS_ENFORCED` stays **false**. Tiny throwaway sats only.
- **Dev build** — the test-cabinet seam is live only in dev (`import.meta.env.DEV`); a prod bundle
  ignores it and always uses the real cabinet.
- This is **Stage 1** (your self-keys) — **NOT** Stage 2 (the real trio), which is the separate
  go-live gate.
- Do **not** touch 2A-5 (slash/relock), §11.5 (inactivity timelock), 2A-3 (ceremony UX),
  2A-6 (loud prompt), or the 2B enforcement flip.

---

## Setup (before you start)

- [ ] **Dev build** running.
- [ ] **3 self-controlled keys** ready → label them `owner`, `custA`, `custB`.
- [ ] A **fed where the owner-seat can hold ecash** (funding actually works there).
- [ ] A **few hundred throwaway sats** to fund the owner-seat. **First run: fund it by your own hand**
      (manual / you-approve), so you're certainly present. A capped NWC is fine for *repeat* runs once
      you've watched it work.
- [ ] `__installTestCabinet([owner, custA, custB])` — the trio is the test cabinet; for this bond,
      `owner` is the owner and `custA`/`custB` are its two custodians (both ∈ the cabinet → the keystone
      will accept them).

---

## The run — watch every ✅

**1. Install the test cabinet** → confirm `cabinetPubkeysForCommunity` returns your 3 keys (dev only).

**2. Fund the owner-seat** with the tiny sats → confirm it holds ecash.

**3. Lock the bond** — `owner` self-creates **and** self-locks; custodians = `custA`, `custB`.
   - ✅ lock **succeeds** (keystone accepts the test custodians; routing owner→share-0,
     custA→share-1, custB→share-2).
   - ⭐ **THE ATTACK — run it, it's the whole point:** take the **`owner` key and try to decrypt
     `custA`'s share-1 and `custB`'s share-2.**
     - ✅ **PASS = it FAILS** (real ECDH refuses). The owner provably can't assemble a second share →
       **no-self-return holds on real crypto**, not just the recipient-map shape.
     - 🛑 if the owner **can** decrypt → **STOP.** The bridge mis-encrypted; the keystone is broken at
       the crypto layer. Nothing proceeds — note it and bring it back.

**4. Strand it** — withhold the return-heal → ✅ the bond **stays locked** (no auto-refund, §13.0), and
   the owner **can't reconstruct alone** (only holds share-0).

**5. Restore it** — `custA` casts the **REFUND** return-heal carrying its **genuine share-envelope** →
   ✅ the engine **accepts** the envelope (leg-3), and the owner now holds share-0 + custA's share =
   2-of-3. *(Pause a beat before this step to watch the reversibility — a strand that comes back.)*

**6. Owner reconstructs + redeems** → ✅ the tiny sats **actually come home** on the real fed. Real
   reconstruct → redeem, end to end.

**7. Clear the test cabinet** → `__installTestCabinet(null)` → ✅ the **real cabinet is restored**, no
   leak.

---

## The verdict

- ✅ **Stage 1 PROVEN** if: step 3's attack **fails-as-expected** (owner can't decrypt), step 6 **returns
  the sats**, and step 7 **clears clean**.
- 🛑 **STOP** if the owner can decrypt a custodian's share — the crypto no-self-return is broken; do not
  proceed, capture exactly what happened.

---

## What this unlocks

Stage 1 proven = the keystone holds against **real money** (with your self-keys). The next gate is
**Stage 2** — the real trio (Bitcrazy + Chapsmart + Graysatoshi, real `BLF_CABINET_PUBKEYS`, three
*independent* humans), the only run that exercises true independent custody. That's the go-live gate
for 2B. Still untouched after this: 2A-5, §11.5, 2A-3, 2A-6, 2B.

---

## The one rule for the day

**Watch it live.** Tiny sats, dev build. If anything surprises you, **stop and look** — don't push
through. This is the keystone meeting real money for the first time. It earned your full attention.
