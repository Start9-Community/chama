// ══════════════════════════════════════════════════════════════════════════
// Chama — Payment Rail Registry
// ══════════════════════════════════════════════════════════════════════════
//
// Per PHILOSOPHY.md §2.3: payment methods are first-class extensible data.
// Each community surfaces a different set of rails (Wave/Orange Money in
// Senegal, M-Pesa in Kenya, Revtag/$cashtag in global, etc.). The registry
// here is the static v1 truth; v2 may publish rails as community-attached
// Nostr events for organic growth.
//
// allowPublicHandle is the load-bearing privacy bit. Per the philosophy:
//
//   "Customizable public-by-design usernames (Revtag, $cashtag, ZBD
//    username, etc.) get an opt-in 'show publicly' toggle per saved
//    handle in Settings; default is masked. Sensitive handles (phone
//    numbers, bank accounts) have no public-toggle path — privacy
//    default is locked."
//
// allowPublicHandle === false means the Settings UI MUST NOT render a
// visibility toggle for that handle, AND saved-handles.ts enforces the
// same rule on writes (defense in depth).

export interface Rail {
  /** Stable wire identifier — never change once shipped. Lowercase
   *  hyphenated. Examples: wave, orange-money, m-pesa, revtag, cashtag. */
  key: string;
  /** Human-readable label shown in pickers and listing pills. */
  displayName: string;
  /** Whether the user is permitted to opt this rail's handles into the
   *  public-display path. Sensitive rails (phone number, bank account)
   *  are locked private; public-by-design rails (Revtag, $cashtag)
   *  default to masked but allow opt-in publishing. */
  allowPublicHandle: boolean;
  /** Optional list of community slugs this rail is geo-relevant to.
   *  Empty/missing means available to every community (Revtag, $cashtag,
   *  Wise — they cross borders). */
  region?: string[];
  /** Placeholder hint for the input field — "+221 77 123 4567",
   *  "@username", "your.bank@email.com", etc. */
  placeholder?: string;
}

/** v1 seed list. Bias toward small + honest: enumerate the rails we
 *  actually expect users in our four seed communities to want. Sensitive
 *  rails (phone-number-based mobile money, bank transfers) are private-
 *  only; public-by-design tags get the opt-in path. */
