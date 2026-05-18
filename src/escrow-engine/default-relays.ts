// Chama — default Nostr relay pool
//
// Keep this list biased toward relays that have behaved well in browser
// smoke tests. More relays are not automatically better: a wall of red
// connection states erodes trust, while five steady relays are plenty for
// redundant publish/replay.

export const DEFAULT_RELAYS: string[] = [
  "wss://relay.damus.io",
  "wss://relay.primal.net",
  "wss://nos.lol",
  "wss://nostr.mom",
  "wss://offchain.pub",
];
