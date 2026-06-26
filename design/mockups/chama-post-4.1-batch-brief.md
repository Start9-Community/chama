# CC Brief — Post-4.1.0 batch (the full queue)

**Status:** ready to hand to CC. **4.1.0 is shipping**; this is everything queued after it, in
priority order. Standalone (not appended). Author: cowork, 2026-06-26. Leave uncommitted.

Each item is self-contained. Everything here is UI/data **except E (the bond)** — only E touches the
fund-custody path. Suggested order is the section order: **A → B → C → D → E.**

---

## A. DO FIRST — the rating CTA is hidden at completion (quick)

CC's #17 (ratings-in-chat + green glow + "💬 Chat is closed") **works and looks great** — but at
`COMPLETED` the chat doesn't scroll to it, so the 👍/👎 lands **below the fold** (Jetty's two
screenshots: the CTA is only visible after a manual scroll). Everything is correct; only the **reveal**
is missing.

- **Fix:** when the trade reaches `COMPLETED` / the rating CTA mounts, **auto-scroll the chat feed to
  the bottom** so the CTA is in view. The existing `chatEndRef.scrollIntoView` (`ChatPanel.tsx:~243`)
  fires on `state.chatMessages.length` change — it does **not** fire on the COMPLETED status change
  (no new message), which is why the CTA stays off-screen. Add a scroll trigger keyed on the CTA
  appearing (status→COMPLETED, or `ratingCta` going non-null).
- **Center the CTA box** — it reads slightly off-center; Jetty: "looks gorgeous, just needs centering."
- Seam: `ChatPanel.tsx` (the trailing `RatingTap` render + the `chatEndRef` effect). Tiny.

## B. 4.1.1 Tauri fixes (recipes already in hand)

- **#16 offramp redirect (+ Help-screen links).** Root cause: `openExternalSwap` uses `window.open`
  (`external-swap-registry.ts:292`), which the Tauri webview blocks — so **every** redirect offramp
  (Bitika/Chapsmart/Banxaas/Bitzed) **and** the Help footer links are dead on native (Tando survives
  because it's a LUD-16 invoice, not a redirect). **Fix:** add `@tauri-apps/plugin-opener` (JS dep +
  Rust plugin in `src-tauri`) + an `opener:allow-open-url` capability; call it under `isTauriRuntime()`,
  scoped to registry/trusted URLs only. One helper fixes the whole class. (Validate on a Tauri/APK
  build — not browser-testable.)
- **#18 chat-input focus glitch.** Tapping the chat bar sometimes doesn't focus/select mid-trade
  (suspect Tauri-only). Needs a device repro; likeliest a WKWebView nested-scroll / keyboard-`dvh`
  quirk under the new fixed-rectangle layout.

## C. US ACTIVATION batch (high value — the data backs it)

Zapstore insights: **~846K US impressions / month, downloads capped** by the "is it even live here?"
perception. Three moves convert that demand:

### C1. Simplify onboarding (cut the relic)
- `GlobeCountryPicker.tsx`, the **no-local-Chama branch (~171-206)**: **delete the request-a-Chama form
  + the "become a leader/arbiter" copy** from onboarding entirely — 99% of new users aren't leaders;
  don't fork them at signup. Replace the deterring *"no arbiters here, an arbiter would be a stranger"*
  with a **reassuring** line: *"You're trading {country}'s sats, backed by Chama's global arbiters until
  a local Chama launches — your country goes fully Live soon."* (true now — the G-Bot feds are
  native-verified + cabinet-backed). One clean **Continue → nsec → in.** No second decision.
- **Add a light tap/next coach-mark tour** (NymChat-style: "Step X of N" · Back/Next/Skip), shown once
  after first sign-in, pointing at the **3 bottom-nav buttons (Browse/Create/Me) + the 2 FABs** with
  short "here's what you can do" copy. Skippable; device-local "seen" flag (mirror `chama_intro_seen`).
  Goal: let them **see the home screen first**, not be glued to a globe and a form.
- **Move the arbiter on-ramp entirely to the blue Listings FAB** (`BrowseView` "Arbiter recruitment" /
  `ArbiterApplyForm`), reframed as the **aspirational leader pitch** — army-recruiter voice ("If you
  want to lead your community, or already do…") that self-selects leaders — plus a **teaser** of the
  bond ceremony: *you'll need two more trusted people (not today), keep trading meanwhile, riding the
  OG arbiters' coattails.* Full ceremony detail fills in when 2A lands; for now a teaser + a link to
  the FAQ's arbiter section (the HelpTip "?" already explains the role).

### C2. US reads "Live" (#20)
- The US (`us-gbf` / GBF) is already a real, native-verified community — it just needs to **read Live**
  in the picker instead of falling into the "no local Chama" path. Surface the native-verified G-Bot
  communities as **Live** so US/Germany/Benin users see availability where they actually are. Pairs with
  C1 (same perception, same fix surface).

### C3. Strike US off-ramp — the one-tap USD cash-out
- Per **DECISIONS 2026-06-26** ("US fiat off-ramp = pay a fiat-converting Lightning Address") + the
  matching BACKLOG entry: build a **lighter mirror of `tando-offramp.ts`** → `strike-offramp.ts`. A
  Strike username is a LUD-16 address; paying it (the **existing** claim BOLT11-OUT path) converts
  sats→USD in the **user's own** Strike account. **Zero new custody / money-transmitter surface.**
  Build: `isStrikeLightningAddress()`, `isUSPayoutContext()` (analog to `isKenyaPayoutContext` —
  match `us-usd`/GBF/USD), a one-time "flip Strike to receive **Cash**" hint, saved in the
  payout-destinations store; provider-agnostic (Cash App / Bitcoin Well are drop-in siblings). Show
  "≈ $X at Strike's rate," never a guarantee. The DECISIONS + BACKLOG entries are the full spec.

## D. Other queued items

- **Trade durations per category** (LOCKED): Exchange **3h** · CBP **3h** · Marketplace **1 day** ·
  Lending **7-day cap** (repayment-based) + bounded creator customization within per-category clamps
  (`expirySeconds` exists, consensus-safe). Surface the tradeoff when extending; keep hard min/max
  clamps. **Lending → "coming soon" on Create** (repayment flow unwired). **CBP monthly bills → stay
  "coming soon" until the storefront/menu persistence fix lands** (recurring bills depend on it).
- **Cross-device / cross-chama trade continuation:** tapping "continue" on a trade whose chama ≠ this
  device's current chama should offer a one-tap **"switch to [that Chama] to continue"** (switching
  *toward* the trade's fed is safe + necessary). **Do not** relax the existing block on switching
  *away* from a fed where you hold an active trade.
- **#12 vote-#2 latency / UI glitch** — adversarial investigation: separate relay-propagation timing
  (the *resolving* vote must reach all parties) from UI re-render thrash on resolution/claim.
- **#13 bridge-incompatible banner** — auto-clear once a compatible bridge responds; nag only after
  automatic retries are exhausted.

## E. SEPARATE TRACK — Finish the bond (Phase 2A)

See **`chama-arbiter-bond-phase2-brief.md`** (written, decisions locked). Real SSS-lock custody +
bonding ceremony + cabinet heal/relock + loud heal-prompt, **enforcement OFF**, proven on **GBF
native** (Jetty plays the self-cabinet) then **BLF** (real trio). This is its own focused effort —
the keystone is the money-path custody, not the enforcement flip. **Don't lump it into A–D.**

---

**Theme:** A/B = finish 4.1's polish; **C = "US activation"** (the 846K demand has a working path);
D = housekeeping; E = the bond. Nothing in A–D touches fund custody.
