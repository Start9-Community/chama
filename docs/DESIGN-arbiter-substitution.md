# Design — Arbiter Substitution (pool arbiter steps in for an absent assigned arbiter)

Status: DESIGN LOCKED (maintainer sign-off 2026-06-04): grace = min(4h, half
remaining life); pool cap = 3 (assigned + 2 backups); v1 scope = vote only
(chat/fee display follow later). Money-path: this extends the holder-only share
model (docs/DESIGN-holder-only-shares.md) and the vote acceptance rules. Same
discipline as holder-only: staged build → full matrix → on-device verify →
ship in one release.

Maintainer note on the short grace: safe because the priority rule (below)
already guarantees the assigned arbiter's eligible vote supersedes any backup's
pre-settlement — the window only reduces redundant backup effort, it is not a
correctness boundary.

## The problem (today, v2.0.0)

Holder-only made the **assigned arbiter the sole holder of the arbiter Shamir
share** (index 2). In a dispute (buyer and seller disagree), the winner
reconstructs from their own LOCK share + the arbiter's agreeing vote-carried
share — so if the assigned arbiter never shows up, the dispute **cannot** be
resolved on merit. The only escape is the expiry auto-refund, which always pays
the locker regardless of who was right. Backup arbiters exist in
`state.communityArbiters` but are powerless: they hold no share, and
`handleVote` rejects them (`NOT_PARTICIPANT`).

## The design

### 1. Deterministic arbiter priority order (the race-killer)

`pickArbiterFromPool(pool, escrowId, exclude)` is already deterministic. Define
the **priority order** for an escrow by iterating it:

```
priority[0] = pickArbiterFromPool(pool, id, [buyer, seller])           // assigned
priority[1] = pickArbiterFromPool(pool, id, [buyer, seller, p0])       // backup 1
priority[2] = pickArbiterFromPool(pool, id, [buyer, seller, p0, p1])   // backup 2
...
```

Every client derives the identical order from data already in the state — no
coordinator, no new events. **Race rule:** the arbiter vote slot belongs to the
eligible arbiter-vote in the chain whose pubkey has the LOWEST priority index.
Replay converges no matter what order votes arrive in; a backup's vote is
superseded on replay if the assigned arbiter's (or a higher-priority backup's)
eligible vote exists. Once a RESOLVE + CLAIM have landed, first-accepted-wins
(unchanged from the holder-only doc): late votes cannot flip a settled trade.

### 2. LOCK — arbiter share encrypted to the pool

In `lockAndPublish`, share index 2's `encryptedFor` gains one NIP-44 ciphertext
per pool member, capped at the first `ARBITER_POOL_SHARE_CAP = 3` of the
priority order — the assigned arbiter + 2 backups (maintainer-locked; bounds
event size and key-spread, covers the BLF official pool exactly). Buyer/seller shares stay
strictly holder-only — **each non-arbiter participant still holds exactly one
share**, and a pool arbiter alone still holds only ONE of the three slots, so
no single party can reconstruct. The cryptographic 2-of-3 is unchanged.

Marker: keep `sharePolicy: "holder-only-v1"` and add an additive
`LockPayload.arbiterPoolShare: true`. (Why not "holder-only-v2": a v2.0 client
branches `sharePolicy === "holder-only-v1"` and would dump an unknown policy
into the LEGACY claim path and fail confusingly. With the additive marker, a
v2.0 client handles the lock fine — own-share claim works, assigned-arbiter
envelopes work — it merely ignores substitution.)

### 3. Eligibility — who may vote as arbiter, and when

A pubkey P may cast the arbiter vote iff ALL of:
- the lock carries `arbiterPoolShare: true` (substitution never applies to
  older locks — backups hold no share there, the vote would be useless);
- P is in the escrow's priority order (assigned or backup);
- buyer and seller have both voted and disagree (existing `ARBITER_TOO_EARLY`
  / `ARBITER_NOT_NEEDED` gates, unchanged);
- **grace window**: for the assigned arbiter (priority 0), immediately. For a
  backup, only when `created_at ≥ substitutionEligibleAt`, where

  ```
  disputeStartAt        = created_at of the LATER of the two disagreeing votes
  substitutionEligibleAt = disputeStartAt
                         + min(GRACE_MAX, floor((expiresAt − disputeStartAt) / 2))
  GRACE_MAX             = 4h   (maintainer-locked)
  ```

  The assigned arbiter gets up to 4h of exclusivity (or half the trade's
  remaining life on short trades, so backups always get a real window before
  the expiry refund). Both inputs are chain data, so every client computes the
  same boundary. A too-early backup vote is rejected with a new reason
  `SUBSTITUTE_TOO_EARLY`; a non-pool voter stays `NOT_PARTICIPANT`.

### 4. Seating — acting arbiter, not re-assignment

