import { formatUsdBtcPrice } from "../../markets/bitcoin-price.js";
import { T } from "../theme.js";
import { useBitcoinPrice } from "../hooks/useBitcoinPrice.js";
import { nextAmountDisplayMode, type AmountDisplayMode } from "../amount-display.js";

export function BitcoinPricePill({
  compact = false,
  amountMode,
  onAmountModeChange,
}: {
  compact?: boolean;
  amountMode?: AmountDisplayMode;
  onAmountModeChange?: (mode: AmountDisplayMode) => void;
}) {
  const price = useBitcoinPrice();
  const label = price.usd ? `${formatUsdBtcPrice(price.usd)} BTC` : "BTC price…";
  const stale = price.source !== "live";
  const title = price.updatedAt
    ? `BTC/USD ${new Date(price.updatedAt).toLocaleTimeString()}`
    : "Loading BTC/USD";
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

  return (
    <span
      title={title}
      style={pillStyle}
    >
      {content}
    </span>
  );
}
