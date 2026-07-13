# CC BRIEF — US fiat offramp: Strike LUD-16 native offramp (USD via cash-receive)

## Decision (Jetty, 2026-06-26 — see DECISIONS 2026-06-26)
- **US off-ramp = pay a fiat-converting Lightning Address, provider-agnostic, Strike is the flagship.**
  Same mechanism as Tando, generalized to USD. A fiat-converting Lightning Address is a payout
  **destination**, never a redirect and never a Chama-held balance.
- **Not a redirect, not Strike-for-Business, no incorporation, no custody.** Chama pays
  `<username>@strike.me` via the existing LUD-16 payout path; **Strike** converts to USD entirely under
  the **user's own** account + KYC + limits. Chama stays a coordinator (BOLT11-OUT at claim).
- **Independent of `EXTERNAL_SWAPS_ENABLED`** (Tando precedent) — rides the always-available
  Lightning-Address payout path, not the redirect registry.
- **v1 = Strike only.** Bitcoin Well (non-custodial, sell-to-US-bank over Lightning) and Cash App
  (Lightning receive via invoice — no static LUD-16 address) are same-seam fast-follows, **not** this brief.

## Background (verified in code + on Strike)
- **Strike FAQ** (verified 2026-06-26): every Strike user has a Lightning Address
  `<username>@strike.me`; inbound Lightning is *"delivered directly to your Strike account as either
  cash or bitcoin,"* and the user can set the default receive currency to **Cash** → USD in their
  Strike balance, withdrawable to a US bank by ACH. Licensed (Zap Solutions, Inc., NYDFS, NMLS ID
  1902919).
- Chama already has the **LUD-16 client payout path**: `resolveLightningAddressToInvoice`
  (`lnurl.ts:376`, signature `(address, amountSats, fetch?)`), `parseLightningAddress`/
  `isLightningAddress`, wired into `DestinationPicker`. **Paying a Lightning Address is done.**
- **`strike` is ALREADY a rail** (`rail-registry.ts:425`): key `strike`, `displayName "Strike"`,
  `allowPublicHandle:true`, `placeholder "username"`, region `[sv-usd, us-gbf, us-blf, global-usd]`,
  countries `[US, SV, AR]`. **That rail is the P2P *payment handle*** (a counterparty pays your
  Strike). **This brief adds a SEPARATE payout-destination / offramp use of the same username** — a
  distinct surface, exactly like Tando. See "Don't conflate" below.
- US community slugs: **`us-gbf`** ("USA · USD", GBF), plus `us-blf`, `global-usd`. The set
  `US_LEANING_COMMUNITY_SLUGS = {us-gbf, us-blf, global-usd}` already exists (`rail-registry.ts:632`).
- **Precedent = Tando**, mirror it exactly: `src/payments/tando-offramp.ts`; the Tando block in
  `ClaimPayoutModal.tsx` (eligibility `:192`, saved-find `:966`, build `:989`); tests in
  `src/escrow-engine/tests.ts` (~`:14546`–`14582`). Full pattern brief: `chama-fiat-ramps-tando-brief.md`.

## Part A — `src/payments/strike-offramp.ts` (mirror `tando-offramp.ts`, lighter)
Strike is **lighter** than Tando — the username IS the address, so there's no MSISDN normalization.
1. `export const STRIKE_LNADDRESS_DOMAIN = "strike.me";`
2. `normalizeStrikeUsername(raw): string | null` — strip a leading `@`; if the user pasted the full
   address, strip a trailing `@strike.me`; lowercase; validate Strike's username charset (lowercase
   alphanumeric + limited punctuation — **confirm exact rules on Strike; be conservative**, reject on
   doubt). Bare username or `null`.
3. `buildStrikeLightningAddress(rawUsername): string | null` — `<normalized>@strike.me` or `null`.
   Lowercased so it dedupes cleanly in the shared payout-destinations store.
4. `isStrikeLightningAddress(address): boolean` — `endsWith("@strike.me")`, case-insensitive.
5. `strikeUsernameFromAddress(address): string | null` — inverse, to pre-fill the field from a saved
   destination.
6. `isUSPayoutContext({homeCommunity, tradeCommunity, fiatCurrency}): boolean` — analog of
   `isKenyaPayoutContext` (`tando-offramp.ts:110`): true if either community slug is US-leaning
   (`us-gbf`/`us-blf`/`global-usd`, or `startsWith("us-")`) **OR** `fiatCurrency === "USD"`. Keep this
   **cycle-free** like `tando-offramp.ts` — either re-declare the slug check inline, or export
   `US_LEANING_COMMUNITY_SLUGS` from `rail-registry.ts` and import it (don't pull in the community
   registry). Independent of `EXTERNAL_SWAPS_ENABLED`.
