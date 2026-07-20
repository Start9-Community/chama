import { marketFetch } from "./market-fetch.js";

export interface FiatRatesSnapshot {
  rates: Record<string, number>;
  updatedAt: number | null;
  source: "cache" | "live" | "unavailable";
  providers?: string[];
  error?: string;
}

const CACHE_KEY = "chama_usd_fiat_rates_v1";
const REFRESH_MS = 6 * 60_000;
const STALE_MS = 12 * 60 * 60_000;
const RATES_TIMEOUT_MS = 5_000;

interface RatesSource {
  id: string;
  url: string;
  parse: (data: unknown) => Record<string, number>;
}

interface RatesQuote {
  id: string;
  rates: Record<string, number>;
}

const RATE_SOURCES: RatesSource[] = [
  {
    id: "open-er",
    url: "https://open.er-api.com/v6/latest/USD",
    parse: data => parseRatesRecord(valueAt(data, ["rates"])),
  },
  {
    id: "exchange-rate-api",
    url: "https://api.exchangerate-api.com/v4/latest/USD",
    parse: data => parseRatesRecord(valueAt(data, ["rates"])),
  },
  {
    id: "fawaz-cdn",
    url: "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
    parse: data => parseRatesRecord(valueAt(data, ["usd"])),
  },
];

let snapshot: FiatRatesSnapshot = readCachedSnapshot();
let inFlight: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const subscribers = new Set<(snapshot: FiatRatesSnapshot) => void>();

export function getFiatRatesSnapshot(): FiatRatesSnapshot {
  return snapshot;
}

export function subscribeFiatRates(
  callback: (snapshot: FiatRatesSnapshot) => void,
): () => void {
  subscribers.add(callback);
  callback(snapshot);
  startRatesLoop();
  void refreshFiatRates();
  return () => {
    subscribers.delete(callback);
    if (subscribers.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function startRatesLoop() {
  if (timer) return;
  timer = setInterval(() => {
    void refreshFiatRates();
  }, REFRESH_MS);
}

async function refreshFiatRates(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const quotes = await fetchConsensusRates();
      if (quotes.length === 0) throw new Error("all fiat FX sources unavailable");
      const rates = mergeRates(quotes);
      if (Object.keys(rates).length === 0) throw new Error("fiat FX consensus empty");
      snapshot = {
        rates,
        updatedAt: Date.now(),
        source: "live",
        providers: quotes.map(q => q.id),
      };
      writeCachedSnapshot(snapshot);
    } catch (e: any) {
      snapshot = {
        ...snapshot,
        source: Object.keys(snapshot.rates).length > 0 ? "cache" : "unavailable",
        error: e?.message || "Fiat FX rates unavailable",
      };
    } finally {
      inFlight = null;
      notify();
    }
  })();
  return inFlight;
}

async function fetchConsensusRates(): Promise<RatesQuote[]> {
  const settled = await Promise.allSettled(RATE_SOURCES.map(fetchRatesSource));
  return settled.flatMap(result =>
    result.status === "fulfilled" && result.value ? [result.value] : []
  );
}

async function fetchRatesSource(source: RatesSource): Promise<RatesQuote | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RATES_TIMEOUT_MS);
  try {
    const response = await marketFetch(source.url, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${source.id} HTTP ${response.status}`);
    const data = await response.json();
    const rates = source.parse(data);
    if (Object.keys(rates).length === 0) throw new Error(`${source.id} response missing rates`);
    return { id: source.id, rates };
  } finally {
    clearTimeout(timeout);
  }
}

function mergeRates(quotes: RatesQuote[]): Record<string, number> {
  const buckets = new Map<string, number[]>();
  for (const quote of quotes) {
    for (const [currency, rate] of Object.entries(quote.rates)) {
      if (!Number.isFinite(rate) || rate <= 0) continue;
      const normalized = currency.trim().toUpperCase();
      if (normalized.length < 3) continue;
      const bucket = buckets.get(normalized) ?? [];
      bucket.push(rate);
      buckets.set(normalized, bucket);
    }
  }
  buckets.set("USD", [...(buckets.get("USD") ?? []), 1]);

  const rates: Record<string, number> = {};
  for (const [currency, values] of buckets.entries()) {
    if (values.length === 0) continue;
    const roughMedian = median(values);
    const bounded = values.filter(value => Math.abs(value - roughMedian) / roughMedian <= 0.06);
    rates[currency] = median(bounded.length > 0 ? bounded : values);
  }
  return rates;
}

function parseRatesRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const rates: Record<string, number> = {};
  for (const [currency, raw] of Object.entries(value as Record<string, unknown>)) {
    const rate = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(rate) && rate > 0) rates[currency.toUpperCase()] = rate;
  }
  return rates;
}

function valueAt(data: unknown, path: string[]): unknown {
  let cursor: unknown = data;
  for (const key of path) {
    if (cursor == null || (typeof cursor !== "object" && !Array.isArray(cursor))) return null;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
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

function readCachedSnapshot(): FiatRatesSnapshot {
  if (typeof window === "undefined") return { rates: {}, updatedAt: null, source: "unavailable" };
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return { rates: {}, updatedAt: null, source: "unavailable" };
    const parsed = JSON.parse(raw) as { rates?: unknown; updatedAt?: unknown };
    const updatedAt = typeof parsed.updatedAt === "number" ? parsed.updatedAt : Number(parsed.updatedAt);
    const rates = parseRatesRecord(parsed.rates);
    if (!Number.isFinite(updatedAt) || Object.keys(rates).length === 0) {
      return { rates: {}, updatedAt: null, source: "unavailable" };
    }
    return {
      rates,
      updatedAt,
      source: Date.now() - updatedAt > STALE_MS ? "unavailable" : "cache",
      providers: ["cache"],
    };
  } catch {
    return { rates: {}, updatedAt: null, source: "unavailable" };
  }
}

function writeCachedSnapshot(next: FiatRatesSnapshot) {
  if (typeof window === "undefined" || !next.updatedAt || Object.keys(next.rates).length === 0) return;
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify({
      rates: next.rates,
      updatedAt: next.updatedAt,
    }));
  } catch {}
}
