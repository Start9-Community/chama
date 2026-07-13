// ══════════════════════════════════════════════════════════════════════════
// Chama — Strike US-dollar offramp (LUD-16)  [the US mirror of Tando]
// ══════════════════════════════════════════════════════════════════════════
//
// A Strike username IS a LUD-16 Lightning Address: `<username>@strike.me`. With
// the user's Strike receive currency set to Cash, passive inbound Lightning
// arrives in their cash balance. So the US off-ramp is "pay a fiat-converting
// Lightning Address" — exactly the Tando pattern, lighter: there's no phone→
// MSISDN step, a Strike address is already a valid destination. Chama just pays
// it via the existing LUD-16 client path (`resolveLightningAddressToInvoice`,
// lnurl.ts) — NOT a redirect, so it also dodges the Tauri `window.open` opener
// bug (#16).
//
// NO new custody and NO money-transmitter surface: Chama sends sats; the
// conversion + rate + bank withdrawal all happen inside the user's OWN Strike
// account. Chama can't set the receive currency for them, hence the guided
// confirmation in the claim picker.
// Provider-agnostic by design — Cash App / Bitcoin Well are drop-in siblings
// on the same seam (v1 ships Strike only).
//
// Resolve via LNURL-pay (.well-known/lnurlp/<username>), NEVER the captcha-
// gated `strike.me/<user>` web page. See DECISIONS / BACKLOG 2026-06-26.

/** Strike's live Lightning-Address host. */
export const STRIKE_LNADDRESS_DOMAIN = "strike.me";

/** Cash-receive guidance shown on the Strike claim picker. Chama cannot flip
 *  this setting for them: if Strike is set to Bitcoin, the same payment lands
 *  as bitcoin instead of cash. Steps match Strike's public Lightning Address
 *  guide: Account screen → Bitcoin settings → Receive currency → Cash. */
export const STRIKE_CASH_HINT =
  "Before sending, set passive Lightning receives in Strike to Cash.";

/** Short step list for the claim-picker how-to. */
export const STRIKE_CASH_STEPS: readonly string[] = [
  "Open Strike and go to Account",
  "Bitcoin settings → Receive currency",
  "Choose Cash",
];

/** Strike's own caveat for tiny passive receives: they may still settle as
 *  bitcoin. Chama's claims are usually far above this, but the wording keeps
 *  the rail honest. */
export const STRIKE_CASH_CAVEAT =
  "If Strike is set to Bitcoin, this payment lands as bitcoin. Strike may also deliver payments below $0.01 as bitcoin.";

/**
 * Normalize a user-typed Strike identity to a bare lowercase username, or null
 * if it isn't a plausible Strike username.
 *
 * Accepted input shapes (surrounding spaces ignored):
 *   - `username`                    (bare handle)
 *   - `@username`                   (leading @, as people often type it)
 *   - `username@strike.me`          (full Lightning Address)
 *   - `https://strike.me/username`  (profile/tipping URL — we extract the
 *                                    handle and resolve via LNURL, never load
 *                                    the page)
 *
 * We intentionally keep client-side validation light: Strike is the authority
 * on which usernames exist, and the LNURL resolve gives the final answer. We
 * only require a safe LUD-16-ish local part (alphanumeric first char, then
 * alphanumeric / dot / underscore / dash) so typos like whitespace, extra `@`,
 * or a foreign host fail before the network call.
 */
export function normalizeStrikeUsername(raw: string): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim().toLowerCase();
  if (!s) return null;

  // Profile/tipping URL → take the first path segment as the handle.
  const urlMatch = s.match(/^(?:https?:\/\/)?(?:www\.)?strike\.me\/([^/?#]+)/);
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

  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(s)) return null;
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
  if (typeof address !== "string") return false;
  const trimmed = address.trim().toLowerCase();
  const parts = trimmed.split("@");
  if (parts.length !== 2) return false;
  const [local, host] = parts;
  return host === STRIKE_LNADDRESS_DOMAIN && normalizeStrikeUsername(local ?? "") === local;
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
 * offramp should be offered. Matches the US-leaning community family
 * (`us-gbf` / `us-blf` / `us-*` shells + `global-usd`) or a USD fiat currency.
 * USD-currency contexts include dollarized economies (e.g. Ecuador, El
 * Salvador) where Strike also operates — Strike, not Chama, enforces its own
 * availability. Independent of EXTERNAL_SWAPS_ENABLED — Strike rides the
 * always-available Lightning-Address payout path (Tando precedent).
 *
 * TRADE context is authoritative (mirrors isKenyaPayoutContext): a US-home
 * user cashing out a Kenya (KES) trade must NOT see Strike; home is only the
 * fallback when the claim carries no community AND no currency tag.
 */
export function isUSPayoutContext(input: {
  homeCommunity?: string | null;
  tradeCommunity?: string | null;
  fiatCurrency?: string | null;
}): boolean {
  const isUSSlug = (slug?: string | null): boolean => {
    if (!slug) return false;
    const s = slug.toLowerCase();
    return s.startsWith("us-") || s === "global-usd";
  };
  const currency = (input.fiatCurrency ?? "").trim().toUpperCase();
  if (input.tradeCommunity || currency) {
    return isUSSlug(input.tradeCommunity) || currency === "USD";
  }
  return isUSSlug(input.homeCommunity);
}
