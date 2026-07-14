// ══════════════════════════════════════════════════════════════════════════
// Chama — ChapSmart fiat on-ramp ("Fund with M-Pesa", Tanzania)
// ══════════════════════════════════════════════════════════════════════════
//
// ChapSmart pays the escrow's funding BOLT11 in exchange for a TZS M-Pesa
// payment, so a fiat-only user can fund a lock directly. This is the client
// side of Jetty's `chapsmart.ts` proxy router (the `/buy-sats/*` routes);
// the ChapSmart API key/secret live server-side, the client only talks to
// the proxy. Design brief: chama-chapsmart-fiat-funding-brief.md (see the
// CONFIRMED 2026-07-08 section — shapes below are from ChapSmart API v6).
//
// How it rides the funding flow: the AtomicFundingModal already displays the
// exact-amount BOLT11 and watches for payment. ChapSmart is simply an
// ALTERNATE PAYER of that displayed invoice — the user pays TZS via the
// M-Pesa agent flow, pastes the SMS confirmation code, ChapSmart pays the
// BOLT11, and the existing receive-watcher + LOCK take over. No changes to
// fund-and-lock/useEscrow; the escrow money-path is byte-identical.
//
// The exact-sats wrinkle: ChapSmart's quote is TZS-driven (amountTZS in →
// calculatedSats out) while an escrow invoice is an exact sats amount. Their
// send-sats verification allows the BOLT11 to differ from the quoted sats by
// ±2%, so `getBuyQuoteForSats` estimates the TZS from a reference quote's
// rate and re-quotes until the quote lands well inside that tolerance.
//
// Scope guards (mirrors the off-ramp's context gating):
//   * Tanzania-only (ChapSmart policy — TZ-local users; not IP-enforced,
//     and the proxy masks user IPs anyway, so the gate is honest UX).
//   * Exchange excluded — Exchange IS the P2P on-ramp; the funder there is
//     the seller who already holds sats.
//   * Off in sim (the modal composes `!isSimModeOn()` — no real M-Pesa).

import {
  getScopedStorageItem,
  setScopedStorageItem,
} from "../storage/user-scope.js";
import { isTanzaniaPayoutContext } from "./chapsmart-offramp.js";

// ── Config ───────────────────────────────────────────────────────────────

/** Proxy origin that fronts the ChapSmart backend (holds the API key/secret).
 *  TODO(jetty): point at the redeployed proxy (source: ~/Downloads/chapsmart.ts
 *  → IncogNET VPS behind Caddy, CORS open for Chama origins).
 *  Overridable for local dev via `localStorage.chama_chapsmart_base`. */
const DEFAULT_CHAPSMART_PROXY_BASE = "https://getchama.app/api/chapsmart";

export function chapsmartProxyBase(): string {
  try {
    const override = typeof localStorage !== "undefined" ? localStorage.getItem("chama_chapsmart_base") : null;
    if (override && override.trim()) return override.trim().replace(/\/+$/, "");
  } catch { /* no-op */ }
  return DEFAULT_CHAPSMART_PROXY_BASE;
}

/** Master switch. OFF until the proxy is deployed + the API key issued.
 *  `localStorage.chama_chapsmart_onramp` overrides: "1" force-on (dev/pilot
 *  against a local proxy), "0" force-off. Flip the const to launch. */
export const CHAPSMART_ONRAMP_ENABLED = false;

export function isChapsmartOnrampEnabled(): boolean {
  try {
    const override = typeof localStorage !== "undefined" ? localStorage.getItem("chama_chapsmart_onramp") : null;
    if (override === "1") return true;
    if (override === "0") return false;
  } catch { /* no-op */ }
  return CHAPSMART_ONRAMP_ENABLED;
}

/**
 * Context gate — pure, no enable/sim check (the caller composes those).
 * Tanzania context only (same signal as the LUD-16 off-ramp) and never for
 * Exchange ("p2p-trade"): there the buyer pays fiat P2P and the seller —
 * who already holds sats — is the one funding the lock.
 */
