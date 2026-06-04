# RFC — Fedimint Escrow Module (consensus-enforced 2-of-3 trade escrow)

Status: DRAFT for community discussion (Chama maintainer + engineering).
Companion docs: DESIGN-holder-only-shares.md (the shipped app-layer floor),
DESIGN-arbiter-substitution.md (the shipped pool-arbiter extension). This RFC
is the ceiling those documents point at.

## 1. Who is asking, and from what evidence

Chama is a Nostr-native, non-custodial P2P marketplace/exchange client running
escrow on Fedimint ecash in production (Android via Zapstore, Tauri desktop,
Fedi mini-app). Trades are event chains on Nostr relays (kinds 38100-38108);
funds are federation ecash locked at trade start and released by a 2-of-3 vote
among buyer, seller, and a community arbiter.

We have pushed the app-layer model as far as we believe it goes:

- **Holder-only shares (shipped v2.0.0)**: the locked token's secret is
  Shamir-split 2-of-3; each share is NIP-44-encrypted to exactly one holder
  (buyer / seller / arbiter). A vote re-encrypts the voter's own share to the
  engine-computed payout recipient ("vote-carried release"), so the winner
  reconstructs from their own share + one agreeing voter's. Reconstruction is
  cryptographically 2-of-3 — no single party, including someone scraping
  relays, can assemble the token alone.
- **Deterministic arbiter substitution (code-complete)**: the arbiter share is
  encrypted to a deterministic priority order over the community pool
  (assigned + 2 backups), with a chain-derived grace window, so an absent
  arbiter no longer strands disputes.

What the app layer CANNOT fix: **the funder minted the bearer token.** Ecash
is bearer cash; the federation cannot distinguish "the funder re-issuing notes
they still know" from any honest spend. Pre-resolution, a malicious funder can
race the reconstruction with a reissue. Holder-only shares narrow the window
and remove relay-scrape reconstruction, but RELEASE-to-non-funder ultimately
trusts the funder's client to behave until the winner redeems. That residual
risk is structural to bearer tokens — it can only be closed where the money
lives: in federation consensus.

## 2. Proposal in one paragraph

A Fedimint module (server + client + common, per the standard module split)
that holds escrowed funds in a module-controlled output, spendable only by
(a) a valid 2-of-3 threshold of per-trade ephemeral keys signing a canonical
escrow message, or (b) after timeout, a permissionless refund transaction
paying the pre-committed refund recipient. Nostr remains the coordination and
social layer (discovery, chat, votes-as-events, arbiter pools); the federation
becomes the judge of the money instead of the app.

## 3. Design

### 3.1 Escrow creation (fund)
The funder's client submits a transaction consuming ecash inputs and producing
an `EscrowOutput { escrow_id, amount, terms_hash, timeout_height/ts,
refund_recipient_key, release_recipient_key, arbiter_policy }`. `terms_hash`
commits to ALL payout-critical terms: the three (or pool-capped N) ephemeral
participant pubkeys, recipient keys for each outcome, amounts/fees including
the arbiter-fee policy, the timeout, and the Nostr escrow id binding the
module escrow to its relay event chain.

### 3.2 Per-trade ephemeral keys
Each participant derives a fresh keypair per trade (no reuse of Nostr identity
keys for spending authority). VOTE events on Nostr carry TWO signatures: the
normal Nostr event signature (identity, threading, social accountability) and
an ephemeral-key signature over the canonical module message:

```
canonical_msg = H(
  federation_id ‖ module_instance_id ‖ escrow_id ‖ amount ‖ terms_hash ‖
  outcome ‖ release_recipient ‖ refund_recipient ‖ timeout
)
```

Binding federation id + module instance + terms_hash kills cross-federation
and cross-trade replay; binding outcome + recipients makes a vote unusable for
any payout other than the one the voter saw.

### 3.3 Resolution (spend)
Anyone may submit a `ResolveInput` carrying ≥2 ephemeral signatures over the
same canonical message with the same outcome. Guardians verify threshold +
terms_hash + recipient match and release the funds to the outcome's committed
recipient as new ecash (or a Lightning payout via the gateway, client's
choice). The winner being offline is fine — signatures are bearer evidence,
so the winner's client can submit late, or a watcher can.

### 3.4 Timeout
After timeout, a refund transaction is PERMISSIONLESS: anyone may submit it,
but it can only pay the pre-committed refund recipient. A late valid 2-of-3
resolution remains valid until either the refund or the resolution is
accepted — first accepted wins, exactly the semantics our app layer ships
today (expiry-heal), now consensus-enforced.

### 3.5 Arbiter pools and substitution
Two options, in increasing ambition:
1. **Committed set (preferred for v1)**: `terms_hash` commits the eligible
   arbiter key set (assigned + capped backups, the same deterministic
   priority order our app layer derives). Any ONE of the set may provide the
   arbiter-slot signature; the guardians don't rank them — ranking, grace
   windows, and social coordination stay on Nostr where they belong. The
   module only needs "1 valid signature from the committed arbiter set +
   1 from buyer/seller".
2. **Ranked set**: the module enforces priority/grace on-chain. We believe
   this is unnecessary consensus complexity; the committed-set version plus
   relay-side coordination already removes the money risk.

### 3.6 What stays on Nostr
Listing discovery, joins, chat, vote *narration*, reputation, arbiter pools,
storefront stock accounting — everything social stays relay-side and
unchanged. The module replaces exactly one thing: bearer-token reconstruction
as the release mechanism.

## 4. Rollout

- BLF / Chama-operated federations install the module first (we control
  guardian deployment there). The app detects module availability per
  federation and uses it when present.
- Third-party federations without the module keep the app-layer holder-only
  escrow — the floor everywhere, the module the ceiling where installed.
- Cross-federation trades keep the LN-in / ecash-escrow / LN-out sandwich;
  the module governs the middle leg.

## 5. What we ask the Fedimint community

1. Sanity-check the output/input model against the current module API
   (`fedimint-server` consensus items + `fedimint-client` state machines —
   we've studied the dummy module and the custom-module starter template and
   believe this fits without core changes; corrections welcome).
2. Prior art: are others building or planning escrow/covenant-style modules?
   We would rather contribute than duplicate.
3. Interest in this living in-tree vs. as an out-of-tree module crate we
   maintain (we're happy to do the latter and upstream later).
4. Client surface: we run `@fedimint/core` (fedimint-sdk WASM) today inside a
   web client + Capacitor/Tauri shells, and we maintain our own native
   fedimint bridges for Android and Tauri. With the UniFFI evolution of the
   client core underway, the shape we want is one Rust module-client whose
   calls surface across WASM and the native Kotlin/Swift/React-Native
   bindings from a single implementation — we would happily retire our custom
   bridges for that. Guidance on exposing custom-module client calls along
   that trajectory would shorten our path materially.

## 6. Non-goals

- No new trust assumptions beyond the federation the user already chose.
- No identity linkage: ephemeral keys mean the module learns amounts and
  keys, not Nostr identities.
- No change to single-party UX (sends, top-ups). The module is escrow only.

## Appendix: lessons from the app layer worth keeping

- Pure-function recipient routing (`payoutRecipientFor(state, outcome)`)
  prevented an entire class of "reinterpreted outcome" bugs; the canonical
  message is its consensus-grade descendant.
- Permutation-convergent replay (any event order → same state) is the only
  sane model under relay eventual consistency; the module gets this for free
  from federation consensus, which is precisely why it's the right home.
- Loud cross-version failure beats silent stranding: module-aware locks must
  be visibly unclaimable by module-unaware clients, never silently stuck.
