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

**Status:** Active. v0.2.0 shipped; v0.3.0 brief drafting next.

---

## 2026-05-07 — LNURL-first claim hierarchy (Pillar 2.7 operationalized)

**Context:** v0.3.0 brief discussion surfaced the question of how
users actually provide a destination at claim time. Initial framing
was "they paste a BOLT11." Wife's feedback (separate thread) on the
marketplace UX flagged that paste-as-default fails for non-technical
users. Designing pure Option B atomic lifecycle made the destination-
input step's UX a first-class question.

**Options considered:**
- (a) **Paste-only:** user always pastes a BOLT11 invoice. Universal,
      works for every wallet, but creates friction every claim and
      doesn't reward returning users.
- (b) **LN Address only:** user types a Lightning Address, system
      resolves. Smoother for users who have one, but breaks for
      wallets that only generate BOLT11 (some Phoenix versions, some
      Wallet of Satoshi flows, certain Fedi configurations).
- (c) **Three-tier hierarchy:** saved destination tap (primary), LN
      Address with auto-save toggle (secondary), BOLT11 paste behind
      Advanced disclosure (tertiary). The smooth path is the default;
      the manual path is the escape hatch.

**Decision:** Option (c).

**Rationale:** Reordering affordances rather than removing them
preserves the ability of every wallet to claim while making the
common case effortless. The auto-save-on-first-claim detail is the
key — the user pastes their address once, the system remembers,
and from the second claim onward they tap a saved row. The toggle
itself ("Save for next time") is the educational moment per Pillar
2.7 — the user reads the toggle, understands implicitly that future
trades will be faster, and the system has taught them without a
tutorial.

This also corrects an architectural mistake: handle-management
should not live in Settings as the canonical add-flow. Settings is
for *managing* handles (rename, remove, mark default), not for
*adding the first one*. Adding happens organically in the moment
the user feels the friction of typing an address. That's the right
onboarding gradient — the user learns about the feature at the
moment using it saves them future work.

**Implications:**
- Saved-handles surface (already exists from v0.1.79) becomes the
  primary affordance at claim and fund time, not a settings-tucked
  power feature.
- "Save for next time" toggle defaults ON in the input field. Users
  who want to use a one-off address can untoggle; default behavior
  is the helpful behavior.
- Same hierarchy applies symmetrically at QR-IN where appropriate
  (sender providing destination; the asymmetry is real but the
  affordance ordering principle holds).
- BOLT11 paste lives behind "Advanced" disclosure or "More options"
  expander. Available, not hidden. Doesn't clutter the main flow.
- This affordance hierarchy becomes a Chama-wide pattern: tap-saved
  > input-with-save-toggle > paste-advanced. Applies to any future
  surface where users need to provide destinations or selections
  with returning-user dynamics.

**Status:** Active. Lands in v0.3.0 alongside the atomic lifecycle
work. The two are mutually reinforcing — atomic lifecycle removes
the wallet-balance preamble, LNURL-first claim removes the
paste-each-time preamble, and the result is a flow where the user
taps a listing and taps to claim and the system handles everything
in between.

---

## 2026-05-07 — Menu primitive as vertical-agnostic listing schema

**Context:** Wife provided marketplace feedback that single-item
listings don't match how real merchants think — sats.coffee, a
tailor, a motorbike repair shop, all have menus, not single items.
Initial thought was "add multi-item to marketplace." Generalizing
revealed the same pattern applies across all five Chama verticals.

**Options considered:**
- (a) **Marketplace-only multi-item:** add multi-item support as a
      Marketplace-vertical feature. Solves the immediate feedback,
      but ships the same primitive five times eventually as each
      other vertical encounters the same need.
- (b) **Per-vertical multi-item, custom each time:** build it for
      each vertical when the vertical's users ask. Five different
      schemas, five different basket UIs, five different LOCK
      payloads. Worst-case path.
