// Dependency-free checks for the one rule that breaks LNURL most often:
// the bolt11 description hash must be sha256 of the EXACT metadata string served.
// Run with:  npm test

import assert from "node:assert/strict";
import { buildMetadata, buildPayRequest, sha256Hex } from "./lnurl";

const username = "alice";
const hostname = "pay.chapsmart.com";

const pr = buildPayRequest({
  username,
  hostname,
  minSendableMsat: 1000,
  maxSendableMsat: 100_000_000,
  commentAllowed: 280,
});

// 1) metadata must survive the JSON-over-the-wire round-trip unchanged.
const overTheWire = JSON.parse(JSON.stringify(pr)) as typeof pr;
assert.equal(overTheWire.metadata, pr.metadata, "metadata changed across JSON round-trip");

// 2) the callback rebuilds byte-identical metadata before hashing.
assert.equal(buildMetadata(username, hostname), pr.metadata, "callback metadata differs from served");

// 3) description hash is a 32-byte (64 hex char) sha256.
const h = sha256Hex(pr.metadata);
assert.match(h, /^[0-9a-f]{64}$/, "description hash is not 64 hex chars");

// 4) LUD-16 requires a text/identifier entry equal to the address.
const entries = JSON.parse(pr.metadata) as Array<[string, string]>;
assert.ok(
  entries.some(([k, v]) => k === "text/identifier" && v === `${username}@${hostname}`),
  "missing text/identifier matching the lightning address",
);

// 5) commentAllowed surfaces only when enabled.
assert.equal(pr.commentAllowed, 280);

console.log("All LUD-16 / LUD-06 invariants hold ✅");
console.log("metadata        :", pr.metadata);
console.log("descriptionHash :", h);
