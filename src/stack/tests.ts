import { stackMemberProgress } from "./progress.js";
import type { StackCircle, StackContributionClaim } from "./types.js";

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

const CIRCLE: StackCircle = {
  version: 1,
  circleId: "stack_1",
  name: "Tuesday stack",
  memberPubkeys: ["a", "b"],
  memberGoalSats: 21_000,
  cadence: "weekly",
  createdAt: 1_900_000_000,
};

const claim = (
  memberPubkey: string,
  amountSats: number,
  periodKey: string,
): StackContributionClaim => ({
  circleId: "stack_1",
  memberPubkey,
  amountSats,
  periodKey,
  claimedAt: 1_900_000_100,
});

console.log("\n── Stack progress ──");
const mid = stackMemberProgress(CIRCLE, [claim("a", 10_000, "2026-W30")], "a", "2026-W30");
assert(!mid.hitGoal && mid.contributedSats === 10_000, "partial week does not hit goal");
const hit = stackMemberProgress(
  CIRCLE,
  [claim("a", 21_000, "2026-W30"), claim("a", 21_000, "2026-W29")],
  "a",
  "2026-W30",
  ["2026-W29"],
);
assert(hit.hitGoal && hit.streak === 2, "streak counts contiguous prior periods that hit");

console.log(`\nStack results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
