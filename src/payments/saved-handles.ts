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
//     (`chama_saved_handles`)
//   - CRUD over saved handles
//   - The visibility-setter guard that refuses "public" for rails whose
//     allowPublicHandle === false. The Settings UI is the first line
//     (it doesn't render a toggle for those rails); this module is the
//     second line — defense in depth, in case anything slips past UI.
//   - The masking utility used by render paths in Browse / profile / list
//
// Storage format (localStorage["chama_saved_handles"] is a JSON array):
//   [{ id, rail, handle, visibility, createdAt }, ...]
//
// IDs are local to this device — they're how the LOCK payload's
// `handleId` field references the seller's audit trail. Other devices
// don't share the ID space; that's fine, the cleartext `handle` flowing
// alongside is what receivers use.

import { railAllowsPublicHandle } from "./rail-registry.js";

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
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(SAVED_HANDLES_STORAGE_KEY);
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
    if (typeof localStorage === "undefined") return;
    // Preserve legacy Lightning rows until payout-destinations.ts has a
    // chance to migrate them into `chama_payout_destinations`.
    const legacyLightning = readStoredAll().filter(h => h.rail === LIGHTNING_RAIL);
    localStorage.setItem(
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
  const existing = readAll();
  const networks = opts?.networks?.filter(n => typeof n === "string" && n.length > 0);
  const entry: SavedHandle = {
    id: generateId(),
    rail,
    handle: trimmed,
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

/** Mask a handle for public display. Heuristics:
 *   - Very short handles (<= 4 chars): full mask "•••"
 *   - Phone-shaped (starts with + or digit): keep "+CC" and last 4
 *     digits, mask the middle. The previous heuristic
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
    // Country code: leading 1-3 digits after the "+", if any. Without
    // a "+" the input might be a domestic number — show just the last 4.
    const ccMatch = handle.match(/^\+(\d{1,3})/);
    const cc = ccMatch ? `+${ccMatch[1]}` : "";
    const last4 = digits.slice(-4);
    return cc ? `${cc} ••• ${last4}` : `••• ${last4}`;
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
  if (viewerIsParticipant) return handle;
  return maskHandle(handle);
}
