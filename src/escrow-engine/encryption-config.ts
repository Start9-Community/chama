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
 *  v1.2.2: PROD_ENCRYPTION is on. VOTE, CLAIM, RESOLVE, and
 *  PERIOD_RELEASE are now wrapped in the per-recipient envelope
 *  pattern from envelope.ts — the same shape LOCK uses for its SSS
 *  shares — so any of the three participants can decrypt and no
 *  relay operator can read the cleartext.
 *
 *  The v1.2.1 attempt at PROD shipped a single-recipient
 *  `nip44Encrypt(payload, selfPubkey)` for VOTE, which only the
 *  sender could decrypt; trades stalled at "invalid MAC" for the
 *  other two participants. We rolled back to DEV for that release
 *  and rebuilt the publish path on top of envelope.ts in v1.2.2.
 *
 *  Flipping back to DEV is a temporary debugging tool only. The
 *  assertProductionEncryption() guard below makes shipping DEV in a
 *  production build a hard runtime failure at boot, so any local
 *  flip stays local. */
export const ENCRYPTION_CONFIG: EncryptionConfig = PROD_ENCRYPTION;

/**
 * SECURITY: hard runtime assertion. Call this once at app boot. If a
 * production build ever ships with DEV_ENCRYPTION (LOCK/VOTE/CLAIM/
 * RESOLVE payloads in cleartext on relays), this throws on startup
 * and refuses to render the app. The error is loud so a maintainer
 * notices before any user-visible event hits the wire.
 *
 * `isProductionBuild` is a small abstraction — passing it in keeps
 * this module free of Vite-specific globals like `import.meta.env`
 * so the unit tests can still flip the config back to DEV temporarily
 * (e.g., the tests at line ~3614 in tests.ts) without tripping the
 * assertion under Node.
 */
export function assertProductionEncryption(isProductionBuild: boolean): void {
  if (!isProductionBuild) return;
  if (ENCRYPTION_CONFIG !== PROD_ENCRYPTION) {
    throw new Error(
      "FATAL: production build is shipping with non-PROD encryption " +
        "config. LOCK / VOTE / CLAIM / RESOLVE payloads would be " +
        "world-readable on relays. Refusing to start.",
    );
  }
  if (
    !ENCRYPTION_CONFIG.enabled ||
    !ENCRYPTION_CONFIG.encryptVote ||
    !ENCRYPTION_CONFIG.encryptClaim ||
    !ENCRYPTION_CONFIG.encryptResolve
  ) {
    throw new Error(
      "FATAL: production build is shipping with one or more encryption " +
        "flags disabled. Refusing to start.",
    );
  }
}

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
