# Design — #7 Multi-unit stock (listing-as-template + child escrows)

Status: protocol locked. Race policy = **Option A (optimistic + refund)**, chosen.

## Decision log (from review)

- The *original* #7 pain was narrower than this doc: on today's single-unit
  model, two buyers join one listing concurrently; buyer 1 locks; buyer 2 is
  left thinking they joined while the seller is heads-down on buyer 1 (buyer 2's
  JOIN is effectively orphaned). That is a **contention-visibility bug we fix
  now** (Stage 0 below) — surface the active hold to non-holders as
  "reserved — being viewed, Ns left" so buyer 2's state is honest, not phantom.
- The **storefront** (template + children) is the strategic direction that
  subsumes it — "sellers can't be required to post one listing consumed
  immediately." Built in stages after Stage 0. The Stage 0 contention UI is
  reused as the storefront's last-unit countdown.
- Race policy: **Option A**. Overcommit resolves through the existing refund
  path; escrow protects every party so it's a UX wrinkle, never a loss.

## Stage 0 — immediate contention fix (current single-unit model)

Ship first, independently. When a viewer who is NOT the holder opens a CREATED
listing that already has an active (non-expired) buyer `joinHold`, show a
"reserved — being viewed by someone · Ns left" banner with the hold's
`expiresAt` via `CountdownTimer`, and don't present a join/lock affordance as if
the slot were free. If the hold expires → it frees (they can join). If it locks
→ taken (hidden). Solves the stranded-buyer-2 bug and is the storefront's
last-unit countdown later.

## Goal

A listing carries a real stock count. Multiple buyers each take units
concurrently; the listing stays browsable showing "N left" until sold out.
When only the last unit is left and it's being held, other viewers see a
"being viewed — Ns left" public countdown (the #7 ask, `<2 but >0` gate).

## Why the model must change

Today: one CREATE event **is** the escrow (its `d`-tag). For a marketplace
listing the **seller creates** it and the **buyer locks** (funds) it directly
(state-machine.ts:543 — `marketplace → buyer locks`). One listing → one buyer →
gone on LOCK. A 2-of-3 escrow (buyer/seller/arbiter, SSS shares, votes) is
inherently **one buyer per escrow** — you cannot fill one escrow from many
buyers. So multi-buyer concurrency requires one escrow **per buyer**.

## The model: template + children

- **Parent listing** (CREATE) gains `stock: N` (units offered) and is a
  *perpetual offer* — it is never locked itself. A new tag
  `["parent", "<parent-d-tag>"]` is absent on the parent.
- **Child escrow**: when a buyer wants units, their client publishes a normal
  CREATE/LOCK escrow that carries `["parent", "<parent-d-tag>"]` and a
  `claimedQuantity`. The buyer locks the child exactly as today (marketplace =
  buyer locks). Each child is a full, independent 2-of-3 escrow.
- **Stock accounting (derived, not stored):**
  `remaining = parent.stock − Σ(claimedQuantity of children that are
  committed)` where "committed" = an active hold OR a non-refunded/non-expired
  LOCK. Computed by querying children with a `#parent` relay filter
  (CREATE already publishes filterable tags; we add `parent`).
- **Browse:** render the parent with "N left"; hide at `remaining = 0`; the
  child escrows are the actual trades (shown in Me / by id), never as separate
  Browse cards.
- **Stable identifier (the "sync a trade id" ask):** the parent `d`-tag is the
  durable order identity; every child references it, so observers can always
  resolve "the same visible order" and watch its remaining stock and the
  last-unit countdown, before *and* after any given child locks.

## The hard part — the last-unit race (decision required)

Because the buyer self-locks with no seller gate, two buyers can both see
"1 left" and both fund the last unit. On a serverless, eventually-consistent
Nostr backbone there is **no global coordinator**, so this can't be prevented
by a simple lock. Two honest ways to handle it:

### Option A — Optimistic + refund (recommended for v1)
Stock is best-effort. Buyers lock children optimistically. The seller fulfills
up to `N`; any overcommitted child is refunded through the **existing** escrow
refund path (seller votes refund / the hold expires → buyer's sats return).
The "being viewed + countdown" signals contention to *reduce* races.
- **Financially safe:** funds sit in 2-of-3 escrow; an overcommit just refunds
  the losing buyer — no loss, no seller drain (escrow already protects this).
- **Cheap:** reuses the battle-tested refund/expiry machinery; no new ceremony;
  the seller needn't be online at lock time.
- **Cost:** a buyer who loses a rare last-unit race locks, waits, and is
  refunded — a UX wrinkle, not a money risk.

### Option B — Seller-gated reservation (strict, no overcommit)
Buyer reserves; the **seller** (the stock authority, must be online) publishes
an ACK allocating one unit to that buyer; only an ACK-backed reservation can
lock. The seller serializes their own inventory → zero overcommit.
- **Clean:** never a double-sell, never a refund-after-lock.
- **Cost:** a new seller-ACK ceremony + state-machine path + heavy tests, and
  it makes selling depend on the seller being online and responsive. Casual
  sellers who step away can't sell until back.

**Recommendation: A.** It's financially safe (escrow protects every party),
ships sooner, reuses proven refunds, and is honest about the serverless reality
(you handle races, you don't pretend to prevent them). The contention countdown
is the race-reducer. B is a good *later* hardening if overcommit-refunds prove
annoying in practice. **This is the one decision I need from you.**

## Staged implementation (each stage ships + tests independently)

1. **Schema + parent tag (no behavior yet).** `stock` on the listing payload,
   `parent` + `claimedQuantity` on child payloads, parser validation, cloner
   preservation. Pure additive; legacy single-unit listings untouched.
2. **Child creation + stock accounting (read side).** Client helper to spawn a
   child referencing a parent; `#parent` subscription; a pure
   `remainingStock(parent, children, now)` function (this is the testable heart
   — covers holds, locks, expiries, refunds). Heavy unit tests incl. the race.
3. **Browse "N left" + visibility.** Parent shows remaining; hides at 0; child
   trades live in Me. 
4. **Reservation decrement + last-unit contention UX.** Hold reserves a unit;
   when `remaining` is `<2 but >0` and held, non-holders see "being viewed —
   Ns left" via `CountdownTimer`.
5. **Chosen race policy.** Wire Option A (overcommit → refund path surfaced
   clearly) or B (seller-ACK ceremony).
6. **Replay/concurrency test sweep.** Two buyers racing the last unit; partial
   sell-through; refund-frees-stock; sold-out hides.

## Risk + testing

Highest risk is the `remainingStock` accounting under eventual consistency and
replay (a child seen before its parent, a refunded child freeing stock, an
expired hold freeing a reservation). Stage 2's pure function is where almost all
the tests live — same pattern as the existing 1900+ reducer tests. No funds ever
move outside a 2-of-3 escrow, so even a wrong `remaining` is a display bug, not a
loss — which is the safety floor that makes Option A acceptable.
