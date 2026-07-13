// ══════════════════════════════════════════════════════════════════════════
// Chama — Nostr Wallet Connect receive-invoice helper (NIP-47)
// ══════════════════════════════════════════════════════════════════════════
//
// Claim/recovery payouts need a BOLT11 invoice that Chama can pay from the
// user's Fedimint wallet. There NWC is a receive-invoice source: we ask the
// user's wallet to make an invoice for the exact payout amount, then Chama
// pays that invoice through the normal Fedimint outbound Lightning path.
//
// Funding is the inverse: Chama makes a Fedimint receive invoice, then asks
// the user's NWC wallet to pay it. Wallet-side budgets/permissions remain
// the user's safety boundary.

import { parseBolt11Msats } from "./bolt11.js";

export const NWC_REQUEST_KIND = 23194;
export const NWC_RESPONSE_KIND = 23195;
export const NWC_INFO_KIND = 13194;

export type NwcErrorCode =
  | "NwcParseError"
  | "NwcUnsupportedWallet"
  | "NwcRelayError"
  | "NwcTimeout"
  | "NwcWalletError"
  | "NwcMalformedResponse";

export class NwcError extends Error {
  constructor(public code: NwcErrorCode, message: string) {
    super(message);
    this.name = "NwcError";
  }
}

export interface NwcConnection {
  walletPubkey: string;
  relays: string[];
  secret: string;
  lud16?: string;
}

type NwcEncryption = "nip44_v2" | "nip04";

interface MinimalNostrEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface ResolveNwcInvoiceOpts {
  description?: string;
  timeoutMs?: number;
  infoTimeoutMs?: number;
  publishTimeoutMs?: number;
  now?: () => number;
}

export interface NwcPayInvoiceOpts {
  timeoutMs?: number;
  infoTimeoutMs?: number;
  publishTimeoutMs?: number;
  now?: () => number;
}

const HEX64_RE = /^[0-9a-f]{64}$/i;

function normalizeRelayUrl(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new NwcError("NwcParseError", "NWC relay URL is invalid");
  }
  if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw new NwcError("NwcParseError", "NWC relay must be a ws:// or wss:// URL");
  }
  return url.toString().replace(/\/$/, "");
}

function hexToBytes(hex: string): Uint8Array {
  if (!HEX64_RE.test(hex)) {
    throw new NwcError("NwcParseError", "NWC secret must be a 32-byte hex string");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function isBolt11(invoice: string): boolean {
  return /^ln(?!url)[a-z0-9]/i.test(invoice.trim());
}

export function isNwcConnectionString(raw: string): boolean {
  try {
    parseNwcConnectionString(raw);
    return true;
  } catch {
    return false;
  }
}

export function parseNwcConnectionString(raw: string): NwcConnection {
  if (typeof raw !== "string") {
    throw new NwcError("NwcParseError", "NWC connection must be text");
  }
  const trimmed = raw.trim();
  if (!trimmed) throw new NwcError("NwcParseError", "NWC connection cannot be empty");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new NwcError("NwcParseError", "NWC connection string is not a valid URI");
  }
  if (url.protocol.toLowerCase() !== "nostr+walletconnect:") {
    throw new NwcError("NwcParseError", "Paste a nostr+walletconnect:// connection string");
  }

  const walletPubkey = (url.hostname || url.pathname.replace(/^\/+/, "")).toLowerCase();
  if (!HEX64_RE.test(walletPubkey)) {
    throw new NwcError("NwcParseError", "NWC wallet pubkey is invalid");
  }

  const relays = [...new Set(url.searchParams.getAll("relay").map(normalizeRelayUrl))];
  if (relays.length === 0) {
    throw new NwcError("NwcParseError", "NWC connection is missing a relay");
  }

  const secret = (url.searchParams.get("secret") ?? "").toLowerCase();
  if (!HEX64_RE.test(secret)) {
    throw new NwcError("NwcParseError", "NWC connection is missing a valid secret");
  }

  const lud16 = url.searchParams.get("lud16")?.trim() || undefined;
  return { walletPubkey, relays, secret, lud16 };
}

export function buildNwcMakeInvoiceRequest(amountSats: number, description?: string) {
  if (!Number.isFinite(amountSats) || amountSats <= 0) {
    throw new NwcError("NwcParseError", "NWC invoice amount must be positive");
  }
  return {
    method: "make_invoice",
    params: {
      amount: Math.round(amountSats * 1000),
      ...(description ? { description } : {}),
    },
  };
}

export function buildNwcPayInvoiceRequest(bolt11: string) {
  const invoice = bolt11.trim();
  if (!isBolt11(invoice)) {
    throw new NwcError("NwcParseError", "NWC pay_invoice needs a BOLT11 invoice");
  }
  return {
    method: "pay_invoice",
    params: {
      invoice,
    },
  };
}

function infoSupportsMethod(infoEvent: MinimalNostrEvent | null, method: string): boolean {
  if (!infoEvent) return true;
  const methods = infoEvent.content.split(/\s+/).map(m => m.trim()).filter(Boolean);
  return methods.length === 0 || methods.includes(method);
}

function pickEncryption(infoEvent: MinimalNostrEvent | null): NwcEncryption {
  const encryptionTag = infoEvent?.tags
    ?.find(t => t[0] === "encryption")
    ?.slice(1)
    .join(" ")
    .toLowerCase();
  if (encryptionTag?.includes("nip44_v2")) return "nip44_v2";
  return "nip04";
}

function parseNwcResponsePayload(raw: string, method: string): any {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new NwcError("NwcMalformedResponse", "NWC wallet returned non-JSON response");
  }
  if (parsed?.error) {
    const code = typeof parsed.error.code === "string" ? parsed.error.code : "OTHER";
    const message = typeof parsed.error.message === "string" ? parsed.error.message : "NWC wallet rejected the request";
    throw new NwcError("NwcWalletError", `${code}: ${message}`);
  }
  if (parsed?.result_type !== method) {
    throw new NwcError("NwcMalformedResponse", "NWC wallet returned the wrong response type");
  }
  return parsed?.result ?? {};
}

