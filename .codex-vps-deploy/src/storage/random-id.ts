// ══════════════════════════════════════════════════════════════════════════
// Cryptographic short-ID helpers
// ══════════════════════════════════════════════════════════════════════════
//
// `Math.random()` is NOT cryptographically secure. The browser spec gives
// it ~53 bits of state in the best case and most implementations seed it
// from low-entropy sources at page load. That's fine for animation jitter
// or shuffle-the-deck UX but NOT for any identifier whose unguessability
// matters for correctness or privacy.
//
// Chama uses short IDs in a few security-adjacent places:
//   * Fedimint operation IDs — paired with money movement; if guessable,
//     a same-origin script could race a legitimate handler to read or
//     cancel pending operations.
//   * Sats-trace IDs — used to correlate user-side traces; if guessable,
//     they leak that the same user is active on a shared device.
//   * Saved-handle IDs, payout-destination IDs, NWC-connection IDs —
//     used as opaque keys in storage; if a future code path makes them
//     externally visible, predictability becomes a deanonymization
//     vector.
//   * Chat image IDs / menu item IDs — UI-side React keys; not strictly
//     security-sensitive, but no reason to keep Math.random when the
//     replacement is one line.
//
// This module is the single place to produce those IDs.

/**
 * Generate a `length`-character base36 string of cryptographically
 * random characters. Default length 10 ≈ 51.7 bits of entropy, more
 * than enough for any short-ID use case.
 *
 * Throws if `crypto.getRandomValues` is unavailable rather than
 * silently falling back to `Math.random`. This is deliberate — anywhere
 * we call randomId(), we want hard randomness or an audible failure,
 * never quiet downgrade.
 */
export function randomId(length: number = 10): string {
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    throw new Error(
      "crypto.getRandomValues is unavailable; refusing to generate a " +
        "non-cryptographic ID. This indicates a broken runtime.",
    );
  }
  const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) {
    // A 1-in-256 byte mapped onto a 36-char alphabet has slight modulo
    // bias (~0.4% over-representation of the first 28 alphabet entries).
    // For ID purposes at 10 chars (51+ bits of usable entropy) this is
    // fully negligible — collisions would still take ~2^25 draws.
    out += ALPHABET[bytes[i] % 36];
  }
  return out;
}
