import { chipInProgress } from "./progress.js";
import type { ChipInContribution, ChipInGoal } from "./types.js";

let passed = 0;
let failed = 0;

function assert(condition: unknown, name: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`);
  }
}

const GOAL: ChipInGoal = {
  version: 1,
  goalId: "chip_1",
  organizerPubkey: "org",
  community: "ke-kes",
  mintUrl: "fed1",
  goalSats: 100_000,
  deadlineSec: 2_000_000_000,
  description: "Group gift",
  createdAt: 1_900_000_000,
};

const contrib = (
  amountSats: number,
  status: ChipInContribution["status"],
  pubkey = "a",
): ChipInContribution => ({
  goalId: "chip_1",
  contributorPubkey: pubkey,
  amountSats,
  escrowId: status === "pledged" ? null : `esc_${pubkey}`,
  status,
});

console.log("\n── Chip In progress ──");
assert(
  chipInProgress(GOAL, [contrib(40_000, "locked"), contrib(30_000, "pledged")]).remainingSats === 60_000
    && !chipInProgress(GOAL, [contrib(40_000, "locked")]).met,
  "locked counts; pledged does not meet the goal",
);
assert(
  chipInProgress(GOAL, [contrib(60_000, "locked", "a"), contrib(40_000, "locked", "b")]).met,
  "goal met when locked sum reaches target",
);
assert(
  chipInProgress(GOAL, [contrib(10_000, "locked")], 2_000_000_001).expired,
  "expired when past deadline and unmet",
);

console.log(`\nChip In results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
