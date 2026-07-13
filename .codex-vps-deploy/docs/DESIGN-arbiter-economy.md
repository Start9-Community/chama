# Design — Arbiter Economy (provenance, admission, rotation, reputation)

Status: DESIGN (captured 2026-06-05). Two pieces shipped in **v2.3** —
arbiter-pool *provenance* (the "close the door" guard) and the *committed
substitution grace* — and are marked SHIPPED below. The economy itself
(salaried rotation, applications, ratings, consensus admission, bonds) remains
design-only and is gated on the Ratings primitive
(see [BACKLOG.md](../BACKLOG.md) → "Ratings primitive (core)").

This doc is the home for "what stops someone adding an arbiter to cheat
everyone?" — the maintainer's own framing — and the longer arc that turns
arbitration from a hardcoded bootstrap list into a real community institution.

Money-path lineage: builds on
[DESIGN-holder-only-shares.md](DESIGN-holder-only-shares.md) (the cryptographic
2-of-3) and [DESIGN-arbiter-substitution.md](DESIGN-arbiter-substitution.md)
(pool backups + healing). The standing rule from that arc carries forward
verbatim: **vote immutability is permanent policy. There is no vote-flip
backdoor, and any future exception requires Chamacito community-consensus
voting — never a maintainer switch.**

---

## 0. Threat model — the "arbiter door"

A trade's `communityArbiters` ride in on the CREATE event, set by the
**creator's own client**. Until v2.3 the reducer only checked that the LOCK's
chosen arbiter was a *member of that pool* — never that the pool itself was the
community's real one. So:

- A hostile creator stuffs `communityArbiters` with **sock-puppet keys they
  control**.
- At LOCK the assigned arbiter (and, since v2.1, the substitution backups) are
  drawn from that poisoned pool.
- In a dispute, "the neutral arbiter" is the creator's puppet. If the creator
  is also a party, they effectively seat **two of the three Shamir slots**
  (their own + the arbiter), defeating the 2-of-3.

Healing cannot be abused this way — it is REFUND-only to the engine-computed
recipient (`INVALID_HEAL_OUTCOME`), so a sock-puppet backup can only return the
locker's own sats. The live hole is **normal dispute substitution**, where the
arbiter vote carries the deciding share.

### Why not a hard reducer reject?

Rejecting an "unrecognized arbiter" LOCK at the state-machine level would turn
**registry drift into a funds-stranding DoS**: a client on an older registry,
or a community mid-election, would see legitimate trades become unspendable.
The threat here is **trust**, not **validity** — so the close is informed
consent, not a protocol gate. (If a future version makes the official pool a
signed, replayable on-chain artifact, a hard gate becomes safe; not before.)

---

## 1. SHIPPED (v2.3) — Provenance: classify, badge, warn

`classifyArbiterProvenance(communityArbiters, trustedPool)` in
`src/arbiters/pool.ts` is the pure heart. It partitions a trade's pool against
the set **this device** trusts for the community
(`getTrustedArbiterPool({ community })` = official ∪ local ∪ env), returning:

```
{ recognized[], unrecognized[], verified, hasPool }
```

- `verified` = non-empty pool AND every member recognized.
- `hasPool=false` = raw/legacy escrow, neutral (no warning).

Surfaces:

- **TradeDetail PARTICIPANTS panel** — a quiet green "Community-verified
  arbiters" tick when clean; an amber "⚠ UNRECOGNIZED ARBITER(S)" card naming
  the exact keys when not. Visible to everyone, including the prospective
  locker before they fund (the money-at-risk moment).
- The official community pool is the **shared baseline**, so two honest clients
  on it always agree (green). A stuffed pool surfaces its foreign keys to the
  counterparty the instant they open the trade.

Deliberately *not* shipped yet: a Browse-card pre-warning (more surface, lower
signal pre-lock) and a hard Fund-modal confirmation gate (revisit if field use
shows people lock through the banner).

## 2. SHIPPED (v2.3) — Committed substitution grace

