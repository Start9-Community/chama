// ══════════════════════════════════════════════════════════════════════════
// Chama — Create wizard (v0.2.0 item 5 + items 7, 10)
// ══════════════════════════════════════════════════════════════════════════
//
// Three-step wizard for publishing a listing. Per the v0.2.0 brief:
//
//   Step 1 — Category + community context. Four large category cards
//     (Exchange / Community Bill Pay / Marketplace / Lending) above a read-only
//     "Listing in [home community]" line. Federation is never named
//     here — derived downstream from the community.
//
//     Item 10: arbiter attention warning surfaces here when the user
//     is arbiter on a LOCKED escrow (soft = no disagreement yet, hard
//     = vote-pending tiebreaker). Soft = informational; hard =
//     conflict-explicit with asymmetric CTA. Either way it's a warning,
//     not a block — Pillar 2.7 educational moment.
//
//     Save-draft surfacing: "Continue your last [vertical] listing"
//     cards for any drafts in localStorage, cap 3 visible (sorted by
//     savedAt desc), older drafts behind "Show more drafts" expander.
//
//   Step 2 — Vertical-specific form. Ships description + amount + fiat,
//     accepted payment rails, menu/bracket rows, marketplace fulfillment,
//     and the future graduated subscription surface.
//
//     Item 7: subscription toggle is invisible unless canOfferSubscription
//     === true. v0.2.0 universally false (no rating events yet) → toggle
//     hidden for everyone. When v0.2.1 wires the rating aggregator the
//     gate naturally opens for graduated sellers.
//
//   Step 3 — Review & publish. Preview card (left/top) + federation-
//     honesty info card (one-time-per-account, dismissed on first
//     publish). Save-draft button + Publish button.

import { useState, useEffect, type WheelEvent } from "react";
import { type MenuItem } from "../../escrow-engine/types.js";
import { randomId } from "../../storage/random-id.js";
import { categoryAllowsFulfillmentChoice, type Fulfillment } from "../../labels/vote-labels.js";
import { getCommunityBySlug, communityForInvite, DEFAULT_COMMUNITY_SLUG } from "../../communities/registry.js";
import {
  getUserCommunitySlug,
  getUserCommunitySlugRaw,
  setUserCommunitySlug,
} from "../../communities/storage.js";
import { defaultCurrencyForCommunity } from "../../communities/currency.js";
import { getTrustedArbiterPool } from "../../arbiters/pool.js";
import { type ArbiterWarning, displayCounterpartyName, resolveCreateMintUrl } from "../decisions.js";
import { T, inputStyle, fmtSats } from "../theme.js";
import {
  MIN_REAL_ATOMIC_FUNDING_SATS,
  minimumAtomicFundingMessage,
} from "../../payments/funding-limits.js";
import { railsForCommunity, categoryUsesPaymentRails } from "../../payments/rail-registry.js";
import { isTestnetMode } from "../../fedimint/index.js";
import { isSimModeOn } from "../../sim/simMode.js";
import {
  getScopedStorageItem,
  removeScopedStorageItem,
  setScopedStorageItem,
} from "../../storage/user-scope.js";
import { BitcoinAmount } from "../components/BitcoinAmount.js";
import {
  estimateFiatForMsats,
  estimateSatsForFiat,
  formatFiatAmount,
  type AmountDisplayMode,
} from "../amount-display.js";
import { useBitcoinPrice } from "../hooks/useBitcoinPrice.js";
import { useFiatRates } from "../hooks/useFiatRates.js";

type Step = 1 | 2 | 3;
type Vertical = "p2p-trade" | "bill-pay" | "marketplace" | "lending";
type ListingMode = "single" | "menu";

const VERTICALS: { id: Vertical; label: string; icon: string; description: string }[] = [
  { id: "p2p-trade", label: "Exchange", icon: "⚡", description: "Swap sats for fiat with another user." },
  { id: "bill-pay", label: "Community Bill Pay", icon: "🧾", description: "Pay a bill in exchange for sats." },
  { id: "marketplace", label: "Marketplace", icon: "🏪", description: "Sell goods, services, or digital items." },
  { id: "lending", label: "Lending", icon: "🤝", description: "Lend sats with repayment terms." },
];

interface FormState {
  listingMode: ListingMode;
  desc: string;
  sats: string;
  fiat: string;
  cur: string;
  premium: string;
  fulfillment: Fulfillment;
  isSubscription: boolean;
  periods: string;
  intervalDays: string;
  paymentMethods: string[];
  menuItems: MenuDraftItem[];
  /** #7 multi-unit storefront: units in stock for a single-product marketplace
   *  listing. ">=2 makes it a multi-unit parent (buyers spawn child escrows);
   *  blank / 1 is a legacy single-unit listing. Stored as a string for the
   *  input; parsed at submit. Optional so older drafts load without it. */
  stock?: string;
}

interface SavedDraft {
  vertical: Vertical;
  formState: FormState;
  savedAt: number;
}

interface MenuDraftItem {
  id: string;
  label: string;
  sats: string;
  maxSats: string;
  fiat: string;
  description: string;
  fulfillment: Fulfillment;
  imageDataUrl: string;
  dueDate: string;
  termDays: string;
  apr: string;
  trustTier: string;
  maxQty: string;
}

const DRAFT_KEY_PREFIX = "chama_create_draft_";
const FIRST_PUBLISH_KEY_PREFIX = "chama_first_publish_done_";
const MAX_MENU_ITEMS = 20;
const MAX_MENU_IMAGE_DATA_URL_CHARS = 500_000;
const MENU_IMAGE_MAX_EDGE_PX = 1280;
const MENU_IMAGE_ACCEPT = [
  "image/*",
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
].join(",");
const LENDING_TIER_LIMITS = [
  { tier: 1, maxSats: 50_000, label: "Starter" },
  { tier: 2, maxSats: 200_000, label: "Proven" },
  { tier: 3, maxSats: 500_000, label: "Trusted" },
  { tier: 4, maxSats: 1_000_000, label: "Prime" },
  { tier: 5, maxSats: 2_000_000, label: "OG" },
] as const;
const MAX_FEDIMINT_LENDING_SATS = LENDING_TIER_LIMITS[LENDING_TIER_LIMITS.length - 1].maxSats;

function newMenuDraftItem(): MenuDraftItem {
  return {
    id: `mi_${Date.now().toString(36)}_${randomId(6)}`,
    label: "",
    sats: "",
    maxSats: "",
    fiat: "",
    description: "",
    fulfillment: "service",
    imageDataUrl: "",
    dueDate: "",
    termDays: "",
    apr: "",
    trustTier: "",
    maxQty: "",
  };
}

function normalizeMenuDraftItem(raw: any): MenuDraftItem | null {
  if (!raw || typeof raw !== "object") return null;
  return {
    id: typeof raw.id === "string" && raw.id.trim()
      ? raw.id
      : newMenuDraftItem().id,
    label: typeof raw.label === "string" ? raw.label : "",
    sats: typeof raw.sats === "string" || typeof raw.sats === "number" ? String(raw.sats) : "",
    maxSats: typeof raw.maxSats === "string" || typeof raw.maxSats === "number" ? String(raw.maxSats) : "",
    fiat: typeof raw.fiat === "string" || typeof raw.fiat === "number" ? String(raw.fiat) : "",
    description: typeof raw.description === "string" ? raw.description : "",
    fulfillment: raw.fulfillment === "physical" || raw.fulfillment === "digital" || raw.fulfillment === "service"
      ? raw.fulfillment
      : "service",
    imageDataUrl: typeof raw.imageDataUrl === "string" ? raw.imageDataUrl : "",
    dueDate: typeof raw.dueDate === "string" ? raw.dueDate : "",
    termDays: typeof raw.termDays === "string" || typeof raw.termDays === "number" ? String(raw.termDays) : "",
    apr: typeof raw.apr === "string" || typeof raw.apr === "number" ? String(raw.apr) : "",
    trustTier: typeof raw.trustTier === "string" || typeof raw.trustTier === "number" ? String(raw.trustTier) : "",
    maxQty: typeof raw.maxQty === "string" || typeof raw.maxQty === "number" ? String(raw.maxQty) : "",
  };
}

function inferImageMimeType(file: File): string | null {
  if (file.type.startsWith("image/")) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (!ext) return null;
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  if (ext === "avif") return "image/avif";
  if (ext === "heic") return "image/heic";
  if (ext === "heif") return "image/heif";
  if (ext === "bmp") return "image/bmp";
  return null;
}

function normalizeImageDataUrl(file: File, dataUrl: string): string | null {
  if (dataUrl.startsWith("data:image/")) return dataUrl;
  const mimeType = inferImageMimeType(file);
  if (!mimeType) return null;
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) return null;
  return `data:${mimeType};base64,${dataUrl.slice(commaIndex + 1)}`;
}

function readImageFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Couldn't read image"));
    reader.readAsDataURL(file);
  });
}

function loadImageDataUrl(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't preview image"));
    img.src = dataUrl;
  });
}

async function prepareMenuImageDataUrl(file: File): Promise<string> {
  const original = normalizeImageDataUrl(file, await readImageFileAsDataUrl(file));
  if (!original) {
    throw new Error("That file doesn't look like a supported photo.");
  }
  if (original.length <= MAX_MENU_IMAGE_DATA_URL_CHARS) return original;

  const img = await loadImageDataUrl(original);
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;

  for (const maxEdge of [MENU_IMAGE_MAX_EDGE_PX, 1024, 820, 640, 500]) {
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Image preview is not available in this browser.");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, targetWidth, targetHeight);
    ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

    for (const quality of [0.82, 0.72, 0.62, 0.52, 0.42]) {
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      if (dataUrl.length <= MAX_MENU_IMAGE_DATA_URL_CHARS) return dataUrl;
    }
  }

  throw new Error("That screenshot is too large for this release. Try a tighter crop.");
}

function normalizeFormState(raw: any, currency = "USD"): FormState {
  const fallback = emptyCreateFormState(currency);
  if (!raw || typeof raw !== "object") return fallback;
  const menuItems = Array.isArray(raw.menuItems)
    ? (raw.menuItems as unknown[])
        .map(normalizeMenuDraftItem)
        .filter((item): item is MenuDraftItem => item !== null)
        .slice(0, MAX_MENU_ITEMS)
    : [];
  const listingMode: ListingMode = raw.listingMode === "menu"
    ? "menu"
    : raw.listingMode === "single"
      ? "single"
      : menuItems.length > 0
        ? "menu"
        : fallback.listingMode;
  return {
    ...fallback,
    ...raw,
    listingMode,
    cur: fallback.cur,
    premium: typeof raw.premium === "string" || typeof raw.premium === "number" ? String(raw.premium) : fallback.premium,
    paymentMethods: Array.isArray(raw.paymentMethods)
      ? raw.paymentMethods
          .map((method: unknown) => typeof method === "string" ? method.trim() : "")
          .filter(Boolean)
      : fallback.paymentMethods,
    fulfillment: raw.fulfillment === "physical" || raw.fulfillment === "digital" || raw.fulfillment === "service"
      ? raw.fulfillment
      : fallback.fulfillment,
    menuItems,
  };
}

