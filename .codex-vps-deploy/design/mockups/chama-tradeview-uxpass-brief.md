# CC brief — TradeView UX pass (the "make it sing" redesign)

Reshape `src/ui/screens/TradeDetail.tsx` (currently ~4,386 lines, everything-in-one-scroll) into a focused three-zone view. **The reducer / state-machine never changes — this is presentation only.** Mockups Jetty approved (clickable, faithful to `theme.ts`): `chama-tradeview-redesign-mockup-v4.html` (skeleton + roles + verticals) and `chama-living-chat-preview.html` (living chat). Leave everything **uncommitted** for Jetty's split; no `package.json` bump.

## The skeleton — fixed top · swipe middle · anchored bottom
1. **Fixed top:** the slim progress **spine** (Reserved → Locked → Settled; middle node recolors **amber** on a dispute) + the **one action card** (already driven by `detailNextStep`, ~line 3552). These never scroll.
2. **Swipe middle — a horizontal pager of three full-width panes: Chat · Details · Parties.** Chat leads (default pane). Each pane owns the full phone width. Use scroll-snap; the **whole region from the pills down is the swipe surface** (the pills row included — drag on the pills pages too; Jetty confirmed mouse-drag is just a mockup quirk, so wire touch + pointer drag so it's real on device).
3. **Anchored bottom:** the **trade timeline** (today's event chain) collapsed behind a **visible** anchor row with a rotating chevron (the demoted "technical log").

## The pager pills — reuse the Create segmented control
The Chat/Details/Parties indicator must be the **same sliding segmented control** as Create's single↔storefront toggle (`CreateForm.tsx:1535`, the "sliding segmented control between a single listing and the storefront"). Same rounded-pill language Jetty already designed — minimal, names-only, active segment filled. Plus a gentle nudging ‹ › swipe hint. Keep it visually distinct from the spine above (text pills vs progress nodes).

## The action card — per-role, gated, vertical-aware
Drive from the existing `detailNextStep` + the real vote buttons (`onVote`, `handleReleaseTap`, `releaseButton`/`refundButton` ~line 2246–2285). Each role sees its true action:
- **Funder (buyer in marketplace; seller in swap/loan):** big **Release** (green, pays the performer by name) + **Refund** demoted to a quiet line. First-voter keeps the existing plain-primary + cancel-link pattern.
- **Performer (seller in marketplace; buyer in swap/loan):** the **mark-done** button (see wording below), then waits; refund/back-out demoted.
- **Arbiter:** the **dual ruling** — "Release → {name}" / "Refund → {name}", each tinted in the **recipient's** role colour (the existing `arbiterReleaseColor`/`arbiterRefundColor`), so the decision names who gets paid.
- **GATE both adjacent money buttons.** Extend the existing two-tap arm-to-confirm (`handleReleaseTap` → "tap again to confirm", `releaseArmed`) to **both** Release and Refund/dispute in **every** vertical — not only the `performRisk` case — because they sit side by side. One tap arms (amber, "tap again to confirm — pay {name} {amount}"), second fires, auto-disarm ~3s. Refund stays semantically never-blocked, but still gets the misfire arm.

## Vertical-aware wording — NAIL THIS (Jetty's emphasis: every vertical + every participant view)
All copy flows from the existing **`getVoteLabel(category, fulfillment, voteRole, outcome)`** dictionary — it's the source of truth; don't hardcode. Two specifics:
- **Mark-done verb keys off `state.fulfillment`:** shipping → **"Mark delivered"** (📦); service → **"Mark completed"** (✓). Carry the same per-vertical tone to swap (**"Mark sent"** 💸), lending (**"Mark repaid"** ↩), CBP (**"Mark paid"** ✓).
- **Make the vertical obvious** (users don't infer it from vote labels): a mono **vertical kicker over the trade title** in the nav, **and** a tag on the **Details** pane header (e.g. `DETAILS · MARKETPLACE · GOODS`).
Verify the exact strings per (vertical × role) against `getVoteLabel` so the participant view reads right everywhere — this is the bit Jetty most wants nailed.

## The nav — a real back button
Replace the bare `‹` with a **bigger, circled ← ** (≈38px tap target, properly centered), trade title beside it, vertical kicker above the title, status pill trailing.

## Living chat — weave trade events into the conversation
Make the Chat pane a **single time-sorted feed** of `state.chatMessages` (kind 38108) **+ system event bubbles derived from `state.eventChain`** lifecycle transitions. **Display-only — derive from existing events, publish nothing new.** Reuse the notification copy for consistency. Event → bubble:
- reserved · **locked** ("⚡ Sats locked in escrow") · delivered/completed/sent/repaid/paid · **vote cast** ("🗳️ {name} released → pays {name}") · **ready to claim** ("✅ Your claim is ready") · **disputed** ("⚖ Dispute opened") · **settled** ("🎉 Settled — {amount} moved to {name}") · timed out.
- Centered system-bubble style, colour by meaning (purple lock, green done, orange vote, amber dispute). The existing "📦 Marked as delivered" structured message (rides 38108) stays as-is; the rest are rendered from the chain.

## Font — enforce DM Sans + JetBrains Mono
`theme.ts` already declares `sans:'DM Sans'` / `mono:'JetBrains Mono'` but they're never loaded → system fallback (the "ugly" current look). **Self-host/bundle both webfonts** so the app renders like the mockups.

## Constraints
No reducer / state-machine change (system bubbles + all wording are display-derived). Browser + native identical. No version bump. Uncommitted for Jetty's split. Tests: keep the suite green; any new pure helpers (e.g. event→bubble mapping, fulfillment→verb) get asserts in `tests.ts`.
