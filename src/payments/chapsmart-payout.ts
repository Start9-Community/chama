// ══════════════════════════════════════════════════════════════════════════
// Chama — ChapSmart TZS payout adapter
// ══════════════════════════════════════════════════════════════════════════

export const CHAPSMART_PAYOUT_PROFILE_STORAGE_KEY = "chama_chapsmart_payout_profile";

export interface ChapsmartPayoutProfile {
  phoneNumber: string;
  recipientName: string;
  createdAt: number;
  lastUsedAt?: number;
}

export interface ChapsmartPayoutInvoiceRequest {
  phoneNumber: string;
  recipientName: string;
  amountSatsMax: number;
  escrowId?: string;
}

export interface ChapsmartPayoutInvoice {
  invoiceId: string;
  bolt11: string;
  amountSats: number;
  amountTZS: number;
  feeSats?: number;
  expiresAt?: number;
}

export interface CreateChapsmartPayoutInvoiceOpts {
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_CHAPSMART_PAYOUT_ENDPOINT = "https://nwc.chapsmart.com/chama/payout-invoice";

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function isProfile(x: any): x is ChapsmartPayoutProfile {
  return (
    x && typeof x === "object" &&
    typeof x.phoneNumber === "string" &&
    typeof x.recipientName === "string" &&
    typeof x.createdAt === "number" &&
    (x.lastUsedAt === undefined || typeof x.lastUsedAt === "number")
  );
}

export function getChapsmartPayoutProfile(): ChapsmartPayoutProfile | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(CHAPSMART_PAYOUT_PROFILE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isProfile(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveChapsmartPayoutProfile(input: {
  phoneNumber: string;
  recipientName: string;
}): ChapsmartPayoutProfile {
  const existing = getChapsmartPayoutProfile();
  const profile: ChapsmartPayoutProfile = {
    phoneNumber: input.phoneNumber.trim(),
    recipientName: input.recipientName.trim(),
    createdAt: existing?.createdAt ?? nowSec(),
    lastUsedAt: nowSec(),
  };
  if (!profile.phoneNumber) throw new Error("Enter a Tanzanian mobile number");
  if (!profile.recipientName || profile.recipientName.split(/\s+/).length < 2) {
    throw new Error("Enter the recipient's first and last name");
  }
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(CHAPSMART_PAYOUT_PROFILE_STORAGE_KEY, JSON.stringify(profile));
    }
  } catch {
    // localStorage is best-effort; return the profile so the in-flight
    // payout can still continue.
  }
  return profile;
}

export function clearChapsmartPayoutProfile(): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(CHAPSMART_PAYOUT_PROFILE_STORAGE_KEY);
    }
  } catch {
    // no-op
  }
}

export function toChapsmartTanzaniaPhone(input: string): string {
  const digits = input.replace(/\D/g, "");
  if (/^0[67]\d{8}$/.test(digits)) return digits;
  if (/^255[67]\d{8}$/.test(digits)) return `0${digits.slice(3)}`;
  if (/^[67]\d{8}$/.test(digits)) return `0${digits}`;
  throw new Error("Enter a Tanzanian mobile number, for example +255 71 234 5678");
}

export function isChapsmartPayoutEligible(input: {
  homeCommunity?: string | null;
  fiatCurrency?: string | null;
}): boolean {
  return (
    input.homeCommunity === "tz-tzs" ||
    (input.fiatCurrency ?? "").toUpperCase() === "TZS"
  );
}

export async function createChapsmartPayoutInvoice(
  request: ChapsmartPayoutInvoiceRequest,
  opts: CreateChapsmartPayoutInvoiceOpts = {},
): Promise<ChapsmartPayoutInvoice> {
  if (!Number.isFinite(request.amountSatsMax) || request.amountSatsMax <= 0) {
    throw new Error("No claimable sats available for Chapsmart payout");
  }

  const endpoint = opts.endpoint ?? DEFAULT_CHAPSMART_PAYOUT_ENDPOINT;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) throw new Error("Chapsmart payout needs network access");

  const phoneNumber = toChapsmartTanzaniaPhone(request.phoneNumber);
  const recipientName = request.recipientName.trim();
  if (!recipientName || recipientName.split(/\s+/).length < 2) {
    throw new Error("Enter the recipient's first and last name");
  }

  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      phoneNumber,
      recipientName,
      amountSatsMax: Math.floor(request.amountSatsMax),
      escrowId: request.escrowId,
    }),
  });

  let data: any = null;
  try {
    data = await response.json();
  } catch {
    // handled below
  }

  if (!response.ok || !data?.success) {
    throw new Error(data?.error || "Chapsmart could not create a payout invoice yet");
  }

  const invoice: ChapsmartPayoutInvoice = {
    invoiceId: String(data.invoiceId || ""),
    bolt11: String(data.bolt11 || ""),
    amountSats: Number(data.amountSats),
    amountTZS: Number(data.amountTZS),
    feeSats: data.feeSats === undefined ? undefined : Number(data.feeSats),
    expiresAt: data.expiresAt === undefined ? undefined : Number(data.expiresAt),
  };

  if (!invoice.invoiceId) throw new Error("Chapsmart response was missing invoiceId");
  if (!/^ln(bc|bcrt|tb)/i.test(invoice.bolt11)) {
    throw new Error("Chapsmart response was missing a Lightning invoice");
  }
  if (!Number.isFinite(invoice.amountSats) || invoice.amountSats <= 0) {
    throw new Error("Chapsmart response was missing amountSats");
  }
  if (invoice.amountSats > request.amountSatsMax) {
    throw new Error("Chapsmart invoice exceeds the claim payout budget");
  }
  if (!Number.isFinite(invoice.amountTZS) || invoice.amountTZS <= 0) {
    throw new Error("Chapsmart response was missing amountTZS");
  }

  return invoice;
}
