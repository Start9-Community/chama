// ══════════════════════════════════════════════════════════════════════════
// Chama — Sandbox mode (Settings → Advanced)
// ══════════════════════════════════════════════════════════════════════════
//
// v0.1.85: power-user-only gate for surfaces that destroy or rewire
// state — federation switching, custom invite paste, OPFS reset. Per
// the brief, none of these should appear in front of normie users in
// production. Sandbox mode is:
//
//   - Auto-on in dev builds (import.meta.env.DEV) for the team's own work
//   - Opt-in for production users via localStorage.chama_sandbox_mode = "1"
//   - Off by default everywhere else
//
// First-time onboarding now happens via community pill taps in BrowseView
// (one-tap join). Sandbox hosts the picker for power users who want to
// paste a custom invite or pick a non-community-mapped federation.

const SANDBOX_STORAGE_KEY = "chama_sandbox_mode";

export function isSandboxModeOn(): boolean {
  // Auto-on in dev builds
  try {
    if ((import.meta as any).env?.DEV) return true;
  } catch { /* SSR — fall through */ }
  // Opt-in via localStorage flag in production
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem(SANDBOX_STORAGE_KEY) === "1";
    }
  } catch { /* no-op */ }
  return false;
}

export function setSandboxMode(on: boolean): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (on) {
      localStorage.setItem(SANDBOX_STORAGE_KEY, "1");
    } else {
      localStorage.removeItem(SANDBOX_STORAGE_KEY);
    }
  } catch { /* no-op */ }
}

/** Whether the user can toggle sandbox mode in the UI. Always true; the
 *  dev-build auto-on doesn't depend on the toggle, so flipping it off
 *  in dev is harmless (the flag stays implicitly on). The toggle is
 *  meaningful in production where it's the only way in. */
export function canToggleSandboxMode(): boolean {
  return true;
}
