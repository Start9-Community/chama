// ══════════════════════════════════════════════════════════════════════════
// Chama — active-user localStorage scope
// ══════════════════════════════════════════════════════════════════════════
//
// Several stores are user-owned but browser-local: home Chama, active
// federation route, saved handles, payout destinations, payout profiles,
// and crash-recovery queues. They should follow the active npub, not the
// browser profile. First-run onboarding can still write before a signer is
// known; once connect() learns the pubkey, the scoped reader claims that
// legacy value exactly once.

let activeUserScope: string | null = null;

function normalizeScope(pubkey?: string | null): string | null {
  const clean = pubkey?.trim().toLowerCase();
  if (!clean) return null;
  return clean.replace(/[^a-z0-9_-]/g, "_");
}

export function setLocalStorageUserScope(pubkey?: string | null): void {
  activeUserScope = normalizeScope(pubkey);
}

export function getLocalStorageUserScope(): string | null {
  return activeUserScope;
}

export function scopedStorageKey(baseKey: string, scope = activeUserScope): string {
  const clean = normalizeScope(scope);
  return clean ? `${baseKey}:${clean}` : baseKey;
}

export function getScopedStorageItem(baseKey: string): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const scope = getLocalStorageUserScope();
    if (!scope) return localStorage.getItem(baseKey);

    const scopedKey = scopedStorageKey(baseKey, scope);
    const scoped = localStorage.getItem(scopedKey);
    if (scoped !== null) return scoped;

    const legacy = localStorage.getItem(baseKey);
    if (legacy !== null) {
      localStorage.setItem(scopedKey, legacy);
      localStorage.removeItem(baseKey);
    }
    return legacy;
  } catch {
    return null;
  }
}

export function setScopedStorageItem(baseKey: string, value: string): void {
  if (typeof localStorage === "undefined") return;
  const key = scopedStorageKey(baseKey);
  localStorage.setItem(key, value);
  if (key !== baseKey) localStorage.removeItem(baseKey);
}

export function removeScopedStorageItem(baseKey: string): void {
  if (typeof localStorage === "undefined") return;
  const key = scopedStorageKey(baseKey);
  localStorage.removeItem(key);
  if (key !== baseKey) localStorage.removeItem(baseKey);
}
