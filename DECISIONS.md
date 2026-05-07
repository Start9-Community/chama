# Chama Decisions

Architectural decisions that changed the product's shape. Each entry
captures the date, the context (what prompted the decision), the
options considered, the choice, and the rationale.

This file is append-only. Decisions can be superseded by later entries
but never edited away. When a decision is superseded, the new entry
links back to the one it replaces.

The goal: six months from now, when something feels weird and you
wonder "why did we do it this way," you can find the answer here.

---

## 0. Format

```
## YYYY-MM-DD — Short title

**Context:** What prompted the decision. What was the trigger event,
the smoke-test catch, the design conversation, the operational
reality?

**Options considered:**
- (a) Description, with tradeoff
- (b) Description, with tradeoff
- (c) Description, with tradeoff

**Decision:** Picked option (X).

**Rationale:** Why this choice over the others. What the decision
optimizes for. What it gives up.

**Implications:** Downstream consequences. What changes elsewhere
because of this. What the next decision this unlocks (or blocks).

**Status:** Active / Superseded by [link]
```

---

## 2026-04-26 — Coordinator, not wallet (Pillar 2.1, Option B chosen)

**Context:** v0.1.71's "33 sats missing" event surfaced a
fundamental architectural question: where do user funds live between
trades? Initial assumption was Chama held a Fedimint wallet that
custodied bearer ecash. v0.1.75 investigation confirmed Fedimint
ecash is bearer cash that lives only in client OPFS — federations
do not custody unspent notes. Reading Fedi's
`bridge/fedi-wasm/storage.rs` confirmed the upstream story is "go
native via FFI"; web durability is structurally limited.

**Options considered:**
- (a) **Wallet model** — Chama as a Fedimint wallet client. Users
      preload sats, hold balances, trade from those balances. Simple
      mental model but exposes users to OPFS durability risk every
      moment they're not actively trading.
- (b) **Coordinator model** — Chama as a trade-coordinator. Lightning
      is the universal interface; ecash exists only as cryptographic
      substrate during the LOCK→CLAIM window. BOLT11 in at fund time,
      BOLT11 out at claim time. OPFS drains between trades. No
      persistent balance UI.
- (c) **Hybrid** — Wallet for power users, coordinator for normies,
      toggle in settings. Worst of both worlds; no clean mental model.

**Decision:** Option (b), Coordinator model.

**Rationale:** "No sats stranded, ever" is the deepest ethical
commitment Chama can make. OPFS bearer-cash durability is genuinely
limited (browser quotas, profile resets, cross-device, browser-bound
key material). The wallet model leaks this fragility into every
moment of user experience. The coordinator model contains it to the
brief window where the trade structurally needs it. Lightning as
universal interface also makes Chama interoperable with every other
Bitcoin tool a user already has.

**Implications:**
- Trade lifecycle becomes: BOLT11 IN at fund time → ecash in escrow
  during LOCK→CLAIM only → BOLT11 OUT at claim time → OPFS drains.
- "Wallet" mental model is dead in user-facing language. UI calls it
  "Chama," and balance is "Active funds in escrow."
- Recovery banner exists for failure modes (interrupted trades,
  half-finished claims), not steady state.
- Federation switching becomes mechanically trivial when balance is
  zero — tear down WASM client, init on new fed, OPFS rotates. No
  Lightning round-trip, no fees, no balance to preserve.
- One-trade-at-a-time becomes design choice, not technical limit.

**Status:** Active. Operationalization in progress — v0.1.85 +
v0.2.0 captured the language and architecture; v0.3.0 "Atomic
Lifecycle" removes the FundWalletModal preload surface that still
contradicts the doctrine.

---

## 2026-05-01 — Communities, not federations (PHILOSOPHY.md §2.3)

**Context:** Federation as a primitive is invisible to most users —
the cryptographic vocabulary doesn't map to anything in their lives.
But every Bitcoin app forces users to learn it. Chama could either
inherit that complexity or hide it. Building toward Adopting Bitcoin
Nairobi made the question urgent: a Senegalese rice trader does not
need to learn what a Fedimint guardian set is.

**Options considered:**
- (a) **Federation-primary** — User picks a federation by name from
      a list (BLF, BP, etc.). Educational copy explains what they are.
      Power-user-friendly but high cognitive load.
- (b) **Community-primary, federation-derived** — User picks a
      community (currency + country/region + language). Federation
      derived automatically from the community. Federation appears
      only in Settings → Advanced as plumbing.
- (c) **No picker** — Auto-assign based on locale. Removes choice
      entirely. Sovereignty-incompatible.

**Decision:** Option (b).

**Rationale:** The community is what the user actually identifies
with — "I'm Senegalese, I trade in CFA, my neighbors speak Wolof and
French." The federation is plumbing that backs that identity. Forcing
users to learn the plumbing was a failure of product design, not a
limit of the protocol. Communities map directly to real-world
identity; federations don't.

