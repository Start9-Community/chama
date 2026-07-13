# Chama Backlog

Living document. Items surface from smoke testing, design sessions, OSS
contribution work, and operational reality. The primary goal is now an
integrity-first v1: a product that is correct, private, recoverable, and
worth trusting. Conference demos are useful forcing functions, not the
roadmap's center of gravity.

Items move between sections as priorities shift. Adding an item is cheap;
removing one without addressing it requires a note in
[DECISIONS.md](DECISIONS.md).

---

**Reading this doc:** shipped work is folded into collapsible `✅ Shipped` blocks
(expand to see the history); `- [ ]` = open, `- [x]` = done. The quick "what's on the
table" is right here:

## 🔜 Now / Next — open work at a glance

**Recently completed (folded out of this glance — see sections below):**
bond commitment LIVE on **mainnet** (v5.0, ceremony open to all, 2-of-3 vestige deleted,
bonded arbiters seat + read green) · picker/Me/Dashboard **liveness signal** (kind-38135 +
`LivenessSignal`; "Live" tier removed) · **Strike USD** claim picker (username →
@strike.me + Cash-tab how-to) · **Lending**
retired from Create/landing/splash (Work/Chip In/Stack shown as Soon).

- 🔥 **Private community federations over Nostr** (encrypted `#p`-scoped fed invite; the
  "ultra-private chamas" + recruitment on-ramp; cross-fed lockdown LOCKED). HIGH — Jetty's pick.
  (`chama-private-community-feds-brief.md`; DECISIONS 2026-07-03.)
