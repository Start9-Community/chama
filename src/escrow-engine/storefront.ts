// ══════════════════════════════════════════════════════════════════════════
// #7 multi-unit storefront — pure stock accounting (Stage 2a)
// ══════════════════════════════════════════════════════════════════════════
//
// A multi-unit PARENT listing offers `stock` units. Each buyer's purchase is a
// CHILD escrow (carrying `parent` = the parent's id and `claimedQuantity`).
// Remaining stock is DERIVED — never stored — from the parent's children.
// These functions are pure and the testable heart of the storefront: no
// relays, no UI, no money. Money only ever lives in each child's own 2-of-3
// escrow, so a wrong count is at worst a display glitch, never a loss — which
// is what makes the optimistic (overcommit → refund) race policy acceptable
// under eventual consistency.
//
// Two distinct notions, deliberately separate:
//   • availableStock — units a NEW buyer can take RIGHT NOW (held + locked
//     units both subtracted). Drives "N available" and whether a fresh buyer
//     can join.
//   • unsoldStock — units not yet LOCKED (held units still count). A listing
//     stays browsable while unsold > 0; it's "sold out" only when every unit
//     is locked. The last-unit contention countdown keys off this: the last
//     unsold unit being held is exactly the "1 left, being viewed" case.

import {
  EscrowStatus,
  Role,
  JOIN_HOLD_LOCK_GRACE_SECONDS,
  type EscrowState,
} from "./types.js";

/** A child whose sats are locked or already settled — the unit is sold and
 *  only frees again via a refund (which moves it to CANCELLED / EXPIRED). */
function childIsLocked(child: EscrowState): boolean {
  return (
    child.status === EscrowStatus.LOCKED ||
    child.status === EscrowStatus.APPROVED ||
    child.status === EscrowStatus.CLAIMED ||
    child.status === EscrowStatus.COMPLETED
  );
}

/** A CREATED child with a live buyer reservation (hold not past its expiry +
 *  the hidden lock-grace window). The grace is included on purpose: a hold
 *  inside grace can still produce a LOCK, so we keep the unit reserved rather
 *  than briefly reselling it. */
function childIsHeld(child: EscrowState, now: number): boolean {
  if (child.status !== EscrowStatus.CREATED) return false;
  const hold = child.joinHolds?.[Role.BUYER];
  return !!hold && hold.expiresAt + JOIN_HOLD_LOCK_GRACE_SECONDS > now;
}

/** True when a child's claimed units currently count against availability
 *  (locked OR actively held). Cancelled / expired / lapsed-hold children free
 *  their units back. */
export function childCommitsStock(child: EscrowState, now: number): boolean {
  return childIsLocked(child) || childIsHeld(child, now);
}

/** Units a child claims (defaults to 1 for legacy / malformed values, so a
 *  child can never silently free or over-consume stock). */
function childClaim(child: EscrowState): number {
  const q = child.claimedQuantity;
  return typeof q === "number" && Number.isInteger(q) && q > 0 ? q : 1;
}

function sumClaims(
  parent: EscrowState,
  children: readonly EscrowState[],
  predicate: (child: EscrowState) => boolean,
): number {
  let units = 0;
  for (const child of children) {
    if (child.parent !== parent.id) continue;
    if (predicate(child)) units += childClaim(child);
  }
  return units;
}

/** Units a NEW buyer can take right now: `stock − (held + locked units)`,
 *  floored at 0. A parent with no `stock` is the legacy single unit. */
export function remainingStock(
  parent: EscrowState,
  children: readonly EscrowState[],
  now: number,
): number {
  const total = parent.stock ?? 1;
  return Math.max(0, total - sumClaims(parent, children, (c) => childCommitsStock(c, now)));
}

/** Units not yet LOCKED — held units still count. The listing stays browsable
 *  while this is > 0; it's sold out only when every unit is locked. */
export function unsoldStock(
  parent: EscrowState,
  children: readonly EscrowState[],
  now: number,
): number {
  const total = parent.stock ?? 1;
  return Math.max(0, total - sumClaims(parent, children, childIsLocked));
}

/** Fully sold: every unit is locked, nothing left to buy. Browse hides these. */
export function isSoldOut(
  parent: EscrowState,
  children: readonly EscrowState[],
  now: number,
): boolean {
  return unsoldStock(parent, children, now) <= 0;
}

/** The #7 "last unit" gate: exactly one unit is unsold AND it's currently
 *  held (so nothing is buyable right now) — i.e. the "1 left, being viewed by
 *  another buyer, Ns left" countdown should show to would-be buyers. */
export function isLastUnitContested(
  parent: EscrowState,
  children: readonly EscrowState[],
  now: number,
): boolean {
  return (
    unsoldStock(parent, children, now) === 1 &&
    remainingStock(parent, children, now) === 0
  );
}
