# Chama — bond → arbiter enrollment (the connective tissue) — design brief

**Status:** design brief (2026-07-05). No code yet (beyond the pure S1 primitive). Surfaced by
Jetty's device pass: he bonded two npubs and saw **no arbiter dashboard** and suspected they'd
"never see a trade." Correct — and this brief is the missing spine.

## The gap (the "aha")

Posting a bond publishes the chain-verifiable **kind-38135** liveness announcement. That makes the
chama read as *live* — but it does **not** enroll the npub as an **arbiter**. Arbiter assignment runs
off a *different* mechanism (the signed roster + device-trusted cabinet), which never reads 38135. So
a bonded npub:

- is **never in the assignable pool** → never seated on a trade,
- gets **no arbiter dashboard** (or an empty one),
- shows liveness to the world but can't actually *do the job* they bonded for.

**Bonding ≠ being an arbiter.** This brief connects the two: a chain-verified bond should make you an
assignable, dashboard-having arbiter for that community.

## Current architecture (what assignment actually uses)

```
apply (38121) → steward signs roster (38120) → getTrustedArbiterPool(community)
     └─ sources: rosterArbiters (verified 38120) + deviceTrusted (BLF cabinet + local/env)
CREATE: creator's client stuffs communityArbiters[] into the trade payload (from the pool)
LOCK:   pickArbiterFromPool(pool, escrowId) auto-seats one
dashboard / fees / provenance: gate on POOL MEMBERSHIP (isCabinetMember, recognized-in-pool)
capacity (exposure.ts, DORMANT): assignablePool() filters over-capacity — reads kind 38130 (OLD)
```

Two truths fall out: (1) nothing in this path reads the 38135 commitment bond; (2) the capacity seam
reads the **legacy 38130** declaration, not the real 38135 bond — a model mismatch to bridge.

## The design — bonded arbiters as a THIRD, chain-verified pool source

Add **bonded arbiters** as a pool source alongside the signed roster:

- **Permissionless by construction.** The bond *is* the trust — locked, chain-verified skin in the
  game. It needs no steward sign-off; that's the whole democratize-arbiter-hood point (PHILOSOPHY
  §2.11). Chain-verifiability makes it a legitimate **distinct-authority** trust source — arguably
  *stronger* than a steward roster (a steward vouch can be Sybil'd; a funded CLTV bond cannot).
- **Union, not replacement.** Assignable pool = elected roster (38120) ∪ bonded (38135) ∪ cabinet.
  The elected path stays; bonding is a second on-ramp.
- **Recognized in provenance.** Because any client can verify a 38135 bond on-chain, a bonded arbiter
  is a *shared* trust baseline — honest clients badge them green (not "unrecognized sock-puppet").

## Integration points (precise)

1. **`pool.ts` — a `bondedPool` source.** Bonded data is async (38135 relay read + esplora verify),
   but `getTrustedArbiterPool` is sync. So INJECT it (mirror `PoolCapacityContext`): a new
   `bondedPool?: readonly string[]` option, merged into `getTrustedArbiterPoolSources`. The caller
   resolves it from `fetchCommunityBonds`.
2. **CREATE flow — inject bonded arbiters into `communityArbiters`.** The creating client fetches the
   community's bonded set and includes it in the trade payload. This is where bonded npubs become
   *assignable* (the behavioral core).
3. **Provenance (`classifyArbiterProvenance`) — recognize bonded.** Feed the bonded set into the
   trusted reference so a trade seating a bonded arbiter reads green. (New "bond-verified" recognition
   tier, distinct from device-trusted and roster-vouched, for the #73 tier badges.)
4. **Dashboard gate — show arbiter surfaces for a bonded npub.** Today the arbiter dashboard gates on
   cabinet/pool membership. Extend: a user with a verified bond for their community sees the arbiter
   dashboard (Disputes / watched trades). ⚠ Until S3 lands they'd be assignable-nowhere, so the
   dashboard would be empty — sequence S3 (assignment) with/before S2 (dashboard) so it isn't a hollow
   surface.
5. **Capacity bridge (Phase 2B) — read 38135, not 38130.** `exposure.ts` (`getArbiterBond`,
   `PoolCapacityContext.bondEvents`) reads the legacy 38130 declaration. Point it at the 38135
   commitment bond (chain-verified `actualSats` as the cap) so capacity gates on the REAL bond when
   `BONDS_ENFORCED` flips. Prefer bonded arbiters (real stake) over unbonded rostered ones.

## ⭐ Governance decisions (need Jetty's call before S3)

1. **Permissionless enrollment** — a chain-verified bond ⇒ assignable arbiter, no steward sign-off.
   *(Recommend YES — it's the point.)*
2. **Auto-enroll vs opt-in** — is the 38135 announcement itself the "I'm available to arbiter" signal,
   or is there a separate per-bond "go active" toggle? *(Recommend: announcement = opt-in; add a
   later "pause assignments" toggle if an arbiter wants to stay bonded but stop being seated.)*
3. **One union pool** — elected + bonded arbiters share one assignable pool. *(Recommend YES.)*
4. **Assignment preference** — once capacity is live, prefer bonded (skin-in-game) over unbonded
   rostered arbiters for higher-value trades. *(Later, rides with 2B.)*

## Staged plan (money path — stage carefully, never-empty pool safety throughout)

- **S1 — pure primitive (SAFE, do now):** `bondedArbitersForCommunity(verifiedBonds)` → distinct
  funded+active npubs. No wiring. Tests. *(Building block; governance-neutral.)*
- **S2 — dashboard gate:** show the arbiter dashboard + recognize bonded in provenance. Visible win
  (Jetty's two npubs finally see the surface). Sequence with S3 so it isn't empty.
- **S3 — CREATE injection (behavioral core):** creating client fetches bonded arbiters → included in
  `communityArbiters` → bonded npubs get seated. This is the real "they can arbiter now."
- **S4 — capacity on 38135 (Phase 2B):** bridge `exposure.ts` to the commitment bond; gate + prefer
  by real bond size; flip `BONDS_ENFORCED`.

## Ties

Rides with **Phase 2A** (`chama-arbiter-bond-phase2-brief.md`) and the **real Dashboard** (the home
the bonded arbiter lands on). S4 is literally Phase 2B. The v1/v2 gold-star differentiation
(`chama-live-chama-signal-brief.md`) sits on top once Tier 2 exists.
