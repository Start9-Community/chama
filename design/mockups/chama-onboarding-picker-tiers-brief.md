# CC Brief — Onboarding picker: two-green-tier design (C1 + C2, final)

**Status:** the locked answer to CC's C2 question (which communities read what). Decided with Jetty,
2026-06-26. Supersedes the C1/C2 sketch in `chama-post-4.1-batch-brief.md`. Standalone. Leave
uncommitted. Surface: `src/ui/screens/GlobeCountryPicker.tsx` (+ the native-verified set).

**Why this matters (the anchor):** the old "no local Chama in {country} — an arbiter would be a
stranger" soft-landing nearly cost Jetty a real trader — the US user who saw it and felt shut out
became the one who offered Jetty his *first trade*. The lesson: **never make a visitor feel like
they're standing in the dark.** The deterrent isn't the words alone — it's the green-light-vs-no-light
binary ("you're in / you're nothing"). We're replacing that with **two greens**: the distinction lives
in the *words*, never in the presence or absence of light.

---

## The honest split — PRESERVED, not reversed

CC was right to guard the `// GBF is intentionally NOT here` block and `isRealLocalChama`. An
elected-local-arbiter community (Kenya/Afribit/Bitsacco) is **not** the same as a country merely
*backed* by a native-verified federation — "a flag is not a Chama." **Keep `isRealLocalChama` and that
block untouched.** We don't promote GBF into "live local Chama"; we give the backed countries an
honest second tier.

## Three tiers — the first two BOTH green (no red, no blue, no darkness)

1. **⚡ Live Now** *(green)* — the current `isRealLocalChama` set (Kenya · Afribit Kibera · Bitsacco).
   *Elected local arbiters.* Label keeps its existing "live local Chama" meaning. (Jetty's wording:
   "Live Now" / "Fully Live Now" — pick the chip text that fits.)
2. **✓ Available Now** *(green too)* — **every country backed by a native-verified G-Bot fed
   (GBF / BLF / OCA / LatNet — effectively everywhere).** Copy:
   > **✓ Available now · backed by Chama's global arbiters · your local Chama is coming.**
   Honest (the fed is native-verified, the cabinet backs every trade) and inviting (no "stranger far
   from you"). This is the new landing for what used to be the discouraging "no local Chama" branch.
3. **"Coming soon" — effectively never hit.** `defaultFederationForCountry` **always** pins a regional
   G-Bot fed (Africa→OCA · LatAm→LatNet · else→BLF — *never* null), so **every country a user can pick
   is at least Available Now.** El Salvador is no exception: `SV ∈ LATAM_COUNTRY_CODES` (registry.ts:167)
   → **LatNet**, exactly like Mexico. The only `federationInvite: null` entries are **hidden sunset
   stubs** (e.g. `sv-usd`, kept solely so old listings still resolve) — never shown in the picker.
   Keep a "coming soon" branch only as a defensive, should-never-trigger fallback; **in practice the
   picker is two green tiers, full stop.** *(Optional hygiene: repoint `sv-usd` null → LatNet, mirroring
   the `global-usd → BLF` precedent, so legacy SV listings ride the same fed a new SV user gets.)*

**Scope of "Available Now" is BROAD on purpose.** The demand isn't only US (846K impressions) — it's
Germany, Benin, everywhere. If only *named* communities got the green tier, the millions in unnamed
country-shells would still hit a sad fallback and bounce. Broad = "you can trade here" is true for
whoever shows up.

## Layout (recommended; CC verifies on phone width)

- **⚡ Live Now** group up top — the elected-local few, green, prominent.
- **✓ Available Now — the user's OWN country, featured** right below. Derive it from the **device
  locale** (`navigator.language` / `navigator.languages` → the region subtag; privacy-clean, no
  geo-IP, no network call — on-ethos) and surface **that one country** green: "🇺🇸 United States ·
  ✓ available now." **Do NOT hardcode a US/Germany/Benin set** — a fixed VIP list reads as arbitrary
  and re-creates the exact "is *my* country in?" anxiety this redesign exists to kill. If the user's
  locale country is itself a Live-Now community (Kenya), highlight it in the Live Now group instead.
  (Optional second row: the next *real* Live community for social proof — never a random country.)
- **…then the full searchable world** — every country a user searches or picks reads the green
  "Available now…" line. (You can't column-list the planet, so "Available" is a search, not a fixed
  list.)
- **Optional:** if it fits the phone width cleanly, make the *featured* zone a two-column split
  (left: Live Now · right: Available Now featured) — Jetty's side-by-side instinct, applied only to
  the short featured lists, never to the world search. Your call after a browser check.

## Multi-chama per country (the drill-down) + the road to new chamas

**Kenya already shows the shape** — "Kenya · 2 Chamas" → tap → pick (Afribit / Bitsacco). Jetty wants
that for **every** country: tap the US → see the chamas that exist in the US → pick the one you belong
to.

- **This pass (structural):** make the country → chamas drill-down work for **any** country, rendering
  **N** chamas, not just Live-Now ones. Source the list from the registry communities for that country
  (US → GBF "USA · USD" today). One chama → open straight through; several → show the disambiguation
  picker (exactly Kenya's path). Build the list UI to handle N even where most countries have one
  today, so it's ready to grow.
- **The deeper layer (NOT this pass — gated on the bond + a discoverable-chama primitive):**
  *user-created* chamas appearing in that drill-down for everyone. Today `addCustomCommunity()` is
  device-local, so a new chama isn't discoverable by others. For "tap US → see Bob's NYC Chama," a
  chama has to be **published as a fetchable Nostr event** (a chama-announcement), grouped by country.
  That new primitive pairs with **how a real chama is born:** the **arbiter-form leader pitch → "start
  your community" → the cabinet ceremony (2A bond) → publish the chama** so it shows up in its
  country's drill-down. The full vision — *anyone can stand up a local chama others can find and join*
  — is the convergence of **the arbiter on-ramp + the bond (2A) + a published-chama directory + this
  drill-down.** Flag it; don't build it here.

So: **this pass = locale featuring + the N-chama drill-down (registry-sourced).** The discoverable,
user-created chamas + the creation flow ride with 2A and the chama-directory primitive.

## C1 (the rest of the onboarding cleanup — unchanged from the batch brief)

- In the no-local-Chama branch (`GlobeCountryPicker.tsx ~171-206`): **delete the request-a-Chama form
  + the become-a-leader copy**; the branch now lands on the green **Available Now** tier above. One
  clean **Continue → nsec → in.**
- **Coach-mark tour** (NymChat-style tap/next over the 3 nav + 2 FABs), shown once after first sign-in,
  skippable, device-local "seen" flag.
- **Arbiter on-ramp → the blue Listings FAB** (`ArbiterApplyForm`), reframed as the aspirational
  leader pitch + bond-ceremony teaser.

## Honesty note (keep it true)

"Available now" must **never** claim local arbiters or imply an elected local Chama exists where it
doesn't. The *words* carry the distinction (Live vs Available); the *green* carries the welcome. Both
tiers feel "you're in" — only the elected-local set earns "Live."

## Verify (browser-drivable, solo)

Pick a Live-Now country (Kenya) → ⚡ green "Live Now". Pick the US → green "Available now · backed by
the global arbiters · local coming," and US appears in the featured zone. Search a random country
(Germany, Benin, Japan) → green "Available now," never the old dark/stranger landing. No red, no
darkness, no request form anywhere. Both dark + light themes. `npm run predeploy` green.
