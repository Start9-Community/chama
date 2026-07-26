import type { ChipInContribution, ChipInGoal, ChipInProgress } from "./types.js";

/** Pure progress rollup. Locked sats count toward the goal; pledged does not. */
export function chipInProgress(
  goal: ChipInGoal,
  contributions: readonly ChipInContribution[],
  nowSec: number = Math.floor(Date.now() / 1000),
): ChipInProgress {
  let lockedSats = 0;
  let pledgedSats = 0;
  for (const c of contributions) {
    if (c.goalId !== goal.goalId) continue;
    if (c.status === "locked" || c.status === "released") lockedSats += Math.max(0, c.amountSats);
    else if (c.status === "pledged") pledgedSats += Math.max(0, c.amountSats);
  }
  const remainingSats = Math.max(0, goal.goalSats - lockedSats);
  return {
    goalSats: goal.goalSats,
    lockedSats,
    pledgedSats,
    remainingSats,
    met: lockedSats >= goal.goalSats,
    expired: nowSec >= goal.deadlineSec && lockedSats < goal.goalSats,
  };
}
