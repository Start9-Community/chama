export type AmountDisplayMode = "sats" | "fiat";

export const AMOUNT_DISPLAY_STORAGE_KEY = "chama_amount_display_mode";

export function normalizeAmountDisplayMode(value: unknown): AmountDisplayMode {
  return value === "fiat" ? "fiat" : "sats";
}

export function nextAmountDisplayMode(mode: AmountDisplayMode): AmountDisplayMode {
  return mode === "fiat" ? "sats" : "fiat";
}

export function readAmountDisplayMode(): AmountDisplayMode {
  try {
    return normalizeAmountDisplayMode(globalThis.localStorage?.getItem(AMOUNT_DISPLAY_STORAGE_KEY));
  } catch {
    return "sats";
  }
}

export function writeAmountDisplayMode(mode: AmountDisplayMode): void {
  try {
    globalThis.localStorage?.setItem(AMOUNT_DISPLAY_STORAGE_KEY, mode);
  } catch {
    // Cosmetic preference only; storage failure should not block trading.
  }
}

export function formatFiatAmount(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export function estimateFiatForMsats({
  amountMsats,
  currency,
  usdPerBtc,
  usdFiatRates,
}: {
  amountMsats: number;
  currency: string | null | undefined;
  usdPerBtc: number | null | undefined;
  usdFiatRates: Record<string, number> | null | undefined;
}): number | null {
  const normalizedCurrency = normalizeFiatCurrency(currency);
  if (!normalizedCurrency || !usdPerBtc || !Number.isFinite(usdPerBtc) || usdPerBtc <= 0) {
    return null;
  }
  const rate = fiatRateForCurrency(normalizedCurrency, usdFiatRates);
  if (!rate) return null;
  const amount = (amountMsats / 100_000_000_000) * usdPerBtc * rate;
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

export function formatEstimatedFiatForMsats({
  amountMsats,
  currency,
  usdPerBtc,
  usdFiatRates,
}: {
  amountMsats: number;
  currency: string | null | undefined;
  usdPerBtc: number | null | undefined;
  usdFiatRates: Record<string, number> | null | undefined;
}): string | null {
  const normalizedCurrency = normalizeFiatCurrency(currency);
  if (!normalizedCurrency) return null;
  const amount = estimateFiatForMsats({
    amountMsats,
    currency: normalizedCurrency,
    usdPerBtc,
    usdFiatRates,
  });
  return amount === null ? null : formatFiatAmount(amount, normalizedCurrency);
}

export function estimateSatsForFiat({
  fiatAmount,
  currency,
  usdPerBtc,
  usdFiatRates,
}: {
  fiatAmount: number;
  currency: string | null | undefined;
  usdPerBtc: number | null | undefined;
  usdFiatRates: Record<string, number> | null | undefined;
}): number | null {
  const normalizedCurrency = normalizeFiatCurrency(currency);
  if (
    !normalizedCurrency ||
    !Number.isFinite(fiatAmount) ||
    fiatAmount <= 0 ||
    !usdPerBtc ||
    !Number.isFinite(usdPerBtc) ||
    usdPerBtc <= 0
  ) {
    return null;
  }
  const rate = fiatRateForCurrency(normalizedCurrency, usdFiatRates);
  if (!rate) return null;
  const sats = Math.round((fiatAmount / rate / usdPerBtc) * 100_000_000);
  return Number.isFinite(sats) && sats > 0 ? sats : null;
}

export function resolveEstimatedFiatCurrency({
  viewerCurrency,
  listingCurrency,
}: {
  viewerCurrency: string | null | undefined;
  listingCurrency: string | null | undefined;
}): string | null {
  return normalizeFiatCurrency(viewerCurrency)
    ?? normalizeFiatCurrency(listingCurrency);
}

export function shouldQuoteEstimatedFiat({
  viewerCurrency,
  listingCurrency,
}: {
  viewerCurrency: string | null | undefined;
  listingCurrency: string | null | undefined;
}): boolean {
  const viewer = normalizeFiatCurrency(viewerCurrency);
  if (!viewer) return false;
  return viewer !== normalizeFiatCurrency(listingCurrency);
}

export function normalizeFiatCurrency(currency: string | null | undefined): string | null {
  const normalized = currency?.trim().toUpperCase();
  if (!normalized || normalized === "BTC" || normalized.length < 3) return null;
  return normalized;
}

function fiatRateForCurrency(
  currency: string,
  usdFiatRates: Record<string, number> | null | undefined,
): number | null {
  if (currency === "USD") return 1;
  const rate = usdFiatRates?.[currency];
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? rate : null;
}
