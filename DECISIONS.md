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

## 2026-05-05 — Patcher workflow with Claude Code

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
- Future surfaces (sovereign LN address withdrawal in v0.4.0, NWC
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

## 2026-05-11 — Federation reachability as a first-class boot-time state

**Context:** v0.3.0 shipped with federation reachability checked only
at just-in-time moments (lock, claim, invoice creation). Production
smoke on Bitcoin Principles (the default federation, b21068c8 —
surfaced as "Global · USD" in the picker) caught the failure mode: 3
of 4 guardians dead means mint operations cannot complete, but `join`
succeeds because joining only requires reading public federation info
(one guardian suffices). Result: every user composed a trade for ~90
seconds before learning the federation was unreachable. The hang then
manifested as the wrong terminal (`claim-pending`) because the
useEscrow catch-all swallowed the typed bridge error into a silent
watchdog (see sister entry below).

**Options considered:**
- (a) **Probe at lock time only** (status quo through v0.3.0).
      Federation truth surfaces too late — after the user has invested
      attention in composing a trade.
- (b) **Periodic background probe** — every N seconds, refresh
      reachability state. Adds complexity, polling cost, race
      conditions between probe windows and user actions.
- (c) **Cold-boot probe** — run probe1 sequentially after
      initFedimint resolves successfully; expose result as
      `bootProbeState`; gate action surfaces on it. Surfaces unreachable
      federations at app load, before composition. Single source of
      truth across the app.

**Decision:** Option (c). probe1 lives inside `useEscrow.initFedimint`,
sequential — runs after init resolves and before the action returns.
`FedimintState.bootProbeState: "pending" | "ok" | "failed"` exposes
the result. Action surfaces (Fund + Claim) gate on
`bootProbeState === "failed"`. ChamaBar surfaces a single
"⚠ Chama unreachable · Reconnect →" pill (the v0.3.0
`decideChamaBarLabel` decision gains an `unreachable` kind that wins
over the existing three). TradeDetail's Fund + Claim buttons disable
with "Federation unreachable — reconnect first" subtitle pointing back
at the ChamaBar Reconnect — single source of truth, no parallel
surface.

**Rationale:** Reachability is the floor for any other meaningful
state. If the user can't reach the federation, they can't recover
stranded sats, lock new ones, or claim trade winnings — the
actionable next step is always Reconnect, not Recover or Vote.
Surfacing reachability at boot turns "discover brokenness 90 seconds
into composing" into "know immediately at app load and can act."
Sequential placement inside initFedimint means probe1 truth is
available before any meaningful navigation. Single Reconnect surface
across the app (ChamaBar pill) prevents fragmentation — TradeDetail
gates its buttons against the same flag, doesn't render its own
Reconnect.

**Implications:**
- The existing healthRef cache override pattern stays for the legacy
  probe2 path, but boot probe truth wins on conflict. The pre-Phase-3
  optimism ("a successful join is itself proof of reachability") was
  wrong in the broken-quorum case; boot probe explicitly overrides
  that seed.
- The Phase 1 `probeFederation` action also updates `bootProbeState`,
  so the claim-bridge-threw Try-Again flow naturally unblocks the
  boot gate across the entire UI. Same probe seam, three callsites
  (initFedimint boot, claim-bridge-threw retry, ChamaBar Reconnect
  tap — all dispatch through the same action).
- `decideChamaBarLabel` priority ordering: unreachable > in-trade /
  stranded / ready. Tested as a tripwire (§42 in tests.ts) — a
  future refactor that accidentally reorders the priority checks
  would let in-trade or stranded leak through during a federation
  outage. The tripwire fires immediately on regression.
- "pending" is a transient state (between initFedimint resolving and
  probe1 awaiting); UI is fine with the brief optimistic rendering
  during it. Only "failed" gates action surfaces.

**Status:** Active. Operationalized in v0.4.0 Phase 3. §42 tripwire
in tests.ts pins the priority ordering — failed-overrides-all-inputs
is a forever-asset.

---

## 2026-05-11 — Typed bridge errors propagate; watchdog is fallback

**Context:** v0.3.0 Phase 3 shipped the claim-and-payout three-terminal
split (`claim-failed` / `claim-pending` / `payout-failed`). The design
was correct, but a gap in the underlying `useEscrow.claimAndRedeem-
Action` catch chain blocked it from working as designed. The catch
had a "Probably transient" catch-all that swallowed typed bridge
errors (`FED_PROBE_FAILED`, `FED_MISMATCH`) into a silent watchdog. By
the time `runClaimAndPayout` saw the resolved promise, it interpreted
the silently-returned local state as "claim succeeded, balance hasn't
grown yet" → `claim-pending`. Production smoke: every claim attempt on
Bitcoin Principles showed "Your sats are still arriving" for 60
seconds, even though redeem definitively failed pre-publish with no
spend, no chain advance, nothing in flight. The user had no path to
retry beyond closing and reopening the modal.

**Options considered:**
- (a) Tighten the watchdog catch-all to ignore typed bridge errors so
      they re-throw and `runClaimAndPayout`'s existing `claim-failed`
      terminal catches them. Cheap, but conflates two different
      failure modes (hard claim failure with no retry vs. retry-able
      bridge unreachability).
- (b) Restructure the three-terminal split. **Rejected** per Phase 1
      scope guardrail — the three-terminal design was correct; the
      swallow is what blocked it from working as designed.
- (c) **Add a fourth retry-able terminal `claim-bridge-threw`** for
      typed bridge errors with a documented set of codes
      (`BRIDGE_THREW_ERROR_CODES`). Watchdog stays for genuinely
      uncategorized errors (worker timeout, fetch failed, RPC
      hiccups). Modal surfaces actual error + Try-again button.

**Decision:** Option (c).
`BRIDGE_THREW_ERROR_CODES = ["FED_PROBE_FAILED", "FED_MISMATCH"] as const`
is the documented set; `isBridgeThrewError` predicate discriminates in
`runClaimAndPayout`'s catch block. ClaimPayoutModal renders the new
terminal with the underlying error as subtitle and a two-step
Try-again button: probe federation first → if ok, re-dispatch claim
from scratch with the same destination; if probe still fails, stay on
terminal with updated error message.

**Rationale:** The existing watchdog fallback (transient → wait for
balance to land) is correct for genuinely transient errors, where the
federation IS processing the redeem and the JS-side error reflects an
RPC hiccup. But typed bridge errors with a known code communicate a
structural state ("federation unreachable", "wallet on wrong fed")
that no amount of waiting will fix. Surfacing them directly with the
actual message + retry affordance matches reality. Watchdog stays as
fallback for the unknown-error case, not the primary path for known
errors.

**Implications:**
- Honest-copy fix at escrow-bridge.ts: the pre-stash
  `FED_PROBE_FAILED` throw now says "(No sats were spent — retry when
  your Chama is reachable.)" instead of the previous false "Notes
  stashed for retry" message. Notes are NOT stashed at that point in
  the flow (stash happens AFTER CLAIM publish, ~50 lines later). The
  post-stash `claimPublished: true` throw keeps its existing "Claim
  published, redeem failed" copy because notes ARE stashed there.
  Two throw paths with different post-conditions and different copy —
  Pillar 2.7 with gradations.
