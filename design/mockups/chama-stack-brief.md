# Chama — "Stack": non-custodial group savings — design brief

**Status:** design brief (2026-07-05). No code yet. Captures the Stack idea in the shape a
Chapsmart-friend conversation pushed it toward — one Jetty hadn't imagined but found "fairly
onboarding for newbies." Written down now so it isn't lost; build sequencing TBD (after the
liveness / auth-first work settles).

## The one-liner (the friend's framing)

> "An app with individual wallets but a public dashboard visible only to us."

A savings circle where **every member keeps their own wallet** (self-custody — their keys, their
sats) and the group shares a **dashboard visible only to the group** (contribution progress, in the
open, to each other — not the world). No pooled pot, no treasurer.

## ⭐ Why this shape is *right* (not just cute)

It's more on-ethos than it first looks — it's the correct structure for a Bitcoin savings group:

- **No pooled treasury ⇒ no treasurer-rug.** The failure mode that quietly kills real-world
  chamas / ROSCAs / saccos is the person holding the pot walking off with it. Self-custody removes
  that failure mode *by construction* — funds never leave each member's own wallet, so there is
  nothing for anyone to abscond with.
- **The group-only dashboard IS the accountability engine.** The entire psychological force of a
  savings circle is "the others can see whether I showed up this week." Stack keeps that social
  pressure while taking on *zero* custody risk. That's the trade almost no savings app gets right —
  they either pool (and inherit rug risk) or go fully private (and lose the accountability).
- **Newbie-friendly.** No "hand your money to the group treasurer" leap of faith. You keep your own
  sats, you just make your *commitment* visible. Lower trust barrier to join = better onboarding.

## ⭐ Kinship with the commitment bond (the deep point)

Stack is the **friendly, low-stakes cousin of the arbiter commitment bond**. Both are the same
primitive: *self-custodied capital, made visible on purpose.*

| | Commitment bond | Stack |
|---|---|---|
| Whose sats | arbiter's own | member's own |
| Custody | self (CLTV timelock to own key) | self (own wallet) |
| Visibility | public, chain-verifiable (kind 38135) | group-only, encrypted |
| Stakes | high (arbiter reputation) | low (savings discipline, social) |
| Proof | on-chain funded UTXO | honor-system v1 → optional proof later |

The reuse: the same "publish a verifiable commitment" muscle already built for bonds applies here.
It also means Stack strengthens the whole thesis — Chama is a place where *commitments are visible
without being custodial*.

## Two decisions that make or break it

1. **What the dashboard shows — progress, NOT raw balances.**
   Show contribution progress / streaks / goal-%: *"Amina hit her weekly target 6 weeks running."*
   That's the motivating signal. A member's actual sat balance is nobody's business — showing it is
   both a privacy leak and *less* motivating than streak/goal framing. Lean hard toward
   progress-against-a-goal, away from balance disclosure.

2. **What "visible to only us" means technically — NIP-44 group-encrypted events.**
   Each member posts their contribution/progress as a Nostr event **encrypted to the group's
   members** (NIP-44; a small, known member set). Other members' clients decrypt and roll up the
   dashboard; the world (and relays) see ciphertext. Real crypto work, but tractable — and it's the
   same publish-a-verifiable-thing pattern as bonds, just encrypted + un-chained.

## ⭐ The honesty caveat (v1) → proof-binding (later)

Because funds are self-custodied, **v1 is honor-system**: a member *could* claim a deposit they
didn't actually make. For a savings circle among people who know each other (the ROSCA reality),
that's fine — social trust carries it, and there's no pot to steal so the blast radius of a lie is
just "you lied to your friends about saving."

**Later (optional):** bind a contribution to a *proof* — an ecash-note or on-chain commitment, i.e.
a mini-bond — so a claimed deposit is cryptographically real, not self-reported. Only worth it if a
group wants trustless verification; don't gate v1 on it.

## Open questions / decisions before build

- **Group formation & membership** — how a Stack is created, how members are invited, how the member
  set (needed for NIP-44 encryption targets) is agreed + updated when someone joins/leaves.
- **The goal model** — per-member goals? one shared group goal? a recurring cadence (weekly/monthly)?
  Streaks vs. cumulative-toward-target. This shapes what the dashboard renders.
- **Contribution "event"** — what a member actually taps to record a contribution (and, in v1, whether
  it's purely self-declared or references a real wallet action they just took).
- **Payout / rotation** — is Stack a pure savings tracker (everyone stacks toward their own goal), or
  does it also model a ROSCA *rotation* (the pot goes to a different member each cycle)? Pure-savings
  is the simpler, safer v1; rotation reintroduces "who holds it this month" questions. Recommend
  pure-savings first.
- **Naming** — "Stack" is the working name (fits Bitcoin "stack sats" culture). Earlier naming riffs:
  Work / Chip In / Stack. Confirm before it hits UI copy.

## Sequencing

After the liveness signal + auth-first onboarding land. Stack is a *new surface*, not a fix, so it
rides behind the launch-shaping work — but it's a strong newbie-onboarding and retention feature
(a reason to open the app weekly), so it shouldn't sink deep into the backlog either. Draft a
concrete v1 scope (pure-savings tracker, per-member goal, NIP-44 group dashboard, honor-system) when
it's picked up.
