import { useState } from "react";
import {
  type EscrowState,
  EscrowStatus,
  Role,
  getEffectiveParticipantAt,
  getEffectiveParticipantsAt,
  getJoinHoldRemainingSeconds,
} from "../../escrow-engine/types.js";
import { getCommunityBySlug } from "../../communities/registry.js";
import { pickArbiterFromPool } from "../../arbiters/pool.js";
import { T, CAT_ICON, ROLE_COLOR, ROLE_ICON, STATUS, TRINITY_RING_ORDER, fmtSats } from "../theme.js";
import { listingPremiumLine } from "../listing-metrics.js";
import { payoutRecipientFor } from "../../escrow-engine/recipients.js";
import { useBitcoinPrice } from "../hooks/useBitcoinPrice.js";
import { useFiatRates } from "../hooks/useFiatRates.js";
import { BitcoinAmount } from "./BitcoinAmount.js";
import { profileNameFor, type NostrProfileNameMap } from "../nostr-profiles.js";
import { STORE_WATERMARK } from "../assets/store-watermark.js";
import {
  estimateFiatForMsats,
  formatEstimatedFiatForMsats,
  formatFiatAmount,
  normalizeFiatCurrency,
  resolveEstimatedFiatCurrency,
  shouldQuoteEstimatedFiat,
  type AmountDisplayMode,
} from "../amount-display.js";

