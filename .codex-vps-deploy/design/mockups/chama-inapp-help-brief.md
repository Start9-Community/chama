# CC Brief — In-app Help/FAQ screen + contextual floating "?"

**Status:** ready to build. **Low-risk, UI-only, no money path.**
**Author:** cowork (advisory), 2026-06-24.
**Ship recommendation:** its **own quick minor** (e.g. 4.1.0), **ahead of the bond** — it helps
the just-launched Nairobi newbies now and shouldn't wait behind the fund-critical bond work.
**Leave uncommitted** (Jetty does the git split).

---

## 0. TL;DR

Two surfaces, both new (nothing like them exists in-app today except the pre-login WelcomeIntro):

1. **A Help & FAQ screen** reached from **Me → settings list** ("Help & FAQ" row). Content
   **mirrors `docs/FAQ.md`** — the same plain-language answers now live on the website.
2. **A reusable contextual "?"** (one small component) — placed first on the **arbiter
   application form**, explaining what an arbiter actually is before someone applies.

**Single source of truth = `docs/FAQ.md`.** The web page (`landing/faq.html`) already mirrors it;
the in-app screen becomes the third mirror. Keep the markdown canonical (see §4 sync note).

---

## 1. What exists / what's absent (read-verified map)

- **Screen router:** `src/ui/App.tsx:139` — a flat `View` union
  (`"browse" | "detail" | "create" | "me" | "saved-handles" | "payout-destinations" | "advanced"`),
  driven by `view` state + conditional render (`~2024-2599`). Bottom nav = 3 tabs
  (`browse | create | me`) via `TAB_FOR_VIEW` (`~164-172`), component
  `src/ui/components/BottomNav.tsx`.
