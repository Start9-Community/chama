import type { CSSProperties } from "react";
import { T, fmtSats } from "../theme.js";

export function BitcoinAmount({
  msats,
  sats,
  label,
  size = 24,
  color = T.accent,
  glyphColor = T.muted,
  gap = 6,
  glyphScale = 1.1,
  className,
  style,
}: {
  msats?: number;
  sats?: number;
  label?: string;
  size?: number;
  color?: string;
  glyphColor?: string;
  gap?: number;
  glyphScale?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const displayLabel = label ?? (msats !== undefined
    ? fmtSats(msats)
    : Math.floor(sats ?? 0).toLocaleString());

  return (
    <span
      className={className ? `bitcoin-amount ${className}` : "bitcoin-amount"}
      style={{
        display: "inline-flex",
        alignItems: "baseline",
        gap,
        color,
        fontFamily: T.mono,
        fontWeight: 900,
        lineHeight: 1,
        ...style,
      }}
    >
      <span
        className="bitcoin-amount-glyph"
        aria-hidden="true"
        style={{
          fontSize: Math.ceil(size * glyphScale),
          color: glyphColor,
          lineHeight: 1,
          transform: "translateY(-1px)",
        }}
      >
        ₿
      </span>
      <span className="bitcoin-amount-number" style={{ fontSize: size, lineHeight: 1 }}>{displayLabel}</span>
    </span>
  );
}
