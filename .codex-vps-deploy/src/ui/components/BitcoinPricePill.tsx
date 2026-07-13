import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
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

// Scoped interaction/animation CSS — inline styles can't do :active/@keyframes.
// The WHOLE hero rectangle is the button (pressable anywhere): it springs down
// on press (tactile), and the "sats ⇄ fiat" toggle line POPS each time you
// switch (the "animate on action" feel, driven by a React key so it's reliable
// on touch — :active alone felt stale on mobile). Honors prefers-reduced-motion.
const TOGGLE_CSS = `
@keyframes chamaPricePop {
  0%   { transform: scale(.86); }
  55%  { transform: scale(1.1); }
  100% { transform: scale(1); }
}
.chama-price-btn { transition: transform .14s cubic-bezier(.34,1.56,.64,1), box-shadow .2s ease; }
.chama-price-btn:active { transform: scale(.98); }
.chama-price-swap { transition: color .3s ease, opacity .3s ease; }
.chama-price-pop { animation: chamaPricePop .3s cubic-bezier(.34,1.56,.64,1); transform-origin: center; }
@media (prefers-reduced-motion: reduce) { .chama-price-pop { animation: none; } }
`;
const ToggleStyle = () => <style>{TOGGLE_CSS}</style>;

/** Big price number that SHRINKS to fit its width (content-responsive), so a
 *  high-denomination currency (IDR/VND-scale) never overflows or clips on a
 *  narrow device. Measures scrollWidth vs the container and steps the font-size
 *  down to `min`; re-fits on width change (rotation) via ResizeObserver. */
function FitText({ text, max, min, align = "left", style }: {
  text: string; max: number; min: number; align?: "left" | "right"; style?: CSSProperties;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const spanRef = useRef<HTMLSpanElement>(null);
  const [px, setPx] = useState(max);
  useLayoutEffect(() => {
    const box = boxRef.current, span = spanRef.current;
    if (!box || !span) return;
    const fit = () => {
      let s = max;
      span.style.fontSize = `${s}px`;
      while (s > min && span.scrollWidth > box.clientWidth) {
        s -= 1;
        span.style.fontSize = `${s}px`;
      }
      setPx(s);
    };
    fit();
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => fit());
      ro.observe(box);
    }
    return () => ro?.disconnect();
  }, [text, max, min]);
  return (
    <div ref={boxRef} style={{ width: "100%", minWidth: 0, overflow: "hidden", textAlign: align }}>
      <span ref={spanRef} style={{ ...style, fontSize: `${px}px`, whiteSpace: "nowrap", display: "inline-block" }}>
        {text}
      </span>
    </div>
  );
}

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
  // Split price into ticker (left) + digits (right) for the hero's two-column
  // layout. A BTC price is huge, so drop decimals entirely — cents are noise.
  const priceTicker = displayAmount != null ? displayCurrency : "";
  const priceDigits = displayAmount != null
    ? Math.round(displayAmount).toLocaleString()
    : "price…";
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
        <>
        <ToggleStyle />
        <button
          type="button"
          className="chama-price-btn"
          title={`${title}. Tap to switch listing amounts to ${nextMode}.`}
          onClick={() => onAmountModeChange(nextMode)}
          style={{
            width: "100%",
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: "13px 16px",
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
          {/* Row 1 — LABEL left, toggle RIGHT (balances the bar). The toggle
              is a SEGMENTED switch: only the ACTIVE side wears the glowing pill
              (FIAT→green, BTC→accent), the other is plain dim; the ⇄ stays loud
              + bright. Pops on each swap (key change). */}
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
          }}>
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 8, flexShrink: 0,
              color: stale ? T.muted : T.green, fontFamily: T.mono, fontSize: 14, fontWeight: 900,
              letterSpacing: 0.8, textTransform: "uppercase",
            }}>
              <span aria-hidden="true" style={{
                width: 9, height: 9, borderRadius: "50%",
                background: stale ? T.muted : T.green,
                boxShadow: stale ? "none" : `0 0 12px ${T.green}99`,
              }} />
              1 BTC =
            </span>
            <span
              key={amountMode}
              className="chama-price-swap chama-price-pop"
              style={{
                display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0,
                fontFamily: T.mono, fontSize: 11, fontWeight: 900,
                textTransform: "uppercase", letterSpacing: 0.6,
              }}
            >
              <span style={amountMode === "fiat"
                ? {
                    padding: "3px 9px", borderRadius: 999,
                    border: `1px solid ${T.green}`, background: T.greenDim,
                    color: T.green, boxShadow: `0 0 10px ${T.green}66`,
                  }
                : { padding: "3px 9px", color: T.muted, opacity: 0.55 }}>
                FIAT
              </span>
              <span aria-hidden="true" style={{
                color: T.accent, fontSize: 17, fontWeight: 900, lineHeight: 1,
                textShadow: `0 0 9px ${T.accent}, 0 0 4px ${T.accent}`,
              }}>
                ⇄
              </span>
              <span style={amountMode === "sats"
                ? {
                    padding: "3px 9px", borderRadius: 999,
                    border: `1px solid ${T.accent}`, background: T.accentDim,
                    color: T.accent, boxShadow: `0 0 10px ${T.accent}66`,
                  }
                : { padding: "3px 9px", color: T.muted, opacity: 0.55 }}>
                BTC
              </span>
            </span>
          </div>

          {/* Row 2 — currency TICKER left, big DIGITS right (shrink-to-fit,
              right-aligned). Ticker anchors the left column; the value lands on
              the right, aligned under the toggle. */}
          <div style={{
            display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12,
          }}>
            <span style={{
              flexShrink: 0,
              color: price.usd ? T.text : T.muted, fontFamily: T.mono, fontSize: 30, fontWeight: 950,
              lineHeight: 1, letterSpacing: 0,
            }}>
              {priceTicker}
            </span>
            <FitText
              text={priceDigits}
              max={30}
              min={15}
              align="right"
              style={{
                color: price.usd ? T.text : T.muted,
                fontFamily: T.mono,
                fontWeight: 950,
                lineHeight: 1,
                letterSpacing: 0,
              }}
            />
          </div>

          {/* Row 3 — source, anchored RIGHT now (under the digits) so the left
              column can give "1 BTC =" + the ticker their full, maximized size. */}
          <span style={{
            alignSelf: "flex-end", maxWidth: "100%", textAlign: "right",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            color: T.muted, fontFamily: T.mono, fontSize: 9, fontWeight: 800,
            textTransform: "uppercase", letterSpacing: 0.6,
          }}>
            {sourceLabel}
          </span>
        </button>
        </>
      );
    }

    return (
      <>
        <ToggleStyle />
        <button
          type="button"
          className="chama-price-btn"
          title={`${title}. Tap to switch listing amounts to ${nextMode}.`}
          onClick={() => onAmountModeChange(nextMode)}
          style={{
            ...pillStyle,
            cursor: "pointer",
          }}
        >
          {content}
        </button>
      </>
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
          <FitText
            text={fullLabel}
            max={30}
            min={15}
            style={{
              color: price.usd ? T.text : T.muted,
              fontFamily: T.mono,
              fontWeight: 950,
              lineHeight: 1,
              letterSpacing: 0,
            }}
          />
        </div>
        <div style={{
          flexShrink: 0,
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
