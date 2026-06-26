# CC Brief — 4.1.0 "newbie-polish" batch (UI only, no money path)

**Status:** ready to build. Four UI items + the already-written **in-app help** brief
(`chama-inapp-help-brief.md`) make up the **4.1.0** "make-the-launched-app-solid" release.
**None touch the escrow/money path** — lowest-risk change class. Ship ahead of the bond.
**Author:** cowork (advisory), 2026-06-24. **Leave uncommitted** (Jetty does the git split).

Items: **1. Ratings-in-chat · 2. TradeView fixed-rectangle + lifecycle-aware default pane ·
3. CBP bill-type picker (#12) · 4. Chat unread badge (#15)** (+ the help screen = E, separate brief).

---

## 1. Ratings-in-chat — put the 👍/👎 where the user actually is

**Problem (Jetty, verified):** the `RatingTap` (👍/👎 "How was your counterparty?") renders only on
the **Parties** pane (`TradeDetail.tsx:2944`, on `COMPLETED`) and the **Me → Trade History** card
(`MeScreen.tsx:735`). At completion the user is in **Chat** — voting, chatting, watching the
"Settled" bubble — *not* on Parties. So the prompt sits where they aren't looking. Today it's a
near-total miss.

**Fix:** surface the **same `RatingTap`** inline at the **end of the Chat feed** when the trade is
`COMPLETED` and the viewer hasn't rated yet. **Keep** the Parties + Me-history copies (don't move,
add) — all three read the same `myGivenRatings`, so rating in any one collapses the others to the
"you rated 👍" state automatically.

