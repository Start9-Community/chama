// ══════════════════════════════════════════════════════════════════════════
// Chama — Orphan-OPFS wipe policy (v3.4.0, audit C14)
// ══════════════════════════════════════════════════════════════════════════
//
// Pure decision logic for the seed-mismatch auto-reset path in
// sdk-adapter.createRealWallet. Extracted so the money rule is
// unit-testable without the WASM SDK:
//
//   INVARIANT(no-wipe-unknown-balance): deleting an OPFS wallet file
//   requires POSITIVE confirmation it holds no ecash. "The balance
//   peek threw" is not confirmation — Fedimint ecash is bearer cash
//   that lives only in that file, and the pre-v3.4.0 behavior of
//   treating unknown as safe-to-wipe has destroyed real sats before
//   (v0.1.76 incident class).
//
// Positive confirmation means exactly one of:
//   - the balance was actually read and equals zero, or
//   - the file provably has no federation client (the SDK's well-known
//     first-run open() error), which makes ecash structurally
//     impossible — there is nothing a wipe could destroy.
//
// Everything else is "unknown" and must never wipe. Where a
// non-destructive escape exists (a LEGACY file while the session has a
// per-npub scope: park the old file untouched, start a fresh scoped
// one), prefer it so the user isn't blocked; otherwise refuse loudly
// and let the user retry online or reset explicitly.

/** Outcome of peeking at the orphan wallet's balance. */
export type OrphanPeek =
  /** Balance positively read (msats ≥ 0). */
  | { kind: "balance"; balanceMsats: number }
  /** open() failed with the SDK's first-run "no client in this DB"
   *  taxonomy: the file never joined a federation, so it cannot hold
   *  ecash. Positive confirmation of empty. */
  | { kind: "no-client" }
  /** Anything else threw or stayed unreadable. NOT confirmation. */
  | { kind: "unknown"; reason: string };

export type OrphanWipeDecision =
  /** Park the orphan file untouched; rotate to a fresh file. */
  | { action: "preserve-and-rescope"; balanceMsats: number | null }
  /** Positively confirmed empty — deleting destroys nothing. */
  | { action: "wipe" }
  /** Holds sats under a foreign seed — refuse, require explicit user override. */
  | { action: "refuse-balance"; balanceMsats: number }
  /** Balance unknowable right now — refuse, nothing deleted. */
  | { action: "refuse-unknown"; reason: string };

/**
 * The SDK's first-run open() failures — a DB with no federation client
 * yet. Mirrors the taxonomy FedimintClient.init() already trusts for
 * the same purpose. Anything not matching is treated as unknown.
 */
export const NO_CLIENT_OPEN_ERROR_RE =
  /client is not initialized|client database not initialized|database not initialized|not initialized for this database|no such client|client secret is not present|run join first/i;

export function decideOrphanWipe(input: {
  peek: OrphanPeek;
  /** The session's per-npub storage scope (null/undefined = unscoped). */
  storageScope: string | null | undefined;
  /** Where the current filename came from: a per-npub key or the legacy global key. */
  filenameSource: "scoped" | "legacy";
}): OrphanWipeDecision {
  const { peek, storageScope, filenameSource } = input;
  // A legacy-keyed file while this session is scoped may belong to a
  // DIFFERENT identity in the same browser profile. Whatever it holds
  // (or might hold), never destroy it — park it and move this identity
  // to its own scoped file.
  const canPark = Boolean(storageScope) && filenameSource === "legacy";

  if (peek.kind === "balance" && peek.balanceMsats > 0) {
    return canPark
      ? { action: "preserve-and-rescope", balanceMsats: peek.balanceMsats }
      : { action: "refuse-balance", balanceMsats: peek.balanceMsats };
  }
  if (peek.kind === "balance" || peek.kind === "no-client") {
    // Positive zero, or structurally no ecash possible.
    return { action: "wipe" };
  }
  // Unknown: never wipe. Park when that's possible without loss;
  // otherwise refuse and keep everything intact.
  return canPark
    ? { action: "preserve-and-rescope", balanceMsats: null }
    : { action: "refuse-unknown", reason: peek.reason };
}
