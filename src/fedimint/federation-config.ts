// ══════════════════════════════════════════════════════════════════════════
// Chama — Federation Configuration
// ══════════════════════════════════════════════════════════════════════════
//
// Per PHILOSOPHY.md §2.5, browser users can only reach federations whose
// guardians expose WebSocket endpoints. BP guardians do; BLF's iroh-only
// transport does not (reliably, today). The universal fallback is
// therefore BP — the browser-friendly choice — and BLF is one explicit
// option among others, opt-in via registry entry, sandbox-mode picker,
// or pasted custom invite.
//
// The federation invite/name CONSTANTS live in ./federation-invites.ts
// so the community registry can import them without forming a circular
// dep (this module needs registry's getCommunityBySlug at function-call
// time; registry needs the invite strings at top-level array
// construction time — putting them in a third file breaks the cycle).
// We re-export them here for back-compat with downstream consumers.
//
// If you don't already have a Fedimint wallet, the easiest way to manage
// your ecash balance on mobile is the Fedi app: https://www.fedi.xyz/

import {
  BP_FEDERATION_NAME,
  BP_FEDERATION_INVITE,
  BP_FEDERATION_ID,
  BLF_FEDERATION_NAME,
  BLF_FEDERATION_INVITE,
  BLF_FEDERATION_ID,
} from "./federation-invites.js";

export {
  BP_FEDERATION_NAME,
  BP_FEDERATION_INVITE,
  BP_FEDERATION_ID,
  BLF_FEDERATION_NAME,
  BLF_FEDERATION_INVITE,
  BLF_FEDERATION_ID,
};

/**
 * localStorage key for a user-supplied custom invite code.
 * If present, takes precedence over the universal BP fallback.
 */
export const CUSTOM_INVITE_STORAGE_KEY = "chama_federation_invite";

/**
 * Resolve the federation invite code to use at runtime, community-blind.
 * Custom user invite wins; otherwise fall back to BP — the universal
 * browser-friendly default. Community-aware callers should prefer
 * `resolveFederationForCommunity(slug)` so a community-pinned invite
 * (e.g. ke-kes → Afribit) is honored.
 */
export function getFederationInvite(): string {
  try {
    if (typeof localStorage !== "undefined") {
      const custom = localStorage.getItem(CUSTOM_INVITE_STORAGE_KEY);
      if (custom && custom.trim().startsWith("fed1")) {
        return custom.trim();
      }
    }
  } catch {
    // localStorage unavailable (SSR, etc.) — fall through to default
  }
  return BP_FEDERATION_INVITE;
}

/**
 * Save a custom federation invite code. Pass empty string to clear
 * and revert to the default.
 */
export function setCustomFederationInvite(inviteCode: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    const trimmed = inviteCode.trim();
    if (!trimmed) {
      localStorage.removeItem(CUSTOM_INVITE_STORAGE_KEY);
      return;
    }
    if (!trimmed.startsWith("fed1")) {
      throw new Error("Invite code must start with 'fed1'");
    }
    localStorage.setItem(CUSTOM_INVITE_STORAGE_KEY, trimmed);
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }
}

/** Whether the user is currently overriding the default federation */
export function hasCustomFederation(): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    return !!localStorage.getItem(CUSTOM_INVITE_STORAGE_KEY);
  } catch {
    return false;
  }
}

// ── Active joined invite (PR 5) ──────────────────────────────────────────
//
// Records the invite that the OPFS-resident wallet was actually joined
// with, separately from the user's preference (CUSTOM_INVITE_STORAGE_KEY).
// On next page load, initFedimint compares the two: if they diverge, the
// OPFS holds a stale federation and must be wiped before joining the
// preferred one. Without this reconciliation, a user who pastes a new
// custom invite and hits the old "case (b) silent no-op" gets stuck on
// whatever federation their OPFS was created with — a refresh wouldn't
// rescue them, since the OPFS persists across reloads.
//
// Written on every successful join/switch; cleared on full reset.
export const ACTIVE_INVITE_STORAGE_KEY = "chama_active_invite";

export function getActiveInvite(): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const v = localStorage.getItem(ACTIVE_INVITE_STORAGE_KEY);
    return v && v.startsWith("fed1") ? v : null;
  } catch {
    return null;
  }
}

export function setActiveInvite(invite: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    const trimmed = invite.trim();
    if (!trimmed) {
      localStorage.removeItem(ACTIVE_INVITE_STORAGE_KEY);
      return;
    }
    localStorage.setItem(ACTIVE_INVITE_STORAGE_KEY, trimmed);
  } catch {
    // localStorage unavailable — silently no-op
  }
}

export function clearActiveInvite(): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(ACTIVE_INVITE_STORAGE_KEY);
    }
  } catch { /* no-op */ }
}