**How (reuse, don't reinvent):**
- `TradeDetail.tsx:2170` already passes `systemBubbles={livingChatBubbles}` into `ChatPanel`. Thread
  the rating props through too: `ratingCta={ status===COMPLETED && counterpartyToRate(state,pubkey)
  && !alreadyRated ? { tradeId, ratee, ratedThumb, onRate: onRateCounterparty } : null }`.
- In `ChatPanel.tsx` (messages container `:316`), after the woven feed's last item, render
  `{ratingCta && <RatingTap {...ratingCta} leading />}` as a trailing card (styled like a system
  bubble, pinned just above the input). The existing auto-scroll (`:243`) brings it into view at
  settle.
- Reuse `RatingTap.tsx` (kind:38123), `counterpartyToRate()`, `myGivenRatings` verbatim — no new
  rating logic, just a third render site + prop plumbing.

**Seam map:** `RatingTap.tsx` (component) · `TradeDetail.tsx:2944` (Parties — reference), `:2170`
(ChatPanel props — add `ratingCta`) · `ChatPanel.tsx:316` (feed end — render it) ·
`reputation/ratings.ts` (`counterpartyToRate`, `RatingThumb`).

**Verify:** complete a trade as buyer and as seller; the 👍/👎 appears in Chat right under
"Settled"; tapping it records once and the Parties + history copies show "rated"; no double-publish.

---

## 2. TradeView fixed-rectangle — kill the post-2nd-vote scroll

**Problem (Jetty, verified):** the view is meant to be a fixed rectangle (the swipe-pager exists for
exactly that), but it scrolls inconsistently and "after the second vote the bottom becomes
scrollable by mistake." Root cause, confirmed in code:
- `.trade-detail-shell` is **`overflow-y:auto`** (`App.tsx:2790`) — the shell itself scrolls.
- the pager carries a hard floor **`minHeight: clamp(150px, 22dvh, 380px)`** (`TradeDetail.tsx:2164`).
- the **action card** (top zone, `~1140+`) is **unconstrained** and grows through the lifecycle
  (funding banners → vote buttons → *armed-confirm* → refund picker → claim button).
- So once the action card grows (the 2nd-vote → armed/resolution phase), `top zone + 150px pager
  floor + timeline` exceeds the viewport → the **shell scrolls** → no longer a fixed rectangle.

The code comment at `:2143-2146` shows the author already hit this tradeoff and chose
"scroll the shell" over "clip the timeline." We can do better and get the fixed rectangle.

**Fix — make it a true fixed-viewport flex column:**
1. `.trade-detail-shell` (`App.tsx:2790`): pin the height to the viewport and **`overflow:hidden`**
   (replace `overflow-y:auto`). Keep `max-width:480px; margin:0 auto; display:flex;
   flex-direction:column`.
2. **Top zone** (header + stepper + **action card**): wrap in a container that is
   `flex:0 1 auto; min-height:0; overflow-y:auto`. A rare tall phase (NWC banner + handle reveal +
   refund picker) then scrolls **inside this zone**, never the shell.
3. **Pager** (`td-pager`, `:2157-2165`): **drop the `minHeight` floor** → `flex:1 1 0;
   min-height:0`. It fills the remainder; the chat scrolls internally (`ChatPanel` already uses
   `flex:1; minHeight:0` when `fill`, `:316`).
4. **Timeline**: render as a compact **fixed footer** `flex:0 0 auto` (always visible) — this is what
   removes the author's original "the pager would obstruct the timeline" worry: the timeline can't
   be obstructed if it's a pinned footer.

**Dynamic split (Jetty, 2026-06-25):** lock the OUTER rectangle **always** — there's plenty of space.
The top zone claims the extra height *only while* lock/claim controls are actually present, and
**yields it back** to the chat once funded / after a successful claim. The outer frame never moves;
only the internal top-vs-chat divide flexes.

Result: one stable rectangle across **every** lifecycle state; the only scroll is inside the chat
(expected) or inside the top zone on rare tall phases. The 2nd-vote glitch disappears because the
resolution/claim content now grows **within** the `flex:0 1 auto` top zone, not the shell.

**Keep intact:** the horizontal swipe pager (`goPane`/`onPagerScroll` `:876-886`, `PagerPills`,
`TD_PANE_STYLE` `:3745`) — we're fixing **vertical** height only. Re-test swipes after.

**Seam map:** `App.tsx:2790` (`.trade-detail-shell` CSS) · `TradeDetail.tsx:969` (shell), `~1140`
(action card → wrap in scroll zone), `2147` (`td-lower`), `2157-2165` (`td-pager` minHeight→0),
`~2140` (timeline → fixed footer), `3745` (`TD_PANE_STYLE`) · `ChatPanel.tsx:316`.

**Verify (the lifecycle matrix — this is the whole point):** for buyer, seller, AND arbiter, walk
**reserved → locked(funding) → marked-sent → vote → 2nd vote/armed → released → claim → settled**
and confirm at **every** step the outer shell does **not** scroll, the timeline footer stays
visible, and only the chat scrolls. Specifically reproduce the old 2nd-vote case from Jetty's
screenshot and confirm it's now a clean rectangle. **Test Tauri and APK separately** — Jetty
suspects the glitch may be **Tauri-only**; if so, suspect a webview `dvh`/viewport-height quirk, but
the fixed-rectangle restructure above should resolve both platforms.

---

## 2b. Lifecycle-aware default pane — surface the tab that matches the next action

**Insight (Jetty):** the *right* tab depends on the step AND the viewer's role, because the
obligation differs. The fixed rectangle (item 2) is the frame; this is what it opens to.

- The party who owes **fiat / a service** (buyer in sats↔fiat, payer in CBP) needs, at the pay
  moment: the **counterparty's payment handle (phone / paybill), the premium, and the full agreed
  cost breakdown** — all on **Details**. Surface it HARD right there.
- The receiver/seller (waiting on the fiat) wants **Chat** — to catch the "sent" + proof.
- From the **second vote → claim → settled**, it's all coordination/confirmation → **Chat** (and
  the rating CTA renders there at settle, item 1).

**Policy — `defaultPaneFor(state, myRole)` (the pane the trade OPENS to):**

| Step / who | Default pane |
|---|---|
| CREATED / RESERVED (pre-lock) | **Details** — see terms before funding (current behavior) |
| LOCKED · you owe the fiat/service · not yet marked-sent/voted | **Details** — handle + premium + full breakdown, surfaced hard |
| LOCKED · you're the receiver/seller (waiting on fiat) | **Chat** — watch for "sent" + proof |
| vote2 / RELEASED / CLAIM / SETTLED / disputed | **Chat** (rating CTA at settle) |