**Implications:**
- Schema gains `community: <slug>` and `fulfillment` tags on listings.
- `resolveFederationForCommunity(slug)` becomes the canonical resolver.
- BLF (and later BP) backs all communities by default; communities
  with no native federation route to the universal fallback.
- "Federation" appears nowhere on user-facing surfaces except
  Settings → Advanced. Code identifiers stay.
- Federation-follows-listing (v0.2.0) becomes natural: the
  community-on-listing tag tells the buyer's wallet which federation
  to switch to.

**Status:** Active. Shipped v0.1.78. Federation→Chama UI sweep
completed v0.1.87. Federation-follows-listing protocol+UI shipped
v0.2.0.

---

## 2026-05-04 — Federation follows the listing (PHILOSOPHY.md §2.3)

**Context:** Cross-federation trade attempts produced stranded
ecash — a mint on fed A cannot be redeemed on fed B. The naive fix
was "warn the user." The right fix was structural: make
cross-federation locks impossible to attempt at the protocol level.

**Options considered:**
- (a) **Warning-based** — Show a warning when buyer/seller/arbiter
      are on different feds, let them proceed. Users will ignore
      warnings; stranded ecash will follow.
- (b) **Block + manual switch** — Detect mismatch, block lock, prompt
      user to manually switch federations. Adds friction. Users may
      not understand why.
- (c) **Federation-follows-listing** — Tap a listing, Chama silently
      switches your client to the listing's federation. Per Pillar
      2.1 (wallets are zero between trades), the switch is mechanically
      trivial and invisible. The user sees one consistent flow; the
      protocol enforces correctness.

**Decision:** Option (c).

**Rationale:** Pillar 2.1 makes (c) cheap. The user's wallet is
already zero between trades, so a "switch" is just "tear down WASM
client, rotate OPFS file, init new client." No Lightning round-trip,
no fees, no balance to preserve. The cost of (c) at runtime is
near-zero; the cost of (a) is occasional permanent fund loss.

**Implications:**
- Listings always carry community + mintUrl tags (probe failures
  cannot strip them — locked v0.1.87).
- Browse renders cross-community listings with amber-tinted "peek"
  styling — visible but visually distinguished. Two-section layout
  in v0.2.0.
- State A (matching federation) and State B (post-switch, was
  non-matching) become canonical detail-screen framings.
- Re-init happens on listing-tap, not Fund-tap. Detail screen always
  opens on the right fed; Fund button never has to deal with
  switching mid-flow.
- Power-user federation tribalism is a v2 concern. v1 prioritizes
  structural correctness.

**Status:** Active. Shipped v0.2.0.

---

## 2026-05-05 — Three-tab navigation (Browse / Create / Me)

**Context:** v0.1.x shipped with a Browse / My Trades / Me layout.
"My Trades" implied the active trade was a tab — but Pillar 2.1's
"one trade at a time" doctrine means an active trade is a *state of
being a Chama user*, not one tab among others.

**Options considered:**
- (a) **Browse / My Trades / Me** (status quo).
- (b) **Browse / Create / Me** with active trade interception —
      every tab tap during active trade routes to the trade screen,
      or a persistent "go to active trade" pill surfaces on non-trade
      screens.
- (c) **Single-screen mode during active trade** — full takeover,
      no tabs visible. Too aggressive; users may legitimately want
      to peek at Browse while waiting on a counterparty.

**Decision:** Option (b).

**Rationale:** Create is the seller's primary surface; surfacing it
as a tab makes the marketplace bidirectional. The active trade as a
state-of-being (rather than a tab) matches the lived experience of
a single high-stakes transaction in flight. The pill is the gentle
nudge; the gate fires only on commitment-creating actions (Fund,
Create publish), not on navigation.

**Implications:**
- "My Trades" content moves to Me → Trade history.
- Active-trade pill renders on Browse, Me, Sandbox, and Create,
  below the FedimintBar.
- Create publish button is gated when active commitment exists.
- The pill also explains *why* Create is blocked — without it, the
  block message is mystifying.

**Status:** Active. Shipped v0.1.85.

---

## 2026-05-05 — Patcher workflow with Code Claude

**Context:** Long-running solo project, building features that touch
many files at once. Attempts at "let CC commit and push" experiments
revealed the workflow worked best when CC stages a diff and a commit
message but never actually commits/pushes/tags itself.

**Options considered:**
- (a) **Full autonomy** — CC commits, pushes, tags, deploys. Fastest
      iteration; highest blast radius from a bad change.
- (b) **Stage + propose** — CC writes patchers, runs typecheck +
      tests, drafts commit messages to `/tmp/`, hands back to Jetty
      who runs `release.sh`. Typecheck + tests pre-deploy gate is
      always honored.
- (c) **Manual everything** — Jetty writes all code, CC suggests
      diffs as text. Slow; defeats the purpose.

**Decision:** Option (b).