function normalizeFederationId(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized && /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

export function expectedFederationIdForInvite(invite: string | null | undefined): string | null {
  const trimmed = invite?.trim();
  if (trimmed === BP_FEDERATION_INVITE) return BP_FEDERATION_ID;
  if (trimmed === BLF_FEDERATION_INVITE) return BLF_FEDERATION_ID;
  return null;
}

// ── Cold-start drift detection (pure) ───────────────────────────────────
//
// Pure helper for initFedimint's reconcile gate. Returns true when the
// OPFS-resident wallet may be bound to a route that doesn't match the invite
// we want to use, in which case the caller must wipe + rejoin subject to the
// fund-loss balance guard.
//
// Two flavors of drift:
//   1. Tracked drift: previousActiveInvite is recorded and disagrees with
//      desiredInvite.
//   2. Untracked OPFS: previousActiveInvite is null, but the wallet is already
//      joined from a previous session. Sign-out/reload does not wipe OPFS.
//      Without this branch, joinFederation can record the requested invite
//      while the wallet stays bound to whatever route the OPFS already held,
//      producing CREATE events whose `mintUrl` and `fed` facts disagree.
//
// We can't peek an invite's fed-id without joining, so the untracked case is
// conservative for unknown routes. For curated routes, compare the desired
// invite's known federation ID to the wallet's actual federation ID before
// trusting localStorage. The caller's balance guard prevents silent bearer-cash
// loss.
export function shouldReconcileFederation(inputs: {
  previousActiveInvite: string | null;
  desiredInvite: string;
  walletIsJoined: boolean;
  walletFederationId?: string | null;
}): boolean {
  if (!inputs.walletIsJoined) return false;
  const expectedFedId = expectedFederationIdForInvite(inputs.desiredInvite);
  const walletFedId = normalizeFederationId(inputs.walletFederationId);
  if (expectedFedId && walletFedId) {
    return expectedFedId !== walletFedId;
  }
  if (inputs.previousActiveInvite === null) return true;
  return inputs.previousActiveInvite !== inputs.desiredInvite;
}

// ══════════════════════════════════════════════════════════════════════════
// COMMUNITY-AWARE RESOLUTION
// ══════════════════════════════════════════════════════════════════════════
//
// Per PHILOSOPHY.md §2.3: communities are the user-facing layer; federations
// are the technical layer that backs them. A community whose registry entry
// has federationInvite === null falls back to BP — the universal browser-
// friendly default. Per §2.5, BLF's iroh-only transport is unreachable
// from browsers; pinning the universal fallback to BP keeps first-time
// browser users on a working federation. BLF remains opt-in via the
// `us-blf` registry entry, sandbox-mode picker, or pasted custom invite.
//
// Precedence (highest first):
//   1. User's pasted custom invite (the manual-override escape hatch)
//   2. The community's federationInvite (when the registry has one)
//   3. BP fallback
//
import { getCommunityBySlug } from "../communities/registry.js";

/**
 * Resolve the federation invite code for a given community slug.
 *
 * - If the user has set a custom invite, it always wins (manual override).
 * - Otherwise, look up the community in the registry. If the entry has a
 *   non-null federationInvite, use it.
 * - Otherwise (community null/unknown, or its federationInvite is null),
 *   fall back to BP.
 */
export function resolveFederationForCommunity(slug: string | null | undefined): string {
  // 1. Manual override beats everything — same precedence as
  //    getFederationInvite(), kept consistent so the "Advanced" path
  //    behaves identically across the codebase.
  try {
    if (typeof localStorage !== "undefined") {
      const custom = localStorage.getItem(CUSTOM_INVITE_STORAGE_KEY);
      if (custom && custom.trim().startsWith("fed1")) {
        return custom.trim();
      }
    }
  } catch {
    // localStorage unavailable — fall through
  }

  // 2. Community-mapped invite, if any.
  const community = getCommunityBySlug(slug);
  if (community?.federationInvite) {
    return community.federationInvite;
  }

  // 3. BP fallback. Browser-friendly universal default per §2.5.
  return BP_FEDERATION_INVITE;
}

// ══════════════════════════════════════════════════════════════════════════
// FEDERATION PRESETS — Curated + dynamic list for the dropdown picker
// ══════════════════════════════════════════════════════════════════════════

/**
 * Metadata describing a single Fedimint federation option in the picker.
 * Chama combines three sources at runtime:
 *   1. CURATED_PRESETS (this file) — BLF + any private invites baked in
 *   2. fetchObserverFederations() — live list from observer.fedimint.org
 *   3. User's own custom invite (advanced field)
 */
export interface FederationPreset {
  /** Display name shown in the picker */
  name: string;
  /** Federation ID (hex) if known; used for deduplication */
  federationId?: string;
  /** Full fed1 invite code */
  inviteCode: string;
  /** Short description or tagline for the picker row */
  description?: string;
  /** Origin: "curated" = baked into this file, "observer" = live fetch */
  source: "curated" | "observer";
  /** Community arbiter pool — npubs designated by community leader */
  arbiters?: {
    /** Primary arbiter — auto-selected for new trades */
    primary: string;
    /** Secondary/backup arbiters — share is encrypted to all of them */
    pool: string[];
    /** Minimum arbiters required (enforced at UI level) */
    minArbiters?: number;
  };
  /** Optional URL for a community leader / community page */
  communityUrl?: string;
  /** Optional country / locality tag */
  region?: string;
}

/**
 * Curated federation list. Intentionally minimal: BP (the universal
 * browser-friendly fallback) and BLF (an explicit opt-in option, not
 * the default). Private federations are NOT baked into this file —
 * Community Leaders surface their federations organically via the
 * permissionless community-add primitive (see addCustomCommunity in
 * src/communities/registry.ts; v1.5 will publish kind:38112 community
 * claims to Nostr for cross-client discovery).
 *
 * The wider public federation list is fetched live from
 * observer.fedimint.org at runtime — see `fetchObserverFederations()`.
 */
export const CURATED_PRESETS: FederationPreset[] = [
  {
    name: BP_FEDERATION_NAME,
    federationId: BP_FEDERATION_ID,
    inviteCode: BP_FEDERATION_INVITE,
    description: "Browser-friendly default. Safe starting point.",
    source: "curated",
  },
  {
    name: BLF_FEDERATION_NAME,
    federationId: BLF_FEDERATION_ID,
    inviteCode: BLF_FEDERATION_INVITE,
    description: "Best on the mobile app — limited browser support today.",
    source: "curated",
  },
];

/**
 * Fetch the live public federation list from Fedimint Observer.
 *
 * The observer API returns an array of federations with fields like
 * `federation_id`, `federation_name`, `invite_code`, `nickname`, etc.
 * We normalize into FederationPreset[].
 *
 * Returns [] on any network/CORS/JSON error — the UI falls back to the
 * curated list, so failure is silent and non-blocking.
 */
export async function fetchObserverFederations(
  signal?: AbortSignal
): Promise<FederationPreset[]> {
  const OBSERVER_URL = "https://observer.fedimint.org/api/federations";
  try {
    const resp = await fetch(OBSERVER_URL, {
      signal,
      headers: { accept: "application/json" },
    });
    if (!resp.ok) {
      console.warn(`[chama] observer fetch failed: HTTP ${resp.status}`);
      return [];
    }
    const data = await resp.json();
    if (!Array.isArray(data)) {
      console.warn("[chama] observer returned non-array payload");
      return [];
    }

    const presets: FederationPreset[] = [];
    for (const entry of data) {
      // The observer schema has shifted over versions. Defensively pull
      // whatever fields look relevant and skip entries without an invite.
      const inviteCode =
        entry?.invite ||
        entry?.invite_code ||
        entry?.inviteCode ||
        entry?.config?.invite_code ||
        null;
      if (typeof inviteCode !== "string" || !inviteCode.startsWith("fed1")) {
        continue;
      }
      const name =
        entry?.meta?.federation_name ||
        entry?.federation_name ||
        entry?.nickname ||
        entry?.name ||
        "Unnamed federation";
      const federationId =
        entry?.federation_id || entry?.federationId || undefined;
      const description =
        entry?.meta?.welcome_message ||
        entry?.description ||
        undefined;

      // Extract health + activity for display
      const health = entry?.health || "unknown";
      const deposits = entry?.deposits ? Math.floor(entry.deposits / 1000) : 0;
      const depositsSats = deposits > 0
        ? deposits > 1_000_000 ? `${(deposits / 1_000_000).toFixed(1)}M sats`
        : deposits > 1_000 ? `${(deposits / 1_000).toFixed(0)}k sats`
        : `${deposits} sats`
        : "";
      const descParts = [];
      if (health === "online") descParts.push("Online");
      else if (health === "offline") descParts.push("Offline");
      if (depositsSats) descParts.push(depositsSats + " deposits");
      if (description) descParts.push(description);

      presets.push({
        name: String(name).slice(0, 60),
        federationId: federationId ? String(federationId) : undefined,
        inviteCode,
        description: descParts.join(" · ").slice(0, 160) || undefined,
        source: "observer",
      });
    }
    return presets;
  } catch (e) {
    if ((e as Error).name !== "AbortError") {
      console.warn("[chama] observer fetch error:", e);
    }
    return [];
  }
}

/**
 * Merge curated + observer presets, deduplicating by federation ID or
 * invite code. Curated always wins over observer for the same federation.
 */
export function mergePresets(
  curated: FederationPreset[],
  observer: FederationPreset[]
): FederationPreset[] {
  const byKey = new Map<string, FederationPreset>();
  const keyFor = (p: FederationPreset) =>
    p.federationId || p.inviteCode.slice(0, 64);
  for (const p of curated) byKey.set(keyFor(p), p);
  for (const p of observer) {
    const k = keyFor(p);
    if (!byKey.has(k)) byKey.set(k, p);
  }
  return [...byKey.values()];
}

/**
 * Friendly name for the community-leader messaging shown under the picker.
 * Exported so the UI can keep the copy in one place.
 */
export const COMMUNITY_LEADER_MESSAGE =
  "Not sure which federation to join? Talk to your Community Leader. " +
  "All participants in a trade must use the same federation for the ecash " +
  "to be spendable across the Shamir shares — joining a federation your " +
  "community already uses keeps your circular economy intact.";
