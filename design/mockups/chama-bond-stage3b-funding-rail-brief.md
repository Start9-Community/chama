# Chama bond — Stage 3b funding-rail decision brief

**Status:** decision brief (2026-07-02). No code yet. Stage 3b is the ⛔ hard stop — it
moves real (or real-network test) sats into a real 2-of-3 address, so it begins only on
Jetty's go-ahead, tiny amounts, supervised. The verifier builds the plumbing; Jetty funds.

## The problem in one sentence

The bond spine is done and Mutinynet-proven; the only missing piece is **getting sats into
the locally-recomputed 2-of-3 bond address** — and Chama users hold their sats as **Fedimint
ecash or Lightning**, not as on-chain UTXOs. So the funding rail is a conversion:
*ecash/Lightning → an on-chain UTXO at the bond address.*

Whatever the rail, one thing never changes: **recompute-don't-trust extends to funding.**
Chama independently confirms the funding UTXO landed at the *locally-recomputed* 2-of-3
address, for the exact amount, with enough confirmations, before it calls `lockBondCustody`.
The rail only delivers sats; the keystone still guards the address.

Three candidate rails, in the order I'd ship them.

---

## Option A — Direct on-chain (the v1 for the seed cabinet)

The ceremony already displays the 2-of-3 address + a QR. A cabinet member with on-chain sats
in *any* wallet simply sends the exact bond amount to it. Chama watches the address (Esplora),
sees the UTXO, verifies address+amount+confirmations, and records it → `lockBondCustody` → the
bond is LOCKED.

**Why it's first:** it is the smallest possible step from where we already are. We *just*
funded a 2-of-3 on Mutinynet from the faucet and spent it six ways — that **was** direct
on-chain funding. The only missing piece is the in-app watcher + the `lockBondCustody` wiring
(small). No third party, no new protocol.

**The catch:** it assumes the funder already holds on-chain BTC. For a three-person seed
cabinet of sophisticated early users, that's fine — they can source a few thousand sats. For
*real users* whose whole balance is ecash/Lightning, it breaks the native UX. So it's the
right **v1 for the cabinet**, not the answer at scale.

**Testable now:** entirely on Mutinynet, no real sats — the exact flow we already ran, plus
the app-side watcher.

---

## Option B — Boltz reverse swap (the real rail) — the deep dive you asked for

This is the one that makes bonds work for *everyone*: it turns the **Lightning liquidity every
Chama user already has** (via NWC / their Alby wallet) into an on-chain deposit at the bond
address — **without the user ever holding on-chain BTC**, and, if paid via NWC, **without ever
touching the federation's Lightning gateway** (the #9 pain point stays out of the funding path).

### First, the naming, because it's backwards on purpose

A **submarine swap** moves value between Lightning and on-chain. A *normal* (forward) swap is
**on-chain → Lightning** (you have on-chain, you want to receive over LN). A **reverse** swap is
**Lightning → on-chain** (you have LN liquidity, you want on-chain sats). Chama users have LN
liquidity, and the bond needs on-chain sats — so **reverse** is our direction.

### The mechanism — walk through funding one 21,000-sat seed bond

The whole trick rests on a **preimage** — a random secret whose hash acts as a lock that both
the Lightning payment and the on-chain payment share, so the two are welded together.

1. **Chama invents the secret.** It generates a random 32-byte preimage `p` and computes
   `H = SHA256(p)`. It keeps `p` secret and sends only `H` to Boltz, along with a claim public
   key `C` and the on-chain amount it wants (21,000 sats).
2. **Boltz returns a *hold* invoice.** A hold (HODL) invoice is the special ingredient: when
   someone pays it, Boltz's node *accepts but does not settle* the payment — it sits "held,"
   claimable only once Boltz learns `p`. Boltz also returns its own pubkey `B`, a timeout, and
   the swap's Taproot lockup address.
3. **Chama recomputes the lockup address itself** (don't-trust-the-wire, same principle as the
   bond keystone). Modern Boltz swaps are **Taproot / Musig2**: the lockup address is the
   aggregate of `C` and `B` tweaked by the swap's script tree. Chama rebuilds it from `C`, `B`,
   `H`, and the timeout and checks it matches — and checks the invoice's amount and that its
   payment hash is really `H`.
