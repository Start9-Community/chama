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
