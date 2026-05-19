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

## Current Priority

These are the highest-leverage items after consolidating the old v0.4.x
candidate list with the older roadmap.

- [x] **LN addresses are payout destinations, not payment handles.**
      Counterparty handles (Wave, Zelle, Revtag, Orange Money, etc.)
      are shared with trade participants so fiat can move. Self-payout
      Lightning Addresses are private receive destinations for claim and
      recovery flows. Split them into `chama_payout_destinations`, migrate
      old `LIGHTNING_RAIL` entries out of `chama_saved_handles`, and make
      Me display them under "Payout destinations." Landed in the
      post-v0.6.2 wave.

- [ ] **PROD_ENCRYPTION flip.** Flip the production encryption flag and
      verify NIP-44 works end-to-end across seeded communities before v1.

- [ ] **getchama.app / app.getchama.app migration.** Retire
      `chama.satoshimarket.app`, update deploy targets and Capacitor
      metadata, and keep a 301 redirect from the old host for a grace
      window. Marketing metadata has started moving, but deploy/release
      targets still need the full migration before recording durable
      walkthroughs.

- [ ] **Per-npub localStorage for user-scoped state.** `chama_active_invite`,
      `chama_community`, saved handles, payout destinations, and similar
      identity-scoped state should not bleed between npubs on shared
      browsers. Refactor toward `chama_<key>_<pubkey>` storage, with
      migration from legacy global keys. Some scoped sentinels have landed,
      but the main identity-bound stores are still global.

- [x] **Soften v0.1.74 seed-safety error red-on-refresh.** A transient
      relay zero-event response can still read like a critical funds alert.
      Add a longer recovery timeout, "still connecting" intermediate state,
      and retry/backoff before escalating to red.

- [x] **Browse boot flash for completed/cancelled trades.** During replay,
      user's own terminal trades can briefly surface in Browse before the
      full chain catches up. Browse should render only open listings by
      other users; terminal user trades belong in Me/history.

- [ ] **Sim manual-fund + Recovery Banner collision.** In sim mode, manual
      fund can create a recoverable balance with no active trade, triggering
      the production recovery banner. Either remove manual fund from sim
      mode or suppress the banner for intentional sim-only manual balances.

- [x] **Sim funding modal timer cleanup.** Dismissing the funding modal
      repeatedly can leave old auto-credit timers alive in sim mode. Cancel
      timers on modal dismissal/cleanup.

- [ ] **APK rebuild + Zapstore listing.** Rebuild and list after the core
      product surface is stable enough to invite non-developer testers.

---

## Scratched Off

Completed or already moved out of the immediate backlog by the current
codebase. Keep these here briefly so the consolidation has memory.

- [x] **v0.3.0 atomic lifecycle surfaces.** `AtomicFundingModal`,
      `DestinationPicker`, claim-and-payout, recovery payout, destroy
      recovery, ChamaBar states, and claim bridge error surfacing are all
      in production code and covered by escrow-engine tests.

- [x] **NIP-46 demoted from primary sign-in.** The signer-app path now
      lives under "More sign-in options" and is desktop-only. Reliability
      testing remains in the investigation queue before any promotion.

- [x] **Release script package-version ordering.** `scripts/release.sh`
      bumps `package.json` before typecheck/test/build, commits after the
      gates, then tags and pushes the bumped version.

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

---

## Product Expansion

- [ ] **Menu primitive.** Add optional menu items to listings, snapshot
      selected items into trades, build buyer basket UI, and add seller
      menu-builder controls in Create. This unlocks marketplace menus,
      Bill Pay fee menus, lending terms, and raw escrow fee tiers without
      changing the escrow envelope.

- [ ] **`user@chama.community` Lightning Address service.** Optional,
      self-hostable LNURL-pay resolver backed by the user's own Chama
      instance, with explicit opt-in and uptime/privacy copy.

- [ ] **Manual arbiter selection.** Surface arbiter stats and let sellers
      choose from a graduated pool with backup assignment so a missing
      arbiter cannot deadlock a trade. v0.6.5 round-robin pool selection
      is the automatic default; manual override remains the graduated-
      seller affordance.

- [ ] **Recurring payments unlock.** Reveal subscription listings only for
      graduated sellers once aggregate ratings are populated.

- [ ] **Bill Pay subscriptions for graduated bitcoiners.** Convenience
      layer for recurring family bills; one-shot Bill Pay remains enough
      for v1.

- [ ] **Trinity Ring progressive completion animation.** Reusable ring
      state across Create preview, listing/active cards, TradeDetail, and
      completed trade view.

- [ ] **Storefront per npub.** Group open listings by seller with kind:0
      metadata as a shopfront header.

- [ ] **Fiat-secondary display.** Sat-primary listings with currency-aware
      fiat estimates and Browse filters. Use production feedback, not a
      conference deadline, to choose which fiat displays matter first.

---

## Later Protocol Work

- [ ] **EcashProvider interface.** Abstract the bearer-cash backend once a
      second provider is concrete enough to shape the interface.

- [ ] **NWC as IN/OUT adapter.** Power-user option for fund and claim,
      bypassing LN Address / BOLT11 paste where a connected wallet can
      programmatically pay or receive.

- [ ] **Arbiter healing powers.** Bounded stale-trade repair without
      consensus, especially for lending repayment timelines.

- [ ] **Open arbiter pool with kind:38104 availability events.** Community
      elected, self-published availability, reputation-aware.

- [ ] **Arbiter incentive economics.** Decide fee model after real usage
      shows what arbiters actually do and where the work is.

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

- [ ] **Multi-relay loadEscrow over-eager pruning.** v0.1.88 smoke caught
      a "Removed broken escrow from saved list" warning during chain
      replay. Escalate if it reproduces.

- [ ] **OPFS-bound-to-previous-npub orphan ecash detection.** Detect and
      surface the case where npub A leaves ecash in browser OPFS and npub
      B logs into the same browser.

- [ ] **Vite warning about dynamic imports.** `sdk-adapter.ts` and
      `mock-wallet.ts` are dynamically imported by `fedimint-client.ts`
      but statically imported by `fedimint/index.ts`; verify this is only
      chunking noise.

- [ ] **`index-*.js` chunk over 500kB warning.** Code-splitting candidates:
      QRScanner, future charting libraries, and the Fedimint WASM blob.

---

## Process Notes

- Items move out of this file via commit messages. When a backlog item is
  addressed, remove or check it in the same diff that ships the fix.
- New items get provenance: smoke session, build, user report, design
  session, or upstream issue. Provenance keeps future prioritization sane.
- Architectural decisions belong in [DECISIONS.md](DECISIONS.md), not here.
  If an item's fix requires a design choice, write the decision first.
