// ══════════════════════════════════════════════════════════════════════════
// Chama — Saved Payment Handles (localStorage)
// ══════════════════════════════════════════════════════════════════════════
//
// Per PHILOSOPHY.md §2.3: handles are private by default; rails are public.
// A listing publicly advertises which rails a seller accepts but masks
// the actual handle in Browse and previews. The handle is revealed only
// to the three trade participants at lock time, via NIP-44 encryption in
// the LOCK event payload.
//
// This module owns:
//   - Persistence of counterparty payment handles in localStorage
//     (`chama_saved_handles:<pubkey>` once connected)
//   - CRUD over saved handles
//   - The visibility-setter guard that refuses "public" for rails whose
//     allowPublicHandle === false. The Settings UI is the first line
//     (it doesn't render a toggle for those rails); this module is the
//     second line — defense in depth, in case anything slips past UI.
//   - The masking utility used by render paths in Browse / profile / list
//
// Storage format (localStorage["chama_saved_handles[:pubkey]"] is a JSON array):
//   [{ id, rail, handle, visibility, createdAt }, ...]
//
// IDs are local to this device — they're how the LOCK payload's
// `handleId` field references the seller's audit trail. Other devices
// don't share the ID space; that's fine, the cleartext `handle` flowing
// alongside is what receivers use.

import { railAllowsPublicHandle } from "./rail-registry.js";
import {
  getScopedStorageItem,
  setScopedStorageItem,
} from "../storage/user-scope.js";

export const SAVED_HANDLES_STORAGE_KEY = "chama_saved_handles";

/** Legacy rail key for pre-v0.6.3 Lightning Address rows. New payout
 *  destinations live in payments/payout-destinations.ts under
 *  `chama_payout_destinations`; this constant remains only so migration
 *  code can identify and remove old rows from saved handles. */
export const LIGHTNING_RAIL = "lightning";

export type HandleVisibility = "private" | "public";

export interface SavedHandle {
  /** Local UUID — used as the `handleId` audit reference in LOCK events. */
  id: string;
  /** Rail key — must match an entry in rail-registry.ts. */
  rail: string;
  /** Cleartext handle (phone number, username, account, etc.). Stored
   *  locally only; flows into LOCK payloads via the bridge's resolver. */
  handle: string;
  /** "private" → masked everywhere except active-trade reveal.
   *  "public"  → may be shown in profile / listing-public surfaces.
   *  Defense-in-depth: setVisibility() refuses "public" when the rail
   *  doesn't allow it, so this can never be "public" for a sensitive rail. */
  visibility: HandleVisibility;
  /** Unix seconds — for stable list ordering and audit. */
  createdAt: number;
  /** Legacy optional field from the era where Lightning destinations
   *  were stored here. Kept so old rows validate long enough to migrate. */
  lastUsedAt?: number;
  /** v0.6.5: rail keys the user accepts on THIS handle. Only meaningful
   *  for phone-number entries — one number often works on multiple
   *  mobile-money networks (Safaricom SIM → M-Pesa; Senegalese number →
   *  Wave AND Orange Money; etc.). Counterparties need to know which
   *  network to send to during a trade. Each entry is a rail key from
   *  rail-registry.ts (e.g. "m-pesa", "wave", "orange-money"). Empty/
   *  undefined for non-phone rails. Flows through the LOCK envelope so
   *  it's visible to all three participants at active-trade time. */
  networks?: string[];
}

// ── Storage I/O ───────────────────────────────────────────────────────────

