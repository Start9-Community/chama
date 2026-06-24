// Pure LNURL helpers: metadata, payRequest body, hashing, validation.
// No I/O here so this module is trivially unit-testable (see selftest.ts).

import { createHash } from "node:crypto";

// LUD-16 limits the username to a-z 0-9 - _  (we also tolerate ".").
export const USERNAME_RE = /^[a-z0-9_.-]+$/;

export function lightningAddress(username: string, hostname: string): string {
  return `${username}@${hostname}`;
}

/**
 * LUD-06 `metadata`, returned as a STRINGIFIED JSON array of [type, value] pairs.
 * LUD-16 additionally requires a `text/identifier` (or `text/email`) entry whose
 * value equals the lightning address being paid.
 *
 * The exact bytes of this string are what the bolt11 invoice commits to via its
 * description hash, so it MUST be produced deterministically and identically in
 * both the payRequest step and the callback step.
 */
export function buildMetadata(username: string, hostname: string): string {
  const address = lightningAddress(username, hostname);
  const entries: Array<[string, string]> = [
    ["text/plain", `Pay to ${address}`],
    ["text/identifier", address],
  ];
  return JSON.stringify(entries);
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export interface PayRequestParams {
  username: string;
  hostname: string;
  minSendableMsat: number;
  maxSendableMsat: number;
  commentAllowed: number;
}

export interface PayRequestBody {
  callback: string;
  minSendable: number;
  maxSendable: number;
  metadata: string;
  tag: "payRequest";
  commentAllowed?: number;
}

/** LUD-06 step 1 response. Also serves as the LUD-16 response. */
export function buildPayRequest(p: PayRequestParams): PayRequestBody {
  const body: PayRequestBody = {
    callback: `https://${p.hostname}/lnurlp/${encodeURIComponent(p.username)}/callback`,
    minSendable: p.minSendableMsat,
    maxSendable: p.maxSendableMsat,
    metadata: buildMetadata(p.username, p.hostname),
    tag: "payRequest",
  };
  if (p.commentAllowed > 0) body.commentAllowed = p.commentAllowed; // LUD-12
  return body;
}