`LockPayload.substitutionGraceSeconds` (additive, consensus-safe exactly like
`expirySeconds`) lets the locker commit the ceiling on the assigned arbiter's
exclusive window. `substitutionEligibleAt` reads it as
`disputeStart + min(clamp(grace, 0, 4h), half-life)`. Absent ⇒ the legacy 4h
default, byte-identical to v2.1/v2.2. Clamped so a committed value can only make
backups eligible **sooner**, never later (a longer window only delays rescue of
the locker's own funds, and healing refunds at expiry regardless). A power-user
card (`chama_substitution_grace_seconds`) drives short floors for testing.

---

## 3. DESIGN — Admission: who may be an arbiter at all

Today the pool is the hardcoded `BLF_OFFICIAL_ARBITERS` bootstrap for every
non-hidden community. The economy replaces this with **per-community
admission**, but provenance (§1) is the invariant that must survive the
transition: whatever the admission mechanism, a verifying client must be able
to reduce a trade's arbiter to "∈ the community's known set" from replayable
data, not the creator's say-so.

Candidate mechanisms, in increasing order of decentralization:

1. **Signed roster (near-term).** The community publishes a signed `kind:38104`
   roster event; clients treat its members as the official pool. Provenance
   then checks against the roster, not a baked constant. Sybil-resistant only
   as far as the roster signer is trusted.
2. **Consensus admission (the maintainer's ask).** A candidate *applies*; the
   community's existing members (or the Chamacitos at large) **vote** them in.
   Admission is itself a community-consensus event — the same governance
   primitive that the vote-immutability rule reserves for high-stakes change.
   This is the honest answer to "what stops someone adding an arbiter": **you
   cannot add yourself; the community admits you.**
3. **Bonded admission (later).** An admitted arbiter posts a bond (ecash locked
   to a community-controlled escrow) that is slashable on proven misconduct.
   Turns reputation from purely social into partly economic collateral.

Open sharpenings (carried from the capture session):

- **Seat-capture / Sybil.** Consensus admission only helps if the *electorate*
  isn't itself Sybil. Bootstrap with the known roster, widen the franchise as
  ratings (§5) accumulate real history. Bonds raise the cost of a captured
  seat.
- **Provenance vs admission.** §1 closes the *unvalidated-pool* door now;
  admission decides *who is allowed in the pool* later. They compose: a signed
  roster makes `getTrustedArbiterPool` a verifiable lookup instead of a
  device-local guess, upgrading the green badge from "I recognize these" to
  "the community elected these."

## 4. DESIGN — Rotation: keep arbiters live, not lazy

Substitution (v2.1) already routes around an absent arbiter mid-dispute. The
economy adds **proactive rotation** so absence is rare:

- **Response-window rotation.** An arbiter who repeatedly lets the grace floor
  lapse (forcing backups to step in) drops in assignment priority. The
  `disputeStart → substitutionEligibleAt` gap is already measured per trade;
  aggregate it into a response score.
- **Salaried/duty pay (structure locked, price open).** Per
  [BACKLOG.md](../BACKLOG.md) → "Arbiter incentive economics": **duty pays, not
  power** — a dispute-triggered flat fee, not a percentage of every assignment.
  "Arbiter was needed" already rides on the public trade receipt. Exact amounts
  are a post-v1 empirical question (let real usage set them).
- **Opt-in availability.** `kind:38104` availability signals let an arbiter mark
  themselves unavailable for certain amounts/windows so rotation skips them
  cleanly instead of discovering absence at dispute time.

## 5. DESIGN — Reputation: the real collateral

Gated on the **Ratings primitive** (BACKLOG, core unblock). Once
per-counterparty ratings are captured at claim/complete:

- **Arbiter public dashboard** (read-only v1): trades assigned, disputes
  handled, outcome breakdown, response latency, community revocations.
  Reputation is legible; a bad arbiter is visibly bad.
- **Graduated franchise.** Admission voting weight and assignment priority lean
  on accumulated, non-gameable history rather than name recognition.
- **Revocation.** A community can vote an arbiter out; the roster event updates;
  provenance (§1) immediately stops badging their trades as verified.

---

## Invariants (must hold through every stage)

1. **Provenance is reducible from replayable data.** A verifying client decides
   "is this arbiter community-recognized?" without trusting the creator.
2. **2-of-3 is never weakened.** No admission/rotation change may let one party
   seat two Shamir slots. (§0 is the thing we are permanently closing.)
3. **Healing stays REFUND-only.** Economy changes never grant a backup an
   arbitrary payout — only the engine-computed refund recipient.
4. **No vote-flip backdoor, ever.** Admission, rotation, bonds, and slashing are
   all *forward* mechanisms; none rewrites a settled vote. High-stakes change
   goes to community consensus, not a maintainer.

## Build order (when this leaves design)

1. Signed `kind:38104` roster → provenance checks the roster (upgrade the badge).
2. Ratings primitive (separate keystone) → arbiter dashboard read-only.
3. Consensus admission events (apply → community vote → roster update).
4. Duty-fee wiring on the dispute path; response-window rotation scoring.
5. Bonds + slashing (last; needs ratings + admission + a community escrow).

---

## Maintainer field-read (2026-06-05) — refinements + open tensions

Captured live while reading this doc the day v2.3 shipped. Each item is tagged
ACCEPTED (folds cleanly into the arc), TENSION (good idea that fights another
principle — resolve before building), or DECISION (a product call made here).

### A. Arbiter JOIN must respect deterministic assignment — DECISION → v2.3.1
The "arbiter door" guard validates membership and pool provenance, but in
CREATED state the auto-assigned arbiter is only a *preview* — the slot is unseated
until a JOIN or the LOCK seats it. So a *legit* pool member who is NOT the
deterministically-assigned arbiter could front-run a JOIN and self-assign to a
trade they want to sway. Provenance is happy (they're in the pool); deterministic
assignment is quietly defeated. Fix: only `pickArbiterFromPool(pool, id,
[buyer,seller])` (= priority 0) may JOIN-seat the arbiter slot pre-lock; any other
pool member gets a loud `ARBITER_NOT_ASSIGNED` deny. Safe w.r.t. substitution and
healing — backups never JOIN; they step in via *vote* after the grace.

### B. Manual Chama switch is gated on ACTIVE COMMITMENT, not just balance — DECISION
Switching federation while a party to a LOCKED/disputed trade strands the user's
shares (they live on the trade's federation; claim hard-fails with FED_MISMATCH
until they switch back). The balance guard misses this because a locked locker's
balance is 0. Gate a manual switch on active-commitment (the same predicate that
drives the in-escrow pill / recovery suppression), not just withdrawable balance.
Idle → switch freely. "Between trades," enforced honestly.

### C. Rating-TIERED assignment + amount caps (the FIFA-ref principle) — ACCEPTED
Apply the Lending tier model to arbiter auto-assignment: tier arbiters by
accumulated rating, and gate high-value trades to higher-tier arbiters. A new or
low-rated arbiter accrues history on small-amount trades; high-value trades route
only to vetted, high-tier arbiters. "A FIFA referee vs a small-town soccer ref —
not the same risk to mess up." This is "graduated franchise" with teeth: priority
AND amount-ceiling both lean on non-gameable history. Bootstrap arbiters still
need blind trust for their first trades (no ratings yet), so the tier-0 ceiling is
deliberately low.

### D. "Tread lightly" surfacing for low/no-rating arbiters — ACCEPTED
The trader-facing complement to (C): when a trade's arbiter has no/low ratings,
surface it loudly at the lock moment — "this arbiter is still building a record;
consider keeping this trade under X sats" — and optionally enforce a soft max
trade amount as a default the trader can override. Protects the trader by default;
lets small arbiters earn their record on low stakes. Pairs with the public arbiter
dashboard.

### E. Graduated slashing — self-selected no-show is worse — ACCEPTED (nuanced)
If an arbiter publishes an availability signal (kind:38104) for a window and then
no-shows in that window, slash harder than a passive absence — they opted in and
broke it. Same for a backup who accepts then bails. BUT: keep a grace band for
genuine life events (a first miss is a warning, not a slash; patterns are what
get punished). The goal is seriousness without scaring off good people who
occasionally have a bad week. Slashing scales with pattern, not a single miss.

### F. Bond is a FIDELITY bond, not PoS — REFRAME (maintainer dislikes PoS)
> ⚠️ **SIZING SUPERSEDED 2026-06-14** — the bond is sized by *exposure* (self-selected stake → max trade ceiling), NOT "a term's earnings" (unmeasurable in dispute-free months, and it perversely rewards manufacturing disputes). The fidelity-not-PoS framing still stands. See the 2026-06-14 section.
Important framing the maintainer is right to insist on: this is a *performance/
fidelity bond* (like a contractor's surety bond or a court bond) — collateral
forfeitable on proven misconduct. It is NOT proof-of-stake: no block production,
no yield-from-staking, no consensus weight bought with capital. Sizing idea
(accepted): set the bond near what an arbiter can earn in a period, so a diligent
arbiter naturally earns it back before profiting — skin in the game without
locking out the un-wealthy permanently.

### G. Bond CUSTODY — held by top-rated chamacitos, not a vague "community escrow" — DECISION + TENSION
> ⚠️ **SUPERSEDED 2026-06-14** — senators → the **cabinet** (fed-owner + community-owner; k-of-n seeded at n=2, widening). And bonds are **commitment** bonds (self-held, publicly pledged), NOT cryptographic custody — there is nothing to "hold" or seize. See the 2026-06-14 section.
The maintainer rejects "community-controlled escrow" as under-defined ("who are
the VIP members?"). Preferred model: the bond is locked with the *highest-rated
chamacitos in that community* — elected officials with a reputation to lose, "like
senators / the house." This is elegant: custody is recursive-trust, anchored in
the same legible reputation everything else uses. TENSION to resolve before build:
top-rated holders could still collude; mitigate with the same provenance +
revocation transparency (their custody role is public and itself revocable), and
consider requiring k-of-n among them to move a bond so no single official can
slash unilaterally.

### H. Arbiter as community MODERATOR — ACCEPTED role, TENSION on pay
Proposed second duty: arbiters also keep the community safe — flag/mark (not
delete; deletion is too harsh and not ours to do on a Nostr-native protocol)
listings that look harmful, weekly. Good: it makes "arbiter" a real, ongoing
community-leadership role, which justifies real selection rigor. TENSION: the
maintainer floated "pay them 1% on each trade" for this. That fights the locked
principle **duty pays, not power** (BACKLOG: flat dispute fee, NOT a percentage of
every assignment) — a per-trade cut re-introduces exactly the volume/assignment-
grabbing incentive that motivates (A)'s front-running fix. Resolution to decide:
keep the dispute fee flat, and fund the moderation role separately — a fixed
community stipend (from a treasury / small listing fee), not a slice of every
trade. Same total comp is fine; the *shape* matters, because incentives follow the
shape.

### I. Arbiter application form + FAQ CTA — ACCEPTED (V3 surface)
A small CTA widget: "Become a community arbiter" → application form + FAQ. This is
the human on-ramp to consensus admission (§3). Low-effort, high-signal: it makes
the recruitment path visible instead of tribal knowledge. Wire after the signed
roster exists so applications resolve into a real admission flow.

### J. Signed kind:38104 roster is the keystone — CONFIRMED
The maintainer independently landed on this while reading §0's parenthetical: the
signed, replayable roster is what lets provenance become a *hard gate* safely.
Promote it from "later" to the FIRST build step (already #1 in Build order). It
unblocks the hard gate, tiered assignment lookups, and the admission flow.

---

## v3 sharpening (2026-06-07) — presence bond, fairness by reputation

Locked in DECISIONS.md (2026-06-07, "Arbiter v3: presence bond
(slash-to-cover), fairness by reputation"). This section is the design-home
version: it tightens §3–§5, resolves the §3.3 staking tension, and extends
the Invariants list. It does not change the build order — bonds stay last.

### Two invariants to add alongside Invariants 1–4

5. **Presence/fairness split.** The protocol verifies presence ONLY — "did the
   assigned arbiter's eligible vote land before `substitutionEligibleAt`?" is
   objective and replayable from the event chain. Fairness (was the ruling
   right?) is the arbiter's job, is subjective, and is governed by
   reputation/ratings + community revocation (§5) — never auto-slashed. The
   protocol does not adjudicate its own adjudicator.
6. **Slashing is post-hoc.** No trade ever waits on bond movement. The trade
   plane settles at backup speed (deterministic eligibility → backup votes →
   done); the bond plane settles at custodian speed (k-of-n, whenever). The
   presence proof is permanent, so deferred judgment loses nothing. Backup pay
   has two legs with two latencies: dispute fee rides trade settlement, the
   call-out bonus rides custodian signatures. Slow custodians delay only the
   bonus + treasury remainder — parties are already whole.

### Slash-to-cover (refines §3.3 bonded admission and §4 duty pay)

- **Standing bond, locked once** into k-of-n custody by the community's
  top-rated chamacitos (field-read G), reusing the holder-only/SSS construct.
  NOT re-posted per dispute: the per-dispute "earmark" is a **lien recorded in
  Nostr state, not a fund move** — zero live arbiter action at dispute time,
  which kills the stake-per-dispute idea (the arbiter is offline exactly
  then).
- **On a proven no-show:** dispute fee (1.5%) = work-pay → routes to the
  ACTING backup (parties owed it anyway; substitution costs them nothing).
  Forfeited bond = absence penalty → **capped** call-out bonus to the backup
  (full-bond-to-backup is a jackpot incentive to engineer no-shows);
  remainder → community treasury. On small trades the bonus, not the 1.5%,
  is what makes standby worth staffing. Never to the parties (they were made
  whole by the substitute; paying them re-creates the rejected parent-escrow
  design).
- **Challenge window before movement:** custodians publish intent-to-slash,
  wait 24–48h (free — see invariant 6). Custody is protocol-manual (SSS
  shares are inert; k human keys must act) but client-automatable: a
  custodian's client may verify the replayable proof and co-sign by opt-in
  policy. The tap is not the safety mechanism; the window and k independent
  relay views are.
- **Epistemic honesty about absence:** in an open relay world, absence is only
  "absent from my view" — a present vote can be eclipsed, and a true no-show
  can forge a backdated vote during the window (`created_at` is
  self-asserted). A single miss is never fully adjudicable. This is WHY
  graduated, pattern-based slashing (field-read E) is load-bearing: first
  miss → warning + ding (cheap if wrong); repeated "eclipses" go statistically
  implausible. The mechanism absorbs what the epistemics can't settle.

### Federation binding (rule, not hope)

Bond, primary, backups, and custodians all bind to the **community's
federation** — senators are that community's top-rated chamacitos, so they
hold its fed by construction. Cross-fed trades (regional routing) never move
the bond; they only consume presence. Two-rail payout on substitution:
dispute fee in trade-settlement terms, bonus in bond-fed ecash. The bond
inherits the community fed's guardian risk (long-lived ecash dies with its
mint); sizing (≈ one period's duty earnings, field-read F) bounds it, and
top-up cadence doubles as a fed liveness check. Top-up before new high-value
assignments; exit reclaims only with no open assignments (active-commitment
guard).

---

## v3 sharpening (2026-06-13) — tiered stake → exposure, and the federation-owner fast-track

Maintainer intent (captured verbatim): *"Anyone can be an arbiter — no degree,
no KYC. You prove yourself and show up if summoned, and soon pay your bond. Small
bond → small trades, medium → medium, big → golden — UNLESS you can prove you
control your own federation (DESIGN-arbiter-federation-proof.md, Level A), which
fast-tracks you to golden without the big bond. Safe whether or not any given
arbiter can prove it."*

Right shape, and on-mission. It composes three axes that already live in this
doc: the **bond** axis (§3.3, field-read F), the **rating-tier** axis
(field-read C), and the **identity** axis (the federation-proof doc). Honest
review, in the house tags:

### K. Stake UNLOCKS exposure; it never GATES entry — DECISION (the anti-"too harsh")
Entry stays free and permissionless. The bottom tier (small trades) needs **no
capital bond** — reputation + the 2-of-3 (an arbiter can't steal alone, only
*collude*) carry it while a newcomer earns ratings on small stakes (field-read
C/D). The bond *unlocks* larger exposure; it is never the turnstile. This is
load-bearing for the mission: a bond-to-enter would exclude exactly the
capital-poor, community-trusted arbiters in Benin/Kenya we exist to serve.
Non-capital roads to the top stay open: federation-ownership (below) and the
senator co-bond (field-read G).

### L. Keep proof-tier and exposure-tier names distinct — DECISION (naming)
Two orthogonal axes; do NOT reuse A/B/C for both or they collide:
- **Proof tier** (identity, federation-proof doc): C unverified < B
  guardian-verified < **A** federation-endorsed.
- **Exposure tier** (max trade size): **Bronze / Silver / Gold**.
Mapping: proof-**A** (an *established* fed) → **Gold** with no big bond. Trap to
avoid: proof-B ("guardian-verified") is NOT the Silver/"medium" tier.

### M. Federation-ownership replaces a bond's IDENTITY job, not its RECOURSE job — TENSION
A bond does two things: it makes identities costly (Sybil resistance) AND posts
slashable recourse capital. Federation *control* is a costly, persistent,
*named* stake → it fully covers the identity job. It posts **no** recourse
capital (you can't slash a federation), and a fed is cheap (~$10–30/mo,
research-confirmed) — less than a golden trade — so a fed-owner *could* rationally
defect once. So "fed-owner = super safe" is true against impersonation/Sybil,
**partial** against theft. Resolution: **(a)** the fast-track requires an
**ESTABLISHED** federation — guardian count ≥ threshold + age + activity +
on-chain footprint, all observable without trust — so a throwaway solo fed buys
nothing; **(b)** keep a *small fidelity* bond even at Gold (field-read F sizing
≈ one period's earnings — affordable, not collateral-to-trade) so there is always
something to slash; **(c)** Gold safety rests on ratings + established-fed
identity + the 2-of-3 collusion requirement, not on capital equal to the trade.
Honest claim to ship: *"as safe as a non-custodial, no-KYC system gets — an
attack needs collusion AND the burning of a costly, named, persistent identity,
and is partially slashable"* — excellent, but not literally "100% recourse."

### N. "Proves they paid federation fees" → prove CONTROL + MATURITY — DECISION
An off-chain G-Bot payment is not cryptographically verifiable, and a solo fed
pays ~nothing — so "paid fees" is neither checkable nor the right signal. The
verifiable proxy is federation **control** (Level A meta-endorsement) + the
**maturity** metrics in (M). Verify the artifact, not the receipt.

### Tension with field-read F (flag, don't bury)
"Big bond for golden" pulls toward the Bisq rule (bond ≥ max extractable value);
field-read F locked the opposite (bond ≈ one period's earnings,
fidelity-not-collateral, "don't lock out the un-wealthy"). Both can't hold if a
Gold bond must literally cover a golden trade. Resolution (M): keep the *capital*
bond fidelity-sized at every tier; what scales to reach Gold is the *requirement
set* (ratings + established-fed identity), payable in multiple currencies of
trust — capital being only one. Capital-rich-but-new reach Gold via a larger
(still bounded) bond; trusted-but-poor reach it via ratings + Level A. **Two
independent doors to Gold = the redundancy that keeps it safe whether or not a
given arbiter is a fed-owner** — the maintainer's "even if we can't prove it"
instinct, made precise.

### Locked decision (2026-06-13) — the bond is UNIVERSAL; no exception, no bypass
Supersedes the "federation-owner fast-track" exploration in (M): there is **no
bond bypass for anyone, including Level-A federation owners.** Rationale (the
maintainer's, and the honest one): arbitration is **a real job that demands
availability and honesty we cannot measure** — so everyone posts skin in the
game, period. The rules that survive:
- **Universal bond.** Every arbiter at every exposure tier stakes a bond, Gold
  included. The 2-of-3 already stops unilateral theft; the universal bond closes
  the *collusion / self-dealing* door (incl. the C7 cross-identity Sybil) by
  forcing even an accomplice arbiter to post slashable capital.
- **Self-selected tier by stake.** An arbiter picks their arbitration ceiling by
  how many sats they can stake. Bigger stake → bigger trades. No gatekeeper sets
  it; one's own capital does.
- **Time-boxed term, auto-return.** The bond is committed for a *period* the
  arbiter signs up for and is **returned automatically at term end** absent a
  proven slash (active-commitment guard: no open assignments). This is what makes
  it a *job/shift*, not a paywall.
- **Level A is identity, not exemption.** Federation control (Level A) still
  earns the anti-squat green badge and trust/ratings weight (more for an
  *established* fed — field-read M(a)), but buys **no** bond discount. Identity
  and skin-in-the-game are separate gates; Gold needs both.
- **Protocol, not product.** This flow is deliberately copyable — anyone can run
  it; it is not a "just use Chama" moat. That generality is a feature.

Honesty note (keep loud, don't overclaim): a universal bond makes self-dealing
*expensive and visible*, not cryptographically *impossible*. Because the bond is
fidelity-sized (≈ a term's earnings, field-read F), a single defection on a trade
larger than the bond can still net the attacker something — which is exactly why
Gold also requires real ratings (field-read C — dual-signed receipts, slow to
fake) and an established-fed identity. Bond + ratings + identity + 2-of-3
compose; no single one is the whole wall. Surface it **loudly**.

---

## v3 sharpening (2026-06-14) — the cabinet, commitment bonds, exposure sizing, tip-funded presence

Locked live with the maintainer + the second arbiter (Chapsmart). **This is now the
CURRENT bond / pay / rating model.** It supersedes field-read F's *sizing*,
field-read G *in full*, and the *custody + slash-as-fund-movement* parts of the
2026-06-07 section. What still stands: "duty pays, not power"; presence-proof is
objective/replayable; judgment is post-hoc; the epistemic-honesty-about-absence
reasoning. Build order is unchanged — bonds are still LAST (their OWN money-path release,
after the verifier + Ratings + cabinet-roster + exposure tiers); this locks the
*design*, nothing here is built yet. **Refined 2026-06-15:** §2 → n=3 trio; §3 →
**real SSS lock + strand-by-withholding slash** (the earlier "commitment/pledge"
framing and the time-released-share idea are corrected below).

Design north star (the maintainer's words): *"I want to lock my bond safely and
get it back. Everything else builds on that — or fails."* Plus: no DAO ("they
attract bad luck"), no new complicated tool, lenient on-ramp (many will want to
test the protocol), and the arbiter as **the most valuable AND most protected
role** in Chama — pioneers who promote justice, naturally.

### 1. Identity collapses to TWO tiers — DECISION
- **Anchor** — a Level-A (federation-endorsed, DESIGN-arbiter-federation-proof.md)
  arbiter who is also a cabinet member.
- **Bonded arbiter** — everyone else: posts a bond, arbitrates within their
  exposure cap.
- **Level B (guardian-verified) is retired** — you bond to the cabinet; you don't
  prove guardianship. **Level C (unverified)** isn't an arbiter, just a listing.
- Keep the SEPARATE axis: **exposure tiers** (Bronze/Silver/Gold) sized by bond
  (§3) — the ramp survives. (Federation-proof's A/B/C remains the *proof
  mechanism* for becoming an Anchor; the 2 tiers here are the *role*.)

### 2. The cabinet replaces the senators — now an n=3 trio — DECISION (refined 2026-06-15)
- Custody/standing authority = the **cabinet**: fed-owner + community-owner + a
  third trusted Level-A anchor. For BLF: the maintainer + Chapsmart + **Graysatoshi**.
- k-of-n custody, **n=3** (named, accountable, Level-A founders, mutually bonded —
  "each bonded against the others"), **designed to widen** further as more Level-A
  anchors join. The trio is the *seed*, not a ceiling.
- **Why n=3 over n=2** (it hardens §3's asymmetry): a member's bond RETURNS on any
  **1 of the other 2** healing (robust to one absent/griefing member), and STRANDS
  only if the **other 2 both** refuse (no unilateral slash; no single colluder can
  block a legit one). Three rating-graph roots (§6) instead of two; concrete mutual
  accountability.
- *Pushback on record (n=2):* a 2-person authority concentrates power and is a
  griefing point. n=3 + the challenge window + community-consensus backstop (§4)
  answer it; the residual is all-3 collusion (bounded by community-consensus +
  exposure caps + total reputational collapse). (Bisq's bonded-role + DAO
  confiscation is the same shape and has held.)
- To seat Graysatoshi: add his npub to BLF's `chama:arbiters` meta (a new 3-npub
  proposal) + he pledges a bond like the others.

### 3. Real SSS lock; slash = strand-by-withholding — DECISION, the keystone (refined 2026-06-15)
*Corrects the earlier "commitment/pledge, not seizable" framing — it IS a real lock.*
- **Real lock, reusing escrow.** The bond is ecash **SSS-locked with the cabinet**:
  the owner holds ONE share, the cabinet holds the rest. Mid-term it is genuinely
  locked — the owner cannot reconstruct alone. Not a pledge; real custody-by-split.
- **Return = the existing REFUND-only heal.** At term-end, **any one** cabinet
  member casts a REFUND-only heal → the bond returns to the owner (engine-computed
  recipient). Bonds are a distinct lock class **excluded from AUTO-refund** and
  routed to a *deliberate* cabinet heal — extending the **v2.9 suppression branch**
  (the locker-ghost-vs-standing-RELEASE guard), so it is another branch of existing
  logic, not new machinery.
- **Slash = strand-by-withholding.** To punish a cheat the cabinet simply
  **declines to heal** → the bond never reconstructs → **stranded forever.** This is
  the "burn", by *inaction*: it never violates the safety invariant (no third party
  *moves* the locker's funds — they just don't help; stranded sats benefit no one).
  Plus reputational delisting (independent of the bond).
- **The asymmetry IS the safety:** RETURN needs any **1** cabinet member (one honest
  member rescues an honest arbiter); STRAND needs **all** of them to refuse (a
  single dissenter protects an honest arbiter; a single colluder cannot strand a
  peer — though a 2-of-N *coalition* can; that residual is handled by the MAD clause
  in §4, not by the crypto). Slash hard-by-default, return easy-by-default — free
  from the SSS structure (and why n=3 matters, §2).
- **No time-lock needed** (corrects the earlier worry): the lock is the SSS split,
  not a time primitive; "term" is a coarse wall-clock window (the existing C11 clamp
  suffices; return-only-to-owner means clock-gaming is not a theft vector).
- **Declined:** *block height* (the browser can't read absolute height — only peg-in
  confirmation depth — and an external oracle is a needless dependency for a coarse
  term); *active burn/seize* (it would rebuild the exact "third-party-moves-your-funds"
  capability the escrow forbids, and let a compromised cabinet grief-destroy bonds —
  strand-by-withholding gets the destruction with none of that).
- **Retracted 2026-06-15:** the "time-released self-recovery share" — incompatible
  with strand-by-withholding (unilateral recovery would defeat the slash). Return is
  cabinet-dependent by design; honest-arbiter protection = trio redundancy +
  reputation + community backstop.
- **Self-sized by EXPOSURE:** pledged amount = the trade-size ceiling. **Bond =
  skin; pay = wage.**
- **Deterrence math:** a caught cheater is delisted (loses role R + reputation) and,
  if the cabinet agrees, **stranded** (loses bond B). With exposure caps **E < R**,
  cheating loses even before the strand; the strand is the visible teeth on top.

### 4. This is NOT a DAO — DECISION
- "Slashing" = the **roster updating (delisting) + the public record** — never a
  vote to seize funds.
- The **challenge window (24–48h)** is *due process for a delisting*, not a
  confiscation court.
- Slashing a **cabinet member's own** standing escalates to **community consensus**
  (the high-stakes primitive), never the other founder alone.
- **The pioneers' own seed bonds:** the **trio** pledges *simultaneously*, each
  member's bond SSS-held by the other two — return on any 1 of the other 2, strand
  only if both others refuse. No custodian "above" the root; it bottoms out in
  reputation + a publicly-visible **real-money stake** + the role itself (the
  maintainer's thesis: seeders must have real money to lose, provable independently
  — visible strength from miles away). Slashing a cabinet member escalates to
  community consensus.
- **Cabinet-betrayal deterrent — the MAD clause (option i, locked 2026-06-15).**
  Honest residual: the asymmetry stops a *single* griefer, but a **2-of-N coalition
  CAN strand an honest member's bond**, and the crypto does NOT make that
  self-destructive for the coalition. What deters it today — and why it suffices:
  (a) **zero-gain** — strand *destroys*, never *seizes*, so betraying an honest peer
  is pure spite at max cost, zero profit; (b) **reputational MAD** — refusing a
  *provably honest* peer's refund is public (the challenge window) →
  community-consensus delists the refusers → they lose the role + the chama they
  built (career suicide).
- **The upgrade we'll add IF wrongful-refusal griefing ever shows up (option ii,
  deferred):** strand a proven wrongful-refuser's **own** bond via the
  community-consensus path — turning reputational MAD into true bond-MAD that closes
  the 2-coalition hole. Not built now (YAGNI — reputational + zero-gain suffices, and
  it avoids standing up community-consensus-slash machinery until griefing actually
  appears). **Airtight now, door open to true MAD later.**

### 5. Pay = availability + work, funded by TIPS (not a treasury) — DECISION
- Dispute-only pay punishes arbiters whose chamas behave (a quiet month earns
  nothing). Split pay:
  - **Availability (presence)** — funded by an **optional per-trade tip**, NOT a
    treasury. No pool, no funding source, no DAO; self-funding, peer-to-peer ecash.
  - **Dispute fee (work)** — mandatory when a dispute happens; flat ("duty pays,
    not power").
- A dispute-free month is **paid readiness** (on-call doctor / firefighter), not
  unemployment — a quiet chama is a *success* and the arbiter still eats.
- **The tip does double duty: pay AND presence-reputation** — a *costly* "I value
  this arbiter being here," far more Sybil-resistant than a free thumb; weighted by
  tipper standing (medium, §6).
- *Honest tradeoff:* tips are voluntary → presence income is variable. A
  **stimulus, not a salary** — the role's value is standing + dispute fees + the
  cabinet path; don't promise a living from tips alone at small scale.

### 6. Rating arbiters — two streams, neither gates exposure — DECISION
- Rep is **no longer the ladder** (bonds self-size exposure), so arbiter rep is a
  soft **selection/trust** signal, not a Sybil gate.
- **Presence** — the **tip**, available on *every settled trade* (the arbiter is a
  seated participant on all of them, not just disputes). This solves the
  sparse-graph problem your friend flagged.
- **Performance** — 👍/👎 from the parties *after a dispute resolves* (kind:38123
  already supports the arbiter as ratee; the UI hook is #73).
- **Weight = medium** — lenient on newcomers (the bond does the hard Sybil work);
  the Level-A anchors are the graph roots that give "weight" meaning.

### 7. WHEN the tip is offered — DECISION
- **Primary: the completion screen (happy path)** — *"[arbiter] was your backstop
  the whole way — tip them? [small preset] · maybe next time."* Non-pushy.
- **Secondary: after a dispute resolves** — paired with the 👍/👎.
- **Never at lock/funding** — don't clutter the money-move.
- Buyer and seller can each tip independently (both were backstopped).

### Still open (small build-time details)
- The bond lock-class details: the owner+cabinet **share policy** (owner = 1 share,
  cabinet = the rest) and the auto-refund-exclusion wiring (extend the v2.9
  suppression branch). (Proof-of-holding is moot under the real-lock model — it is
  genuinely locked, not self-held.)
- Whether the future top-tier cryptographic custody is ever worth building
  (default: no).
- Stipend via a community treasury is **dropped** — tips replace it.

---

## v3 sharpening (2026-06-16) — exposure cap, multi-community, cabinet lifecycle, the two paths

Locked live with the maintainer; continues the 2026-06-14/15 model. Nothing here
changes the bond mechanism — it **bounds and operationalizes** it. Build order
unchanged; bonds last.

### 8. The AGGREGATE exposure cap — the keystone, two-sided — DECISION
The self-selected bond caps exposure on **two** axes, both enforced HARD:
1. **Per-trade** — any single trade an arbiter oversees < their bond.
2. **Aggregate** — the **sum of ALL their open bonded trades, across EVERY chama,
   combined** < their bond.
Live capacity = `bond − Σ(open bonded trades)`; the system **refuses any new
assignment** that would push the sum over the bond. This turns "a cheating arbiter
can't profit / can't go far" into a *number*, not a hope: it bounds the **maximum
any arbiter (or colluding cabinet) can ever burn or wash** to the posted bond — no
silently stacking 8 trades worth 1M against a 200k bond and wiping them in one go.
This cap — NOT fed-owner virtue (a fed is cheap, field-read M(a)) — is the
structural backstop the "even if the cabinet are friends, it's safe" conclusion
rests on.

### 9. Arbiters MAY span multiple communities — DECISION (reverses the earlier one-community lean)
Earlier instinct was one-arbiter-one-community. **Reversed:** with strong cabinet
anchors + the aggregate cap (§8) protecting participants, an arbiter can officially
serve **multiple communities** (they're rated everywhere anyway). UX: soft-surface
"this arbiter is from a different chama," and give **local arbiters preference** in
assignment. The aggregate cap is what makes spanning safe — total exposure is
bounded no matter how many chamas.

### 10. Cabinet lifecycle — replacing a member is a term-boundary roster swap — DECISION
Replacing a **good-standing** cabinet member rides the natural term cycle (at
term-end all bonds heal back anyway): (1) the departing member's bond heals back;
(2) update the roster/meta — drop their npub, add the replacement's — via the same
threshold write that seated the trio; (3) the replacement posts their own bond;
(4) the next term re-locks the cabinet as the new three. **No funds at risk**
(bonds returned before re-locking), **no re-founding** — a roster swap + the
newcomer's bonding. Only an **emergency** mid-term replacement (lost key / rogue
member) needs an off-cycle heal + re-lock.

### 11. Cabinet members are PUBLIC, established identities — DECISION (Genesis-specific)
Every cabinet member must present a **public, established Nostr profile** — NOT a
net-new key. It's a costly identity signal AND it's what makes whole-Chama
reputation legible: the cabinet + every arbiter in the chama + their ratings go
**Live on the globe**, so anyone can read a chama's trustworthiness at a glance
before trading. Public-by-construction is itself a deterrent.

### 12. Two onboarding paths for a cabinet — DECISION
- **Hardcore** — bring your own 3 founders + a **federation you control**
  (Level-A verifiable); sovereign from day one. The PR-to-verify should be easy
  even though running a fed isn't "normie-easy."
- **Bootstrap** — anchor to **BLF's** Genesis cabinet (custody by BLF) until you
  grow your own 3, then run the **bonding ceremony** (simultaneous 3-way lock, §3);
  the chama flips to **Live** on the globe the moment the locks finalize.
This is why "path B" (net-new-federation onboarding via a first-time Genesis
cabinet) is load-bearing, not a side-quest.

### 13. Loud heal-prompt — UX invariant — DECISION
Healing an honest peer's bond is the **single action that protects a peer** (return
needs any one cabinet member). So it must be the **loudest prompt a cabinet member
ever gets** — impossible to miss, surfaced to every member the instant a peer's
bond is due. (Pairs with §4's reputational MAD: a member who ignores a loud,
provable heal request is visibly *choosing* to.)

### 14. Big-scale fake-cabinet attack — named, backstopped — THREAT MODEL
The residual worth naming: an attacker stands up **fake chamas with self-controlled
3-npub cabinets across many countries** to look legitimate and prey on traders.
Defanged by: **public-reputation-at-a-glance** (a fresh fake chama has no history,
§11) + the **aggregate cap** (bounds per-chama damage, §8) + can't-steal
(burn-not-seize). The coordinated case the per-chama mechanisms miss is exactly
what the **community-gated (ii)** escape hatch (§4) exists for — locked as an *idea*
now, built only if it appears. "Guns on the wall."

