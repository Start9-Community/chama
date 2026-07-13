// ══════════════════════════════════════════════════════════════════════════
// market-fetch — cross-platform fetch for public market data (BTC price, FX).
//
// Web and Capacitor (APK) serve the app from a real / https://localhost origin,
// and the public price APIs answer because they send
// `Access-Control-Allow-Origin: *`. Tauri desktop serves from a custom
// `tauri://` scheme; the system WebView (WebKitGTK / WKWebView) treats that as
// an opaque origin and blocks the cross-origin fetch, so the price/FX feeds
// never resolve and fiat pricing goes dead (the Create sats↔fiat toggle showed
// only sats). On Tauri we route through the HTTP plugin, which makes the request
// from Rust (reqwest) and isn't subject to WebView CORS. See DECISIONS.md
// 2026-06-06. Everywhere else this is just the global fetch.
// ══════════════════════════════════════════════════════════════════════════

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function isTauriRuntime(): boolean {
  const global = globalThis as {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  };
  return Boolean(global.__TAURI__ || global.__TAURI_INTERNALS__);
}

let tauriFetch: FetchLike | null = null;
let tauriFetchLoad: Promise<FetchLike | null> | null = null;

async function loadTauriFetch(): Promise<FetchLike | null> {
  if (tauriFetch) return tauriFetch;
  if (!tauriFetchLoad) {
    // Dynamic import keeps the Tauri plugin out of the web/APK bundle's hot
    // path — it's only fetched the first time we're actually on desktop.
    tauriFetchLoad = import("@tauri-apps/plugin-http")
      .then(mod => {
        tauriFetch = mod.fetch as unknown as FetchLike;
        return tauriFetch;
      })
      .catch(() => null);
  }
  return tauriFetchLoad;
}

export async function marketFetch(url: string, init?: RequestInit): Promise<Response> {
  if (isTauriRuntime()) {
    const tf = await loadTauriFetch();
    if (tf) return tf(url, init);
    // Fall through to the WebView fetch if the plugin failed to load — it may
    // still work on some desktop WebViews, and a failed price read degrades
    // gracefully (cached/unavailable) rather than throwing here.
  }
  return fetch(url, init);
}
