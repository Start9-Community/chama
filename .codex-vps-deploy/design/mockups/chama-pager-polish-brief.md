# CC brief — TradeView pager polish: cart-first landing + Chat unread badge

Small follow-ups on the new pager (`PagerPills.tsx` + `TradeDetail.tsx`). Display-only, no reducer change, leave uncommitted.

## 1. Confirm cart-first landing covers the buyer-join path (likely already done)
`TradeDetail.tsx:863` already sets `defaultPane = state.status === CREATED ? 1 (Details) : 0 (Chat)` — so a listing/menu opened to build an order (CREATED) lands on **Details**. Just verify this holds for the **buyer opening a menu/store listing to build a cart** specifically — if any join/seat/reserve flow re-scopes the view to Chat, keep Details as the pre-lock default. The intent (Jetty): a buyer should never land on Chat while the task is "build your order."

## 2. Make the cart-build action obvious on the Details pane (pre-lock)
When on Details pre-lock with a cart to build, surface a clear "build your order" affordance (a header/CTA on the Details pane), and make sure the `‹ ›` pager nudge is visible so they know the other panes are a swipe away. A first-timer landing here should immediately know "this is where I build my order, and I can swipe for chat."

## 3. Chat unread badge — iOS-style count on the Chat pill (the real new build)
Add an optional per-tab badge to `PagerPills` (`badge?: number`) and drive it for the **Chat** pill:
- Track `lastChatViewedAt` per trade — the timestamp when `activePane` becomes Chat (0). Persist per `escrowId` (localStorage), or in-memory if simpler.
- **Unread** = count of inbound chat messages (kind 38108, `msg.pubkey !== me`) with `created_at > lastChatViewedAt`. Human messages only — the living chat already shows system event bubbles inline; don't badge those.
- Render a small red circle with the count on the Chat pill (iOS app-badge style, capped e.g. "9+"). Clears to 0 the moment the Chat pane opens.
- Net flow: buyer builds their cart on Details → a message arrives → Chat pill shows ①  → they swipe over, it clears.

This is the iPhone-badge behavior Jetty asked for — the user can stay focused on the cart and still get pulled to Chat the moment the other party speaks.
