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
Important framing the maintainer is right to insist on: this is a *performance/
fidelity bond* (like a contractor's surety bond or a court bond) — collateral
forfeitable on proven misconduct. It is NOT proof-of-stake: no block production,
no yield-from-staking, no consensus weight bought with capital. Sizing idea
(accepted): set the bond near what an arbiter can earn in a period, so a diligent
arbiter naturally earns it back before profiting — skin in the game without
locking out the un-wealthy permanently.

### G. Bond CUSTODY — held by top-rated chamacitos, not a vague "community escrow" — DECISION + TENSION
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

