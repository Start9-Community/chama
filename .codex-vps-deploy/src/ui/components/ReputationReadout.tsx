import { useEffect, useState } from "react";
import { T } from "../theme.js";
import type { AggregateRatings } from "../../reputation/ratings.js";

// v3.1.1 (#2): the read-only reputation surface. Given a pubkey, fetches that
// party's VERIFIED rating aggregate from relays (fetchRatingSummary already
// drops unverifiable ratings) and shows a compact `👍 N · 👎 M · from K settled
// trades` line. Fetch-on-mount so it only hits relays when actually revealed
// (e.g. tapping a participant in the trinity ring).
export function ReputationReadout({ pubkey, name, fetchSummary }: {
  pubkey: string;
  name?: string | null;
  fetchSummary: (ratee: string) => Promise<AggregateRatings>;
}) {
  const [data, setData] = useState<AggregateRatings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    setData(null);
    fetchSummary(pubkey)
      .then(s => { if (!cancelled) { setData(s); setLoading(false); } })
      .catch(() => { if (!cancelled) { setError(true); setLoading(false); } });
    return () => { cancelled = true; };
  }, [pubkey, fetchSummary]);

  const who = name || (pubkey.slice(0, 8) + "…");

  return (
    <div style={{
      marginTop: 12, padding: "10px 12px", borderRadius: T.rs,
      background: T.surface, border: `1px solid ${T.border}`,
      fontFamily: T.mono, fontSize: 12.5,
      animation: "fadeIn 0.2s ease",
    }}>
      <div style={{ fontSize: 9.5, color: T.muted, letterSpacing: 0.5, marginBottom: 6, textTransform: "uppercase" }}>
        Reputation · {who}
      </div>
      {loading ? (
        <span style={{ color: T.muted }}>Loading from relays…</span>
      ) : error ? (
        <span style={{ color: T.red }}>Couldn't load reputation — tap again to retry.</span>
      ) : data && data.count > 0 ? (
        <span style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ color: T.green, fontWeight: 700 }}>👍 {data.positive}</span>
          <span style={{ color: T.amber, fontWeight: 700 }}>👎 {data.negative}</span>
          <span style={{ color: T.muted }}>· from {data.count} settled trade{data.count !== 1 ? "s" : ""}</span>
        </span>
      ) : (
        <span style={{ color: T.muted }}>No ratings yet — new to the community.</span>
      )}
    </div>
  );
}
