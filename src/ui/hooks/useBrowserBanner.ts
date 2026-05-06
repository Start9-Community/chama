// ══════════════════════════════════════════════════════════════════════════
// useBrowserBanner — per-pubkey dismissal of the browser-support banner
// ══════════════════════════════════════════════════════════════════════════
//
// The browser-support banner (BrowserSupportBanner.tsx) fires once per
// pubkey to honestly disclose the iroh-relay browser limitation per
// Pillar 2.7. Dismissal is stored under
// `chama_browser_support_dismissed_${pubkey}` so:
//
//   - A new npub on the same browser sees the banner once until they
//     dismiss it themselves (Bug E from v0.1.85 smoke testing — global
//     dismissal incorrectly suppressed the banner for every subsequent
//     npub on the same browser).
//   - Sign-out + sign-in different npub re-evaluates the dismissal
//     against the new pubkey.
//   - Multi-identity power users get the educational banner once per
//     identity, which matches the per-account semantics other Chama
//     surfaces use.
//
// The hook is a thin React wrapper. The localStorage key shape and the
// re-read-on-pubkey-change behavior are the load-bearing pieces; the
// rest is just plumbing.

import { useState, useEffect } from "react";

const STORAGE_KEY_PREFIX = "chama_browser_support_dismissed_";

function readDismissed(pubkey: string): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(STORAGE_KEY_PREFIX + pubkey) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(pubkey: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STORAGE_KEY_PREFIX + pubkey, "1");
  } catch { /* no-op */ }
}

export function useBrowserBanner(pubkey: string | null): {
  dismissed: boolean;
  dismiss: () => void;
} {
  const [dismissed, setDismissed] = useState<boolean>(false);

  // Re-read on pubkey change. While disconnected, treat as undismissed
  // so the banner re-fires after sign-in if the new npub hasn't
  // dismissed it.
  useEffect(() => {
    setDismissed(pubkey ? readDismissed(pubkey) : false);
  }, [pubkey]);

  const dismiss = () => {
    setDismissed(true);
    if (pubkey) writeDismissed(pubkey);
  };

  return { dismissed, dismiss };
}
