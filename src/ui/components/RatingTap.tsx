// One-tap counterparty rating (👍/👎) — the capture surface for the kind:38123
// ratings primitive. Deliberately NON-BLOCKING: it's a tap, never a gate, so it
// never stands between the user and closing a settled trade. Binary by design
// (one thumb, zero required text) so a rating is given, not skipped. Shows
// "rated" once done; the same (trade, ratee) slot is replaceable, so a tap here
// and a tap later from Me history land on the same rating.

import { useState } from "react";
import { T } from "../theme.js";
import type { RatingThumb } from "../../reputation/ratings.js";

export function RatingTap({
  tradeId,
  ratee,
  ratedThumb,
  onRate,
}: {
  tradeId: string;
  ratee: string;
  /** The thumb already on chain for this (trade, ratee), if any. */
  ratedThumb?: RatingThumb;
  onRate: (tradeId: string, ratee: string, thumb: RatingThumb) => Promise<void>;
}) {
  const [tapped, setTapped] = useState<RatingThumb | undefined>(undefined);
  const [pending, setPending] = useState<RatingThumb | null>(null);
  const shown = tapped ?? ratedThumb;

  const tap = async (thumb: RatingThumb) => {
    if (shown || pending) return;
    setPending(thumb);
    try {
      await onRate(tradeId, ratee, thumb);
      setTapped(thumb);
    } catch {
      // Leave it un-rated so the user can retry; a failed publish is silent.
    } finally {
      setPending(null);
    }
  };

  const wrap: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingTop: 14,
    marginBottom: 16,
    borderTop: `1px solid ${T.border}`,
  };

  if (shown) {
    return (
      <div style={wrap}>
        <span style={{ fontSize: 14 }}>{shown === "up" ? "👍" : "👎"}</span>
        <span style={{ fontSize: 11, fontFamily: T.mono, color: T.muted }}>
          Thanks — your rating is in.
        </span>
      </div>
    );
  }

  const pill = (thumb: RatingThumb, color: string): React.CSSProperties => ({
    cursor: pending ? "default" : "pointer",
    border: `1px solid ${color}66`,
    background: pending === thumb ? `${color}33` : `${color}1a`,
    color,
    borderRadius: 999,
    fontSize: 16,
    lineHeight: 1,
    padding: "8px 16px",
    opacity: pending && pending !== thumb ? 0.5 : 1,
  });

  return (
    <div style={wrap}>
      <span style={{ fontSize: 11, fontFamily: T.mono, color: T.muted }}>
        How was your counterparty?
      </span>
      <button aria-label="thumbs up" disabled={!!pending} onClick={() => tap("up")} style={pill("up", T.green)}>
        👍
      </button>
      <button aria-label="thumbs down" disabled={!!pending} onClick={() => tap("down")} style={pill("down", T.amber)}>
        👎
      </button>
    </div>
  );
}
