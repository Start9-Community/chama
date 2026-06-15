# Chama — Consensus & Security Invariants

A single registry mapping each invariant to the code that enforces it, the test that pins it, and its status. The point: when you add a feature, check it against this list instead of re-deriving the model — and the next auditor (or future-you, in six months) sees in one glance what's actually protected versus what's design-only.

Seeded from the 2026-06 consensus threat audit (findings **C1–C17**) plus the arbiter-economy invariants. **This is a living doc** — update the row whenever you touch the enforcement, and keep the status honest.

## Status legend
- ✅ **enforced** — wired in code + (ideally) pinned by a test
- ⚠️ **partial** — enforced on one path, or with a known gap
- 📐 **design-only** — specified in docs, not yet in code
- 🔓 **accepted-risk** — known limitation, documented, mitigated elsewhere

## Convention (make it greppable)
- Tag each enforcement point in code: `// INVARIANT(arbiter-assignment)` next to the reducer check.
- Name the test to match: `invariant_arbiter-assignment__lock_rejects_non_assigned`.
- Then "is X still enforced?" is a `grep`, not an archaeology dig.
- When a change alters **which events the reducer accepts**, it's a **coordinated release** (v2.9 precedent) — flag it here + cross-version it.

## Money path — the sacred core
| Invariant | Enforced at | Status | Audit |
|---|---|---|---|
| **2-of-3 never weakened** — release/refund needs exactly 2 of {buyer, seller, arbiter} | `state-machine.ts` (vote tally → RESOLVE) | ✅ | — |
| **holder-only shares** — LOCK seals one SSS share per recipient; the app layer can't reconstruct | `escrow-client.ts` LOCK envelope · `encryption-config.ts` | ✅ | — |
| **roles signer-derived** — VOTE/CLAIM role comes from the event signer, never a self-attested field | `state-machine.ts` handleVote / handleClaim | ✅ | — |
| **vote immutability** — a cast vote can't be flipped; one vote per pubkey | `state-machine.ts` (double-vote block) | ✅ | — |
| **healing is REFUND-only** — a heal can never RELEASE-flip | `state-machine.ts` `INVALID_HEAL_OUTCOME` | ✅ | — |
| **expiry performance-contest (v2.9)** — a silent locker can't auto-refund once the non-locker voted RELEASE | `state-machine.ts` (v2.9 logic) | ✅ | — |
| **arbiter ∈ pool** — LOCK/JOIN arbiter must be in `communityArbiters` | handleJoin `~491` · handleLock `~636` | ✅ | — |
| **arbiter deterministic assignment** — only the deterministically-selected arbiter may seat | handleJoin `~506` ✅ · **handleLock: consent-enforced (v3.5)** — the reducer stays membership-only BY DESIGN (any LOCK-side assignment reject strands genuine old chains on replay; the "consent posture" tests pin this). `pool.ts` `classifyArbiterAssignment` accepts ANY historical basis — `pool[0]` (pre-v0.6.5 fallback) · no-exclusion pick (v0.6.5+) · `[buyer,seller]`-excluded pick (v0.7.2+) — and TradeDetail shows a loud OFF-ASSIGNMENT banner + a two-tap acknowledge on the performer's release vote · tests `invariant_arbiter-assignment__*` | ✅ | **C1** (v3.5 — consent layer, not consensus; residuals: pre-v3.5 clients show no warning · a colluder sitting on an old basis (e.g. `pool[0]`) passes — pool trust itself is membership + C7 · the two-tap covers the standard vote surface; subscription `PERIOD_RELEASE` and buyer-locked raw-escrow get the banner only) |
| **arbiter fee bounds** — `0 ≤ fee ≤ amount`, integer | **sanitize at `handleCreate`** (clamp to `[0, amount]`, floor to int) · parser type + `isFinite` · NO `handleLock` reject (rejecting post-spend strands the locker) · tests `invariant_arbiter-fee-bounds__*` | ✅ | **C2** (v3.3 — sanitize, not reject) |
| **NIP-44 only** — sensitive events encrypted; no NIP-04 downgrade | `encryption-config.ts` | ✅ | — |
| **event-id idempotency** — replaying the same event is a no-op | `escrow-client.ts` / `state-machine.ts` | ✅ | — |
| **same-federation** — both sides on the same fed | self-reported `fed` tag (skipped if absent) | 🔓 | **C16** (fail-open) |

## Assignment & determinism
| Invariant | Enforced at | Status | Audit |
|---|---|---|---|
| **assignment seed ungrindable** — the selection seed isn't creator-preimageable | `pool.ts` `pickArbiterFromPool ~228` (`sum(charCode) mod len`) | ⚠️ | **C6** (grindable — **deliberately deferred at v3.5**: a new seed is a FOURTH assignment era, diluting C1's accept-any-historical-basis check, and its exploit needs a colluder already in the pool, which C7 closes; do it later as its own clean cutover) |
| **dispute clock bounded** — anchor `created_at` clamped to `≤ expiresAt+4h` (CEILING only) | `arbiter-substitution.ts` `clampDisputeAnchor` — **ceiling only; floor dropped** (it rejected valid arbiter votes on honest clock skew) · tests `invariant_dispute-clock__*` | ✅ | **C11** (v3.3 — ceiling only; priority rule is the correctness boundary) |