- (c) **Vertical-agnostic menu primitive:** listings gain optional
      `items: MenuItem[]`. Absent = single-item (today's behavior).
      Present = buyer composes basket. Trade carries `selected_items`
      summed into single `amount_sats`. Escrow envelope unchanged
      across all verticals. Per-vertical applications (FX flavors,
      product menus, utility-payment menus, loan tiers, arbitration
      tiers) emerge naturally from the same primitive.

**Decision:** Option (c).

**Rationale:** The escrow envelope was always vertical-agnostic —
LOCK, VOTE, CLAIM don't care what the trade is *for*, only that it
has an amount and participants. Multi-item is a *listing* concept,
not an escrow concept. Building it as a listing-schema feature with
buyer-side basket UI keeps the protocol layer untouched and unlocks
all five verticals simultaneously.

The cross-vertical applications make this compelling beyond the
original marketplace use case:
- P2P Exchange: liquidity providers list multiple FX flavors per
  rail in one listing
- Marketplace: full merchant menus (sats.coffee, tailors, repair
  shops, etc.)
- Bill Pay: volunteer help desks offering multiple utility services
  with per-service fees
- Community Lending: lenders publishing tiered loan products
- Raw Escrow: arbiters publishing tiered fee structures

This positions Chama as a decentralized, self-custodial alternative
to BTCPayServer-style merchant tooling, but with the substrate being
Nostr + Fedimint instead of Lightning + custodial infrastructure.
That's a meaningful market positioning beyond what single-item
P2P trade unlocks.

**Implications:**
- v0.4.0 ships the menu primitive after v0.3.0 atomic lifecycle.
  Sequence matters: v0.3.0 makes funding clean (one BOLT11 per
  trade); v0.4.0 makes the unit-of-funding richer (one trade can
  contain multiple items). They reinforce, don't fight.
- Buyer-side basket UI is new code in Browse → Listing detail.
  Quantity steppers, running total, basket-modify pre-create.
- Seller-side menu builder is new step in Create wizard for menu-
  listings. Save-draft applies same as fixed-price.
- LOCK payload format extends with `selected_items: SelectedItem[]`
  (a snapshot, not a reference — the listing could change after
  the trade is created). Listing snapshot in trade includes
  line-itemized description so seller and arbiter see exactly what
  was ordered.
- Per-vertical UX nuances (loan term picker for Lending, fee tier
  picker for Raw Escrow, etc.) are styling on top of the same
  basket primitive. Not five separate features.
- Future market positioning narrative: "Chama is the decentralized,
  self-custodial alternative to merchant payment infrastructure" —
  v0.4.0 enables that story credibly. Pre-v0.4.0, Chama is a P2P
  trade tool; post-v0.4.0, Chama is a multi-vertical commerce
  primitive.

**Status:** Active. Targeted for v0.4.0 after v0.3.0 ships. Wife
credited as design partner for surfacing the underlying need; the
cross-vertical generalization emerged in conversation with Claude
on 2026-05-06.

---

## 2026-05-09 — DestinationPicker as canonical sender-side affordance

**Context:** v0.3.0 needed a single "user provides a destination to
receive sats" surface that three different consumer surfaces could
reuse: the claim flow (Phase 3), the recovery banner failure-mode
drain (Phase 4), and the destroy-modal recover-then-switch path
(Phase 4). Building three near-identical pickers risked drift over
time — the next maintainer adds a feature to one, forgets the others,
and the three surfaces start diverging.

**Options considered:**
- (a) **Inline picker UI per surface** — each consumer renders its
      own picker with its own LNURL resolution + saved-handle list +
      BOLT11 paste affordance. Maximum flexibility per consumer; high
      duplication; almost certain to drift.
- (b) **DestinationPicker shell as canonical surface** — one React
      component that consumers compose via
      `<DestinationPicker onResolve={...} />`. The picker handles its
      own LNURL resolution + tier rendering + error surfacing
      internally; consumers receive a BOLT11 plus dispatch metadata
      `{ saveAfter, addressUsed }` and decide what to do next.
- (c) **Lower-level helpers, no shell** — export
      `resolveLightningAddressToInvoice` + `decideDispatch` and let
      consumers wire their own UI. Same drift risk as (a) plus the
      added burden of every consumer reimplementing the visual
      hierarchy.

**Decision:** Option (b). The shell is the canonical surface;
consumers import and compose, never reach past it into picker
internals.

**Rationale:** The three-tier visual hierarchy (saved rows / typed
address with save toggle / BOLT11 paste under disclosure) is the load-
bearing UX commitment from Pillar 2.7 — saved-first surfaces faster
trades organically, and the "Save for next time" toggle IS the
educational moment. Centralizing this in one component makes the
hierarchy a single source of truth across surfaces. Phase 1 split the
picker into a shell (`DestinationPicker.tsx`) plus pure decision
logic (`destination-picker-logic.ts`); the logic is unit-tested
exhaustively, and the shell is composed across consumers without
exposing those internals.

**Implications:**
- Three consumer surfaces in v0.3.0 — `ClaimPayoutModal` (Phase 3),
  `RecoveryPayoutModal` (Phase 4, used by both the recovery banner
  and destroy-modal paths) — all mount `<DestinationPicker />`
  directly. None of them imports from `destination-picker-logic.ts`.
- Future surfaces (sovereign LN address withdrawal in v0.3.1, NWC
  adapter in v1.5, any future "send sats out of Chama" flow) plug into
  the same `onResolve` contract. NWC in v1.5 will likely add a fourth
  tier ("use connected wallet") inside the shell, transparent to
  existing consumers.
- The internal seam (picker logic vs shell) is a stable architectural
  boundary, not an implementation detail. Tests exist at the logic
  layer; visual contract is reviewed at the shell layer.
- Code-review heuristic: any future PR that imports from
  `destination-picker-logic.ts` outside the shell or its own tests is
  drifting from this decision. Catch in review, not after merge.

**Status:** Active. Operationalized in v0.3.0 Phases 1 (foundation),
3 (claim consumer), and 4 (recovery + destroy consumers). Pinned by
the Phase 1 §36 picker-logic test surface and the Phase 3+4 reminder
discipline that consumer surfaces compose the shell, not the
internals.

---

## 2026-05-09 — AtomicFundingModal as receive-side BOLT11 surface

**Context:** v0.3.0 needed a sender-side / receiver-side asymmetry to
be intentional, not accidental. DestinationPicker (the previous
decision) is unambiguously send-side: the user picks a destination to
receive sats. The fund-time path looks superficially similar — the
user is providing a wallet to interact with — but it's actually
receive-side from Chama's perspective: Chama issues a BOLT11 invoice,
the user's external Lightning wallet pays it. Lightning Addresses are
receive-only by protocol; "auto-pay from saved Lightning Address" is
not a thing the protocol allows.

**Options considered:**
- (a) **Symmetric DestinationPicker on both sides** — show saved
      Lightning Addresses + "Save for next time" toggle at fund time
      too. Visually consistent with the claim flow but architecturally
      misleading: a Lightning Address has no spending authority, so
      saving one at fund time would imply a capability the protocol
      doesn't grant.
- (b) **AtomicFundingModal as a separate receive-side surface** —
      Chama-issued BOLT11 invoice is the centerpiece; user pays from
      any external Lightning wallet via QR scan or paste. No saved-
      destinations at fund time, because the user IS the sender. The
      modal handles invoice generation, 15-minute countdown, payment
      detection, mint-confirming watchdog, and chained LOCK in one
      atomic flow.
- (c) **Hide the fund-time UX entirely** — auto-detect inbound
      payment via OPFS subscription and skip the modal. Sounds elegant
      but breaks for users who need to actually scan a QR to pay; no
      visual anchor for the "this is your funding moment" beat.

**Decision:** Option (b). AtomicFundingModal is a receive-side
surface; DestinationPicker is a send-side surface. The two never mix.

**Rationale:** The protocol asymmetry between Lightning Addresses
(receive-only) and Lightning sending (BOLT11 invoices, NWC for
programmatic spending) is real and load-bearing. v0.3.0 ships the
foundation that v1.5 NWC will layer on top of — at that point,
AtomicFundingModal gains a "use connected wallet" branch that bypasses
the BOLT11 display entirely (NWC grants spending authority with
budgets, which Lightning Addresses fundamentally cannot). Designing
the surfaces with the asymmetry visible NOW prevents v1.5 NWC from
needing to restructure either modal.

**Implications:**
- DestinationPicker is mounted only by send-side consumers (claim,
  recovery, destroy). Pinned by the Phase 1 reminder that consumer
  surfaces compose the shell directly.
- AtomicFundingModal is mounted only by the receive-side path
  (listing-tap → Fund). It never composes DestinationPicker; the
  surface architecture is intentionally not symmetric.
- v1.5 NWC's "use connected wallet" feature will:
  - Add a fourth tier inside DestinationPicker on the send side (NWC
    grants spending authority, so the picker can now offer one-tap
    auto-send instead of address-resolution).
  - Add a pre-BOLT11 auto-pay branch inside AtomicFundingModal on the
    receive side (the connected wallet pays the invoice
    programmatically; the user never sees the BOLT11).
  Both extensions plug in without restructuring either component.
- Documentation surface: this asymmetry is mentioned in the brief and
  in `DestinationPicker.tsx` / `AtomicFundingModal.tsx` file
  headers. Future maintainers reading either modal in isolation can
  see why the surfaces look different even though the user-facing
  task ("connect a wallet to a trade") sounds similar.

**Status:** Active. Operationalized in v0.3.0 Phase 2 (AtomicFunding-
Modal + `runFundAndLock`). v1.5 NWC item in BACKLOG.md references this
foundation explicitly.

---
