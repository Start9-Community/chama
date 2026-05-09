// ══════════════════════════════════════════════════════════════════════════
// Chama — LNURL-pay resolver for Lightning Address claim destinations
// ══════════════════════════════════════════════════════════════════════════
//
// Per PHILOSOPHY.md §2.7: claim time is when the user provides a destination
// to receive sats. v0.3.0's DestinationPicker accepts a Lightning Address
// (`user@domain.tld`); this module resolves it to a BOLT11 invoice for the
// exact claim amount via LNURL-pay.
//
// Two-stage resolution:
//   1. Parse the address synchronously. Malformed input fails here, before
//      any network call. UX win: "that's not a valid Lightning Address" in
//      <1ms beats a 5-second DNS timeout that surfaces as a generic network
//      error.
//   2. Fetch metadata at https://{domain}/.well-known/lnurlp/{user}, then
//      hit the callback URL with the amount to receive a BOLT11.
//
// Errors are typed via LnurlError.code so DestinationPicker can render a
// targeted message (DNS down vs server 500 vs amount out of range vs
// malformed metadata). Per Q2 the picker does NOT auto-fall-back to BOLT11
// paste mode on resolution failure — it surfaces the typed error and lets
// the user retry or switch tier deliberately.
//
// LNURL-pay protocol reference: LUD-06, LUD-16 (Lightning Address).

/** Code-tagged error carrying the failure category. Callers branch on
 *  `.code` to render the right message. */
export class LnurlError extends Error {
  constructor(public code: LnurlErrorCode, message: string) {
    super(message);
    this.name = "LnurlError";
  }
}

export type LnurlErrorCode =
  /** Input failed parse-time validation. No network call was made. */
  | "LnurlParseError"
  /** DNS resolution or transport-level failure (CORS, fetch threw). */
  | "LnurlDnsError"
  /** Server reachable but returned non-2xx, or LNURL `status: "ERROR"`. */
  | "LnurlServerError"
  /** Server returned 2xx but body was non-JSON or didn't match the
   *  LNURL-pay schema. Includes "tag != payRequest" and missing fields. */
  | "LnurlMalformedError"
  /** Requested amount fell outside the recipient's minSendable/maxSendable. */
  | "LnurlAmountOutOfRangeError";

/** Parsed Lightning Address. */
export interface LightningAddressParts {
  user: string;
  domain: string;
}

/** Parse a Lightning Address (LUD-16) — `user@domain.tld`. Synchronous;
 *  throws LnurlError("LnurlParseError") for malformed input.
 *
 *  Validation rules (intentionally strict — Lightning Addresses are
 *  email-shaped but not full email; restricting to the LUD-16 subset
 *  catches typos before a network round-trip):
 *    - exactly one '@'
 *    - user: lowercase a-z, 0-9, dot, dash, underscore (1+ chars)
 *    - domain: at least one dot, ASCII letters/digits/dashes, TLD ≥ 2 chars
 *    - whitespace trimmed before validation
 *    - case-insensitive (normalized to lowercase) */
export function parseLightningAddress(raw: string): LightningAddressParts {
  if (typeof raw !== "string") {
    throw new LnurlError(
      "LnurlParseError",
      "Lightning Address must be a string",
    );
  }
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) {
    throw new LnurlError(
      "LnurlParseError",
      "Lightning Address cannot be empty",
    );
  }
  // Exactly one '@'.
  const atCount = (trimmed.match(/@/g) || []).length;
  if (atCount !== 1) {
    throw new LnurlError(
      "LnurlParseError",
      `Not a valid Lightning Address: expected one '@', got ${atCount}`,
    );
  }
  const match = trimmed.match(
    /^([a-z0-9._-]+)@([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})$/,
  );
  if (!match) {
    throw new LnurlError(
      "LnurlParseError",
      `Not a valid Lightning Address: ${raw}`,
    );
  }
  return { user: match[1], domain: match[2] };
}

/** True iff `raw` parses as a Lightning Address. Convenience for
 *  DestinationPicker's input classifier — never throws. */
export function isLightningAddress(raw: string): boolean {
  try {
    parseLightningAddress(raw);
    return true;
  } catch {
    return false;
  }
}

/** LNURL-pay metadata returned from `.well-known/lnurlp/{user}`. */
export interface LnurlPayMetadata {
  /** Callback URL to GET with `?amount=<msats>` to receive a BOLT11. */
  callback: string;
  /** Minimum receivable amount in millisatoshis. */
  minSendable: number;
  /** Maximum receivable amount in millisatoshis. */
  maxSendable: number;
  /** Description metadata (used by some wallets for invoice annotation). */
  metadata: string;
  /** Always "payRequest" for LNURL-pay. */
  tag: "payRequest";
}

