# Chama — Store Permanence Brief (#49, gated by #52)

**Status:** DECISIONS FROZEN 2026-07-12 (Jetty: "I would love #1 and #3"). Not built. Client-only
pass, no reducer/consensus/money-path touch. Candidate for v5.1 (feels like it belongs) or v5.2.
**Frame:** #49 (store-permanence) built in the #52 shape (gate privileges on the BOND, never on
ratings/trade-counts). Companion item: single-listing photo upload (stores need a shopfront image).

## What prompted this
Stores are quietly asking to be first-class: a single Stores listing already carries a **stock
quantity picker**, yet a listing dies at settle or expiry (default 24h) — there's no "store that
survives a completed trade." A seller who finishes trade #1 and turns to trade #2 may find the
listing already lapsed, or the next buyer gone. We want a store to *persist* so the next buyer can
walk up, while keeping the "one focused trade at a time" guidance that suits go-slow global-south
sellers.

## The real constraint (why listings are short today) — traced, not vibes
- A listing's lifetime is `expirySeconds` in the CREATE payload (default 24h; dev override already
  clamps to [5 min, 30 days] — `useEscrow.ts:1695`). The protocol already accepts a 7-day listing.
- **The catch:** `expirySeconds` double-books as the **trade timeout**. At LOCK,
  `expiresAt = lockedAt + tradeTimeoutSeconds` where `tradeTimeoutSeconds = expirySeconds`
  (`state-machine.ts:884`). So a 7-day listing means a buyer's **locked sats sit up to 7 days**
  before the expiry auto-refund. That coupling — protecting locked funds, NOT the browse feed — is
  the real reason listings are kept short. This is the "how long do we let funds sit locked before
  heal/arbiter?" question, and it's why we do NOT just crank `expirySeconds` up.
- One CREATE = one escrow = one buyer. A "store" today is just a menu listing that dies at settle.

## Decision: ship Tier 1 + Tier 3, defer Tier 2