function readStoredAll(): SavedHandle[] {
  try {
    const raw = getScopedStorageItem(SAVED_HANDLES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Light validation — drop entries that don't look right rather than
    // crashing the whole page on a corrupt key.
    return parsed.filter(isSavedHandle);
  } catch {
    return [];
  }
}

function readAll(): SavedHandle[] {
  return readStoredAll().filter(h => h.rail !== LIGHTNING_RAIL);
}

function writeAll(handles: SavedHandle[]): void {
  try {
    // Preserve legacy Lightning rows until payout-destinations.ts has a
    // chance to migrate them into `chama_payout_destinations`.
    const legacyLightning = readStoredAll().filter(h => h.rail === LIGHTNING_RAIL);
    setScopedStorageItem(
      SAVED_HANDLES_STORAGE_KEY,
      JSON.stringify([...handles.filter(h => h.rail !== LIGHTNING_RAIL), ...legacyLightning]),
    );
  } catch {
    // localStorage unavailable / quota exceeded — no-op. The Settings
    // UI surfaces persistence failures via the next read returning the
    // pre-write list (i.e. the change "didn't take").
  }
}

function isSavedHandle(x: any): x is SavedHandle {
  return (
    x && typeof x === "object" &&
    typeof x.id === "string" &&
    typeof x.rail === "string" &&
    typeof x.handle === "string" &&
    (x.visibility === "private" || x.visibility === "public") &&
    typeof x.createdAt === "number" &&
    // networks is optional; if present must be an array of strings.
    (x.networks === undefined
      || (Array.isArray(x.networks) && x.networks.every((n: unknown) => typeof n === "string")))
  );
}

function generateId(): string {
  // Same shape as escrow IDs — short, locally unique, no crypto needed.
  return `h_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// ── CRUD ──────────────────────────────────────────────────────────────────

export function listSavedHandles(): SavedHandle[] {
  return readAll();
}

export function getSavedHandle(id: string): SavedHandle | null {
  return readAll().find(h => h.id === id) ?? null;
}

/** Saved handles for a given rail key, newest first. Used by the Create
 *  form to auto-prefill when the seller picks a payment method. */
export function getSavedHandlesByRail(rail: string): SavedHandle[] {
  return readAll()
    .filter(h => h.rail === rail)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function addSavedHandle(
  rail: string,
  handle: string,
  opts?: { networks?: string[] },
): SavedHandle {
  const trimmed = handle.trim();
  if (!trimmed) {
    throw new Error("Handle cannot be empty");
  }
  // v0.7.0: phone numbers get canonicalized to "+CC XXX-XXX-XXXX" on
  // save. Other rails store the user's input verbatim — formatting a
  // Revtag or email wouldn't help and could break a literal handle.
  const normalized = rail === "phone-number"
    ? formatPhoneNumber(trimmed)
    : trimmed;
  const existing = readAll();
  const networks = opts?.networks?.filter(n => typeof n === "string" && n.length > 0);
  const entry: SavedHandle = {
    id: generateId(),
    rail,
    handle: normalized,
    visibility: "private",
    createdAt: Math.floor(Date.now() / 1000),
    ...(networks && networks.length > 0 ? { networks } : {}),
  };
  writeAll([entry, ...existing]);
  return entry;
}

export function deleteSavedHandle(id: string): void {
  writeAll(readAll().filter(h => h.id !== id));
}

/** Update mutable fields of a saved handle. Visibility changes go
 *  through setHandleVisibility() instead — it's the one with the rail
 *  guard. */
export function updateSavedHandle(
  id: string,
  patch: { rail?: string; handle?: string; networks?: string[] },
): SavedHandle | null {
  const handles = readAll();
  const idx = handles.findIndex(h => h.id === id);
  if (idx === -1) return null;
  // Drop the networks field entirely when the patch sets it to an
  // empty array — keeps the stored object minimal for non-phone rails.
  const nextNetworks = patch.networks
    ?.filter(n => typeof n === "string" && n.length > 0);
  const next: SavedHandle = {
    ...handles[idx],
    ...(patch.rail   !== undefined ? { rail:   patch.rail   } : {}),
    ...(patch.handle !== undefined ? { handle: patch.handle.trim() } : {}),
    ...(patch.networks !== undefined
      ? (nextNetworks && nextNetworks.length > 0
          ? { networks: nextNetworks }
          : { networks: undefined })
      : {}),
  };
  // Strip undefined networks so the stored JSON stays clean.
  if (next.networks === undefined) delete next.networks;
  handles[idx] = next;
  writeAll(handles);
  return next;
}

// ── Visibility (the load-bearing privacy gate) ────────────────────────────

export type SetVisibilityResult =
  | { ok: true; handle: SavedHandle }
  | { ok: false; error: string };

/** Change a saved handle's visibility. Refuses "public" when the rail
 *  doesn't allow it. The Settings UI also hides the toggle for those
 *  rails — this is the second line of defense in case the toggle ever
 *  gets there by accident (programmatic call, future UI bug, etc.).
 *
 *  Refused requests return an error rather than throwing because the
 *  caller is typically a UI handler that needs to surface the message. */
export function setHandleVisibility(
  id: string,
  visibility: HandleVisibility,
): SetVisibilityResult {
  const handles = readAll();
  const idx = handles.findIndex(h => h.id === id);
  if (idx === -1) {
    return { ok: false, error: `No saved handle with id ${id}` };
  }
  const handle = handles[idx];

  // Refuse "public" for sensitive rails. The unknown-rail path is also
  // refused (railAllowsPublicHandle returns false for unknown keys) so
  // a stale handle from a removed rail can't be promoted to public.
  if (visibility === "public" && !railAllowsPublicHandle(handle.rail)) {
    return {
      ok: false,
      error:
        `Rail "${handle.rail}" doesn't allow public handles. ` +
        `Phone numbers, bank accounts, and email-based rails are kept private.`,
    };
  }

  const next: SavedHandle = { ...handle, visibility };
  handles[idx] = next;
  writeAll(handles);
  return { ok: true, handle: next };
}