`participants[Role.ARBITER]` stays the assigned arbiter (it is part of the
LOCK's committed data). The reducer derives `state.actingArbiter` = pubkey of
the vote currently holding the arbiter slot per the priority rule. The vote is
recorded in `votes[Role.ARBITER]` exactly as today, so `checkVoteThreshold`,
RESOLVE, and `payoutRecipientFor` are untouched. v1 scope: a backup can VOTE
(and carry the share). Chat access / fee routing for the acting arbiter are
display-level follow-ups, not protocol.

### 5. Vote-carried share + claim — almost free

The backup decrypts their copy of share 2 from the pooled LOCK (locker =
sender), re-encrypts to `payoutRecipientFor(state, outcome)` (voter = sender),
and attaches the standard `VoteShareEnvelope` (`shareIndex: 2`). Existing
validation already pins shareIndex to the voter's seated role and the
recipient to the engine-computed winner — it must accept the *acting* arbiter
as the ARBITER-role sender (one check to loosen, nothing else). The winner's
claim scan is unchanged: own LOCK share + a distinct agreeing vote-share, which
the backup's envelope satisfies.

## Healing substitution (added 2026-06-05 — the disputed-expiry limbo fix)

Field incident: a 1-1 disputed trade expired with the assigned arbiter absent.
The expiry-heal rescue vote (`maybeAutoRefundExpired`) skips every participant
who already voted — which in a live dispute is everyone EXCEPT the assigned
arbiter. The rescue therefore had the same single point of failure as the
dispute itself, and the funder self-rescue ("refinement #3") was never actually
implemented (no retained notes, no reissue fallback). Funds strand until the
assigned arbiter's device comes online.

Fix, shipped with this design: on pooled-share locks (`arbiterPoolShare`), ANY
pool backup may cast the healing vote on an EXPIRED, unresolved trade —
**REFUND only** (`INVALID_HEAL_OUTCOME` otherwise), **no grace floor** (the
assigned arbiter had the trade's entire life), slot still derived by priority
so concurrent heals converge. Backup CLIENTS auto-heal on load exactly like
the assigned arbiter's would, so "sats will be returned automatically" is now
backed by three devices instead of one. Legacy non-pooled locks keep
participants-only healing (backups hold no share there — a vote would be
powerless anyway).

## Versioning / rollout (honest)

Soft lockstep, much gentler than v2.0.0's:
- New locks remain claimable by v2.0 clients in every NON-substituted flow
  (the additive marker changes nothing they read).
- A v2.0 client never accepts a backup's VOTE (`NOT_PARTICIPANT`), so if a
  substitution actually happens: v2.0 *observers* just show a stale "waiting on
  arbiter" view, and a v2.0 *winner* cannot use the backup-carried share — for
  them the trade behaves exactly like today's absent-arbiter case (expiry
  refund) until they update. No funds at risk; substitution benefits simply
  require the winner to be on the new build. Release notes say so plainly.

## Determinism invariants (test-pinned)

1. Any permutation of the same event set replays to the same state.
2. Assigned arbiter's eligible vote ALWAYS wins the slot over any backup's,
   regardless of arrival order — until a RESOLVE+CLAIM has settled the trade.
3. `substitutionEligibleAt` is a pure function of chain data.
4. A backup vote on a lock without `arbiterPoolShare` is invalid everywhere.
5. Buyer/seller share exposure is IDENTICAL to holder-only-v1 (pooling touches
   only share index 2).

## Implementation status (CODE-COMPLETE — on-device matrix pending)

All four stages landed (2130 tests green): the pure engine (priority order,
dispute clock, grace boundary, derived arbiter slot with permutation-convergence
tests), the pooled LOCK build + wire marker + parser shape check, the vote/
envelope/claim plumbing (the backup's envelope flows through the existing
holder-only code untouched), canVote/decideVotePrompt mirrors, the Me NEEDS
queue for backups (floor countdown → "step in as backup"), and the TradeDetail
"backup arbiter stepped in" caption. PENDING: the on-device matrix — dispute
with the assigned arbiter offline → backup steps in after the floor → winner
reconstructs from own share + the backup's vote-carried share.

## Staged implementation (atomic ship)

1. **Pure engine**: priority-order helper (`arbiterPriorityOrder(state)`),
   `disputeStartAt` / `substitutionEligibleAt` derivation, handleVote
   acceptance + slot-priority replay rule + `SUBSTITUTE_TOO_EARLY` /
   `NOT_POOL_ARBITER` reasons, `state.actingArbiter`. Heavy permutation tests.
2. **LOCK build**: pooled share-2 encryption behind `arbiterPoolShare: true`;
   parser shape-validation; holder-shares validation accepts the acting
   arbiter.
3. **Vote + claim plumbing**: backup's `buildVoteShareEnvelope` reads their
   pooled LOCK copy; claim path untouched but matrix-tested with a
   backup-carried share.
4. **UI**: NEEDS surfaces eligible disputes to backups after the window with a
   "Step in as arbiter" affordance + countdown ("assigned arbiter has until
   T"); trinity ring shows the acting arbiter; substitution copy.
5. **Gates + on-device**: full matrix; live test = dispute with the assigned
   arbiter offline → backup steps in after the window → winner claims.

## Test matrix (green before ship)

- Permutation convergence: {buyer, seller, assigned, backup1, backup2} votes in
  every arrival order → identical final state.
- Grace boundary: backup vote 1s before `substitutionEligibleAt` rejected, 1s
  after accepted; assigned arbiter immediate.
- Priority: backup1 vote then assigned vote (pre-resolve) → assigned wins slot;
  post-RESOLVE+CLAIM → first accepted stands.
- Pool cap: only the first 3 priority pubkeys hold share-2 copies, and the
  ELIGIBLE set is capped to the same 3 — share-holding and vote-eligibility
  never diverge.
- Legacy lock (no marker): every backup vote rejected; assigned-only behavior
  byte-identical to v2.0.0.
- Envelope: backup's shareIndex-2 envelope validates; misrouted/mismatched
  rejected (existing INVALID_SHARE_ENVELOPE paths).
- E2E: holder-only pooled lock → dispute → backup resolves → winner
  reconstructs from own share + backup's envelope.

## Resolved maintainer decisions (2026-06-04)

1. **Grace formula** — `min(4h, half the remaining life)`. Maintainer proposed
   4h; the adaptive floor keeps backups viable on short trades. Safe because
   the priority rule, not the window, protects correctness.
2. **Pool cap** — 3 (assigned + 2 backups), matching the BLF official pool.
3. **v1 scope** — vote only. Chat access and fee display for an acting backup
   are follow-ups, not protocol.