export function isChapsmartOnrampContext(input: {
  homeCommunity?: string | null;
  tradeCommunity?: string | null;
  fiatCurrency?: string | null;
  tradeCategory?: string | null;
}): boolean {
  if (input.tradeCategory === "p2p-trade") return false;
  return isTanzaniaPayoutContext(input);
}

// ── M-Pesa payment instructions (Jetty-confirmed 2026-07-08) ─────────────
//
// ChapSmart receives the fiat via the M-Pesa AGENT-WITHDRAWAL flow (Kutoa
// Pesa) — NOT a paybill. The SMS confirmation code the user receives after
// confirming IS the `mpesaId` for send-sats.

export const CHAPSMART_MPESA_USSD = "*150*00#";
export const CHAPSMART_MPESA_AGENT_NUMBER = "1228685";
export const CHAPSMART_MPESA_AGENT_NAME = "BRIAN";

export interface MpesaPayStep {
  sw: string;
  en: string;
}

/** The numbered USSD steps for the funding modal, Swahili-first with an
 *  English gloss. `amountTZS` must be the EXACT quoted amount — ChapSmart
 *  verifies the M-Pesa payment amount against the quote to the shilling. */
export function chapsmartMpesaPaySteps(amountTZS: number): MpesaPayStep[] {
  const tzs = formatTzs(amountTZS);
  return [
    { sw: `Piga ${CHAPSMART_MPESA_USSD}`, en: `Dial ${CHAPSMART_MPESA_USSD}` },
    { sw: "Chagua 2 – Kutoa Pesa", en: "Choose 2 – Withdraw money" },
    {
      sw: `Weka namba ya wakala: ${CHAPSMART_MPESA_AGENT_NUMBER}`,
      en: `Enter agent number: ${CHAPSMART_MPESA_AGENT_NUMBER}`,
    },
    { sw: `Ingiza kiasi: TZS ${tzs}`, en: `Enter amount: TZS ${tzs} (exactly)` },
    {
      sw: `Jina: ${CHAPSMART_MPESA_AGENT_NAME}`,
      en: `The name shown should read ${CHAPSMART_MPESA_AGENT_NAME}`,
    },
    { sw: "Weka namba yako ya siri na uthibitishe", en: "Enter your PIN and confirm" },
  ];
}

export function formatTzs(amountTZS: number): string {
  return Math.round(amountTZS).toLocaleString("en-US");
}

/**
 * Normalize a pasted M-Pesa confirmation code (e.g. `XKR4MPT9QZN` from the
 * SMS), or null if it can't be one. Uppercase alphanumeric, 8–14 chars after
 * stripping whitespace — loose on purpose; `/buy/mpesa-lookup` is the real
 * validator, this just catches obvious paste mistakes before a round-trip.
 */
export function normalizeMpesaConfirmationCode(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const stripped = raw.trim().replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z0-9]{8,14}$/.test(stripped)) return null;
  return stripped;
}

// ── Wire types (ChapSmart API v6, via the proxy) ─────────────────────────

export class ChapsmartApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ChapsmartApiError";
    this.status = status;
  }
}

/** Map proxy/ChapSmart failures to copy a funding user can act on.
 *  Codes from the v6 doc §7. */
export function friendlyChapsmartError(e: unknown): string {
  const status = e instanceof ChapsmartApiError ? e.status : undefined;
  const fallback = e instanceof Error && e.message ? e.message : "ChapSmart request failed";
  switch (status) {
    case 409:
      return "That M-Pesa code was already used, or the amount doesn't match the quote. Check the code and the exact TZS amount.";
    case 410:
      return "The price quote expired (30 min). Get a fresh quote and pay the new amount.";
    case 429:
      return "Too many requests — wait a minute and try again.";
    case 503:
      return "ChapSmart can't fetch the live BTC price right now. Try again shortly.";
    default:
      return fallback;
  }
}