**Rationale:** Two layers of review (CC self-checks via typecheck
and tests; Jetty visually reviews the diff before deploy) catches
both classes of bug — the type-level ones the human eye misses and
the design-level ones the typechecker can't see. The 3-profile
smoke test on Firefox + Chrome runs after every deploy as a third
layer.

**Implications:**
- `release.sh` is the only thing that touches version, commits, and
  pushes.
- CC instructions explicitly forbid `npm version` and direct
  `package.json` version edits.
- All CC work products land in `/tmp/` for review.
- Memory file `~/.claude/projects/-Users-Jetty-chama/memory/workflow_no_version_bumps.md`
  enforces the version-bump rule across CC chats.

**Status:** Active.

---

## 2026-05-06 — BACKLOG.md and DECISIONS.md as living documents

**Context:** The project crossed ~50 open items spread across
multiple version targets, plus inline TODOs and "filed for later"
notes scattered through commits and chats. Memory + project knowledge
alone became insufficient to track what was deliberate, what was
deferred, and what was forgotten.

**Options considered:**
- (a) **Continue ad-hoc** — rely on commit messages and memory to
      track outstanding items. Will keep working until it doesn't.
- (b) **GitHub Issues** — convert each item to an Issue when it
      becomes the next thing being worked on. Searchable, linkable,
      assignable. Heavier ceremony per item.
- (c) **In-repo `BACKLOG.md` + `DECISIONS.md`** — one file each at
      repo root. Backlog tracks open items by version target;
      Decisions logs architectural choices append-only. Searchable
      via git, version-controlled, no tooling.

**Decision:** Option (c) now, with Option (b) as natural augmentation
once items become external/contributor-facing.

**Rationale:** Solo project at this stage. The friction of GitHub
Issues per item is too high for the small wins. BACKLOG.md as a
single file with version-section organization is the lowest
ceremony / highest value structure. DECISIONS.md captures the "why
did we do it this way" moments that keep coming up. Together they
externalize what was previously trapped in conversation history.

**Implications:**
- Every release commit message ends with a reference to
  BACKLOG.md items addressed.
- Architectural decisions (the QR-IN/QR-OUT atomic-lifecycle
  realization, role-color-on-arbiter-buttons, etc.) get a
  DECISIONS.md entry as they happen.
- Items move out of BACKLOG.md only via commit messages —
  same diff that ships the fix removes the line.
- Future GitHub Issues integration: convert in-flight items to
  Issues when external contributors (alexlwn123, future Fedimint
  upstream collaborators) need visibility.

**Status:** Active.

---

## 2026-05-06 — Atomic Lifecycle as v0.3.0 (FundWalletModal removal)

**Context:** v0.2.0 shipped federation-follows-listing — a major
convergence release for community/federation identity. During smoke
review, Jetty noticed that FundWalletModal still presents an
arbitrary "fund your wallet" surface. This contradicts Pillar 2.1's
"BOLT11 IN at fund time → ecash only during LOCK→CLAIM → BOLT11 OUT
at claim time" doctrine. The doctrine had been written into
PHILOSOPHY.md as Pillar 2.1 but never operationalized in the UI.

**Options considered:**
- (a) **Bundle into v0.2.0** — pull FundWalletModal removal into
      the v0.2.0 PR. Adds significant scope to an already-large
      release; risks destabilizing federation-follows-listing.
- (b) **v0.3.0 dedicated release** — let v0.2.0 ship as planned,
      then immediately follow with a focused v0.3.0 that
      operationalizes Option B. Clean slicing; each release ships
      one big idea cleanly.
- (c) **Defer indefinitely** — keep FundWalletModal in main paths;
      treat the contradiction as acceptable until v1.5+. Pillar 2.1
      becomes aspirational rather than operational.

**Decision:** Option (b).

**Rationale:** Federation-follows-listing is a real, valuable
improvement on its own — v0.2.0 is the right shape and worth
shipping cleanly. Atomic Lifecycle is the next axis of work,
sequential not competing. Bundling them risks both. Deferring
indefinitely is the worst path because every additional feature
built on FundWalletModal as a primary surface entrenches the
contradiction.

**Implications:**
- v0.2.0 ships with FundWalletModal still in primary paths
  (recovery banner, destroy modal withdraw path, etc.). Documented
  as a known gap in the v0.2.0 commit message.
- v0.3.0 work: listing-tap → exact-amount BOLT11 invoice; claim →
  BOLT11-OUT at claim time; FundWalletModal moves to Sandbox-only;
  recovery banner copy shifts to failure-mode-only language;
  EcashProvider interface designed for future Cashu support.
- v0.3.0 is partly removal work (taking FundWalletModal off main
  paths) and partly architectural (the listing-tap → exact-invoice
  flow). This is "doctrinally pure" rather than feature-additive.

**Status:** Active. v0.2.0 shipping; v0.3.0 brief drafting next.

---
