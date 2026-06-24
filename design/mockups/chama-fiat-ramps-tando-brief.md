# CC BRIEF — Day-1 fiat ramps: offramp-only registry + Tando LUD-16 native offramp

## Decision (Jetty, 2026-06-24 — revised)
- **All external providers are OFFRAMP-only, surfaced post-CLAIM, country-matched.** No pre-LOCK
  CTA at all — remove it. Nobody onramps in-app; locking is the user's own action with sats they
  already hold, so a pre-lock provider CTA is pointless.
- **No Banxaas pre-lock**, and no `bidirectional` special-casing for anyone. Banxaas stays only as a
  normal country offramp redirect.
- **Remove Minmo entirely** — too much friction (can't even log in with Nostr), not worth surfacing.
- **Tando is the star: a genuine LUD-16 native offramp** (claim/payout to `<phone>@bitcoin.co.ke`
  via the existing payout path), NOT a redirect. The standard every other provider will follow.

## Background (verified in code + on the providers)
- `src/payments/external-swap-registry.ts`: guided-**redirect** model; `EXTERNAL_SWAPS_ENABLED=false`
  since v1.2.8. Two gated call sites — `AtomicFundingModal` (pre-LOCK CTA) and `ClaimPayoutModal`
  (post-CLAIM picker). Registry data + resolver + tests are intact behind the flag.
- Chama already has the **LUD-16 client payout path**: `resolveLightningAddressToInvoice`
  (`lnurl.ts:376`), `parseLightningAddress`/`isLightningAddress` (`:172/208`), wired into
  `DestinationPicker` (Tier-2 typed Lightning Address). Paying a Lightning Address is done.
- **Tando** (live May 2026): `<phone>@bitcoin.co.ke` is a Lightning Address → pay it → recipient gets
  **KES in M-Pesa <40s**, non-custodial. Pure LUD-16. Domain is **bitcoin.co.ke** (the registry's
  `use.tando.me` is the old redirect URL).

## Part A — Enable offramp providers (post-CLAIM only)
1. Set `EXTERNAL_SWAPS_ENABLED = true`, but wire **only the post-CLAIM picker** (`ClaimPayoutModal`).
2. **Remove the pre-LOCK CTA** in `AtomicFundingModal` entirely — no provider surfaces before lock.
   `getBidirectionalSwapsForContext` + the pre-lock CTA become dead code (delete, or leave unreferenced).
3. **Drop `bidirectional` from Banxaas** — it's a plain country offramp redirect now (keeping
   `recommended` so it tops the Senegal picker is fine).
4. **Remove Minmo** — delete both `minmo` entries (`ke-kes`, `ke-kes-bitsacco`).
5. **Honesty copy** (the v1.2.8 dead-end concern): redirect providers OPEN the provider's own site —
   e.g. "Opens {provider} in your browser — cash out there, paste your invoice back." Never let a user
   expect an in-app swap.

**Final non-Tando providers — all offramp redirects, country-matched:**
| Provider | Country | Currency | Notes |
|---|---|---|---|
| Banxaas | Senegal (+ CI/CM/GN coming-soon) | XOF / XAF / GNF | offramp redirect (was bidirectional — drop that) |
| Chapsmart | Tanzania | TZS | offramp, link-only |
| Bitika | Kenya | KES | offramp, link-only (no LUD-16) |
| Bitzed | Zambia | ZMW | offramp redirect — note: Bitzed is actually a buy+spend wallet app, but Chama surfaces it as a cash-out redirect like the rest; fine in this model |

## Part B — Tando the smart way: LUD-16 native M-Pesa offramp (the cherry)
Turn "claim to M-Pesa" into **one tap, in-app, standards-based** — no redirect.
1. In the claim/payout flow add a Kenya **"Cash out to M-Pesa (Tando)"** option: user enters their
   M-Pesa **phone number**; Chama forms `<normalized-phone>@bitcoin.co.ke` and routes it through the
   **existing** `resolveLightningAddressToInvoice` payout path. Released escrow sats pay that Lightning
   Address → Tando deposits KES to the phone.
2. **Tando does NOT depend on `EXTERNAL_SWAPS_ENABLED`** — it's the Lightning-Address payout path,
   always available. **Replace** the Tando *redirect* registry entry with this native path.
3. Details:
   - Normalize + validate Kenyan MSISDN; confirm the exact format `bitcoin.co.ke` expects (likely
     `2547XXXXXXXX`) by actually resolving the LUD-16 metadata before offering it.
   - Pre-resolve `.well-known/lnurlp/<phone>` to validate + read `minSendable`/`maxSendable`; clear
     error if the claim amount is out of bounds.
   - Show "≈ KES X" from Chama's live FX (Tando's final rate applies at settlement).
   - **Save via the EXISTING saved-payout-destinations store** (Jetty, 2026-06-24) — a Tando number
     is literally a Lightning Address (`<phone>@bitcoin.co.ke`), so it goes in the store you already
     have, NOT a new bespoke store. Give it a friendly label ("M-Pesa · 0712…") if the store takes one
     (raw address acceptable otherwise); dedupe by number.
   - **Dedicated phone-entry UI lives in the Claim modal ONLY** (Jetty, 2026-06-24) — not Recovery.
     Because the saved number lives in the shared store (above), it still appears one-tap in Recovery's
     picker, and a user can paste `<phone>@bitcoin.co.ke` into Recovery's Lightning-Address field
     manually — so Recovery keeps M-Pesa cash-out, just without the phone-number sugar. Right v1 scope.
   - Rides the **journal / double-pay guard automatically** — same `payInvoice` path, no new fund surface.
4. Kenya offramp options end up: **Tando (LUD-16 native, lead)** + **Bitika (link redirect)**. No Minmo.
5. Why it's the spearhead: Chama's payout is LUD-16-native, so Tando drops in as "just a Lightning
   Address." Other builders need a bespoke Tando API; Chama needs none. They'll all learn.

## Offramp / onramp reality (settled)
- **OFFRAMP (sats → mobile money): YES** — every provider, country-matched, post-CLAIM. Tando is the
  one-tap LUD-16 standout; the rest are guided redirects.
- **ONRAMP / "lock a trade with fiat": NOT offered in-app at all** (pre-lock CTA removed). LUD-16 is
  pay-only; anyone who needs sats to fund a lock does it themselves, externally, beforehand. A true
  in-app fiat-lock would require a provider that pays a Chama-issued invoice on fiat receipt — none today.

## Don't conflate: `chapsmart-lnurl/`
That phoenixd-backed LUD-16 *receive* server is separate infra (exposing `username@domain`, custodial
pooling). **Not needed for Tando** (Tando already exposes `<phone>@bitcoin.co.ke`). Leave it out.

## Verify
- Post-CLAIM picker shows the right country offramps (Banxaas SN, Chapsmart TZ, Bitika + Tando KE,
  Bitzed ZM); **no pre-lock CTA anywhere**; **Minmo gone**; redirect copy unambiguous.
- Tando: claim → "Cash out to M-Pesa" → resolves `<phone>@bitcoin.co.ke` → ≈KES → pays the released
  sats; journal/double-pay guards apply unchanged; existing Lightning-Address payouts unaffected.
- Update registry tests for the removed Minmo entries + removed pre-lock/bidirectional path.
- `npm run predeploy` green. Leave uncommitted for Jetty's split.
