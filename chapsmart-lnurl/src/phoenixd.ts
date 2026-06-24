// Thin client for the phoenixd HTTP API (the only part of this server that
// touches a Lightning node). Swap this file out to target LND/CLN/LNbits/etc.
//
// phoenixd API reference: https://phoenix.acinq.co/server/api
//   POST /createinvoice   (application/x-www-form-urlencoded)
//     amountSat        Long
//     description      String   ── use EITHER description …
//     descriptionHash  String   ── … OR descriptionHash (hex). LNURL needs this.
//     externalId       String?  (free-form tag, handy for attribution)
//     expirySeconds    Long?
//     webhookUrl       String?
//   → { amountSat, paymentHash, serialized }   // `serialized` is the bolt11

import { config } from "./config";

export interface CreatedInvoice {
  paymentHash: string;
  serialized: string; // bolt11 invoice
  amountSat: number;
}

function authHeader(): string {
  const token = Buffer.from(
    `${config.phoenixd.username}:${config.phoenixd.password}`,
  ).toString("base64");
  return `Basic ${token}`;
}

export async function createInvoiceWithDescriptionHash(opts: {
  amountSat: number;
  descriptionHash: string; // hex-encoded sha256 of the LUD-06 metadata string
  externalId?: string;
  expirySeconds?: number;
}): Promise<CreatedInvoice> {
  const body = new URLSearchParams();
  body.set("amountSat", String(opts.amountSat));
  body.set("descriptionHash", opts.descriptionHash);
  if (opts.externalId) body.set("externalId", opts.externalId);
  if (opts.expirySeconds) body.set("expirySeconds", String(opts.expirySeconds));

  const res = await fetch(`${config.phoenixd.base}/createinvoice`, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`phoenixd createinvoice ${res.status}: ${text}`);
  }

  let data: { amountSat?: number; paymentHash?: string; serialized?: string };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`phoenixd returned non-JSON: ${text}`);
  }

  // `serialized` is phoenixd's field for the bolt11 string.
  if (!data.serialized || !data.paymentHash) {
    throw new Error(`phoenixd response missing fields: ${text}`);
  }

  return {
    paymentHash: data.paymentHash,
    serialized: data.serialized,
    amountSat: data.amountSat ?? opts.amountSat,
  };
}