export const RAIL_REGISTRY: Rail[] = [
  // ── universal default ──────────────────────────────────────────────
  // Mobile money, bank-transfer coordination, and cash-in/cash-out
  // workflows default to phone numbers across much of the global south.
  // Phone numbers are sensitive identifiers, so they are locked private.
  {
    key: "phone-number",
    displayName: "Phone number",
    allowPublicHandle: false,
    placeholder: "+254 712 345 678",
  },

  // ── sn-cfa (Senegal · CFA) ─────────────────────────────────────────
  // Mobile money in Francophone West Africa is phone-number-based —
  // sensitive by definition.
  {
    key: "wave",
    displayName: "Wave",
    allowPublicHandle: false,
    region: ["sn-cfa"],
    placeholder: "+221 77 123 4567",
  },
  {
    key: "orange-money",
    displayName: "Orange Money",
    allowPublicHandle: false,
    region: ["sn-cfa"],
    placeholder: "+221 77 123 4567",
  },
  {
    key: "wizall",
    displayName: "Wizall",
    allowPublicHandle: false,
    region: ["sn-cfa"],
    placeholder: "+221 77 123 4567",
  },
  {
    key: "free-money",
    displayName: "Free Money",
    allowPublicHandle: false,
    region: ["sn-cfa"],
    placeholder: "+221 77 123 4567",
  },

  // ── East Africa & broader M-Pesa / Airtel footprint ───────────────
  // v0.6.5: broadened region tags. M-Pesa is Safaricom in Kenya but
  // also Vodacom in Tanzania, DRC, Mozambique, Lesotho, and others —
  // the brand and the UX are interchangeable from the user's
  // perspective, so we treat them as one rail. Airtel Money operates
  // across Kenya, Uganda, Tanzania, Rwanda, Zambia, Malawi, Niger,
  // Chad, DRC, Madagascar, Gabon, Republic of Congo, and more.
  // Region arrays list known community slugs (only ke-kes today, but
  // future TZ/UG/RW/etc. communities will pick these up automatically).
  {
    key: "m-pesa",
    displayName: "M-Pesa",
    allowPublicHandle: false,
    region: ["ke-kes"],
    placeholder: "+254 712 345 678",
  },
  {
    key: "airtel-money",
    displayName: "Airtel Money",
    allowPublicHandle: false,
    region: ["ke-kes"],
    placeholder: "+254 733 123 456",
  },
  // MTN Mobile Money (MoMo) — the dominant network across West and
  // Central Africa: Ghana, Côte d'Ivoire, Cameroon, Uganda, Rwanda,
  // Zambia, Bénin, Liberia, Republic of Congo, Guinea, South Sudan.
  // No region tag yet because none of those communities exist in the
  // registry, but listed universally so users in countries it
  // operates in can still tag their phones.
  {
    key: "mtn-momo",
    displayName: "MTN Mobile Money",
    allowPublicHandle: false,
    placeholder: "+233 24 123 4567",
  },
  // Tigo Pesa — Tanzania (rebranded to "Mixx by Yas" 2023 but Tigo
  // Pesa is still widely recognized), historically Senegal & Chad.
  {
    key: "tigo-pesa",
    displayName: "Tigo Pesa",
    allowPublicHandle: false,
    placeholder: "+255 71 234 5678",
  },
  // Telebirr — Ethio Telecom's wallet, Ethiopia's dominant mobile
  // money since 2021.
  {
    key: "telebirr",
    displayName: "Telebirr",
    allowPublicHandle: false,
    placeholder: "+251 91 234 5678",
  },

  // ── South & Southeast Asia mobile money ───────────────────────────
  // bKash — Bangladesh's dominant mobile financial service.
  {
    key: "bkash",
    displayName: "bKash",
    allowPublicHandle: false,
    placeholder: "+880 1700 123456",
  },
  // GCash — Philippines, ~70M users. Globe Telecom's wallet.
  {
    key: "gcash",
    displayName: "GCash",
    allowPublicHandle: false,
    placeholder: "+63 917 123 4567",
  },
  // Maya (formerly PayMaya) — Philippines, GCash's main competitor.
  {
    key: "maya",
    displayName: "Maya (PayMaya)",
    allowPublicHandle: false,
    placeholder: "+63 917 123 4567",
  },
  // Easypaisa — Pakistan, Telenor Bank wallet.
  {
    key: "easypaisa",
    displayName: "Easypaisa",
    allowPublicHandle: false,
    placeholder: "+92 300 1234567",
  },
  // JazzCash — Pakistan, Jazz Mobile Bank wallet.
  {
    key: "jazzcash",
    displayName: "JazzCash",
    allowPublicHandle: false,
    placeholder: "+92 300 1234567",
  },

  // ── Latin America popular rails ──────────────────────────────────
  // PIX — Brazil's instant-payment system. Keys are CPF, email,
  // phone, or a random UUID; phone-keyed PIX is common. Public-by-
  // design (the PIX key is meant to be shared).
  {
    key: "pix",
    displayName: "PIX (Brazil)",
    allowPublicHandle: true,
    placeholder: "+55 11 91234 5678 or CPF / email",
  },
  // Mercado Pago — Argentina, Brazil, Mexico, Chile, Colombia, Peru,
  // Uruguay. Phone-based wallet plus full bank app.
  {
    key: "mercado-pago",
    displayName: "Mercado Pago",
    allowPublicHandle: false,
    placeholder: "+54 9 11 1234 5678",
  },
  // Nequi — Colombia, Bancolombia's digital wallet. Phone-keyed.
  {
    key: "nequi",
    displayName: "Nequi",
    allowPublicHandle: false,
    placeholder: "+57 300 123 4567",
  },

  // ── sv-usd (El Salvador · USD) ─────────────────────────────────────
  // Strike usernames are public-by-design (paystrike.me/<user>).
  {
    key: "strike",
    displayName: "Strike",
    allowPublicHandle: true,
    region: ["sv-usd"],
    placeholder: "username",
  },

  // ── global-usd & cross-community ───────────────────────────────────
  // Public-by-design tags that cross borders. allowPublicHandle: true
  // because the handle was designed to be shared (the username IS the
  // address).
  {
    key: "revtag",
    displayName: "Revtag (Revolut)",
    allowPublicHandle: true,
    placeholder: "@username",
  },
  {
    key: "cashtag",
    displayName: "$cashtag (Cash App)",
    allowPublicHandle: true,
    placeholder: "$username",
  },
  {
    key: "zbd",
    displayName: "ZBD username",
    allowPublicHandle: true,
    placeholder: "username@zbd.gg",
  },
  {
    key: "wise-tag",
    displayName: "Wise tag",
    allowPublicHandle: true,
    placeholder: "@username",
  },
  // Sensitive: email-based payment apps, Zelle (typically email/phone),
  // raw bank wires.
  {
    key: "paypal",
    displayName: "PayPal",
    allowPublicHandle: false,
    placeholder: "you@example.com",
  },
  {
    key: "venmo",
    displayName: "Venmo",
    // Venmo usernames CAN be public, but the typical handle (often phone-
    // tied or PII-adjacent) defaults to private. Conservative.
    allowPublicHandle: false,
    placeholder: "@username",
  },
  {
    key: "zelle",
    displayName: "Zelle",
    allowPublicHandle: false,
    placeholder: "you@example.com or +1 555 555 5555",
  },
  {
    key: "bank-transfer",
    displayName: "Bank transfer",
    allowPublicHandle: false,
    placeholder: "Account number / IBAN",
  },
];