### Tier 1 — Renewable listings (client-only, easy) — BUILD
A **Renew** action (and auto-renew while the seller's client is alive) that re-publishes an identical
CREATE with a fresh expiry when the old one lapses unfunded. Zero reducer/consensus/fund-safety
touch. The durable trade-index already remembers expired listings, so a **"Your store lapsed —
renew?"** card is natural. This alone kills the pain new sellers hit.
- **Auto-renew requires the seller's client online — DECIDED YES.** It doubles as a liveness signal;
  a store whose owner has vanished *should* lapse. No server-side renewal.

### Tier 3 — Bond-gated tenure (mostly free, #52 rule) — BUILD
Permanence is a privilege anchored to the **bond**, never to ratings/trade-counts:
- **Bonded npub** (chain-verified kind-38135, bond ≥ a floor) → longer, auto-renewed store tenure
  (e.g. 7-day renewable).
- **Unbonded** → 24h default, manual renew only.
`fetchCommunityBonds` + esplora-verify already exist and are already wired into CreateForm for
arbiter seating — reusing them as a listing-duration gate is a small pure check. Sybil-proof (costs
real locked sats), unfarmable (no trade-count gate). Narrative symmetry with E1: the bond is an
earnings license AND a storefront license.

### Tier 2 — Decouple listing-TTL from trade-timeout (consensus change) — DEFER
An additive CREATE field (`listingTtlSeconds` separate from `tradeTimeoutSeconds`) so a listing can
live 7 days while any individual locked trade still times out in ~24h. Same additive class as
`bondedArbiters`, BUT old clients ignoring the field derive a different `expiresAt` → chain
divergence, so per consensus-release discipline it's its **own coordinated release**. Cheap now
(~no users), expensive later. **If Tier 1 works, we may never need it** — a renewable 24h listing
gives store persistence WITHOUT ever letting locked funds sit longer than 24h. Revisit only if
renewal friction proves real.

⚠ **Load-bearing consequence of deferring Tier 2:** because `expirySeconds` still double-books as
the trade timeout, Tier 1's renewable listings stay on the **24h** timeout — which is exactly what
we want (locked funds never sit >24h before heal/arbiter). Tier 1 gives persistence via *renewal*,
not via *longer locks*. That's the clean answer to Jetty's constraint: the store persists, the
individual trade's lock does not.

## The seller-focus / next-order question (Jetty's concern) — resolved by Tier 1
"Can a seller handle multiple orders at once from one listing?" — by design Chama routes the seller
to the ONE accepted trade and guides them to its goal; that focus is a feature, not a limit. The gap
was only: when they finish, is the listing still there for the next buyer? Tier 1 answers it — the
store auto-renews (while the seller's online) so the next buyer always finds an open shopfront,
without inviting concurrent-order chaos. One focused trade at a time, but the store never disappears
between them.

## Companion item — single-listing photo upload (stores need a shopfront)
Today photo upload exists only on **multi-item** (shipped-items) listings, not on a **single** Stores
listing — so a one-item store can't show the thing before it ships. Add the existing image-upload
affordance to the single-listing path (reuse the multi-item uploader component + storage/encoding
already in place). Buyer-protection value: "see something before it ships." Scope with Tier 1/3 or
as its own small pass. NOTE: confirm where listing images are stored/served (the multi-item path is
the reference) and keep it within the existing mechanism — no new hosting.

## Build shape (client-only, ~dashboard-pass size)
1. **Renew action** (Tier 1): re-publish CREATE with fresh expiry; a "store lapsed — renew?" card off
   the trade-index; auto-renew effect while client alive (online-gated).
2. **Bond-duration gate** (Tier 3): `fetchCommunityBonds` + esplora-verify → bonded ⇒ longer
   renewable tenure, unbonded ⇒ 24h manual. Pure check in CreateForm.
3. **Single-listing photo** (companion): surface the multi-item uploader on the single path.
4. i18n EN/FR/ES; typecheck + touched test sections; Jetty device pass.
No reducer, no lock-bundle, no claim-math. Tier 2 stays a separate future coordinated release.

## ⚠ Companion gap surfaced 2026-07-12 (device pass) — seller not routed to child orders
The multi-unit storefront model (#7) is confirmed live: `purchaseFromListing` →
`createEscrow(buildChildCreateParams(parent, qty))` spawns a **CHILD order escrow** per purchase;
the **parent listing persists** as the storefront. So a store trade is legitimately TWO escrows —
parent storefront (stays "Waiting for a buyer") + child order (the buyer's locked order). Same
title, different escrow IDs, and each escrow runs its OWN deterministic arbiter pick, so the child
and parent seat **different arbiters** — all expected, not a glitch.

**The gap:** the SELLER isn't routed or notified to the live child order. They sit on the parent
storefront ("Waiting for a buyer to start an order") while the buyer's child order is LOCKED and
waiting for delivery. The seller IS a participant in every child (escrow-client comment; children
load via `loadChildren`/`childrenByParent`), so the order is discoverable in their trades — but
nothing points them to it. Fix (store-model routing, ships with this brief):
- Parent storefront TradeDetail surfaces **"🛒 N orders in progress → deliver"** linking to the
  live children (reuse `childrenByParent`/`listingChildren`).
- **Notify the seller when a child LOCKs** ("New order on your storefront") and route the tap to the
  child order — same "guide the seller to the accepted trade" doctrine.
- Interim unstick (today): the seller opens the live order from **Me → their trades list**; it's
  there, just not surfaced on the storefront.
Pre-existing (#7 shipped in v5.0), so NOT a v5.1 regression — folds into the 5.2 store pass.

## Open decision for Jetty
- **v5.1 or v5.2?** Jetty leans "feels like 5.1"; fine either way — it's client-only and independent
  of the E1/bond pile, so it can ride 5.1 or slip to 5.2 without entangling the ship.
