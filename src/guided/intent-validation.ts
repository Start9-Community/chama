import type {
  GuidedIntentField,
  GuidedIntentValidationIssue,
  GuidedIntentValidationResult,
  GuidedTradeIntent,
} from "./types.js";

const ALLOWED_FIELDS = new Set<GuidedIntentField>([
  "version",
  "direction",
  "amountSats",
  "paymentRails",
  "strategy",
  "community",
  "mintUrl",
  "fiatCurrency",
  "maxFiatAmount",
]);

const RAIL_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COMMUNITY_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FIAT_CURRENCY = /^[A-Z]{3}$/;

function issue(
  field: GuidedIntentField,
  code: GuidedIntentValidationIssue["code"],
  message: string,
): GuidedIntentValidationIssue {
  return { field, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parse untrusted UI/voice-shaped data into the only contract the matcher
 * accepts. Unknown fields are rejected so an upstream interpreter cannot
 * smuggle execution-like instructions into a trade intent. */
export function validateGuidedTradeIntent(input: unknown): GuidedIntentValidationResult {
  if (!isRecord(input)) {
    return {
      ok: false,
      issues: [issue("$", "NOT_AN_OBJECT", "Guided trade intent must be an object")],
    };
  }

  const issues: GuidedIntentValidationIssue[] = [];
  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(key as GuidedIntentField)) {
      issues.push(issue("$", "UNKNOWN_FIELD", `Unknown guided intent field: ${key}`));
    }
  }

  if (input.version !== 1) {
    issues.push(issue("version", "UNSUPPORTED_VERSION", "Guided trade intent version must be 1"));
  }
  if (input.direction !== "buy_sats" && input.direction !== "sell_sats") {
    issues.push(issue("direction", "INVALID_DIRECTION", "Direction must be buy_sats or sell_sats"));
  }
  if (
    typeof input.amountSats !== "number"
    || !Number.isSafeInteger(input.amountSats)
    || input.amountSats <= 0
  ) {
    issues.push(issue("amountSats", "INVALID_AMOUNT", "Amount must be a positive whole number of sats"));
  }

  const rawRails = input.paymentRails;
  const paymentRails = Array.isArray(rawRails)
    ? [...new Set(rawRails.map(value => typeof value === "string" ? value.trim().toLowerCase() : value))]
    : [];
  if (
    !Array.isArray(rawRails)
    || paymentRails.length === 0
    || paymentRails.some(value => typeof value !== "string" || !RAIL_KEY.test(value))
  ) {
    issues.push(issue(
      "paymentRails",
      "INVALID_PAYMENT_RAILS",
      "Payment rails must be a non-empty list of lowercase rail keys",
    ));
  }

  if (input.strategy !== "available_now") {
    issues.push(issue(
      "strategy",
      "INVALID_STRATEGY",
      "The first guided milestone supports available_now only",
    ));
  }

  const community = typeof input.community === "string"
    ? input.community.trim().toLowerCase()
    : input.community;
  if (
    community !== undefined
    && (typeof community !== "string" || !COMMUNITY_KEY.test(community))
  ) {
    issues.push(issue("community", "INVALID_COMMUNITY", "Community must be a lowercase slug"));
  }

  const mintUrl = typeof input.mintUrl === "string" ? input.mintUrl.trim() : input.mintUrl;
  if (mintUrl !== undefined && (typeof mintUrl !== "string" || mintUrl.length === 0)) {
    issues.push(issue("mintUrl", "INVALID_MINT_URL", "Mint URL must be a non-empty string"));
  }

  const fiatCurrency = typeof input.fiatCurrency === "string"
    ? input.fiatCurrency.trim().toUpperCase()
    : input.fiatCurrency;
  if (
    fiatCurrency !== undefined
    && (typeof fiatCurrency !== "string" || !FIAT_CURRENCY.test(fiatCurrency))
  ) {
    issues.push(issue("fiatCurrency", "INVALID_FIAT_CURRENCY", "Fiat currency must be a three-letter code"));
  }

  if (
    input.maxFiatAmount !== undefined
    && (
      typeof input.maxFiatAmount !== "number"
      || !Number.isFinite(input.maxFiatAmount)
      || input.maxFiatAmount <= 0
    )
  ) {
    issues.push(issue("maxFiatAmount", "INVALID_MAX_FIAT", "Maximum fiat amount must be positive"));
  }
  if (
    (input.maxFiatAmount === undefined) !== (fiatCurrency === undefined)
  ) {
    issues.push(issue(
      "maxFiatAmount",
      "INCOMPLETE_FIAT_LIMIT",
      "Maximum fiat amount and fiat currency must be supplied together",
    ));
  }

  if (issues.length > 0) return { ok: false, issues };

  const value: GuidedTradeIntent = {
    version: 1,
    direction: input.direction as GuidedTradeIntent["direction"],
    amountSats: input.amountSats as number,
    paymentRails: paymentRails as string[],
    strategy: "available_now",
    ...(typeof community === "string" ? { community } : {}),
    ...(typeof mintUrl === "string" ? { mintUrl } : {}),
    ...(typeof fiatCurrency === "string" ? { fiatCurrency } : {}),
    ...(input.maxFiatAmount !== undefined
      ? { maxFiatAmount: input.maxFiatAmount as number }
      : {}),
  };
  return { ok: true, value };
}
