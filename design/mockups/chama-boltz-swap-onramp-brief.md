# Chama — Boltz swaps for on-chain funding + payout (idea capture)

**Status:** idea / design capture (2026-07-08, Jetty's proposal). **NOT a v5 blocker** — v5 is finish-the-bond +
release. Strong **v5.x candidate**, best bundled with the on-chain payout / off-ramp expansion and the ChapSmart
funding-method work. No code yet; this captures the idea so it's ready to pick up post-release.

## The idea
Use **Boltz** (non-custodial submarine + reverse swaps) at the on-chain edges of a trade so on-chain BTC users
don't wait on Fedimint's on-chain peg-in confirmations (~10-12 confs), and on-chain payouts skip the peg-out —
with a modest privacy bump from the extra hop.

## Why it fits Chama
- **Non-custodial.** Boltz swaps are HTLC-based — atomic and refundable; Boltz cannot steal mid-swap (it brands
  itself a "non-custodial bitcoin bridge"). So it does NOT introduce a custodian into the path — aligns with the
  ethos (unlike a KYC ramp).
- **Edge integration, zero escrow-core change.** It plugs into the SAME "alternate payer of the funding BOLT11"
  abstraction NWC and ChapSmart already use (`fund-and-lock`'s `autoPayInvoice`). The Fedimint LOCK/CLAIM core is
  untouched — lowest-risk shape.

## The two legs
1. **Funding on-ramp (submarine swap, chain → Lightning).** The escrow's atomic fund-and-lock already generates an
   exact-amount funding BOLT11 and watches for payment. A Boltz **submarine swap** takes that invoice: the user
   sends on-chain BTC to Boltz's lockup address, Boltz pays the invoice, the sats mint into the user's own Fedimint
   wallet, and the LOCK proceeds — at Lightning speed, no 12-conf peg-in wait. Killer case: an on-chain-only user
   with no Lightning can fund a trade directly.
2. **Payout off-ramp (reverse swap, Lightning → chain).** On CLAIM the user gets sats; a Boltz **reverse swap**
   delivers them to the user's on-chain address without a Fedimint peg-out. Useful for the on-chain payout / TZS
   off-ramp story; the swap hop adds some privacy vs a direct peg-out.

## Honest tradeoffs
- **Fees are comparable, not a clear win.** ~0.1% service + on-chain network fees (and routing on the LN leg) —
  in the same ballpark as Fedimint peg-in/out. Don't sell this on cost; sell it on **speed** (no conf wait) and
  **reach** (on-chain-only users) + a privacy bump. (Jetty's "maybe not" on fees is right.)
- **Failure/refund handling is real work.** Submarine swaps can fail (invoice unpaid in the window, on-chain
  underpay) → a refund flow the user must be walked through. Boltz has refund tooling + documented swap states,
  but this is the bulk of the integration cost.
- **Boltz-provider reliance.** The swaps are trustless (can't steal), but the *service* being up/available (and
  regional access, amount min/max) is a dependency. Mitigation: keep the Fedimint peg-in/out path as a fallback,
  and consider the self-hostable `boltz-client` long-term.
- **Volume justification.** Only worth it once on-chain funding/payout is common enough to matter — most funding is
  Lightning/NWC today, where there's no conf wait. Pair it with the on-chain/off-ramp push rather than shipping
  standalone.

## Integration points (when built)
- Client module `src/payments/boltz-swap.ts` — thin, typed calls to the Boltz REST API: create submarine swap
  (invoice → lockup address + amount), poll swap status, create reverse swap, handle refund. (Mirror the shape of
  the ChapSmart starter module.)
- `fund-and-lock` / `useEscrow`: add `fundingMethod === "boltz"` alongside `nwc`/`chapsmart` → `autoPayInvoice` =
  "run a Boltz submarine swap that pays this BOLT11." No lock-path change.
- `ClaimPayoutModal`: add "Receive on-chain (Boltz)" as a payout destination → reverse swap to the user's address.
- Gating: off in sim; surface the swap fee + limits in the quote step; refund CTA on failure.

## Sources
- Boltz — Non-Custodial Bitcoin Bridge: https://boltz.exchange/
- Boltz API — Swap Types & States (lifecycle/refunds): https://api.docs.boltz.exchange/lifecycle.html
- Submarine Swaps — Boltz Blog: https://blog.boltz.exchange/p/submarine-swaps-c509ce0fb1db
