// ══════════════════════════════════════════════════════════════════════════
// Chama — CREATE-event federation tags (probe-decoupled)
// ══════════════════════════════════════════════════════════════════════════
//
// Per PHILOSOPHY.md §2.3 ("federation follows the listing"), every CREATE
// event must carry enough federation context for buyers to resolve
// regardless of the seller-side probe outcome. Pre-v0.1.87 a probe
// failure stripped BOTH `fedPrefix` AND `fed` from the event, which
// cascaded into buyers filtering the listing out.
//
// What's in scope here: derive the two fed-related tags from the
// available signals (cached client federationId + optional probe
// result). `community` and `mintUrl` are populated upstream by the
// CreateForm and are not probe-conditional — this helper only governs
// the probe-derived / probe-redundant pair.
//
// Decision:
//   - `fed` (federation ID hex): include if either the probe captured
//     it OR the running client knows it. The client's cached fed ID is
//     set on init; no probe needed.
//   - `fedPrefix` (10-char ecash prefix): only when the probe
//     succeeded. Computing it requires actually round-tripping a 1-sat
//     OOB note. Its absence falls back to the LOCK gate, which is the
//     load-bearing fed-mismatch defense at money-move time.
//
// Pure: no IO, no React, no fedimint client dependency. Testable in
// isolation; shell collects the inputs and passes them through.

export interface CreateFedTagsInputs {
  /** federationId from the running fedimint client, or null if the
   *  client isn't initialized. */
  cachedFedId: string | null;
  /** Outcome of the optional 1-sat probe. `null` means the probe
   *  failed or was skipped (e.g. wallet not joined). */
  probeResult: { prefix: string; fed: string | null } | null;
}

export interface CreateFedTags {
  fed?: string;
  fedPrefix?: string;
}

export function deriveCreateFedTags(inputs: CreateFedTagsInputs): CreateFedTags {
  const tags: CreateFedTags = {};
  // Probe contributes both fields when present. The probe's `fed`
  // matches the cached value; preferring the probe is just a recency
  // signal, not a correctness one.
  if (inputs.probeResult) {
    tags.fedPrefix = inputs.probeResult.prefix;
    if (inputs.probeResult.fed) tags.fed = inputs.probeResult.fed;
  }
  // Cached ID is the fallback for `fed` when the probe didn't run or
  // returned null. Crucially, this means a probe failure no longer
  // strips `fed` from the CREATE event — buyers can still resolve.
  if (!tags.fed && inputs.cachedFedId) {
    tags.fed = inputs.cachedFedId;
  }
  return tags;
}