// ── Error humanisation (v1.2.5) ─────────────────────────────────────────
//
// Raw NWC error strings look like "INTERNAL: FAILURE_REASON_NO_ROUTE" —
// useful in logs, useless in a toast a user has to read on their phone
// at 2am. `humanizeNwcError` maps the two common shapes — NIP-47
// error codes and BOLT-level FAILURE_REASON_* codes embedded in their
// messages — into copy that says what happened in plain words and
// suggests what to try next.
//
// The function is permissive: pass any error string (or Error.message)
// and it'll return the most-helpful translation it can find, falling
// back to the original string when nothing matches. Cheap to call
// from every error toast site; safe to leave wrapping things that
// aren't NWC errors at all.

const NWC_CODE_COPY: Record<string, string> = {
  // NIP-47 error codes (the prefix before the colon in raw messages).
  RATE_LIMITED:
    "Your Lightning wallet is throttling requests. Wait a moment and try again.",
  NOT_IMPLEMENTED:
    "Your Lightning wallet doesn't support this NWC method. Try a different wallet or update yours.",
  INSUFFICIENT_BALANCE:
    "Your Lightning wallet doesn't have enough sats to pay this invoice.",
  QUOTA_EXCEEDED:
    "Your NWC connection's spending budget is used up. Top it up in your wallet's NWC settings.",
  RESTRICTED:
    "Your NWC connection isn't permitted to pay invoices. Re-pair with payment permission enabled.",
  UNAUTHORIZED:
    "Your NWC connection was rejected by the wallet. Re-pair it.",
  INTERNAL:
    "Your Lightning wallet hit an internal error. Try again, or check the wallet's logs.",
  OTHER:
    "Your Lightning wallet refused the payment. Try again, or check your wallet's logs.",
  PAYMENT_FAILED:
    "The Lightning payment failed. Your sats stay in your wallet — try again.",
  NOT_FOUND:
    "Your Lightning wallet couldn't find the invoice or operation. It may have expired.",
};

// BOLT-spec payment-failure reason codes, often embedded in
// PAYMENT_FAILED / INTERNAL messages from LND-backed wallets.
const NWC_FAILURE_REASON_COPY: Record<string, string> = {
  FAILURE_REASON_NONE:
    "The payment failed but the wallet didn't say why. Try again.",
  FAILURE_REASON_TIMEOUT:
    "Your Lightning node gave up trying to find a route before the deadline. Network congestion or an unresponsive intermediate node. Retry usually works.",
  FAILURE_REASON_NO_ROUTE:
    "Your Lightning node couldn't find a route to the trade's federation gateway. Usually a channel-liquidity or peer-connectivity issue. Retry, or open a bigger / better-connected channel (Zeus LSP is one good option).",
  FAILURE_REASON_ERROR:
    "Your Lightning node hit an error while paying. Check the wallet's logs.",
  FAILURE_REASON_INCORRECT_PAYMENT_DETAILS:
    "The federation gateway rejected the invoice details. The invoice may have already been paid or expired — try again with a fresh one.",
  FAILURE_REASON_INSUFFICIENT_BALANCE:
    "Your Lightning channel doesn't have enough outbound capacity for this payment, even though your balance shows enough total. Rebalance your channels, or open another channel with more outbound liquidity.",
};

