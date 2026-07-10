# Chama — reputation-gated store permanence (design brief)

**Status:** design capture (2026-07-08, Jetty's proposal). Launch-quality anti-spam + a reputation progression
reward. **v5-vs-post-v5 is an open decision** (see the last section) — the build is moderate and carries no
consensus risk, but the verification fan-out is ~a feature's worth of build+test on an otherwise release-ready tree.

## The idea
A new seller's storefront is **time-boxed** (lives at most ~1 week); once they've **earned X verified trades** it
becomes **permanent**. Two wins at once:
- **Anti-spam.** A permissionless marketplace must not be floodable with fake/abandoned stores at launch. Unproven
  sellers' stores self-expire; only earned reputation buys permanence.
- **Progression reward.** A concrete, visible reason to complete honest trades — ties directly into the Dashboard
  STANDING that just shipped.

## ⭐ Why it's much easier than prefer-bonded (the key craftability point)
Store visibility is a **display / consent-layer** concern, NOT reducer/consensus state. And a seller's completed-
trade count is **already publicly verifiable** — `aggregateVerifiedRatings` (reputation/ratings.ts) validates each
rating against the actual settled trade via `verifyRatingForTrade`. So this needs **no CREATE-stamp, no JOIN-gate,
no reducer change, and carries zero chain-fork risk** — the exact opposite of 2B. Each viewing client independently
computes "has this seller earned X?" and ages the store out or keeps it. The pieces all exist: `expirySeconds` /
`expiresAt` (expiry), `storefront.ts` (the perpetual multi-unit PARENT = the "store"), the ratings-verification
machinery, and the Browse listing filter.

## How it works
1. A storefront (the `stock` PARENT listing in `storefront.ts`) declares an intended long/permanent lifetime.
2. When rendering Browse, each client computes the store owner's **verified completed-trade count** (from public
   rating events, verified against the trades — `aggregateVerifiedRatings`; or a direct settled-trade-as-seller
   count).
3. **< X ⇒ treat as temporary:** the store is shown with a "temporary" badge and **ages out after ≤1 week**
   regardless of the declared lifetime.
4. **≥ X ⇒ permanent:** the store persists.

The enforcement is **per-viewer verification** — this is load-bearing. A client-side "I'm permanent" flag alone is
trivially gamed by a modified client; the anti-spam value only holds because *honest viewers verify the count
themselves* and won't render an unearned store as permanent. (Same trust-minimized shape as ratings + liveness.)

## The real work (moderate)
- **Verification fan-out.** Browse shows N stores → each owner's verified count must be computed → batch-fetch their
  rating/trade events + cache. This is the bulk of the effort, and it's the SAME shape as the liveness "🛡 N bonded"
  count fan-out already solved (one batched relay read, grouped by npub, cached). Reuse that pattern.
- **Define the rule.** Threshold X; the newcomer cap (~1 week — confirm); what counts as an "earned trade"
  (recommend: **verified completed trades as seller** — conservative + already computable; note verified-rating
  count is a lower bound since not every completion is rated, so a direct settled-trade count may be preferable).
- **"Permanent" mechanics.** The storefront is an addressable/replaceable event — decide between a long/renewing
  `expirySeconds` vs a periodic auto-republish so it never ages off relays. Keep it self-describing so a fresh
  viewer can evaluate it without prior state.
- **UI.** A "temporary · N/X trades to permanent" progress line on newcomer stores + a "permanent" badge on earned
  ones. Dovetails with the Dashboard STANDING card.

## Integration points (when built)
- `src/escrow-engine/storefront.ts` — the store (parent) is here; add the permanence classification helper (pure).
- `src/reputation/ratings.ts` — reuse `aggregateVerifiedRatings` (or add a `verifiedSettledTradeCount(seller)`).
- CreateForm — a storefront's declared lifetime; show the newcomer cap + progress.
- Browse listing filter — age out sub-threshold stores past their ≤1-week window; badge the rest.
- A batched owner-count fetch + cache (model on the liveness `fetchBondedArbiterCounts` fan-out).

## Anti-abuse
- Per-viewer verification is the whole defense — never trust a self-declared permanence flag.
- A spammer's modified client can declare permanence, but honest clients compute the real (zero) verified count and
  render + age the store as temporary. No honest viewer is fooled; spam self-expires.
- Sybil note: X verified trades still costs real completed trades (with real counterparties + escrow), so cheaply
  minting permanence at scale is expensive — but pair-trading collusion to farm the count is a residual worth
  noting (the bond/liveness layer + rating verification blunt it; not fully eliminated).

## v5-vs-post-v5 (Jetty decides)
- **In v5:** it's a real launch-quality anti-spam gate, but a real version REQUIRES the per-viewer verification
  fan-out (the client-side-only shortcut doesn't achieve the anti-spam goal), so it adds ~a feature of build+test to
  a tree that's otherwise ready for the device pass — extends the runway.
- **First post-v5:** ship v5 (bond + release) now; make this the first feature after, with the fan-out done properly.
Recommendation: capture (this brief) + decide based on how pressing marketplace-spam-at-launch feels. Marketplace
listings already default-expire (24h), so the floor isn't zero today — that argues for post-v5 unless spam risk is
judged high.
