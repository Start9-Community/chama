# Chama — Cryptographic Custody: Foundational Finding + Direction

**Status:** DECISION RECORD. Author: cowork (advisory) with CC's Phase-2 finding, 2026-06-30.
**Decision (Jetty, 2026-06-30):** Chama's custody must be **cryptographically secure**, not
economically/reputationally secured. We take **Option 1** (the funder/owner never holds the locked
notes), however many months it takes. We do **not** take Option 2 (detect-and-slash). This doc is the
map for that work.

---

## 0. TL;DR

- **The finding:** `createEscrowLock` (fedimint-client.ts:1054) has the **funder mint and hold the
  complete bearer ecash** (`oobNotes`), then SSS-split *that note string*. The funder holds the whole
  secret at lock time — no decryption, no reconstruction needed. An honest client discards it; a
  funder who retains it can **redeem unilaterally and covertly**. True for **trades and bonds alike.**
- **Why trades survive it and the bond doesn't:** a trade funder who reclaims forfeits what they were
  trading for, and is deterred by the arbiter + reputation → they discard and complete. A bond owner
  who retains gets their stake back **for free, covertly, while still appearing bonded** → a rational
  owner always retains → the bond binds **nothing.**
- **The decision:** make custody cryptographic — the funder/owner **cannot** unilaterally reclaim.
- **The scope:** this is a **custody re-architecture**, bond-first (urgent, unmitigated) — but the
  same gap exists in the **trade escrow** (real, only incentive-mitigated). "Chama is cryptographically
  secure" eventually means the same construction under trades too.

---

## 1. The finding (durable record of *why*)

`createEscrowLock` does three things, in order:
1. **Spend** the funder's balance into `oobNotes` — the *complete bearer ecash token* (a string).
2. **Hash** it (`notesHash`, for later verification).
3. **`shamirSplit(oobNotes, 3, 2)`** — split *the bearer note string itself* into a 2-of-3.

So the SSS shares are **of the bearer notes**, and **the funder holds the entire `oobNotes` at lock
time.** They don't need anyone's share — they minted and hold the whole secret. The function discards
`oobNotes` on return (local variable), so an *honest* client throws it away. But the funder's own
wallet created it; retaining it is trivial — and for a bond, the owner **is** the funder, on their own
machine. NIP-44's symmetric conversation keys (sender can decrypt what they sent) and the engine's
3-leg keystone are both **downstream of this** and don't help: the owner never needed the custodians'
shares, because they had the plaintext notes from the start.

**This is not a latent trade "bug" to panic over** — it's the inherent property of an ecash escrow
(you cannot cryptographically stop the funder from holding their own notes; you lean on the arbiter +
reputation). It *is* worth stating plainly in the threat model. And it means the bond — meant to be the
cryptographic backstop for exactly the trade funder-reclaim scam — cannot be that backstop while it
reuses this construction. Circular.

---

## 2. What "cryptographically secure" precisely means here

Be exact, so the goal is calibrated:

- **The necessary, achievable guarantee (Option 1): no single party — above all the funder/owner —
  can take the locked funds alone.** No covert self-redeem. This is the thing that's broken and the
  thing this work fixes.
