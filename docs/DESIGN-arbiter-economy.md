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
