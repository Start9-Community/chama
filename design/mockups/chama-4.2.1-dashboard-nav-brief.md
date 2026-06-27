# CC Brief — 4.2.1 Dashboard-nav cleanup (tiny, surgical, no money-path)

**Status:** ready for CC. Standalone (not appended). Author: cowork, 2026-06-26. Leave **uncommitted**
(Jetty ships it as 4.2.1 via `npm run ship -- --patch`). **Scope: navigation + coach-tour only —
zero escrow/reducer/fund-custody touch.** Predeploy must stay green.

## Why (the anchor)
The first-run coach tour currently walks: **Browse → Create (pencil FAB) → Arbiter FAB → Create
(bottom tab, "in case you missed it") → Me.** Two of those are redundant/odd: the bottom **Create**
tab duplicates the pencil FAB, and the **Arbiter FAB** pushes a leader/recruitment decision at a brand-
new user who isn't a leader yet. Jetty's fix: **repurpose the bottom Create tab into a "Dashboard"
home** (the future home for standing / stats / earnings / ratings / the bond), **hide the arbiter
on-ramp for now**, and **leave create on the pencil FAB**. The real Dashboard ships later with the
bond (Phase 2A) — **this pass is just the rename + an inviting "coming soon" placeholder + hiding the
arbiter FAB + trimming the tour.**

## The four changes

1. **Rename the bottom-nav middle tab `Create` → `Dashboard`.** New icon (a gauge/stats glyph fits —
   your call; keep it in the existing nav-icon style). It is now a real nav destination, not a
   shortcut to the create form.

2. **Dashboard tab opens a "coming soon" placeholder screen** (a new lightweight screen/pane, same
   theme tokens as the rest of the app). Inviting copy, not a dead end — e.g.:
   > **Your Dashboard**
   > Your standing, your stats, your earnings — **coming soon.**
   > _Public ratings and your arbiter standing land here next._
   Keep it a single calm centered card. No actions required; it must render in both dark + light.

3. **Hide the Arbiter FAB** (the blue Listings/recruitment FAB → `ArbiterApplyForm` entry point).
   **Hide the entry point only — do NOT delete `ArbiterApplyForm` or the arbiter code.** It returns
   as the aspirational leader pitch when the bond (2A) lands. Simplest: gate the FAB render behind a
   `const SHOW_ARBITER_FAB = false;` (or equivalent) so re-enabling later is a one-line flip. The
   **pencil/create FAB stays exactly as-is** — create still works from it.

4. **Trim the coach tour to four clean steps: Browse → Create (pencil FAB) → Dashboard → Me.**
   Drop the arbiter-FAB step and the redundant second "Create (bottom tab)" step. Re-point what was
   the bottom-Create step at the new **Dashboard** tab with fresh copy (e.g. "Your home base — stats
   and standing are coming here"). The tour component (`src/ui/components/CoachMarkTour.tsx`) is
   generic and reads `steps` from the call site (App.tsx, `data-coach="…"` selectors) — edit the steps
   array + the `data-coach` attribute on the renamed tab. The tour already auto-skips a step whose
   target isn't on screen, so removing the arbiter step is safe.

## Seams (CC verifies)
- Bottom-nav render + the `Create` tab label/icon/route (App.tsx nav bar).
- The arbiter FAB render (App.tsx / BrowseView) — flag it off.
- Coach-tour `steps` definition + `data-coach` attributes (App.tsx) and `CoachMarkTour.tsx` (generic,
  likely untouched).
- New placeholder screen/pane for the Dashboard route.

## Guardrails
- **No escrow-engine, reducer, payments, or fedimint touch.** Pure UI/nav.
- Don't remove arbiter code — only hide its entry point.
- Create must remain reachable (pencil FAB) at all times.

## Verify (browser, solo)
First sign-in → tour is **Browse → Create → Dashboard → Me** (4 steps, no arbiter step, no duplicate
Create). Bottom bar reads **Dashboard** in the middle; tapping it shows the "coming soon" card (dark +
light). The arbiter FAB is gone; the pencil FAB still opens the create form and a trade can still be
created. `npm run predeploy` green.
