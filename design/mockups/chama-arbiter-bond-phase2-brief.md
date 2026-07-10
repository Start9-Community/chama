# CC Brief — Finish the Arbiter Bond (Phase 2): real custody, ceremony, lifecycle, enforcement

**Status:** DESIGN-LOCKED, ready to build. **The next major track after v4.2.1** (originally scoped as 4.1.0's spine; 4.1/4.2 shipped other work first). **§11 folds in the 2026-06-26 design-review refinements — read it alongside §0.**
**Author:** cowork (advisory), 2026-06-24. Design home: `docs/DESIGN-arbiter-economy.md`
(§3 keystone, §8 cap, §2 cabinet, §10 lifecycle, §12 paths, §13 loud prompt).
**Money-path lineage:** `docs/DESIGN-holder-only-shares.md` (the 2-of-3 SSS lock we reuse).
**Leave uncommitted** (Jetty does the git split). Confirm-first on anything that moves real ecash.

---

## 0. TL;DR — read this first

"Finish the bond" is **the single highest fund-risk piece of work in Chama.** It locks
**real ecash into a long-lived, multi-party custody** for the first time (every prior lock is
a short-lived *trade* escrow). Treat it with the same adversarial rigor as the funding/payout
work — and **stage it so no participant's money ever depends on an unproven custody loop.**

**The reframe that drives the whole plan:** the exposure cap (`exposure.ts`) is built and
unit-tested, and flipping `BONDS_ENFORCED=true` is a one-liner — **but doing that now would be
security theater.** A `kind:38130` bond today is an **unbacked declaration** (`bonds.ts` header
says so): a signed claim "I stake B," with **nothing locked.** An attacker declares
`bondMsats = 10_000_000` → instantly "Gold" → unlocks 1M-sat trades **with zero capital at
risk.** So:

> **The keystone of "finishing the bond" is the real SSS-lock custody (the money path), NOT the
> enforcement flip. Enforcement must not flip until a declaration is backed by locked ecash.**

Recommended split:

- **Phase 2A — custody + ceremony + lifecycle, enforcement OFF.** Build the real bond lock, the
  bonding ceremony, the cabinet heal/relock lifecycle, and the loud heal-prompt. Prove the full
  **lock → term → return → relock** loop on the **real BLF fed** with the trio's **own tiny,
  short seed bonds.** `BONDS_ENFORCED` stays `false`. No participant funds depend on this yet.
- **Phase 2B — flip enforcement, once 2A is proven live.** Wire the capacity context into
  assignment and flip `BONDS_ENFORCED=true`. Now the caps bind **real, backed** bonds.

4.1.0 can be **2A alone** (already a large, fund-critical release whose payoff is a *visibly
bonded cabinet* — real money locked, legible on the globe) with 2B following once the custody
loop has run live. Or ship both — **Jetty's call (see §9).** Either way, 2A lands before 2B.

---

## 1. Where we are (Phase 1 — DONE, dormant)

All built, pure, unit-tested, and **inert**:

- **`src/arbiters/exposure.ts`** — the §8 cap ledger. `classifyArbiterCapacity`,
  `canAssignArbiter`, `selectOverCapacityArbiters`, `assignablePool` — per-trade **and**
  aggregate (global, every chama) caps, both `≤`. `UNBONDED_FLOOR_MSATS = 10M` (sub-floor trades
  need no bond). `BONDS_ENFORCED = false` (line 50). Display bands Bronze/Silver/Gold (Gold ≥ 1M
  sats). **Always computes the truth; nothing acts on it.**
- **`src/arbiters/bonds.ts`** — `kind:38130` declaration: build / parse / sig-verify /
  term-gate / newest-wins select. **Header is explicit: declaration only, UNBACKED, a claim not
  custody.** This is the seam Phase 2 makes real.
- **`src/arbiters/pool.ts`** — the dormant assignment seam: `getTrustedArbiterPool()` →
  `if (BONDS_ENFORCED && options.capacity) return assignablePool(...)` (lines ~152-155). No prod
  caller passes `capacity` yet. `BLF_CABINET_NPUBS` = the n=3 trio (maintainer + Chapsmart +
  Graysatoshi), seeded; `BLF_OFFICIAL_ARBITERS` derives from it.
- **Apply flow exists:** `src/arbiters/applications.ts` (`kind:38121`) +
  `src/ui/components/ArbiterApplyForm.tsx` (shipped v3.1.1, wired into Browse + MeScreen).
- **Absent (Phase 2 builds these):** any bond-posting UI, any cabinet UI, any heal-prompt, the
  real lock, the lifecycle.

**Do not rebuild Phase 1. Build on it.**

---

## 2. The fund-safety risks (loud — design these in, don't discover them)

1. **Long-lived ecash inherits guardian risk.** A bond is locked for a **term** (weeks/months),
   not minutes. "Long-lived ecash dies with its mint" — a BLF guardian incident *during a term*
   can lose bonded capital. The design accepts this and bounds it by **sizing**. ⇒ **First live
   bonds must be tiny and short** (see §6 seed test). Term length is a risk dial, not a detail.
2. **Strand-by-withholding is irreversible by design.** Slash = the cabinet *declines to heal* →
   the bond never reconstructs → **gone forever** (this is the "burn," by inaction — it never
   *moves* anyone's funds, preserving the safety invariant). The flip side: if the custodians who
   could heal are **unavailable** at term-end (lost keys, offline), an **honest** arbiter's bond
   also strands. The **loud heal-prompt (§13 / step 2A-6)** and a generous return window exist
   precisely to stop accidental strands. **Cabinet key hygiene is load-bearing.**
3. **First real non-trade custody.** The reconstruct recipient is the **bond owner** (an
   arbiter), not a buyer/seller — `recipients.ts` is trade-shaped and needs a bond-class case.
   The caster is restricted to **cabinet members**, not "any pool backup." Both are new branches
   on fund-critical code (`handleVote`). Adversarial tests are mandatory (§8).
4. **Theater risk (the §0 reframe).** Never let `BONDS_ENFORCED` flip while any in-scope bond is
   an unbacked declaration. 2B's first line of defense is: *a bond only counts toward capacity if
   it is backed by a verified live lock*, not merely declared.

---

## 3. Invariants that must hold (from `DESIGN-arbiter-economy.md`)

- **2-of-3 is never weakened.** No bond mechanism may let one party seat two Shamir slots.
- **Healing stays REFUND-only to the engine-computed recipient.** For a bond, that recipient is
  the **owner**; no cabinet member can ever redirect a bond elsewhere. (`INVALID_HEAL_OUTCOME`
  is the existing guard — extend it, don't loosen it.)
- **Strand never MOVES funds.** Slashing = roster delisting + the public record + *withholding a
  heal*. There is **no active seize/burn** (rejected: it would rebuild the "third party moves
  your funds" capability the escrow forbids). Stranded sats benefit no one.
- **No vote-flip backdoor, ever.** Bonds/heals/relocks are forward-only.
- **Enforcement is consent-layer, never a reducer reject.** Over-capacity arbiters are *skipped
  at assignment*; a hand-seated one triggers a UI warn+ack. The reducer **always** accepts the
  LOCK — a live trade can never freeze on capacity drift. `assignablePool` already guarantees a
  **never-empty** fallback. Keep it.

---

## 4. Recommended staging

```
2A  custody + ceremony + lifecycle + loud prompt        BONDS_ENFORCED = false
    └─ seed test: trio posts tiny/short bonds on real BLF, heals them back
2B  wire capacity context + flip BONDS_ENFORCED = true   (only after 2A is proven live)
```

2A's payoff stands alone: a **bonded cabinet with real, locked, publicly-legible capital** —
the trust signal §11 wants ("read a chama's trustworthiness at a glance"). 2B turns the cap from
observational into binding.

---

## 5. Phase 2A — build plan

### Decision 0 (do this first): the bond share topology — **reuse the existing 2-of-3 verbatim**

The design leaves "owner = 1 share, cabinet = the rest" as an open build detail. **Recommended
MVP: a bond is a 2-of-3 SSS lock with roles `[owner, custodianA, custodianB]`** — i.e. the
*exact* `holder-shares.ts` construct, just relabeled from `[buyer, seller, arbiter]`. This buys
the design's asymmetry **with zero new crypto**:

- **Return** = owner's share + **either** custodian's heal-vote share = 2 ⇒ reconstruct ⇒ refund
  to owner. ("Any one custodian returns it.")
- **Strand** = both custodians withhold ⇒ owner holds 1 < threshold ⇒ stranded. ("All refuse.")
- For a **cabinet member's own seed bond**, the two custodians are **the other two cabinet
  members** — this is *literally* the design's "each member's bond SSS-held by the other two,
  return on any 1 of the other 2." Perfect fit.
- For a **general (non-cabinet) arbiter's bond**, pick **two** cabinet custodians (e.g.
  fed-owner + community-owner).

> Tradeoff to note, not solve now: this gives "any 1 of **2** custodians," not "any 1 of all 3."
> A 2-of-4 (`owner` + 3 cabinet) would give 1-of-3 redundancy but needs a new threshold path.
> **Ship the 2-of-3 reuse; leave 2-of-4 as a documented later generalization.** Reusing the
> audited lock is the single biggest fund-risk reduction available here.

### 2A-1 — Bond lock-class + auto-refund exclusion

- Add a **lock-class discriminator** so the engine knows "this lock is a BOND, not a trade"
  (e.g. a `lockClass: "bond"` on the lock payload, additive + consensus-safe like
  `expirySeconds`/`substitutionGraceSeconds`). Default absent ⇒ "trade" ⇒ byte-identical to
  today.
- **Extend the v2.9 suppression branch** in `handleVote`, `src/escrow-engine/state-machine.ts`
  **~lines 939-958** (the `isHealing` / `INVALID_HEAL_OUTCOME` block):
  - A **bond-class** lock is **excluded from auto-refund at expiry entirely** (a trade
    auto-refunds the locker at expiry; a bond must NOT — term-end is a *deliberate* cabinet heal,
    or it strands). This is "another branch of existing logic, not new machinery."
  - A bond heal is **REFUND-only to the owner** and **only a current cabinet member may cast it**
    (tighten the existing "any pool backup may heal" to "cabinet ∋ caster" for bond-class).
  - `recipients.ts` (`payoutRecipientFor`) gains a **bond-class case → recipient = owner**.
- `TRULY_TERMINAL_STATES` (`types.ts`) is unchanged; a bonded lock stays non-terminal so the
  ledger keeps counting it (mirrors how EXPIRED still exposes). Confirm an unhealed bond at
  term-end reads as **open exposure** until healed (it should — it still has ecash at stake).

### 2A-2 — The lock itself (reuse the bridge)

- Reuse the LOCK-time share split in `src/fedimint/escrow-bridge.ts` (~lines 188-265) and
  `holder-shares.ts`. The bond lock encrypts share 0 to the owner, shares 1/2 to the two
  custodians (NIP-44, exactly as trades do).
- **Self-sized by exposure:** the locked amount = the declared `bondMsats` = the exposure
  ceiling. The `kind:38130` declaration (`bonds.ts`) now references the **lock** (carry the lock
  id / escrow id in the payload) so a verifier can confirm *backed*, not just *declared*. (This
  is the 2B trust hook — see 2A-7.)

### 2A-3 — Bonding ceremony UX (two flavors, §3 / §12)

- **Cabinet seed ceremony (path "Bootstrap → Live", §12):** the trio locks **simultaneously**,
  each member's bond held by the other two. When all three locks finalize, the chama flips to
  **Live on the globe** (§12). This is the first thing built and the first thing seed-tested.
- **Individual arbiter "post a bond":** a new surface (no UI exists today) — pick term + amount
  (→ band via `exposureTier`), confirm, lock to two cabinet custodians. Entry stays free; this is
  **opt-in to raise your exposure cap above the 10M-sat floor**, never a turnstile (§K). Wire the
  CTA next to the existing `ArbiterApplyForm` path.

### 2A-4 — Term-end return (the happy path)

- Any **one** custodian casts the **REFUND-only return heal** → owner reconstructs → bond back.
  Reuse the heal vote path; the caster check from 2A-1 enforces cabinet-only.
- **Auto-refund-exclusion wiring:** bonds are a distinct lock class routed to *deliberate* return
  (extends the v2.9 suppression branch — 2A-1), never the trade auto-refund.

### 2A-5 — Slash (strand-by-withholding) + relock lifecycle

- **Slash = delist + public record + custodians decline to heal.** No new "seize" code. The
  challenge window (24-48h, §4) is **due process for a delisting**, not a confiscation court.
- **Term-boundary roster swap (§10):** replacing a good-standing cabinet member = (1) their bond
  heals back, (2) roster/meta drop+add via the same threshold write that seated the trio, (3)
  replacement posts their bond, (4) next term re-locks as the new three. **No funds at risk**
  (bonds returned before re-locking). Only an **emergency** (lost key / rogue) needs an off-cycle
  heal + re-lock.
- **Slashing a cabinet member's own standing → community consensus** (the high-stakes primitive),
  never the other founder alone. The MAD clause (§4) is the deterrent; build only the
  reputational path now (option i), leave bond-MAD (option ii) as a documented "gun on the wall."

### 2A-6 — The loud heal-prompt (§13, a UX invariant)

- Healing an honest peer's bond is the **single action that protects a peer** (return needs any
  one custodian). It must be the **loudest prompt a cabinet member ever gets** — impossible to
  miss, surfaced to every relevant custodian the instant a peer's bond is due for return. Pairs
  with reputational MAD: ignoring a loud, provable, in-term return request is visibly *choosing*
  to strand a peer.

### 2A-7 — Seed test (the gate for 2A → done)

**Run NATIVE (Tauri + APK), not browser.** The native Rust sidecar is the reliable lock/claim path;
browser WASM fedimint is the weaker one (Jetty, confirmed). The registry marks **GBF (US 🇺🇸) "Native
sidecar verified end-to-end"** — a known-native-good **control** fed if BLF ever needs ruling out.

⚠ **Correction (2026-06-25):** there is **no determination that BLF native lock/claim is broken.** The
BLF registry note (`IROH_LIMITATION_NOTE`) is about *browser* reliability ("Browser Fedimint reliable
via canary iroh bump"), and CLAUDE.md's "possibly BLF all-iroh-gateways" (#9) is an **unverified flag**,
not a finding. **Pre-flight (before CC builds the lock):** fund a few hundred sats of ecash on a
**BLF-default community** — any non-Africa / non-LatAm country with no pre-seed (Germany 🇩🇪 / India 🇮🇳 /
Philippines 🇵🇭; `defaultFederationForCountry` routes Africa→OCA, LatAm→LatNet, **everywhere else→BLF**;
us-blf/global-usd are hidden) — on **Tauri + APK** and confirm it mints. If it mints, BLF native funding
works and the seed test runs on BLF natively. If it can't, run `/gateways` + `/probe-gateways` on BLF's
bridge (port = frontend+15000) — only an all-iroh gateway set is a real gap.

**Two stages:**
- **Stage 1 — self-cabinet plumbing test (Jetty solo).** Play all **3 cabinet seats** across the 3
  Tauris + APK with 3 self-controlled npubs. Params (LOCKED 2026-06-25): **~500–1,000 sats each**, a
  **test-override term cyclable in minutes** first, then a **few-day** standing term. Prove
  **lock → declaration references the lock → term → loud prompt → one custodian heals → owner
  reconstructs → relock**; then **deliberately strand** a throwaway (all withhold → never reconstructs,
  never auto-refunds, harms no one). Self-keys prove the **plumbing**, not the trust model.
- **Stage 2 — real-trio dress rehearsal (go-live gate).** Jetty + Chapsmart + Graysatoshi on BLF — the
  only stage that exercises the **independent-custodian** property. Gates 2B.

**Nothing about participant trades changes during 2A** (`BONDS_ENFORCED` stays false). This live loop
is the prerequisite for 2B.

---

## 6. Phase 2B — flip enforcement (only after 2A is proven live)

- **Back-only counting.** Update the capacity reader so a bond counts toward an arbiter's
  capacity **only if it is backed by a verified live lock** (2A-2's lock reference), not merely a
  `kind:38130` declaration. This closes the theater hole (§0/§2.4).
- **Wire the capacity context** (`PoolCapacityContext`: `tradeMsats`, `bondEvents`, `allTrades`,
  `excludeTradeId`) into the assignment call site:
  - **`src/fedimint/escrow-bridge.ts` ~lines 161-163** — `pickArbiterFromPool(state.communityArbiters, …)`
    (the LOCK-time seat). Feed `getTrustedArbiterPool({ community, capacity })`.
  - **`src/ui/screens/CreateForm.tsx` ~lines 1061-1092** — the pre-fund preview pool. Same
    context from the current trades/bonds snapshot, so the creator sees the eligible pool *before*
    funding.
- **Flip `BONDS_ENFORCED = true`** (`exposure.ts:50`). Now `assignablePool` skips over-capacity
  arbiters (consent-layer) while **never emptying the pool**. Per-trade + aggregate caps bind
  real capital.
- Surface the band + cap honestly in the arbiter/provenance UI ("backed by X sats; covers trades
  ≤ X"). Keep the honesty note loud (§ "Honesty note"): bond + ratings + identity + 2-of-3
  **compose**; no single one is the whole wall.

---

## 7. What this does NOT touch (keep the blast radius small)

- **Tips / pay (§5-7), ratings (§6), response-window rotation (§4)** — separate streams, out of
  scope for 4.1.0. The bond self-sizes exposure; rep does not gate it.
- **The funding/payout money path** (the v4.0.0 work) — unrelated; do not regress it.
- **Fed-switching across the multi-fed set** — unchanged; bonds bind the community fed by
  construction.

---

## 8. Verification (fund-critical — non-negotiable)

- **Unit tests (new):** `src/arbiters/` and `src/escrow-engine/` —
  - bond share topology: owner+A return, owner+B return, owner-alone strand, A+B-withhold strand;
  - bond heal is REFUND-only-to-owner; a **non-cabinet** caster is rejected for a bond-class lock;
  - bond-class lock is **excluded from auto-refund** at expiry (trade-class still auto-refunds);
  - cap math already covered — add: a **declared-but-unlocked** bond contributes **zero** capacity
    once 2B's back-only-counting lands.
- **Adversarial sweep (write these as tests, the way the payout sweep was):**
  - declare `bondMsats=∞` with no lock → must NOT unlock exposure (2B);
  - double-heal / replayed return vote → no double reconstruct;
  - lost-key strand of an honest bond → loud prompt path + (later) recovery story documented;
  - term-clock gaming (`created_at` self-asserted) → C11 clamp (`arbiter-substitution.ts`) holds;
    return-only-to-owner means clock-gaming is not a theft vector — assert it.
- **`npm run predeploy`** green (typecheck + the full suite; ~2,700 tests as of 2026-06-23).
- **Real-fed seed-bond live test (§2A-7)** with a written rollback: if any lock/heal misbehaves,
  the trio's bonds are tiny and short, and strand harms only the trio's own seed sats.
- **Spin up a subagent for an independent adversarial read of the heal/strand branch** before
  Jetty's sign-off (this is the highest-stakes diff in the app).

---

## 9. Decisions (LOCKED 2026-06-24 — defaults taken)

1. **4.1.0 scope:** ship **2A alone** (bonded cabinet, enforcement still off — conservative,
   recommended) or **2A+2B together** (caps go live in one release)?
2. **First-live aggressiveness:** seed-test with **trio-only tiny/short bonds** first
   (recommended) vs. open individual-arbiter bonding immediately.
3. **Term length** for the first real bonds (the guardian-risk dial — recommend **short**, e.g.
   days-to-weeks, for the first term).
4. **Custodian count per bond:** reuse **2-of-3 (2 custodians)** now (recommended) vs. build
   **2-of-4 (any 1 of all 3)** up front.

**LOCKED 2026-06-24 (Jetty):** all four taken at the recommended default —
**2A first · trio seed test · short first term · 2-of-3 reuse.** The 2-of-3 = owner's own
1 share + **2** cabinet custodians (no 2-of-4; the "4" was never a 4th cabinet member, just the
owner's own share counted among the shares). The lowest-fund-risk path on every axis.

---

## 10. Seam map (read-verified, 2026-06-24)

| Seam | File:line | Role in Phase 2 |
|---|---|---|
| Auto-refund / heal branch (v2.9) | `escrow-engine/state-machine.ts:939-958` | extend for bond-class: exclude auto-refund, cabinet-only caster, REFUND-only-to-owner |
| `isPerformanceContest` | `escrow-engine/arbiter-substitution.ts:241` | reference for the carve-out shape |
| Recipient computation | `escrow-engine/recipients.ts` (`payoutRecipientFor`) | add bond-class → owner |
| 2-of-3 SSS lock | `escrow-engine/holder-shares.ts` (+ `docs/DESIGN-holder-only-shares.md`) | reuse verbatim, relabel roles `[owner, custA, custB]` |
| LOCK-time split | `fedimint/escrow-bridge.ts:188-265` | reuse for the bond lock |
| Arbiter seat (assignment) | `fedimint/escrow-bridge.ts:161-163` | 2B: feed `capacity` |
| Pre-fund preview pool | `ui/screens/CreateForm.tsx:1061-1092` | 2B: feed `capacity` |
| Capacity seam (dormant) | `arbiters/pool.ts:134-156` | 2B: flips live via `BONDS_ENFORCED` |
| Cap ledger | `arbiters/exposure.ts` (`BONDS_ENFORCED` @50) | 2B: flip; back-only counting |
| Bond declaration | `arbiters/bonds.ts:72-111` | carry a lock reference (backed, not just declared) |
| Cabinet trio | `arbiters/pool.ts:30-38` (`BLF_CABINET_NPUBS`) | the seed custodians |
| C11 term clamp | `escrow-engine/arbiter-substitution.ts:54,73` | term-clock safety |
| Apply CTA (exists) | `ui/components/ArbiterApplyForm.tsx` | wire "post a bond" beside it |
| Bond/cabinet UI | (absent) | build: ceremony, post-a-bond, loud heal-prompt |
| Tests | `escrow-engine/tests.ts` (~346 cases) | extend; add bond/cabinet specs |
```

---

## 11. Refinements folded in (2026-06-26 design review — binding precision + the shape of 2B)

A stress-test of the model (Jetty + an outside take + cowork). **Nothing here changes the 2A
staging or Decision 0** — it sharpens the honest claims and pre-shapes 2B. Ordered most-important
first.

### 11.1 — "The cabinet cannot steal" is collusion-resistance-by-stake, NOT cryptographic impossibility — say it precisely

Flat 2-of-3 reuse (Decision 0) is the right call, but it has a property the public claim **must**
respect: **any 2 of the 3 shares reconstruct — including custodianA + custodianB *without* the
owner.** Those two custodians are the other two cabinet members; if they collude they can combine
their own decryptable shares **off-protocol** and rebuild the owner's bond. The
`INVALID_HEAL_OUTCOME` / REFUND-only-to-owner binding (§3) stops the *protocol* from ever
redirecting a heal — but it **cannot** stop two humans who each hold a readable share from
combining them by hand. This is the **same** inherent 2-of-3 property the trade escrow already
lives with (arbiter + one party can always collude); the bond does **not** invent a new vector.

So the honest — and actually *stronger* — claim is:

> **No single cabinet member can touch your bond. Seizing it takes two members colluding, which
> burns their own staked bonds and their public standing, detectably, forever. The math stops one;
> mutual stake stops two.**

That is the MAD-by-mutual-stake the take was reaching for ("if I misbehave I burn capital and
standing in public"). **Never ship the words "cannot steal" unqualified.**
- **Detectability:** a colluded seizure spends the bond ecash with no authorized return — surface a
  "bond returned vs. went-dark" status so a seizure reads *as* a seizure (Fedimint exposes the
  spent nonce, though blind to *whom*).
- **Hardening path (deferred, documented):** to make the owner's share *cryptographically
  mandatory* (block custA+custB) you need a **nested** secret — `owner AND (custA OR custB)`, not
  flat 2-of-3. New crypto; keep the 2-of-3 reuse for 2A, leave nesting as the maturity upgrade if
  collusion-by-stake ever proves too weak.

### 11.2 — Strand mechanic, corrected (replaces any "burn slightly pays the operator" framing)

A stranded bond is **stranded, not seized, and pays no one — including the operator.** The shares
never recombine, so the note is never redeemed; blind issuance means the federation can't identify
or redeem the dark note, and can't pull its backing without peg-ing out more than the abandoned
amount (which would undercollateralize live holders — a betrayal of *all* ecash, not a capture of
the strand). The value sits as permanent over-collateralization, claimable by no one. The owner's
deterrent is intact (their sats leave their control); the bond adds **no operator-capture surface**.
This is the mechanism behind §3's "stranded sats benefit no one."

### 11.3 — NEW 2B rule: pool-redundancy gate ("thin pool" protection)

Today's cap answers "can the *assigned* arbiter cover this trade?" It never asks "if she ghosts, do
enough *backups* have capacity to heal it?" — and the whole substitution/heal path is worthless if
the answer is one. Add to 2B: a high-value trade is assignable only if **≥2 (ideally 3) arbiters in
the assigned arbiter's substitution chain each have remaining capacity ≥ the trade size.** Below
that → **pool-thin** → cap the size / warn / block (consent-layer, never a reducer reject). For the
seed cabinet this just means the trio needs bonded depth before high-value trades open. (Round-robin
is capacity-*blind*, so it can *manufacture* thinness by piling exposure on one arbiter;
capacity-aware assignment — seat the most-headroom eligible arbiter — would help, but only if every
client recomputes the **same** exposure snapshot from the chain or replay diverges. Document it as
an option, not a 2B requirement.)

### 11.4 — NEW exposure rule: a bond only counts if it OUTLIVES the trade

A bond counts toward capacity for a trade **only if its remaining term exceeds the trade timeout +
dispute window + return/heal window.** A bond expiring tomorrow must not authorize a 7-day lending
trade today — it would expire mid-dispute, unbacked. Plugs straight into `trade-durations.ts`
(Exchange 3h … Lending 7d): the bond's **remaining term** becomes an input to the duration clamp,
and an arbiter's eligible *max trade duration* shrinks as the bond nears expiry. Surface it ("bond
expires in 2d — trades ≤ that, minus dispute+return").

### 11.5 — Honest-actor strand from INACTIVITY (not just refusal) — add an escape hatch

§2.2 frames strand as adversarial withholding; the likelier failure is **benign** — a custodian
loses a key or drifts off, and an *honest* arbiter's bond (1 share < threshold) can never return.
The loud heal-prompt (2A-6) mitigates malice, not a dead peer. Add a **timelock self-return
fallback**: after `term + a long grace`, the owner recovers with their share alone (the lock
degrades to 1-of-1). It weakens "locked" only *far* past term-end, and it's the difference between
"honest arbiter waits on a peer" and "honest arbiter loses capital to a peer's dead phone." Low risk
for the trio; **build the hatch before opening individual (non-cabinet) bonding.**

### 11.6 — Exposure-view completeness: the aggregate cap must FAIL SAFE

The §8 aggregate cap (Σ open across *all* chamas < bond) is only as honest as the relay view of
every open trade — the **same** completeness gremlin that drops chat messages on a fresh device. A
partition that hides one open locked trade **under-counts** exposure and **over-authorizes**. The 2B
reader must fail **safe**: when the exposure view is provably incomplete (fewer relays than quorum
answered, a watched trade didn't resolve), **assume more exposure, never less** — degrade the
eligible cap, don't inflate it. Over-authorization is real fund risk; under-authorization is only a
missed trade.

### 11.7 — Two-key split (identity vs. custody): deferred, YAGNI for 2A

Separating a public identity/roster/reputation key from a bond-custody key is sound hygiene
*eventually* (rotate custody without rewriting social identity), but for three known cabinet members
it buys a rotation feature you don't need yet and **costs a new primitive** — a signed
identity→custody attestation, or an attacker substitutes/repudiates a custody key. One key per
member for 2A; revisit at many-arbiter scale.

### 11.8 — Restorative strand: a stranded bond is RECOVERABLE on remediation (the bond+extra superpower)

The strand is **reversible, and that's the point.** Because "strand" = *withholding* the bound
return-heal (§11.2: nobody can seize it — it just sits, reconstructable), the cabinet can cast that
return-heal **at any later time** — including the day a slashed arbiter makes the victim whole
(returns the defrauded buyer/seller's sats). Restoration isn't a new feature to build; it's the
strand **being reversible by construction.** The punishment and the path back are the **same lever**,
held or released — restorative justice with **no DAO, no court, no token**, just the cabinet's
discretion to re-open the heal once amends are proven.

Why it's strong (and why the cap makes it work): under pure-burn a *caught* arbiter has **no reason
to remediate** (the bond's gone either way) → the victim may never be repaid. Under restorative
strand the rational caught actor **remediates to recover the bond** → the victim is made whole. And
remediation is the *dominant* strategy **precisely because §8 already enforces bond ≥ trade
exposure** — the bond you recover by making good is ≥ the sats you could keep by defrauding. The cap
isn't only an exposure bound; it's what makes "make the victim whole" the rational move. Same coin.

Build honestly:
- **The judge is cabinet discretion, not a cryptographic proof.** "They proved they refunded" =
  "the cabinet is convinced." Harden the happy path with a **victim attestation** (the defrauded
  user signs a "made whole" event the cabinet keys on) — but keep cabinet override, because a paid
  victim can **refuse to sign to extort** ("pay me again or your bond stays dead"). Attestation as
  the clean path; cabinet judgment as the backstop.
- **Restore the bond, NOT the standing.** Disgorge + repay — but the delisting + public record stay
  permanent even after the bond returns, or fraud becomes *free-if-you-remediate*. Two ledgers:
  capital can come back, reputation does not.
- **Bounded by federation health.** A long strand still inherits guardian risk (§2.1) — the
  "restore anytime" window can't outlive BLF's continued backing of that ecash.

### 11.9 — The nested "owner-mandatory" hardening, in detail (deferred — the real tradeoff)

Goal: make the owner's share **cryptographically required**, so the two custodians **alone** can't
reconstruct — closing the §11.1 collusion path without leaning on stake/MAD. Construction is a
two-level threshold **tree**, `owner AND (custA OR custB)`, no exotic math:

1. **AND layer (2-of-2):** split the bond secret `S` into `K_owner + K_team` (XOR/additive) — need
   **both** halves to get `S`.
2. **OR layer (1-of-2):** make `K_team` recoverable by **either** custodian → give custA and custB
   **each a copy** of `K_team`.
3. Reconstruct = `K_owner` (owner only) + `K_team` (either custodian). custA + custB hold `K_team`
   (and a spare copy) but **never `K_owner`** → locked out. Owner-alone has `K_owner`, no `K_team` →
   locked out. Exactly "owner + any one custodian."

Why it's deferred, not recommended:
- **New crypto on the money path.** It's a *different* lock shape than the audited flat-2-of-3
  `holder-shares.ts` → you forfeit Decision 0's biggest safety win (reuse the hammered construct)
  and take on fresh audit surface — the opposite of the 2A posture.
- **It breaks the §11.5 inactivity hatch.** That hatch is "after a long timelock the owner recovers
  with their *own share alone*" — but owner-mandatory makes owner-alone insufficient by design. You
  can't have both "custodians-alone can't" and "owner-alone eventually can"; you'd need a separate
  timelocked reveal of `K_team` to the owner. More machinery on the most dangerous path.
- **Owner-key-loss becomes strictly fatal** (cabinet holds `K_team`, never `K_owner` → no recovery).

When it earns its keep: a **large or anonymous** cabinet, where "they'd burn their standing" is a
weak deterrent (many members, many collusion combos, low mutual visibility). For the **tight,
mutually-bonded trio**, the *economic* collusion-resistance of §11.1 is sufficient and free.
**Recommendation: flat 2-of-3 + restorative strand (§11.8) + the honest MAD claim now; nest only
if/when the cabinet outgrows a trusted set.**

**The trigger rule (pin this — it IS the decision): escalate by TRUST, not size.** Stay on
social-MAD (flat 2-of-3) for any cabinet where you'd vouch for **every** member with your **own**
sats; switch to **nested owner-mandatory (§11.9)** the instant you'd seat someone you only trust
*"enough."* The worst case for social-MAD is the **sleeper** — plays straight to bank street-cred,
then defects once trusted — and that is the *exact* adversary nesting neutralizes (a sleeper still
needs a co-defector, and can't beat owner-mandatory crypto, so the path closes). **Corollary
(Kerckhoffs): the design must stay safe even when a cabinet member understands it completely —
never rely on a member's ignorance.** A smart, skeptical member who has seen every seam and still
plays straight is the *strongest* seat there is (informed honesty > ignorant honesty) and the best
free red-team you'll get before real sats lock. If the only thing keeping a cabinet honest is that
nobody looked too hard, the seam isn't closed — **close it (nest), don't hope for it.**

---

## 12. CC EXECUTION — build order + the autonomous adversarial test rig

The build-and-prove layer (the "CC brief" half). §5 has the seams; this is the *order* and the
*test rig* — including the all-keys autonomous setup Jetty proposed, which is the only configuration
that can directly **prove** §11.

### 12.1 — Build order (2A, `BONDS_ENFORCED = false` throughout)

1. **Decision 0** — bond = flat 2-of-3 reuse, roles `[owner, custA, custB]` (locked).
2. **2A-1** bond lock-class + auto-refund exclusion (`state-machine.ts` v2.9 branch).
3. **2A-2** the lock (reuse `escrow-bridge.ts` LOCK split; the `kind:38130` declaration references the
   lock id, so a verifier sees *backed*, not just declared).
4. **2A-4** term-end return (one custodian heals → owner reconstructs) — build BEFORE strand so the
   happy path is proven first.
5. **§11.8 restorative wiring** — the return-heal is castable *any time*, not only at term: add the
   "restore on remediation" path + a **victim-attestation seam** (a signed "made whole" event) with
   cabinet override. This is the superpower; wire it into the return path, not as a bolt-on.
6. **2A-3** ceremony UX (cabinet simultaneous seed lock → chama flips Live; individual post-a-bond).
7. **2A-5** slash / strand-by-withholding + relock; **2A-6** the loud heal-prompt.
8. **UI honesty (§11.1)** — never render "cannot steal" unqualified; ship the MAD-by-mutual-stake copy.
9. **§11.5 inactivity timelock** — build the honest-actor self-return BEFORE opening individual
   (non-cabinet) bonding.

2B (caps live + §11.3 redundancy gate + §11.4 outlives-the-trade + §11.6 fail-safe counting) lands
only after 2A is proven on the **real trio**.

### 12.2 — The autonomous adversarial rig (CC-driven) — Stage 1, supercharged

CC creates **3 self-controlled nsecs**, runs 3 instances against a **Jetty-preconfigured fed** (Jetty
funds tiny sats, pastes to lock), and drives the whole loop + the proof matrix. One hand on all three
keys is the *only* setup that can demonstrate the game theory directly.

**Proof matrix** (each as a scripted scenario + a deterministic suite test where possible):
- **P1 — collusion is real.** custA + custB combine their raw shares **off-protocol** → reconstruct an
  owner's bond *without* the owner. It SUCCEEDS on flat 2-of-3 → the live proof behind §11.1's honest
  claim. Document it as *expected*, not a bug.
- **P2 — restorative reversibility.** Strand a bond (withhold), then later cast the return-heal → owner
  recovers. Proves §11.8: punishment and the path back are the same lever.
- **P3 — (once §11.9 nesting exists) collusion FAILS.** The identical custA+custB attempt can't
  reconstruct → proves owner-mandatory.
- **P4 — outlives-the-trade.** A near-expiry bond can't authorize a long trade (§11.4 clamp).
- **P5 — inactivity self-return** unlocks only after `term + grace` (§11.5).

**Rail 1 — Stage 1 ≠ Stage 2.** One actor with all keys proves the *plumbing and the math*, NOT the
**independent-custodian** property the bond exists for. The real-trio dress rehearsal (Jetty +
Chapsmart + Graysatoshi, independent keys, the real heal-prompt) is a SEPARATE gate and the only one
that clears 2B. CC-auto must never be logged as "Stage 2 done."

**Rail 2 — bound blast radius (confirm-first holds for a bot).** Tiny throwaway sats (~500–1,000),
**Jetty funds and owns every "lock real ecash" moment.** CC owns the exhaustive *logic + adversarial
matrix* in browser-preview and as suite tests (where the rare double-reconstruct / double-pay races
actually get caught); the **real-native-fed lock** — the reliable path, where sats move — stays the
supervised, hands-on step. The fund-safety invariants (no double-pay, no double-reconstruct,
fail-closed journaling) are proven as **tests**, not by live clicking alone.

**Instrument it.** Log every step (platform / share-index / heal-caster / reconstruct-outcome) so a
failing autonomous run is *diagnosable*, not an opaque red. Spin up the adversarial-read subagent
(§8) on the heal / strand / restore branch before Jetty's sign-off — highest-stakes diff in the app.

---

## 13. 2A-2 PRE-FLIGHT — decisions settled before the money-path lock

2A-1 (pure engine, `category==='bond'`) landed green + adversarially cleared (2803 tests). **2A-2 is the
first real ecash** — the SSS bond LOCK in `escrow-bridge.ts`. Start it with the below already decided so
the money path is not where they get discovered. Do **0** first, then build 2A-2 to satisfy **1–3**,
behind the review gate.

**0. Clean up the `isPerformanceContest` overload (2A-1 tidy, do first).** At the auto-refund site, skip on
`isPerformanceContest(state) || isBondEscrow(state)` and restore `isPerformanceContest` to
performance-contests-only. A shared fund-predicate that silently includes bonds at *every* future call site
(incl. `votePrompt`/`canVote`) is a leak we don't want. If it stays overloaded: a loud comment + a test
asserting every current call site's bond-inclusion is intended.

**1. The LOCK seating invariant (M1, made a hard gate).** At LOCK, whatever the CREATE convention:
**owner → share-0 (BUYER), custodians → share-1/share-2; assert `buyerPubkey === owner`; recipient routes
off the `owner` field; reject `owner===custA`, `owner===custB`, `custA===custB`.** A misseated owner
self-strands — the assert makes that impossible.
   - *CREATE convention (CC picks the least-churn mechanics that satisfy the invariant):* cleanest is a
     **bond CREATE that seats no trade-slot** — it records `owner` + the two custodian pubkeys as bond
     fields, and LOCK does all the seating. That sidesteps the "signer → SELLER" trap (M1) with no
     cross-signing dance. Do **not** implement the brief's literal "an arbiter locks their own ecash" naively
     — that phrasing *is* the M1 trap.
   - *Ceremony tie-in (2A-3):* the seed ceremony should read as **each member posting their own bond**, not
     peers cross-creating. **DECIDED (Jetty, 2026-06-29): Flavor A — self-create.** Bond CREATE seats
     **no** trade-slot; LOCK seats owner→share-0 + the two custodians. Each member posts their *own*
     bond; chama flips Live when all three lock. Flavor B (cross-create) rejected — the UX friction
     isn't worth the small code saving, and security is a wash given §13.2.

**2. ⭐ THE KEYSTONE CHECK — validate the custodians against the cabinet roster.** Above the seating
mechanics in importance. **The two custodians MUST be verified real cabinet-roster members**
(`BLF_CABINET_NPUBS`, reusing the existing arbiter-provenance / self-roster machinery). Without it, an owner
names two **sock-puppet** custodians they control → owner + 1 puppet = 2 shares → the bond is
**self-returnable** → strand-by-withholding is defeated and the whole bond is theater. **A bond whose
custodians aren't roster-verified must not lock.** This is the bond's reason to exist — gate it hardest.
(This is distinct from M1: M1 is the owner misseated → self-*strand*; this is the custodians being fake →
self-*return*. The second is the more dangerous, and 2A-1's panel didn't cover it — there was no LOCK yet.)

**3. Forward gates that land in 2A-2:** M2 (reject `SUBSCRIBE` / `PERIOD_RELEASE` on a bond); M4 (64-hex
`owner` validation); confirm the parser treats an unknown `'bond'` category the consensus-safe way *before*
any bond event reaches the wire.

**4. The 2B gate (do NOT flip `BONDS_ENFORCED` until):** M3 — exclude bonds from `exposure.ts`'s
arbiter-summation, or a custodian's own bond seat double-counts as their arbiter exposure and corrupts the cap.

**5. Posture:** 2A-2 is the *you-own-every-lock* step — behind the review gate, tiny Jetty-funded sats, CC
pauses before the first real lock. Prove the **lock → heal → strand → restore** loop with the §12.2
autonomous rig before 2A-2 is called done.