- Replace today's `defaultPane = status===CREATED ? Details : Chat` (`TradeDetail.tsx:867`) with
  `defaultPaneFor(state, myRole)`.
- Compute on **open** (mount) AND fire a **single, deliberate auto-focus to Details** when the
  status first advances into the "you owe fiat now" state (reuse `goPane` `:876`). **Guard:** a
  manual swipe in the session wins forever after — never yank a user who moved themselves; the
  auto-focus fires at most once per status transition.
- The Details **content already exists** (payment method, premium, breakdown) — "we're already
  doing most of that." The work here is (a) the focus logic and (b) a **bold "checkout" headline**
  at the pay moment: one unmissable line — **"You owe KES 80"** (the FINAL fiat, premium already
  applied) — as the single largest, boldest element on Details, sitting above *who to pay (the
  handle)* and *what was agreed (the breakdown, e.g. KES 50 → KES 80)*. **Both parties see the same
  number**, so there's zero ambiguity about the amount or the direction. The breakdown already
  renders — this **promotes the final figure to a headline**, phrased as an obligation ("You owe…"
  for the payer / "You'll receive…" for the seller).

**Seam:** `TradeDetail.tsx:867` (`defaultPane`), `:869` (`activePane`), `:876-886`
(`goPane`/`onPagerScroll` — reuse for the one-time focus) · the Details pane render (payment
handle + premium + breakdown — confirm prominence) · a small "who owes fiat at this status" helper
(role + status).

**Verify:** as the **payer**, open the trade right after lock → lands on **Details** with the
handle + amount-to-pay front and center; swipe to Chat, it stays (no yank); as the **seller**, the
same trade opens on **Chat**; at settle, both land on **Chat** with the rating CTA.

---

## 3. CBP bill-type picker (#12) — Kenya-first

**Problem:** Community Bill Pay listings (`CreateForm.tsx`, vertical `bill-pay` `:82-87`) carry
amount / description / fiat / premium / payment-methods but **no bill type**. A bill type makes a
CBP listing legible ("what am I paying?"), helps a volunteer payer decide, and enables Browse
filtering later.

**Fix:** add an **optional** `billType` field to the CBP create form, options driven by the home
community's **country**, slotted after the description (`~CreateForm.tsx:2050-2084`, before premium).
It is **informational metadata only** — it does **not** change escrow logic. Persist it on the CBP
listing payload; show it on the trade card + detail. Optional (never gate posting); "Other" catches
the long tail.

