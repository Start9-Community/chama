export const KIND0_TOGGLE_KEY_PREFIX = "chama_fetch_kind0_enabled_";

export type NostrProfileNameMap = Record<string, string>;

export function readKind0Toggle(pubkey: string | null | undefined): boolean {
  if (!pubkey) return false;
  try {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(KIND0_TOGGLE_KEY_PREFIX + pubkey) === "1";
  } catch {
    return false;
  }
}

export function writeKind0Toggle(pubkey: string | null | undefined, on: boolean): void {
  if (!pubkey) return;
  try {
    if (typeof localStorage === "undefined") return;
    if (on) localStorage.setItem(KIND0_TOGGLE_KEY_PREFIX + pubkey, "1");
    else localStorage.removeItem(KIND0_TOGGLE_KEY_PREFIX + pubkey);
  } catch {
    // best-effort preference
  }
}

export function extractNostrProfileName(content: string): string | null {
  try {
    const parsed = JSON.parse(content);
    const raw =
      typeof parsed.display_name === "string" && parsed.display_name.trim()
        ? parsed.display_name
        : typeof parsed.displayName === "string" && parsed.displayName.trim()
          ? parsed.displayName
          : typeof parsed.name === "string" && parsed.name.trim()
            ? parsed.name
            : typeof parsed.username === "string" && parsed.username.trim()
              ? parsed.username
              : null;
    if (!raw) return null;
    const name = raw.trim().replace(/\s+/g, " ");
    return name.length > 40 ? name.slice(0, 39).trimEnd() + "..." : name;
  } catch {
    return null;
  }
}

export function profileNameFor(
  profiles: NostrProfileNameMap | undefined,
  pubkey: string | null | undefined,
  enabled: boolean,
): string | null {
  if (!enabled || !pubkey) return null;
  return profiles?.[pubkey.toLowerCase()] ?? null;
}

