import type { StackCircle, StackContributionClaim, StackMemberProgress } from "./types.js";

/** Pure honor-system rollup: progress against goal, not wallet balances. */
export function stackMemberProgress(
  circle: StackCircle,
  claims: readonly StackContributionClaim[],
  memberPubkey: string,
  periodKey: string,
  priorPeriodKeys: readonly string[] = [],
): StackMemberProgress {
  const contributedSats = claims
    .filter(c =>
      c.circleId === circle.circleId
      && c.memberPubkey === memberPubkey
      && c.periodKey === periodKey
    )
    .reduce((sum, c) => sum + Math.max(0, c.amountSats), 0);
  const hitGoal = contributedSats >= circle.memberGoalSats;
  let streak = hitGoal ? 1 : 0;
  if (hitGoal) {
    for (const key of priorPeriodKeys) {
      const prior = claims
        .filter(c =>
          c.circleId === circle.circleId
          && c.memberPubkey === memberPubkey
          && c.periodKey === key
        )
        .reduce((sum, c) => sum + Math.max(0, c.amountSats), 0);
      if (prior >= circle.memberGoalSats) streak += 1;
      else break;
    }
  }
  return {
    memberPubkey,
    periodKey,
    contributedSats,
    goalSats: circle.memberGoalSats,
    hitGoal,
    streak,
  };
}