// v0.2.0 item 4: variant="non-matching" applies an amber tint per
// chama_browse_amber_tint_sorted. Quiet, not alarmist — it's a
// teaching affordance, not a warning. Tapping a non-matching listing
// triggers the listing-tap dispatch in App.tsx (silent switch when
// balance==0; destroy-confirm modal when balance>0). The community
// flag/name appears inline so users can see at a glance which fed
// they'd be switching to.
export function TradeCard({
  state,
  pubkey,
  onSelect,
  variant = "matching",
  kind0Enabled = false,
  profileNames,
  amountDisplayMode = "sats",
  quoteCurrency,
  stockLeft,
}: {
  state: EscrowState;
  pubkey: string;
  onSelect: () => void;
  variant?: "matching" | "non-matching";
  kind0Enabled?: boolean;
  profileNames?: NostrProfileNameMap;
  amountDisplayMode?: AmountDisplayMode;
  quoteCurrency?: string | null;
  /** #7 Stage 3: derived remaining units for a multi-unit parent listing.
   *  Undefined for single-unit listings (no badge). */
  stockLeft?: number;
}) {
  const btcPrice = useBitcoinPrice();
  const fiatRates = useFiatRates();
  const nowSec = Math.floor(Date.now() / 1000);
  const participants = getEffectiveParticipantsAt(state, nowSec);
  const isAmber = variant === "non-matching";
  const cardBg = isAmber ? T.amberDim : T.card;
  const cardBorder = isAmber ? T.amber + "44" : T.border;
  const listingCommunity = state.community
    ? getCommunityBySlug(state.community)
    : null;
  const sellerPubkey = state.participants[Role.SELLER]
    ?? (state.initiator.role === Role.SELLER ? state.initiator.pubkey : null);
  const sellerName = profileNameFor(profileNames, sellerPubkey, kind0Enabled);
  // A "Store" tile = a marketplace listing with a seller (same condition as the
  // Store badge below). These get a faint Satoshi Market storefront watermark.
  const isMarketStore = state.category === "marketplace" && !!sellerPubkey;
  const communityChipLabel = listingCommunity
    ? (listingCommunity.disambiguator ?? listingCommunity.displayName)
    : null;
  // v2.3.1 — history/audit presentation. On your OWN trade (the Me list) you
  // already know your role — you have the seller dashboard, and arbiters get
  // their own view — so the card shows just the COUNTERPARTY (the other side),
  // never "· You", plus the unique trade ID for audit. Identical-looking orders
  // (same npub, same title) are still told apart by the id. On Browse (non-
  // participant) we keep the single "Seller · X" context line. This also fixes
  // the v2.3 double-"Seller" line: a buyer-viewer rendered the counterparty line
  // ("Seller · X") AND the seller-context line ("Seller · X").
  const viewerRole = pubkey === state.participants[Role.SELLER] ? Role.SELLER
    : pubkey === state.participants[Role.BUYER] ? Role.BUYER : null;
  const isParticipant = viewerRole !== null;
  const counterpartyPk = viewerRole === Role.SELLER ? participants[Role.BUYER]
    : viewerRole === Role.BUYER ? sellerPubkey : null;
  const counterpartyLine = counterpartyPk
    ? `${viewerRole === Role.SELLER ? "Buyer" : "Seller"} · ${profileNameFor(profileNames, counterpartyPk, kind0Enabled) ?? shortPubkey(counterpartyPk)}`
    : null;
  const sellerContextLine = !isParticipant && sellerPubkey && state.category !== "marketplace"
    ? `Seller · ${sellerName ?? shortPubkey(sellerPubkey)}`
    : null;
  const status = STATUS[state.status] ?? STATUS.CREATED;
  const timeLine = compactJoinHoldRemaining(state, nowSec) ?? compactTimeRemaining(state, nowSec);
  const fiatLine = state.fiatAmount != null && state.fiatCurrency
    ? formatFiatAmount(state.fiatAmount, state.fiatCurrency)
    : null;
  const menuItems = state.items ?? [];
  const hasMenu = menuItems.length > 0;
  const fiatFloor = menuFiatFloor(menuItems);
  const exchangeRange = state.category === "p2p-trade"
    ? exchangeBracketRange(menuItems)
    : null;
  const satsLabel = exchangeRange ? satsRangeLabel(exchangeRange) : fmtSats(state.amountMsats);
  const marketplaceImages = state.category === "marketplace"
    ? menuItems.map(item => item.imageDataUrl).filter((src): src is string => !!src)
    : [];
  const menuCountLine = hasMenu ? menuSummary(state.category, menuItems.length, null) : null;
  const menuLine = hasMenu ? menuSummary(state.category, menuItems.length, fiatFloor) : null;
  const listingCurrency = listingFiatCurrency(state, fiatFloor, listingCommunity?.currency);
  const estimatedCurrency = resolveEstimatedFiatCurrency({
    viewerCurrency: quoteCurrency,
    listingCurrency,
  });
  const quoteViewerFiat = shouldQuoteEstimatedFiat({
    viewerCurrency: quoteCurrency,
    listingCurrency,
  });
  const fiatPrimary = fiatLine
    ?? (fiatFloor ? `${hasMenu ? "from " : ""}${formatFiatAmount(fiatFloor.amount, fiatFloor.currency)}` : null);
  const estimatedFiatPrimary = (quoteViewerFiat || !fiatPrimary) && estimatedCurrency
    ? estimatedFiatPrimaryLabel({
        amountMsats: state.amountMsats,
        currency: estimatedCurrency,
        exchangeRange,
        menuItems,
        hasMenu,
        usdPerBtc: btcPrice.usd,
        usdFiatRates: fiatRates.rates,
      })
    : null;
  const displayFiatPrimary = quoteViewerFiat
    ? estimatedFiatPrimary ?? fiatPrimary
    : fiatPrimary ?? estimatedFiatPrimary;
  const showFiatPrimary = amountDisplayMode === "fiat" && !!displayFiatPrimary;
  const paymentMethodsLine = paymentMethodsSummary(state.paymentMethods);
  const premiumLine = listingPremiumLine(state, btcPrice.usd);
  const secondaryLine = showFiatPrimary
    ? [`₿ ${satsLabel}`, menuCountLine].filter(Boolean).join(" · ")
    : fiatLine ?? (
      hasMenu
        ? menuLine
        : state.category === "marketplace" ? fulfillmentLabel(state.fulfillment) : null
    );
  const previewArbiterPk = state.status === EscrowStatus.CREATED
    && !participants[Role.ARBITER]
    && state.communityArbiters.length > 0
    ? (pickArbiterFromPool(state.communityArbiters, state.id, [
        participants[Role.BUYER],
        participants[Role.SELLER],
      ]) ?? null)
    : null;

  return (
    <div onClick={onSelect} style={{
      background: cardBg, border: `1px solid ${cardBorder}`,
      borderRadius: T.r, padding: 14, cursor: "pointer",
      transition: "border-color 0.2s",
      overflow: "hidden",
      position: "relative", isolation: "isolate",
    }}>
      {isMarketStore && (
        <div aria-hidden="true" style={{
          position: "absolute", inset: 0, zIndex: -1,
          backgroundImage: `url(${STORE_WATERMARK})`,
          backgroundRepeat: "no-repeat",
          // Storefront-with-₿ emblem in the tile's right zone, vertically centred
          // and clear of the left-aligned title/price. Fixed size so it reads the
          // same on wide and narrow cards. contrast() crushes the icon's residual
          // dark field to black so it drops out cleanly under `screen` — only the
          // neon (and the Bitcoin glyph) shows.
          backgroundPosition: "right 20px center",
          backgroundSize: "auto 128px",
          filter: "contrast(1.4)",
          mixBlendMode: "screen",
          opacity: 0.65,
          pointerEvents: "none",
        }} />
      )}
      {marketplaceImages.length > 0 && (
        <div style={{
          display: "grid",
          gridTemplateColumns: marketplaceImages.length > 1 ? "1fr 1fr" : "1fr",
          gap: 2,
          margin: "-14px -14px 12px",
          height: 156,
          background: T.surface,
        }}>
          {marketplaceImages.slice(0, 2).map((src, index) => (
            <img
              key={`${src.slice(0, 32)}_${index}`}
              src={src}
              alt=""
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                display: "block",
              }}
            />
          ))}
        </div>
      )}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "stretch",
        gap: 12,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            display: "flex", alignItems: "center", gap: 6,
            marginBottom: 8, flexWrap: "wrap",
          }}>
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 4,
              fontSize: 10, padding: "3px 8px", borderRadius: 999,
              background: T.surface, color: T.muted,
              border: `1px solid ${T.border}`,
              fontFamily: T.mono, fontWeight: 700,
              lineHeight: 1.2,
            }}>
              <span style={{ fontSize: 11, lineHeight: 1 }}>{CAT_ICON[state.category] || "📦"}</span>
              {shortCategoryLabel(state.category)}
            </span>
            {state.subscription && (
              <span style={{
                fontSize: 10, padding: "3px 8px", borderRadius: 999,
                background: T.purpleDim, color: T.purple,
                border: `1px solid ${T.purple}33`,
                fontFamily: T.mono, fontWeight: 700,
              }}>
                🔄 {state.subscription.releasedCount}/{state.subscription.totalPeriods}
              </span>
            )}
            {hasMenu && (
              <span style={{
                fontSize: 10, padding: "3px 8px", borderRadius: 999,
                background: T.accentDim, color: T.accent,
                border: `1px solid ${T.accent}33`,
                fontFamily: T.mono, fontWeight: 800,
              }}>
                {menuBadgeLabel(state.category)}
              </span>
            )}
            {/* #7 Stage 3: derived stock on a multi-unit listing. >0 → "N left";
                0 (all units currently held/locked but not fully sold) → reserved. */}
            {stockLeft !== undefined && (
              <span style={{
                fontSize: 10, padding: "3px 8px", borderRadius: 999,
                background: stockLeft > 0 ? `${T.green}22` : `${T.amber}22`,
                color: stockLeft > 0 ? T.green : T.amber,
                border: `1px solid ${(stockLeft > 0 ? T.green : T.amber)}55`,
                fontFamily: T.mono, fontWeight: 800,
              }}>
                {stockLeft > 0 ? `${stockLeft} left` : "reserved"}
              </span>
            )}
            {state.category === "marketplace" && sellerPubkey && (
              <span style={{
                fontSize: 10, padding: "3px 9px", borderRadius: 999,
                background: `linear-gradient(135deg, ${T.amber}2b, ${T.green}18)`,
                color: T.amber,
                border: `1px solid ${T.amber}55`,
                fontFamily: T.mono, fontWeight: 800,
                display: "inline-flex", alignItems: "center", gap: 4,
                maxWidth: "100%",
              }}>
                <span aria-hidden="true">★</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  Store · {sellerName ?? shortPubkey(sellerPubkey)}
                </span>
              </span>
            )}
            {listingCommunity && (() => {
              // Per-fed chip accent (registry-driven). Amber "off-route" state
              // wins — that's routing info, more important than which fed.
              // On-route/neutral: use the community's accent if it has one,
              // else the legacy neutral grey.
              const accent = !isAmber ? (listingCommunity.chipAccent ?? null) : null;
              const chipColor = isAmber ? T.amber : (accent ?? T.muted);
              const chipBorder = isAmber ? T.amber + "33" : (accent ? accent + "55" : T.border);
              const chipBg = accent ? accent + "1a" : T.surface;
              return (
              <span style={{
                fontSize: 10, padding: "3px 8px", borderRadius: 999,
                background: chipBg, color: chipColor,
                border: `1px solid ${chipBorder}`,
                fontFamily: T.mono, fontWeight: 700,
                display: "inline-flex", alignItems: "center", gap: 3,
                maxWidth: "100%",
              }}>
                <span style={{ fontSize: 10, lineHeight: 1 }}>{listingCommunity.flagEmoji}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {communityChipLabel}
                </span>
              </span>
              );
            })()}
          </div>

          <div style={{
            fontSize: 17, fontWeight: 800, color: T.text,
            fontFamily: T.sans, lineHeight: 1.2, marginBottom: 10,
            overflow: "hidden", textOverflow: "ellipsis",
            display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
          }}>
            {state.description}
          </div>

          {counterpartyLine && (
            <div style={{
              marginTop: -4,
              marginBottom: 6,
              color: viewerRole === Role.SELLER ? T.purple : T.amber,
              fontFamily: T.mono,
              fontSize: 10,
              fontWeight: 700,
              lineHeight: 1.4,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap" as const,
            }}>
              {counterpartyLine}
            </div>
          )}

          {isParticipant && <TradeIdLine id={state.id} />}

          {sellerContextLine && (
            <div style={{
              marginTop: -4,
              marginBottom: 9,
              color: T.muted,
              fontFamily: T.mono,
              fontSize: 10,
              lineHeight: 1.4,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap" as const,
            }}>
              {sellerContextLine}
            </div>
          )}

          <div style={{
            display: "flex", alignItems: "baseline", gap: 7,
            minWidth: 0, flexWrap: "wrap",
            marginBottom: 12,
          }}>
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              color: T.accent, fontFamily: T.mono, lineHeight: 1,
            }}>
              {hasMenu && !exchangeRange && !showFiatPrimary && (
                <span style={{ fontSize: 10, color: T.muted, fontWeight: 800, lineHeight: 1 }}>
                  from
                </span>
              )}
              {showFiatPrimary ? (
                <span style={{
                  fontSize: 24,
                  fontWeight: 900,
                  letterSpacing: 0,
                  color: T.accent,
                }}>
                  {displayFiatPrimary}
                </span>
              ) : exchangeRange ? (
                <BitcoinAmount label={satsRangeLabel(exchangeRange)} size={24} />
              ) : (
                <BitcoinAmount msats={state.amountMsats} size={24} />
              )}
            </span>
            {secondaryLine && (
              <span style={{
                fontSize: 11,
                color: T.muted,
                fontFamily: T.mono,
                lineHeight: 1.4,
              }}>
                · {secondaryLine}
              </span>
            )}
          </div>
          {paymentMethodsLine && (
            <div style={{
              marginTop: -5,
              marginBottom: premiumLine ? 4 : 11,
              color: T.muted,
              fontFamily: T.mono,
              fontSize: 10,
              lineHeight: 1.4,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap" as const,
            }}>
              accepts {paymentMethodsLine}
            </div>
          )}
          {premiumLine && (
            <div style={{
              marginTop: paymentMethodsLine ? 0 : -5,
              marginBottom: 11,
              color: T.amber,
              fontFamily: T.mono,
              fontSize: 10,
              fontWeight: 800,
              lineHeight: 1.4,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap" as const,
            }}>
              {premiumLine}
            </div>
          )}
          <MiniTrinityRing
            state={state}
            pubkey={pubkey}
            previewArbiterPk={previewArbiterPk}
          />
        </div>

        <div style={{
          width: 86, flexShrink: 0,
          display: "flex", flexDirection: "column",
          alignItems: "flex-end", justifyContent: "space-between",
          textAlign: "right", gap: 10,
        }}>
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 5,
            padding: "4px 8px", borderRadius: 999,
            background: status.bg, color: status.c,
            border: `1px solid ${status.c}33`,
            fontSize: 10, fontWeight: 800,
            fontFamily: T.mono, textTransform: "uppercase",
            lineHeight: 1.2,
          }}>
            <span style={{
              width: 6, height: 6, borderRadius: "50%",
              background: status.c, boxShadow: `0 0 8px ${status.c}66`,
            }} />
            {compactStatusLabel(state, nowSec, pubkey)}
          </span>
          {timeLine && (
            <div style={{
              fontSize: 10, color: timeLine.tone, fontFamily: T.mono,
              lineHeight: 1.35,
            }}>
              {timeLine.label}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function shortPubkey(pubkey: string): string {
  return pubkey.length > 13 ? `${pubkey.slice(0, 6)}…${pubkey.slice(-4)}` : pubkey;
}

// v2.3.1 — the unique trade ID, surfaced on the user's own trade cards for
// audit. Two same-npub, same-title trades are still distinct by this id. Tap to
// copy (stopPropagation so it doesn't open the trade). Display is the point;
// copy is the bonus that makes it shareable for a dispute or support thread.
function TradeIdLine({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        try {
          navigator.clipboard?.writeText(id);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch { /* clipboard unavailable — display still serves the audit */ }
      }}
      title="Tap to copy trade ID"
      style={{
        marginTop: -2, marginBottom: 9,
        display: "inline-flex", alignItems: "center", gap: 5, maxWidth: "100%",
        color: T.muted, fontFamily: T.mono, fontSize: 9, lineHeight: 1.4,
        cursor: "pointer",
      }}
    >
      <span style={{ color: copied ? T.green : T.muted, flexShrink: 0 }}>
        {copied ? "✓ copied" : "ID"}
      </span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, opacity: 0.85 }}>
        {id}
      </span>
      <span aria-hidden="true" style={{ flexShrink: 0, opacity: 0.6 }}>⧉</span>
    </div>
  );
}

