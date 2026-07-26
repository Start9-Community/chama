/** Chip In — N contributors → 1 organizer goal.
 * Pure contract only. No events, no spends. See
 * design/mockups/chama-chip-in-brief.md. */

export interface ChipInGoal {
  version: 1;
  goalId: string;
  organizerPubkey: string;
  community: string;
  mintUrl: string;
  goalSats: number;
  deadlineSec: number;
  description: string;
  createdAt: number;
}

export interface ChipInContribution {
  goalId: string;
  contributorPubkey: string;
  amountSats: number;
  /** Escrow / child trade id once locked; null while pledged only. */
  escrowId: string | null;
  status: "pledged" | "locked" | "released" | "refunded";
}

export type ChipInProgress = {
  goalSats: number;
  lockedSats: number;
  pledgedSats: number;
  remainingSats: number;
  met: boolean;
  expired: boolean;
};
