# CC Brief — Help screen: readability + focus-on-expand (4.1.0, BEFORE ship)

**Status:** ready to build. **Pre-ship polish of the 4.1.0 Help screen** — Jetty wants it readable
before 4.1.0 ships. UI-only, Help screen only, no money path.
**Author:** cowork (advisory), 2026-06-25. **Leave uncommitted.**

**The problem (Jetty, from a live screenshot):** the FAQ answers are cramped and hard to learn from.
Three concrete causes in the code:
1. **Numbered steps run together.** `faq.ts` answers like "How do I buy/sell something?" are a single
   string with inline `1. … 2. … 3. …` and **no line breaks**, so `HelpScreen.tsx`'s
   `whiteSpace: "pre-line"` (line ~87) has nothing to break — they wrap into one block, numbers not
   aligned.
2. **The answer is small and low-contrast** — `fontSize: 12.5`, `color: T.muted` (HelpScreen.tsx:87).
   "Small writing is not ideal to learn about something new."
3. **No focus.** Expanding a question changes nothing else on screen, so the answer competes with all
   the other rows.

Jetty's directive: **"This is NOT the place to shy away from space."** Make the *answer* big and
spacious when open, and let everything else recede until the user collapses it.

---

## Fix 1 — Numbered steps render as a real, aligned list

Restructure the content so numbered answers are *structured*, not a flattened string.

- In **`src/ui/content/faq.ts`**, widen `FaqItem.a` to accept steps:
  ```ts
  export interface FaqItem {
    q: string;
    a: string | { intro?: string; steps: string[]; outro?: string };
  }
  ```
- Convert the numbered answers to the steps shape (currently flattened): **"How do I buy something?"**,
  **"How do I sell something?"**, and the **"How do I cash out to M-Pesa?"** steps. Keep `docs/FAQ.md`
  as the source of truth (it's already a markdown numbered list — the `steps[]` mirror it 1:1).
- In **`HelpScreen.tsx`**, render steps as a proper hanging-indent list (a real `<ol>`, or a flex
  row per step): a fixed number column + the text column, each step on its own line, with vertical
  spacing between steps, so wrapped lines of step 2 align under step 2's *text*, not under "2.".
- Plain-string answers keep rendering as a paragraph (most answers stay strings).

> Lighter alternative if you'd rather not touch the content model: put `\n` between steps in the
> strings — but that alone won't give true hanging-indent alignment (wrapped lines misalign), so the
> structured `steps[]` is the recommended path.

## Fix 2 — Make the answer BIG and legible

In the open-answer block (HelpScreen.tsx:~87):

- **`fontSize: 12.5 → ~16` (16–17)**, **`color: T.muted → T.text`** (full contrast), **`lineHeight`
  ~1.7**, and **more space** — bump the padding (e.g. `"4px 16px 18px"`) so the answer breathes.
- The answer is where the learning happens — it should be the most legible thing on the screen.
- **Questions:** a modest bump is welcome (`13.5 → ~15`), but the **answer is the priority** — Jetty
  is fine with the current question size *as long as the answer is way bigger*. Don't shrink anything.

## Fix 3 — Focus-on-expand (the core ask)

The accordion is already single-open (`open: string | null`, HelpScreen.tsx:12) — perfect for "view
JUST THAT." When something is open (`open !== null`), make the open answer the **hero** and let
**everything else recede** until manual collapse:

- **Recede the rest:** every non-open row, the section labels, the glossary, and the footer get a
  **dim (`opacity ~0.35`) + a light blur (`filter: blur(1.5px)`)**, with a smooth `transition: opacity
  .2s, filter .2s`. They **stay tappable** (so the user can collapse or jump to another question) —
  they just clearly step back.
- **Hero the open one:** full opacity/contrast, the big type from Fix 2, generous space. Optionally
  give the open card a subtle lift (slightly stronger border or a hair of shadow) so it reads as "on
  top."
- **On collapse** (`open === null`): everything returns to equal, fully scannable.
- Net flow Jetty described: *browse the questions smoothly → land on one → view just that answer, big
  → collapse → repeat.*

> "Compact everything else" and "blur the rest lightly" are the two options Jetty floated — the
> dim+blur above is the cleaner of the two and keeps the other rows usable. If you want even more
> focus, also tighten the non-open rows' padding while something is open. Your judgment.

---

## Seams

- **`src/ui/screens/HelpScreen.tsx`** — the accordion map (lines ~60-96): apply the recede style to
  non-open items + labels when `open !== null`; the answer block (~86-90): bump size/color/space +
  render `steps[]` as an aligned list. Glossary (~99-109) + footer (~111-127): recede when `open !==
  null`.
- **`src/ui/content/faq.ts`** — `FaqItem.a` → `string | { intro?, steps[], outro? }`; convert the 3
  numbered answers.

## Verification (you can drive this solo in the browser — you did last time)

- A numbered answer ("How do I buy something?") renders as an **aligned list**, one step per line,
  numbers lined up, wrapped text hanging under the step text.
- The open answer is **big and high-contrast**; expanding **dims + lightly blurs** everything else;
  collapsing restores the full scannable list.
- Both **dark and light** legible.
- `npm run predeploy` green.

## Scope / ship

UI-only, Help screen only, no reducer/money path. **Folds into 4.1.0 before it ships** (Jetty's
gating this on it). No new deps.