- Tripwire test for the documented codes set: if a future maintainer
  adds a new typed bridge error (e.g., `FED_DISCONNECTED`), the
  `BRIDGE_THREW_ERROR_CODES.length === 2` assertion fails until they
  update the documented set + add a routing test. Forces the contract
  to evolve together.
- The claim-bridge-threw retry path reuses the Phase 1
  `probeFederation` action — same probe seam that the boot probe
  uses. A successful retry-probe both unblocks the modal AND updates
  `bootProbeState` to ok (see sister DECISIONS entry above), so the
  ChamaBar unreachable pill clears and Fund/Claim re-enable across
  the rest of the UI in one action.
- The original three-terminal split is preserved unchanged.
  `claim-pending` is now RESERVED for the case it was designed for:
  bridge resolved successfully (no throw), but balance hasn't reflected
  the credit within the 60s watchdog window. `payout-failed` stays
  reserved for claim-landed-but-LN-send-threw.

**Status:** Active. Operationalized in v0.4.0 Phase 1. §45 in tests.ts
pins the discrimination at every quadrant: typed throws → bridge-threw,
hard-failure throws → claim-failed, untyped throws → claim-failed,
clean+stalled → claim-pending.

---

## 2026-05-11 — Fedi-runtime delegation is a viable v0.4.0 path

**Context:** Pre-v0.3.0, the assumption was that Chama's browser OPFS
Fedimint client would handle all federation operations directly,
independent of Fedi. Production smoke against Bitcoin Principles
(3 of 4 guardians dead) AND Bitcoin Life (full quorum, iroh-relay
transport failure) confirmed that the OPFS-Fedimint-via-iroh-relay
transport doesn't work in browser today, against any federation.