4. **Chama pays the hold invoice over Lightning** — via NWC (the user's own Alby/NWC wallet).
   Boltz now has an **incoming LN payment it is holding** but cannot claim, because it still
   doesn't know `p`.
5. **Boltz locks up the on-chain sats.** Seeing the held payment, Boltz broadcasts a tx putting
   21,000 sats into that Taproot swap address.
6. **Chama claims — straight to the bond address.** Chama watches for the lockup, verifies the
   amount, then builds a **claim transaction spending the swap UTXO whose output is the bond's
   2-of-3 address**. Two ways to claim:
   - **Cooperative (the normal path):** Chama hands `p` to Boltz via the API; the two produce a
     Musig2 partial signature each and do a **key-path spend** — cheap and private, and the
     preimage never appears on-chain.
   - **Fallback (if Boltz ghosts):** Chama claims via the **script path**, revealing `p`
     on-chain. Slightly bigger/less private, but it doesn't need Boltz's cooperation.
7. **Boltz settles the Lightning payment.** Either way Boltz ends up with `p` — handed over in
   the cooperative case, or read off the on-chain script-path spend — and uses it to settle the
   held invoice, finally collecting the LN payment.
8. **The bond is funded.** The claim tx confirms; 21,000 sats now sit in the 2-of-3. Chama
   records the UTXO → `lockBondCustody` → LOCKED.

### Why nobody can cheat (the part worth internalizing)

The preimage `p` is the single hinge, and it forces the two payments to happen together or not
at all:

- **Boltz can't keep your Lightning sats without releasing on-chain.** The LN payment is *held*,
  and Boltz can only settle it with `p`. It only gets `p` when you claim the on-chain funds (or
  when you hand it over in exchange for cooperating). No claim, no `p`, no settle — the held
  invoice times out and **your sats come back**.
- **You can't be left having paid for nothing.** If Boltz never locks on-chain, the invoice was
  only *held* → it expires → refund. If Boltz locks but then refuses to cooperate on the claim,
  you take the script-path claim and get the on-chain sats anyway (and that reveal is what lets
  Boltz settle — so it has every incentive to cooperate).
- **Worst case is a timeout, not a loss.** Both legs refund. That matches Chama's whole ethos:
  the funding path **fails safe** — no sats stranded, the bond just doesn't get created that
  attempt.

### The Chama-specific beauty

The claim's **output is the bond 2-of-3 directly**, so a single reverse swap deposits the bond
in one atomic-ish flow, funded from Lightning the user already has. And because Chama pays the
hold invoice via **NWC (external Lightning)**, the federation's LN gateway — the thing that
breaks in #9 — is **never in the loop** for funding. (You *could* pay it from the fed's gateway
instead, but that reintroduces #9; NWC is the clean path and it's your default anyway.)

### The testing reality (this shapes the plan)

Boltz **deprecated its public testnet in favor of regtest**, and production is **mainnet**.
There is no Mutinynet-Boltz, so — unlike the custody matrix — we can't mirror this on a faucet
signet. The rail's first real exercises are:

- **Self-hosted `boltz-backend` on regtest** — full control, no real sats. This is where we
  wire + prove the plumbing (create swap → recompute lockup → pay hold invoice → claim to the
  bond address → lock). The bulk of the integration is validated here.
- **One tiny mainnet bond** — a 21k-sat seed bond is a couple of dollars. This is the true
  go-live and the genuine ⛔ hard stop: your call, your sats, supervised.

Integration note: Boltz asks that you go through their **official SDK** rather than hand-rolling
the API, which also gives you the Musig2 + claim-tx construction for free.

---

## Option C — Fedimint peg-out (the native upgrade, later)

Fedimint's on-chain wallet module can **peg out**: redeem ecash and have the guardians co-sign
an on-chain withdrawal straight to an address — here, the bond 2-of-3. No third party, no
Lightning hop, ecash → on-chain in one native step.

**Why it's the most elegant:** the trust is the federation you already trust, not an added
service like Boltz; there's no LN detour; and there's no extra service fee beyond the peg-out's
on-chain cost.

**Why it's not first:** (1) the federation has to *support* peg-out — some disable it or set
minimums above a seed bond; (2) Chama's native Rust `fedimint-bridge` almost certainly doesn't
**expose** peg-out yet (new bridge work + a rebuild/relaunch, same as any bridge change); (3)
peg-outs wait on guardian consensus + on-chain confirmation (slow-ish); (4) it links the fed to
the bond address on-chain. It's the best *long-term native* rail, but the most
integration-uncertain — right to revisit after Boltz proves the model, or once a launch
federation cleanly supports peg-out.

---

## Recommendation — ship it in stages

1. **v1 (now, cabinet-only): Direct on-chain.** Smallest delta from today; fully Mutinynet-
   testable with no real sats; lets bonds go live for the three-person seed cabinet behind the
   existing flag. Work = an address watcher + `lockBondCustody` wiring.
2. **v2 (the real rail): Boltz reverse swap, paid via NWC.** What makes bonds work for every
   user with only Lightning liquidity, keeping the fed gateway out of funding. Plumb + prove on
   self-hosted regtest, then one tiny mainnet seed bond as go-live.
3. **v3 (optional native upgrade): Fedimint peg-out.** Removes Boltz as a dependency if/when a
   launch fed supports it and the bridge exposes it.

Across all three, `BONDS_ENFORCED` stays **false** — funding a bond and *enforcing* an exposure
cap are separate flags; this brief is only about getting sats safely into the address.

## What I'd build first, concretely (v1)

A small `fund-watcher` seam: given a bond's recomputed address, poll Esplora (the Mutinynet
endpoint we're already using) for a confirmed UTXO of the expected amount, verify
address+amount, and call `lockBondCustody`. It's the natural next commit, it's Mutinynet-safe,
and it turns the "funding lands in a later build" placeholder in `BondCeremonyModal` into a real
LOCK — without a single line of real-sats risk. Boltz (v2) then slots in as an *alternative
source* feeding the same watcher + lock.

## Field intel (Jetty, 2026-07-02) — reshapes the ordering

Three things Jetty flagged that pull peg-out forward and reframe v1:

1. **Peg-out is already live — CONFIRMED IN CODE 2026-07-02.** Chama's own native
   `fedimint-bridge` (`main.rs`) already exposes the full wallet-module surface:
   `/onchain/deposit-address` (peg-in), `/onchain/withdraw-fees`, and **`/onchain/withdraw`**
   calling `WalletClientModule.withdraw(address, amount)` and returning the on-chain **txid** on
   `WithdrawState::Succeeded`. It's wrapped all the way up the TS stack:
   `native-bridge-adapter.ts` → `FedimintClient.withdrawOnchain(address, amountSats)` →
   `{ txid, feesSats, operationId }`, with an existing `payOnchain` call site already using it for
   claims. So **v3 is a wiring job, not bridge work** — exactly as Jetty said (the wallet module
   ships by default; LN is the optional add-on). Wired 2026-07-02: `fundBondViaPegout(bondId)` +
   `bondPegoutFees(bondId)` (useEscrow) send EXACTLY the bond amount on-chain to the bond's own
   2-of-3 (peg-out fee additional, from ecash) → the fund-watcher confirms + locks. A ceremony
   "Fund from my Chama balance" button (fee preview + moves-real-sats confirm) drives it, behind
   `SHOW_BOND_CEREMONY`. Caveat holds: `withdrawOnchain` throws on a browser/WASM build without the
   on-chain module (→ "fund the address directly"); native (Tauri/Android) has it.
   *Direction note:* the friend's ~12-conf observation is the peg-**in** credit delay; the bond
   uses peg-**out** (ecash → the external 2-of-3), which is the confirmed `/onchain/withdraw` path.

2. **The watcher requires N confirmations now — reorg safety. DONE 2026-07-02.**
   `findBondFundingUtxo` takes a `minConfs` (fetches `/blocks/tip/height`, requires `tip −
   block_height + 1 ≥ minConfs`); `defaultMinConfs(network)` = 2 on signet, 6 on mainnet, and
   `checkBondFunding` passes it. A too-shallow deposit is ignored (keep polling) — 3 tests in
   5b-BONDFUND cover 6-deep-accepts-6, 6-deep-rejects-12, 12-deep-accepts-12. (12 stays available
   via an explicit param for the truly paranoid, matching Fedimint's own peg-in depth.)

3. **Direct-on-chain is a FIRST-CLASS path, not a stopgap — and it already subsumes the others.**
   Bonds are preferably high-value, and serious posters (esp. Western / desktop) will *want* to
   fund the 2-of-3 straight from **Sparrow or a hardware wallet**; global-south posters use their
   phone. Crucially, the watcher is **source-agnostic**, so "fund from Sparrow," "manually peg-out
   from your fed to the bond address," and "Boltz claim" **all already work today** through the v1
   watcher — the deposit just appears at the address. So v2 Boltz and v3 peg-out are really
   *in-app UX sugar* over funding paths that are already possible manually; none of v1 is throwaway.

4. **Framing:** posting a bond is a *responsible role*, not a mass-market feature — it's expected
   NOT to please most users at first, and that's by design. The rail should be correct and safe,
   not frictionless-for-everyone.

## Sources
- [Boltz API — Swap Types & States](https://api.docs.boltz.exchange/lifecycle.html)
- [Boltz API — Claims & Refunds](https://api.docs.boltz.exchange/claiming-swaps.html)
- [Boltz API v2 (latest REST API)](https://api.docs.boltz.exchange/api-v2.html)
- [Boltz Blog — Hold Reverse Swaps](https://blog.boltz.exchange/p/brewing-boltz-hold-reverse-swaps-fea0fadbf041)
- [Boltz API — Introduction (regtest/mainnet; testnet deprecated)](https://api.docs.boltz.exchange/)