export interface ChapsmartBuyQuote {
  quoteId: string;
  /** What the user must pay via M-Pesa, in TZS — EXACT (server-verified). */
  amountTZS: number;
  /** What ChapSmart will pay out, in sats, at the locked price. */
  calculatedSats: number;
  /** Live BTC/USDT price the quote locked (display only). */
  btcPrice?: number;
  raw?: unknown;
}

export interface ChapsmartMpesaLookup {
  found: boolean;
  /** TZS amount of the M-Pesa transaction, when found. */
  amount?: number;
  phoneNumber?: string;
  senderName?: string;
  raw?: unknown;
}

export interface ChapsmartSendResult {
  success: boolean;
  status?: string;
  raw?: unknown;
}

// ── Proxy calls ──────────────────────────────────────────────────────────

async function postProxy<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${chapsmartProxyBase()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || data?.success === false) {
    throw new ChapsmartApiError(
      data?.error || `ChapSmart request failed (${res.status})`,
      res.status,
    );
  }
  return data as T;
}

/** ChapSmart account number for this npub — create-on-first-use (anonymous
 *  16-digit account via the proxy), persisted user-scoped. The NIP-98 nostr
 *  signup/link is a later nicety; funding only needs SOME account. */
export async function ensureChapsmartAccount(): Promise<string> {
  const KEY = "chama_chapsmart_account_v1";
  try {
    const existing = getScopedStorageItem(KEY);
    if (existing && existing.trim()) return existing.trim();
  } catch { /* fall through to create */ }
  const data = await postProxy<any>("/create-account", {});
  const accountNumber = String(data?.accountNumber ?? "").trim();
  if (!accountNumber) {
    throw new ChapsmartApiError("ChapSmart account creation returned no account number");
  }
  try {
    setScopedStorageItem(KEY, accountNumber);
  } catch { /* non-fatal — recreated next time */ }
  return accountNumber;
}

/** Quote what `amountTZS` buys. Mirrors `POST /buy-sats/quote` → ChapSmart
 *  `/api/v1/buy/quote`. Quotes are single-use with a 30-minute TTL. */
export async function getBuyQuote(req: {
  amountTZS: number;
  accountNumber: string;
}): Promise<ChapsmartBuyQuote> {
  const data = await postProxy<any>("/buy-sats/quote", {
    amountTZS: Math.round(req.amountTZS),
    accountNumber: req.accountNumber,
  });
  const quote: ChapsmartBuyQuote = {
    quoteId: String(data?.quoteId ?? ""),
    amountTZS: Number(data?.amountTZS ?? req.amountTZS),
    calculatedSats: Number(data?.calculatedSats ?? 0),
    btcPrice: typeof data?.btcPrice === "number" ? data.btcPrice : undefined,
    raw: data,
  };
  if (!quote.quoteId || !Number.isFinite(quote.calculatedSats) || quote.calculatedSats <= 0) {
    throw new ChapsmartApiError("ChapSmart returned an unusable quote");
  }
  return quote;
}

// ── Exact-sats quoting (the escrow-funding adapter) ──────────────────────

/** Server-enforced BOLT11-vs-quote tolerance (v6 §9.2: ±2%). */
export const CHAPSMART_SEND_SATS_TOLERANCE = 0.02;
/** Our stricter acceptance target, leaving margin inside the server's 2%
 *  for rounding + any price drift between quote and send. */
export const CHAPSMART_TARGET_TOLERANCE = 0.012;
/** Reference probe amount used to learn the current sats-per-TZS rate. */
export const CHAPSMART_REFERENCE_TZS = 10_000;

/** True when a quote's sats are close enough to the invoice's exact sats.
 *  Conservative denominator (the smaller of the two) so we're inside the
 *  server's ±2% under either interpretation. */
export function quoteMatchesTargetSats(
  quoteSats: number,
  targetSats: number,
  tolerance = CHAPSMART_TARGET_TOLERANCE,
): boolean {
  if (!Number.isFinite(quoteSats) || !Number.isFinite(targetSats)) return false;
  if (quoteSats <= 0 || targetSats <= 0) return false;
  const deviation = Math.abs(quoteSats - targetSats) / Math.min(quoteSats, targetSats);
  return deviation <= tolerance;
}

