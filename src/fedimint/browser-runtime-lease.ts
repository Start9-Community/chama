// Chama — browser Fedimint runtime lease
//
// A Start9 service can expose the same UI on multiple localhost-style ports.
// Ports are separate web origins, so OPFS, BroadcastChannel, localStorage and
// Web Locks cannot coordinate them. Cookies, however, are host-scoped and are
// shared across ports. Keep at most one heavyweight Fedimint WASM/OPFS runtime
// alive per browser profile + Start9 service host while leaving every tab's
// Nostr client and trade state fully operational.

const COOKIE_NAME = "chama_fedimint_runtime";
const HEARTBEAT_MS = 15_000;
// Chrome may throttle a long-backgrounded page's timers to roughly one
// callback per minute. Three minutes keeps a healthy hidden wallet from being
// mistaken for a dead owner while still recovering automatically after a
// renderer crash.
export const BROWSER_RUNTIME_LEASE_TTL_MS = 180_000;
const CLAIM_SETTLE_MS = 80;

type LeaseRecord = { token: string; touchedAt: number };

let ownedToken: string | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let pageHideInstalled = false;

function readCookieValue(cookie: string, name: string): string | null {
  for (const part of cookie.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) return rawValue.join("=") || null;
  }
  return null;
}

export function parseBrowserRuntimeLease(cookie: string): LeaseRecord | null {
  const raw = readCookieValue(cookie, COOKIE_NAME);
  if (!raw) return null;
  try {
    const [token, touched] = decodeURIComponent(raw).split(".");
    const touchedAt = Number(touched);
    return token && Number.isFinite(touchedAt) && touchedAt > 0
      ? { token, touchedAt }
      : null;
  } catch {
    return null;
  }
}

export function browserRuntimeLeaseIsActive(
  record: LeaseRecord | null,
  now = Date.now(),
): boolean {
  return !!record && now - record.touchedAt < BROWSER_RUNTIME_LEASE_TTL_MS;
}

function writeLease(token: string, touchedAt = Date.now()): void {
  document.cookie =
    `${COOKIE_NAME}=${encodeURIComponent(`${token}.${touchedAt}`)}; Path=/; SameSite=Strict`;
}

function clearLeaseCookie(): void {
  document.cookie = `${COOKIE_NAME}=; Max-Age=0; Path=/; SameSite=Strict`;
}

function releaseOwnedLease(): void {
  if (!ownedToken || typeof document === "undefined") return;
  const current = parseBrowserRuntimeLease(document.cookie);
  if (current?.token === ownedToken) clearLeaseCookie();
  ownedToken = null;
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
}

function leaseError(): Error {
  const error = new Error(
    "Chama's wallet is already open in another tab. That tab remains fully active; " +
      "close it before funding, claiming, or reconnecting this wallet. Trade chat and status remain available here.",
  );
  (error as Error & { code?: string }).code = "FEDIMINT_RUNTIME_IN_OTHER_TAB";
  return error;
}

/**
 * Claim the single browser Fedimint runtime slot for this host.
 *
 * The short settle turn closes the simultaneous-open race: contenders write
 * unique tokens, then only the last visible token proceeds to import WASM.
 * A renderer crash stops heartbeats and the stale lease self-heals.
 */
export async function acquireBrowserRuntimeLease(): Promise<() => void> {
  if (typeof document === "undefined" || typeof location === "undefined") {
    return () => {};
  }
  if (ownedToken) return releaseOwnedLease;

  const now = Date.now();
  const existing = parseBrowserRuntimeLease(document.cookie);
  if (browserRuntimeLeaseIsActive(existing, now)) throw leaseError();

  const token = globalThis.crypto?.randomUUID?.()
    ?? `${now.toString(36)}-${Math.random().toString(36).slice(2)}`;
  writeLease(token, now);
  await new Promise((resolve) => setTimeout(resolve, CLAIM_SETTLE_MS));

  const settled = parseBrowserRuntimeLease(document.cookie);
  if (settled?.token !== token) throw leaseError();

  ownedToken = token;
  heartbeat = setInterval(() => {
    const current = parseBrowserRuntimeLease(document.cookie);
    if (current?.token !== ownedToken) {
      ownedToken = null;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      return;
    }
    writeLease(token);
  }, HEARTBEAT_MS);

  if (!pageHideInstalled) {
    pageHideInstalled = true;
    globalThis.addEventListener?.("pagehide", releaseOwnedLease);
  }
  return releaseOwnedLease;
}
