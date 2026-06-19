import { formatUsdBtcPrice, formatUsdBtcPriceFull } from "../../markets/bitcoin-price.js";
import { T } from "../theme.js";
import { useBitcoinPrice } from "../hooks/useBitcoinPrice.js";
import { useFiatRates } from "../hooks/useFiatRates.js";
import {
  estimateFiatForMsats,
  formatFiatAmount,
  nextAmountDisplayMode,
  normalizeFiatCurrency,
  type AmountDisplayMode,
} from "../amount-display.js";

export function BitcoinPricePill({
  compact = false,
  hero = false,
  amountMode,
  onAmountModeChange,
  quoteCurrency,
}: {
  compact?: boolean;
  hero?: boolean;
  amountMode?: AmountDisplayMode;
  onAmountModeChange?: (mode: AmountDisplayMode) => void;
  quoteCurrency?: string | null;
}) {
  const price = useBitcoinPrice();
  const fiatRates = useFiatRates();
  const normalizedQuoteCurrency = normalizeFiatCurrency(quoteCurrency) ?? "USD";
  const localBtcPrice = normalizedQuoteCurrency === "USD"
    ? price.usd ?? null
    : estimateFiatForMsats({
        amountMsats: 100_000_000_000,
        currency: normalizedQuoteCurrency,
        usdPerBtc: price.usd,
        usdFiatRates: fiatRates.rates,
      });
  const displayCurrency = localBtcPrice ? normalizedQuoteCurrency : "USD";
  const displayAmount = localBtcPrice ?? price.usd ?? null;
  const displayIsUsd = displayCurrency === "USD";
  const label = displayAmount
    ? `${displayIsUsd ? formatUsdBtcPrice(displayAmount) : formatFiatAmount(displayAmount, displayCurrency)} BTC`
    : "BTC price…";
  const fullLabel = displayAmount
    ? (displayIsUsd ? formatUsdBtcPriceFull(displayAmount) : formatFiatAmount(displayAmount, displayCurrency))
    : "BTC price…";
  const stale = price.source !== "live";
  const title = price.updatedAt
    ? `BTC/${displayCurrency} ${new Date(price.updatedAt).toLocaleTimeString()}`
    : `Loading BTC/${displayCurrency}`;
  const providerCount = price.source === "live" ? price.providers?.length ?? 0 : 0;
  const btcSourceLabel = price.source === "live"
    ? providerCount > 1
      ? `median of ${providerCount} sources`
      : "live source"
    : price.source === "cache"
      ? "cached quote"
      : "waiting for sources";
  const sourceLabel = displayCurrency !== "USD" && displayAmount
    ? `${btcSourceLabel} · FX ${fiatRates.source === "live" ? "live" : fiatRates.source === "cache" ? "cached" : "waiting"}`
    : btcSourceLabel;
  const content = (
    <>
      <span
        aria-hidden="true"
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: stale ? T.muted : T.green,
          boxShadow: stale ? "none" : `0 0 7px ${T.green}66`,
        }}
      />
      <span>{label}</span>
      {amountMode && (
        <span style={{
          marginLeft: 1,
          padding: compact ? "2px 4px" : "2px 5px",
          borderRadius: 999,
          background: amountMode === "fiat" ? T.green + "18" : T.accentDim,
          border: `1px solid ${amountMode === "fiat" ? T.green + "44" : T.accent + "44"}`,
          color: amountMode === "fiat" ? T.green : T.accent,
          textTransform: "uppercase",
        }}>
          {amountMode}
        </span>
      )}
    </>
  );

  const pillStyle = {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: compact ? "4px 7px" : "4px 10px",
    borderRadius: 6,
    background: T.surface,
    border: `1px solid ${stale ? T.border : T.green + "55"}`,
    color: stale ? T.muted : T.green,
    fontFamily: T.mono,
    fontSize: compact ? 8 : 9,
    fontWeight: 800,
    whiteSpace: "nowrap" as const,
    lineHeight: 1,
  };

  if (amountMode && onAmountModeChange) {
    const nextMode = nextAmountDisplayMode(amountMode);
    if (hero) {
      return (
        <button
          type="button"
          title={`${title}. Toggle listing amounts to ${nextMode}.`}
          onClick={() => onAmountModeChange(nextMode)}
          style={{
            width: "100%",
            display: "grid",
            gridTemplateColumns: "1fr auto",
            alignItems: "center",
            gap: 12,
            padding: "14px 16px",
            borderRadius: T.r,
            border: `1px solid ${stale ? T.borderHi : T.green + "55"}`,
            background: stale
              ? `linear-gradient(135deg, ${T.surface}, ${T.card})`
              : `linear-gradient(135deg, ${T.greenDim}, ${T.surface} 48%, ${T.accentDim})`,
            color: T.text,
            textAlign: "left",
            cursor: "pointer",
            boxShadow: stale ? "none" : `0 0 26px ${T.green}12`,
          }}
        >
          <span style={{
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            gap: 5,
          }}>
            <span style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              color: stale ? T.muted : T.green,
              fontFamily: T.mono,
              fontSize: 10,
              fontWeight: 900,
              letterSpacing: 1.1,
              textTransform: "uppercase",
            }}>
              <span
                aria-hidden="true"
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: stale ? T.muted : T.green,
                  boxShadow: stale ? "none" : `0 0 10px ${T.green}88`,
                }}
              />
              1 BTC =
            </span>
            <span style={{
              color: price.usd ? T.text : T.muted,
              fontFamily: T.mono,
              fontSize: 30,
              fontWeight: 950,
              lineHeight: 1,
              letterSpacing: 0,
              whiteSpace: "nowrap",
            }}>
              {fullLabel}
            </span>
            <span style={{
              color: T.muted,
              fontFamily: T.mono,
              fontSize: 9,
              fontWeight: 800,
              lineHeight: 1.3,
              textTransform: "uppercase",
              letterSpacing: 0.8,
            }}>
              {sourceLabel}
            </span>
          </span>
          <span style={{
            display: "inline-flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 4,
            padding: "8px 10px",
            borderRadius: 999,
            background: amountMode === "fiat" ? T.green + "18" : T.accentDim,
            border: `1px solid ${amountMode === "fiat" ? T.green + "44" : T.accent + "44"}`,
            color: amountMode === "fiat" ? T.green : T.accent,
            fontFamily: T.mono,
            fontSize: 10,
            fontWeight: 900,
            textTransform: "uppercase",
            whiteSpace: "nowrap",
          }}>
            <span>{amountMode}</span>
            <span style={{ color: T.muted, fontSize: 8, fontWeight: 800 }}>view</span>
          </span>
        </button>
      );
    }

    return (
      <button
        type="button"
        title={`${title}. Toggle listing amounts to ${nextMode}.`}
        onClick={() => onAmountModeChange(nextMode)}
        style={{
          ...pillStyle,
          cursor: "pointer",
        }}
      >
        {content}
      </button>
    );
  }

  if (hero) {
    return (
      <div
        title={title}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "14px 16px",
          borderRadius: T.r,
          border: `1px solid ${stale ? T.borderHi : T.green + "55"}`,
          background: stale
            ? `linear-gradient(135deg, ${T.surface}, ${T.card})`
            : `linear-gradient(135deg, ${T.greenDim}, ${T.surface} 48%, ${T.accentDim})`,
          color: T.text,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{
            color: stale ? T.muted : T.green,
            fontFamily: T.mono,
            fontSize: 10,
            fontWeight: 900,
            letterSpacing: 1.1,
            textTransform: "uppercase",
            marginBottom: 5,
          }}>
            BTC/{displayCurrency}
          </div>
          <div style={{
            color: price.usd ? T.text : T.muted,
            fontFamily: T.mono,
            fontSize: 30,
            fontWeight: 950,
            lineHeight: 1,
            letterSpacing: 0,
          }}>
            {fullLabel}
          </div>
        </div>
        <div style={{
          color: T.muted,
          fontFamily: T.mono,
          fontSize: 9,
          fontWeight: 800,
          textTransform: "uppercase",
          letterSpacing: 0.8,
          textAlign: "right",
        }}>
          {sourceLabel}
        </div>
      </div>
    );
  }

  return (
    <span
      title={title}
      style={pillStyle}
    >
      {content}
    </span>
  );
}