- **The residual, inherent to any 2-of-3:** *two* of the three holders, colluding, can still act
  (the §11.1 economic-MAD — two cabinet members reconstructing a peer's bond). Removing *that*
  cryptographically needs the **nested scheme (§11.9)** or a higher threshold — a **further layer**,
  not Option 1.

So: **Option 1 = "no one alone, including the funder."** Full collusion-resistance = Option 1 +
nesting. Today we are below even the first bar (the *owner alone* takes it). Option 1 gets us to the
first bar; nesting is the optional second.

---

## 3. The construction space — the real paths to Option 1

**Core requirement:** the spend + custody must be done so that **no single party (especially the
funder) ever holds the complete bearer notes**, and release requires the 2-of-3 threshold.

| Path | What it is | Verdict |
|---|---|---|
| **A. Cabinet-minted lock** | Owner pays the cabinet; the cabinet mints + splits. | **Not a solution alone** — it just moves "who holds the notes" from owner to the minting cabinet member. Only safe if the mint itself is multi-party (→ B). |
| **B. Threshold / MPC minting** | The notes are issued *in shares*, never assembled at one party. | Cryptographically strong, but **hard** — a custom protocol or client-side MPC over Fedimint issuance. Research-grade. |
| **C. Federation-side escrow module ⭐** | The federation holds the bond ecash in a contract that releases only on the cabinet's 2-of-3. Owner funds it; cannot bypass the federation. | **Cleanest + ecash-native.** Needs a **custom Fedimint module** on the fed — gated on Fedimint's module extensibility + guardian deployment. **Aligns with your own-federation / sovereignty chapter** (deploy it on your *own* fed). |
| **D. Bitcoin / Lightning 2-of-3 multisig** | The bond is a standard 2-of-3 multisig (owner + 2 cabinet), on-chain or in an L2 construct. Owner-alone can't spend. | **Proven, trustless, no new crypto** (multisig is the gold standard for "no one alone"). Cost: **moves the bond off Fedimint ecash** → on-chain/L2 custody, fees, less privacy, a separate surface. |
| **E. Native Fedimint escrow (if it exists)** | A native 2-of-3 / escrow construct over ecash, if Fedimint provides one. | Unknown — **research item.** If it exists, the ecash-native shortcut to C. |

**The realistic finalists: C vs D.** C keeps everything in ecash and rides your sovereignty plans, but
is build-and-dependency-gated on Fedimint. D is proven and buildable today, but leaves ecash for the
bond's custody (different UX/fees/privacy). The whole direction hinges on the **C-feasibility question**
(§6).

---

## 4. The scope reality (the honest "months")

Option 1 is **not a bond patch — it's a custody construction.** Sequencing:

1. **Bond first** — it's the *unmitigated* case (a rational owner always retains; the bond binds
   nothing today). This is where the new custody primitive gets designed, built, and *proven on real
   tiny sats with the live-attack as the gate.*
2. **Then the trade escrow** — the same funder-reclaim gap is real there, only **incentive-mitigated**
   (the funder usually wants to complete; the arbiter/reputation deter the scam). "Chama is
   cryptographically secure" means eventually bringing trades onto the same funder-doesn't-hold-notes
   custody.

That two-stage arc — design the custody primitive, prove it on the bond, migrate trades onto it — is
the multi-month re-architecture. It is also the *honest* one: it's the difference between Chama
*claiming* non-custodial cryptographic protection and Chama *having* it.

---

## 5. What survives from the work so far (this matters — read it)

The months of engine work are **not** thrown away. What broke is **one layer: the LOCK / custody
primitive** (SSS-of-bearer-notes, funder-held). Everything *above* it is the orchestration and
accountability model, and it largely survives a custody swap:

- The bond **lifecycle** (CREATE → LOCK → return-heal → resolve → claim), the **cabinet-membership
  keystone**, the **REFUND-only-to-owner** routing, the **restorative-strand** reversibility, the
  **victim-attestation** seam, the **public record / two-ledger** separation, the **§0 reconstruct
  guarantee** — all of that is the design that sits *on top* of custody.
- What gets re-implemented underneath: **how a custodian delivers their "share,"** and **how the funds
  are held so the owner can't reconstruct alone.** Under C it becomes a federation contract release;
  under D it becomes a multisig co-sign. The *shape* of "owner + one custodian returns it; both
  custodians withholding strands it" is preserved; the *primitive* changes.

So the accurate read: we **validated the entire bond lifecycle and accountability model** — and the
live-attack discipline caught that the **custody primitive** beneath it must change. That's a
foundation-corrected build, not a wasted one.

---

## 6. The first step — the linchpin research

Everything forks on one question: **can Fedimint support a custodial / 2-of-3 escrow construct over
ecash (path C or E)** — natively, via a community module, or via a custom module deployable on BLF or
your own federation?

- **If yes → C** is the ecash-native cryptographic bond, and the path to cryptographic *trades* too,
  all on Fedimint — and it slots into your run-your-own-federation plans.
- **If no (or far off) → D** (Bitcoin / L2 2-of-3 multisig) is the proven fallback, accepting the
  bond's custody lives off ecash.

**Recommended next action:** a focused research pass on Fedimint's module/contract capabilities + their
roadmap + whether a custom escrow module is feasible on a fed you control. That answer chooses C vs D,
and C vs D shapes everything after it.

---

## 7. The frame to hold

The bond didn't fail — it got *honest*. The stop-rule and the live-attack caught a foundational flaw
before one real sat moved and before launch. The decision to be **cryptographically secure rather than
reputationally secure** is the decision that makes Chama's "non-custodial, your-keys, trustless"
language *true* instead of aspirational. It is months of work. It is also the only version worth
shipping. The map above is where it starts.

---

## 8. Path C, grounded — the Fedimint escrow module (researched 2026-06-30)

