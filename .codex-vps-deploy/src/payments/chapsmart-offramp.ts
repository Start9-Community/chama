// ══════════════════════════════════════════════════════════════════════════
// Chama — ChapSmart native M-Pesa offramp, Tanzania (LUD-16)
// ══════════════════════════════════════════════════════════════════════════
//
// ChapSmart (live July 2026) exposes every Tanzanian Vodacom M-Pesa number as a
// Lightning Address: `<phone>@chapsmart.com`. Pay that address and the recipient
// gets TZS in M-Pesa in ~60s. Chama already has the LUD-16 client payout path
// (`resolveLightningAddressToInvoice`, lnurl.ts), so ChapSmart drops in as "just
// a Lightning Address" — NOT a redirect, exactly like Tando (bitcoin.co.ke).
//
// This is the small, pure mirror of tando-offramp.ts for Tanzania: turn a Vodacom
// number a user types into the canonical `<msisdn>@chapsmart.com` Lightning
// Address (and back), validate it client-side before any network call, and help
// the claim modal recognise saved ChapSmart numbers in the shared payout-
// destinations store.
//
// Domain is chapsmart.com (ChapSmart's live LUD-16 host — verified conformant),
// NOT the old nwc.chapsmart.com NWC endpoint (dead; that integration was removed).
//
// ⚠ Vodacom-only: M-Pesa in Tanzania runs on Vodacom, and ChapSmart rejects
// Tigo/Airtel/Halotel numbers. We validate the Vodacom M-Pesa prefixes client-side
// so a wrong-network number fails fast (before a round-trip), matching Tando's
// "reject malformed input before the network call" principle. If ChapSmart ever
// adds networks, widen VODACOM_NATIONAL_PREFIX below.

/** ChapSmart's live Lightning-Address host. */
export const CHAPSMART_LNADDRESS_DOMAIN = "chapsmart.com";

// Vodacom Tanzania M-Pesa national prefixes (first two digits of the 9-digit
// national number): 74x, 75x, 76x, 79x — i.e. local 0740–0769 and 0790–0799.
const VODACOM_NATIONAL_PREFIX = /^(74|75|76|79)\d{7}$/;

/**
 * Normalize a user-typed Tanzanian Vodacom number to a bare MSISDN
 * (`255` + 9 national digits), or null if it isn't a valid Vodacom M-Pesa number.
 *
 * Accepted input shapes (spaces, dashes, parens and a leading `+` are ignored):
 *   - `2557XXXXXXXX`  (full MSISDN, 12 digits)
 *   - `07XXXXXXXX`    (local trunk-0 form, 10 digits)
 *   - `7XXXXXXXX`     (national significant number, 9 digits)
 *
 * The national number must be 9 digits beginning with a Vodacom M-Pesa prefix
 * (74/75/76/79). ChapSmart expects the full MSISDN with no leading `+`, e.g.
 * `255740034110`.
 */
export function normalizeTanzanianMsisdn(raw: string): string | null {
  if (typeof raw !== "string") return null;
  // Strip everything a human might type around the digits.
  const stripped = raw.trim().replace(/[\s()\-.]/g, "").replace(/^\+/, "");
  if (!/^\d+$/.test(stripped)) return null;

  let national: string | null = null;
  if (/^255\d{9}$/.test(stripped)) national = stripped.slice(3);
  else if (/^0\d{9}$/.test(stripped)) national = stripped.slice(1);
  else if (/^\d{9}$/.test(stripped)) national = stripped;

  if (national === null) return null;
  // Vodacom M-Pesa only (Tigo/Airtel/Halotel are rejected by ChapSmart).
  if (!VODACOM_NATIONAL_PREFIX.test(national)) return null;

  return `255${national}`;
}

/** True iff `raw` is a valid Tanzanian Vodacom M-Pesa mobile number. Never throws. */
export function isValidTanzanianMsisdn(raw: string): boolean {
  return normalizeTanzanianMsisdn(raw) !== null;
}

/**
 * Build the canonical ChapSmart Lightning Address for a phone number, or null
 * if the number isn't a valid Vodacom MSISDN. Result is normalized lowercase so
 * it dedupes cleanly in the payout-destinations store (which keys by lowercased
 * address).
 */
export function buildChapsmartLightningAddress(rawPhone: string): string | null {
  const msisdn = normalizeTanzanianMsisdn(rawPhone);
  if (!msisdn) return null;
  return `${msisdn}@${CHAPSMART_LNADDRESS_DOMAIN}`;
}

/**
 * Render an MSISDN in the familiar local form `0740 034 110` for display.
 * Falls back to the raw input if it can't be normalized.
 */
export function formatTanzanianMsisdnDisplay(raw: string): string {
  const msisdn = normalizeTanzanianMsisdn(raw);
  if (!msisdn) return raw;
  const national = msisdn.slice(3); // 9 digits
  return `0${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`;
}

/** True iff a (saved) Lightning Address is a ChapSmart M-Pesa address. */
export function isChapsmartLightningAddress(address: string): boolean {
  return (
    typeof address === "string" &&
    address.trim().toLowerCase().endsWith(`@${CHAPSMART_LNADDRESS_DOMAIN}`)
  );
}

/**
 * Recover the MSISDN from a saved ChapSmart Lightning Address, or null if the
 * address isn't a valid ChapSmart address. Used to pre-fill the phone field from
 * a saved payout destination.
 */
export function chapsmartMsisdnFromAddress(address: string): string | null {
  if (!isChapsmartLightningAddress(address)) return null;
  const local = address.trim().toLowerCase().split("@")[0];
  return normalizeTanzanianMsisdn(local);
}

/**
 * True when a claim/payout context is Tanzanian, so the native ChapSmart M-Pesa
 * offramp should be offered. Matches the `tz-tzs` community family or a TZS fiat
 * currency. Independent of EXTERNAL_SWAPS_ENABLED — ChapSmart rides the always-
 * available Lightning-Address payout path (mirrors isKenyaPayoutContext).
 */
export function isTanzaniaPayoutContext(input: {
  homeCommunity?: string | null;
  tradeCommunity?: string | null;
  fiatCurrency?: string | null;
}): boolean {
  const isTanzaniaSlug = (slug?: string | null): boolean =>
    !!slug && slug.toLowerCase().startsWith("tz-tzs");
  const currency = (input.fiatCurrency ?? "").trim().toUpperCase();
  // The TRADE context is authoritative (mirrors isKenyaPayoutContext): a TZ-home
  // user cashing out a foreign-currency trade must NOT see M-Pesa. Home is only
  // the fallback for a context-less claim (no community AND no currency tag).
  if (input.tradeCommunity || currency) {
    return isTanzaniaSlug(input.tradeCommunity) || currency === "TZS";
  }
  return isTanzaniaSlug(input.homeCommunity);
}
