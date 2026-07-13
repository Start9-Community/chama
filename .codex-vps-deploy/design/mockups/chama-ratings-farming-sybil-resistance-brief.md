# Chama — ratings farming & Sybil resistance — design principles

**Status:** design principles / guardrail (2026-07-09). Answers "what stops a user farming ratings between their own
npubs to look trustworthy or unlock features?" Short version: the design is already sound because **nothing gates on
ratings** — this brief makes the rule explicit so it *stays* that way (esp. for #49 store permanence).

## The core reframe
Chama's protection is **escrow + bond, not reputation.** Every trade is escrow-held and arbiter-adjudicated regardless
of how good a counterparty's rating history looks. So a farmed rating **cannot steal** — it can only make someone
*look* trustworthy, and looking trustworthy doesn't bypass the escrow. This is the inverse of Amazon/eBay, where
reputation IS the protection and fake reviews are catastrophic. Here they're cosmetic. That caps the blast radius by
design.

## Are ratings farmable? Yes — cheaply.
Ratings are trade-verified — a rating only counts against a SETTLED escrow (`aggregateVerifiedRatings`). Not nothing:
farming requires real escrow cycles. But a Sybil controlling both sides just cycles their own sats between their own
npubs and pays only the fees (~a few sats per funding). Trade-verification raises the bar without making it expensive.
**Treat ratings as cheap to forge.**

## The load-bearing rule
> **Gate privileges on the BOND; let ratings only modulate. Never let ratings alone unlock anything.**

The commitment bond is the Sybil-resistant anchor: it costs locked on-chain capital you can't fake or cheaply
replicate. That's why the one powerful role (arbiter) is bond-gated, not rating-gated — correct by construction.
Ratings may *sweeten* (a bonded arbiter with great ratings ranks higher), but the key to any real privilege must be
something costly: the bond.

Cost-to-forge vs value-of-forgery: a rating costs ~fees (cheap) → put nothing valuable behind it. A bond costs locked
capital + time (expensive) → put valuable privileges behind it.

## ⚠ Direct constraint on #49 (store permanence)
"Store becomes permanent after X trades" is exactly a trade-count gate → farmable by self-dealing X trades. If #49
ships, it must key on something costlier than raw count:
- **Distinct counterparties** (a diverse trade graph is hard to fake — needs many colluding npubs, itself a cost), and/or
- **A small bond** (permanence = skin in the game), and/or
- **Sustained value/volume** over time (ties up capital).

Never "did 10 trades" — that's 10 self-deals. **Design #49 against this brief.**

## The residual threat (low ROI)
The one thing a farmed rating buys: luring a real victim into a trade by looking established. But even then the escrow
+ arbiter protect the victim — the scammer can't just take the money. So the ROI on farming is low: cost = fees + time
+ running a Sybil ring; payoff = a marginal confidence boost the escrow already neutralizes. Worth watching, not urgent.

## If ratings ever need to be Sybil-HARD (future — only if reputation starts carrying weight)
A graph/Bayesian layer over the ratings aggregate:
1. **Counterparty-diversity weighting** — a Sybil ring is a dense, isolated cluster of repeat npubs rating each other;
   organic reputation is a diffuse graph touching many independent nodes. Down-weight tight clusters.
2. **Bonded-/trusted-rater weighting** — a rating from a bonded (or diverse-history) npub counts more than one from a
   fresh throwaway. Reputation flows from trusted anchors outward (EigenTrust/PageRank shape); a cluster of fresh npubs
   gets near-zero flow from the bonded core, so their inflated self-ratings don't count.
3. **Value/recency weighting** — weight by trade value and spread over time; a burst of identical small trades between
   three npubs reads as farming.

Build only if/when a feature makes reputation valuable enough to attack. Until then the "gate on the bond" rule is the
whole defense, and it's sufficient.

## Bottom line
Nothing gates on ratings today → no farming vector today. Keep it that way: **the bond is the key to power, ratings are
just the paint.** Anchor every future privilege (starting with #49) to the bond or to a genuinely costly signal, and
farming stays pointless.
