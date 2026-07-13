# Chama — the "Live chama" signal (onboarding, post-bond) — design brief

**Status:** design brief (2026-07-03). No code yet. Captures the shift now that the single-key
commitment bond exists: **no country is special anymore** — any chama becomes "Live" the moment it
has bonded arbiters, so liveness must be *computed from the ground up*, not hardcoded (goodbye
Kenya-is-green). Jetty's Q3.

## The shift the bond forces

The old onboarding split (⚡ Live now / ✓ Available now / coming soon) was a **hardcoded**
"Kenya has elected local arbiters" artifact. The commitment bond democratizes arbiter-hood — anyone
can lock their own sats and *be* a bonded arbiter — so the "Live" tier is no longer a place we
bless; it's a **state a community earns**. Every country starts equal; each chama is encouraged to
stand up its own arbiters immediately.

## ⭐ The liveness score (Jetty's three signals, combined)

A chama's liveness is a computed score, not a binary flag:

    liveness ≈ (# bonded arbiters) × (their combined ratings) × (total bond commitment: size × duration)

Each factor earns its place:
- **# of bonded arbiters** — coverage + redundancy; rewards a community that recruits, not one that
  leans on a single hero. (And it shows *unity* to traders.)
- **Combined ratings** — proven, on-chain-adjacent trust; arbiters who actually showed up and were
  rated well for the 1% disputes.
- **Bond commitment (how much × how long)** — the §2.11 doctrine applied to a whole chama: a
  community whose arbiters bond large and long is telling the truth in the only language that can't
  be faked. Long, well-funded bonds pull the score up hard.

This is also the **"grade entire chamas"** idea Jetty floated — a chama leaderboard falls right out
of the score, and it's a marketing surface ("look how alive this community is").

## Representation in onboarding

- **Drop the binary orange/green.** Show a **graduated** signal — a small strength meter, or a plain
  honest readout: *"3 arbiters · 4.8★ · 60-day bonds."* Magnitude, not a badge.
- **A "?" explainer toggle** (Jetty: "why is Kenya orange but US green?"): a small popover —
  *"What makes a chama Live? Bonded arbiters who show up, get rated, and commit for the long haul.
  Be one."* Educates AND plants the incentive in the same breath.

## ⭐ Never surface a single default OG arbiter (Jetty — the sharp one)

Showing "arbiter: {OG}" tells a newcomer *"covered, don't bother applying."* That kills the flywheel.
Instead:
- Show the **count** of arbiters, never a single default name-as-the-answer.
- A **"this chama needs arbiters — become one, and rank up"** CTA, especially where coverage is thin.
- Frame arbiter scarcity as **opportunity, not sufficiency.**

The flywheel this creates: more applicants → higher liveness score → more trader trust → more trades →
more fees → more applicants. The onboarding's job is to *start* that loop, not to short-circuit it by
implying the job's taken.

## What this needs to be built (why it's not a 5-min change)

- A **liveness aggregation**: per-chama, roll up bonded-arbiter count + their rating summaries + total
  bond size×duration (reads the commitment bonds + the ratings the app already tracks).
- The bond data is **local-per-arbiter today** (each arbiter's commitment bond is their own on-chain
  UTXO + a local record). For a *community* liveness score, arbiters' bonds need to be **discoverable**
  — likely a small Nostr announcement ("I've bonded X until block T for community C", verifiable
  against the on-chain UTXO), so other clients can compute the score without trusting a claim.
- An **onboarding redesign** of the country/chama picker to render the graduated signal + the "?"
  explainer + the "become an arbiter" CTA.

## Open questions / decisions before build

- **The bond-announcement kind** (how an arbiter advertises their commitment bond so a chama's
  liveness is computable + verifiable against the chain). Pairs naturally with the private-community-
  fed work.
- **Score weighting** — how much each factor counts; guard against gaming (e.g. many tiny short bonds).
- **"Live" threshold** — is a chama "Live" at ≥1 bonded arbiter, or a minimum score? (Lean: ≥1, but
  the *strength* is graduated.)
- Sybil resistance on ratings + arbiter identities (ties to the existing arbiter-trust model, §2.7).

## Future — v1 vs v2 arbiter differentiation + participants redesign (Jetty, 2026-07-05)

Once Tier 2 exists (the open-stranger-ceremony bond with real slashing teeth,
`chama-bond-collusion-closure-brief.md`), an arbiter who went through the **extended v2 process** is
a strictly stronger commitment than a **v1 timelock-commitment** arbiter. Mark that difference
*visibly* — e.g. a **gold star** next to a v2 arbiter's name/id — so traders can tell "committed
capital" (v1) from "committed capital that can actually be slashed" (v2) at a glance. Ties into the
liveness score (a v2 bond should weigh more).

And now that the bond gives us a real reason to show arbiter identity, **redesign the participants /
arbiter section** to use the real estate: full name/id, the star (v1/v2), and their rating — instead
of a bare pubkey. This is where the "become an arbiter, rank up" incentive gets its surface.

## Sequencing

After the commitment bond settles (real-sats walk-through done) and alongside the arbiter-bond
announcement kind. This is a launch-shaping feature — it's how "everyone is Live now" actually reads
to a new user — so it should land before/with the global push, not deep in the backlog.