**Decision:** Pursue Hybrid runtime. v0.4.0 detects Fedi webview at
boot (per the _isFediRuntime pattern proven in Satoshi Market)
and delegates federation operations to:
  - window.fediInternal.generateEcash({amount}) for lock-time
    ecash generation (federation-aware via notes prefix)
  - window.fediInternal.receiveEcash(notes) for claim-time
    ecash receipt (cross-federation confirmed working)
  - window.webln.sendPayment/makeInvoice for LN routing
  - window.nostr for NIP-07 signing (already used)

Outside Fedi, Chama continues to use OPFS Fedimint client and
surfaces honest errors per v0.4.0's claim-bridge-threw terminal
until v0.x ships native iroh transport for browser.

**Rationale:** The Satoshi Market codebase already proved every API
above works in production. We are not exploring; we are porting
a known-working integration pattern into Chama. v0.4.0 ships
Nairobi-ready demo via Fedi webview; native browser transport
remains a separate workstream without blocking demo timing.

**Implications:**
  - Fedi-runtime detection becomes a top-level architectural fork
  - SSS escrow logic is unchanged (ecash splitting is rail-agnostic)
  - Chama's OPFS client stays for non-Fedi-webview environments
  - "Couldn't reach your Chama" remains correct fallback for
    standalone browser until native transport ships
  - Nairobi demo: Chama-as-Fedi-mini-app, demoable on any phone
    with Fedi installed

**Status:** Active — v0.4.0 scope, post-v0.4.0 release.

---

## 2026-05-11 — All current Chama surfaces blocked on Fedimint SDK ≤0.1.1 + iroh-relay ≥0.91 mismatch

After v0.4.1's relay race fix unblocked Chama's local init path, the
underlying federation transport reachability was revealed as a pure
upstream dependency problem: @fedimint/fedimint-client-wasm-bundler
ships a pre-iroh-0.91 client. iroh-relay servers were upgraded to
iroh ≥0.91 (Aug 2025) with wire-level breaking changes to the WebSocket
handshake protocol. Client and server can't handshake. HTTP 400 every
time.

Affected surfaces (all identically blocked):
- Standalone browser (Firefox, Chrome, Safari) — same WASM
- Capacitor APK — wraps WebView, same WASM
- Chama-as-Fedi-mini-app — loads chama.satoshimarket.app, same WASM
- (Only Fedi mobile native app reaches federations, via compiled
  iroh-net binary that bypasses iroh-relay entirely; that code path
  is not available to web clients)

Tracking upstream: github.com/fedimint/fedimint-sdk/issues/288

v0.4.1's relay race fix and v0.4.0's honest error surfacing remain
correct and valuable independent of this issue. They make the local
diagnostic clean so the "Chama unreachable" message now points at the
real, upstream blocker.

Unblock path:
1. Fedimint SDK releases a version targeting iroh ≥0.91 → bump deps,
   smoke test, ship v0.4.2
2. If a working canary build is identified, use it as an interim
   bridge while waiting for a proper release
3. If both paths fail before Nairobi: pivot demo strategy to
   listings-and-Nostr-only (signed escrow events render, full trade
   completion deferred to post-SDK-update)

Nairobi feasibility depends on (1) or (2). Architecturally Chama is
ready; transport layer is upstream-blocked.

**2026-05-18 update:** A working canary was confirmed, but the latest
published npm packages remain `@fedimint/core@0.1.3`,
`@fedimint/transport-web@0.1.2`, and
`@fedimint/fedimint-client-wasm-bundler@0.1.1`. Fedimint SDK
maintainers replied on issue #288 that the larger active effort is
moving away from `wasm-pack` toward fully UniFFI-based builds across
the SDK stack, so they are not promising an exact stable release
timeline for the iroh bump.

**Implication:** Continue Chama v1 as planned. The Chama architecture
stays correct because it isolates Fedimint behind `IFedimintWallet`,
keeps runtime detection at the edge, and treats SDK transport as a
replaceable adapter concern. Do not rewrite toward UniFFI preemptively;
wait for the SDK API/package shape to land, then adapt the factory.
In the meantime, canary testing is now an upstream contribution track:
smoke BP, BLF, Afribit, and the browser/Fedi surfaces, then report
regressions with package hashes, federation, browser, and console logs.

---

## 2026-05-18 — NIP-46 signer app is advanced desktop-only until proven reliable

**Context:** The "Use a signer app" button was sitting beside the
primary sign-in CTA, but current NIP-46 attempts can stall and produce
`WebSocket is already in CLOSING or CLOSED state` followed by a Chama
timeout. The flow may still become the best desktop privacy path
because it signs every event without embedding a browser key, but it
has not earned primary placement yet.

