// ══════════════════════════════════════════════════════════════════════════
// Chama — NIP-46 Nostr Connect Signer
// ══════════════════════════════════════════════════════════════════════════
//
// Uses nostr-tools BunkerSigner to communicate with a remote signer
// (Amber, nsecBunker, etc.) over Nostr relays.
//
// Flow:
//   1. Generate local keypair + nostrconnect:// URI
//   2. Display URI as QR code or tappable link
//   3. User scans/taps → signer approves connection
//   4. All signing happens over relays — no redirects
//   5. Local keypair persisted for session continuity

import type { Signer, UnsignedEvent } from "./escrow-client.js";
import type { NostrEvent } from "./types.js";

// Storage keys.
//
// SECURITY: we deliberately do NOT persist the ephemeral NIP-46 client
// secret key. An earlier version wrote it to localStorage on every
// connect, where any script with DOM access (XSS, a hostile browser
// extension, a sketchy npm dep that ships in a future build) could lift
// it and impersonate this client to the bunker — i.e. trigger sign
// requests against the user's real identity key.
//
// hasSavedNIP46Session / clearNIP46Session below are kept only as legacy
// no-op shims for any caller that may still reference them; nothing in
// the repo reads STORAGE_LOCAL_KEY back, so persisting it bought us
// zero functionality and one footgun. Reconnecting just means scanning
// the QR again.
const STORAGE_LOCAL_KEY = "chama_nip46_local_key";
const STORAGE_BUNKER_URI = "chama_nip46_bunker_uri";
const STORAGE_USER_PUBKEY = "chama_nip46_user_pubkey";

// NIP-46 relays for communication
const NIP46_RELAYS = [
  "wss://relay.satoshimarket.app",  // Our own relay — only relay needed for NIP-46
];

const NIP46_CONNECT_TIMEOUT_MS = 90_000;