const BY_KEY: Map<string, Rail> = new Map(
  RAIL_REGISTRY.map(r => [r.key, r])
);

/** Look up a rail by its wire key. Returns null for unknown keys
 *  (e.g. a listing using a rail from a future registry version) so
 *  callers can render a generic pill without crashing. */
export function getRailByKey(key: string | null | undefined): Rail | null {
  if (!key) return null;
  return BY_KEY.get(key) ?? null;
}

/** Rails available to a given community. Includes:
 *   - region-scoped rails whose `region` array contains the slug
 *   - cross-community rails (no region field)
 *  Returns the original registry order (curated). */
export function railsForCommunity(slug: string | null | undefined): Rail[] {
  return RAIL_REGISTRY.filter(r => {
    if (!r.region || r.region.length === 0) return true;
    return slug ? r.region.includes(slug) : false;
  });
}

/** Convenience: whether a rail's handles can EVER be made public.
 *  False for unknown keys (conservative — refuse public path on
 *  unfamiliar rails rather than leak by default). */
export function railAllowsPublicHandle(key: string | null | undefined): boolean {
  return getRailByKey(key)?.allowPublicHandle === true;
}

/** v0.6.5: the set of phone-number-based mobile-money networks the
 *  user can tag on their saved phone entry for a given community.
 *  Surfaces the same regional rails Create lets sellers pick, minus
 *  the synthetic "phone-number" rail itself. A user in Senegal sees
 *  Wave / Orange Money / Wizall / Free Money; a user in Kenya sees
 *  M-Pesa / Airtel Money; a global user sees a curated fallback. The
 *  selection rides through the LOCK envelope so counterparties know
 *  which network(s) to send fiat to.
 *
 *  Heuristic for "phone-based": region-scoped rails with the
 *  +cc-formatted placeholder. We don't ship a strict type bit on the
 *  Rail interface to keep registry rows minimal; placeholder is a
 *  reliable proxy for now and easy to upgrade later. */
export function phoneNetworksForCommunity(slug: string | null | undefined): Rail[] {
  // v0.6.5: return region-relevant rails FIRST, then cross-region
  // universally available rails. Never strand a user with an empty
  // list — they may have a phone in a country whose community isn't
  // in the registry yet (Ghana, Tanzania, Bangladesh, Philippines,
  // Brazil, …), and they still need to tag their phone honestly.
  //
  // "Phone-shaped" proxy = placeholder starts with "+". Easy to keep
  // in sync as the registry grows.
  const isPhoneShaped = (r: Rail) =>
    r.key !== "phone-number"
    && (r.placeholder ? r.placeholder.startsWith("+") : false);

  const allPhone = RAIL_REGISTRY.filter(isPhoneShaped);

  const regionMatched = allPhone.filter(r =>
    r.region && r.region.length > 0 && slug ? r.region!.includes(slug) : false
  );
  const crossRegion = allPhone.filter(r => !r.region || r.region.length === 0);

  if (regionMatched.length > 0) {
    // Community user: their local rails first, popular cross-region
    // options after, deduped by key.
    const seen = new Set(regionMatched.map(r => r.key));
    return [...regionMatched, ...crossRegion.filter(r => !seen.has(r.key))];
  }
  // No region match (community doesn't have phone rails configured,
  // or unknown slug): show everything phone-shaped so a Bangladeshi
  // user on Global · USD can still pick bKash.
  return allPhone;
}
