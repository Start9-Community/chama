# Chama — 2B: prefer-bonded arbiter assignment (+ BONDS_ENFORCED) — design/plan

**Status:** design + plan (2026-07-08). Awaiting Jetty's scope confirm before touching the reducer.
Consensus-critical money-path change → confirm-first, then implement + adversarial pass, uncommitted.

## Why this isn't a client-side reorder (the trap)
The seated arbiter is **reducer-ENFORCED** at JOIN: `state-machine.ts:527` computes
`assignedArbiter = pickArbiterFromPool(state.communityArbiters, state.id, [buyer, seller])` and rejects any
other pre-lock arbiter JOIN with `ARBITER_NOT_ASSIGNED`. `pickArbiterFromPool` (`pool.ts:401`) is a pure,
replay-identical hash-round-robin. If we change *how it picks* (to prefer bonded), old clients and new clients
compute **different** assigned arbiters for the same trade → a bonded arbiter's JOIN is accepted by new clients
and **rejected** by old ones → the chain diverges on the money path. `pool.ts:431-437` documents exactly why the
reducer must never recompute-and-reject across versions.

## The design — CREATE is the single consensus anchor
Everything hangs off data the creator stamps into the CREATE event, because that's the one payload every client
replays byte-identically (the reducer is pure and cannot fetch bonds).

1. **Stamp `bondedArbiters ⊆ communityArbiters` into the CREATE payload.** The creator already fetches funded+active
   bonds at publish (`CreateForm.handlePublish`, wired for the pool in v5); it now also stamps the resolved bonded
   subset. New optional field on `CreatePayload` + `EscrowState` (mirrors how `communityArbiters` flows). Absent on
   every historical CREATE ⇒ old trades are untouched.
2. **New deterministic pick that prefers the stamped bonded subset:** `pickPreferredArbiter(pool, bonded, id, exclude)`
   — pick from `bonded ∩ pool` (minus exclusions) if non-empty, else fall back to `pickArbiterFromPool(pool, …)`.
   Pure, replay-identical given the STAMPED bonded set (not a live fetch).
3. **Widen the JOIN gate to accept BOTH bases — never reject a valid arbiter** (`state-machine.ts:527`). The gate
   accepts `event.pubkey` if it equals EITHER the bonded-preferred pick OR the legacy `pickArbiterFromPool` pick.
   ⇒ a new client seats + all clients accept the bonded arbiter (they have the stamped bonded set); an old client's
   legacy pick is still accepted too. **Neither old nor new JOIN is ever rejected → no strand, no fork.** "Prefer"
   becomes: the seating client CHOOSES bonded; every client ACCEPTS it. (Same accept-any-of-N doctrine C1 already uses.)
4. **C1 `classifyArbiterAssignment` (`pool.ts:478`): add the bonded-preferred pick as a 4th accepted basis** so a
   bonded-seated arbiter reads `as-assigned`, not `off-assignment`. Keyed on the stamped bonded set.
5. **Cosmetic previews prefer bonded too** (`TradeDetail.tsx:417`, `TradeCard.tsx:168`, lock builder
   `escrow-bridge.ts:200`) — same `pickPreferredArbiter`, so the previewed/seated/settled arbiter agree.

## Capacity enforcement (`BONDS_ENFORCED`, `exposure.ts:50`) — belongs at the CREATE stamp
Flipping `BONDS_ENFORCED` makes `getTrustedArbiterPool` skip over-capacity arbiters via `assignablePool`. If that
filtering happens at reducer/pick time it changes the POOL per-client → same divergence class. Safe placement: the
creator applies capacity filtering **when it builds `communityArbiters` for the CREATE stamp** (it already has the
bonds + open-trade data). All clients then replay the same stamped pool. `assignablePool` keeps its never-empty OG
fallback so a trade never freezes on capacity drift.

## Rollout safety
- CREATE-anchored ⇒ every client replays the same assignment inputs.
- Gate accepts-both ⇒ never rejects a valid arbiter ⇒ **cannot strand locked funds or fork a chain.**
- Historical trades carry no `bondedArbiters` stamp ⇒ byte-identical to today (legacy pick only).
- ~No users + clean v5 version bump ⇒ no meaningful mixed-client window; but the design is safe even if there were.

## Adversarial matrix (the pass Jetty wants)
1. **Mixed-client replay:** old-client + new-client apply the same v5 chain (bonded seated) → both `ok`, same state,
   no `ARBITER_NOT_ASSIGNED`. And an old-style (legacy-pick) JOIN on a v5 trade → still accepted.
