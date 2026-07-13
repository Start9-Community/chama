// ══════════════════════════════════════════════════════════════════════════
// Chama — Chapsmart TZS payout helpers
// ══════════════════════════════════════════════════════════════════════════
//
// v1.2.4 — the inline API integration with Chapsmart's payout endpoint
// (`https://nwc.chapsmart.com/chama/payout-invoice`) has been retired.
// The endpoint was unreliable in production and the partner prefers a
// fiat-first redirect flow on their own site. Chapsmart now lives in
// `external-swap-registry.ts` as a guided redirect alongside Banxaas
// and the rest. The `ClaimPayoutModal` renders it via the shared
// external-swap picker, gated on the trade being CLAIMED first.
//
// What's still here is the small amount of locally-useful logic that
// has nothing to do with the dead endpoint:
//
//   * Profile storage (`getChapsmartPayoutProfile`,
//     `saveChapsmartPayoutProfile`, `clearChapsmartPayoutProfile`):
//     the user's phone + name, stored per-npub via the user-scope
//     storage helpers. Other surfaces (settings, future onramp UI)
//     still want this profile to pre-fill forms.
//   * Tanzania phone normalisation (`toChapsmartTanzaniaPhone`): used
//     by the saved-handle network picker to format pasted numbers.
//   * Eligibility check (`isChapsmartPayoutEligible`): retained for
//     any caller that wants to surface a Tanzania-specific affordance
//     even though the modal now drives off the unified registry.

import {
  getScopedStorageItem,
  removeScopedStorageItem,
  setScopedStorageItem,
} from "../storage/user-scope.js";

export const CHAPSMART_PAYOUT_PROFILE_STORAGE_KEY = "chama_chapsmart_payout_profile";

export interface ChapsmartPayoutProfile {
  phoneNumber: string;
  recipientName: string;
  createdAt: number;
  lastUsedAt?: number;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function isProfile(x: any): x is ChapsmartPayoutProfile {
  return (
    x && typeof x === "object" &&
    typeof x.phoneNumber === "string" &&
    typeof x.recipientName === "string" &&
    typeof x.createdAt === "number" &&
    (x.lastUsedAt === undefined || typeof x.lastUsedAt === "number")
  );
}

export function getChapsmartPayoutProfile(): ChapsmartPayoutProfile | null {
  try {
    const raw = getScopedStorageItem(CHAPSMART_PAYOUT_PROFILE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isProfile(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveChapsmartPayoutProfile(input: {
  phoneNumber: string;
  recipientName: string;
}): ChapsmartPayoutProfile {
  const existing = getChapsmartPayoutProfile();
  const phoneNumber = input.phoneNumber.trim();
  if (!phoneNumber) throw new Error("Enter a Tanzanian mobile number");
  toChapsmartTanzaniaPhone(phoneNumber);
  const profile: ChapsmartPayoutProfile = {
    phoneNumber,
    recipientName: input.recipientName.trim(),
    createdAt: existing?.createdAt ?? nowSec(),
    lastUsedAt: nowSec(),
  };
  if (!profile.recipientName || profile.recipientName.split(/\s+/).length < 2) {
    throw new Error("Enter the recipient's first and last name");
  }
  try {
    setScopedStorageItem(CHAPSMART_PAYOUT_PROFILE_STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // localStorage is best-effort; return the profile so the in-flight
    // payout can still continue.
  }
  return profile;
}

export function clearChapsmartPayoutProfile(): void {
  try {
    removeScopedStorageItem(CHAPSMART_PAYOUT_PROFILE_STORAGE_KEY);
  } catch {
    // no-op
  }
}

export function toChapsmartTanzaniaPhone(input: string): string {
  const digits = input.replace(/\D/g, "");
  if (/^0[67]\d{8}$/.test(digits)) return digits;
  if (/^255[67]\d{8}$/.test(digits)) return `0${digits.slice(3)}`;
  if (/^[67]\d{8}$/.test(digits)) return `0${digits}`;
  throw new Error("Enter a Tanzanian mobile number, for example +255 71 234 5678");
}

export function isChapsmartPayoutEligible(input: {
  homeCommunity?: string | null;
  fiatCurrency?: string | null;
}): boolean {
  return (
    input.homeCommunity === "tz-tzs" ||
    (input.fiatCurrency ?? "").toUpperCase() === "TZS"
  );
}
