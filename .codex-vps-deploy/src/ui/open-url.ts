import { isTauriRuntime } from "./sign-in-environment.js";

// v4.1 B (#16): open an external URL from any runtime.
//
// In the Tauri webview, `window.open(...)` and `<a target="_blank">` are silent
// no-ops — there's no native handler for a new browser window — so every
// redirect off-ramp (Bitika/Chapsmart/Banxaas/Bitzed) and the Help-screen
// footer links were DEAD on desktop/APK while working fine in the browser.
// (Tando survives because it's a LUD-16 invoice, not a redirect.)
//
// The fix: when running under Tauri, hand the URL to the OS via the opener
// plugin (`@tauri-apps/plugin-opener`); everywhere else, the normal new-tab
// path. One helper fixes the whole class.
//
// SECURITY: this hands the URL to the operating system's default handler. Only
// pass TRUSTED URLs — provider entries from the external-swap registry and
// Chama's own Help links. Never feed it a URL that originated from untrusted
// listing/chat content.
export async function openExternalUrl(url: string): Promise<void> {
  if (typeof window === "undefined") return;

  if (isTauriRuntime()) {
    try {
      // Dynamic import so the browser bundle never eagerly pulls Tauri code;
      // the plugin encapsulates the exact `plugin:opener|open_url` IPC
      // contract (safer than hand-rolling the invoke).
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
      return;
    } catch (e) {
      // Capability missing / IPC failure — fall through to window.open so the
      // browser/Fedi-webview path is never regressed, and surface it for an
      // on-device tester.
      console.warn("[chama] tauri opener failed, falling back to window.open:", e);
    }
  }

  window.open(url, "_blank", "noopener,noreferrer");
}