**Proposed Kenya list (Jetty to confirm — you're the one testing in Nairobi):**

| # | Bill type | Why it's on the list |
|---|---|---|
| ⚡ | **Electricity — KPLC** (tokens / postpaid) | The #1 prepaid bill; "tokens" bought constantly |
| 💧 | **Water** (county, e.g. Nairobi Water) | Monthly utility, M-Pesa paybill |
| 🎓 | **School fees** | Large, lumpy, M-Pesa-paid — a top reason to pre-fund sats |
| 🏠 | **Rent** | Common M-Pesa/P2P payment |
| 📺 | **TV** (DSTV / GOtv / Zuku) | Recurring subscriptions |
| 🌐 | **Internet / home fibre** (Safaricom Home, Zuku, Faiba) | Recurring |
| 📱 | **Airtime & data** (Safaricom / Airtel) | Tiny, frequent top-ups |
| 🛡️ | **Health — SHA / SHIF** (replaced NHIF, Oct 2024) | Monthly statutory contribution, paid via M-Pesa |
| 🔥 | **Cooking gas** (LPG refill) | Frequent household top-up |
| 🧾 | **Other** (M-Pesa Paybill / Buy Goods) | Catch-all for anything missing |

Keep it a **per-country registry** (`src/communities/bill-types.ts`, keyed by community country) so
Senegal/Benin/etc. add their own later. Kenya ships first; others fall back to a generic
{Utilities, Rent, School fees, Airtime, Other} until localized.

**Seam map:** `CreateForm.tsx:82-87` (CBP vertical), `~89-107` (`FormState` + `billType?`), `~115-129`
(`MenuDraftItem` + `billType?`), `~2050-2084` (UI slot), `~1665` (`homeCommunity` for country) · the
CBP payload + trade card/detail display · new `src/communities/bill-types.ts`.

**Verify:** post a CBP listing with each Kenya type; it shows on the card/detail; an empty/"Other"
type still posts; a non-Kenya community shows the generic fallback.

---

## 4. Chat unread badge (#15) — and a question on "cart-first"

**Unread badge (clear, build it):** there is **no** read-tracking today — `chatMessages` live on
`EscrowState` (`types.ts:864`); no `lastRead`/`unread` anywhere.
- Store a per-trade **`lastReadChatAt`** (unix s) in **localStorage scoped by trade id** (device-local
  pref, NOT on `EscrowState`) — reuse the scoped-storage pattern from `notify-service`'s fired-tags.
- On opening a trade's **Chat** pane, write `lastReadChatAt[tradeId] = now`.
- `unread(tradeId) = chatMessages.filter(m => m.created_at > lastReadChatAt[tradeId] && author !==
  me).length`.
- Badge: a dot/count on the **Chat** pager pill (`PagerPills`) + on the **trade-list card**
  (Me/Browse `TradeCard`); optional small dot on the **Me** bottom-nav tab when any trade has unread.
- New helper `src/chat/unread.ts` (store + count); wire mark-read in `ChatPanel.tsx`.

**"Pager cart-first landing" — needs one clarification before I brief it.** The app has **no
main-nav pager** — it's flat bottom-tabs (`browse | create | me`, default `browse`, `App.tsx:390`),
and the only swipe-pager is the TradeDetail Chat/Details/Parties one. So "**pager cart-first
landing**" is ambiguous. Which did you mean: (a) **storefront/menu** flow opening on the **cart**;
(b) the **app** landing on something other than Browse at startup; or (c) the **TradeDetail** pager
defaulting to a different pane? Tell me which and I'll brief it — the unread badge above is
independent and ready regardless.

**Seam map (unread):** `ChatPanel.tsx` (mark-read on view) · `PagerPills` (badge the Chat pill) ·
`TradeCard` (badge the card) · `BottomNav.tsx` (optional Me dot) · new `src/chat/unread.ts`.

---

## Follow-on fold-in (2026-06-25 — Jetty's post-build punch list; fold into THIS uncommitted 4.1.0)

Surfaced while Jetty verified 4.1 live (Tauri sandbox). Land #17 + #19 in 4.1.0 (they finish the
ratings + TradeView stories); #16/#18 can ride along or follow as 4.1.1.

- **#17 — Chat closes at completion.** After `COMPLETED`, **mute the chat input + Send** (messages /
  images currently vanish into the void), make the in-chat **ratings CTA glow / prominent**, and add a
  gentle **"Chat is now closed"** line. Completes the ratings-in-chat (item 1) story.
- **#19 — Pager hard-snap.** Chat/Details/Parties swipe must land **hard on one pane per gesture** — no
  far-left→far-right multi-pane fling. Tighten scroll-snap / clamp to ±1 pane per swipe.
- **#16 — Offramp redirect.** Bitika's (and Chapsmart's) green "open the swap" button doesn't redirect
  — wire the provider redirect URL. (Tando one-tap works.)
- **#18 — Chat-input focus glitch.** Tapping the chat bar sometimes doesn't focus/select mid-trade
  (Jetty suspects Tauri-only) — check focus handling under the new fixed-rectangle layout.
- **FAQ 3-surface sync.** `docs/FAQ.md` was missing the M-Pesa per-transfer-limit Q&A the website
  already carries — now **added to `docs/FAQ.md`**. **Mirror that exact Q&A into
  `src/ui/content/faq.ts`** so all three surfaces (markdown · web · in-app) match.

## Shared verification (all four)

- `npm run predeploy` green (typecheck + suite).
- Both **dark and light** themes legible (the app has a light mode).
- A11y: tap targets ≥ 40px; the rating CTA + badges have `aria-label`s.
- Nothing in this batch may touch the reducer / escrow / money path — diff-check that it doesn't.