**Decision:** Hide NIP-46 under "More sign-in options" and offer it
only in standalone desktop web sessions. Do not show it in native
Capacitor builds, mobile browser sessions, or Fedi webviews.

**Rationale:** Fedi webview already supplies `window.nostr`; mobile
users need the least fragile sign-in surface; and desktop is where a
remote signer can plausibly become the power-user default after real
testing. This preserves the option without letting a flaky path define
the first impression.

**Promotion criteria:** Before making NIP-46 the desktop king, prove
at least two signer implementations, verify relay behavior over
`wss://relay.satoshimarket.app`, confirm NIP-44 encrypt/decrypt support
or document fallback limits, and add user-visible timeout/retry copy
that distinguishes signer rejection from relay failure.

---

## 2026-05-18 — Nairobi is demo context, not the primary roadmap goal

**Context:** Older backlog entries treated Adopting Bitcoin Nairobi as
the v1 forcing function. That was useful while the product surface was
coalescing, but it became too restrictive: it encouraged demo-readiness
to compete with product correctness, privacy boundaries, recovery
semantics, and long-term maintainability.

**Decision:** Chama's primary goal is an integrity-first v1, not a
Nairobi launch date. Nairobi can still supply feedback, demos, partner
stories, or useful pressure, but it does not define scope, sequencing,
or quality bars.

**Implications:**
- Privacy/category fixes beat deadline-driven polish.
- Launch can slip when the right architecture or user-safety work needs
  more time.
- Backlog language should refer to production feedback or real usage
  rather than "Nairobi data" as the deciding input.
- Demo plans live below product integrity work and should never block a
  more important trust fix.

**Status:** Active in the next post-v0.6.1 wave.

---

## 2026-05-18 — Lightning Addresses are payout destinations, not payment handles

**Context:** The v0.3.x claim/recovery flow saved Lightning Addresses
inside `chama_saved_handles` under a synthetic `LIGHTNING_RAIL`. That
made implementation easy, but it blurred a privacy boundary: payment
handles are counterparty-facing data that can be revealed in a LOCK
event, while Lightning Addresses are self-payout destinations used only
after claim or recovery.

**Decision:** Move Lightning Address persistence into
`chama_payout_destinations`. Migrate legacy `LIGHTNING_RAIL` rows out of
`chama_saved_handles`, keep payment handles limited to fiat/public rails,
and expose a separate Me → Settings row called "Payout destinations."

**Implication:** Claim and recovery can still offer one-tap saved
destinations, but the trade-time handle reveal picker no longer has any
path to show or publish the user's Lightning wallet address.

---

## 2026-05-19 — One funding operation at a time replaces one trade at a time

**Context:** The 2026-05-05 three-tab decision was built on top of a
hard "one trade at a time" gate: while any user-as-buyer-or-seller
escrow was live, Create and Fund were blocked. The gate was designed
for an earlier architecture where concurrent trades risked ecash
collisions in the shared OPFS wallet. Option B's full wiring (BOLT11
IN → mint → `spendNotes` → LOCK → OPFS drains to 0) closes that risk:
the wallet sits at zero between trades, and ecash only exists for the
milliseconds spanning `runFundAndLock`. The hard gate now over-blocks
— sellers can't serve multiple buyers, buyers can't browse for the
next trade while a previous one is in LOCKED/voting/approved.