The research turned C from "research-grade, maybe" into **"designed by Fedimint's lead maintainer,
with a reference implementation, and it fits Chama almost exactly."**

**The construction solves the flaw at the root.** A Fedimint escrow is a custom module where the funder
does `mint notes → contract` (deposit ecash *into* a federation-held contract); withdrawal is
`contract + release-condition + sig → mint notes`. The **guardians hold the contract and enforce the
release condition at consensus.** So after depositing, the funder holds **no redeemable notes** — the
federation does — and release requires the pre-agreed condition the funder alone can't satisfy. That is
Option 1, native to Fedimint. (Source: dpc, Fedimint discussion #5249; reference impl
`harsh-ps-2003/escrow`, generated from the official custom-module template.)

**The bond maps onto dpc's "multiple Es with a threshold."** His design explicitly allows the escrow
agent `E` to be *"multiple Es with a threshold."* Chama's bond = a deposit whose escrow agents are the
cabinet and whose release condition is **2-of-3 over [owner, custodianA, custodianB]**:
- **Return** = owner + 1 custodian → guardians release to owner.
- **Strand** = custodians withhold → the condition is never met → the funds **stay in the guardians'
  contract, reachable by no one.** The cryptographic strand, finally with teeth.
- **Restore** = the cabinet supplies the threshold at any later time → release to owner. The
  restorative reversibility, now *federation-enforced* instead of hope-the-owner-discarded.
- **Term** = a timelock parameter on the contract.
The owner **cannot** withdraw alone — the guardians enforce the 2-of-3. The foundational flaw is gone.

**Reputation stays on Nostr — exactly how Chama is already built.** dpc: *"E's identity/reputation
happens OUTSIDE Fedimint's consensus (advertising, review systems)."* Chama's Nostr ratings + roster +
the cabinet keystone **are** that layer. The module owns custody + release; Nostr owns coordination +
reputation + cabinet identity. The split Chama already has is the split the module assumes.

**It's not just the bond — it's the whole escrow.** The reference module is **buyer/seller/arbiter with
arbiter dispute resolution** — i.e. *Chama's trade escrow, federation-enforced.* The same construction
re-homes Chama's **trades** too (killing the funder-reclaim there as well). One module family fixes
bond + trades at the root.

**Status + opportunity.** The reference module (a Summer-of-Bitcoin project) is **incomplete**; a more
detailed proposal exists (m1sterc001guy's gist); and dpc + the Open Source Justice Foundation have
**explicitly asked for someone to build production escrow.** This is frontier work the Fedimint
protocol's own maintainers *want* — built **with** the protocol, not against any app-layer gatekeeping.
Done well, Chama could be the first production cryptographic P2P escrow on Fedimint.

**The guardian architecture (the real fork inside C):**
- Chama needs a **federation it controls** with a **genuine guardian set** — a single-guardian fed is
  custodial-by-the-operator and defeats the point. Target 3–5 independent node-runners. Candidates:
  Jetty + recruited runners (Jon/Umbrel + GBot, Meetup contacts).
- **Guardians ≠ cabinet.** Guardians run the federation + the module (they enforce *all* contracts);
  the cabinet are the bond custodians named *in* a bond contract. They may overlap, but they're
  different roles. Important: the guardians enforce release, so the guardian set's honesty is a trust
  assumption *underneath* the cabinet — the federation's threshold matters as much as the cabinet's.
- The guardians run a **custom `fedimintd`** (the stock binary recompiled with Chama's escrow/bond
  modules) → a custom Start9/Umbrel package, not the stock Fedimint service. (The stock Start9 service
  being gone on 0.4.0 is moot — you ship a custom build regardless.)

**First concrete steps:** (1) read m1sterc001guy's proposal + the reference module's three crates
(client/common/server) + the custom-module template, and size the build; (2) settle the **guardian
set** — the trust model lives here; (3) prototype the bond as a minimal module (2-of-3 deposit +
timelock) on a local `devimint` federation and prove deposit → strand → restore with the guardians
enforcing release.

---

## 9. Build sizing — the construction spectrum (m1sterc / Resolvr, 2026-06-30)

m1sterc001guy's **Resolvr** proposal (a Fedimint contributor's design for Nostr-keyed threshold
dispute-resolution) refines §8 and reveals the bond's real spectrum — and that §8 over-indexed on the
*custodial* variant.