export function humanizeNwcError(input: unknown): string {
  const raw =
    typeof input === "string"
      ? input
      : (input as any)?.message
        ? String((input as any).message)
        : String(input ?? "");
  if (!raw) return "Lightning payment failed for an unknown reason.";

  // Most NWC errors come through as `${code}: ${message}` per nwc.ts
  // line 197 — split on the first colon and look the code up.
  const colonIdx = raw.indexOf(":");
  const candidateCode = colonIdx > 0 ? raw.slice(0, colonIdx).trim() : raw.trim();
  const tail = colonIdx > 0 ? raw.slice(colonIdx + 1).trim() : "";

  // BOLT FAILURE_REASON_* often sits in the tail. Check that first so
  // "INTERNAL: FAILURE_REASON_NO_ROUTE" surfaces the routing copy
  // rather than the generic INTERNAL copy.
  const failureReasonMatch = raw.match(/FAILURE_REASON_[A-Z_]+/);
  if (failureReasonMatch) {
    const reasonCopy = NWC_FAILURE_REASON_COPY[failureReasonMatch[0]];
    if (reasonCopy) return reasonCopy;
  }

  if (candidateCode in NWC_CODE_COPY) {
    const codeCopy = NWC_CODE_COPY[candidateCode];
    // If the wallet attached a useful detail in the tail, append it
    // in a parenthetical so the underlying message isn't lost.
    return tail && tail !== candidateCode
      ? `${codeCopy} (wallet said: ${tail})`
      : codeCopy;
  }

  return raw;
}

export function extractInvoiceFromNwcResponse(raw: string): string {
  const result = parseNwcResponsePayload(raw, "make_invoice");
  const invoice = result?.invoice;
  if (typeof invoice !== "string" || !isBolt11(invoice)) {
    throw new NwcError("NwcMalformedResponse", "NWC wallet did not return a BOLT11 invoice");
  }
  return invoice;
}

export function extractPreimageFromNwcPayResponse(raw: string): string | undefined {
  const result = parseNwcResponsePayload(raw, "pay_invoice");
  const preimage = result?.preimage;
  if (preimage !== undefined && typeof preimage !== "string") {
    throw new NwcError("NwcMalformedResponse", "NWC wallet returned an invalid preimage");
  }
  return preimage;
}

async function encryptRequest(
  secretKey: Uint8Array,
  walletPubkey: string,
  plaintext: string,
  encryption: NwcEncryption,
): Promise<string> {
  if (encryption === "nip44_v2") {
    const nip44 = await import("nostr-tools/nip44");
    return nip44.encrypt(plaintext, nip44.getConversationKey(secretKey, walletPubkey));
  }
  const nip04 = await import("nostr-tools/nip04");
  return nip04.encrypt(secretKey, walletPubkey, plaintext);
}

async function decryptResponse(
  secretKey: Uint8Array,
  walletPubkey: string,
  ciphertext: string,
  encryption: NwcEncryption,
): Promise<string> {
  if (encryption === "nip44_v2") {
    const nip44 = await import("nostr-tools/nip44");
    return nip44.decrypt(ciphertext, nip44.getConversationKey(secretKey, walletPubkey));
  }
  const nip04 = await import("nostr-tools/nip04");
  return nip04.decrypt(secretKey, walletPubkey, ciphertext);
}