// ── Privacy decision + masking ────────────────────────────────────────────

// ── Phone-number formatting ───────────────────────────────────────────────
//
// v0.7.0: normalize phone numbers to a consistent "+CC XXX-XXX-XXXX" shape
// so saved entries are unambiguous and visually scannable for the
// counterparty receiving them at LOCK time. The user can type the
// number any way they like — "+254712345678", "+254 712-345-678",
// "0712345678", "254-712-345-678" — and the formatter reduces it to a
// single canonical form before persistence. Display helpers can then
// replace the visible "+CC" with a country flag while preserving the
// dial code in storage.
//
// Country-code length is the only fuzzy part: most countries use a
// 2- or 3-digit CC, but a handful (NANP=1, Russia/KZ=7) use 1 digit.
// The function uses a small heuristic based on the first digit:
//   "1" or "7" → 1-digit CC (NANP / Russia)
//   "2…"      → 3-digit CC (most African countries)
//   anything else → 2-digit CC
// Domestic numbers (no leading "+") are left as dashed digit groups with
// no CC prefix — the user opted out of international formatting.
//
// The function is intentionally lenient: it never throws and always
// returns SOMETHING the user can read. Garbage in (empty string, all
// non-digits) yields a trimmed empty string.

const PHONE_CC_TO_ISO: Record<string, string> = {
  "1": "US",
  "7": "RU",
  "20": "EG",
  "27": "ZA",
  "30": "GR",
  "31": "NL",
  "32": "BE",
  "33": "FR",
  "34": "ES",
  "39": "IT",
  "44": "GB",
  "49": "DE",
  "54": "AR",
  "55": "BR",
  "57": "CO",
  "61": "AU",
  "63": "PH",
  "81": "JP",
  "82": "KR",
  "86": "CN",
  "91": "IN",
  "92": "PK",
  "212": "MA",
  "213": "DZ",
  "216": "TN",
  "218": "LY",
  "221": "SN",
  "223": "ML",
  "225": "CI",
  "226": "BF",
  "229": "BJ",
  "233": "GH",
  "234": "NG",
  "237": "CM",
  "243": "CD",
  "250": "RW",
  "251": "ET",
  "254": "KE",
  "255": "TZ",
  "256": "UG",
  "260": "ZM",
  "263": "ZW",
  "265": "MW",
  "503": "SV",
  "880": "BD",
};

const PHONE_NATIONAL_GROUPS: Record<string, number[]> = {
  "1": [3, 3, 4],
  "7": [3, 3, 4],
  "33": [1, 2, 2, 2, 2],
  "54": [1, 2, 4, 4],
  "55": [2, 5, 4],
  "57": [3, 3, 4],
  "63": [3, 3, 4],
  "92": [3, 7],
  "221": [2, 3, 4],
  "233": [2, 3, 4],
  "251": [2, 3, 4],
  "254": [3, 3, 3],
  "255": [2, 3, 4],
  "880": [4, 6],
};

