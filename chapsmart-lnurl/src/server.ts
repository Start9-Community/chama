// LUD-16 (Lightning Address) server over LUD-06 payRequest, backed by phoenixd.
//
// Flow a wallet performs for  <username>@<host> :
//   1. GET https://<host>/.well-known/lnurlp/<username>   -> payRequest JSON
//   2. GET <callback>?amount=<msat>[&comment=...]          -> { pr: <bolt11> }
//
// The only non-obvious correctness rule (LUD-06): the bolt11 invoice's
// description hash MUST equal sha256(the exact metadata string from step 1).

import express, { type Request, type Response } from "express";
import { config } from "./config";
import {
  USERNAME_RE,
  buildMetadata,
  buildPayRequest,
  lightningAddress,
  sha256Hex,
} from "./lnurl";
import { createInvoiceWithDescriptionHash } from "./phoenixd";

const app = express();
app.disable("x-powered-by");

// LNURL clients — including in-browser wallets — fetch these endpoints
// cross-origin, so permissive CORS is required.
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  next();
});

const MIN_MSAT = config.minSendableSat * 1000;
const MAX_MSAT = config.maxSendableSat * 1000;

function lnurlError(res: Response, reason: string, status = 400) {
  return res.status(status).json({ status: "ERROR", reason });
}

/** Validate + apply the optional allowlist. Returns the normalised name or null. */
function resolveUsername(raw: string): string | null {
  const u = raw.toLowerCase();
  if (!USERNAME_RE.test(u)) return null;
  if (config.allowedUsernames.length && !config.allowedUsernames.includes(u)) {
    return null;
  }
  return u;
}

// --- Step 1: payRequest (LUD-16 well-known + LUD-06 direct path) ------------
function payRequestHandler(req: Request, res: Response) {
  const username = resolveUsername(req.params.username);
  if (!username) return lnurlError(res, "Unknown or invalid username", 404);

  return res.json(
    buildPayRequest({
      username,
      hostname: config.hostname,
      minSendableMsat: MIN_MSAT,
      maxSendableMsat: MAX_MSAT,
      commentAllowed: config.commentAllowed,
    }),
  );
}

app.get("/.well-known/lnurlp/:username", payRequestHandler);
app.get("/lnurlp/:username", payRequestHandler);

// --- Step 2: callback -> bolt11 --------------------------------------------
app.get("/lnurlp/:username/callback", async (req, res) => {
  try {
    const username = resolveUsername(req.params.username);
    if (!username) return lnurlError(res, "Unknown or invalid username", 404);

    // `amount` is in MILLISATOSHIS per LUD-06.
    const amountRaw = req.query.amount;
    if (typeof amountRaw !== "string" || !/^\d+$/.test(amountRaw)) {
      return lnurlError(res, "Missing or invalid 'amount' (millisatoshis)");
    }
    const amountMsat = Number(amountRaw);
    if (amountMsat < MIN_MSAT || amountMsat > MAX_MSAT) {
      return lnurlError(res, `Amount out of range (${MIN_MSAT}..${MAX_MSAT} msat)`);
    }
    // phoenixd issues invoices in whole satoshis.
    if (amountMsat % 1000 !== 0) {
      return lnurlError(res, "Amount must be a whole number of sats (multiple of 1000 msat)");
    }

    // LUD-12 comment: validated, but deliberately NOT folded into the hash.
    const comment = typeof req.query.comment === "string" ? req.query.comment : "";
    if (config.commentAllowed > 0 && comment.length > config.commentAllowed) {
      return lnurlError(res, `Comment too long (max ${config.commentAllowed})`);
    }

    // CRITICAL: hash the SAME metadata string we served in step 1.
    const metadata = buildMetadata(username, config.hostname);
    const descriptionHash = sha256Hex(metadata);

    const invoice = await createInvoiceWithDescriptionHash({
      amountSat: amountMsat / 1000,
      descriptionHash,
      externalId: lightningAddress(username, config.hostname), // attribution
    });

    if (comment) {
      // Persist this however you like; it must not alter the invoice.
      console.log(`[pay] ${username} ${amountMsat}msat comment=${JSON.stringify(comment)}`);
    }

    return res.json({
      pr: invoice.serialized,
      routes: [],
      ...(config.successMessage
        ? { successAction: { tag: "message", message: config.successMessage } }
        : {}),
    });
  } catch (err) {
    console.error("[callback] error:", err);
    return lnurlError(res, "Failed to create invoice", 502);
  }
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.listen(config.port, () => {
  console.log(
    `LUD-16 server listening on :${config.port}  (address domain: ${config.hostname})`,
  );
});