7. Unit tests in `escrow-engine/tests.ts` mirroring the Tando block: build/normalize happy + reject;
   full-address paste handling (`user@strike.me` → `user`); case-insensitivity; lowercase dedupe;
   `isUSPayoutContext` matrix (`us-gbf` ✓, `global-usd` ✓, `USD` ✓, `ke-kes` ✗, `{}` ✗).

## Part B — Claim modal surface (mirror the Tando block in `ClaimPayoutModal.tsx`)
1. Add `const strikeEligible = isUSPayoutContext({ homeCommunity, tradeCommunity, fiatCurrency });`
   next to `tandoEligible` (`:192`).
2. When `strikeEligible`, offer **"Cash out to USD (Strike)"**: user enters their **Strike username**
   (or pastes `user@strike.me`); Chama forms `<username>@strike.me` and routes it through the
   **existing** `resolveLightningAddressToInvoice` payout path. Released escrow sats pay it → Strike
   delivers USD (if the user set receive = Cash; see #3).
3. **Cash receive confirmation (LOAD-BEARING).** A Strike LN address can deliver as **bitcoin** unless
   the user flips **Account → Bitcoin settings → Receive currency → Cash**. Chama **cannot** set this
   for them. Show a guided inline note and require an explicit confirmation before sending: *"Strike
   is set to receive passive Lightning payments as Cash."*
4. **Pre-resolve** `.well-known/lnurlp/<username>` (via the existing path) to validate the address and
   read `minSendable`/`maxSendable`; clear error if the claim amount is out of bounds (Strike's
   receive limits surface here).
5. Show **"≈ $X"** from Chama's live FX, with "final rate + any spread applied by Strike at receipt."
   **Chama sends sats, not dollars** — never promise an exact USD figure.
6. **Save via the EXISTING saved-payout-destinations store** — a Strike address is a Lightning Address
   (`user@strike.me`), so it lives in the same store as Tando and every other destination, NOT a new
   store. Friendly label ("Strike · user") if the store takes one; dedupe by address.
7. **Username-entry UI lives in the Claim modal ONLY** (Tando precedent) — the saved address pre-fills
   the Strike picker, and a user can paste `user@strike.me` into Recovery's Lightning-Address field
   manually. Right v1 scope.
8. Rides the **journal / double-pay guard automatically** — same `payInvoice` path, no new fund
   surface. Rides the **#9 gateway pay path** (needs a reachable LN gateway). **Dodges #16** — a
   derived/pasted address is a Lightning destination, not a `window.open` redirect. (Only an optional
   "New to Strike? Open strike.me" signup link would hit #16 — defer it, or gate behind the Tauri
   opener fix.)

## Don't conflate
- **`strike` rail (`rail-registry.ts:425`) ≠ this offramp.** The rail = a counterparty pays *your*
  Strike as a P2P fiat method (a payment handle shown to the other party). This brief = *you* melt
  your *own* claimed ecash to your *own* Strike LN address to cash out to USD. Same username, two
  different surfaces — keep them separate (the rail stays a counterparty handle; the offramp is a
  payout destination).
- **The captcha is a non-issue.** It guards the human `strike.me/<user>` web page only. We resolve the
  **LUD-16 endpoint** (`.well-known/lnurlp/<user>`), which is open by necessity (every wallet must hit
  it) — no captcha, no scraping, Chama sets the amount.

## Availability / degradation
- Strike isn't available in every US state/country and has its own KYC + send/receive limits — all the
  **user's** concern, not Chama's. But degrade gracefully: if LUD-16 resolution fails or the amount is
  out of bounds, fall back to the generic paste-invoice Lightning-Address path and surface the other
  providers. No hard dependency on Strike.

## Verify
- US-context claim (community `us-gbf`/`us-blf`/`global-usd`, or a USD trade) → "Cash out to USD
  (Strike)" appears; non-US context → it does not.
- Enter username → resolves `<user>@strike.me` → "≈ $X" → pays the released sats; journal/double-pay
  guards apply unchanged; existing Lightning-Address payouts AND the Tando path unaffected.
- Cash-receive guidance is always shown in the Strike picker; a saved Strike destination pre-fills the
  username but still passes through the Cash confirmation.
- `strikeEligible` matrix + `strike-offramp.ts` unit tests added; `npm run predeploy` green. Leave
  uncommitted for Jetty's split.