function shortCategoryLabel(category: string): string {
  if (category === "p2p-trade") return "Exchange";
  if (category === "bill-pay") return "Com. Bill Pay";
  if (category === "marketplace") return "Market";
  if (category === "lending") return "Lending";
  if (category === "raw-escrow") return "Raw";
  return category;
}

function fulfillmentLabel(fulfillment: EscrowState["fulfillment"]): string {
  if (fulfillment === "physical") return "Physical";
  if (fulfillment === "digital") return "Digital";
  return "Service";
}

function menuBadgeLabel(category: string): string {
  if (category === "p2p-trade") return "☰ Options";
  if (category === "bill-pay") return "☰ Bills";
  if (category === "lending") return "☰ Loans";
  return "☰ Store";
}

function menuSummary(
  category: string,
  count: number,
  fiatFloor: { amount: number; currency: string } | null,
): string {
  const noun = category === "p2p-trade" ? "option"
    : category === "bill-pay" ? "bill"
    : category === "lending" ? "loan"
    : "item";
  const base = `${count} ${noun}${count === 1 ? "" : "s"}`;
  return fiatFloor
    ? `${base} · from ${fiatFloor.currency} ${fiatFloor.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
    : base;
}

function menuFiatFloor(items: NonNullable<EscrowState["items"]>): { amount: number; currency: string } | null {
  const fiatItems = items.filter((item) => item.fiatAmount !== undefined && item.fiatCurrency);
  if (fiatItems.length === 0) return null;
  const currencies = new Set(fiatItems.map((item) => item.fiatCurrency));
  if (currencies.size !== 1) return null;
  const amount = Math.min(...fiatItems.map((item) => item.fiatAmount ?? Number.POSITIVE_INFINITY));
  const currency = fiatItems[0]?.fiatCurrency;
  return Number.isFinite(amount) && currency ? { amount, currency } : null;
}

function listingFiatCurrency(
  state: EscrowState,
  fiatFloor: { amount: number; currency: string } | null,
  communityCurrency: string | null | undefined,
): string | null {
  return normalizeFiatCurrency(state.fiatCurrency)
    ?? normalizeFiatCurrency(fiatFloor?.currency)
    ?? normalizeFiatCurrency(communityCurrency);
}

function estimatedFiatPrimaryLabel({
  amountMsats,
  currency,
  exchangeRange,
  menuItems,
  hasMenu,
  usdPerBtc,
  usdFiatRates,
}: {
  amountMsats: number;
  currency: string;
  exchangeRange: { minMsats: number; maxMsats: number } | null;
  menuItems: NonNullable<EscrowState["items"]>;
  hasMenu: boolean;
  usdPerBtc: number | null;
  usdFiatRates: Record<string, number>;
}): string | null {
  const normalizedCurrency = normalizeFiatCurrency(currency);
  if (!normalizedCurrency) return null;

  if (exchangeRange) {
    return estimatedFiatRangeLabel({
      minMsats: exchangeRange.minMsats,
      maxMsats: exchangeRange.maxMsats,
      currency: normalizedCurrency,
      usdPerBtc,
      usdFiatRates,
    });
  }

  const displayMsats = hasMenu && menuItems.length > 0
    ? Math.min(...menuItems.map(item => item.amountMsats))
    : amountMsats;
  const label = formatEstimatedFiatForMsats({
    amountMsats: displayMsats,
    currency: normalizedCurrency,
    usdPerBtc,
    usdFiatRates,
  });
  return label && hasMenu ? `from ${label}` : label;
}

function estimatedFiatRangeLabel({
  minMsats,
  maxMsats,
  currency,
  usdPerBtc,
  usdFiatRates,
}: {
  minMsats: number;
  maxMsats: number;
  currency: string;
  usdPerBtc: number | null;
  usdFiatRates: Record<string, number>;
}): string | null {
  const min = estimateFiatForMsats({ amountMsats: minMsats, currency, usdPerBtc, usdFiatRates });
  const max = estimateFiatForMsats({ amountMsats: maxMsats, currency, usdPerBtc, usdFiatRates });
  if (min === null || max === null) return null;
  const minLabel = formatFiatAmount(min, currency);
  const maxLabel = formatFiatAmount(max, currency);
  return minLabel === maxLabel ? minLabel : `${minLabel}-${maxLabel.replace(`${currency} `, "")}`;
}

function exchangeBracketRange(items: NonNullable<EscrowState["items"]>): { minMsats: number; maxMsats: number } | null {
  const brackets = items
    .filter((item) => item.kind === "exchange-bracket")
    .map((item) => ({
      minMsats: item.minAmountMsats ?? item.amountMsats,
      maxMsats: item.maxAmountMsats ?? item.amountMsats,
    }))
    .filter((range) => range.minMsats > 0 && range.maxMsats >= range.minMsats);
  if (brackets.length === 0) return null;
  return {
    minMsats: Math.min(...brackets.map((range) => range.minMsats)),
    maxMsats: Math.max(...brackets.map((range) => range.maxMsats)),
  };
}

function satsRangeLabel(range: { minMsats: number; maxMsats: number }): string {
  const min = fmtSats(range.minMsats);
  const max = fmtSats(range.maxMsats);
  return min === max ? min : `${min}-${max}`;
}

function paymentMethodsSummary(methods: string[] | undefined): string | null {
  const cleaned = (methods ?? []).map((method) => method.trim()).filter(Boolean);
  if (cleaned.length === 0) return null;
  const visible = cleaned.slice(0, 3).join(" · ");
  const extra = cleaned.length > 3 ? ` · +${cleaned.length - 3}` : "";
  return `${visible}${extra}`;
}

function compactStatusLabel(state: EscrowState, nowSec: number, viewerPubkey?: string): string {
  const { status } = state;
  if (
    status === EscrowStatus.CREATED &&
    TRINITY_RING_ORDER.some(role =>
      role !== state.initiator.role &&
      !!getEffectiveParticipantAt(state, role, nowSec)
    )
  ) {
    return "Joined";
  }
  if (status === EscrowStatus.CREATED) return "Open";
  if (status === EscrowStatus.LOCKED) return "Escrow";
  if (status === EscrowStatus.APPROVED) {
    // Resolved for someone else → the viewer's part is done; only the
    // winner still has a claim to make. Their chip reads Done, not Claim.
    if (viewerPubkey && state.resolvedOutcome) {
      const winner = payoutRecipientFor(state, state.resolvedOutcome);
      if (winner && winner.pubkey !== viewerPubkey) return "Done";
    }
    return "Claim";
  }
  if (status === EscrowStatus.CLAIMED) return "Settling";
  if (status === EscrowStatus.COMPLETED) return "Done";
  if (status === EscrowStatus.EXPIRED) return "Timed out";
  if (status === EscrowStatus.CANCELLED) return "Closed";
  return status;
}

function MiniTrinityRing({
  state,
  pubkey,
  previewArbiterPk,
}: {
  state: EscrowState;
  pubkey: string;
  previewArbiterPk: string | null;
}) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 5,
      minWidth: 0,
    }}>
      {TRINITY_RING_ORDER.map((role, index) => {
        const previousRole = TRINITY_RING_ORDER[index - 1];
        const realPk = getEffectiveParticipantAt(state, role);
        const autoAssigned = role === Role.ARBITER && !realPk && !!previewArbiterPk;
        const pk = realPk ?? (autoAssigned ? previewArbiterPk : null);
        const filled = !!pk;
        const color = ROLE_COLOR[role] ?? T.muted;
        const isYou = pk === pubkey;
        const connectorRole = role === Role.ARBITER || previousRole === Role.ARBITER
          ? Role.ARBITER
          : role;
        const connectorColor = ROLE_COLOR[connectorRole] ?? T.muted;
        const connectorFilled = connectorRole === Role.ARBITER
          ? !!(getEffectiveParticipantAt(state, Role.ARBITER) ?? previewArbiterPk)
          : filled;
        return (
          <div key={role} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            {index > 0 && (
              <span style={{
                width: 12, height: 1,
                background: connectorFilled ? `${connectorColor}55` : T.border,
                display: "inline-block",
              }} />
            )}
            <span
              title={filled ? `${role}: ${isYou ? "You" : pk}` : `${role}: open`}
              style={{
                width: 22, height: 22, borderRadius: "50%",
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                border: `1px ${filled ? "solid" : "dashed"} ${filled ? color : T.border}`,
                background: filled ? (autoAssigned ? `${color}12` : `${color}22`) : T.surface,
                color: filled ? color : T.muted,
                fontFamily: T.mono, fontSize: 10, fontWeight: 800,
                opacity: autoAssigned ? 0.78 : 1,
                boxShadow: isYou ? `0 0 0 2px ${color}22` : "none",
              }}
            >
              {ROLE_ICON[role] ?? "?"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function compactJoinHoldRemaining(state: EscrowState, nowSec: number): { label: string; tone: string } | null {
  if (state.status !== EscrowStatus.CREATED) return null;
  const activeHoldRoles = TRINITY_RING_ORDER
    .filter(role => role !== state.initiator.role)
    .map(role => [role, getJoinHoldRemainingSeconds(state, role, nowSec)] as const)
    .filter(([, remaining]) => remaining !== null && remaining > 0);
  if (!activeHoldRoles.length) return null;

  const remaining = Math.min(...activeHoldRoles.map(([, r]) => r ?? Infinity));
  const minutes = Math.max(1, Math.ceil(remaining / 60));
  const tone = remaining < 120 ? T.red : remaining < 300 ? T.amber : T.muted;
  return { label: `lock ${minutes}m`, tone };
}

function compactTimeRemaining(state: EscrowState, nowSec = Math.floor(Date.now() / 1000)): { label: string; tone: string } | null {
  if (!state.expiresAt) return null;
  if (
    state.status === EscrowStatus.COMPLETED
    || state.status === EscrowStatus.CANCELLED
    || state.status === EscrowStatus.CLAIMED
  ) {
    return null;
  }
  const remaining = state.expiresAt - nowSec;
  if (remaining <= 0) return { label: "Expired", tone: T.red };
  const hours = Math.floor(remaining / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  const tone = remaining < 600 ? T.red : remaining < 3600 ? T.amber : T.muted;
  const label = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  return {
    label: state.status === EscrowStatus.CREATED ? `listing ${label}` : label,
    tone,
  };
}
