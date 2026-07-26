/** Stack — self-custody group savings dashboard (honor-system v1).
 * See design/mockups/chama-stack-brief.md. No pooled pot. */

export interface StackCircle {
  version: 1;
  circleId: string;
  name: string;
  memberPubkeys: string[];
  /** Per-member weekly/monthly target in sats (progress framing, not balance). */
  memberGoalSats: number;
  cadence: "weekly" | "monthly";
  createdAt: number;
}

export interface StackContributionClaim {
  circleId: string;
  memberPubkey: string;
  /** Self-declared contribution toward the member goal for this period. */
  amountSats: number;
  periodKey: string;
  claimedAt: number;
}

export type StackMemberProgress = {
  memberPubkey: string;
  periodKey: string;
  contributedSats: number;
  goalSats: number;
  hitGoal: boolean;
  streak: number;
};
