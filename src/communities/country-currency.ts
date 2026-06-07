// ══════════════════════════════════════════════════════════════════════════
// Chama — Country → currency (ISO 3166-1 alpha-2 → ISO 4217)
// ══════════════════════════════════════════════════════════════════════════
//
// The full-world picker maps EVERY country to its real local currency so a
// globe press lands on "🇫🇷 France · EUR", not a generic "Global · USD".
// This table is also the source of the picker's country list (its keys), so
// adding a country here makes it tappable everywhere.
//
// Shared currencies are intentional: XOF (West African CFA), XAF (Central
// African CFA), EUR (eurozone), USD (dollarized economies). Kept current as
// of 2026 (e.g. HR→EUR since 2023, ZW→ZWG/ZiG since 2024).

export const COUNTRY_CURRENCY: Record<string, string> = {
  // ── Africa ──
  DZ: "DZD", AO: "AOA", BJ: "XOF", BW: "BWP", BF: "XOF", BI: "BIF",
  CM: "XAF", CV: "CVE", CF: "XAF", TD: "XAF", KM: "KMF", CG: "XAF",
  CD: "CDF", CI: "XOF", DJ: "DJF", EG: "EGP", GQ: "XAF", ER: "ERN",
  SZ: "SZL", ET: "ETB", GA: "XAF", GM: "GMD", GH: "GHS", GN: "GNF",
  GW: "XOF", KE: "KES", LS: "LSL", LR: "LRD", LY: "LYD", MG: "MGA",
  MW: "MWK", ML: "XOF", MR: "MRU", MU: "MUR", MA: "MAD", MZ: "MZN",
  NA: "NAD", NE: "XOF", NG: "NGN", RW: "RWF", ST: "STN", SN: "XOF",
  SC: "SCR", SL: "SLE", SO: "SOS", ZA: "ZAR", SS: "SSP", SD: "SDG",
  TZ: "TZS", TG: "XOF", TN: "TND", UG: "UGX", ZM: "ZMW", ZW: "ZWG",

  // ── Americas ──
  AG: "XCD", AR: "ARS", BS: "BSD", BB: "BBD", BZ: "BZD", BO: "BOB",
  BR: "BRL", CA: "CAD", CL: "CLP", CO: "COP", CR: "CRC", CU: "CUP",
  DM: "XCD", DO: "DOP", EC: "USD", SV: "USD", GD: "XCD", GT: "GTQ",
  GY: "GYD", HT: "HTG", HN: "HNL", JM: "JMD", MX: "MXN", NI: "NIO",
  PA: "PAB", PY: "PYG", PE: "PEN", KN: "XCD", LC: "XCD", VC: "XCD",
  SR: "SRD", TT: "TTD", US: "USD", UY: "UYU", VE: "VES",

  // ── Asia ──
  AF: "AFN", AM: "AMD", AZ: "AZN", BH: "BHD", BD: "BDT", BT: "BTN",
  BN: "BND", KH: "KHR", CN: "CNY", CY: "EUR", GE: "GEL", IN: "INR",
  ID: "IDR", IR: "IRR", IQ: "IQD", IL: "ILS", JP: "JPY", JO: "JOD",
  KZ: "KZT", KW: "KWD", KG: "KGS", LA: "LAK", LB: "LBP", MY: "MYR",
  MV: "MVR", MN: "MNT", MM: "MMK", NP: "NPR", KP: "KPW", OM: "OMR",
  PK: "PKR", PS: "ILS", PH: "PHP", QA: "QAR", SA: "SAR", SG: "SGD",
  KR: "KRW", LK: "LKR", SY: "SYP", TW: "TWD", TJ: "TJS", TH: "THB",
  TL: "USD", TR: "TRY", TM: "TMT", AE: "AED", UZ: "UZS", VN: "VND",
  YE: "YER",

  // ── Europe ──
  AL: "ALL", AD: "EUR", AT: "EUR", BY: "BYN", BE: "EUR", BA: "BAM",
  BG: "BGN", HR: "EUR", CZ: "CZK", DK: "DKK", EE: "EUR", FI: "EUR",
  FR: "EUR", DE: "EUR", GR: "EUR", HU: "HUF", IS: "ISK", IE: "EUR",
  IT: "EUR", LV: "EUR", LI: "CHF", LT: "EUR", LU: "EUR", MT: "EUR",
  MD: "MDL", MC: "EUR", ME: "EUR", NL: "EUR", MK: "MKD", NO: "NOK",
  PL: "PLN", PT: "EUR", RO: "RON", RU: "RUB", SM: "EUR", RS: "RSD",
  SK: "EUR", SI: "EUR", ES: "EUR", SE: "SEK", CH: "CHF", UA: "UAH",
  GB: "GBP", VA: "EUR",

  // ── Oceania ──
  AU: "AUD", FJ: "FJD", KI: "AUD", MH: "USD", FM: "USD", NR: "AUD",
  NZ: "NZD", PW: "USD", PG: "PGK", WS: "WST", SB: "SBD", TO: "TOP",
  TV: "AUD", VU: "VUV",
};

/** Currency for a country code, defaulting to USD for anything unmapped
 *  (keeps a generated shell well-formed even for an unexpected code). */
export function currencyForCountry(code: string): string {
  return COUNTRY_CURRENCY[code.toUpperCase()] ?? "USD";
}