**Decision:** Retire the one-trade-at-a-time hard gate. Replace it
with a `fundingInProgress` flag that disables only a second Fund tap
while `runFundAndLock` is mid-flight. Create + Browse stay open
always. ChamaBar and ActiveTradePill become plural-aware ("3 active
trades · 150k sats in escrow"). The recovery banner narrows to skip
the expected-transient cases — mid-fund and mid-claim hold the
balance briefly and shouldn't race the very flow that's about to
drain it.

**Rationale:**
- The architectural risk the original gate protected against is gone.
  What remains is one wallet-race scenario (two concurrent
  `spendNotes` on the shared OPFS wallet), and that's local to the
  funding flow, not the trade lifecycle. The AtomicFundingModal is
  already exclusive by nature (one modal at a time); the flag is the
  programmatic backstop.
- Users complete trades because sats are locked, not because the UI
  hid the rest of the app. The commitment is financial. Patience
  still belongs in the design, but via education and nudges — the
  pill, claim notifications, the ChamaBar "in escrow" surface — not
  hard blocks.
- Multi-trade is a real use case: a seller running three listings,
  an arbiter watching two LOCKED trades, a buyer browsing for the
  next thing while waiting on a counterparty to release the current
  one. The old gate forced these users into a serial workflow that
  didn't match either the architecture or their lived activity.

**Implications:**
- Tab routing still puts Browse / Create / Me at the same level.
  The pill is now informational rather than gating; the only
  visible "no, not yet" surface is the Fund button briefly greying
  out while another funding flow is mid-flight.
- The state machine is unchanged. Each trade's event chain remains
  independent; concurrency was always a UI-layer concern, never a
  protocol concern.
- The "patience as a feature" language in PHILOSOPHY §2.1 is
  retained but reframed: patience now lives in trade completion
  speed and user judgment, not in interface gates.

**Status:** Active. Shipped v0.6.5.

---

## 2026-05-20 - DECISION (locked): "P2P" renamed to "Exchange" across all user-facing surfaces. 
P2P renamed to Exchange, Bill Pay renamed to Community Bill Pay across all user-facing surfaces. Internal category enum values (p2p-trade, bill-pay) unchanged. Pill abbreviation: ⚡ EXCHANGE and 🧾 COM. BILL PAY. Full name in Create wizard, Trade Detail, and educational contexts. The "Community" prefix is structural — it anchors the mutual-aid framing where someone helps someone else pay their bill, not a self-service fintech feature. Per Pillar 2.7, the name itself educates.

---

## 2026-05-22 - Arbiter dispute fee: fixed escalation, outcome-independent split

**Decision:** Dispute fees are fixed at 1.5% additional (on top of the
ambient 0.5%), split equally between buyer and seller regardless of who wins.
Neither party chooses the amount.

**Rejected alternatives:**
- User-chosen dispute fee: both parties are adversarial at dispute time and
  will race to the bottom. The losing party feels doubly robbed.
- Average of both bids: trivially gameable. Bid 0, counterparty bids high,
  split the middle.
- Fee only from the losing party: creates perverse incentive — arbiter may
  subconsciously favor outcomes that maximize their take.

**Why outcome-independent split works:**
The arbiter's compensation is decoupled from who wins. No party can buy a
favorable outcome by paying more. The dispute cost is a known quantity before
opening — users can price it honestly. Fast arbiter response is incentivized
because the fee is already locked; slow response is just leaving money on the
table.

---

## 2026-06-06 — Fiat listings show the creator's currency for everyone; viewer-currency "≈" retired

**Context:** A listing carries a native fiat price in the creator's Chama
currency — a Cotonou seller prices in XOF, a Dar seller in TZS. The headline
already anchored on that native price, but a viewer whose own Chama used a
different currency also saw a secondary "≈ {their currency}" line, converted
live through FX rates. Two things were wrong with that second line. It implies a
precision that doesn't exist — the seller will not accept the buyer's currency
at mid-market rate, so it reads like a quote when it's a one-leg guess. And it
depends on live FX, which means the same listing renders differently depending
on whether rates loaded — broken entirely on Tauri (see the entry below), flaky
on slow links.

**Options considered:**
- (a) **Keep the "≈" overlay** — convenient for cross-border viewers, but
      dishonest about precision and non-deterministic across surfaces.
- (b) **Creator currency for everyone, retire the "≈"** — one authoritative
      fiat figure, identical for all viewers; sats (₿) stays the universal
      cross-border reference since it's what actually settles.
- (c) **Convert everything to the viewer's currency** — worst option; buries
      the price the seller actually set behind an FX guess.

**Decision:** Option (b). `shouldQuoteEstimatedFiat` returns false — the
viewer-currency estimate is gone for any listing that carries a fiat price.
Sats-only listings with no native fiat keep their single estimated figure;
they have no creator price to anchor on and no second line to be redundant with.

**Rationale:** Optimizes for honesty and determinism over convenience. Every
viewer sees the same price the seller set, plus the same sats. No FX guesswork
presented as a quote, and a listing looks identical with or without live rates.
What we give up: a cross-border viewer no longer gets a glance-value in their own
currency and has to read the sats (or learn the seller's currency). Worth it.

**Implications:** Display-only — vote/escrow mechanics untouched. Removes a
live-FX dependency from the render path, so listings survive offline/slow links
and the Tauri rate-fetch gap intact. The two existing
`shouldQuoteEstimatedFiat` unit assertions flip to expect suppression.

**Status:** Active.

---

## 2026-06-06 — Market price/FX fetches go through the Tauri HTTP plugin on desktop

**Context:** The Create form's sats↔fiat toggle was dead on the Tauri desktop
build only — APK and browser both worked, Tauri showed sats and nothing else.
The toggle isn't the bug: the BTC-price and FX-rate fetches never resolve under
Tauri, so there's no rate to turn a typed fiat price into sats and the fiat
fields have nothing to do. Why only Tauri — the APK serves from
`https://localhost` and the browser from a real origin, and the public price
APIs answer both because they send `Access-Control-Allow-Origin: *`. Tauri serves
from a custom `tauri://` scheme; the system WebView (WebKitGTK / WKWebView)
treats that as an opaque origin and blocks the cross-origin `fetch`, and no HTTP
plugin was registered (`src-tauri/Cargo.toml` carried only `tauri-plugin-shell`)
so the request had no way out of the WebView.

**Options considered:**
- (a) **Set a permissive CSP / hope the WebView allows it** — doesn't address
      the opaque-origin block; WebKit still refuses, platform-dependent.
- (b) **Proxy the price feeds through our own server** — reintroduces a server
      Chama deliberately doesn't have; a liveness and trust dependency for a
      cosmetic feature.
- (c) **`@tauri-apps/plugin-http`, Tauri-only** — make the request from Rust
      (reqwest), which isn't subject to WebView CORS; leave web/APK on the
      global `fetch` untouched.

**Decision:** Option (c). The two market modules (`markets/bitcoin-price.ts`,
`markets/fiat-rates.ts`) route through the Tauri HTTP plugin when — and only
when — `isTauriNativePlatform()` is true. The plugin is registered in the Rust
shell and the price/FX hosts are allow-listed in the desktop capability.

**Rationale:** Keeps Chama serverless, fixes the actual cause (origin/CORS, not
CSP), and confines the change to the desktop surface so web and Android can't
regress. Reuses the platform detector already used by the native bridge.

**Implications:** One JS dependency, one Rust crate, and a capability allow-list
that has to track the host list in the two market modules — if a price source is
added there, its host must be added to the capability or it'll fail on desktop
only. Web build and unit tests can't exercise the Rust side, so this needs a real
`tauri:dev` / `tauri build` run to confirm the BTC pill resolves end-to-end.

**Status:** Active.

---

## 2026-06-07 — Light mode via in-place palette swap, not CSS variables

**Context:** #50 asks for dark/light theming. The entire UI styles itself with
inline styles reading a single static `T` token object (`import { T }`), and a
recon pass found **198 call sites** that build colors by string-concatenating an
alpha onto a token (`` `${T.accent}aa` ``, `T.green + "18"`). There are no
`React.memo`/`PureComponent` barriers anywhere in `src/ui`, all 16 `useMemo`s
are data-shaping (none close over styles), and only three things capture token
values at module load: `STATUS` and `inputStyle` in theme.ts, and the
`globalCss` template in App.tsx. index.html hardcodes the boot background and
`theme-color`.

**Options considered:**
- (a) **CSS custom properties** — the "modern" answer; instant switching. But
      `var(--accent)` + `"aa"` is not a color: all 198 concat sites would need
      `color-mix()` (WebView-support risk on older field devices in exactly the
      markets Chama serves) or an explosion of per-alpha tokens. Biggest diff,
      real compatibility risk.
- (b) **Theme via React context** — type-safe, but abandons the codebase's
      `import { T }` idiom and threads a hook through every component. Hundreds
      of mechanical edits, no offsetting benefit.
- (c) **Two palettes, swap in place** — `T` stays the one export;
      `applyThemeMode()` `Object.assign`s DARK or LIGHT into it, rebuilds the
      three module-load captures (`STATUS`, `inputStyle`, `globalCss` becomes a
      function), and a root-level state bump repaints the whole tree (no memo
      barriers — audited, not assumed). Mode persists like the amount-display
      preference; a tiny pre-bundle script in index.html applies the saved mode
      to the boot background so light users don't get a dark flash.

**Decision:** Option (c), with modes `dark | light | system` (system follows
`prefers-color-scheme` with a change listener). Dark stays the default — it's
the brand. Toggle lives in Me. Role colors (PHILOSOPHY §5.2) stay identical in
both palettes — sacred means sacred. QR codes and the scanner overlay stay
universal black-on-white in both modes; a backup QR's job is to scan, not to
match the wallpaper.

**Rationale:** The 198 concat sites keep working untouched — the swap happens
underneath the idiom instead of fighting it. The whole diff concentrates in
theme.ts, the Me toggle, and index.html. Light-palette hues are darkened where
needed (green/amber/teal/purple/accent text on white) to keep contrast honest.

**Implications:** The palette is now the single source of truth and module-load
capture is the one footgun: any future `const FOO = { x: T.accent }` at module
scope will go stale on switch. Rule: read `T` at render time, or rebuild the
constant inside `applyThemeMode()`. A unit test pins T/STATUS/inputStyle
staying in sync across a swap.

**Status:** Active.

---

## 2026-06-07 — Arbiter v3: presence bond (slash-to-cover), fairness by reputation

**Context:** The arbiter economy (DESIGN-arbiter-economy.md §3–5) needs the
bond question settled before V3 builds it. The crystallization: the protocol
can objectively, replayably verify exactly ONE thing about an arbiter —
**presence** (did the assigned arbiter's eligible vote land before
`substitutionEligibleAt = disputeStart + min(4h, half remaining life)`?).
**Fairness** — whether the ruling was right — is the arbiter's whole job and is
inherently subjective. A protocol that auto-slashes on "wrong" rulings is a
protocol adjudicating its own adjudicator.

**Options considered:**
- (a) **Bond in a parent escrow, redistributed to buyer/seller on a bad
      outcome** (earlier idea) — complex design for little arbiter reward, and
      it pays the wrong people: the parties were already made whole by the
      substitute. Rejected.
- (b) **Stake-per-dispute** — arbiter posts collateral when a dispute opens.
      Fatal flaw: the no-show case is precisely the case where the arbiter is
      offline, so the stake never gets posted exactly when it matters.
      Rejected.
- (c) **Standing presence bond, slash-to-cover** — locked ONCE into a k-of-n
      community-custody escrow held by the community's top-rated chamacitos
      (field-read G "senators"), reusing the same holder-only/SSS construct as
      the trade escrow. Per-dispute "earmark" is a lien recorded in Nostr
      state, not a fund move — zero live arbiter action at dispute time.
      Movement happens only on a proven no-show, and a no-show's forfeiture
      funds the SUBSTITUTE (capped call-out bonus → backup; remainder →
      community treasury), never the parties.

**Decision:** Option (c). Presence is measured by the bond; fairness is
measured by reputation/ratings + community revocation (§5) and is never
auto-slashed. On a substitution: the dispute fee (1.5%) is work-pay and routes
to the ACTING backup, not the absent primary — parties already owed it, so a
substitution costs them nothing extra. The forfeited bond is the absence
penalty: capped bonus to the backup (a full-bond jackpot would make backups
*want* primary no-shows), remainder to treasury. On small trades the bonus,
not the tiny 1.5%, is what makes standby worth staffing.

Refinements locked in from the 2026-06-07 design review:

1. **Slashing is post-hoc — no trade ever waits on bond movement.** The trade
   plane is fast and deterministic (backup eligibility replays from the event
   chain; the backup votes; the trade settles with no bond dependency). The
   bond plane is slow and human (k-of-n signatures, whenever). The presence
   proof is permanent, so the evidence is as strong next week as today. The
   backup's pay has two legs with two latencies: dispute fee rides trade
   settlement, bonus rides custodian signatures. If custodians are slow, the
   only delayed thing is the bonus and the treasury remainder — the parties
   are already whole. The liveness dependency lands on the least time-critical
   leg by construction.
2. **Custody is protocol-manual, client-automatable.** SSS shares are inert
   data; nothing executes itself — k humans' keys must act (the same reason
   vote-flip died). But a custodian's CLIENT may verify the replayable proof
   deterministically and surface one-tap co-sign, or auto-co-sign under an
   opt-in policy. The key still signs; the human delegates judgment to a
   verifier they chose. Safety does not come from the manual tap.
3. **Safety comes from a challenge window + epistemic humility.** Before any
   movement, custodians publish an intent-to-slash and wait (24–48h — free,
   since slashing is post-hoc). And state the hard truth: **absence is never
   provable in an open relay world** — only "absent from my view." A present
   arbiter's vote can be eclipsed from custodian relays; a true no-show can
   forge a *backdated* vote during the challenge window (`created_at` is
   self-asserted). A single miss is therefore never fully adjudicable — which
   is exactly why graduated, pattern-based slashing (field-read E) is not
   softness but epistemic honesty: first miss → warning + reputation ding
   (cheap if wrong); "my votes keep getting eclipsed" becomes statistically
   implausible by the third occurrence. The mechanism absorbs the epistemics.
4. **Federation binding is a rule, not a hope.** Bond, primary, backups, and
   custodians all bind to the COMMUNITY's federation — senators are top-rated
   chamacitos of that community, so they hold its fed by construction. A
   cross-fed trade (regional routing) never moves the bond; it only consumes
   presence. Two-rail payout on substitution: dispute fee in trade-settlement
   terms, bonus in bond-fed ecash. The bond inherits the community fed's
   guardian risk (long-lived ecash dies with its mint); sizing keeps that
   bounded and top-up cadence doubles as a fed liveness check.

Sizing: bond ≈ one period's expected duty earnings (disputes/period × avg
dispute fee) — a diligent arbiter earns it back before profiting (field-read
F: fidelity bond, NOT proof-of-stake). Tier-0 arbiters get low bond + low
trade-amount ceiling (field-reads C/D) so capital doesn't lock out newcomers.
Drawn-down bonds top up before new high-value assignments; an exiting arbiter
reclaims once no open assignments remain (active-commitment guard).