2. **Bonded front-run:** a bonded pool member who is NOT the id-selected one tries to JOIN-seat → still rejected
   (gate accepts only the two *computed* picks, not any bonded member).
3. **Empty/decayed bonded set:** stamped `bondedArbiters=[]` or all excluded (buyer/seller) → falls back to legacy
   pick exactly; OG fallback seats; never empty.
4. **bonded == buyer or seller:** exclusion still applies (can't self-arbiter).
5. **Substitution + healing** (`arbiter-substitution.ts:94`, VOTE-path backups) unchanged — they already use
   `pickArbiterFromPool` over the pool; confirm a bonded-preferred seat doesn't break the backup ordering / grace.
6. **Capacity (if flipped):** trade above every bonded arbiter's bond → OG-only pool seated; Σ open bonded ≤ bond
   enforced at stamp; never-empty fallback holds.
7. **C1 provenance:** bonded-seated arbiter reads green (`as-assigned`) to the counterparty; a hand-seated
   non-pick still reads `off-assignment`.
8. Full suite + typecheck green; new block for the pick + gate + C1 bases.

## Open decisions (Jetty)
- **Scope of this pass:** prefer-bonded ordering ONLY now (smaller consensus surface, verify on device), then flip
  `BONDS_ENFORCED` capacity as a second gated pass — OR both in one pass. (Recommend staged: prefer-bonded first.)
- **Bonded preference rule:** bonded-that-fits first with OG fallback (recommended) vs strict bonded-only.
- Confirm the accept-both gate widening (the safe core) — this is the one reducer change.

## BUILT 2026-07-08 (STAGED: prefer-bonded only; BONDS_ENFORCED stays false) — uncommitted, typecheck clean, +20 asserts green
Jetty chose STAGED. Prefer-bonded seating is wired end-to-end; capacity enforcement (the BONDS_ENFORCED flip) is deferred to a second pass.
- **Consensus anchor:** `CreatePayload.bondedArbiters` + `EscrowState.bondedArbiters` (types.ts, optional, read `?? []`). CreateForm stamps the funded bonded subset (∩ the final pool) at publish; it round-trips via the wholesale `JSON.stringify`/`JSON.parse` CREATE content + the `...params` spread through App.handleCreate → useEscrow.createEscrow → escrow-client.createEscrow. Reducer sets it on CREATE; cloneState copies it. **Verified end-to-end** (round-trip asserted in tests).
- **`pickPreferredArbiter(pool, bonded, id, exclude)`** (pool.ts): picks from bonded∩pool minus exclusions, else the legacy `pickArbiterFromPool`. Pure + replay-identical on the STAMPED set.
- **JOIN gate widened** (state-machine.ts:~527): accepts EITHER the bonded-preferred OR the legacy pick — never rejects a valid arbiter. Empty/absent bonded ⇒ the two picks coincide ⇒ byte-identical to the pre-2B single-pick gate. Front-run still blocked (only the two *computed* picks pass, not any bonded member).
- **C1** (`classifyArbiterAssignment`): bonded-preferred added as a 4th accepted basis (a bonded-seated arbiter reads `as-assigned`; a hand-seated non-pick still reads `off-assignment`).
- **Seat + previews prefer bonded:** TradeDetail/TradeCard previews + the lock-builder fallback pick.
- ⚠ **ONE line lives in CC's `escrow-bridge.ts`** (the lock-builder arbiter pick, ~line 200 → `pickPreferredArbiter`) — orthogonal to #37's spend/publish/stash, but FLAG it for the git split so CC's uncommitted #37 and this reconcile cleanly.
- **Adversarial pass — tests.ts block 31d-3b, +20 asserts, all green:** pickPreferredArbiter units (bonded / empty / undefined / not-in-pool / excluded-fallback); accept-both; **DETERMINISTIC divergent case** (bonded ≠ legacy ⇒ BOTH JOINs accepted ⇒ old+new client, no chain fork); front-run blocked; backward-compat (pre-2B trade byte-identical); C1 as-assigned / off-assignment. Typecheck clean. (Full suite = Jetty's predeploy; CC baseline 2963 + these.)
- ⏳ **Jetty device-verifies (3-instance):** a bonded arbiter is preferred as the seat on a new trade in their community; a trade whose bonded arbiter is excluded/absent/over-cap still seats an OG (never strands); the counterparty reads the bonded seat GREEN (as-assigned).
- **Next — 2B part 2 (deferred):** flip `BONDS_ENFORCED` — capacity-filter `communityArbiters` at the CREATE stamp (the creator has bonds + open-trade data), keeping `assignablePool`'s never-empty OG fallback. Separate gated pass + its own adversarial leg.
