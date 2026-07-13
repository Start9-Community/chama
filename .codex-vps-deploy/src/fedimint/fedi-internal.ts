// Fedi Mini-App wallet bridge.
//
// The Fedi app injects `window.fediInternal` into Mini-App webviews. For
// Chama, the useful primitives are ecash-native: generate bearer notes from
// the user's Fedi wallet, and receive bearer notes back into it.

export interface FediEcashRequest {
  /** Fedi's RequestInvoiceArgs amount is sats, not msats. */
  amount: number;
  memo?: string;
}

export interface FediInternalProvider {
  version?: number;
  generateEcash?: (
    request: FediEcashRequest,
  ) => Promise<string | { notes?: string; ecash?: string }>;
  receiveEcash?: (ecash: string) => Promise<
    | number
    | string
    | {
        msats?: number;
        amountMsats?: number;
        amount_msats?: number;
        amount?: number | string | { msats?: number; msat?: number };
      }
    | void
  >;
}

export function getFediInternal(): FediInternalProvider | null {
  if (typeof window === "undefined") return null;
  const provider = (window as any).fediInternal;
  return provider && typeof provider === "object"
    ? provider as FediInternalProvider
    : null;
}

export function hasFediInternalEcash(): boolean {
  return hasFediInternalGenerateEcash() && hasFediInternalReceiveEcash();
}

export function hasFediInternalGenerateEcash(): boolean {
  const provider = getFediInternal();
  return !!provider && typeof provider.generateEcash === "function";
}

export function hasFediInternalReceiveEcash(): boolean {
  const provider = getFediInternal();
  return !!provider && typeof provider.receiveEcash === "function";
}

export function msatsToExactSats(amountMsats: number): number {
  if (!Number.isSafeInteger(amountMsats) || amountMsats <= 0) {
    throw new Error("Fedi ecash funding requires a positive integer amount.");
  }
  if (amountMsats % 1000 !== 0) {
    throw new Error(
      "Fedi ecash funding only supports whole-sat trade amounts.",
    );
  }
  return amountMsats / 1000;
}

export async function generateFediEcash(
  amountMsats: number,
  memo?: string,
): Promise<{ notes: string; amountSats: number }> {
  const provider = getFediInternal();
  if (!provider || typeof provider.generateEcash !== "function") {
    throw new Error("Fedi wallet ecash funding is not available in this browser.");
  }

  const amountSats = msatsToExactSats(amountMsats);
  const response = await provider.generateEcash({ amount: amountSats, memo });
  const notes = typeof response === "string"
    ? response
    : response?.notes ?? response?.ecash;

  if (!notes || typeof notes !== "string") {
    throw new Error("Fedi wallet did not return ecash notes.");
  }

  return { notes, amountSats };
}

function extractReceivedMsats(result: Awaited<ReturnType<NonNullable<FediInternalProvider["receiveEcash"]>>>): number | null {
  if (typeof result === "number" && Number.isFinite(result)) return result;
  if (typeof result === "string" && result.trim() && Number.isFinite(Number(result))) {
    return Number(result);
  }
  if (!result || typeof result !== "object") return null;

  const direct =
    result.msats ??
    result.amountMsats ??
    result.amount_msats;
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;

  const amount = result.amount;
  if (typeof amount === "number" && Number.isFinite(amount)) return amount;
  if (typeof amount === "string" && amount.trim() && Number.isFinite(Number(amount))) {
    return Number(amount);
  }
  if (amount && typeof amount === "object") {
    const nested = amount.msats ?? amount.msat;
    if (typeof nested === "number" && Number.isFinite(nested)) return nested;
  }

  return null;
}

export async function receiveFediEcash(
  ecash: string,
  expectedMsats?: number,
): Promise<number | null> {
  const provider = getFediInternal();
  if (!provider || typeof provider.receiveEcash !== "function") {
    throw new Error("Fedi wallet ecash receive is not available in this browser.");
  }
  const result = await provider.receiveEcash(ecash);
  const msats = extractReceivedMsats(result);
  if (
    msats !== null &&
    expectedMsats !== undefined &&
    Number.isSafeInteger(expectedMsats) &&
    msats !== expectedMsats
  ) {
    throw new Error(
      `Fedi wallet received ${msats} msats, but this claim expected ${expectedMsats} msats.`,
    );
  }
  return msats;
}