**Rationale:** Asks the protocol to verify only what it can verify. Keeps the
arbiter's judgment accountable to humans (ratings, revocation), not to code.
Pays the worker, punishes the absentee, and never turns either into a party
windfall or a backup jackpot.

**Implications:** Adds two invariants to DESIGN-arbiter-economy.md alongside
the existing four (presence/fairness split; post-hoc slashing). Resolves the
§3.3 "stake before each dispute" tension with the standing-bond lien. No code
changes in this entry — documentation only.

**Status:** Active (design). Implementation gated on the Ratings primitive +
signed `kind:38104` roster + community-custody escrow (Build order §1–5;
bonds remain last).

---

## 2026-06-07 — Expiry auto-refund is exploitable: a ghosting seller can keep fiat + sats

**Context:** The attack, verified in code: seller locks sats (exchange,
bill-pay, lending — the seller is the locker per `recipients.ts`) → buyer
sends fiat and votes RELEASE → seller goes silent until expiry → the protocol
refunds the locker. The seller keeps BOTH the fiat and the sats. Pure-inaction
theft, zero cost, no forged message required. Pre-expiry the performing buyer
has no path to win: `handleVote` returns `ARBITER_TOO_EARLY` unless BOTH
buyer and seller voted, so a silent seller means the arbiter can never honor
the buyer's standing RELEASE. At expiry the protocol actively pays the thief:
`maybeAutoRefundExpired` auto-votes REFUND and pooled-lock healing
(REFUND-only by invariant) finishes the job — to the locker.
DESIGN-arbiter-substitution.md already conceded the symptom: "the expiry
auto-refund, which always pays the locker regardless of who was right."

