export interface BitcoinPriceSnapshot {
  usd: number | null;
  updatedAt: number | null;
  source: "cache" | "live" | "unavailable";
  error?: string;
}

const PRICE_URL = "https://mempool.space/api/v1/prices";
const CACHE_KEY = "chama_btc_price_usd_v1";
const REFRESH_MS = 60_000;
const STALE_MS = 15 * 60_000;

let snapshot: BitcoinPriceSnapshot = readCachedSnapshot();
let inFlight: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const subscribers = new Set<(snapshot: BitcoinPriceSnapshot) => void>();

export function getBitcoinPriceSnapshot(): BitcoinPriceSnapshot {
  return snapshot;
}

export function subscribeBitcoinPrice(
  callback: (snapshot: BitcoinPriceSnapshot) => void,
): () => void {
  subscribers.add(callback);
  callback(snapshot);
  startPriceLoop();
  void refreshBitcoinPrice();
  return () => {
    subscribers.delete(callback);
    if (subscribers.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function formatUsdBtcPrice(usd: number): string {
  if (usd >= 100_000) return `$${Math.round(usd / 1000).toLocaleString()}k`;
  return `$${Math.round(usd).toLocaleString()}`;
}

export function estimateUsdForSats(sats: number, usdPerBtc: number): number {
  return (sats / 100_000_000) * usdPerBtc;
}

export function premiumPercentForSats({
  sats,
  fiatAmount,
  usdPerBtc,
}: {
  sats: number;
  fiatAmount: number;
  usdPerBtc: number;
}): number | null {
  const spot = estimateUsdForSats(sats, usdPerBtc);
  if (!Number.isFinite(spot) || spot <= 0 || !Number.isFinite(fiatAmount) || fiatAmount <= 0) {
    return null;
  }
  return ((fiatAmount - spot) / spot) * 100;
}

function startPriceLoop() {
  if (timer) return;
  timer = setInterval(() => {
    void refreshBitcoinPrice();
  }, REFRESH_MS);
}

async function refreshBitcoinPrice(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const response = await fetch(PRICE_URL, { cache: "no-store" });
      if (!response.ok) throw new Error(`price HTTP ${response.status}`);
      const data = await response.json() as { USD?: unknown };
      const usd = typeof data.USD === "number" ? data.USD : Number(data.USD);
      if (!Number.isFinite(usd) || usd <= 0) throw new Error("price response missing USD");
      snapshot = { usd, updatedAt: Date.now(), source: "live" };
      writeCachedSnapshot(snapshot);
    } catch (e: any) {
      snapshot = {
        ...snapshot,
        source: snapshot.usd ? "cache" : "unavailable",
        error: e?.message || "Bitcoin price unavailable",
      };
    } finally {
      inFlight = null;
      notify();
    }
  })();
  return inFlight;
}

function notify() {
  for (const callback of subscribers) callback(snapshot);
}

function readCachedSnapshot(): BitcoinPriceSnapshot {
  if (typeof window === "undefined") return { usd: null, updatedAt: null, source: "unavailable" };
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return { usd: null, updatedAt: null, source: "unavailable" };
    const parsed = JSON.parse(raw) as { usd?: unknown; updatedAt?: unknown };
    const usd = typeof parsed.usd === "number" ? parsed.usd : Number(parsed.usd);
    const updatedAt = typeof parsed.updatedAt === "number" ? parsed.updatedAt : Number(parsed.updatedAt);
    if (!Number.isFinite(usd) || usd <= 0 || !Number.isFinite(updatedAt)) {
      return { usd: null, updatedAt: null, source: "unavailable" };
    }
    return {
      usd,
      updatedAt,
      source: Date.now() - updatedAt > STALE_MS ? "unavailable" : "cache",
    };
  } catch {
    return { usd: null, updatedAt: null, source: "unavailable" };
  }
}

function writeCachedSnapshot(next: BitcoinPriceSnapshot) {
  if (typeof window === "undefined" || !next.usd || !next.updatedAt) return;
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify({
      usd: next.usd,
      updatedAt: next.updatedAt,
    }));
  } catch {}
}
