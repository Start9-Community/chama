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

Surfaced from v0.1.88 smoke testing and v0.2.0 build. Targeted as the
fast-follower release after v0.2.0 stabilizes.

- [ ] **Arbiter vote button role colors verified live.** Doctrine
      shipped in v0.2.0 — purple "Side with buyer" (#BF5AF2) and
      orange "Side with seller" (#F7931A). Confirm both render
      correctly in production trade detail. Surfaced v0.1.88 smoke.

- [ ] **DestroyEcashConfirmModal "Withdraw via Lightning" path
      verification.** Three-button flow shipped in v0.2.0; verify
      the post-withdraw auto-switch fires correctly when balance
      reaches zero. Edge case: user cancels modal mid-withdraw — pending
      switch state should drop, not fire later. Surfaced v0.1.88 smoke.

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

- [ ] **Multi-relay `loadEscrow` over-eager pruning investigation.**
      v0.1.88 smoke caught a "Removed broken escrow from saved list"
      warning during chain replay. May be pruning healthy trades that
      are briefly inconsistent across relays during fetch. Inspect
      pruning logic; soften if needed. Don't touch in v0.2.0 or v0.3.0.

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

## v1 (pre-Adopting Bitcoin Nairobi)

The v1 launch surface. Federation-follows-listing, atomic lifecycle,
and three-tab navigation are the load-bearing pieces. Nairobi demo
content lives here.

- [ ] **PROD_ENCRYPTION flip.** Unblocked by PR 5 (federation
      switching wired in v0.1.85+). Flip the flag and verify NIP-44
      encryption works end-to-end across all five communities.

- [ ] **`chama.community` as canonical public surface.** A record →
      existing VPS, new nginx vhost. `chama.exchange` → 301 redirect
      to `chama.community`, reserved for institutional / LN address
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

---

## Investigation queue (no version target)

Items that need inspection before they can be scoped. Move to a
version target once the shape is clear.

- [ ] **Multi-relay loadEscrow over-eager pruning.** See v0.2.1. May
      reveal a deeper issue; if so, escalate to v0.2.1 must-fix.

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
