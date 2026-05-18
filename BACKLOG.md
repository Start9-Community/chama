# Chama Backlog

Living document. Items surface from smoke testing, design sessions, OSS
contribution work, and operational reality. Each item lists the version
that surfaced it and a sentence of context. When a release ships, the
commit message references which items got addressed.

Items move from one section to another as priorities shift. Adding an
item is cheap; removing one without addressing it requires a note in
[DECISIONS.md](DECISIONS.md).

---

## v0.2.1 — polish + edge cases

Surfaced from v0.1.88 + v0.2.0 smoke testing. Targeted as the
fast-follower release after v0.2.0 stabilizes. Most of v0.2.1's
original list folded into v0.3.0 because v0.3.0 rewrote the surfaces
those items touched (recovery banner, destroy modal, State B copy,
Trinity Ring order, arbiter warning copy). What remains is genuinely
v0.2.1 polish that v0.3.0 didn't subsume.

- [ ] **Arbiter vote button role colors verified live.** Doctrine
      shipped in v0.2.0 — purple "Side with buyer" (#BF5AF2) and
      orange "Side with seller" (#F7931A). Confirm both render
      correctly in production trade detail. Surfaced v0.1.88 smoke.

- [ ] **Soften v0.1.74 seed-safety error red-on-refresh.** Fires red
      every refresh when Nostr relay momentarily returns zero events
      (timing race). Funds safe but UX reads as critical alert. Fix:
      longer recovery timeout + "still connecting" intermediate state,
      retry-with-backoff before escalating, or info-color until N
      retries fail. Filed v0.1.85.

- [ ] **kind:0 fetcher for `displayCounterpartyName`.** Pure helper
      shipped in v0.1.87 with `kind0Name: null` default. Wire the
      relay-fetch + cache so counterparty names render when the
      counterparty has self-published a kind:0 with a name field
      AND the local user has opted into the toggle.

- [ ] **Subscription mode reveal.** `canOfferSubscription` returns
      false universally in v0.2.0. Wire it to read aggregate ratings
      once they're populated; threshold per PHILOSOPHY.md §State 8
      (5+ positive, 0 negative) is v1 placeholder.

- [ ] **First-publish honesty card opt-out.** `chama_first_publish_done_<pubkey>`
      currently never re-shows. Consider a Settings → "Show me the
      info card again" reset for users who want to re-read the
      "runs on X" educational paragraph.

---

## v0.3.x — observability (no scheduled release)

Items filed as "watch for it in production, act if reality says so."
Not actionable on a release timeline; surfaced from v0.3.0 development
or smoke testing where the right answer is "let production tell us."

- [ ] **Fedimint LN gateway fee tuning.** v0.3.0 ships fundAndLock
      with no mint-margin (exact amount + 90% threshold tolerance). If
      production smoke testing or Nairobi data shows measured
      shortfalls (federation receives less than invoice amount due to
      gateway fee passthrough), add a configurable mint-margin. Filed
      as observable, not actionable. Surfaced from v0.3.0 Phase 2.

---

## v0.3.2 — chama.community Lightning Address service

Originally planned as v0.4.0; renumbered to v0.3.2 after v0.3.0
production smoke caught a hard claim hang on Bitcoin Principles (the
default federation — 3 of 4 guardians dead, mint operations couldn't
complete). v0.4.0 became the fix release: surface bridge errors
honestly (claim-bridge-threw terminal), cold-boot federation probe
gate, Trinity Ring drift on TradeCard, Lightning Address subsection
in the saved-handles panel. This section's items shift one slot.

Optional self-hostable Lightning Address service backed by the user's
own Chama instance. Opt-in surface in Settings.

- [ ] **`user@chama.community` Lightning Address resolver.** Standard
      LNURL-pay resolver that maps `user@chama.community` to the
      user's Chama instance and generates a BOLT11 invoice on-the-fly
      backed by their connected federation. Self-sovereign Lightning
      Address that doesn't require a custodial provider.

- [ ] **Opt-in flow in Settings.** Users explicitly enable the
      service for their npub. Disabled by default. Educational copy
      explains the privacy and uptime tradeoffs (your Chama instance
      must be reachable for incoming Lightning to resolve).

- [ ] **Sovereign Start9 / Umbrel deployment story.** Once a user
      hosts their own Chama on Start9 or Umbrel, the
      `user@chama.community` resolver points to their sovereign
      instance directly. Reference deployment at
      `sovereign.chama.community` post-v1.

---

## v0.4.0 — Menu primitive (vertical-agnostic)

Generalization of multi-item listings across all five Chama
verticals. Trigger came from wife's marketplace feedback;
cross-vertical generalization positions Chama as a decentralized,
self-custodial BTCPayServer alternative. The escrow envelope is
unchanged — single trade, single LOCK, single CLAIM. Only the
listing schema and create-trade UX expand.

- [ ] **Schema: optional `items: MenuItem[]` on listings.** A
      `MenuItem` has `id`, `label`, `amount_sats`, optional
      `quantity_max`, optional `description`. If `items` is absent,
      the listing is a fixed-price single-item listing (today's
      behavior). If `items` is present, the buyer composes a basket.

- [ ] **Trade snapshot: `selected_items: SelectedItem[]`.** When
      buyer creates a trade against a menu listing, the trade carries
      the basket selection. Sum of selected items becomes the
      `amount_sats` of the escrow. Listing snapshot in the trade
      includes the line-itemized description so the seller and
      arbiter see exactly what was ordered.

- [ ] **Buyer-side basket UI in Browse → Listing detail.** Quantity
      steppers per item, running total, "Order" CTA that creates the
      trade with the basket payload. Empty-basket state, basket-clear
      affordance, basket-modify affordance pre-create.

- [ ] **Seller-side menu builder in Create wizard.** New step in the
      Create flow when the seller chooses to publish a menu listing.
      Add/remove items, set per-item amounts, set per-item
      quantity caps, reorder. Save-draft applies to menu listings
      same as fixed-price.

- [ ] **Vertical-specific applications:**
  - **P2P Exchange:** liquidity provider lists multiple FX flavors
    in one listing (USD→BTC at 0.4%, EUR→BTC at 0.5%, in-person
    only at different rate)
  - **Marketplace:** sats.coffee's whole menu, motorbike repair
    SKUs, tailor's shirt/pants/suit pricing in one listing
  - **Bill Pay:** volunteer offering "I'll pay your KPLC bill 2%,
    DStv 3%, school fees 1.5%" all in one listing
  - **Community Lending:** lender lists "30-day up to 100k at X%,
    60-day up to 250k at Y%, 90-day up to 500k at Z%" in one
    listing
  - **Raw Escrow:** arbiter offering "I'll arbitrate up to 500k for
    fee A, up to 2M for fee B, up to 10M for fee C"

- [ ] **Seller dashboard for menu listings.** Per-item view counts,
      orders received per item, "your most-ordered item" surface.
      Power-user analytic that helps sellers refine their menu.

---

## v1 (pre-Adopting Bitcoin Nairobi)

The v1 launch surface. Federation-follows-listing, atomic lifecycle,
and three-tab navigation are the load-bearing pieces. Nairobi demo
content lives here.

- [ ] **PROD_ENCRYPTION flip.** Unblocked by PR 5 (federation
      switching wired in v0.1.85+). Flip the flag and verify NIP-44
      encryption works end-to-end across all five communities.

- [ ] **chama.community landing page** — replaces
      satoshimarket.app/chama. Build after v0.3.0 ships (atomic
      lifecycle is the operational story the page needs to tell).
      4-6 weeks before June Nairobi target. Path A (static,
      hand-coded, Tailwind) preferred. Hero = Trinity Ring +
      animated trade flow showing pure QR-IN → escrow → QR-OUT.
      Cypherpunk-first aesthetic per PHILOSOPHY.md §5. Brand pack
      assets in /mnt/project/ are ready. Testimonials captured
      opportunistically pre-launch — Mafintosh feedback on copy is
      noted; alexlwn123 quote welcome if offered; sats.coffee
      design-partner moment can ship as testimonial.
      Domain: `chama.community` as canonical (A record → existing
      VPS, new nginx vhost). `chama.exchange` → 301 redirect to
      `chama.community`, reserved for institutional / LN address
      suffix use.

- [ ] **APK rebuild + Zapstore listing.** Once v0.3.0 atomic lifecycle
      is stable. Capacitor bundle should already work; Zapstore needs
      the listing.

- [ ] **Nairobi demo plan.** Sample Bill Pay listings (sats.coffee
      style), prepared seller npubs with reputation seeded, M-Pesa
      conversion moment as the demo's emotional climax.

---

## v1.5 — graduated trust + visual polish

- [ ] **Manual arbiter selection.** Surface arbiter stats; let
      sellers choose. Required: graduated arbiter pool with backup
      assignment so a chosen-but-unavailable arbiter doesn't deadlock
      the trade.

- [ ] **Recurring payments unlock.** Subscription primitive opens for
      sellers who've graduated via positive-rating reputation.
      sats.coffee is the design partner.

- [ ] **Bill Pay subscriptions for graduated bitcoiners.** Family-utility
      use case — recurring monthly Bill Pay listings (e.g., paying
      mom's electric bill from sats every month). Convenience polish;
      one-shot listings already work at v1.

- [ ] **Lightning routing visualization.** At fund-time (BOLT11 paid →
      mint complete) and claim-time (SSS reconstruct → BOLT11
      redeemed). Animated, brand-aligned, optional skip.

- [ ] **Globe community picker.** Replaces list-style picker for
      first-signin and switching. 3D globe with flag pins.

- [ ] **Trinity Ring rendering polish in TradeDetail.** Closed ring
      with role-color arcs at varying opacity to show participant
      vote states. Brand-product alignment moment per PHILOSOPHY.md
      §5.1.

- [ ] **Auto-sweep CTA at QR-OUT.** If a winner reaches QR-OUT with
      OPFS balance > trade amount (orphans + dust from previous failed
      trades), offer "Sweep everything ({total} sats) instead?" Was
      filed under v0.3.0 originally; deferred from v0.3.0 because real
      orphan-accumulation frequency wasn't yet observable. Decide
      after Nairobi smoke produces empirical orphan-accumulation data.

- [ ] **EcashProvider interface.** Abstract the bearer-cash backend
      behind an interface so future Cashu support is non-invasive.
      Was filed under v0.3.0 originally; deferred because designing
      the abstraction without a second concrete provider in hand
      risks over-engineering. Revisit when Cashu becomes a concrete
      need (v2's Cashu provider item depends on this interface
      shipping). Surfaced from v0.3.0 scope-trim.

- [ ] **NWC as IN/OUT adapter.** Power-user opt-in for Nostr Wallet
      Connect at fund and claim time, replacing the LN Address /
      BOLT11 UX with a programmatic path. v0.3.0's
      AtomicFundingModal + DestinationPicker lay the structural
      foundation: NWC adds a "use connected wallet" branch that
      bypasses the BOLT11-paste tier on both sides. Follows the
      Phase 2 of the pluggable Lightning interface laid out in the
      original brief.

---

## v2 — protocol expansion

- [ ] **Arbiter healing powers.** Ability to act on stale trades
      without consensus. Essential for Lending repayment which has
      no server-side timer.

- [ ] **Self-reveal gesture for testimonials.** Per State 5 rating
      visibility model — let users opt-in to publish individual
      ratings as testimonials.

- [ ] **NIP draft for cross-client rating adoption.** Let ratings
      flow to other Nostr clients organically. Don't pre-empt;
      propose only after we have real data.

- [ ] **Cashu provider (if EcashProvider interface ships in v0.3.0).**
      Single-operator model is incompatible with v1 trust positioning,
      but v2 can offer it as an opt-in for users who prefer the model.

- [ ] **Subscription extension kinds 38109–38110.** Already designed,
      not in production. Wire when subscription mode unlocks for
      graduated merchants in v1.5.

---

## OSS contributions (Fedimint upstream)

Independent of Chama versioning. File when natural breaks appear.

- [ ] **Fedimint SDK canary regression matrix during UniFFI transition.**
      Track canary hashes against BP, BLF, Afribit, and the Chama
      browser/Fedi surfaces. Upstream issue #288 confirmed the team is
      moving from `wasm-pack` to UniFFI-based builds and explicitly
      values downstream canary coverage. File regressions with exact
      package versions, federation, browser, and console/network logs.

- [ ] **OPFS resilience PR for `@fedimint/transport-web`.** Draft
      `PR.md` exists. Chama runs this fix in production since v0.1.11.
      File first as small fast-yes. Primary contact: alexlwn123.

- [ ] **RFC for `@fedimint/transport-node`.** Draft `RFC.md` exists
      with 5 open questions. File second after OPFS lands.

- [ ] **Iroh-WebSocket browser asymmetry note.** Issue/note, not PR.
      Chama's `BrowserSupportBanner` honesty acknowledges this — the
      upstream issue should document the asymmetry for other
      browser-first builders.

- [ ] **Native browser iroh transport (post-v1 only).** Long-horizon
      Rust + WASM contribution to Fedimint and iroh upstream. Would
      solve `browserReliable: false` universally. Likely path:
      WebTransport over HTTP/3 (QUIC) where supported, WebRTC data
      channels as fallback, WebSocket as universal floor. Months of
      work; DO NOT start before v1 ships and Adopting Bitcoin Nairobi
      has produced empirical reliability data. Real failure modes from
      production must inform the design, not imagined requirements.
      Target window: post-Nairobi, v1.5 or v2 timeframe. Captured here
      as a serious commitment, not deprioritized.

---

## Investigation queue (no version target)

Items that need inspection before they can be scoped. Move to a
version target once the shape is clear.

- [ ] **NIP-46 signer app reliability and promotion test.** The button
      now lives under More sign-in options and is desktop-only. Before
      promoting it to the primary desktop private-login path, test
      Amber/nsecBunker or equivalent signer apps, relay behavior on
      `wss://relay.satoshimarket.app`, NIP-44 support, timeout/retry
      copy, and session restoration.

- [ ] **Multi-relay loadEscrow over-eager pruning.** v0.1.88 smoke
      caught a "Removed broken escrow from saved list" warning during
      chain replay. May reveal a deeper issue; if so, escalate to
      v0.2.1 must-fix. Otherwise low priority.

- [ ] **OPFS-bound-to-previous-npub orphan ecash detection.** If npub A
      leaves ecash in browser OPFS and npub B logs in same browser,
      the seed in OPFS won't decrypt with B's NIP-44 key. Detectable;
      surfaceable. Filed as `DestroyEcashConfirmModal` drift path 4
      if it surfaces in real testing.

- [ ] **Vite warning about dynamic imports.** `sdk-adapter.ts` and
      `mock-wallet.ts` are dynamically imported by `fedimint-client.ts`
      but also statically imported by `fedimint/index.ts` — chunking
      not optimal. Likely cosmetic; verify no behavioral impact.

- [ ] **`index-*.js` chunk over 500kB warning.** Bundle size noted in
      every build. Code-splitting candidates: QRScanner (already
      split), Plotly/D3 if/when added, the WASM blob itself. Chrome's
      cold-start TTI vs APK behavior may differ; test both.

---

## Process notes

- Items move out of this file via commit messages. When v0.2.1 ships,
  any v0.2.1 items addressed get checked off in the same PR's commit
  message and removed from this file in the same diff.
- New items get added with their surfacing context — "v0.1.88 smoke,"
  "v0.2.0 build," "Samuel test session," etc. Provenance helps
  prioritize and helps future-you understand why something was filed.
- Architectural decisions (not just task items) belong in
  [DECISIONS.md](DECISIONS.md), not here. If an item's "fix" requires
  a design choice you haven't yet made, write the decision first.

---

## LN addresses are payout destinations, not handles (v0.4.3 or v0.5.0)

Currently `saved_handles` storage conflates two categories:
- Counterparty handles (Wave, Zelle, Revtag, Orange Money) — given to a counterparty so they can send fiat
- Self-payout LN addresses — destinations for receiving sats during CLAIM

These are different concepts that share UI surface. The handle-reveal 
dropdown during LOCK currently exposes LN addresses to counterparties, 
which is wrong — counterparties don't need to know where the user 
chooses to receive their sats.

Required changes:
1. New `chama_payout_destinations` localStorage store for LN addresses
2. Migration from `saved_handles` LIGHTNING_RAIL entries
3. Remove LN entries from trade-flow handle-reveal dropdown
4. New section in Me → Settings: "Payout destinations" with LN addresses
5. Claim flow saves new LN address to payout destinations, NOT to saved handles

Pillar 2.5 (clarity of intent), and protects user privacy 
(counterparties don't learn user's LN address from trade flow).

---

## Backlog: Browse view briefly shows completed trades during boot. 

When user signs in and saved-escrows loads from Nostr, completed trades appear in Browse for ~1s before being filtered out. Expected: only OPEN/LOCKED trades by other users appear in Browse. The user's own completed trades should NEVER appear in Browse, they belong in Me → trade history. Filter chain needs to also exclude COMPLETED/CANCELLED states from Browse rendering, not just sim/non-sim tagging.

---

## v0.4.3 candidates

1. **getchama.app migration.** Retire chama.satoshimarket.app from URL. 
   DNS A-record for app.getchama.app → 89.147.108.68. SSL via Let's Encrypt. 
   Update release.sh TARGET_HOST. Update Capacitor manifest. 301 redirect 
   from old subdomain for ~6 months. Estimated 2-4 hours including DNS 
   propagation. Do BEFORE recording marketing videos longer-term.

2. **LN-addresses-as-payout-destinations, not handles.** Currently 
   saved_handles conflates counterparty handles (Wave, Zelle, Revtag, etc.) 
   with self-payout LN addresses. Wrong category. Migration: new 
   `chama_payout_destinations` localStorage store keyed by pubkey. 
   Remove LN entries from trade-flow handle-reveal dropdown. Move LN 
   saved-addresses to Me → Settings → Payout Destinations section.

3. **Per-npub localStorage for user-scoped state.** chama_active_invite, 
   chama_community, saved_handles all keyed by browser, not pubkey. 
   Fresh npubs inherit previous npub's state on shared machines. Refactor 
   to consistently key by pubkey prefix: chama_<key>_<npub>.

4. **Manual-fund + Recovery Banner collision in sim mode.** When sim user 
   manually funds via Settings → Advanced → Open manual fund, balance > 0 
   + no active trade triggers Recovery Banner. Fix: either remove manual 
   fund affordance from sim mode entirely (auto-credit via createInvoice 
   is sufficient), or suppress Recovery Banner when sim mode + 
   manual-funded-balance.

5. **Release.sh package.json bump ordering bug.** Tags commit but doesn't 
   bump package.json (or follow-up commit reverts it). Caused version 
   pill drift since v0.3.0. Fix: bump package.json BEFORE building, 
   commit bump, THEN tag, THEN build with bumped version.

## v0.4.4+ candidates

6. **Browse view briefly shows user's completed/cancelled trades on boot.** 
   ~1s flash before filter takes effect. Filter chain needs to exclude 
   user-as-participant on COMPLETED/CANCELLED states from Browse rendering. 
   User's own completed trades belong only in Me → trade history.

7. **Sim mode: 2M sats race condition when user dismisses funding modal 
   multiple times.** Auto-credit timers from prior dismissed invoices 
   not always cancelled cleanly. Edge case. Add timer-cancel-on-modal-dismiss 
   handler in AtomicFundingModal cleanup.

8. **Fiat display (mempool.space + open.er-api.com).** Sat-primary, 
   fiat-secondary listings. Currency-aware Browse filter. Backlog for after 
   Nairobi feedback informs which fiat displays are most needed.

## v0.5.0+ candidates

9. **Trusted arbiter pool.** Hardcoded TRUSTED_ARBITERS array 
   (Chapsmart, Graysatoshi, Bitcrazy + Jetty fallback) at src/arbiters/pool.ts. 
   Auto-assign random-from-pool on LOCK. Arbiter Dashboard in Me tab. 
   Demo-ready before Nairobi.

10. **Trinity Ring progressive completion animation.** Each role color 
    fills in as participant joins. Same Trinity Ring geometry (220,220 
    center, r=150, stroke 52). Triggered on JOIN events: 1 color at 
    first JOIN, 2 at second, all 3 + complete ring at LOCK. Reusable 
    across CREATE preview, LOCK preview, Active Trade card, completed 
    trade view. Replaces static three-glyph row currently in Participants 
    section. Never built — we've shipped 80+ versions with static rings.

11. **Storefront per npub.** Group all OPEN listings by seller npub. 
    Render as coherent shopfront with kind:0 metadata as header. 
    Buyer browses stores instead of listings. Converges v0.4.0 menu 
    primitive + npub identity + kind:0 profile. "Store window" metaphor 
    — depth and personality, not flat tiles.

## v1+ candidates  

12. **Bisq-vs-Chama blog post / marketing one-liner.** "What happened 
    to Bisq this week cannot happen to Chama. Here's why." Architectural 
    differentiator. Trusted update channel attack surface vs. 2-of-3 
    SSS attack surface. Write while Bisq incident is fresh.

13. **Open arbiter pool with kind:38104 availability events.** 
    Community-elected, not hardcoded. Self-publishing availability. 
    Reputation tracking. v1.5.

14. **Arbiter incentive economics design.** Flat fee per trade vs. 
    percentage vs. tiered. Pay-regardless-of-outcome (honesty bonus) 
    vs. pay-on-resolution-only. Needs Nairobi data first.

15. **UTXOracle integration.** Exchange-free BTC/USD from on-chain 
    UTXO patterns. Requires self-run Bitcoin Core full node. 
    Philosophically perfect, operationally expensive. Defer to v1.5+.

16. **Native browser iroh transport contribution upstream.** Fixes 
    the root cause of sim mode's existence. Months of Rust+WASM work. 
    Do not start before v1 ships. Real Nairobi user data should 
    precede design. v1.5/v2 commitment.