async function executeNwcRequest(
  connectionString: string,
  request: { method: string; params: Record<string, unknown> },
  opts: {
    timeoutMs?: number;
    infoTimeoutMs?: number;
    publishTimeoutMs?: number;
    now?: () => number;
  } = {},
): Promise<string> {
  const connection = parseNwcConnectionString(connectionString);
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const infoTimeoutMs = opts.infoTimeoutMs ?? 2_500;
  const publishTimeoutMs = opts.publishTimeoutMs ?? 5_000;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const secretKey = hexToBytes(connection.secret);

  const [{ getPublicKey, finalizeEvent }, { SimplePool }] = await Promise.all([
    import("nostr-tools/pure"),
    import("nostr-tools/pool"),
  ]);

  const pool = new SimplePool({ enableReconnect: true });
  const clientPubkey = getPublicKey(secretKey);
  let responseSub: { close: (reason?: string) => void } | undefined;
  const closeResponseSub = (reason: string) => {
    const sub = responseSub;
    if (sub) sub.close(reason);
  };

  try {
    const infoEvent = await pool
      .get(
        connection.relays,
        { kinds: [NWC_INFO_KIND], authors: [connection.walletPubkey], limit: 1 },
        { maxWait: infoTimeoutMs },
      )
      .catch(() => null) as MinimalNostrEvent | null;

    if (!infoSupportsMethod(infoEvent, request.method)) {
      throw new NwcError("NwcUnsupportedWallet", `NWC wallet does not advertise ${request.method} support`);
    }

    const encryption = pickEncryption(infoEvent);
    const content = await encryptRequest(
      secretKey,
      connection.walletPubkey,
      JSON.stringify(request),
      encryption,
    );
    const tags = [
      ["p", connection.walletPubkey],
      ["expiration", String(now() + Math.ceil(timeoutMs / 1000) + 30)],
      ...(encryption === "nip44_v2" ? [["encryption", "nip44_v2"]] : []),
    ];
    const requestEvent = finalizeEvent({
      kind: NWC_REQUEST_KIND,
      created_at: now(),
      tags,
      content,
    }, secretKey) as MinimalNostrEvent;

    const responsePromise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        closeResponseSub("timeout");
        reject(new NwcError("NwcTimeout", "NWC wallet did not answer in time"));
      }, timeoutMs);

      responseSub = pool.subscribeMany(
        connection.relays,
        {
          kinds: [NWC_RESPONSE_KIND],
          authors: [connection.walletPubkey],
          "#p": [clientPubkey],
          since: requestEvent.created_at - 10,
        } as any,
        {
          id: `chama_nwc_${requestEvent.id.slice(0, 12)}`,
          maxWait: timeoutMs,
          onevent: async (event: MinimalNostrEvent) => {
            const eTags = event.tags.filter(t => t[0] === "e").map(t => t[1]);
            if (eTags.length > 0 && !eTags.includes(requestEvent.id)) return;
            try {
              const plaintext = await decryptResponse(secretKey, connection.walletPubkey, event.content, encryption);
              clearTimeout(timer);
              closeResponseSub("received");
              resolve(plaintext);
            } catch (e) {
              if (e instanceof NwcError) {
                clearTimeout(timer);
                closeResponseSub("malformed");
                reject(e);
              }
            }
          },
        },
      );
    });

    const publishPromises = pool.publish(
      connection.relays,
      requestEvent as any,
      { maxWait: publishTimeoutMs },
    );
    try {
      await Promise.any(publishPromises);
    } catch {
      closeResponseSub("publish-failed");
      throw new NwcError("NwcRelayError", "Could not publish NWC request to any wallet relay");
    }

    return await responsePromise;
  } finally {
    closeResponseSub("done");
    pool.close(connection.relays);
  }
}

export async function resolveNwcConnectionToInvoice(
  connectionString: string,
  amountSats: number,
  opts: ResolveNwcInvoiceOpts = {},
): Promise<string> {
  const response = await executeNwcRequest(
    connectionString,
    buildNwcMakeInvoiceRequest(amountSats, opts.description ?? "Chama payout"),
    opts,
  );
  const invoice = extractInvoiceFromNwcResponse(response);
  const invoiceMsats = parseBolt11Msats(invoice);
  const expectedMsats = Math.round(amountSats * 1000);
  if (invoiceMsats !== expectedMsats) {
    throw new NwcError(
      "NwcMalformedResponse",
      "NWC wallet returned an invoice for the wrong amount",
    );
  }
  return invoice;
}

export async function payInvoiceWithNwc(
  connectionString: string,
  bolt11: string,
  opts: NwcPayInvoiceOpts = {},
): Promise<{ preimage?: string }> {
  const response = await executeNwcRequest(
    connectionString,
    buildNwcPayInvoiceRequest(bolt11),
    opts,
  );
  return { preimage: extractPreimageFromNwcPayResponse(response) };
}