function parseWholeSats(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseOptionalPositiveNumber(value: string): number | undefined {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parsePremiumBps(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return undefined;
  const clamped = Math.max(-99, Math.min(1000, parsed));
  return Math.round(clamped * 100);
}

function parseOptionalPositiveInt(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function lendingTierForSats(sats: number): number | undefined {
  if (!Number.isFinite(sats) || sats <= 0) return undefined;
  return LENDING_TIER_LIMITS.find(limit => sats <= limit.maxSats)?.tier;
}

function lendingTierLimitForTier(tier: number | undefined): typeof LENDING_TIER_LIMITS[number] | undefined {
  return LENDING_TIER_LIMITS.find(limit => limit.tier === tier);
}

function lendingTierSummary(value: string) {
  const sats = parseWholeSats(value);
  const tier = lendingTierForSats(sats);
  const limit = lendingTierLimitForTier(tier);
  if (!sats) return "Enter principal to assign borrower tier.";
  if (!tier || !limit) {
    return (
      <>
        Above current Fedimint lending cap of <BitcoinAmount sats={MAX_FEDIMINT_LENDING_SATS} size={11} gap={4} glyphScale={1.18} color="inherit" glyphColor="inherit" />.
      </>
    );
  }
  return (
    <>
      Tier {tier} · {limit.label} · up to <BitcoinAmount sats={limit.maxSats} size={11} gap={4} glyphScale={1.18} color="inherit" glyphColor="inherit" />
    </>
  );
}

function lendingAmountAboveCurrentCap(value: string): boolean {
  const sats = parseWholeSats(value);
  return sats > MAX_FEDIMINT_LENDING_SATS;
}

function parseDueDate(value: string): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value + "T23:59:59");
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

function menuKindForVertical(vertical: Vertical): NonNullable<MenuItem["kind"]> {
  if (vertical === "p2p-trade") return "exchange-bracket";
  if (vertical === "bill-pay") return "bill";
  if (vertical === "lending") return "loan";
  return "market-item";
}

function normalizeMenuItems(form: FormState, vertical: Vertical): MenuItem[] {
  if (form.listingMode !== "menu") return [];
  return form.menuItems.flatMap((item, index) => {
    const label = item.label.trim();
    const minSats = parseWholeSats(item.sats);
    const maxSats = vertical === "p2p-trade"
      ? (parseWholeSats(item.maxSats) || minSats)
      : minSats;
    if (!label || minSats <= 0) return [];
    if (vertical === "p2p-trade" && maxSats < minSats) return [];
    const fiatAmount = vertical === "lending"
      ? undefined
      : item.fiat.trim()
        ? Number.parseFloat(item.fiat)
        : undefined;
    const kind = menuKindForVertical(vertical);
    return [{
      id: item.id || `item_${index + 1}`,
      label,
      kind,
      amountMsats: minSats * 1000,
      minAmountMsats: vertical === "p2p-trade" ? minSats * 1000 : undefined,
      maxAmountMsats: vertical === "p2p-trade" ? maxSats * 1000 : undefined,
      description: item.description.trim() || undefined,
      fiatAmount: Number.isFinite(fiatAmount) ? fiatAmount : undefined,
      fiatCurrency: Number.isFinite(fiatAmount) ? form.cur : undefined,
      fulfillment: vertical === "marketplace" ? item.fulfillment : undefined,
      imageDataUrl: vertical === "marketplace" && item.imageDataUrl ? item.imageDataUrl : undefined,
      dueAt: vertical === "bill-pay" ? parseDueDate(item.dueDate) : undefined,
      termDays: vertical === "lending" ? parseOptionalPositiveInt(item.termDays) : undefined,
      aprBps: vertical === "lending"
        ? (() => {
            const apr = parseOptionalPositiveNumber(item.apr);
            return apr === undefined ? undefined : Math.round(apr * 100);
          })()
        : undefined,
      trustTier: vertical === "lending" ? lendingTierForSats(minSats) : undefined,
      maxQuantity: vertical === "marketplace" ? parseOptionalPositiveInt(item.maxQty) : undefined,
    }];
  });
}

function hasLendingAmountAboveCurrentCap(form: FormState, vertical: Vertical): boolean {
  if (vertical !== "lending") return false;
  if (form.listingMode === "menu") {
    return form.menuItems.some(item => lendingAmountAboveCurrentCap(item.sats));
  }
  return lendingAmountAboveCurrentCap(form.sats);
}

function hasPartialMenuRows(form: FormState, vertical: Vertical): boolean {
  if (form.listingMode !== "menu") return false;
  return form.menuItems.some(item => {
    const touched = item.label.trim()
      || item.sats.trim()
      || item.maxSats.trim()
      || item.fiat.trim()
      || item.description.trim()
      || item.imageDataUrl
      || item.dueDate.trim()
      || item.termDays.trim()
      || item.apr.trim()
      || item.trustTier.trim();
    if (!touched) return false;
    if (!item.label.trim() || parseWholeSats(item.sats) <= 0) return true;
    if (vertical === "p2p-trade") {
      const maxSats = parseWholeSats(item.maxSats);
      if (item.maxSats.trim() && maxSats <= 0) return true;
      return maxSats > 0 && maxSats < parseWholeSats(item.sats);
    }
    return false;
  });
}

function minimumMenuSats(items: MenuItem[]): number {
  if (items.length === 0) return 0;
  return Math.min(...items.map(item => Math.floor(item.amountMsats / 1000)));
}

function effectiveListingSats(form: FormState, vertical: Vertical): number {
  const menuItems = normalizeMenuItems(form, vertical);
  if (menuItems.length > 0) return minimumMenuSats(menuItems);
  const baseSats = parseWholeSats(form.sats);
  return form.isSubscription
    ? baseSats * parseWholeSats(form.periods)
    : baseSats;
}

function hasDraftContent(form: FormState): boolean {
  return !!(
    form.desc.trim()
    || form.sats.trim()
    || form.fiat.trim()
    || form.premium.trim()
    || form.paymentMethods.length > 0
    || form.menuItems.some(item =>
      item.label.trim()
      || item.sats.trim()
      || item.maxSats.trim()
      || item.fiat.trim()
      || item.description.trim()
      || item.imageDataUrl
      || item.dueDate.trim()
      || item.termDays.trim()
      || item.apr.trim()
      || item.trustTier.trim()
    )
  );
}

function readDraft(vertical: Vertical): SavedDraft | null {
  try {
    const raw = getScopedStorageItem(DRAFT_KEY_PREFIX + vertical);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.vertical || !parsed?.formState) return null;
    return {
      vertical: parsed.vertical,
      formState: normalizeFormState(parsed.formState),
      savedAt: Number.isFinite(parsed.savedAt) ? parsed.savedAt : Date.now(),
    };
  } catch { return null; }
}

function writeDraft(draft: SavedDraft): void {
  try {
    setScopedStorageItem(DRAFT_KEY_PREFIX + draft.vertical, JSON.stringify(draft));
  } catch { /* no-op */ }
}

function clearDraft(vertical: Vertical): void {
  try {
    removeScopedStorageItem(DRAFT_KEY_PREFIX + vertical);
  } catch { /* no-op */ }
}

function readAllDrafts(): SavedDraft[] {
  return VERTICALS
    .map(v => readDraft(v.id))
    .filter((d): d is SavedDraft => d !== null)
    .sort((a, b) => b.savedAt - a.savedAt);
}

function hasFirstPublishedBefore(pubkey: string | null): boolean {
  if (!pubkey) return false;
  try {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(FIRST_PUBLISH_KEY_PREFIX + pubkey) === "1";
  } catch { return false; }
}

function markFirstPublished(pubkey: string | null): void {
  if (!pubkey) return;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(FIRST_PUBLISH_KEY_PREFIX + pubkey, "1");
    }
  } catch { /* no-op */ }
}

function blurNumberInputOnWheel(e: WheelEvent<HTMLInputElement>) {
  e.currentTarget.blur();
}

function menuTitleForVertical(vertical: Vertical): string {
  if (vertical === "p2p-trade") return "SAT OPTIONS";
  if (vertical === "bill-pay") return "BILLS";
  if (vertical === "lending") return "LOAN OFFERS";
  return "STORE ITEMS";
}

function menuAddLabelForVertical(vertical: Vertical): string {
  if (vertical === "p2p-trade") return "+ Option";
  if (vertical === "bill-pay") return "+ Bill";
  if (vertical === "lending") return "+ Loan";
  return "+ Item";
}

function menuPlaceholderForVertical(vertical: Vertical, index: number): string {
  if (vertical === "p2p-trade") return `Option ${index + 1}`;
  if (vertical === "bill-pay") return `Bill ${index + 1}`;
  if (vertical === "lending") return `Loan offer ${index + 1}`;
  return `Item ${index + 1}`;
}

function menuHintForVertical(vertical: Vertical): string {
  if (vertical === "p2p-trade") return "Buyers choose an exact sats amount inside an option.";
  if (vertical === "bill-pay") return "Volunteers can bundle one or more bills before locking.";
  if (vertical === "lending") return "Lenders choose one or more loan requests to fund.";
  return "Products and services can carry images and fiat anchors.";
}

function menuCurrencyHint(vertical: Vertical, currency: string): string {
  if (vertical === "p2p-trade") return `Every option uses ${currency}; no mixed-currency checkout.`;
  if (vertical === "bill-pay") return `All bill estimates use ${currency}; volunteers can bundle them safely.`;
  if (vertical === "lending") return `Loan tiers are sats-based; ${currency} stays as the community fiat context for repayment display.`;
  return `All item fiat anchors display in ${currency}.`;
}

function singleModeLabel(vertical: Vertical): string {
  if (vertical === "bill-pay") return "Single bill";
  if (vertical === "marketplace") return "Single";
  if (vertical === "lending") return "One loan";
  return "One swap";
}

function menuModeLabel(vertical: Vertical): string {
  if (vertical === "p2p-trade") return "Curated swaps";
  if (vertical === "bill-pay") return "Monthly bills";
  if (vertical === "lending") return "Loanbook";
  return "Storefront";
}

function singleModeDescription(vertical: Vertical): string {
  if (vertical === "bill-pay") return "One bill, one checkout.";
  if (vertical === "marketplace") return "One product or service.";
  if (vertical === "lending") return "One principal amount.";
  return "One exact sats amount.";
}

function menuModeDescription(vertical: Vertical): string {
  if (vertical === "p2p-trade") return "Let buyers choose from options.";
  if (vertical === "bill-pay") return "Let volunteers bundle bills.";
  if (vertical === "lending") return "Multiple loan requests in one place.";
  return "A seller page with multiple items.";
}

function descriptionLabel(vertical: Vertical, usingMenu: boolean): string {
  if (usingMenu) {
    if (vertical === "bill-pay") return "BUNDLE NAME";
    if (vertical === "marketplace") return "STORE NAME";
    if (vertical === "lending") return "LOAN BOOK NAME";
    return "NAME";
  }
  return "DESCRIPTION";
}

function descriptionPlaceholder(vertical: Vertical, usingMenu: boolean): string {
  if (usingMenu) {
    if (vertical === "bill-pay") return "My bills for the month";
    if (vertical === "marketplace") return "Your store name";
    if (vertical === "lending") return "Your lending desk";
    return "Your exchange name";
  }
  if (vertical === "bill-pay") return "Pay my electricity bill";
  if (vertical === "marketplace") return "What are you selling?";
  if (vertical === "lending") return "Loan terms in a sentence";
  return "What are you trading?";
}

function descriptionRequired(vertical: Vertical, usingMenu: boolean): boolean {
  return usingMenu || vertical !== "p2p-trade";
}

function fallbackMenuDescription(vertical: Vertical, menuItems: MenuItem[]): string {
  if (menuItems.length === 1) return menuItems[0]?.label ?? "";
  if (vertical === "p2p-trade") return `${menuItems.length} sats options`;
  if (vertical === "bill-pay") return `${menuItems.length}-bill bundle`;
  if (vertical === "lending") return `${menuItems.length} loan offers`;
  return `${menuItems.length}-item store`;
}

function buildListingDescription(form: FormState, vertical: Vertical, menuItems: MenuItem[]): string {
  const desc = form.desc.trim();
  if (desc) return desc;
  if (menuItems.length > 0) return fallbackMenuDescription(vertical, menuItems);
  if (vertical === "p2p-trade") return "Sats for sale";
  return "";
}

function menuPartialMessage(vertical: Vertical): string {
  if (vertical === "p2p-trade") return "Complete option names and valid min/max sats before review.";
  if (vertical === "bill-pay") return "Complete bill names and sats before review.";
  if (vertical === "lending") return "Complete loan names and sats before review.";
  return "Complete item names and sats before review.";
}

