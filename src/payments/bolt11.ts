// Small BOLT11 helpers for payout/funding routing decisions.

export function stripLightningUri(raw: string): string {
  return String(raw || "").trim().replace(/^lightning:/i, "");
}

export function isBolt11PaymentInfo(raw: string): boolean {
  return /^ln(?!url)(bc|tb|bcrt|sb|bcsim)/i.test(stripLightningUri(raw));
}

/**
 * Extract the msat amount encoded in a BOLT11 human-readable prefix.
 * Returns null for amountless invoices, non-BOLT11 input, or unsupported
 * networks.
 */
export function parseBolt11Msats(raw: string): number | null {
  const invoice = stripLightningUri(raw).toLowerCase();
  const match = /^ln(?:bc|tb|bcrt|sb|bcsim)(\d*)([munp]?)1/.exec(invoice);
  if (!match || !match[1]) return null;

  const amount = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;

  switch (match[2]) {
    case "m": return amount * 100_000_000;
    case "u": return amount * 100_000;
    case "n": return amount * 100;
    case "p": return Math.floor(amount / 10);
    case "": return amount * 100_000_000_000;
    default: return null;
  }
}

export function hasBolt11Amount(raw: string): boolean {
  return parseBolt11Msats(raw) !== null;
}