## Trust anchors — the economic layer (CLOSE BEFORE ENABLING fees / bonds / tiered assignment)
| Invariant | Enforced at | Status | Audit |
|---|---|---|---|
| **verified roster is a hard gate** for fee/high-value trades | `pool.ts` `classifySelfRoster` — the green badge is REFUSED when recognition depends on a roster signed by a party to the trade (creator/buyer/seller; a steward-arbiter is NOT a stake conflict) · `requiresVerifiedRosterConsent` — fee-bearing / high-value (≥ `HIGH_VALUE_CONSENT_MSATS`) arms a two-tap consent gate unless a distinct-authority roster of ≥3 backs the pool (consent, never a disable — a false positive must not strand the performer's recourse) · small pools stay awareness-only; the 2-member default pool is never gated on ordinary trades · tests `invariant_roster__*` + fee-gate suite | ⚠️ | **C7** (v3.5 — SAME-key self-rostering closed; gate wired ahead of the economic layer, dormant while fees are off. **Residual: a cross-identity Sybil** — key#1 creates the shell + signs the roster, accomplice key#2 trades — still badges green; closing it needs an authority outside the attacker's keyspace (registry steward pin / federation-owner credential). A permissionless shell's roster certifies "the shell's creator vouches", no more) |
| **economic deterrents** — fees/bonds/slashing make collusion irrational | none (fees cosmetic; no payout fans out) | 📐 | **C8** (social-only today) |
| **rating canonical basis** — reputation aggregates identically across clients | `ratings.ts:140` `verifyRatingForTrade` (view-dependent) | 🔓 | **C9** (canonicalize before #73 reads it) |

## Relay & replay
| Invariant | Enforced at | Status | Audit |
|---|---|---|---|
| **replay = function of the event SET, not arrival order** | `replayEventChain` (skips order-dependent errors) | ⚠️ | **C10** |
| **multi-relay confirmation** for VOTE/RESOLVE/CLAIM | single-relay first-ACK publish | 🔓 | **C10** |
| **RESOLVE bound to its tallied vote ids** | not bound (race) | ⚠️ | **C10** |

## Fund safety — "no sats stranded"
| Invariant | Enforced at | Status | Audit |
|---|---|---|---|
| **mint-op mutual exclusion** — all mint ops incl. the boot drain under one lock | `mint-mutex.ts` `withMintLock` (Web Locks keyed on OPFS filename → cross-tab; in-process FIFO fallback) wrapping `FedimintClient.spendNotes` / `redeemEcash` / `redeemWithRetry` / `createEscrowLock` · tests `invariant_mint-mutex__*` (fallback path; cross-tab two-tab race needs the device pass) | ✅ | **C12** (v3.4.0) |
| **already-spent verified** — "already spent" confirmed as THIS wallet credited | `fedimint-client.ts` `confirmAlreadySpentCredit` (balance-delta poll under the mint mutex); unconfirmed ⇒ `ALREADY_SPENT_UNCONFIRMED` → `markUnresolvedCredit` + C13 surface — never silent success, never silent loss · test `invariant_already-spent__requires_confirmed_credit` · honest caveat: an unrelated LN receive of ≥ the claim amount inside the ≤10s confirm window can false-confirm (LN ops aren't under the mint lock; accepted as rare, do not widen the window) | ✅ | **C5** (v3.4.0) |
| **stranded notes surfaced** — post-claim redeem failure alarms + escape hatch | `pending-redemptions.ts` `listStrandedRedemptions` → MeScreen alarm card → `EcashExportModal` preset mode (QR + copy + two-tap clear) · test `invariant_stranded-notes__surfaced_and_exportable` (card/modal rendering needs the device pass) | ✅ | **C13** (v3.4.0) |
| **no wipe on unknown balance** — unknown = refuse, ask | `orphan-wipe-policy.ts` `decideOrphanWipe` (wipe requires positive zero or provably-clientless; unknown ⇒ `ORPHAN_BALANCE_UNKNOWN` refusal, or park a legacy file untouched) wired in `sdk-adapter.ts` · test `invariant_no-wipe__unknown_balance_refuses` | ✅ | **C14** (v3.4.0) |
| **claim tries all envelopes** (client half) | `holder-shares.ts` `collectClaimEnvelopeCandidates` + bridge try-all loop (per-candidate decrypt/reconstruct failures fall through to the next envelope) · test `invariant_claim__tries_all_envelopes` | ✅ | **C15** (v3.4.0 — client half) |
| **claim deadline re-heal** — APPROVED re-opens to refund-heal after a claim deadline | reducer untouched (changes vote/state acceptance ⇒ coordinated consensus release) | 📐 | **C15** (deferred half) |

## Build / environment
| Invariant | Enforced at | Status | Audit |
|---|---|---|---|
| **no sim/mock in prod** — sim wallet tree-shaken from prod | `?sim=1` / `?testnet=1` flips + persists | ⚠️ | **C3** |
| **native bridge URL loopback-only** | accepts `?nativeFedimintUrl=` / localStorage in browser | ⚠️ | **C4** |
| **unknown invites get a guardian interstitial** | `startsWith("fed1")` prefix check only | 🔓 | **C17** |

---
**Maintenance.** The ✅ rows were confirmed by the audit's scanners + spot-checks; line refs marked `~` are approximate — confirm them and pin a test as you touch each. This table, rendered, is also the public threat-model page for the dev site: publishing "here's what we enforce, here's what's design-only, here's the clawback we're honest about" is a credibility signal, not a liability.