- **No in-app help/FAQ/tooltip/"?" exists today** (only `ConnectScreen`'s `WelcomeIntro`, pre-login).
- **Arbiter form:** `src/ui/components/ArbiterApplyForm.tsx` — a fixed floating card opened from
  Browse's ⚖️ FAB (`BrowseView.tsx:~138-151`), fields: `statement` textarea + optional `fedInvite`.
- **Me settings list:** `src/ui/screens/MeScreen.tsx:~513-600` — a `T.card` list (appearance
  toggle, kind:0 toggle…). The natural home for a "Help & FAQ" row.
- **No modal/popover library** — modals are bespoke inline conditional renders + a fixed overlay +
  a blur backdrop (pattern in `BrowseView.tsx:~112-123`, `panels/FundWalletModal.tsx`). Reuse it;
  don't add a dependency.
- **Theme** `src/ui/theme.ts` (`T`): `bg/surface/card/border/text/muted`, semantic
  `accent/teal/purple/green/red/amber` (+`*Dim`), fonts `sans`(DM Sans)/`mono`(JetBrains Mono),
  radii `r`(12)/`rs`(8). Role colors are **sacred** — don't borrow them for help chrome.
- **FAQ content** lives only in `docs/FAQ.md` (+ `docs/FAQ.fr.md`) — **not** importable in-app yet.

---

## 2. Part 1 — the Help & FAQ screen

### Wiring
- Add `"help"` to the `View` union (`App.tsx:139`); conditional-render `<HelpScreen onBack={() =>
  setView("me")} />` in the router block. It's a **full screen**, not a modal (the content is long);
  no new bottom-nav tab — it's reached from Me.
- In `MeScreen.tsx` settings list, add a **"Help & FAQ"** row (subtitle: "Trading basics, getting
  paid, arbiter duties, recovery") that calls a passed `onOpenHelp` → `setView("help")`. Match the
  existing row style (`padding:"14px 16px"`, `borderBottom:1px solid ${T.border}`, a `→` chevron).

### Content module (the mirror)
- Create `src/ui/content/faq.ts` exporting typed sections authored **from `docs/FAQ.md`**:
  ```ts
  export interface FaqItem { q: string; a: string }              // a = plain text / light inline
  export interface FaqSection { id: string; title: string; items: FaqItem[] }
  export const FAQ_SECTIONS: FaqSection[] = [ /* basics, start, trade, money, safety, trouble */ ];
  export const FAQ_GLOSSARY: { term: string; def: string }[] = [ /* sats, Lightning, escrow… */ ];
  ```
- Sections mirror the website 1:1: **The basics · Getting started · Buying & selling · Getting your
  money (incl. 🇰🇪 M-Pesa one-tap + the per-transfer limit heads-up) · Account & safety ·
  Troubleshooting · Glossary.** Use the exact answers already in `docs/FAQ.md` (0.5% fee, "Chama
  never holds your money," recovery-key warning, etc.).
- **EN only now.** Structure for i18n later (FR/ES) but don't build the toggle — Jetty is
  translating the app as a separate pass. (When that lands, add a `lang` param and a `faq.fr.ts`
  mirror of `docs/FAQ.fr.md`.)

### Layout
- Reuse the visual language of `ConnectScreen`'s cards. An **accordion** (tap a question to expand
  its answer) keeps a long FAQ scannable on a phone; section headers as quiet `T.mono` labels (like
  the web page's eyebrow labels). Optional, nice-to-have: a top filter box that substring-matches
  questions (skip if it adds time — the accordion alone is enough for v1).
- A footer card mirrors the web "Still need a hand?" — link out to the app/Zapstore and the Nostr
  follow (njump), using the same npub already on the site.

---

## 3. Part 2 — the contextual floating "?"

### One reusable component
- Build `src/ui/components/HelpTip.tsx` (or `InfoPopover`) — a small **"?"** affordance that, when
  tapped, shows a short popover anchored near it, dismissed by tapping the **backdrop** (reuse the
  fixed-overlay + blur pattern from `BrowseView`). Props: `{ title?: string; children: ReactNode }`.
  No new deps. This is the "contextual floating '?'" — reusable anywhere later (fund modal, claim
  screen, create form), but **land it first on the arbiter form**.

### On the arbiter form (`ArbiterApplyForm.tsx`)
- Put a **"?"** in the card header ("BECOME A COMMUNITY ARBITER"). Tapping it explains the role in
  plain language **as it works today** (bonds are still dormant — do NOT describe them yet):
  - what an arbiter is (a trusted community member who can **break a tie in a dispute**);
  - that they **only step in when buyer & seller disagree** — not every trade;
  - that they **can never take your money** — escrow is 2-of-3, they only release to the side
    telling the truth;
  - that arbiters **build a public reputation** over time.
- A second, smaller "?" next to the **federation-operator** field, explaining that field is
  optional and strengthens your application (Level-A proof) — keep it one sentence.
- **Bond seam (do not build now):** leave a clearly-marked `// TODO(bond 2A): add "post a bond to
  raise your exposure cap" line here once BONDS_ENFORCED ships` so the copy gains the bond
  explanation the day Phase 2A lands — and not before (saying "post a bond" while it's
  non-functional would mislead).

---

## 4. The three-surface sync note (flag, don't ignore)

After this ships, the FAQ exists in **three** places: `docs/FAQ.md` (canonical) · `landing/faq.html`
(web) · `src/ui/content/faq.ts` (app). Keep **`docs/FAQ.md` the single source**; the other two
mirror it. For now **hand-mirror** (the content is stable). A future tiny build step could generate
both mirrors from the markdown — **note it as a backlog item, don't build it now** (YAGNI until the
FAQ churns often).

---

## 5. Scope, accessibility, ship

- **Pure UI, no money path, no reducer, no protocol** — lowest-risk change class. Safe to ship as
  its own minor ahead of the bond.
- **A11y:** the "?" gets an `aria-label="What is this?"`; the popover/screen is keyboard-dismissible
  (Esc) and focus-returns to the trigger; tap targets ≥ 40px.
- **Theme-only styling** (tokens above); verify in **both dark and light** (the app has a light
  mode — `MeScreen` appearance toggle).

---

## 6. Verification

- `npm run predeploy` green (typecheck + suite).
- Manual: Me → Help & FAQ opens, every section expands, links work; back returns to Me.
- Arbiter form "?" opens/closes via backdrop + Esc; copy reads right; **no mention of bonds**.
- Light + dark both legible.
- Spot-check the in-app answers against `docs/FAQ.md` so the mirror is faithful (esp. the 0.5% fee
  and the M-Pesa per-transfer limit line).

---

## 7. Seam map (read-verified, 2026-06-24)

| Seam | File:line | Action |
|---|---|---|
| Screen router / `View` union | `src/ui/App.tsx:139` (+ render `~2024-2599`) | add `"help"`, render `HelpScreen` |
| Bottom nav | `src/ui/components/BottomNav.tsx` | no change (Help isn't a tab) |
| Me settings list | `src/ui/screens/MeScreen.tsx:~513-600` | add "Help & FAQ" row → `onOpenHelp` |
| Arbiter form | `src/ui/components/ArbiterApplyForm.tsx` (header, fed field) | add `HelpTip`s |
| Overlay/backdrop pattern | `src/ui/components/BrowseView.tsx:~112-123` | reuse for `HelpTip` |
| Theme tokens | `src/ui/theme.ts` (`T`) | style with these |
| FAQ source | `docs/FAQ.md` (+ `.fr.md`) | author `src/ui/content/faq.ts` from it |
| New: Help screen | `src/ui/screens/HelpScreen.tsx` | create |
| New: content module | `src/ui/content/faq.ts` | create |
| New: "?" component | `src/ui/components/HelpTip.tsx` | create |

---

## 8. Open decisions for Jetty

1. **Ship order:** in-app help as its **own minor (4.1.0) before the bond** *(recommended)*, or
   fold into the bond release?
2. **Search box** in the Help screen: include now, or accordion-only for v1 *(recommended:
   accordion-only — add search later if the FAQ grows)*?
3. **FR in-app now or later:** EN-only now *(recommended — matches your "translate the app later"
   plan)*, or mirror `FAQ.fr.md` in this pass too?
