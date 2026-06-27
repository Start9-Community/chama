// ══════════════════════════════════════════════════════════════════════════
// Chama — Strike US-dollar offramp (LUD-16)  [the US mirror of Tando]
// ══════════════════════════════════════════════════════════════════════════
//
// A Strike username IS a LUD-16 Lightning Address: `<username>@strike.me`. With
// the user's Strike "default receive currency" set to **Cash (USD)**, inbound
// Lightning auto-converts to USD in their Strike balance (withdrawable to a US
// bank by ACH). So the US off-ramp is "pay a fiat-converting Lightning Address"
// — exactly the Tando pattern, lighter: there's no phone→MSISDN step, a Strike
// address is already a valid destination. Chama just pays it via the existing
// LUD-16 client path (`resolveLightningAddressToInvoice`, lnurl.ts) — NOT a
// redirect, so it also dodges the Tauri `window.open` opener bug (#16).
//
// NO new custody and NO money-transmitter surface: Chama sends sats; the
// conversion + rate + ACH all happen inside the user's OWN Strike account.
// Chama can't set the receive currency for them, hence the one-time hint.
// Provider-agnostic by design — Cash App / Bitcoin Well are drop-in siblings
// on the same seam (v1 ships Strike only).
//
// Resolve via LNURL-pay (.well-known/lnurlp/<username>), NEVER the captcha-
// gated `strike.me/<user>` web page. See DECISIONS / BACKLOG 2026-06-26.

/** Strike's live Lightning-Address host. */
export const STRIKE_LNADDRESS_DOMAIN = "strike.me";

/** One-time hint shown when a user saves a Strike destination. Chama cannot
 *  flip this setting for them — left on Bitcoin, they just receive sats. */
export const STRIKE_CASH_HINT =
  "In Strike, set your default receive currency to Cash (USD) so incoming " +
  "Lightning lands as dollars. Left on Bitcoin, you'll just receive sats.";

/**
 * Normalize a user-typed Strike identity to a bare lowercase username, or null
 * if it isn't a plausible Strike username.
 *
 * Accepted input shapes (surrounding spaces ignored):
 *   - `username`                    (bare handle)
 *   - `@username`                   (leading @, as people often type it)
 *   - `username@strike.me`          (full Lightning Address)
 *   - `https://strike.me/username`  (profile URL — we extract the handle and
 *                                    resolve via LNURL, never load the page)
 *
 * Strike usernames are alphanumeric and may contain `.`, `_` or `-`; they must
 * start with an alphanumeric and be 2–30 chars. Case-insensitive (lowercased
 * so it dedupes cleanly in the payout-destinations store, which keys by
 * lowercased address).
 */
export function normalizeStrikeUsername(raw: string): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim().toLowerCase();
  if (!s) return null;

  // Profile URL → take the first path segment as the handle.
  const urlMatch = s.match(/^https?:\/\/strike\.me\/([^/?#]+)/);
  if (urlMatch) s = urlMatch[1]!;

  // Leading-@ form (people type `@alice`) — strip it BEFORE host parsing so it
  // isn't misread as a Lightning Address whose host is the username.
  s = s.replace(/^@/, "");

  // Full Lightning Address → take the local part (must be the Strike host).
  if (s.includes("@")) {
    const [local, host, ...rest] = s.split("@");
    if (rest.length > 0) return null; // more than one '@' → malformed
    if (host !== STRIKE_LNADDRESS_DOMAIN) return null;
    s = local ?? "";
  }

  if (!/^[a-z0-9][a-z0-9._-]{1,29}$/.test(s)) return null;
  return s;
}

/** True iff `raw` is a usable Strike username / address. Never throws. */
export function isValidStrikeUsername(raw: string): boolean {
  return normalizeStrikeUsername(raw) !== null;
}

/**
 * Build the canonical Strike Lightning Address for a username/identity, or
 * null if it isn't a valid Strike username. Result is normalized lowercase so
 * it dedupes cleanly in the payout-destinations store.
 */
export function buildStrikeLightningAddress(rawUsername: string): string | null {
  const username = normalizeStrikeUsername(rawUsername);
  if (!username) return null;
  return `${username}@${STRIKE_LNADDRESS_DOMAIN}`;
}

/** True iff a (saved) Lightning Address is a Strike address. */
export function isStrikeLightningAddress(address: string): boolean {
  return (
    typeof address === "string" &&
    address.trim().toLowerCase().endsWith(`@${STRIKE_LNADDRESS_DOMAIN}`)
  );
}

/**
 * Recover the username from a saved Strike Lightning Address, or null if the
 * address isn't a valid Strike address. Used to pre-fill the username field
 * from a saved payout destination.
 */
export function strikeUsernameFromAddress(address: string): string | null {
  if (!isStrikeLightningAddress(address)) return null;
  const local = address.trim().toLowerCase().split("@")[0];
  return normalizeStrikeUsername(local ?? "");
}

/**
 * True when a claim/payout context is a US-dollar one, so the Strike USD
 * offramp should be offered. Matches the `us-` community family (GBF "USA ·
 * USD", us-usd shells) or a USD fiat currency. USD-currency contexts include
 * dollarized economies (e.g. Ecuador, El Salvador) where Strike also operates,
 * so they qualify too — Strike, not Chama, enforces its own availability.
 * Independent of EXTERNAL_SWAPS_ENABLED — Strike rides the always-available
 * Lightning-Address payout path (Tando precedent).
 */
export function isUSPayoutContext(input: {
  homeCommunity?: string | null;
  tradeCommunity?: string | null;
  fiatCurrency?: string | null;
}): boolean {
  const isUSSlug = (slug?: string | null): boolean =>
    !!slug && slug.toLowerCase().startsWith("us-");
  if (isUSSlug(input.tradeCommunity) || isUSSlug(input.homeCommunity)) {
    return true;
  }
  return (input.fiatCurrency ?? "").trim().toUpperCase() === "USD";
}