**Options considered:**
- (a) **Status quo** — correct for true abandonment (nobody performed), but
      catastrophic for one-sided performance. Unacceptable once stated.
- (b) **Auto-RELEASE at expiry when the buyer voted RELEASE** — rewards a
      lying buyer who votes without paying; violates the healing invariant
      (healing must never grant an arbitrary payout). Rejected.
- (c) **Turn one-sided performance into a contest, not an abandonment:**
      (1) suppress auto-refund and healing-REFUND when
      `votes[buyer] === RELEASE` — a standing RELEASE from the non-locker
      means someone claims to have performed; (2) relax `ARBITER_TOO_EARLY`
      so that when one side voted RELEASE and the other has been silent past
      a deadline, the arbiter MAY rule. The performing buyer gets a path to
      win against a silent seller.

**Decision:** Option (c) — designed, deliberately NOT implemented in this
round. Documentation only.

**Rationale:** The expiry default ("refund the locker") encodes "nobody
performed." A standing RELEASE vote from the non-locker falsifies that
assumption, so the default must yield to adjudication. The caveat is priced
in: a buyer could vote RELEASE without paying to force a dispute — but that
routes to the arbiter (the correct venue) and costs the lying buyer
reputation; strictly better than today's costless seller theft. The symmetric
safe case is preserved: buyer never voted (didn't pay) + seller silent →
auto-refund to the seller remains correct. Invariants preserved: healing
stays REFUND-only (it is *suppressed*, never flipped to RELEASE), and no
settled vote is ever rewritten.

**Implications:** This flaw is the strongest argument FOR the presence bond
(entry above): the only thing protecting a performing buyer from a ghosting
seller is an arbiter who shows up. It also sharpens the case for
notifications (#88) — fewer innocent no-shows make the remaining silence
legible as intent. Implementation (separate PR): `state-machine.ts`
(`ARBITER_TOO_EARLY` relaxation + healing suppression) and
`escrow-client.ts` (`maybeAutoRefundExpired` guard), with permutation tests
across all four categories × who-voted-what × expiry.

**Status:** Active — flaw acknowledged; fix designed, not yet implemented.