**Two corrections to §8:**
1. **The cabinet brings KEYS, not NODES.** Resolvr's explicit requirement: *"Reviewers should NOT be
   required to run server infrastructure."* The cabinet (= Resolvr's "reviewers") hold threshold keys
   tied to their npubs; a *separate* entity runs any federation. → **Chap + Gray (no node) can be
   cabinet members** — they just sign. Guardians ≠ cabinet, and the cabinet needs zero infra.
2. **Non-custodial beats federation-custodial for a bond.** §8's ecash-module path is Resolvr
   **Variant 2**, where the federation custodies the funds — *"an untrustworthy federation can rug the
   users."* For a bond, whose whole job is to be **un-rugable**, that's the wrong trade. The
   **non-custodial** constructions below are the right fit: only the cabinet-threshold can ever move
   the bond — not even the guardians.

**The cryptographic primitive (all tiers): a 2-of-3 threshold over [owner, custA, custB].** The owner
is 1-of-3 → cannot move the funds alone → cannot reclaim. The finding dies to *any* of these:

| Tier | Construction | Effort | Trade-off |
|---|---|---|---|
| **MVP** | **Plain 2-of-3 Bitcoin multisig** (Taproot/P2WSH) over [owner, custA, custB]; owner funds; 2-of-3 spends; PSBTs coordinated over Nostr; term = a CLTV/CSV timelock | **Weeks.** Standard crypto, **no Fedimint module, no federation.** | Bond lives on-chain (a UTXO); fund/return are on-chain txs with fees. Fine for an occasional, long-lived, value-significant bond. |
| **Elegant** | **FROST 2-of-3 (Resolvr Variant 1)** — DKG + ROAST; the key looks single-sig on-chain | **Months.** FROST/ROAST + DKG engineering; coordinate over Nostr or a federation. | More private (indistinguishable on-chain), threshold-elegant. Still on-chain, still non-custodial. |
| **Ecash-native** | **Fedimint ecash contract (Resolvr Variant 2 / §8)** — FROST-locked ecash, federation-enforced | **Months + a federation.** Custom module + guardian set. | Cheap, private, ecash-native — **but federation-custodial** (the fed can rug). Weakest for an un-rugable bond. |

**The funding rail — Jetty's Boltz instinct was right all along.** The MVP/elegant tiers hold the bond
on-chain, so the owner funds it by swapping ecash → LN → the on-chain multisig. **A Boltz-style
non-custodial swap is exactly that ecash→multisig rail.** The shot in the dark was the funding rail for
the shippable bond.

**What "months to solve the impossible" actually is:** the *impossible* (a cryptographic bond that
honors the commitment) is a **2-of-3 multisig MVP — weeks, standard crypto, no federation.** The
*frontier* (Resolvr FROST / an ecash module, first-of-its-kind on Fedimint) is the elegant upgrade you
build over months *after* the commitment is already honored by the MVP. You don't have to choose: ship
the multisig bond to be **honest now**, build Resolvr to be **beautiful later.**

**Engine reuse:** CREATE = the multisig/key setup; LOCK = fund the 2-of-3; return = the cabinet
co-signs; strand = withholding; restore = co-sign later; keystone = the multisig is built from verified
cabinet keys; attestation = informs the co-sign. The §0–§7 accountability model survives intact; the
*custody mechanic* becomes "co-sign a 2-of-3" instead of "deliver an SSS share."

**Revised recommendation:** **MVP = the 2-of-3 multisig** (Boltz-railed, Nostr-coordinated) — ship it to
honor the commitment. **Frontier = Resolvr FROST** (first-of-its-kind, maintainers cheering). Defer
Variant-2 ecash unless privacy/fees demand it *and* you accept federation custody.

**Update (2026-06-30, CC research + confirmed):** the ecash module (Variant 2) is **federation-custodial**
— a dishonest federation can rug it. For an un-rugable bond that's the wrong trade, so the **non-custodial
multisig is the PERMANENT top tier for real bonds, not a stopgap** — the module is the cheap/private ecash
**lane for lower-stakes cases**, not a replacement. Arc: **multisig = the vault forever; module = the ecash
lane later.** (CC's independent research reached §9's non-custodial-beats-custodial conclusion from the
other direction.) The four MVP forks are **settled** in `chama-bond-mvp-multisig-brief.md` → LOCKED: no
owner recovery leaf, owner-is-a-signer 2-of-3, residual accepted+documented, Mutinynet. Path C confirmed
`feasible-with-custom-module` but multi-month + needs a 3–5 independent guardian set at genesis — worth it
long-term, not the now.
