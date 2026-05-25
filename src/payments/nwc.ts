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