/** Fetch LNURL-pay metadata for a Lightning Address. Caller passes a
 *  fetch implementation explicitly so tests can mock it without touching
 *  globalThis.fetch. */
export async function fetchLnurlPayMetadata(
  address: string,
  fetchImpl: typeof fetch = (typeof fetch !== "undefined" ? fetch : (() => {
    throw new Error("fetch is not available in this environment");
  }) as any),
): Promise<LnurlPayMetadata> {
  const { user, domain } = parseLightningAddress(address);
  const url = `https://${domain}/.well-known/lnurlp/${user}`;
  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch (e: any) {
    throw new LnurlError(
      "LnurlDnsError",
      `Couldn't reach ${domain}: ${e?.message || "network error"}`,
    );
  }
  if (!res.ok) {
    throw new LnurlError(
      "LnurlServerError",
      `${domain} returned HTTP ${res.status}`,
    );
  }
  let body: any;
  try {
    body = await res.json();
  } catch {
    throw new LnurlError(
      "LnurlMalformedError",
      `${domain} returned non-JSON metadata`,
    );
  }
  // LNURL convention: `status: "ERROR"` with a `reason` field.
  if (body && body.status === "ERROR") {
    throw new LnurlError(
      "LnurlServerError",
      typeof body.reason === "string" && body.reason
        ? body.reason
        : `${domain} returned an LNURL error`,
    );
  }
  if (
    !body ||
    body.tag !== "payRequest" ||
    typeof body.callback !== "string" ||
    typeof body.minSendable !== "number" ||
    typeof body.maxSendable !== "number"
  ) {
    throw new LnurlError(
      "LnurlMalformedError",
      `${domain} returned malformed LNURL-pay metadata`,
    );
  }
  return {
    callback: body.callback,
    minSendable: body.minSendable,
    maxSendable: body.maxSendable,
    metadata: typeof body.metadata === "string" ? body.metadata : "",
    tag: "payRequest",
  };
}

/** Hit the LNURL-pay callback for `amountSats` and return the BOLT11
 *  invoice. Validates the amount against minSendable/maxSendable
 *  upfront — out-of-range amounts fail synchronously without a network
 *  call (same UX principle as parseLightningAddress). */
export async function requestLnurlInvoice(
  meta: LnurlPayMetadata,
  amountSats: number,
  fetchImpl: typeof fetch = (typeof fetch !== "undefined" ? fetch : (() => {
    throw new Error("fetch is not available in this environment");
  }) as any),
): Promise<string> {
  const amountMsats = amountSats * 1000;
  if (amountMsats < meta.minSendable || amountMsats > meta.maxSendable) {
    const minSats = Math.ceil(meta.minSendable / 1000);
    const maxSats = Math.floor(meta.maxSendable / 1000);
    throw new LnurlError(
      "LnurlAmountOutOfRangeError",
      `Amount ${amountSats} sats outside receiver's range (${minSats}–${maxSats} sats)`,
    );
  }
  const sep = meta.callback.includes("?") ? "&" : "?";
  const url = `${meta.callback}${sep}amount=${amountMsats}`;
  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch (e: any) {
    throw new LnurlError(
      "LnurlDnsError",
      `LNURL callback unreachable: ${e?.message || "network error"}`,
    );
  }
  if (!res.ok) {
    throw new LnurlError(
      "LnurlServerError",
      `LNURL callback returned HTTP ${res.status}`,
    );
  }
  let body: any;
  try {
    body = await res.json();
  } catch {
    throw new LnurlError(
      "LnurlMalformedError",
      "LNURL callback returned non-JSON response",
    );
  }
  if (body && body.status === "ERROR") {
    throw new LnurlError(
      "LnurlServerError",
      typeof body.reason === "string" && body.reason
        ? body.reason
        : "LNURL callback returned an error",
    );
  }
  if (typeof body?.pr !== "string" || !/^lnbc/i.test(body.pr)) {
    throw new LnurlError(
      "LnurlMalformedError",
      "LNURL callback didn't return a BOLT11 invoice",
    );
  }
  return body.pr;
}

/** One-shot helper: address + amount → BOLT11. Composes
 *  parseLightningAddress → fetchLnurlPayMetadata → requestLnurlInvoice.
 *  This is what DestinationPicker calls for Tier 1 / Tier 2. */
export async function resolveLightningAddressToInvoice(
  address: string,
  amountSats: number,
  fetchImpl?: typeof fetch,
): Promise<string> {
  const meta = await fetchLnurlPayMetadata(address, fetchImpl);
  return requestLnurlInvoice(meta, amountSats, fetchImpl);
}
