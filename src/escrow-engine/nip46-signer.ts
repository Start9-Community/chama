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

// Storage keys
const STORAGE_LOCAL_KEY = "chama_nip46_local_key";
const STORAGE_BUNKER_URI = "chama_nip46_bunker_uri";
const STORAGE_USER_PUBKEY = "chama_nip46_user_pubkey";

// NIP-46 relays for communication
const NIP46_RELAYS = [
  "wss://relay.satoshimarket.app",  // Our own relay — only relay needed for NIP-46
];

const NIP46_CONNECT_TIMEOUT_MS = 90_000;

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
      if (bunkerSigner.nip44Encrypt) {
        return bunkerSigner.nip44Encrypt(recipientPubkey, plaintext);
      }
      if (bunkerSigner.nip04Encrypt) {
        return bunkerSigner.nip04Encrypt(recipientPubkey, plaintext);
      }
      throw new Error("Signer app does not support encrypted Chama messages");
    },
    nip44Decrypt: async (ciphertext: string, senderPubkey: string) => {
      if (bunkerSigner.nip44Decrypt) {
        return bunkerSigner.nip44Decrypt(senderPubkey, ciphertext);
      }
      if (bunkerSigner.nip04Decrypt) {
        return bunkerSigner.nip04Decrypt(senderPubkey, ciphertext);
      }
      throw new Error("Signer app does not support encrypted Chama messages");
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

  // Always generate a FRESH local keypair for new connections.
  // Reusing old keys causes relay noise from previous sessions,
  // making the first connection attempt unreliable.
  const localSecretKey = generateSecretKey();
  localStorage.setItem(STORAGE_LOCAL_KEY, JSON.stringify(Array.from(localSecretKey)));

  const clientPubkey = getPublicKey(localSecretKey);

  // Generate a random secret for this connection
  const secret = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

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

        // Save for session restoration
        localStorage.setItem(STORAGE_USER_PUBKEY, userPubkey);
        localStorage.setItem(STORAGE_BUNKER_URI, uri);

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
 */
export function hasSavedNIP46Session(): boolean {
  return !!(
    localStorage.getItem(STORAGE_LOCAL_KEY) &&
    localStorage.getItem(STORAGE_USER_PUBKEY)
  );
}

/**
 * Clear saved NIP-46 session (logout).
 */
export function clearNIP46Session(): void {
  localStorage.removeItem(STORAGE_LOCAL_KEY);
  localStorage.removeItem(STORAGE_BUNKER_URI);
  localStorage.removeItem(STORAGE_USER_PUBKEY);
}