function menuCountLabel(vertical: Vertical, count: number): string {
  const noun = vertical === "p2p-trade"
    ? "option"
    : vertical === "bill-pay"
      ? "bill"
      : vertical === "lending"
        ? "offer"
        : "item";
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function menuFiatFloor(items: MenuItem[]): { amount: number; currency: string } | null {
  const priced = items.filter((item) => item.fiatAmount !== undefined && item.fiatCurrency);
  if (priced.length === 0) return null;
  const currencies = new Set(priced.map((item) => item.fiatCurrency));
  if (currencies.size !== 1) return null;
  const amount = Math.min(...priced.map((item) => item.fiatAmount ?? Number.POSITIVE_INFINITY));
  const currency = priced[0]?.fiatCurrency;
  return Number.isFinite(amount) && currency ? { amount, currency } : null;
}

function estimatedMenuFiatFloor({
  menuItems,
  currency,
  usdPerBtc,
  usdFiatRates,
}: {
  menuItems: MenuItem[];
  currency: string;
  usdPerBtc: number | null;
  usdFiatRates: Record<string, number>;
}): { amount: number; currency: string } | null {
  if (menuItems.length === 0) return null;
  const floorMsats = Math.min(...menuItems.map(item => item.amountMsats));
  const amount = estimateFiatForMsats({
    amountMsats: floorMsats,
    currency,
    usdPerBtc,
    usdFiatRates,
  });
  return amount === null ? null : { amount, currency };
}

function formatMenuAmount(
  item: MenuItem,
  amountDisplayMode: AmountDisplayMode,
  estimate?: {
    currency: string;
    usdPerBtc: number | null;
    usdFiatRates: Record<string, number>;
  },
) {
  if (amountDisplayMode === "fiat" && item.fiatAmount !== undefined && item.fiatCurrency) {
    return <>{formatFiatAmount(item.fiatAmount, item.fiatCurrency)}</>;
  }
  if (amountDisplayMode === "fiat" && estimate) {
    if (item.minAmountMsats !== undefined && item.maxAmountMsats !== undefined) {
      const min = estimateFiatForMsats({
        amountMsats: item.minAmountMsats,
        currency: estimate.currency,
        usdPerBtc: estimate.usdPerBtc,
        usdFiatRates: estimate.usdFiatRates,
      });
      const max = estimateFiatForMsats({
        amountMsats: item.maxAmountMsats,
        currency: estimate.currency,
        usdPerBtc: estimate.usdPerBtc,
        usdFiatRates: estimate.usdFiatRates,
      });
      if (min !== null && max !== null) {
        const minLabel = formatFiatAmount(min, estimate.currency);
        const maxLabel = formatFiatAmount(max, estimate.currency);
        return <>{minLabel === maxLabel ? minLabel : `${minLabel}-${maxLabel.replace(`${estimate.currency} `, "")}`}</>;
      }
    }
    const amount = estimateFiatForMsats({
      amountMsats: item.amountMsats,
      currency: estimate.currency,
      usdPerBtc: estimate.usdPerBtc,
      usdFiatRates: estimate.usdFiatRates,
    });
    if (amount !== null) return <>{formatFiatAmount(amount, estimate.currency)}</>;
  }
  if (item.minAmountMsats !== undefined && item.maxAmountMsats !== undefined) {
    const min = fmtSats(item.minAmountMsats);
    const max = fmtSats(item.maxAmountMsats);
    return (
      <BitcoinAmount
        label={min === max ? min : `${min}-${max}`}
        size={12}
        gap={4}
        glyphScale={1.18}
      />
    );
  }
  return <BitcoinAmount msats={item.amountMsats} size={12} gap={4} glyphScale={1.18} />;
}

function supportsPremium(vertical: Vertical): boolean {
  return vertical === "p2p-trade" || vertical === "bill-pay" || vertical === "lending";
}

function premiumLabelForVertical(vertical: Vertical): string {
  if (vertical === "lending") return "PREMIUM APR (%)";
  if (vertical === "bill-pay") return "SERVICE PREMIUM (%)";
  return "PREMIUM (%)";
}

function premiumHintForVertical(vertical: Vertical, currency: string): string {
  if (vertical === "lending") return "Shown as APR on the loan request.";
  if (vertical === "bill-pay") return `Shown with the ${currency} bill price.`;
  return `Shown with the ${currency} exchange price.`;
}

function formatPremiumPercent(premiumBps: number): string {
  const pct = premiumBps / 100;
  return Math.abs(pct) < 10 && !Number.isInteger(pct)
    ? pct.toFixed(1)
    : pct.toFixed(Number.isInteger(pct) ? 0 : 2).replace(/\.?0+$/, "");
}

function premiumReviewLine(form: FormState, vertical: Vertical): string | null {
  if (!supportsPremium(vertical)) return null;
  const premiumBps = parsePremiumBps(form.premium);
  if (premiumBps === undefined) return null;
  const display = formatPremiumPercent(premiumBps);
  if (vertical === "lending") return `${display}% premium APR`;
  const signed = premiumBps > 0 ? `+${display}` : display;
  return `${signed}% premium`;
}

function parseFiatAmount(value: string): number | null {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function fiatInputValue(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return "";
  const maximumFractionDigits = amount >= 1000 ? 0 : amount >= 100 ? 1 : 2;
  return amount.toLocaleString("en-US", {
    useGrouping: false,
    maximumFractionDigits,
  });
}

function fiatInputForSats({
  satsValue,
  currency,
  usdPerBtc,
  usdFiatRates,
}: {
  satsValue: string;
  currency: string;
  usdPerBtc: number | null;
  usdFiatRates: Record<string, number>;
}): string | null {
  const trimmed = satsValue.trim();
  if (!trimmed) return "";
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) return null;
  const sats = parseWholeSats(trimmed);
  if (sats <= 0) return "";
  const amount = estimateFiatForMsats({
    amountMsats: sats * 1000,
    currency,
    usdPerBtc,
    usdFiatRates,
  });
  return amount === null ? null : fiatInputValue(amount);
}

function satsInputForFiat({
  fiatValue,
  currency,
  usdPerBtc,
  usdFiatRates,
}: {
  fiatValue: string;
  currency: string;
  usdPerBtc: number | null;
  usdFiatRates: Record<string, number>;
}): string | null {
  if (!fiatValue.trim()) return "";
  const fiatAmount = parseFiatAmount(fiatValue);
  if (fiatAmount === null) return null;
  if (fiatAmount <= 0) return "";
  const sats = estimateSatsForFiat({
    fiatAmount,
    currency,
    usdPerBtc,
    usdFiatRates,
  });
  return sats === null ? null : String(sats);
}

function premiumCheckoutLine(form: FormState, vertical: Vertical): string | null {
  if (vertical === "lending" || !supportsPremium(vertical)) return null;
  const premiumBps = parsePremiumBps(form.premium);
  const baseFiat = parseFiatAmount(form.fiat);
  if (premiumBps === undefined || baseFiat === null || baseFiat <= 0) return null;
  const checkoutFiat = baseFiat * (1 + premiumBps / 10_000);
  if (!Number.isFinite(checkoutFiat) || checkoutFiat < 0) return null;
  const signed = premiumBps > 0 ? `+${formatPremiumPercent(premiumBps)}%` : `${formatPremiumPercent(premiumBps)}%`;
  return `${formatFiatAmount(baseFiat, form.cur)} ${signed} = ${formatFiatAmount(checkoutFiat, form.cur)} at checkout`;
}

export function emptyCreateFormState(currency = "USD"): FormState {
  return {
    listingMode: "single",
    desc: "",
    sats: "",
    fiat: "",
    cur: currency,
    premium: "",
    fulfillment: "physical",
    isSubscription: false,
    periods: "3",
    intervalDays: "30",
    paymentMethods: [],
    menuItems: [],
  };
}

export function CreateForm({
  onCreate, onClose,
  arbiterWarning, onGoToArbiterTrade,
  canOfferSubscription, userPubkey, activeInvite,
  amountDisplayMode,
  communitySlug,
}: {
  onCreate: (params: any) => void;
  onClose: () => void;
  arbiterWarning: ArbiterWarning;
  onGoToArbiterTrade: (escrowId: string) => void;
  canOfferSubscription: boolean;
  userPubkey: string | null;
  activeInvite: string | null;
  amountDisplayMode: AmountDisplayMode;
  /** v2.1.1: the community the shell is currently presenting as the
   *  user's identity (the header/Browse pill). Create stamps THIS, so
   *  what the user sees is what they publish. Previously this read the
   *  persisted sign-in home directly, which only ConnectScreen ever
   *  writes — a user whose header said "South Africa · ZAR" could
   *  silently publish Tanzania·TZS listings with the Tanzania arbiter
   *  pool because their stored home was stale (the 06-05 field find).
   *  Optional: falls back to the stored home for any callsite that
   *  doesn't thread it. */
  communitySlug?: string | null;
}) {
  // Resolve community context for the listing. Read once at mount;
  // listing publishes into the community the user currently SEES as
  // theirs (Pillar 2.3 "current community" = the header identity, per
  // the v2.1.1 ruling), falling back to the persisted sign-in home.
  const community = (() => {
    if (communitySlug && getCommunityBySlug(communitySlug)) return communitySlug;
    const slug = getUserCommunitySlug();
    return getCommunityBySlug(slug) ? slug : DEFAULT_COMMUNITY_SLUG;
  })();
  const homeCommunity = getCommunityBySlug(community);
  const communityCurrency = defaultCurrencyForCommunity(community);
  // v2.2.0: the listing community now follows the header identity, but
  // the PERSISTED home (what boot-routing uses at sign-in) is only ever
  // written on the sign-in screen — so it can silently go stale (the
  // tz-tzs field find). Surface the mismatch right here and let one tap
  // make the displayed community the persisted home.
  const [persistedHome, setPersistedHome] = useState<string | null>(
    () => getUserCommunitySlugRaw(),
  );
  const isHomeCommunity = persistedHome === community;
  const setAsHome = () => {
    try { setUserCommunitySlug(community); } catch {}
    setPersistedHome(community);
  };
  const [step, setStep] = useState<Step>(1);
  const [vertical, setVertical] = useState<Vertical>("p2p-trade");
  const [form, setForm] = useState<FormState>(() =>
    emptyCreateFormState(communityCurrency),
  );
  const [submitting, setSubmitting] = useState(false);
  const [arbiterDismissed, setArbiterDismissed] = useState(false);
  const [drafts, setDrafts] = useState<SavedDraft[]>(() => readAllDrafts());
  const [showAllDrafts, setShowAllDrafts] = useState(false);
  // v3.1 stage 5: listing-mode setter lifted to the parent so the "every seller is
  // a Store" segmented toggle can live in Step 1 (under the category pick). Same
  // behaviour as before — a menu/store seeds a draft item + turns subscription off.
  const setListingMode = (listingMode: ListingMode) => {
    setForm(prev => {
      const nextItems = listingMode === "menu" && prev.menuItems.length === 0
        ? [newMenuDraftItem()]
        : prev.menuItems;
      return {
        ...prev,
        listingMode,
        isSubscription: listingMode === "menu" ? false : prev.isSubscription,
        menuItems: nextItems,
      };
    });
  };

  useEffect(() => {
    setForm(prev => prev.cur === communityCurrency ? prev : { ...prev, cur: communityCurrency });
  }, [communityCurrency]);

  // Auto-save draft on field change (silent, debounced via the form
  // state's natural batching). Cleared on successful publish.
  useEffect(() => {
    // Don't save empty drafts.
    if (!hasDraftContent(form)) return;
    writeDraft({ vertical, formState: form, savedAt: Date.now() });
    setDrafts(readAllDrafts());
  }, [form, vertical]);

  const continueDraft = (draft: SavedDraft) => {
    setVertical(draft.vertical);
    setForm(normalizeFormState(draft.formState, communityCurrency));
    setStep(2);
  };

  const handlePublish = async () => {
    const menuItems = normalizeMenuItems(form, vertical);
    const hasMenu = menuItems.length > 0;
    const description = buildListingDescription(form, vertical, menuItems);
    const baseSats = hasMenu ? minimumMenuSats(menuItems) : parseWholeSats(form.sats);
    const totalSats = effectiveListingSats(form, vertical);
    if (
      (!description && descriptionRequired(vertical, hasMenu)) ||
      (!hasMenu && !form.sats.trim()) ||
      hasPartialMenuRows(form, vertical) ||
      hasLendingAmountAboveCurrentCap(form, vertical)
    ) return;
    if (
      !isSimModeOn() &&
      !isTestnetMode() &&
      totalSats < MIN_REAL_ATOMIC_FUNDING_SATS
    ) return;
    setSubmitting(true);
    try {
      const amountMsats = baseSats * 1000;
      // #103: stamp the community LABEL honest with the fed this listing is
      // actually minted on. browseCommunity (the header pill) can drift from
      // the wallet's loaded fed during a foreign-listing visit; if it has,
      // re-resolve to the community backing the active fed so the Browse chip
      // and the off-route amber tint (which keys off the real fed) can never
      // disagree. No drift → browseCommunity is kept untouched.
      const effectiveCommunity =
        activeInvite && getCommunityBySlug(community)?.federationInvite !== activeInvite
          ? (communityForInvite(activeInvite)?.slug ?? community)
          : community;
      const mintUrl = resolveCreateMintUrl({ activeInvite, community: effectiveCommunity });
      const communityArbiters = getTrustedArbiterPool({
        community: effectiveCommunity,
        excludePubkeys: [userPubkey],
      });
      const params: any = {
        description,
        amountMsats: hasMenu
          ? amountMsats
          : form.isSubscription
            ? parseWholeSats(form.periods) * amountMsats
            : amountMsats,
        fiatAmount: !hasMenu && form.fiat ? parseFloat(form.fiat) : undefined,
        fiatCurrency: !hasMenu && form.fiat ? form.cur : undefined,
        // v1.2.2 premium-display fix: when the seller leaves the
        // premium field blank on an Exchange / bill-pay listing,
        // persist an explicit 0 so the listing reads "0% premium"
        // instead of falling through to listing-metrics' implied-spot
        // calculation (which displays a moving "-X% premium" anchored
        // off the listed fiat amount vs current BTC spot, and reads
        // like a seller-chosen discount). Lending verticals stay on
        // undefined because they encode APR via the menu's aprBps and
        // we don't want to override that with a flat zero.
        premiumBps: (() => {
          const parsed = parsePremiumBps(form.premium);
          if (parsed !== undefined) return parsed;
          if (vertical === "p2p-trade" || vertical === "bill-pay") return 0;
          return undefined;
        })(),
        category: vertical,
        community: effectiveCommunity,
        // v3.1 (B3): stamp the community's ISO country so the listing self-describes
        // its flag + currency on devices that don't know this (custom) community.
        country: getCommunityBySlug(effectiveCommunity)?.country ?? undefined,
        fulfillment: vertical === "marketplace" ? form.fulfillment : undefined,
        mintUrl,
        communityArbiters: communityArbiters.length > 0 ? communityArbiters : undefined,
        // Marketplace is sats-only — never carry payment rails on it.
        paymentMethods: categoryUsesPaymentRails(vertical) && form.paymentMethods.length > 0 ? form.paymentMethods : undefined,
        items: hasMenu ? menuItems : undefined,
        // #7 multi-unit storefront: only a single-product marketplace listing
        // carries stock. >=2 makes it a parent buyers purchase via child
        // escrows; 1 / blank stays a legacy single-unit listing (undefined).
        stock: (() => {
          if (vertical !== "marketplace" || hasMenu) return undefined;
          const n = parseOptionalPositiveInt(form.stock ?? "");
          return n !== undefined && n >= 2 ? n : undefined;
        })(),
      };
      if (!hasMenu && form.isSubscription) {
        params.subscription = {
          totalPeriods: parseWholeSats(form.periods),
          periodAmountMsats: amountMsats,
          periodDurationSeconds: parseWholeSats(form.intervalDays) * 86400,
        };
      }
      await onCreate(params);
      // Successful publish — clear this vertical's draft + mark
      // first-publish so the honesty card never re-shows.
      clearDraft(vertical);
      markFirstPublished(userPubkey);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  // ── Render: arbiter warning intercepts before the wizard renders ──
  if (arbiterWarning.kind !== "none" && !arbiterDismissed) {
    return (
      <ArbiterWarningCard
        warning={arbiterWarning}
        onContinue={() => setArbiterDismissed(true)}
        onCancel={onClose}
        onGoToArbiterTrade={onGoToArbiterTrade}
      />
    );
  }

  return (
    <div style={{ padding: 16, maxWidth: 480, margin: "0 auto" }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        marginBottom: 14,
      }}>
        <span style={{ fontSize: 18, fontWeight: 700, color: T.text, fontFamily: T.sans }}>
          New listing
        </span>
        <button onClick={onClose} style={{
          background: "none", border: "none", color: T.muted,
          fontSize: 20, cursor: "pointer",
        }}>×</button>
      </div>

      <StepProgress currentStep={step} />

      {step === 1 && (
        <Step1
          vertical={vertical}
          setVertical={setVertical}
          listingMode={form.listingMode}
          setListingMode={setListingMode}
          homeCommunity={homeCommunity}
          isHomeCommunity={isHomeCommunity}
          onSetHome={setAsHome}
          drafts={drafts}
          showAllDrafts={showAllDrafts}
          setShowAllDrafts={setShowAllDrafts}
          onContinueDraft={continueDraft}
          onNext={() => setStep(2)}
        />
      )}

      {step === 2 && (
        <Step2
          vertical={vertical}
          form={form}
          setForm={setForm}
          homeCommunity={homeCommunity}
          canOfferSubscription={canOfferSubscription}
          amountDisplayMode={amountDisplayMode}
          onBack={() => setStep(1)}
          onNext={() => setStep(3)}
        />
      )}

      {step === 3 && (
        <Step3
          vertical={vertical}
          form={form}
          setForm={setForm}
          homeCommunity={homeCommunity}
          firstPublishDone={hasFirstPublishedBefore(userPubkey)}
          submitting={submitting}
          amountDisplayMode={amountDisplayMode}
          onBack={() => setStep(2)}
          onPublish={handlePublish}
          onSaveDraft={() => {
            writeDraft({ vertical, formState: form, savedAt: Date.now() });
            setDrafts(readAllDrafts());
            onClose();
          }}
        />
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Step progress indicator
// ══════════════════════════════════════════════════════════════════════════

function StepProgress({ currentStep }: { currentStep: Step }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 6,
      marginBottom: 20,
    }}>
      {[1, 2, 3].map((n) => {
        const active = n === currentStep;
        const done = n < currentStep;
        return (
          <div key={n} style={{ display: "flex", alignItems: "center", flex: 1, gap: 6 }}>
            <div style={{
              width: 22, height: 22, borderRadius: "50%",
              background: active ? T.accent : done ? T.green : T.surface,
              border: `1px solid ${active ? T.accent : done ? T.green : T.border}`,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontFamily: T.mono, fontSize: 11, fontWeight: 700,
              color: active || done ? T.bg : T.muted,
              flexShrink: 0,
            }}>
              {done ? "✓" : n}
            </div>
            {n < 3 && (
              <div style={{
                flex: 1, height: 1,
                background: done ? T.green : T.border,
              }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Arbiter warning card (item 10)
// ══════════════════════════════════════════════════════════════════════════

function ArbiterWarningCard({
  warning,
  onContinue,
  onCancel,
  onGoToArbiterTrade,
}: {
  warning: ArbiterWarning;
  onContinue: () => void;
  onCancel: () => void;
  onGoToArbiterTrade: (escrowId: string) => void;
}) {
  if (warning.kind === "none") return null;
  const isHard = warning.kind === "hard";
  const counterpartyA = displayCounterpartyName({
    npub: warning.counterpartyA,
    fetchKind0Enabled: false,
    kind0Name: null,
  });
  const counterpartyB = displayCounterpartyName({
    npub: warning.counterpartyB,
    fetchKind0Enabled: false,
    kind0Name: null,
  });

  return (
    <div style={{ padding: 16, maxWidth: 480, margin: "0 auto" }}>
      <div style={{
        background: isHard ? T.redDim : T.amberDim,
        border: `1px solid ${isHard ? T.red + "66" : T.amber + "66"}`,
        borderRadius: T.r, padding: 20,
      }}>
        <div style={{ fontSize: 28, marginBottom: 8 }}>
          {isHard ? "⚠️" : "⚖️"}
        </div>
        <div style={{
          fontSize: 11, fontWeight: 700, color: isHard ? T.red : T.amber,
          fontFamily: T.mono, letterSpacing: 1.5, textTransform: "uppercase",
          marginBottom: 12,
        }}>
          {isHard ? "Arbitration vote pending" : "You're an arbiter"}
        </div>
        {isHard ? (
          <>
            <div style={{
              fontSize: 14, fontWeight: 700, color: T.text, fontFamily: T.sans,
              lineHeight: 1.4, marginBottom: 12,
            }}>
              A trade you're arbiting needs your vote.
            </div>
            {/* v0.3.0 Phase 6 (item 8): tightened from 4 sentences to
                3, dropping the "Your decision determines where their
                sats go" filler and shortening "splitting attention here
                can cost someone real money" → "could cost someone their
                sats". Same urgency, less verbiage. */}
            <div style={{
              fontSize: 13, color: T.text, fontFamily: T.sans,
              lineHeight: 1.55, marginBottom: 20,
            }}>
              <strong>{counterpartyA}</strong> and <strong>{counterpartyB}</strong>{" "}
              disagreed on their trade. Splitting your attention now could
              cost someone their sats. Resolve theirs first.
            </div>
          </>
        ) : (
          <>
            <div style={{
              fontSize: 14, fontWeight: 700, color: T.text, fontFamily: T.sans,
              lineHeight: 1.4, marginBottom: 12,
            }}>
              You're currently arbiter on an active trade.
            </div>
            <div style={{
              fontSize: 13, color: T.text, fontFamily: T.sans,
              lineHeight: 1.55, marginBottom: 20,
            }}>
              <strong>{counterpartyA}</strong> and <strong>{counterpartyB}</strong>{" "}
              haven't disputed and may never need you, but your attention could
              be needed quickly.
            </div>
          </>
        )}
        <div style={{ display: "flex", gap: 8, flexDirection: "column" }}>
          {isHard ? (
            <>
              <button
                onClick={() => onGoToArbiterTrade(warning.escrowId)}
                style={primaryButtonStyle(T.accent)}
              >
                Go to arbitration trade ›
              </button>
              <button
                onClick={onContinue}
                style={mutedSecondaryButtonStyle()}
              >
                Continue anyway
              </button>
            </>
          ) : (
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={onCancel} style={equalButtonStyle()}>
                Cancel
              </button>
              <button onClick={onContinue} style={equalButtonStyle()}>
                Continue anyway
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function primaryButtonStyle(color: string): React.CSSProperties {
  return {
    width: "100%", padding: "12px",
    background: color, border: "none", borderRadius: T.rs,
    color: T.bg, fontFamily: T.mono, fontSize: 13, fontWeight: 800,
    cursor: "pointer", letterSpacing: 0.3,
  };
}
function mutedSecondaryButtonStyle(): React.CSSProperties {
  return {
    width: "100%", padding: "12px",
    background: "transparent", border: `1px solid ${T.border}`, borderRadius: T.rs,
    color: T.muted, fontFamily: T.mono, fontSize: 12, fontWeight: 600,
    cursor: "pointer",
  };
}
function equalButtonStyle(): React.CSSProperties {
  return {
    flex: 1, padding: "12px",
    background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs,
    color: T.text, fontFamily: T.mono, fontSize: 12, fontWeight: 700,
    cursor: "pointer",
  };
}

// ══════════════════════════════════════════════════════════════════════════
// Step 1 — Category + community + drafts
// ══════════════════════════════════════════════════════════════════════════

function Step1({
  vertical, setVertical,
  listingMode, setListingMode,
  homeCommunity,
  isHomeCommunity,
  onSetHome,
  drafts, showAllDrafts, setShowAllDrafts,
  onContinueDraft,
  onNext,
}: {
  vertical: Vertical;
  setVertical: (v: Vertical) => void;
  listingMode: ListingMode;
  setListingMode: (m: ListingMode) => void;
  homeCommunity: ReturnType<typeof getCommunityBySlug>;
  /** v2.2.0: whether the listing community matches the PERSISTED home
   *  (the sign-in boot-routing anchor). When false, the caption becomes
   *  a one-tap "Set as home" affordance — fixing a stale home at the
   *  exact moment the user can see the mismatch. */
  isHomeCommunity: boolean;
  onSetHome: () => void;
  drafts: SavedDraft[];
  showAllDrafts: boolean;
  setShowAllDrafts: (b: boolean) => void;
  onContinueDraft: (d: SavedDraft) => void;
  onNext: () => void;
}) {
  const visibleDrafts = showAllDrafts ? drafts : drafts.slice(0, 3);
  const hiddenDraftCount = Math.max(0, drafts.length - 3);
  // CBP's "Monthly bills" multi-mode is parked (coming soon) — never leave the
  // form in menu mode for bill-pay (e.g. after switching verticals from a Store).
  useEffect(() => {
    if (vertical === "bill-pay" && listingMode === "menu") setListingMode("single");
  }, [vertical, listingMode]);

  return (
    <>
      {/* Save-draft cards (visible when any drafts exist) */}
      {drafts.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{
            fontSize: 11, color: T.muted, fontFamily: T.mono,
            letterSpacing: 1, marginBottom: 8,
          }}>
            CONTINUE A DRAFT
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {visibleDrafts.map(d => {
              const v = VERTICALS.find(vert => vert.id === d.vertical)!;
              const ageMs = Date.now() - d.savedAt;
              const ageMin = Math.floor(ageMs / 60_000);
              const ageStr = ageMin < 1 ? "just now"
                : ageMin < 60 ? `${ageMin}m ago`
                : ageMin < 1440 ? `${Math.floor(ageMin / 60)}h ago`
                : `${Math.floor(ageMin / 1440)}d ago`;
              return (
                <button
                  key={d.vertical}
                  onClick={() => onContinueDraft(d)}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    width: "100%", padding: "10px 12px",
                    background: T.surface, border: `1px solid ${T.border}`,
                    borderRadius: T.rs, cursor: "pointer",
                    textAlign: "left" as const,
                    color: T.text, fontFamily: T.sans,
                  }}
                >
                  <span style={{ fontSize: 18 }}>{v.icon}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      Continue your last {v.label} listing
                    </div>
                    <div style={{
                      fontSize: 10, color: T.muted, fontFamily: T.mono,
                      marginTop: 2,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const,
                    }}>
                      {d.formState.desc || "(no description yet)"} · {ageStr}
                    </div>
                  </div>
                  <span style={{ color: T.muted, fontSize: 16 }}>›</span>
                </button>
              );
            })}
            {!showAllDrafts && hiddenDraftCount > 0 && (
              <button
                onClick={() => setShowAllDrafts(true)}
                style={{
                  background: "none", border: "none",
                  color: T.muted, fontFamily: T.mono, fontSize: 11,
                  cursor: "pointer", padding: "8px",
                }}
              >
                ▼ Show {hiddenDraftCount} more draft{hiddenDraftCount !== 1 ? "s" : ""}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Category cards */}
      <div style={{
        fontSize: 11, color: T.muted, fontFamily: T.mono,
        letterSpacing: 1, marginBottom: 8,
      }}>
        WHAT KIND OF TRADE?
      </div>
      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10,
        marginBottom: 20,
      }}>
        {VERTICALS.map(v => {
          const active = vertical === v.id;
          return (
            <button
              key={v.id}
              onClick={() => setVertical(v.id)}
              style={{
                display: "flex", flexDirection: "column", alignItems: "flex-start",
                gap: 6, padding: "16px 14px",
                background: active ? T.accentDim : T.surface,
                border: `1px solid ${active ? T.accent + "66" : T.border}`,
                borderRadius: T.r, cursor: "pointer",
                textAlign: "left" as const, transition: "all 0.15s",
              }}
            >
              <span style={{ fontSize: 22 }}>{v.icon}</span>
              <span style={{
                fontSize: 13, fontWeight: 700, color: active ? T.accent : T.text,
                fontFamily: T.sans,
              }}>
                {v.label}
              </span>
              <span style={{
                fontSize: 10, color: T.muted, fontFamily: T.sans,
                lineHeight: 1.4,
              }}>
                {v.description}
              </span>
            </button>
          );
        })}
      </div>

      {/* Stage 5 — "every seller is a Store": one light sub-step under the type
          pick. A sliding segmented control between a single listing and the
          vertical's multi/store mode, driving the same listingMode state. */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 8 }}>
          LISTING STYLE
        </div>
        <div style={{
          position: "relative", display: "grid", gridTemplateColumns: "1fr 1fr",
          background: T.surface, border: `1px solid ${T.border}`,
          borderRadius: 999, padding: 4,
        }}>
          <div aria-hidden="true" style={{
            position: "absolute", top: 4, bottom: 4, left: 4,
            width: "calc(50% - 4px)", borderRadius: 999,
            background: T.accentDim, border: `1px solid ${T.accent}66`,
            transform: (listingMode === "menu" && vertical !== "bill-pay") ? "translateX(100%)" : "translateX(0)",
            transition: "transform .22s cubic-bezier(.4,0,.2,1)",
          }} />
          {([["single", singleModeLabel(vertical)], ["menu", menuModeLabel(vertical)]] as [ListingMode, string][]).map(([mode, label]) => {
            const disabled = mode === "menu" && vertical === "bill-pay";
            const active = listingMode === mode && !disabled;
            return (
              <button
                key={mode}
                type="button"
                disabled={disabled}
                onClick={() => { if (!disabled) setListingMode(mode); }}
                style={{
                  position: "relative", zIndex: 1,
                  background: "transparent", border: "none",
                  padding: "9px 10px", borderRadius: 999,
                  cursor: disabled ? "not-allowed" : "pointer",
                  fontFamily: T.mono, fontSize: 12, fontWeight: 800,
                  color: disabled ? T.muted : active ? T.accent : T.muted,
                  transition: "color .2s",
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                }}
              >
                {label}
                {disabled && (
                  <span style={{
                    fontSize: 8, fontWeight: 800, letterSpacing: 0.5,
                    color: T.amber, background: `${T.amber}22`,
                    padding: "1px 5px", borderRadius: 999,
                  }}>SOON</span>
                )}
              </button>
            );
          })}
        </div>
        <div style={{ fontSize: 10.5, color: T.muted, fontFamily: T.sans, lineHeight: 1.4, marginTop: 7 }}>
          {listingMode === "menu" && vertical !== "bill-pay"
            ? menuModeDescription(vertical)
            : singleModeDescription(vertical)}
        </div>
      </div>

      {/* Community context. v2.2.0: the line reflects the header
          identity (what you see is what you publish). When that differs
          from the persisted home — the sign-in boot-routing anchor that
          only the sign-in screen used to be able to change — the caption
          becomes a one-tap "Set as home" so a stale home is fixable at
          the exact moment the mismatch is visible. */}
      <div style={{
        padding: "10px 12px", marginBottom: 24,
        background: T.surface, border: `1px solid ${T.border}`,
        borderRadius: T.rs,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 18, lineHeight: 1 }}>
            {homeCommunity?.flagEmoji ?? "🌐"}
          </span>
          <span style={{ flex: 1, fontSize: 12, color: T.text, fontFamily: T.sans }}>
            Listing in <strong>{homeCommunity?.displayName ?? "your community"}</strong>
          </span>
          {isHomeCommunity ? (
            <span style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, letterSpacing: 0.5 }}>
              YOUR COMMUNITY
            </span>
          ) : (
            <button
              onClick={onSetHome}
              style={{
                background: T.accentDim, border: `1px solid ${T.accent}66`,
                borderRadius: T.rs, padding: "4px 8px", cursor: "pointer",
                color: T.accent, fontFamily: T.mono, fontSize: 10,
                fontWeight: 800, letterSpacing: 0.5, flexShrink: 0,
              }}
            >
              SET AS HOME →
            </button>
          )}
        </div>
        {!isHomeCommunity && (
          <div style={{
            marginTop: 6, fontSize: 10, color: T.muted,
            fontFamily: T.sans, lineHeight: 1.4,
          }}>
            Home decides where Chama signs you in. One tap makes{" "}
            {homeCommunity?.displayName ?? "this community"} your home.
          </div>
        )}
      </div>

      <button onClick={onNext} style={{
        width: "100%", padding: "14px",
        background: T.accent, border: "none", borderRadius: T.rs,
        color: T.bg, fontFamily: T.mono, fontSize: 14, fontWeight: 800,
        cursor: "pointer", letterSpacing: 0.5,
      }}>
        Next ›
      </button>
    </>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Step 2 — Vertical-specific form
// ══════════════════════════════════════════════════════════════════════════

function Step2({
  vertical, form, setForm,
  homeCommunity,
  canOfferSubscription,
  amountDisplayMode,
  onBack, onNext,
}: {
  vertical: Vertical;
  form: FormState;
  setForm: (updater: (f: FormState) => FormState) => void;
  homeCommunity: ReturnType<typeof getCommunityBySlug>;
  canOfferSubscription: boolean;
  amountDisplayMode: AmountDisplayMode;
  onBack: () => void;
  onNext: () => void;
}) {
  const btcPrice = useBitcoinPrice();
  const fiatRates = useFiatRates();
  // v2.5: inline photo-upload error. window.alert is a silent no-op in the
  // Tauri/Capacitor webview, so a rejected image used to fail invisibly.
  const [imageError, setImageError] = useState<string | null>(null);
  const menuItems = normalizeMenuItems(form, vertical);
  const hasMenu = menuItems.length > 0;
  const usingMenu = form.listingMode === "menu";
  const partialMenuRows = hasPartialMenuRows(form, vertical);
  const totalSats = effectiveListingSats(form, vertical);
  const amountTooSmall =
    !isSimModeOn() &&
    !isTestnetMode() &&
    totalSats > 0 &&
    totalSats < MIN_REAL_ATOMIC_FUNDING_SATS;
  const lendingCapExceeded = hasLendingAmountAboveCurrentCap(form, vertical);
  const showSubscriptionMode = false && canOfferSubscription;
  const descriptionOk = !descriptionRequired(vertical, usingMenu) || form.desc.trim().length > 0 || hasMenu;
  const ready =
    descriptionOk &&
    (usingMenu ? hasMenu : form.sats.trim().length > 0) &&
    !partialMenuRows &&
    !amountTooSmall &&
    !lendingCapExceeded;
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm(prev => ({ ...prev, [key]: value }));
  const syncSingleSats = (value: string) => {
    setForm(prev => {
      const next: FormState = { ...prev, sats: value };
      if (vertical !== "lending") {
        const fiat = fiatInputForSats({
          satsValue: value,
          currency: prev.cur,
          usdPerBtc: btcPrice.usd,
          usdFiatRates: fiatRates.rates,
        });
        if (fiat !== null) next.fiat = fiat;
      }
      return next;
    });
  };
  const syncSingleFiat = (value: string) => {
    setForm(prev => {
      const next: FormState = { ...prev, fiat: value };
      const sats = satsInputForFiat({
        fiatValue: value,
        currency: prev.cur,
        usdPerBtc: btcPrice.usd,
        usdFiatRates: fiatRates.rates,
      });
      if (sats !== null) next.sats = sats;
      return next;
    });
  };
  const updateMenuSats = (id: string, value: string) => {
    setForm(prev => ({
      ...prev,
      isSubscription: false,
      menuItems: prev.menuItems.map(item => {
        if (item.id !== id) return item;
        const patch: Partial<MenuDraftItem> = { sats: value };
        if (vertical !== "lending") {
          const fiat = fiatInputForSats({
            satsValue: value,
            currency: prev.cur,
            usdPerBtc: btcPrice.usd,
            usdFiatRates: fiatRates.rates,
          });
          if (fiat !== null) patch.fiat = fiat;
        }
        return { ...item, ...patch };
      }),
    }));
  };
  const updateMenuFiat = (id: string, value: string) => {
    setForm(prev => ({
      ...prev,
      isSubscription: false,
      menuItems: prev.menuItems.map(item => {
        if (item.id !== id) return item;
        const sats = satsInputForFiat({
          fiatValue: value,
          currency: prev.cur,
          usdPerBtc: btcPrice.usd,
          usdFiatRates: fiatRates.rates,
        });
        return {
          ...item,
          fiat: value,
          ...(sats !== null ? { sats } : {}),
        };
      }),
    }));
  };
  useEffect(() => {
    if (vertical === "lending" || !form.sats.trim() || form.fiat.trim()) return;
    const fiat = fiatInputForSats({
      satsValue: form.sats,
      currency: form.cur,
      usdPerBtc: btcPrice.usd,
      usdFiatRates: fiatRates.rates,
    });
    if (!fiat) return;
    setForm(prev => prev.fiat.trim() ? prev : { ...prev, fiat });
  }, [vertical, form.sats, form.fiat, form.cur, btcPrice.usd, fiatRates.rates, setForm]);

  useEffect(() => {
    if (vertical === "lending" || form.menuItems.length === 0) return;
    setForm(prev => {
      let changed = false;
      const menuItems = prev.menuItems.map(item => {
        if (!item.sats.trim() || item.fiat.trim()) return item;
        const fiat = fiatInputForSats({
          satsValue: item.sats,
          currency: prev.cur,
          usdPerBtc: btcPrice.usd,
          usdFiatRates: fiatRates.rates,
        });
        if (!fiat) return item;
        changed = true;
        return { ...item, fiat };
      });
      return changed ? { ...prev, menuItems } : prev;
    });
  }, [vertical, form.menuItems, btcPrice.usd, fiatRates.rates, setForm]);
  const paymentMethodOptions = railsForCommunity(homeCommunity?.slug);
  const togglePaymentMethod = (method: string) => {
    setForm(prev => {
      const exists = prev.paymentMethods.some(value => value.toLowerCase() === method.toLowerCase());
      return {
        ...prev,
        paymentMethods: exists
          ? prev.paymentMethods.filter(value => value.toLowerCase() !== method.toLowerCase())
          : [...prev.paymentMethods, method],
      };
    });
  };
  // setListingMode lifted to the parent CreateForm (v3.1 stage 5 — the listing-style
  // toggle moved to Step 1, under the category pick).
  const menuTitle = menuTitleForVertical(vertical);
  const menuHint = menuHintForVertical(vertical);
  const fiatPrimary = amountDisplayMode === "fiat" && vertical !== "lending";
  const menuFiatFloorValue = amountDisplayMode === "fiat" ? menuFiatFloor(menuItems) : null;
  const menuDisplayFiatFloorValue = amountDisplayMode === "fiat"
    ? menuFiatFloorValue ?? estimatedMenuFiatFloor({
        menuItems,
        currency: form.cur,
        usdPerBtc: btcPrice.usd,
        usdFiatRates: fiatRates.rates,
      })
    : null;
  const premiumCheckout = premiumCheckoutLine(form, vertical);
  const addMenuItem = () => {
    setForm(prev => ({
      ...prev,
      listingMode: "menu",
      isSubscription: false,
      menuItems: prev.menuItems.length >= MAX_MENU_ITEMS
        ? prev.menuItems
        : [...prev.menuItems, newMenuDraftItem()],
    }));
  };
  const updateMenuItem = (id: string, patch: Partial<MenuDraftItem>) => {
    setForm(prev => ({
      ...prev,
      isSubscription: patch.sats || patch.label ? false : prev.isSubscription,
      menuItems: prev.menuItems.map(item => item.id === id ? { ...item, ...patch } : item),
    }));
  };
  const removeMenuItem = (id: string) => {
    setForm(prev => ({
      ...prev,
      menuItems: prev.menuItems.filter(item => item.id !== id),
    }));
  };
  const updateMenuImage = (id: string, file: File | null) => {
    if (!file) {
      updateMenuItem(id, { imageDataUrl: "" });
      return;
    }
    void (async () => {
      try {
        const imageDataUrl = await prepareMenuImageDataUrl(file);
        setImageError(null);
        updateMenuItem(id, { imageDataUrl });
      } catch (e: any) {
        setImageError(e?.message || "That file doesn't look like a supported photo, or it's too large for this release. Try JPG, PNG, or WebP.");
      }
    })();
  };

  const clearMenuImage = (id: string) => {
    setImageError(null);
    updateMenuItem(id, { imageDataUrl: "" });
  };

  return (
    <>
      {imageError && (
        <div
          onClick={() => setImageError(null)}
          style={{
            marginBottom: 16, padding: "10px 12px", borderRadius: T.rs,
            background: T.redDim, border: `1px solid ${T.red}55`,
            color: T.red, fontFamily: T.mono, fontSize: 11, lineHeight: 1.5,
            cursor: "pointer",
          }}
        >
          ⚠ {imageError} <span style={{ color: T.muted }}>(tap to dismiss)</span>
        </div>
      )}
      {/* LISTING STYLE toggle relocated to Step 1 (v3.1 "every seller is a Store"). */}

      {categoryAllowsFulfillmentChoice(vertical) && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>FULFILLMENT</div>
          <select value={form.fulfillment} onChange={e => set("fulfillment", e.target.value as Fulfillment)}
            style={{ ...inputStyle, color: T.text, background: T.surface }}>
            <option value="physical">Physical</option>
            <option value="service">Service</option>
            <option value="digital">Digital</option>
          </select>
        </div>
      )}

      {/* #7 multi-unit storefront: single-product marketplace listings can carry
          a stock count. 2+ makes it a parent buyers purchase via child escrows. */}
      {vertical === "marketplace" && !usingMenu && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>UNITS IN STOCK</div>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            value={form.stock ?? ""}
            onChange={e => set("stock", e.target.value)}
            placeholder="1"
            style={{ ...inputStyle, color: T.text, background: T.surface }}
          />
          <div style={{ fontSize: 10, color: T.muted, fontFamily: T.sans, marginTop: 5, lineHeight: 1.4 }}>
            Leave blank or 1 for a single item. Set 2+ to sell multiple units — each buyer gets their own escrow, and Browse shows “N left.”
          </div>
        </div>
      )}

      {descriptionRequired(vertical, usingMenu) && (
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>
          {descriptionLabel(vertical, usingMenu)}
        </div>
        <input value={form.desc} onChange={e => set("desc", e.target.value)}
          placeholder={descriptionPlaceholder(vertical, usingMenu)}
          style={inputStyle} />
      </div>
      )}

      {!usingMenu ? (
        <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
          {!fiatPrimary && (
          <div style={{ flex: vertical === "lending" ? 1.15 : 1 }}>
            <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>
              {vertical === "lending" ? "LOAN PRINCIPAL (SATS)" : "AMOUNT (SATS)"}
            </div>
            <input
              type="number"
              value={form.sats}
              onChange={e => syncSingleSats(e.target.value)}
              onWheel={blurNumberInputOnWheel}
              placeholder="100000"
              style={inputStyle}
            />
          </div>
          )}
          {fiatPrimary && (
          <div style={{ flex: 1.15 }}>
            <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>{form.cur} PRICE</div>
            <div style={{ display: "flex", gap: 6 }}>
              <div style={{
                width: 72,
                padding: "12px 6px",
                borderRadius: T.rs,
                border: `1px solid ${T.border}`,
                background: T.surface,
                color: T.text,
                fontFamily: T.mono,
                fontSize: 12,
                fontWeight: 900,
                textAlign: "center",
              }}>
                {form.cur}
              </div>
              <input type="number" value={form.fiat} onChange={e => syncSingleFiat(e.target.value)} placeholder="50" style={{ ...inputStyle, flex: 1 }} />
            </div>
            <div style={{ marginTop: 5, fontSize: 9, color: T.muted, fontFamily: T.mono }}>
              local price · escrow still settles in sats
            </div>
          </div>
          )}
          {fiatPrimary && (
          <div style={{ flex: 0.85 }}>
            <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>
              AMOUNT (SATS)
            </div>
            <input
              type="number"
              value={form.sats}
              onChange={e => syncSingleSats(e.target.value)}
              onWheel={blurNumberInputOnWheel}
              placeholder="100000"
              style={inputStyle}
            />
          </div>
          )}
          {vertical === "lending" ? (
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>BORROWER TIER</div>
              <div style={{
                minHeight: 44,
                padding: "10px 12px",
                borderRadius: T.rs,
                border: `1px solid ${lendingCapExceeded ? T.red + "66" : T.border}`,
                background: lendingCapExceeded ? T.redDim : T.surface,
                color: lendingCapExceeded ? T.red : T.text,
                fontFamily: T.mono,
                fontSize: 11,
                lineHeight: 1.35,
                display: "flex",
                alignItems: "center",
              }}>
                {lendingTierSummary(form.sats)}
              </div>
            </div>
          ) : !fiatPrimary && (
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>FIAT</div>
            <div style={{ display: "flex", gap: 6 }}>
              <div style={{
                width: 72,
                padding: "12px 6px",
                borderRadius: T.rs,
                border: `1px solid ${T.border}`,
                background: T.surface,
                color: T.text,
                fontFamily: T.mono,
                fontSize: 12,
                fontWeight: 900,
                textAlign: "center",
              }}>
                {form.cur}
              </div>
              <input type="number" value={form.fiat} onChange={e => syncSingleFiat(e.target.value)} placeholder="50" style={{ ...inputStyle, flex: 1 }} />
            </div>
            <div style={{ marginTop: 5, fontSize: 9, color: T.muted, fontFamily: T.mono }}>
              auto from {homeCommunity?.flagEmoji ?? "🌐"} Chama
            </div>
          </div>
          )}
        </div>
      ) : (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>
            MENU CURRENCY
          </div>
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: 10,
            borderRadius: T.rs,
            border: `1px solid ${T.border}`,
            background: T.surface,
          }}>
            <div style={{
              padding: "10px 12px",
              borderRadius: T.rs,
              border: `1px solid ${T.border}`,
              background: T.card,
              color: T.text,
              fontFamily: T.mono,
              fontSize: 12,
              fontWeight: 900,
            }}>
              {form.cur}
            </div>
            <div style={{ color: T.muted, fontFamily: T.mono, fontSize: 10, lineHeight: 1.45 }}>
              {menuCurrencyHint(vertical, form.cur)}
              {" "}Auto from {homeCommunity?.flagEmoji ?? "🌐"} Chama.
            </div>
          </div>
        </div>
      )}

      {supportsPremium(vertical) && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>
            {premiumLabelForVertical(vertical)}
          </div>
          <div style={{
            display: "grid",
            gridTemplateColumns: "minmax(112px, 0.45fr) 1fr",
            gap: 8,
            alignItems: "stretch",
          }}>
            <input
              type="number"
              value={form.premium}
              onChange={e => set("premium", e.target.value)}
              onWheel={blurNumberInputOnWheel}
              placeholder={vertical === "lending" ? "12" : "2.5"}
              style={inputStyle}
            />
            <div style={{
              minHeight: 44,
              padding: "9px 10px",
              borderRadius: T.rs,
              border: `1px solid ${T.border}`,
              background: T.surface,
              color: premiumCheckout ? T.accent : T.muted,
              fontFamily: T.mono,
              fontSize: 10,
              lineHeight: 1.35,
              display: "flex",
              alignItems: "center",
            }}>
              {premiumCheckout ?? premiumHintForVertical(vertical, form.cur)}
            </div>
          </div>
        </div>
      )}

      {categoryUsesPaymentRails(vertical) && paymentMethodOptions.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>
            ACCEPTED PAYMENT
          </div>
          <div className="payment-rail-scroll" style={{
            display: "flex",
            padding: 10,
            borderRadius: T.rs,
            background: T.surface,
            border: `1px solid ${T.border}`,
            overflowX: "auto",
            overflowY: "hidden",
            WebkitOverflowScrolling: "touch",
            scrollbarWidth: "none",
          }}>
            <div style={{
              display: "flex",
              gap: 7,
              minWidth: "100%",
              width: "max-content",
            }}>
              {paymentMethodOptions.map(rail => {
                const selected = form.paymentMethods.some(method =>
                  method.toLowerCase() === rail.displayName.toLowerCase()
                );
                return (
                  <button
                    key={rail.key}
                    type="button"
                    onClick={() => togglePaymentMethod(rail.displayName)}
                    style={{
                      padding: "6px 9px",
                      borderRadius: 999,
                      border: `1px solid ${selected ? T.accent + "77" : T.border}`,
                      background: selected ? T.accentDim : T.card,
                      color: selected ? T.accent : T.muted,
                      fontFamily: T.mono,
                      fontSize: 10,
                      fontWeight: 800,
                      cursor: "pointer",
                      flex: "0 0 auto",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {selected ? "✓ " : ""}{rail.displayName}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
      {amountTooSmall && (
        <div style={{
          marginTop: -8, marginBottom: 16, padding: "8px 10px",
          borderRadius: T.rs, background: T.amberDim,
          border: `1px solid ${T.amber}44`,
          color: T.amber, fontFamily: T.mono, fontSize: 10, lineHeight: 1.45,
        }}>
          {minimumAtomicFundingMessage()}
        </div>
      )}
      {lendingCapExceeded && (
        <div style={{
          marginTop: -8, marginBottom: 16, padding: "8px 10px",
          borderRadius: T.rs, background: T.redDim,
          border: `1px solid ${T.red}44`,
          color: T.red, fontFamily: T.mono, fontSize: 10, lineHeight: 1.45,
        }}>
          Fedimint lending tiers currently top out at{" "}
          <BitcoinAmount
            sats={MAX_FEDIMINT_LENDING_SATS}
            size={10}
            gap={3}
            glyphScale={1.2}
            color="inherit"
            glyphColor="inherit"
          />.
          Higher on-chain tiers come later.
        </div>
      )}
      {usingMenu && (
      <div style={{
        marginBottom: 20,
        padding: 14,
        background: usingMenu
          ? `linear-gradient(180deg, ${T.accentDim}, ${T.card} 62%)`
          : T.card,
        border: `1px solid ${usingMenu ? T.accent + "88" : T.border}`,
        borderRadius: T.r,
        boxShadow: usingMenu ? `0 0 0 1px ${T.accent}11, 0 18px 44px ${T.accent}12` : "none",
      }}>
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          marginBottom: form.menuItems.length > 0 ? 12 : 0,
        }}>
          <div>
            <div style={{
              fontSize: 11,
              color: usingMenu ? T.accent : T.muted,
              fontFamily: T.mono,
              fontWeight: 900,
              letterSpacing: 1,
            }}>
              {menuTitle}
            </div>
            <div style={{ marginTop: 3, fontSize: 10, color: T.muted, fontFamily: T.mono, lineHeight: 1.45 }}>
              {menuHint}
            </div>
            {hasMenu && (
              <div style={{
                marginTop: 3,
                fontSize: 10,
                color: T.muted,
                fontFamily: T.mono,
                display: "inline-flex",
                alignItems: "baseline",
                gap: 4,
              }}>
                from {menuDisplayFiatFloorValue
                  ? formatFiatAmount(menuDisplayFiatFloorValue.amount, menuDisplayFiatFloorValue.currency)
                  : <BitcoinAmount msats={Math.min(...menuItems.map(item => item.amountMsats))} size={10} gap={3} glyphScale={1.2} color={T.muted} glyphColor={T.muted} />}
              </div>
            )}
          </div>
          <button
            onClick={addMenuItem}
            disabled={form.menuItems.length >= MAX_MENU_ITEMS}
            style={{
              padding: "8px 10px",
              borderRadius: T.rs,
              border: `1px solid ${T.border}`,
              background: T.surface,
              color: form.menuItems.length >= MAX_MENU_ITEMS ? T.muted : T.accent,
              fontFamily: T.mono,
              fontSize: 11,
              fontWeight: 800,
              cursor: form.menuItems.length >= MAX_MENU_ITEMS ? "default" : "pointer",
            }}
          >
            {menuAddLabelForVertical(vertical)}
          </button>
        </div>
        {form.menuItems.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {form.menuItems.map((item, index) => (
              <div key={item.id} style={{
                padding: 12,
                borderRadius: T.rs,
                border: `1px solid ${usingMenu ? T.accent + "33" : T.border}`,
                background: usingMenu ? T.bg : T.surface,
              }}>
                <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                  <input
                    value={item.label}
                    onChange={e => updateMenuItem(item.id, { label: e.target.value })}
                    placeholder={menuPlaceholderForVertical(vertical, index)}
                    style={{ ...inputStyle, flex: 1, minWidth: 0 }}
                  />
                  <input
                    type="number"
                    value={item.sats}
                    onChange={e => updateMenuSats(item.id, e.target.value)}
                    onWheel={blurNumberInputOnWheel}
                    placeholder={vertical === "p2p-trade" ? "min sats" : vertical === "lending" ? "principal" : "sats"}
                    style={{ ...inputStyle, width: 92 }}
                  />
                  {vertical === "p2p-trade" && (
                    <input
                      type="number"
                      value={item.maxSats}
                      onChange={e => updateMenuItem(item.id, { maxSats: e.target.value })}
                      onWheel={blurNumberInputOnWheel}
                      placeholder="max"
                      style={{ ...inputStyle, width: 92 }}
                    />
                  )}
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <input
                    value={item.description}
                    onChange={e => updateMenuItem(item.id, { description: e.target.value })}
                    placeholder="Note"
                    style={{ ...inputStyle, flex: "1 1 140px", minWidth: 0, fontSize: 12 }}
                  />
                  {vertical !== "lending" && (
                    <input
                      type="number"
                      value={item.fiat}
                      onChange={e => updateMenuFiat(item.id, e.target.value)}
                      onWheel={blurNumberInputOnWheel}
                      placeholder={form.cur}
                      style={{ ...inputStyle, width: 84, fontSize: 12 }}
                    />
                  )}
                  {vertical === "bill-pay" && (
                    <input
                      type="date"
                      value={item.dueDate}
                      onChange={e => updateMenuItem(item.id, { dueDate: e.target.value })}
                      style={{ ...inputStyle, width: 128, fontSize: 11 }}
                    />
                  )}
                  {vertical === "lending" && (
                    <>
                      <input
                        type="number"
                        value={item.termDays}
                        onChange={e => updateMenuItem(item.id, { termDays: e.target.value })}
                        onWheel={blurNumberInputOnWheel}
                        placeholder="days"
                        style={{ ...inputStyle, width: 72, fontSize: 12 }}
                      />
                      <input
                        type="number"
                        value={item.apr}
                        onChange={e => updateMenuItem(item.id, { apr: e.target.value })}
                        onWheel={blurNumberInputOnWheel}
                        placeholder="APR"
                        style={{ ...inputStyle, width: 72, fontSize: 12 }}
                      />
                      <div style={{
                        minWidth: 110,
                        padding: "11px 10px",
                        borderRadius: T.rs,
                        border: `1px solid ${lendingAmountAboveCurrentCap(item.sats) ? T.red + "66" : T.border}`,
                        background: lendingAmountAboveCurrentCap(item.sats) ? T.redDim : T.card,
                        color: lendingAmountAboveCurrentCap(item.sats) ? T.red : T.accent,
                        fontFamily: T.mono,
                        fontSize: 10,
                        fontWeight: 800,
                        lineHeight: 1.35,
                      }}>
                        {lendingTierSummary(item.sats)}
                      </div>
                    </>
                  )}
                  {vertical === "marketplace" && (
                    <select
                      value={item.fulfillment}
                      onChange={e => updateMenuItem(item.id, { fulfillment: e.target.value as Fulfillment })}
                      style={{ ...inputStyle, width: 108, padding: "12px 6px", fontSize: 11, color: T.text, background: T.card }}
                    >
                      <option value="physical">Physical</option>
                      <option value="service">Service</option>
                      <option value="digital">Digital</option>
                    </select>
                  )}
                  <button
                    onClick={() => removeMenuItem(item.id)}
                    style={{
                      width: 42,
                      borderRadius: T.rs,
                      border: `1px solid ${T.border}`,
                      background: T.card,
                      color: T.muted,
                      fontFamily: T.mono,
                      fontSize: 14,
                      fontWeight: 800,
                      cursor: "pointer",
                    }}
                  >
                    ×
                  </button>
                </div>
                {vertical === "marketplace" && (
                  <div style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginTop: 8,
                  }}>
                    <label style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      padding: "9px 10px",
                      borderRadius: T.rs,
                      border: `1px solid ${T.border}`,
                      background: T.card,
                      color: item.imageDataUrl ? T.accent : T.muted,
                      fontFamily: T.mono,
                      fontSize: 10,
                      fontWeight: 800,
                      cursor: "pointer",
                    }}>
                      {item.imageDataUrl ? "Change photo" : "+ Photo"}
                      <input
                        type="file"
                        accept={MENU_IMAGE_ACCEPT}
                        onChange={e => {
                          updateMenuImage(item.id, e.target.files?.[0] ?? null);
                          e.currentTarget.value = "";
                        }}
                        style={{ display: "none" }}
                      />
                    </label>
                    {item.imageDataUrl && (
                      <>
                        <img
                          src={item.imageDataUrl}
                          alt=""
                          style={{
                            width: 54,
                            height: 42,
                            objectFit: "cover",
                            borderRadius: 8,
                            border: `1px solid ${T.border}`,
                          }}
                        />
                        <button
                          onClick={() => clearMenuImage(item.id)}
                          style={{
                            border: "none",
                            background: "none",
                            color: T.muted,
                            fontFamily: T.mono,
                            fontSize: 10,
                            fontWeight: 800,
                            cursor: "pointer",
                          }}
                        >
                          remove
                        </button>
                      </>
                    )}
                    <label
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        marginLeft: "auto",
                        fontFamily: T.mono,
                        fontSize: 10,
                        fontWeight: 800,
                        color: item.maxQty.trim() ? T.accent : T.muted,
                      }}
                      title="Max units of this item one order can take. Blank = unlimited."
                    >
                      Max / order
                      <input
                        type="number"
                        min={1}
                        inputMode="numeric"
                        placeholder="∞"
                        value={item.maxQty}
                        onChange={e => updateMenuItem(item.id, { maxQty: e.target.value })}
                        style={{
                          ...inputStyle,
                          width: 56,
                          padding: "8px 8px",
                          fontSize: 11,
                          textAlign: "center",
                          color: T.text,
                          background: T.card,
                        }}
                      />
                    </label>
                  </div>
                )}
              </div>
            ))}
            {partialMenuRows && (
              <div style={{
                color: T.amber,
                fontFamily: T.mono,
                fontSize: 10,
                lineHeight: 1.45,
              }}>
                {menuPartialMessage(vertical)}
              </div>
            )}
          </div>
        )}
      </div>
      )}

      {/* Subscription toggle — invisible unless graduated (item 7).
          v0.2.0 universally false (no rating events yet). */}
      {showSubscriptionMode && !usingMenu && (
        <div style={{
          marginBottom: 20, padding: 16,
          background: form.isSubscription ? T.purpleDim : T.surface,
          border: `1px solid ${form.isSubscription ? T.purple + "33" : T.border}`,
          borderRadius: T.r, transition: "all 0.3s",
        }}>
          <div
            onClick={() => set("isSubscription", !form.isSubscription)}
            style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              cursor: "pointer",
            }}
          >
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: form.isSubscription ? T.purple : T.muted, fontFamily: T.mono }}>
                🔄 SUBSCRIPTION MODE
              </div>
              <div style={{ fontSize: 10, color: T.muted, fontFamily: T.sans, marginTop: 2 }}>
                Periodic release — lock upfront, release in installments
              </div>
            </div>
            <div style={{
              width: 40, height: 22, borderRadius: 11,
              background: form.isSubscription ? T.purple : T.border,
              padding: 2, transition: "background 0.2s", cursor: "pointer",
            }}>
              <div style={{
                width: 18, height: 18, borderRadius: "50%",
                background: T.text, transition: "transform 0.2s",
                transform: form.isSubscription ? "translateX(18px)" : "translateX(0)",
              }} />
            </div>
          </div>

          {form.isSubscription && (
            <div style={{ marginTop: 14 }}>
              <div style={{ display: "flex", gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 10, color: T.purple, fontFamily: T.mono, marginBottom: 4 }}>PERIODS</div>
                  <select value={form.periods} onChange={e => set("periods", e.target.value)}
                    style={{ ...inputStyle, fontSize: 12, color: T.text, background: T.surface }}>
                    {[2,3,4,5,6,7,8,9,10,11,12,24,36,52].map(n => (
                      <option key={n} value={n}>{n} period{n > 1 ? "s" : ""}</option>
                    ))}
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 10, color: T.purple, fontFamily: T.mono, marginBottom: 4 }}>INTERVAL</div>
                  <select value={form.intervalDays} onChange={e => set("intervalDays", e.target.value)}
                    style={{ ...inputStyle, fontSize: 12, color: T.text, background: T.surface }}>
                    <option value="7">Weekly</option>
                    <option value="14">Bi-weekly</option>
                    <option value="30">Monthly</option>
                    <option value="90">Quarterly</option>
                  </select>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={onBack} style={{
          flex: 1, padding: "14px",
          background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs,
          color: T.text, fontFamily: T.mono, fontSize: 13, fontWeight: 700,
          cursor: "pointer",
        }}>
          ‹ Back
        </button>
        <button onClick={onNext} disabled={!ready} style={{
          flex: 2, padding: "14px",
          background: ready ? T.accent : T.surface,
          border: ready ? "none" : `1px solid ${T.border}`,
          borderRadius: T.rs,
          color: ready ? T.bg : T.muted,
          fontFamily: T.mono, fontSize: 14, fontWeight: 800,
          cursor: ready ? "pointer" : "default",
          letterSpacing: 0.5,
        }}>
          Review ›
        </button>
      </div>
    </>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Step 3 — Review & publish
// ══════════════════════════════════════════════════════════════════════════

function Step3({
  vertical, form, setForm,
  homeCommunity,
  firstPublishDone,
  submitting,
  amountDisplayMode,
  onBack, onPublish, onSaveDraft,
}: {
  vertical: Vertical;
  form: FormState;
  setForm: (updater: (f: FormState) => FormState) => void;
  homeCommunity: ReturnType<typeof getCommunityBySlug>;
  firstPublishDone: boolean;
  submitting: boolean;
  amountDisplayMode: AmountDisplayMode;
  onBack: () => void;
  onPublish: () => void;
  onSaveDraft: () => void;
}) {
  const btcPrice = useBitcoinPrice();
  const fiatRates = useFiatRates();
  const v = VERTICALS.find(vert => vert.id === vertical)!;
  const menuItems = normalizeMenuItems(form, vertical);
  const hasMenu = menuItems.length > 0;
  const listingDescription = buildListingDescription(form, vertical, menuItems);
  const totalSats = effectiveListingSats(form, vertical);
  const partialMenuRows = hasPartialMenuRows(form, vertical);
  const amountTooSmall =
    !isSimModeOn() &&
    !isTestnetMode() &&
    totalSats > 0 &&
    totalSats < MIN_REAL_ATOMIC_FUNDING_SATS;
  const lendingCapExceeded = hasLendingAmountAboveCurrentCap(form, vertical);
  const ready =
    listingDescription.length > 0 &&
    (form.sats.trim().length > 0 || hasMenu) &&
    !partialMenuRows &&
    !amountTooSmall &&
    !lendingCapExceeded;
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm(prev => ({ ...prev, [key]: value }));
  const fiatFloor = menuFiatFloor(menuItems);
  const singleFiatAmount = parseFiatAmount(form.fiat);
  const estimatedSingleFiatAmount = singleFiatAmount ?? estimateFiatForMsats({
    amountMsats: totalSats * 1000,
    currency: form.cur,
    usdPerBtc: btcPrice.usd,
    usdFiatRates: fiatRates.rates,
  });
  const previewFiatFloor = fiatFloor ?? estimatedMenuFiatFloor({
    menuItems,
    currency: form.cur,
    usdPerBtc: btcPrice.usd,
    usdFiatRates: fiatRates.rates,
  });
  const previewPremium = premiumReviewLine(form, vertical);
  const previewPremiumCheckout = premiumCheckoutLine(form, vertical);
  const showFiatPrimary = amountDisplayMode === "fiat";

  return (
    <>
      {/* Honesty info card — one-time-per-account, dismissed on first
          successful publish (handled by handlePublish above). Not
          dismissable inline; just disappears after the user has
          published once. */}
      {!firstPublishDone && (
        <div style={{
          marginBottom: 16, padding: 14,
          background: T.accentDim, border: `1px solid ${T.accent}33`,
          borderRadius: T.r,
        }}>
          <div style={{
            fontSize: 11, fontWeight: 700, color: T.accent, fontFamily: T.mono,
            letterSpacing: 1, marginBottom: 8,
          }}>
            FIRST LISTING? HEADS UP
          </div>
          <div style={{ fontSize: 12, color: T.text, fontFamily: T.sans, lineHeight: 1.55 }}>
            This listing will run on your current Chama route. Buyers on a
            different route will be switched when they tap your listing — they
            don't move money via Lightning to switch, just spin up a fresh
            Chama on the right route.
          </div>
        </div>
      )}

      {/* Editable bits — small subset for the review screen */}
      {descriptionRequired(vertical, hasMenu) && (
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>
          {descriptionLabel(vertical, hasMenu)}
        </div>
        <input value={form.desc} onChange={e => set("desc", e.target.value)}
          placeholder={descriptionPlaceholder(vertical, hasMenu)}
          style={inputStyle} />
      </div>
      )}

      {/* Preview card */}
      <div style={{
        marginBottom: 20, padding: 16,
        background: T.card, border: `1px solid ${T.border}`,
        borderRadius: T.r,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 700, color: T.muted, fontFamily: T.mono,
          letterSpacing: 1, marginBottom: 12,
        }}>
          PREVIEW
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
          <span style={{ fontSize: 16 }}>{v.icon}</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: T.text, fontFamily: T.sans }}>
            {v.label}
          </span>
          {homeCommunity && (
            <span style={{
              fontSize: 9, color: T.muted, fontFamily: T.mono,
              padding: "2px 6px", borderRadius: 8,
              background: T.surface, border: `1px solid ${T.border}`,
            }}>
              {homeCommunity.flagEmoji} {homeCommunity.displayName}
            </span>
          )}
        </div>
        <div style={{ fontSize: 14, color: T.text, fontFamily: T.sans, marginBottom: 8 }}>
          {listingDescription || <span style={{ color: T.muted, fontStyle: "italic" }}>(no description)</span>}
        </div>
        {form.paymentMethods.length > 0 && (
          <div style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            marginBottom: 10,
          }}>
            {form.paymentMethods.slice(0, 5).map(method => (
              <span
                key={method}
                style={{
                  padding: "4px 7px",
                  borderRadius: 999,
                  background: T.surface,
                  border: `1px solid ${T.border}`,
                  color: T.muted,
                  fontFamily: T.mono,
                  fontSize: 9,
                  fontWeight: 800,
                }}
              >
                {method}
              </span>
            ))}
          </div>
        )}
        {hasMenu ? (
          <>
            <div style={{
              fontSize: 14,
              fontWeight: 800,
              color: T.accent,
              fontFamily: T.mono,
              marginBottom: 10,
              display: "flex",
              alignItems: "baseline",
              gap: 6,
            }}>
              <span style={{ color: T.muted, fontWeight: 700 }}>from</span>
              {showFiatPrimary && previewFiatFloor ? (
                <span>{formatFiatAmount(previewFiatFloor.amount, previewFiatFloor.currency)}</span>
              ) : (
                <BitcoinAmount msats={Math.min(...menuItems.map(item => item.amountMsats))} size={14} gap={4} glyphScale={1.18} />
              )}
              <span style={{ color: T.muted, marginLeft: 8, fontWeight: 500 }}>
                {showFiatPrimary && previewFiatFloor ? `₿ ${fmtSats(Math.min(...menuItems.map(item => item.amountMsats)))} · ` : ""}
                {menuCountLabel(vertical, menuItems.length)}
              </span>
            </div>
            {previewPremium && (
              <div style={{ marginTop: -4, marginBottom: 10, color: T.accent, fontFamily: T.mono, fontSize: 10, fontWeight: 800 }}>
                {previewPremium}
                {previewPremiumCheckout ? ` · ${previewPremiumCheckout}` : ""}
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {menuItems.map(item => (
                <div key={item.id} style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 10,
                  padding: "8px 10px",
                  borderRadius: T.rs,
                  background: T.surface,
                  border: `1px solid ${T.border}`,
                }}>
                  <span style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 8 }}>
                    {item.imageDataUrl && (
                      <img
                        src={item.imageDataUrl}
                        alt=""
                        style={{ width: 34, height: 28, objectFit: "cover", borderRadius: 6, flexShrink: 0 }}
                      />
                    )}
                    <span style={{ minWidth: 0 }}>
                      <span style={{
                        display: "block",
                        color: T.text,
                        fontFamily: T.sans,
                        fontSize: 12,
                        fontWeight: 700,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap" as const,
                      }}>
                        {item.label}
                      </span>
                      {(item.dueAt || item.termDays || item.trustTier) && (
                        <span style={{
                          display: "block",
                          marginTop: 2,
                          color: T.muted,
                          fontFamily: T.mono,
                          fontSize: 9,
                          whiteSpace: "nowrap" as const,
                        }}>
                          {item.dueAt ? `due ${new Date(item.dueAt * 1000).toLocaleDateString()}` : ""}
                          {item.termDays ? `${item.termDays}d` : ""}
                          {item.trustTier ? ` · tier ${item.trustTier}` : ""}
                        </span>
                      )}
                    </span>
                  </span>
                  <span style={{
                    color: T.accent,
                    fontFamily: T.mono,
                    fontSize: 12,
                    fontWeight: 800,
                    whiteSpace: "nowrap" as const,
                  }}>
                    {formatMenuAmount(item, amountDisplayMode, {
                      currency: form.cur,
                      usdPerBtc: btcPrice.usd,
                      usdFiatRates: fiatRates.rates,
                    })}
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <div style={{
              fontSize: 14,
              fontWeight: 700,
              color: T.accent,
              fontFamily: T.mono,
              display: "flex",
              alignItems: "baseline",
              gap: 8,
              flexWrap: "wrap",
            }}>
              {showFiatPrimary && estimatedSingleFiatAmount !== null ? (
                <>
                  <span>{formatFiatAmount(estimatedSingleFiatAmount, form.cur)}</span>
                  <span style={{ color: T.muted, fontWeight: 400 }}>
                    ₿ {fmtSats((form.isSubscription
                      ? parseWholeSats(form.periods) * parseWholeSats(form.sats)
                      : parseWholeSats(form.sats)) * 1000)}
                  </span>
                </>
              ) : (
                <>
                  <BitcoinAmount
                    sats={form.isSubscription
                      ? parseWholeSats(form.periods) * parseWholeSats(form.sats)
                      : parseWholeSats(form.sats)}
                    size={14}
                    gap={4}
                    glyphScale={1.18}
                  />
                  {singleFiatAmount !== null && (
                    <span style={{ color: T.muted, marginLeft: 8, fontWeight: 400 }}>
                      {formatFiatAmount(singleFiatAmount, form.cur)}
                    </span>
                  )}
                </>
              )}
              {form.isSubscription && <span style={{ color: T.muted, fontWeight: 500 }}>total</span>}
            </div>
            {previewPremium && (
              <div style={{ marginTop: 6, color: T.accent, fontFamily: T.mono, fontSize: 10, fontWeight: 800 }}>
                {previewPremium}
                {previewPremiumCheckout ? ` · ${previewPremiumCheckout}` : ""}
              </div>
            )}
          </>
        )}
        {partialMenuRows && (
          <div style={{ marginTop: 8, fontSize: 10, color: T.amber, fontFamily: T.mono }}>
            {menuPartialMessage(vertical).replace("review", "publishing")}
          </div>
          )}
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <button onClick={onBack} style={{
          flex: 1, padding: "14px",
          background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs,
          color: T.text, fontFamily: T.mono, fontSize: 13, fontWeight: 700,
          cursor: "pointer",
        }}>
          ‹ Back
        </button>
        <button onClick={onSaveDraft} style={{
          flex: 1, padding: "14px",
          background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs,
          color: T.text, fontFamily: T.mono, fontSize: 13, fontWeight: 700,
          cursor: "pointer",
        }}>
          Save draft
        </button>
        <button
          onClick={onPublish}
          disabled={!ready || submitting}
          style={{
            flex: 2, padding: "14px",
            background: ready && !submitting ? T.accent : T.surface,
            border: ready && !submitting ? "none" : `1px solid ${T.border}`,
            borderRadius: T.rs,
            color: ready && !submitting ? T.bg : T.muted,
            fontFamily: T.mono, fontSize: 14, fontWeight: 800,
            cursor: ready && !submitting ? "pointer" : "default",
            letterSpacing: 0.5,
          }}
        >
          {submitting ? "Publishing…" : "Publish to community"}
        </button>
      </div>
      {amountTooSmall && (
        <div style={{
          textAlign: "center", marginTop: 6, fontSize: 10,
          color: T.amber, fontFamily: T.mono, lineHeight: 1.45,
        }}>
          {minimumAtomicFundingMessage()}
        </div>
      )}
      {lendingCapExceeded && (
        <div style={{
          textAlign: "center", marginTop: 6, fontSize: 10,
          color: T.red, fontFamily: T.mono, lineHeight: 1.45,
        }}>
          Fedimint lending tiers currently top out at{" "}
          <BitcoinAmount
            sats={MAX_FEDIMINT_LENDING_SATS}
            size={10}
            gap={3}
            glyphScale={1.2}
            color="inherit"
            glyphColor="inherit"
          />.
        </div>
      )}
      <div style={{ textAlign: "center", marginTop: 6, fontSize: 10, color: T.muted, fontFamily: T.mono }}>
        kind:38100 CREATE · NIP-44 encrypted · multi-relay
      </div>
    </>
  );
}