- **Bond track remainder:** flip `BONDS_ENFORCED` (2B part 2 / #47) + real-world bond adoption.
- **Work** + **Chip In** (CPS) + **Stack** (savings) — engines not built yet (splash/Create
  cards are honest "Soon" only; DECISIONS 2026-07-01/03).
- **Notifications grand finale** + `Rail.settlement` reversibility (Current Priority below).
- Deeper open queues: **Product Expansion · Later Protocol Work · OSS Contributions ·
  Investigation Queue · Field-test asks** — each still has open `- [ ]` items.

---

## Current Priority

These are the highest-leverage items after consolidating the old v0.4.x
candidate list with the older roadmap.

<details>
<summary>✅ <b>Shipped — 17 completed items</b> (click to expand the history)</summary>

- [x] **LN addresses are payout destinations, not payment handles.**
      Counterparty handles (Wave, Zelle, Revtag, Orange Money, etc.)
      are shared with trade participants so fiat can move. Self-payout
      Lightning Addresses are private receive destinations for claim and
      recovery flows. Split them into `chama_payout_destinations`, migrate
      old `LIGHTNING_RAIL` entries out of `chama_saved_handles`, and make
      Me display them under "Payout destinations." Landed in the
      post-v0.6.2 wave.

- [x] **PROD_ENCRYPTION flip.** Flip the production encryption flag and
      verify NIP-44 works end-to-end across seeded communities before v1.

- [x] **getchama.app / app.getchama.app migration.** Retire
      `chama.satoshimarket.app`, update deploy targets and Capacitor
      metadata, and keep a 301 redirect from the old host for a grace
      window. Marketing metadata has started moving, but deploy/release
      targets still need the full migration before recording durable
      walkthroughs.

- [x] **Per-npub localStorage for user-scoped state.** `chama_active_invite`,
      `chama_community`, saved handles, payout destinations, and similar
      identity-scoped state should not bleed between npubs on shared
      browsers. Refactor toward `chama_<key>_<pubkey>` storage, with
      migration from legacy global keys.

      Landed after v0.7.0: active invite, custom invite, home Chama,
      saved handles, payout destinations, ChapSmart payout profile,
      pending redemption stash, and Create drafts now read/write through
      the active pubkey scope. First-run onboarding can still write before
      a signer is known; the first connected pubkey claims that legacy
      value and removes the global key so the next user does not inherit it.

- [x] **Soften v0.1.74 seed-safety error red-on-refresh.** A transient
      relay zero-event response can still read like a critical funds alert.
      Add a longer recovery timeout, "still connecting" intermediate state,
      and retry/backoff before escalating to red.

- [x] **Browse boot flash for completed/cancelled trades.** During replay,
      user's own terminal trades can briefly surface in Browse before the
      full chain catches up. Browse should render only open listings by
      other users; terminal user trades belong in Me/history.

- [x] **15-minute join reservation before lock.** When a buyer or seller
      joins a CREATED trade, reserve that role for 15 minutes while they
      lock/fund. If no LOCK lands before the reservation expires, free the
      role again so another user can join. Auto-assigned arbiters are not
      reservations and must not start this timer. This needs protocol-level
      convergence, not just local Browse filtering: clients must agree on
      join time, stale role handling, and the event shape for cleanup or
      replacement.

      Landed after the Fedi milestone: buyer/seller JOINs now carry
      `holdExpiresAt`, replay treats expired holds as replaceable, cards
      show the compact lock window, and TradeDetail surfaces the live
      lock-window countdown.

- [x] **Sim manual-fund + Recovery Banner collision.** In sim mode, manual
      fund can create a recoverable balance with no active trade, triggering
      the production recovery banner. Either remove manual fund from sim
      mode or suppress the banner for intentional sim-only manual balances.

      Fixed (Phase 1): both recovery alarms now take a `simModeOn` gate that
      defaults falsy (production byte-identical). `shouldShowRecoveryBanner`
      early-returns false; `decideChamaBarLabel` skips its "stranded → ⚠
      Recover" pill (falls through to "ready") — the other label states and
      priority ordering are untouched. Both call sites pass sim mode, so on
      an intentional sim manual-fund balance neither the full-screen banner
      nor the header pill fires. The Me-tab "SATS RECOVERY" card is left as-is
      by design: the fix targets the false *interrupting alarms*, not every
      recovery surface. That card is a calm, true wallet affordance (and sim's
      only recover/payout demo path), so gating it would over-apply the fix.

- [x] **Sim funding modal timer cleanup.** Dismissing the funding modal
      repeatedly can leave old auto-credit timers alive in sim mode. Cancel
      timers on modal dismissal/cleanup.

- [x] **APK rebuild + Zapstore listing.** Rebuild and list after the core
      product surface is stable enough to invite non-developer testers.

- [x] **Remove browser-default blue button glow.** Smoke testing surfaced a
      blue focus/halo behind buttons on Android and desktop. Replace it with
      a subtle Chama focus treatment (amber or role-colored, accessibility-safe)
      so the app does not leak native/browser button styling.

      Landed in v2.5 globalCss: `-webkit-tap-highlight-color:transparent`
      kills the native tap glow; mouse/touch focus drops the outline via
      `:focus(:not(:focus-visible))`, and keyboard nav keeps an
      accessibility-safe amber `:focus-visible` outline.

- [x] **v0.7.0 onboarding + NWC foundation.** Next product push: make first-run feel
      intentional instead of discovered by wandering. Guide a new user
      through Nostr signer connection, community choice, the built-in
      Fedimint wallet, payment handles, payout destinations, and the basic
      escrow lifecycle without turning the app into a marketing page.

      v0.7.0 shipped the first-impression shell, country-first Chama
      picker, friendlier key ceremony, East/West/Central Africa coverage,
      Tanzania/TZS defaults, Chapsmart payout scaffolding, phone formatting,
      and safer vote-turn UI. NWC remains a power-user follow-up after the
      Chapsmart contract is confirmed.

      Source: 2026-05-19 release planning after v0.6.5.

- [x] **Pre-warm Fund flow on TradeDetail mount.** First-fire on a fundable
      CREATED listing has the AtomicFundingModal sitting on its
      CreatingInvoice spinner for a noticeable beat while the Fedimint WASM
      client and federation cold-start. v0.6.5 hid the worst symptom (the
      "Locking…" button label bleed-through, now mitigated by a heavier
      backdrop and an honest "Funding…" label), but the underlying delay
      needed warming. TradeDetail now quietly calls the same idempotent
      federation probe path when the expected locker opens a CREATED
      listing, so the WASM worker, federation handshake, and health probe
      are warmed before Fund. Smoke-session source: 2026-05-19 cold-start
      glitch report.

- [x] **Turn-gated vote buttons by category (v0.7.0).** Buyer/seller
      vote buttons are now UI-gated by category via
      `decideVotePrompt(state, pubkey)`: exactly one happy-path actor
      is prompted before the first vote, then the counterparty unlocks.
      Protocol remains unchanged — the state machine still accepts
      buyer/seller votes in any order.

      - **P2P trade**: buyer-first (buyer sends fiat → votes RELEASE
        first → seller's RELEASE button unlocks). Buyer is the actor
        who has to physically move money out-of-band.
      - **Bill Pay**: buyer-first (same logic — buyer pays the bill,
        seller confirms receipt at the utility).
      - **Lending**: buyer-first (follows P2P pattern; lender disburses
        first, borrower acknowledges).
      - **Marketplace**: seller-first (seller ships → votes RELEASE
        first → buyer's RELEASE unlocks on delivery).

      Second voter UI before first vote: **vote buttons fully hidden**,
      replaced with "Waiting on buyer to confirm payment sent" /
      "Waiting on seller to ship" copy. Chat stays available — that's
      where the clarification happens. After the first user votes,
      the second user's buttons appear.

      Arbiter: NO buttons until disagreement (buyer and seller voted
      differently). Arbiter can still see chat and uploaded images
      throughout — they're observer-only until the dispute path
      triggers. Image upload for chat is a separate prerequisite —
      see sub-item below.

      Source: 2026-05-19 design session; implemented during v0.7.0
      prep.

- [x] **Chat image upload + viewer (prerequisite for dispute polish).**
      Buyer and seller need to be able to share receipts, screenshots,
      and proof-of-payment images in trade chat. Arbiter needs to view
      them during dispute resolution.

      First pass landed after v0.7.0: chat bodies now travel inside a
      buyer/seller/arbiter encrypted envelope, receipt images are
      compressed client-side before send, thumbnails render inline, and
      tap-to-expand opens a private viewer. The current transport keeps
      the compressed image inline in the encrypted CHAT body; Blossom or
      NIP-94-backed blobs remain the scale-up path if relay event-size
      pressure shows up.

- [x] **US fiat off-ramp via a fiat-converting Lightning Address (Strike
      flagship).** **[✅ DONE — module + claim picker.]** Existing Strike users
      type their username; Chama completes `<username>@strike.me` and pays that
      LUD-16 address from the claim (`StrikeUsdPicker` in ClaimPayoutModal).
      Guided how-to: Account → Bitcoin settings → Receive currency → Cash, plus
      an explicit confirmation before send so dollars land in Strike's cash
      balance. Paste-path via payout destinations still works.
      Fast-follow siblings (Bitcoin Well, Cash App invoice) remain open on the
      same seam. Source: 2026-06-26 design session; claim picker 2026-07-10.

</details>

### Open — the actual current priority

- [ ] **Notifications grand finale.** Treat notifications as a major final
      polish layer, not a tiny toast sweep. Users need to know when a trade
      needs action, when sats are locked, when the counterparty voted, when
      an arbiter is needed, when claim/payout/recovery needs attention, and
      when a funding invoice is about to expire. Design this privacy-first:
      opt-in browser/native push, minimal lock-screen text, local in-app
      notification center, and graceful fallback when push is unavailable.
      Target after onboarding/NWC and dispute polish are shaped.

      **Progress (2026-06-25, not the finale):** app-side firing + cold-start
      catch-up + diagnosable Tauri IPC landed (`notify-service.ts`);
      on-device confirmed the app fires correctly — macOS buzz silence is
      signing/identity, not app logic. Remaining = the full polish layer
      above (center, opt-in push, invoice-expiry alerts, etc.).

- [ ] **`Rail.settlement` reversibility field — chargeback-aware payment rails.**
      The `Rail` interface (`rail-registry.ts:23`) models privacy
      (`allowPublicHandle`) but **not finality** — so reversible rails (PayPal
      `:467`, Venmo `:474`) sit beside irreversible ones (Zelle, wire, mobile
      money) with no signal. Chama's escrow protects only the **Bitcoin** leg:
      on a reversible fiat rail a scam buyer can pay → ecash releases (trade
      "completes" correctly) → buyer files a PayPal/Venmo dispute (~180-day
      window) → fiat clawed back → the seller eats it, and escrow can't help
      because the protocol did its job. Classic LocalBitcoins/Paxful PayPal scam.

      - Add `settlement?: "irreversible" | "reversible" | "unknown"` to `Rail`;
        tag the registry (Zelle / wire / mobile money / instant-push tags =
        irreversible; PayPal / Venmo + card-funded Cash App = reversible;
        default `unknown`).
      - **Warn at trade time** when the selected rail is `reversible`, aimed at
        the BTC *seller*: "⚠ PayPal can be reversed by the buyer for ~180 days —
        prefer Zelle/cash for selling." De-rank (or gate behind a confirm)
        reversible rails for the sell-BTC direction; never silently block — some
        users knowingly accept the risk.
      - Same field can **rank the off-ramp / payout picker** and the US-first
        rail order — one concept, two payoffs.

      Source: 2026-06-26 review (PayPal found live in `rail-registry.ts:467`
      with no finality gate).

---

## Scratched Off

Completed or already moved out of the immediate backlog by the current
codebase. Keep these here briefly so the consolidation has memory.

<details>
<summary>✅ <b>Scratched / shipped — 8 items</b> (click to expand)</summary>

- [x] **v0.3.0 atomic lifecycle surfaces.** `AtomicFundingModal`,
      `DestinationPicker`, claim-and-payout, recovery payout, destroy
      recovery, ChamaBar states, and claim bridge error surfacing are all
      in production code and covered by escrow-engine tests.

- [x] **NIP-46 demoted from primary sign-in.** The signer-app path now
      lives under "More sign-in options" and is desktop-only. Reliability
      testing remains in the investigation queue before any promotion.

- [x] **Release script package-version ordering.** `scripts/release.sh`
      runs typecheck/test/build on a clean tree before bumping, rebuilds
      after the bump so deployed assets embed the tagged app version,
      commits only package metadata, then tags and pushes the release.

- [x] **Trusted arbiter pool foundation.** `src/arbiters/pool.ts` reads
      configured arbiters, Create includes community arbiter pools, and
      LOCK validation enforces selected arbiters against the pool. Arbiter
      dashboard and open availability events remain later trust work.

- [x] **Round-robin arbiter selection from the community pool.** v0.6.5
      replaces the `communityArbiters[0]` always-pick with
      `pickArbiterFromPool()` keyed by escrow id — deterministic, idempotent
      on relay replay, and spreads load across the trusted pool without
      requiring server-side state.

- [x] **Relax one-trade-at-a-time gate to one-funding-operation-at-a-time.**
      v0.6.5 removes the hard Create + Fund block on active trades.
      Sellers can serve multiple buyers, buyers can browse for the next
      trade while a previous one is in LOCKED/voting/approved state. The
      only remaining gate is `fundingInProgress`, which protects the
      shared OPFS wallet from concurrent `spendNotes` calls. ChamaBar
      pill and ActiveTradePill are now plural-aware ("3 active trades ·
      150k sats in escrow"). Recovery banner narrowed: suppressed while
      the fund-and-lock or claim-and-payout flows are mid-flight, since
      those flows own the transient balance.

- [x] **Lightning Address subsection in Me.** The old saved-handles
      subsection is now a separate Payout destinations panel backed by
      `chama_payout_destinations`.

- [x] **Mandatory phone-number payment handle.** Phone number is now a
      universal, locked-private rail with a visible quick-add section in
      Payment handles for mobile-money-first users.

</details>

---

## Product Expansion

- [x] **Menu primitive.** Add optional menu items to listings, snapshot
      selected items into trades, build buyer basket UI, and add seller
      menu-builder controls in Create. This unlocks marketplace menus,
      Bill Pay fee menus, lending terms, and raw escrow fee tiers without
      changing the escrow envelope.

- [x] **Me dashboard for sellers and arbiters.** Split Me into operational
      queues instead of treating Browse banners as a dashboard. Sellers get
      menu/listing inventory, incoming orders, lock-window holds, locked
      trades, votes, claims, and history. Official community arbiters see
      an arbiter-only dashboard when their npub appears in a configured
      arbiter pool: assigned disputes, vote-needed trades, inactivity
      signals, and settlement history. Hidden for non-arbiters.

- [x] **Live-chama liveness signal (picker + Me + Dashboard).** **[✅ DONE
      2026-07-05/07.]** Chama liveness = funded+active bonded arbiters ×
      commitment × trade-verified ratings (`computeChamaLiveness` + kind
      38135 announce). `LivenessSignal` on Me / Dashboard / country-detail;
      list shows "🛡 N bonded"; hardcoded "⚡ Live now" tier removed.
      Prefer-bonded seating staged (2B); `BONDS_ENFORCED` flip still open.

- [ ] **Persistent storefront listings with child orders.** Menu listings
      should stay open until the seller edits or deletes them, across
      Exchange, Community Bill Pay, Marketplace, and Lending. Buyer checkout
      should create a child order/escrow snapshot so sold inventory settles
      without consuming or hiding the parent storefront. Seller dashboards
      manage quantities, availability, and paused/deleted state.

- [x] **Cut the Lending vertical** (DECISIONS 2026-07-01). **[✅ DONE 2026-07-05/07 —
      user-facing cut.]** Escrow solves simultaneous-exchange trust, not
      future-promise trust. Lending retired from Create picker, onboarding
      splash, and landing (`#36`); Work / Chip In / Stack occupy the slot as
      honest "Soon" cards. The `"lending"` Vertical + logic stay in code for
      back-compat of any existing lending listings (not a live create path).
      Full code deletion / v3 community-internal door = later cleanup if wanted.

- [ ] **"Work" vertical (replaces Lending).** Services/labor as a first-class
      category, named simply **Work**: small discrete jobs (fix / build / tutor
      / translate / deliver). Poster funds escrow → worker submits proof →
      poster releases (arbiter on dispute). Reuses the escrow envelope +
      reputation + arbiter wholesale; the escrow IS the repayment-recourse
      lending never had. Scope = small jobs only, not recruiting/large offers.
      Likely an elevation/positioning of existing service/commission surfaces,
      not a new engine. (DECISIONS 2026-07-01.)

- [ ] **Chip In (CPS / Community Pool Sats)** — the "chama" unlock. >1 npub pool sats
      toward ONE fixed, transparent destination (merchant/store LUD-16 or a
      specific address), released on goal / refunded all-or-nothing on miss
      (Kickstarter-shaped, deadline-bounded → short escrow, Fedimint-friendly;
      each donor an independent escrow, so it avoids the savings-ROSCA's
      dynamic-membership complexity). The **destination-lock** is the unlock:
      earmarked purpose, can't redirect to the requester → purposed remittance,
      not begging. Reuses the LUD-16 payout rail + escrow + ratings. It is
      lending's INTENT via escrow's STRENGTH. Reverse-lending anti-abuse:
      requester pre-locks a % (skin-in-the-game), ratings + receipt
      confirmation, tier caps. ⚠ Design FIRST: **destination collusion**
      (sock-puppet merchant) → require verified merchant destinations + donor
      receipt confirmation + caps; also sybil/farming resistance + the
      fund-safety-grade all-or-nothing refund path. (DECISIONS 2026-07-01.)
      - **Reverse-lending tier model (front-% by trust — Jetty 2026-07-01):**
        newbie fronts **≥60%** of the bill to a VERIFIED destination; medium
        (good ratings, repeat, registered store) **50%**; OG (excellent ratings)
        **30%** — ALL tiers pay a verified merchant. **Vetting oracle = reuse
        others' solutions:** bootstrap on offramp merchant registration (e.g.
        `pay.chapsmart.com` — registration is a real process = a vetting signal,
        and the payout lands in a KYC'd mobile-money account = accountability),
        evolving to Chama-native merchant reputation (a fulfilled-order track
        record). The **merchant is the THIRD stakeholder** (their registration +
        rating), so collusion needs a registered merchant willing to burn their
        account — that's what actually closes the collusion hole. A
        merchant-landing-page-as-free-bond is a fine low-friction extra layer,
        weak alone (a scammer can make a cheap page) → defense-in-depth, not the
        gate.
      - **De-risk via a capped pilot (validate before betting):** one community,
        verified-merchant destinations only, tiny caps, instrumented; define
        kill/keep metrics UP FRONT (e.g. "60 days: ≥N genuine requests funded by
        ≥M distinct donors, <X% collusion attempts") to dodge the lending
        sunk-cost trap. Cheap to be wrong (escrow refunds donors all-or-nothing;
        caps bound scams; no user funds lost if unused). **Base demand is the
        mundane universal case** — a group splitting/pooling ONE bill (restaurant,
        family need), done in cash / fragmented mobile money today; stranger-help
        is the viral upside, not the whole thesis. Merchant-rail (single-payer) is
        the lower-risk proven-demand hedge under it.

- [ ] **Stack (group savings).** The
      "chama" made literal, and the SIBLING to CPS: friends each keep sats in
      their OWN ecash and see each other's *progress* read-only (NIP-44
      encrypted, opt-in), then graduate on-chain privately via the peg-out rail
      when the stack is meaningful. ⭐ **Individual custody + social visibility —
      NOT a pooled pot** (that's CPS): personal stacks side-by-side with a shared
      window, so it never inherits CPS's shared-mutable-custody complexity.
      Escrow-ethos-clean: nobody holds anyone else's money → no future-promise
      trust (the line that killed Lending). Reuses ecash + NIP-44 + peg-out +
      (naturally) a private community fed as the container. Guardrails: share
      progress/streak not raw balance; opt-in per-person; small-sats framing;
      chat skipped/optional; same app not a separate repo; POST-launch.
      (DECISIONS 2026-07-03.)

- [ ] **`user@chama.community` Lightning Address service.** Optional,
      self-hostable LNURL-pay resolver backed by the user's own Chama
      instance, with explicit opt-in and uptime/privacy copy.

- [ ] **Arbiter public dashboard.** Surface per-arbiter stats on their
profile: trades assigned, disputes handled, outcome breakdown,
inactivity periods, and any community revocations. Reputation is the
real collateral; make it legible. Read-only v1 surface; no UI work
until election events exist.

- [ ] **Recurring payments unlock.** Reveal subscription listings only for
      graduated sellers (`canOfferSubscription`, 5+ / 0). The escrow spine is
      built + tested (SUBSCRIBE / PERIOD_RELEASE / `handleSubscribe` in
      escrow-client + state-machine); the cited Ratings-primitive blocker is
      **CLEARED** (kind:38123 shipped 2026-06-08 — `canOfferSubscription` now
      reads real data). Remaining = UI only: a Create-subscription form behind
      the gate, a period-release surface, a subscription card in TradeView, and
      wiring extension kinds 38109-38110. **Field-validated 2026-06-27** by the
      first trader (asked for it unprompted). Model = prepaid-and-released, NOT
      open-ended Patreon — frame as renewable fixed terms. See DECISIONS
      2026-06-27 for the three-way split + the open-ended/NWC deferral.

- [ ] **On-request / commission listings.** The first trader's "on-request
      beats / commission artwork" case = repeat one-off *commissions*, distinct
      from subscriptions. Mostly reuses the existing Marketplace **service**
      fulfillment type ("Service rendered") + buyer↔seller chat delivery
      (Blossom upload already exists for Exchange); the new bits are a
      buyer-initiated "request" framing (Bill Pay already proves inverted
      initiation) and storefront-per-npub (below) so a buyer can re-commission.
      Lightest of the three threads — near-zero new protocol. Provenance: first
      trader, 2026-06-27.

- [x] **Ratings primitive (core — unblocks graduation).** **[✅ PRIMITIVE SHIPPED — `src/reputation/ratings.ts` + kind:38123 (RatingTap/MeScreen/TradeDetail), DECISIONS 2026-06-08. The #73 CONSUMERS — tiered assignment, arbiter dashboard, amount caps — remain, tracked in the arbiter-economy build.]** Implement the actual
      per-counterparty rating capture + aggregation that `canOfferSubscription`
      and graduated-seller features already assume (5 positive / 0 negative =
      graduated). Natural capture point: the post-claim / complete screen, where
      the off-ramp also wants to live (see docs/DESIGN-7 + the bridge/off-ramp
      notes). Prerequisite for recurring payments, graduated capabilities, and
      the parked external-rail re-enable. The Me dashboard already shows the
      "No ratings yet" placeholder. Provenance: user ask, field testing.

- [ ] **Bill Pay subscriptions for graduated bitcoiners.** Convenience
      layer for recurring family bills; one-shot Bill Pay remains enough
      for v1.

- [ ] **Trinity Ring progressive completion animation.** Reusable ring
      state across Create preview, listing/active cards, TradeDetail, and
      completed trade view.

- [ ] **Storefront per npub.** Group open listings by seller with kind:0
      metadata as a shopfront header.

- [x] **Fiat-secondary display.** Sat-primary listings with currency-aware
      fiat estimates and Browse filters. Use production feedback, not a
      conference deadline, to choose which fiat displays matter first.

---

## Later Protocol Work

- [ ] **EcashProvider interface.** Abstract the bearer-cash backend once a
      second provider is concrete enough to shape the interface.

- [x] **NWC advanced wallet automation.** After the v0.7.0 NWC foundation,
      evaluate deeper NWC flows beyond basic fund/claim: recurring payments,
      saved permissions, policy limits, and richer wallet capability checks.

- [ ] Community arbiter election via kind:38104. Each community elects
its own arbiter pool through availability events. Replaces the v1
hardcoded BLF_OFFICIAL_ARBITERS bootstrap. Same random-assignment
layer underneath — only the pool source changes. Wire after v1 ships
and real Nairobi usage shows who the natural arbiters are.

- [ ] Arbiter key separation enforcement at community tenure level.
v1 enforces uniqueness per-trade (DUPLICATE_PARTICIPANT). v2
target: an npub elected as arbiter for a community is blocked from
opening buyer/seller trades in that same community while holding
arbiter status. Requires arbiter-status tracking per community slug.
Civilian key + arbiter key must stay separate; the protocol should
enforce what the design already requires.

- [ ] Arbiter incentive economics. **[DESIGN LOCKED — tips for presence + flat dispute fee, `DESIGN-arbiter-economy.md` §5; BUILD rides the bond lane.]** Dispute-triggered flat fee, not a
percentage of trade value on every assignment. Exact amounts are
a post-v1 empirical question — let Nairobi usage show what arbiters
actually do before pricing it. Structure is locked: duty pays, not
power. "Arbiter was needed" flag goes on the public trade receipt.

- [x] Arbiter healing powers. SHIPPED with the v2.1 arbiter-substitution
release (2026-06-05): the field revealed the actual failure mode — a
1-1 disputed trade expiring while the assigned arbiter is absent left
sats in limbo, because the expiry-heal rescue vote could only come
from the one participant who hadn't voted (the absent arbiter itself).
Now: the assigned arbiter auto-heals on load (v2.0.x behavior, kept),
and on pooled-share locks ANY pool backup heals too — REFUND only
(INVALID_HEAL_OUTCOME enforced by the reducer), no grace floor, slot
converged by deterministic priority, backup clients auto-heal on load.
Bounded exactly as this item demanded: healing can only ever route the
refund to the engine-computed recipient — never an arbitrary payout,
never a vote flip (vote immutability is permanent policy; any future
exception requires Chamacito community-consensus voting, see ratings).
Lending repayment timers still get their own pass with that vertical.

- [ ] Arbiter opt-in and availability signals. Elected arbiters can
publish kind:38104 events marking themselves unavailable for
certain trade types, amounts, or time windows. Combined with
election events, creates a real community political economy where
arbiters compete on service record, not just name recognition.

- [ ] **Self-reveal gesture for testimonials.** Let users opt into
      publishing individual ratings as testimonials.

- [ ] **NIP draft for cross-client rating adoption.** Propose only after
      Chama has real rating data and clear interoperability pressure.

- [ ] **Cashu provider.** Opt-in v2 provider if/when EcashProvider exists
      and users explicitly prefer Cashu's trust model.

- [ ] **Subscription extension kinds 38109-38110.** Already designed; wire
      when subscription mode unlocks for graduated merchants.

- [ ] **UTXOracle integration.** Exchange-free BTC/USD from on-chain UTXO
      patterns. Philosophically aligned, operationally expensive.

---

## OSS Contributions

Independent of Chama versioning. File when natural breaks appear.

- [ ] **Fedimint SDK canary regression matrix during UniFFI transition.**
      Track canary hashes against BP, BLF, Afribit, and browser/Fedi
      surfaces. Report regressions with package versions, federation,
      browser, and console/network logs.

- [ ] **Fedimint browser meta / Manage Meta access report.** Capture the
      v0.6.5 BLF gateway-vetting debugging trail for the Fedimint team.
      In the browser SDK, `get_config` can advertise a `meta` module at
      instance id `4`, but `rpcSingle("meta", "get_consensus_value",
      { key: 0 })` and `rpcSingle("4", "get_consensus_value", { key: 0 })`
      can both fail with `module not found`. Chama now treats this as a
      browser-SDK access gap and uses a tiny federation-scoped fallback only
      for BLF's known Fedi gateway.

      Suggested upstream asks:

      - Document when wallet clients should address modules by kind
        (`"meta"`) versus instance id (`"4"`), especially from browser WASM.
      - Provide a stable typed helper for reading guardian Manage Meta /
        `vetted_gateways` from wallet clients.
      - Clarify that `vetted_gateways` lives inside the default meta value
        at `MetaKey(0)`, not as a direct meta key.
      - Document the browser serialization shape for `MetaValue` (JSON
        string, hex-encoded JSON, byte-array JSON, or object wrapper).
      - Expose a receive-safe gateway trust bit in `listGateways`, or explain
        why a gateway can be guardian-vetted while the SDK reports
        `vetted=false`.
      - Add a browser canary test where a federation advertises `meta` in
        config and a wallet client successfully reads Manage Meta through
        the public SDK surface.

- [ ] **OPFS resilience PR for `@fedimint/transport-web`.** Draft `PR.md`
      exists. Chama runs this fix in production since v0.1.11. File first
      as the small fast-yes upstream contribution.

- [ ] **RFC for `@fedimint/transport-node`.** Draft `RFC.md` exists with
      open questions. File second after OPFS lands.

- [ ] **Iroh-WebSocket browser asymmetry note.** Document the browser
      asymmetry Chama already surfaces through `BrowserSupportBanner`.

- [ ] **Native browser iroh transport.** Long-horizon Rust/WASM upstream
      work to solve `browserReliable: false` universally. Start after v1
      and real production failure modes have shaped the design.

---

## Investigation Queue

Move these into a target section once the shape is clear.

- [ ] **NIP-46 signer app reliability and promotion test.** Test at least
      two signer implementations, relay behavior on
      `wss://relay.satoshimarket.app`, NIP-44 support, timeout/retry copy,
      and session restoration before promoting it.

- [x] **Multi-relay loadEscrow over-eager pruning.** v0.1.88 smoke caught
      a "Removed broken escrow from saved list" warning during chain
      replay. Escalate if it reproduces.

- [x] **OPFS-bound-to-previous-npub orphan ecash detection.** Detect and
      surface the case where npub A leaves ecash in browser OPFS and npub
      B logs into the same browser.

- [ ] **Vite warning about dynamic imports.** `sdk-adapter.ts` and
      `mock-wallet.ts` are dynamically imported by `fedimint-client.ts`
      but statically imported by `fedimint/index.ts`; verify this is only
      chunking noise.

- [ ] **`index-*.js` chunk over 500kB warning.** Code-splitting candidates:
      QRScanner, future charting libraries, and the Fedimint WASM blob.

---

## Field-test asks (post-v1.2.12, from APK / Tauri / browser smoke)

- [x] **#1 — US rails lead for US-leaning Chamas.** When the selected *Chama*
      (not the federation) is GBF (`us-gbf`), Global USD (`us-blf`), or
      `global-usd`, Create's payment picker now leads with Strike, Cash App
      ($cashtag), Zelle, and bank transfer — US users almost certainly want
      these. Pure rail-registry ranking rule (`railCommunityRank`); every other
      community unaffected. Shipped v1.2.13.

- [ ] **#2 — Landscape / desktop two-sided views → folded into #9.** Make the
      desktop view equal a mobile *landscape* view. In landscape, split two-up
      (info left, info right) to use the extra real estate for trade detail +
      settings visibility. Browse, Create, and Me each get their own distinct
      two-sided layout. Pure UI/UX; sized with #9 landscape.

- [x] **#3 — Create-form fiat toggle broken ON TAURI ONLY.** **[✅ SHIPPED — Tauri HTTP-plugin routing in `market-fetch.ts` + creator-currency `shouldQuoteEstimatedFiat` suppression, DECISIONS 2026-06-06.]** APK and browser
      toggle sats↔fiat correctly during Create; Tauri shows only sats for the
      "BTC" amount entered (e.g. "BTC 12"). The BTC/USD median price itself
      works on Tauri, so it's the toggle / currency-selector state, not the rate
      fetch — investigate localized to the Tauri webview. PRODUCT DIRECTION
      recorded alongside: a bill-pay / fiat listing should be priced and shown
      in the **creator's own Chama currency** for everyone — hardcode it so a
      lurker from another Chama sees the creator's currency (what the creator
      expects to receive), not a converted estimate in their own. This would
      SUPPRESS the viewer-currency "≈" estimate (added v1.2.8) for these
      listings — write the call in DECISIONS.md before coding it.

- [ ] **#4 — Suggest + match payment methods before lock.** If a buyer (before
      joining) or the locker has no saved payment method, prompt them to add one
      instead of the generic "waiting…" copy — for BOTH buyer and seller — and
      LITERALLY MATCH them on a shared rail so the two sides agree on how the
      fiat moves. Lock-flow UX.

- [x] **Ghost / un-surfacing trades from a broken-state era.** (v1.2.14) A
      handful of trades (2-3) made while the app/bridge was in a broken state
      surface for one participant (the seller) but NOT the other — the buyer
      npub never sees it. Root cause: the escrow event chain reached too few
      relays during the outage (or some events live only in one participant's
      local cache), so the buyer's subscription can't discover or fully replay
      it. `loadEscrow(id)` + `LoadTradeInput` can recover IF the events are on
      the current relays. Shipped the durable fix: `EscrowClient.rebroadcastEscrow(id)`
      merges the cached raw chain (`rawEvents`) with the replayed `state.eventChain`,
      deduped by id, and best-effort re-publishes every event to today's relay
      set (a single relay rejection can't abort the heal). Surfaced as
      "↻ RE-BROADCAST / HEAL THIS TRADE" in TradeDetail's Advanced event-chain
      panel; any participant who can see the trade heals it for the others. Plus
      a "FORGET THIS TRADE LOCALLY" escape hatch (`forgetEscrow` → drops saved
      pointer + hides from list, money stays in escrow, re-loadable by ID) for
      unrecoverable ghosts. +11 tests. Provenance: user field report.
  - [x] **v1.2.15 follow-up — the heal/forget didn't actually work on-device.**
        Field report: Forget "frozen, doesn't trigger anything"; re-broadcast
        "doesn't fix it." Two root causes, both fixed: (1) `window.confirm()` is
        a NO-OP in the Tauri/Capacitor webview, so the confirm-gated Forget
        never fired — replaced with an inline two-tap confirm (and the same
        broken pattern on seller "Delete listing" → two-tap toast confirm).
        (2) Re-broadcast publishes to relays, but the counterparty's client has
        NOTHING subscribed to discover a never-seen trade (no `#p` participant
        feed; events carry no `#p` tag; the notifier only sends), so the events
        sat on relays unseen. Fixed the UX to complete the heal: on success it
        now surfaces the trade ID + a Copy button + "send this to the other
        party so they can Load it," and surfaces publish failures (0 relays /
        nothing cached) instead of a vague success line. `forgetEscrow` now also
        `unwatchEscrow`s so a late event can't re-add a dismissed ghost.
        (3) Forget didn't PERSIST across a restart — dropping the saved pointer
        wasn't enough because the Browse/public-listings feed re-delivers every
        trade's public CREATE through `updateEscrow`, silently re-adding the
        ghost on the next reload. Fixed with a persistent per-pubkey
        forgotten-ids denylist (`chama_forgotten_ids:<npub>`) that `updateEscrow`
        honors; loading the trade by ID clears it (deliberate un-forget). So a
        forget now sticks across restart + sign-out/in on the SAME device.
        Caveats (by design): a full localStorage wipe clears the denylist, and
        forget is LOCAL — it doesn't propagate to other devices (to remove a
        listing everywhere, the seller Cancels/Deletes it, which publishes a
        cancel event).
  - [ ] **Auto-discovery so re-broadcast self-heals (no manual ID share).** The
        proper long-term fix: tag escrow CREATEs with `#p` for each participant,
        run `subscribeToParticipant(myPubkey)` on connect (already exists in
        relay-manager, never called), and on re-broadcast publish a FRESH
        `#p`-tagged pointer (new timestamp, so it isn't excluded by Browse's
        `since` window) → the counterparty's participant feed auto-loads the
        trade. Would heal even old ghosts (the pointer is new). Deferred from
        v1.2.15 — needs its own design + tests, beyond the hotfix.
  - [x] **Remaining `window.confirm` / `window.alert` sites.** **[✅ DONE v2.5 — converted to inline / two-tap; only explanatory comments remain, no live calls.]** Same webview
        no-op class: `CreateForm.tsx` photo-type `window.alert` → convert to an
        inline error. Audit for any others before they bite.

---

## Process Notes

- Items move out of this file via commit messages. When a backlog item is
  addressed, remove or check it in the same diff that ships the fix.
- New items get provenance: smoke session, build, user report, design
  session, or upstream issue. Provenance keeps future prioritization sane.
- Architectural decisions belong in [DECISIONS.md](DECISIONS.md), not here.
  If an item's fix requires a design choice, write the decision first.
