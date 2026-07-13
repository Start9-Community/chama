// QR payloads for BOLT11 should favor wallet compatibility over display
// fidelity. Uppercase keeps the payload in QR alphanumeric mode, which
// makes long private invoices significantly easier for phone wallets to scan.
export function makeLightningInvoiceQrPayload(bolt11: string): string {
  const invoice = bolt11.trim().replace(/^lightning:/i, "");
  if (!invoice) return "";
  return `LIGHTNING:${invoice.toUpperCase()}`;
}
