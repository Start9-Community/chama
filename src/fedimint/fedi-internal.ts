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
  receiveEcash?: (ecash: string) => Promise<{ msats: number }>;
}

export function getFediInternal(): FediInternalProvider | null {
  if (typeof window === "undefined") return null;
  const provider = (window as any).fediInternal;
  return provider && typeof provider === "object"
    ? provider as FediInternalProvider
    : null;
}

export function hasFediInternalEcash(): boolean {
  const provider = getFediInternal();
  return !!provider
    && typeof provider.generateEcash === "function"
    && typeof provider.receiveEcash === "function";
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

export async function receiveFediEcash(ecash: string): Promise<number> {
  const provider = getFediInternal();
  if (!provider || typeof provider.receiveEcash !== "function") {
    throw new Error("Fedi wallet ecash receive is not available in this browser.");
  }
  const result = await provider.receiveEcash(ecash);
  if (!result || !Number.isFinite(result.msats)) {
    throw new Error("Fedi wallet did not return the received ecash amount.");
  }
  return result.msats;
}