export function createNip46PairingSecret(
  randomBytes?: (bytes: Uint8Array) => Uint8Array,
): string {
  const fill = randomBytes ?? globalThis.crypto?.getRandomValues?.bind(globalThis.crypto);
  if (!fill) {
    throw new Error("Secure randomness is unavailable");
  }
  const bytes = new Uint8Array(16);
  fill(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface NIP46ConnectResult {
  signer: Signer;
  pubkey: string;
}

interface BunkerSignerLike {
  getPublicKey: () => Promise<string>;
  signEvent: (event: UnsignedEvent) => Promise<NostrEvent>;
  nip44Encrypt?: (thirdPartyPubkey: string, plaintext: string) => Promise<string>;
  nip44Decrypt?: (thirdPartyPubkey: string, ciphertext: string) => Promise<string>;
  nip04Encrypt?: (thirdPartyPubkey: string, plaintext: string) => Promise<string>;
  nip04Decrypt?: (thirdPartyPubkey: string, ciphertext: string) => Promise<string>;
}

export function adaptNIP46BunkerSigner(bunkerSigner: BunkerSignerLike): Signer {
  return {
    getPublicKey: () => bunkerSigner.getPublicKey(),
    signEvent: (event: UnsignedEvent) => bunkerSigner.signEvent(event),
    nip44Encrypt: async (plaintext: string, recipientPubkey: string) => {
      // SECURITY: NIP-44 only. The previous build silently downgraded
      // to NIP-04 if the bunker didn't expose NIP-44, which weakened
      // every escrow payload (SSS shares included) sent through that
      // bunker. Modern bunkers (Amber, nsecBunker) all support NIP-44;
      // if yours doesn't, please upgrade your signer app.
      if (!bunkerSigner.nip44Encrypt) {
        throw new Error(
          "Your remote signer (NIP-46 bunker) does not support NIP-44 " +
            "encryption. Please upgrade your signer app (e.g. Amber, " +
            "nsecBunker) to a recent version.",
        );
      }
      return bunkerSigner.nip44Encrypt(recipientPubkey, plaintext);
    },
    nip44Decrypt: async (ciphertext: string, senderPubkey: string) => {
      // SECURITY: NIP-44 only. See encrypt-side note above.
      if (!bunkerSigner.nip44Decrypt) {
        throw new Error(
          "Your remote signer (NIP-46 bunker) does not support NIP-44 " +
            "decryption. Please upgrade your signer app.",
        );
      }
      return bunkerSigner.nip44Decrypt(senderPubkey, ciphertext);
    },
  };
}

/**
 * Generate a nostrconnect:// URI for the user to scan.
 * Returns the URI string and a Promise that resolves when the bunker connects.
 */
export async function createNostrConnectSession(): Promise<{
  uri: string;
  waitForConnection: () => Promise<NIP46ConnectResult>;
}> {
  // Dynamic import to avoid bundling nostr-tools if not used
  const { generateSecretKey, getPublicKey } = await import("nostr-tools/pure");
  const { BunkerSigner, createNostrConnectURI } = await import("nostr-tools/nip46");
  const { SimplePool } = await import("nostr-tools/pool");

  // SECURITY: shed any NIP-46 secrets a pre-hardening build of Chama
  // may have left in localStorage. This is the migration point — every
  // new pairing flow starts from a clean slate.
  clearNIP46Session();

  // Always generate a FRESH local keypair for new connections.
  // Reusing old keys causes relay noise from previous sessions,
  // making the first connection attempt unreliable.
  //
  // SECURITY: kept entirely in-memory. This key never touches
  // localStorage / sessionStorage / IndexedDB.
  const localSecretKey = generateSecretKey();

  const clientPubkey = getPublicKey(localSecretKey);

  // Generate a cryptographically random pairing secret for this connection.
  const secret = createNip46PairingSecret();

  // Create the nostrconnect:// URI
  const uri = createNostrConnectURI({
    clientPubkey,
    relays: NIP46_RELAYS,
    secret,
    name: "Chama",
    perms: ["get_public_key", "sign_event", "nip44_encrypt", "nip44_decrypt", "nip04_encrypt", "nip04_decrypt"],
  });

  console.debug("[chama] NIP-46 URI generated:", uri.slice(0, 60) + "...");

  return {
    uri,
    waitForConnection: async (): Promise<NIP46ConnectResult> => {
      const pool = new SimplePool({ enableReconnect: true });

      try {
        const bunkerSigner = await BunkerSigner.fromURI(
          localSecretKey,
          uri,
          { pool },
          NIP46_CONNECT_TIMEOUT_MS
        );

        // Get the user's actual pubkey (different from the bunker's key)
        const userPubkey = await bunkerSigner.getPublicKey();

        // SECURITY: do not persist the bunker URI (it embeds the pairing
        // secret) or the local secret key. The user pubkey is fine to
        // persist — it's public. Nothing else in the codebase actually
        // reads these back to restore a session today, so writing them
        // would only widen the blast radius of any XSS.

        console.debug("[chama] NIP-46 connected! User pubkey:", userPubkey.slice(0, 12) + "...");

        const signer = adaptNIP46BunkerSigner(bunkerSigner);

        return { signer, pubkey: userPubkey };
      } catch (e: any) {
        pool.close(NIP46_RELAYS);
        if (e?.message?.includes("subscription closed")) {
          throw new Error("Signer connection closed before approval. Please scan again.");
        }
        throw e;
      }
    },
  };
}

/**
 * Check if there's a saved NIP-46 session that can be restored.
 *
 * Always returns false now: we no longer persist any NIP-46 session
 * material (see security note at the top of this file). Kept as an
 * exported function so any old call sites compile; they will simply
 * always take the "no saved session" branch and re-pair.
 */
export function hasSavedNIP46Session(): boolean {
  return false;
}

/**
 * Clear saved NIP-46 session (logout).
 *
 * Also removes any stale entries left over from previous app versions
 * that did persist these values, so an upgraded client sheds them on
 * first call.
 */
export function clearNIP46Session(): void {
  try {
    localStorage.removeItem(STORAGE_LOCAL_KEY);
    localStorage.removeItem(STORAGE_BUNKER_URI);
    localStorage.removeItem(STORAGE_USER_PUBKEY);
  } catch {
    // localStorage may be unavailable (private mode, SSR) — ignore.
  }
}
