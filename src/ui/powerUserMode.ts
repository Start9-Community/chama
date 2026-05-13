// ══════════════════════════════════════════════════════════════════════════
// Chama — Power-user mode (Settings → Advanced)
// ══════════════════════════════════════════════════════════════════════════
//
// Was `sandboxMode` through v0.4.1. Renamed in v0.4.2 to make room for
// a distinct, product-facing `simMode` (in src/sim/) that mocks the
// Fedimint wallet for testers. Power-user mode is purely a UI gate;
// it has nothing to do with the money layer.
//
// Surfaces: federation switching, custom-invite paste, OPFS reset,
// manual fund. None should appear in front of normie users in
// production.
//
//   - Auto-on in dev builds (import.meta.env.DEV) for the team's own work
//   - Opt-in for production users via localStorage.chama_sandbox_mode = "1"
//     (storage key preserved across the rename so existing power users
//     don't lose the flag)
//   - Off by default everywhere else
//
// First-time onboarding now happens via community pill taps in BrowseView
// (one-tap join). Power-user surfaces host the picker for users who want
// to paste a custom invite or pick a non-community-mapped federation.

const POWER_USER_STORAGE_KEY = "chama_sandbox_mode";

export function isPowerUserModeOn(): boolean {
  // Auto-on in dev builds
  try {
    if ((import.meta as any).env?.DEV) return true;
  } catch { /* SSR — fall through */ }
  // Opt-in via localStorage flag in production
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem(POWER_USER_STORAGE_KEY) === "1";
    }
  } catch { /* no-op */ }
  return false;
}

export function setPowerUserMode(on: boolean): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (on) {
      localStorage.setItem(POWER_USER_STORAGE_KEY, "1");
    } else {
      localStorage.removeItem(POWER_USER_STORAGE_KEY);
    }
  } catch { /* no-op */ }
}

/** Whether the user can toggle power-user mode in the UI. Always true;
 *  the dev-build auto-on doesn't depend on the toggle, so flipping it
 *  off in dev is harmless (the flag stays implicitly on). The toggle
 *  is meaningful in production where it's the only way in. */
export function canTogglePowerUserMode(): boolean {
  return true;
}