function isoToFlagEmoji(iso: string): string {
  const codePoints = iso.toUpperCase().split("")
    .map(char => 127397 + char.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

function phoneFlagForCountryCode(countryCode: string | null): string | null {
  if (!countryCode) return null;
  const iso = PHONE_CC_TO_ISO[countryCode];
  return iso ? isoToFlagEmoji(iso) : null;
}

function detectCountryCodeLength(digits: string): number {
  if (digits.length === 0) return 0;
  // NANP (+1) and Russia/Kazakhstan (+7) are the well-known 1-digit CCs.
  if (digits[0] === "1" || digits[0] === "7") return 1;
  // Most African dial codes are 3 digits and start with "2":
  // 211 (South Sudan), 212 (Morocco), 213 (Algeria), 216 (Tunisia),
  // 218 (Libya), 220-229 (Gambia, Senegal, Mauritania, Mali, Guinea…),
  // 230-239 (Mauritius, Liberia, Sierra Leone, Ghana…), 240-249
  // (Equatorial Guinea, Gabon, Congo, DRC, Angola, Guinea-Bissau…),
  // 250-259 (Rwanda, Ethiopia, Somalia, Djibouti, Kenya, Tanzania,
  // Uganda…), 260-269 (Zambia, Madagascar, Zimbabwe, Namibia, Malawi,
  // Lesotho, Botswana, Swaziland, Comoros…), 290-299 (Saint Helena,
  // Eritrea, Aruba, Faroe, Greenland, Sudan, South Sudan).
  if (digits[0] === "2") return digits.length >= 3 ? 3 : 0;
  // Default: 2-digit CC covers most of Europe, Asia, Oceania.
  return digits.length >= 2 ? 2 : 0;
}

/** Group a string of digits into "XXX-XXX-XXXX" chunks. Final chunk
 *  absorbs any 4-digit trailer (so NANP "5551234567" → "555-123-4567",
 *  not the ugly "555-123-456-7"). 1-digit trailers also merge into
 *  the previous chunk; 2-digit trailers stay separate.
 *
 *  Examples:
 *    "612345678"    (9)  → "612-345-678"
 *    "5551234567"   (10) → "555-123-4567"
 *    "12345678"     (8)  → "123-456-78"
 *    "123"          (3)  → "123"
 *    ""             (0)  → ""                                       */
function groupPhoneDigits(rest: string, countryCode?: string): string {
  if (rest.length === 0) return "";
  const pattern = countryCode ? PHONE_NATIONAL_GROUPS[countryCode] : undefined;
  if (pattern && pattern.reduce((sum, n) => sum + n, 0) === rest.length) {
    let offset = 0;
    return pattern.map(size => {
      const chunk = rest.slice(offset, offset + size);
      offset += size;
      return chunk;
    }).join("-");
  }

  const chunks: string[] = [];
  let i = 0;
  while (i < rest.length) {
    const remaining = rest.length - i;
    // 4-digit trailer absorbed into one chunk; covers NANP / Russia
    // 10-digit forms cleanly.
    if (remaining === 4) {
      chunks.push(rest.slice(i, i + 4));
      i += 4;
    } else {
      const take = Math.min(3, remaining);
      chunks.push(rest.slice(i, i + take));
      i += take;
    }
  }
  return chunks.join("-");
}

/** Normalize a user-typed phone number to "+CC XXX-XXX-XXXX" form.
 *  Lenient: never throws, returns the best-effort canonical form.
 *  Examples:
 *    "+254712345678"         → "+254 712-345-678"
 *    "+254 712-345-678"      → "+254 712-345-678"  (idempotent)
 *    "  +254-712.345 678 "   → "+254 712-345-678"
 *    "+15551234567"          → "+1 555-123-4567"   (NANP)
 *    "0712345678"            → "071-234-5678"      (domestic, no CC)
 *    ""                      → ""
 *    "+"                     → "+"                 (typing in progress) */
export function formatPhoneNumber(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return hasPlus ? "+" : "";

  if (hasPlus) {
    const ccLen = detectCountryCodeLength(digits);
    if (ccLen === 0) return `+${digits}`;
    const cc = digits.slice(0, ccLen);
    const rest = digits.slice(ccLen);
    const grouped = groupPhoneDigits(rest, cc);
    return grouped ? `+${cc} ${grouped}` : `+${cc}`;
  }
  // Domestic — same grouping rule, no CC prefix.
  return groupPhoneDigits(digits);
}

export interface PhoneNumberDisplayParts {
  normalized: string;
  countryCode: string | null;
  flagEmoji: string | null;
  nationalDigits: string;
  nationalFormatted: string;
  /** Flag-led display for saved/revealed phone handles. */
  display: string;
  /** Value to show inside the tel input when the flag prefix is visible. */
  inputValue: string;
}

export function getPhoneNumberDisplayParts(value: string): PhoneNumberDisplayParts {
  const normalized = formatPhoneNumber(value);
  const trimmed = value.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  const ccLen = hasPlus ? detectCountryCodeLength(digits) : 0;

  if (!hasPlus || ccLen === 0) {
    return {
      normalized,
      countryCode: null,
      flagEmoji: null,
      nationalDigits: digits,
      nationalFormatted: normalized,
      display: normalized,
      inputValue: normalized,
    };
  }

  const countryCode = digits.slice(0, ccLen);
  const nationalDigits = digits.slice(ccLen);
  const nationalFormatted = groupPhoneDigits(nationalDigits, countryCode);
  const flagEmoji = phoneFlagForCountryCode(countryCode);
  const flagDisplay = flagEmoji
    ? (nationalFormatted ? `${flagEmoji} ${nationalFormatted}` : flagEmoji)
    : normalized;

  return {
    normalized,
    countryCode,
    flagEmoji,
    nationalDigits,
    nationalFormatted,
    display: flagDisplay,
    inputValue: flagEmoji ? nationalFormatted : normalized,
  };
}

export function formatPhoneNumberForDisplay(value: string): string {
  return getPhoneNumberDisplayParts(value).display;
}

/** Mask a handle for public display. Heuristics:
 *   - Very short handles (<= 4 chars): full mask "•••"
 *   - Phone-shaped (starts with + or digit): keep the country flag
 *     when known, otherwise "+CC", plus last 4 digits. The previous heuristic
 *     ("split on space, keep first two chunks") leaked the whole number
 *     when the user entered without spaces — split(" ") returned a
 *     one-element array and "first two" was the entire input. v0.6.5
 *     fix: strip non-digits first so formatting doesn't matter, then
 *     reconstruct from a canonical anchor (country code + last 4).
 *   - Email-shaped (contains @): mask local + first chars of domain
 *   - Otherwise: keep first 2 + last 2, mask middle */
export function maskHandle(handle: string): string {
  if (!handle) return "";
  if (handle.length <= 4) return "•••";
  if (handle.startsWith("+") || /^\+?\d/.test(handle)) {
    const digits = handle.replace(/\D/g, "");
    if (digits.length <= 4) return `•••${digits}`;
    const parts = getPhoneNumberDisplayParts(handle);
    const last4 = digits.slice(-4);
    if (parts.flagEmoji) return `${parts.flagEmoji} ••• ${last4}`;
    return parts.countryCode ? `+${parts.countryCode} ••• ${last4}` : `••• ${last4}`;
  }
  if (handle.includes("@")) {
    const [local, domain = ""] = handle.split("@");
    const maskedLocal = local.length > 1 ? `${local[0]}•••` : "•••";
    const maskedDomain = domain.length > 1 ? `${domain[0]}•••${domain.includes(".") ? "." + domain.split(".").pop() : ""}` : domain;
    return `${maskedLocal}@${maskedDomain}`;
  }
  return `${handle.slice(0, 2)}•••${handle.slice(-2)}`;
}

/** Decide what to display for a saved handle in a public/profile context.
 *  Returns the cleartext handle when the rail allows public handles AND
 *  the user has opted in (visibility === "public"). Otherwise returns
 *  the masked form.
 *
 *  This is for Browse / listing preview / profile views where the viewer
 *  is NOT one of the trade's three participants. Active-trade reveal
 *  flows separately through the LOCK payload. */
export function publicHandleDisplay(handle: SavedHandle): string {
  if (handle.visibility === "public" && railAllowsPublicHandle(handle.rail)) {
    return handle.handle;
  }
  return maskHandle(handle.handle);
}

/** Display rule for a handle string given the viewer's relationship to
 *  the trade. The handle here is the cleartext that flowed in the LOCK
 *  payload (active trade) or that the viewer pulled from a public
 *  profile (settings-published handle).
 *
 *  - When the viewer IS one of the three participants of an active
 *    locked trade, return the cleartext (full reveal — they need to
 *    actually use it to send the fiat).
 *  - When the viewer is NOT a participant, return the masked form
 *    regardless of the visibility flag the seller set. The flag only
 *    controls whether the cleartext is allowed to flow into the public
 *    surface at all; viewer context still determines the final display. */
export function handleDisplayForViewer(
  handle: string,
  viewerIsParticipant: boolean,
): string {
  if (viewerIsParticipant) {
    return handle.startsWith("+")
      ? formatPhoneNumberForDisplay(handle)
      : handle;
  }
  return maskHandle(handle);
}
