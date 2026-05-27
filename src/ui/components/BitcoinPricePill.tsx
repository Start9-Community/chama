import { formatUsdBtcPrice } from "../../markets/bitcoin-price.js";
import { T } from "../theme.js";
import { useBitcoinPrice } from "../hooks/useBitcoinPrice.js";

export function BitcoinPricePill({ compact = false }: { compact?: boolean }) {
  const price = useBitcoinPrice();
  const label = price.usd ? `${formatUsdBtcPrice(price.usd)} BTC` : "BTC price…";
  const stale = price.source !== "live";

  return (
    <span
      title={price.updatedAt ? `BTC/USD ${new Date(price.updatedAt).toLocaleTimeString()}` : "Loading BTC/USD"}
      style={{
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
        whiteSpace: "nowrap",
        lineHeight: 1,
      }}
    >
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
      {label}
    </span>
  );
}
