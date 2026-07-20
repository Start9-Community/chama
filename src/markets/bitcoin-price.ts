import { marketFetch } from "./market-fetch.js";

export interface BitcoinPriceSnapshot {
  usd: number | null;
  updatedAt: number | null;
  source: "cache" | "live" | "unavailable";
  providers?: string[];
  error?: string;
}

const CACHE_KEY = "chama_btc_price_usd_v1";
const REFRESH_MS = 60_000;
const STALE_MS = 15 * 60_000;
const PRICE_TIMEOUT_MS = 5_000;

interface PriceSource {
  id: string;
  url: string;
  parse: (data: unknown) => number | null;
}

interface PriceQuote {
  id: string;
  usd: number;
}

const PRICE_SOURCES: PriceSource[] = [
  {
    id: "mempool",
    url: "https://mempool.space/api/v1/prices",
    parse: data => numberAt(data, ["USD"]),
  },
  {
    id: "coinbase",
    url: "https://api.coinbase.com/v2/prices/BTC-USD/spot",
    parse: data => numberAt(data, ["data", "amount"]),
  },
  {
    id: "kraken",
    url: "https://api.kraken.com/0/public/Ticker?pair=XBTUSD",
    parse: data => numberAt(data, ["result", "XXBTZUSD", "c", "0"]),
  },
];

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

export function formatUsdBtcPriceFull(usd: number): string {
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
      const quotes = await fetchConsensusQuotes();
      if (quotes.length === 0) throw new Error("all Bitcoin price sources unavailable");
      const usd = median(quotes.map(q => q.usd));
      if (!Number.isFinite(usd) || usd <= 0) throw new Error("price consensus missing USD");
      snapshot = {
        usd,
        updatedAt: Date.now(),
        source: "live",
        providers: quotes.map(q => q.id),
      };
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

async function fetchConsensusQuotes(): Promise<PriceQuote[]> {
  const settled = await Promise.allSettled(PRICE_SOURCES.map(fetchPriceSource));
  const quotes = settled
    .flatMap(result => result.status === "fulfilled" && result.value ? [result.value] : []);
  if (quotes.length <= 2) return quotes;

  const roughMedian = median(quotes.map(q => q.usd));
  const bounded = quotes.filter(q => Math.abs(q.usd - roughMedian) / roughMedian <= 0.03);
  return bounded.length > 0 ? bounded : quotes;
}

async function fetchPriceSource(source: PriceSource): Promise<PriceQuote | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PRICE_TIMEOUT_MS);
  try {
    const response = await marketFetch(source.url, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${source.id} HTTP ${response.status}`);
    const data = await response.json();
    const usd = source.parse(data);
    if (!usd || !Number.isFinite(usd) || usd <= 0) {
      throw new Error(`${source.id} response missing USD`);
    }
    return { id: source.id, usd };
  } finally {
    clearTimeout(timeout);
  }
}

function numberAt(data: unknown, path: string[]): number | null {
  let cursor: unknown = data;
  for (const key of path) {
    if (cursor == null || (typeof cursor !== "object" && !Array.isArray(cursor))) return null;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  const value = typeof cursor === "number" ? cursor : Number(cursor);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
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
      providers: ["cache"],
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
