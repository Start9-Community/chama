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
fast-follower release after v0.2.0 stabilizes — though most of these
may fold naturally into v0.3.0 since v0.3.0 rewrites the surfaces
they touch.

- [ ] **Recovery banner withdraw-failed UX (must-fix).** First-attempt
      Lightning withdraw on Fedi failed with generic "Payment failed"
      toast and no recovery path. Cause unknown without log
      inspection — likely federation-side mint-issuance lag,
      transient Lightning route failure, or OPFS sync race. Fix:
      catch typed failure modes (`Hash mismatch`, `Not the winner`,
      `Network timeout`, `Federation unreachable`, `Spend rejected`)
      and route to specific copy. For transient categories, surface
      "Try again" inline with 2-second debounce. For terminal
      categories, suggest next step ("Wait 30s and retry — federation
      may still be settling"). Per Pillar 2.7, recovery surfaces
      should never dead-end. Surfaced v0.2.0 smoke.

- [ ] **State B detail screen copy: Federation→Chama miss +
      verbosity.** New copy shipped in v0.2.0 still uses "federation"
      — PR A's sweep was scoped before this copy existed. Also reads
      too educational for normies. Tighten:
      - Subtitle: "Running on BLF · switched in for this trade"
      - Callout (one sentence, dismissible): "Your Chama switched
        automatically — no funds at risk."
      - CTA unchanged: "Fund trade · X currency"
      - Educational essay moves to one-time info card per pubkey
        (same pattern as first-publish honesty card). Surface once,
        dismiss forever.
      Surfaced v0.2.0 smoke.

- [ ] **Hard arbiter warning copy tighten.** Current text reads
      slightly clinical. Tighter version:
      > **A trade you're arbiting needs your vote.**
      > {npub-A} and {npub-B} disagreed on their trade.
      > Splitting your attention now could cost someone their sats.
      > Resolve theirs first.
      Surfaced v0.2.0 smoke.

- [ ] **Participant order on TradeDetail: B / A / S (Trinity Ring
      mirror).** Currently ordered B/S/A; should be B/A/S to mirror
      the Trinity Ring brand mark where arbiter sits structurally
      central (apex / 12 o'clock) and buyer/seller flank. Reinforces
      brand consistency every time the trade detail renders. Pillar
      5.2 brand-alignment fix. Surfaced v0.2.0 smoke.

- [ ] **Arbiter vote button role colors verified live.** Doctrine
      shipped in v0.2.0 — purple "Side with buyer" (#BF5AF2) and
      orange "Side with seller" (#F7931A). Confirm both render
      correctly in production trade detail. Surfaced v0.1.88 smoke.

- [ ] **DestroyEcashConfirmModal "Withdraw via Lightning" path
      verification.** Three-button flow shipped in v0.2.0; verify
      the post-withdraw auto-switch fires correctly when balance
      reaches zero. Edge case: user cancels modal mid-withdraw —
      pending switch state should drop, not fire later. Surfaced
      v0.1.88 smoke.

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

## v0.3.0 — Atomic Lifecycle

Operationalize Pillar 2.1 (Option B) — the QR-IN → QR-OUT principle.
v0.2.0 still ships FundWalletModal with arbitrary funding, which
violates the BOLT11-IN-at-fund → ecash-only-during-LOCK→CLAIM →
BOLT11-OUT-at-claim trade lifecycle. Pure Option B never shows a
balance not currently committed to a specific trade.

- [ ] **Listing-tap → BOLT11 invoice for exact trade amount.** No
      wallet preload step. Tap Fund → invoice generated for the trade
      amount → user pays from external Lightning wallet → ecash mints
      directly into the LOCK → trade enters LOCKED state. The invoice
      *is* the funding moment.

- [ ] **LNURL-first claim UX with hierarchy of affordances.**
      Three-tier surface at claim time:
      - **Primary (tap-saved-destination):** if user has a saved
        Lightning Address or LNURL in their handles list, render as
        one-tap row at the top. "Send to jetty@phoenix.app" with
        affirmation that this is the easy path.
      - **Secondary (LN address input):** field with placeholder
        `you@yourwallet.app` and a "Save for next time" toggle
        defaulting ON. Auto-saves on first claim. Second trade has
        a saved destination already populated.
      - **Tertiary (BOLT11 paste):** hidden behind "More options" or
        "Advanced" disclosure. Available for power users, edge cases,
        and BOLT11-only wallets. Doesn't compete for attention.
      The "Save for next time" toggle is itself the educational moment
      per Pillar 2.7 — user reads it, understands implicitly that
      future trades will be faster. Settings is for *managing* handles
      (rename, remove, mark default), not for *adding the first one*.
      First add happens organically in the claim flow.

- [ ] **Inverted same flow at QR-IN (fund time) for senders.** The
      buyer's funding step also benefits from saved destinations on
      the sender side — though the asymmetry is real (Lightning
      Addresses receive, BOLT11 invoices the user pastes for funding
      come from Chama itself). The hierarchy applies wherever the
      user is providing a destination.

- [ ] **Claim → BOLT11 OUT at claim time.** No claim-to-wallet step.
      User pastes/scans BOLT11 invoice (or LN address) at claim time
      → ecash reconstructs from shares → federation redeems →
      Lightning routes to destination → OPFS drains. Single tap.

- [ ] **FundWalletModal → Sandbox-only.** Move the modal out of the
      normal-user surface and into Settings → Advanced → Sandbox.
      Power users testing the app keep access; production users
      never see arbitrary funding.

- [ ] **Recovery banner = failure-mode surface only.** Pure Option B
      means balance > 0 between trades is *always* a failure state
      (interrupted trade, half-finished claim). Recovery banner
      copy shifts from "you have unspent sats" to "your last trade
      didn't finish — sweep these sats."

- [ ] **Auto-sweep detection at QR-OUT.** If OPFS balance > trade
      amount when winner reaches QR-OUT (i.e., orphans + dust from
      previous failed trades), offer "Sweep everything ({total} sats)
      instead?" — drains all orphans and the trade amount in one move.
      Per PHILOSOPHY.md §State 6, this was already filed for v1.1; in
      pure Option B it becomes the canonical claim flow.

- [ ] **EcashProvider interface.** Abstract the bearer-cash backend
      behind an interface so future Cashu support is non-invasive.
      v1 ships only Fedimint; design the seam now to accommodate
      additional providers without making it a v1 blocker.

---

## v0.3.1 — chama.community Lightning Address service

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

- [ ] **Auto-sweep CTA at QR-OUT.** If pure Option B (v0.3.0) didn't
      already make this canonical, finalize here.

- [ ] **NWC as IN/OUT adapter.** Power-user opt-in for Nostr Wallet
      Connect at fund and claim time, replacing the LN Address /
      BOLT11 UX with a programmatic path. Follows the Phase 2 of the
      pluggable Lightning interface laid out in the original brief.

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
