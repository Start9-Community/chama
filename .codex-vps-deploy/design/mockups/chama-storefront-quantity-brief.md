# CC brief (POST-NAIROBI) — Storefront/menu per-item quantity + persistence

**The gap (verified in code).** A **menu Storefront** (multiple different items) or a **Curated Swap** is a SINGLE escrow consumed via `selectedItems` on lock — one buyer picks anything, funds it, and the *whole listing* becomes their trade and vanishes from Browse. No per-item quantity, no persistence. Only the **single-product multi-unit marketplace** path persists: `storefront.ts` (the #7 model) → `purchaseFromListing` → `buildChildCreateParams`, where the parent "stays a perpetual offer" (App.tsx:2089), stock is derived (`remainingStock`), and there's an "N left" badge + last-unit-race refund. The child-spawn model is **hard-guarded to single-product marketplace** (`storefront.ts:197`).

So a multi-item store where buyer A takes the soap and buyer B takes the rice is impossible today — A's order eats the whole shelf.

## The fix — generalize the existing parent→child stock model (pure + tested), don't rebuild it
1. **Per-item stock.** The create form already collects a per-item `maxQuantity` (`CreateForm.tsx:425`) — the engine ignores it. Carry each menu item's own stock so a menu listing tracks per-item availability instead of one parent `stock`.
2. **Spawn from a selected item.** `buildChildCreateParams` prices from the parent's single `amountMsats`. Make it (or a sibling) spawn a child from a **selected menu item** (its label / price / qty), so buying the soap spawns a soap-child.
3. **Relax the marketplace-only guard** (`storefront.ts:197`) to include **curated swaps (p2p-trade)**, so a swap menu persists + supports quantity. Decide with Jetty what "quantity" means for a swap (e.g. how many times this standing offer can be taken).
4. **Order flow:** a menu listing becomes a PARENT; selecting item X (qty N) spawns a child for X via the child-spawn path — *not* the whole-escrow `selectedItems` lock. The parent persists until each item's stock is exhausted; reuse the existing derived-stock / "N left" / oversold-refund machinery.

Net: different buyers buy different items from the same store, each item with its own quantity, the shelf persisting until sold out. Pure engine + UI; **no change to the per-trade state machine.** Brainstorm the swap-quantity semantics with Jetty before building. **Post-Nairobi.**
