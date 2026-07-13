// ══════════════════════════════════════════════════════════════════════════
// Chama — Tando native M-Pesa offramp (LUD-16)
// ══════════════════════════════════════════════════════════════════════════
//
// Tando (live May 2026) exposes every Kenyan M-Pesa number as a Lightning
// Address: `<phone>@bitcoin.co.ke`. Pay that address and the recipient gets
// KES in M-Pesa in <40s, non-custodial. Chama already has the LUD-16 client
// payout path (`resolveLightningAddressToInvoice`, lnurl.ts), so Tando drops
// in as "just a Lightning Address" — NOT a redirect. This is Kenya's lead
// cash-out and the standard every other provider can follow.
//
// This module is the small, pure layer on top of that: turn an M-Pesa phone
// number a user types into the canonical `<msisdn>@bitcoin.co.ke` Lightning
// Address (and back), validate it client-side before any network call, and
// help the claim modal recognise saved Tando numbers in the shared payout-
// destinations store (a Tando number IS a Lightning Address, so it lives in
// the same store as every other saved destination — no parallel store).
//
// The domain is bitcoin.co.ke (Tando's live LUD-16 host), NOT the old
// use.tando.me redirect URL.

/** Tando's live Lightning-Address host. */
export const TANDO_LNADDRESS_DOMAIN = "bitcoin.co.ke";

/**
 * Normalize a user-typed Kenyan mobile number to a bare MSISDN
 * (`254` + 9 national digits), or null if it isn't a valid Kenyan mobile.
 *
 * Accepted input shapes (spaces, dashes, parens and a leading `+` are
 * ignored):
 *   - `2547XXXXXXXX` / `2541XXXXXXXX`  (full MSISDN)
 *   - `07XXXXXXXX`   / `01XXXXXXXX`    (local trunk-0 form)
 *   - `7XXXXXXXX`    / `1XXXXXXXX`     (national significant number)
 *
 * The national number must be 9 digits beginning with 7 (Safaricom 07…) or
 * 1 (the newer 01… range). M-Pesa is Safaricom, and bitcoin.co.ke expects
 * the full MSISDN with no leading `+`, e.g. `254712345678`.
 */
export function normalizeKenyanMsisdn(raw: string): string | null {
  if (typeof raw !== "string") return null;
  // Strip everything a human might type around the digits.
  const stripped = raw.trim().replace(/[\s()\-.]/g, "").replace(/^\+/, "");
  if (!/^\d+$/.test(stripped)) return null;

  let national: string | null = null;
  if (/^254\d{9}$/.test(stripped)) national = stripped.slice(3);
  else if (/^0\d{9}$/.test(stripped)) national = stripped.slice(1);
  else if (/^\d{9}$/.test(stripped)) national = stripped;

  if (national === null) return null;
  // Kenyan mobile national numbers start with 7 or 1.
  if (!/^[17]\d{8}$/.test(national)) return null;

  return `254${national}`;
}

/** True iff `raw` is a valid Kenyan M-Pesa mobile number. Never throws. */
export function isValidKenyanMsisdn(raw: string): boolean {
  return normalizeKenyanMsisdn(raw) !== null;
}

/**
 * Build the canonical Tando Lightning Address for a phone number, or null
 * if the number isn't a valid Kenyan MSISDN. Result is normalized lowercase
 * (digits are unaffected) so it dedupes cleanly in the payout-destinations
 * store, which keys by lowercased address.
 */
export function buildTandoLightningAddress(rawPhone: string): string | null {
  const msisdn = normalizeKenyanMsisdn(rawPhone);
  if (!msisdn) return null;
  return `${msisdn}@${TANDO_LNADDRESS_DOMAIN}`;
}

/**
 * Render an MSISDN in the familiar local form `0712 345 678` for display.
 * Falls back to the raw input if it can't be normalized.
 */
export function formatKenyanMsisdnDisplay(raw: string): string {
  const msisdn = normalizeKenyanMsisdn(raw);
  if (!msisdn) return raw;
  const national = msisdn.slice(3); // 9 digits
  return `0${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`;
}

/** True iff a (saved) Lightning Address is a Tando M-Pesa address. */
export function isTandoLightningAddress(address: string): boolean {
  return (
    typeof address === "string" &&
    address.trim().toLowerCase().endsWith(`@${TANDO_LNADDRESS_DOMAIN}`)
  );
}

/**
 * Recover the MSISDN from a saved Tando Lightning Address, or null if the
 * address isn't a valid Tando address. Used to pre-fill the phone field
 * from a saved payout destination.
 */
export function tandoMsisdnFromAddress(address: string): string | null {
  if (!isTandoLightningAddress(address)) return null;
  const local = address.trim().toLowerCase().split("@")[0];
  return normalizeKenyanMsisdn(local);
}

/**
 * True when a claim/payout context is Kenyan, so the native Tando M-Pesa
 * offramp should be offered. Matches the `ke-kes` community family or a KES
 * fiat currency. Independent of EXTERNAL_SWAPS_ENABLED — Tando rides the
 * always-available Lightning-Address payout path.
 */
export function isKenyaPayoutContext(input: {
  homeCommunity?: string | null;
  tradeCommunity?: string | null;
  fiatCurrency?: string | null;
}): boolean {
  const isKenyaSlug = (slug?: string | null): boolean =>
    !!slug && slug.toLowerCase().startsWith("ke-kes");
  const currency = (input.fiatCurrency ?? "").trim().toUpperCase();
  // The TRADE context is authoritative: when the claim carries a community or a
  // currency, decide from THAT alone — a Kenyan-home user cashing out a Cameroon
  // (XAF) trade must NOT see M-Pesa (it's unusable there). Home is only the
  // fallback for a context-less claim (legacy: no community AND no currency tag).
  if (input.tradeCommunity || currency) {
    return isKenyaSlug(input.tradeCommunity) || currency === "KES";
  }
  return isKenyaSlug(input.homeCommunity);
}
