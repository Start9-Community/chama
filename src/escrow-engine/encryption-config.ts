// ══════════════════════════════════════════════════════════════════════════
// Chama Encryption Configuration
// ══════════════════════════════════════════════════════════════════════════
//
// Controls which event kinds are NIP-44 encrypted.
// During testing/development, all events are plaintext for debugging.
// In production, sensitive events (LOCK, VOTE, CLAIM) are encrypted.

export interface EncryptionConfig {
  /** Master switch — when false, everything is plaintext */
  enabled: boolean;
  /** Encrypt LOCK events (contains SSS shares) */
  encryptLock: boolean;
  /** Encrypt VOTE events (vote outcome is private) */
  encryptVote: boolean;
  /** Encrypt CLAIM events (contains share verification) */
  encryptClaim: boolean;
  /** Encrypt RESOLVE events */
  encryptResolve: boolean;
}

/** Development config — everything plaintext for easy debugging */
export const DEV_ENCRYPTION: EncryptionConfig = {
  enabled: false,
  encryptLock: false,
  encryptVote: false,
  encryptClaim: false,
  encryptResolve: false,
};

/** Production config — sensitive events encrypted */
export const PROD_ENCRYPTION: EncryptionConfig = {
  enabled: true,
  encryptLock: true,
  encryptVote: true,
  encryptClaim: true,
  encryptResolve: true,
};

/** Current active config.
 *
 *  KNOWN GAP — v1.2.1 ships with DEV_ENCRYPTION, not PROD.
 *
 *  PROD_ENCRYPTION currently calls `maybeEncrypt(payload, selfPubkey, …)`
 *  for VOTE / CLAIM / RESOLVE in escrow-client.ts. That encrypts each
 *  event to the SENDER's own pubkey only — the other two participants
 *  get "invalid MAC" and silently drop the event, so trades never reach
 *  consensus. LOCK's SSS shares already use the per-recipient envelope
 *  pattern in envelope.ts (`encryptedFor: { pk → ciphertext }`); the
 *  fix is to extend that pattern to VOTE / CLAIM / RESOLVE so each
 *  event carries three ciphertexts, one per participant, and to teach
 *  the receive path in handleIncomingEvent / loadEscrow to detect an
 *  envelope wrapper before falling through to NIP-44.
 *
 *  Tracking that work as the v1.2.2 followup. Until then, DEV is the
 *  only config that lets trades complete end-to-end.
 *
 *  THE PRIVACY COST while DEV is active: any relay operator can read
 *  the cleartext contents of LOCK, VOTE, CLAIM, RESOLVE events,
 *  including SSS shares, vote outcomes, and claim verification data.
 *  Funds are still non-custodial (the signer still holds the keys and
 *  the state machine still requires 2-of-3 signatures), but trade
 *  details are NOT private from relays. Users with strict privacy
 *  needs should self-host a relay and use only that relay in their
 *  relay list until v1.2.2 ships. */
export const ENCRYPTION_CONFIG: EncryptionConfig = DEV_ENCRYPTION;

/**
 * Helper: encrypt content if the config says so, otherwise return plaintext JSON.
 * In production, content is NIP-44 encrypted to the recipient pubkey.
 * The signer handles the actual encryption via nos2x/Alby.
 */
export async function maybeEncrypt(
  payload: unknown,
  recipientPubkey: string,
  encrypt: (plaintext: string, pubkey: string) => Promise<string>,
  shouldEncrypt: boolean,
): Promise<string> {
  const json = JSON.stringify(payload);
  if (!shouldEncrypt || !ENCRYPTION_CONFIG.enabled) {
    return json;
  }
  return encrypt(json, recipientPubkey);
}