/** Estimate the integer TZS that buys `targetSats`, given a reference quote
 *  (refTZS bought refSats). M-Pesa amounts are whole shillings. */
export function estimateTzsForTargetSats(
  targetSats: number,
  refTZS: number,
  refSats: number,
): number {
  if (
    !Number.isFinite(targetSats) || targetSats <= 0 ||
    !Number.isFinite(refTZS) || refTZS <= 0 ||
    !Number.isFinite(refSats) || refSats <= 0
  ) {
    throw new ChapsmartApiError("Cannot estimate TZS from a degenerate reference quote");
  }
  return Math.max(1, Math.round((targetSats * refTZS) / refSats));
}

/**
 * Get a buy quote whose sats land within tolerance of an EXACT sats target
 * (the escrow funding invoice amount). Probe at a reference TZS to learn
 * the rate, then re-quote at the estimated TZS; each retry re-estimates
 * from the freshest quote. Unused quotes just expire server-side (they're
 * only marked used when sats are sent), so burned probes are harmless.
 *
 * `fetchQuote` is injectable for tests.
 */
export async function getBuyQuoteForSats(opts: {
  targetSats: number;
  accountNumber: string;
  maxAttempts?: number;
  fetchQuote?: (req: { amountTZS: number; accountNumber: string }) => Promise<ChapsmartBuyQuote>;
}): Promise<ChapsmartBuyQuote> {
  const { targetSats, accountNumber } = opts;
  const fetchQuote = opts.fetchQuote ?? getBuyQuote;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  if (!Number.isFinite(targetSats) || targetSats <= 0) {
    throw new ChapsmartApiError("Invalid target sats amount");
  }

  let reference = await fetchQuote({ amountTZS: CHAPSMART_REFERENCE_TZS, accountNumber });
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const tzs = estimateTzsForTargetSats(targetSats, reference.amountTZS, reference.calculatedSats);
    const quote = await fetchQuote({ amountTZS: tzs, accountNumber });
    if (quoteMatchesTargetSats(quote.calculatedSats, targetSats)) return quote;
    reference = quote;
  }
  throw new ChapsmartApiError(
    "Couldn't get a ChapSmart quote matching the trade amount — the BTC price may be moving. Try again.",
  );
}

// ── Payment verification + submission ────────────────────────────────────

/** Pre-validate a pasted confirmation code via `/buy/mpesa-lookup`
 *  (read-only) BEFORE send-sats — catches typos and too-early pastes with a
 *  friendly message instead of a 409. */
export async function lookupMpesaTransaction(mpesaId: string): Promise<ChapsmartMpesaLookup> {
  const data = await postProxy<any>("/buy-sats/mpesa-lookup", { mpesaId });
  return {
    found: data?.found === true,
    amount: typeof data?.amount === "number" ? data.amount : undefined,
    phoneNumber: typeof data?.phoneNumber === "string" ? data.phoneNumber : undefined,
    senderName: typeof data?.senderName === "string" ? data.senderName : undefined,
    raw: data,
  };
}

/** Ask ChapSmart to PAY the funding BOLT11. Server verifies: quote live +
 *  unused, M-Pesa amount == quote TZS, BOLT11 within ±2% of quote sats,
 *  mpesaId never used before (replay protection). On success the sats land
 *  in the user's own Fedimint wallet via the invoice and the atomic
 *  fund-and-lock's receive-watcher takes over — nothing more to do here. */
export async function sendBuySats(req: {
  quoteId: string;
  bolt11: string;
  mpesaId: string;
}): Promise<ChapsmartSendResult> {
  const data = await postProxy<any>("/buy-sats/send", req);
  return {
    success: data?.success !== false,
    status: typeof data?.status === "string" ? data.status : undefined,
    raw: data,
  };
}
