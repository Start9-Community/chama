// Chama — default Nostr relay pool
//
// Keep this list biased toward relays that have behaved well in browser
// smoke tests. More relays are not automatically better: a wall of red
// connection states erodes trust. But the old five had no health margin —
// when three popular relays (damus/primal/offchain) were down at once the
// pool fell to two, BELOW the fetch quorum, which both stalled reads and left
// chat rehydration partial. We now carry a small margin so a few simultaneous
// public-relay outages still leave a working quorum.
//
// NOTE: damus/primal/offchain are normally high-uptime; keep them. The two
// additions below are margin only — confirm/swap them against current browser
// smoke-test behavior (write-acceptance + uptime vary over time). The
// launch-grade answer is a Chama-run relay (own the reliability instead of
// renting it from public relays) — that's infra, tracked separately, not here.
//
// The fetch quorum adapts to this list's length (relay-manager.ts
// effectiveQuorum: min(3, relayCount-1)), so growing/shrinking this list is
// safe — a small pool still resolves instead of waiting out the budget.

export const DEFAULT_RELAYS: string[] = [
  "wss://relay.damus.io",
  "wss://relay.primal.net",
  "wss://nos.lol",
  "wss://nostr.mom",
  "wss://offchain.pub",
  // ── margin (confirm in smoke tests; swap as needed) ──
  "wss://relay.snort.social",
  "wss://nostr.land",
];
