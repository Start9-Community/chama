# Chama relay operations

Chama uses multiple Nostr relays so no single relay is required for marketplace availability. A community-operated relay can improve propagation reliability, but clients must retain public-relay fallbacks.

## Requirements

- Serve secure WebSockets (`wss://`) behind an existing reverse proxy.
- Bind the relay daemon to a private/local interface unless direct exposure is intentional.
- Preserve Chama events long enough for clients to reconstruct historical trades.
- Rate-limit writes and cap event sizes.
- Back up relay data and configuration independently of this application repository.
- Avoid logging event content. NIP-44 protects sensitive payloads, but relay metadata remains visible to the operator.

## Event policy

If the relay restricts writes by kind, allow the kinds currently declared in the application source rather than copying a hard-coded range from this document. The authoritative allocations live in:

- `src/escrow-engine/types.ts`
- `src/arbiters/roster.ts`
- `src/arbiters/bonds.ts`
- `src/bond-multisig/bond-announcement.ts`

This prevents relay policy from silently falling behind protocol changes.

## Verification

Before adding a relay to the default pool:

1. Publish and fetch a disposable signed event over `wss://`.
2. Confirm reconnect and historical-query behavior.
3. Exercise a three-participant test trade and verify both votes propagate.
4. Confirm the application continues working while the new relay is unavailable.

Default client relays are configured in `src/escrow-engine/default-relays.ts`.
