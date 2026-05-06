import { useState } from "react";
import { categoryAllowsFulfillmentChoice, type Fulfillment } from "../../labels/vote-labels.js";
import { getCommunityBySlug, DEFAULT_COMMUNITY_SLUG } from "../../communities/registry.js";
import { getUserCommunitySlug } from "../../communities/storage.js";
import { resolveFederationForCommunity } from "../../fedimint/federation-config.js";
import { T, inputStyle } from "../theme.js";

export function CreateForm({ onCreate, onClose }: {
  onCreate: (params: any) => void; onClose: () => void;
}) {
  const [cat, setCat] = useState("p2p-trade");
  const [desc, setDesc] = useState("");
  const [sats, setSats] = useState("");
  const [fiat, setFiat] = useState("");
  const [cur, setCur] = useState("USD");
  const [submitting, setSubmitting] = useState(false);
  const [isSubscription, setIsSubscription] = useState(false);
  const [periods, setPeriods] = useState("3");
  const [intervalDays, setIntervalDays] = useState("30");
  const [fulfillment, setFulfillment] = useState<Fulfillment>("physical");

  // v0.1.87: the community selector dropdown was removed. Per the
  // locked v0.2.0 design ("listings publish into seller's current
  // community"), CreateForm publishes into whatever community the
  // user is currently on. If they want to list elsewhere, they tap
  // a different community pill in Browse first — that's the v0.2.0
  // multi-community workflow primitive. Read once at form-open;
  // subsequent community switches require a fresh form.
  const community = (() => {
    const slug = getUserCommunitySlug();
    return getCommunityBySlug(slug) ? slug : DEFAULT_COMMUNITY_SLUG;
  })();
  const homeCommunity = getCommunityBySlug(community);

  const cats = [
    { id: "p2p-trade", l: "P2P Trade", i: "⚡" },
    { id: "bill-pay", l: "Bill Pay", i: "🧾" },
    { id: "marketplace", l: "Marketplace", i: "🏪" },
    { id: "lending", l: "Lending", i: "🤝" },
  ];

  const handleSubmit = async () => {
    if (!desc || !sats) return;
    setSubmitting(true);
    try {
      const amountMsats = parseInt(sats) * 1000;
      // Federation is derived from the community per Pillar 2.3
      // (federation follows the listing). Sellers don't pick a fed
      // directly — they pick a community, and the resolver maps it.
      const mintUrl = resolveFederationForCommunity(community);
      const params: any = {
        description: desc,
        amountMsats: isSubscription ? parseInt(periods) * amountMsats : amountMsats,
        fiatAmount: fiat ? parseFloat(fiat) : undefined,
        fiatCurrency: fiat ? cur : undefined,
        category: cat,
        community,
        fulfillment: cat === "marketplace" ? fulfillment : undefined,
        mintUrl,
      };
      if (isSubscription) {
        params.subscription = {
          totalPeriods: parseInt(periods),
          periodAmountMsats: amountMsats,
          periodDurationSeconds: parseInt(intervalDays) * 86400,
        };
      }
      await onCreate(params);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ padding: 16, maxWidth: 480, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <span style={{ fontSize: 18, fontWeight: 700, color: T.text, fontFamily: T.sans }}>New trade</span>
        <button onClick={onClose} style={{ background: "none", border: "none", color: T.muted, fontSize: 20, cursor: "pointer" }}>×</button>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
        {cats.map(c => (
          <button key={c.id} onClick={() => setCat(c.id)} style={{
            padding: "8px 14px", borderRadius: 20,
            background: cat === c.id ? T.accentDim : T.surface,
            border: `1px solid ${cat === c.id ? T.accent + "66" : T.border}`,
            color: cat === c.id ? T.accent : T.muted,
            fontFamily: T.mono, fontSize: 12, fontWeight: 600,
            cursor: "pointer", transition: "all 0.2s",
          }}>
            {c.i} {c.l}
          </button>
        ))}
      </div>

      {/* Read-only community context. Listings publish into the
          seller's current community (locked v0.2.0 design). To list
          elsewhere, tap a different community pill in Browse first. */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "10px 12px", marginBottom: 16,
        background: T.surface, border: `1px solid ${T.border}`,
        borderRadius: T.rs,
      }}>
        <span style={{ fontSize: 18, lineHeight: 1 }}>
          {homeCommunity?.flagEmoji ?? "🌐"}
        </span>
        <span style={{ flex: 1, fontSize: 12, color: T.text, fontFamily: T.sans }}>
          Listing in <strong>{homeCommunity?.displayName ?? community}</strong>
        </span>
        <span style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, letterSpacing: 0.5 }}>
          YOUR COMMUNITY
        </span>
      </div>

      {categoryAllowsFulfillmentChoice(cat) && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>FULFILLMENT</div>
          <select value={fulfillment} onChange={e => setFulfillment(e.target.value as Fulfillment)}
            style={{ ...inputStyle, color: T.text, background: T.surface }}>
            <option value="physical">Physical</option>
            <option value="service">Service</option>
            <option value="digital">Digital</option>
          </select>
        </div>
      )}

      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>DESCRIPTION</div>
        <input value={desc} onChange={e => setDesc(e.target.value)}
          placeholder={cat === "bill-pay" ? "Pay my electricity bill" : "What are you trading?"}
          style={inputStyle} />
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>AMOUNT (SATS)</div>
          <input type="number" value={sats} onChange={e => setSats(e.target.value)} placeholder="100000" style={inputStyle} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>FIAT</div>
          <div style={{ display: "flex", gap: 6 }}>
            <select value={cur} onChange={e => setCur(e.target.value)}
              style={{ ...inputStyle, width: 70, padding: "12px 6px", fontSize: 12, color: T.text, background: T.surface }}>
              {["USD","EUR","GBP","NGN","KES","TZS","XOF","BRL"].map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <input type="number" value={fiat} onChange={e => setFiat(e.target.value)} placeholder="50" style={{ ...inputStyle, flex: 1 }} />
          </div>
        </div>
      </div>

      {/* Subscription toggle */}
      <div style={{
        marginBottom: 20, padding: 16,
        background: isSubscription ? T.purpleDim : T.surface,
        border: `1px solid ${isSubscription ? T.purple + "33" : T.border}`,
        borderRadius: T.r, transition: "all 0.3s",
      }}>
        <div
          onClick={() => setIsSubscription(!isSubscription)}
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            cursor: "pointer",
          }}
        >
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: isSubscription ? T.purple : T.muted, fontFamily: T.mono }}>
              🔄 SUBSCRIPTION MODE
            </div>
            <div style={{ fontSize: 10, color: T.muted, fontFamily: T.sans, marginTop: 2 }}>
              Periodic release — lock upfront, release in installments
            </div>
          </div>
          <div style={{
            width: 40, height: 22, borderRadius: 11,
            background: isSubscription ? T.purple : T.border,
            padding: 2, transition: "background 0.2s", cursor: "pointer",
          }}>
            <div style={{
              width: 18, height: 18, borderRadius: "50%",
              background: T.text, transition: "transform 0.2s",
              transform: isSubscription ? "translateX(18px)" : "translateX(0)",
            }} />
          </div>
        </div>

        {isSubscription && (
          <div style={{ marginTop: 14 }}>
            <div style={{ display: "flex", gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 10, color: T.purple, fontFamily: T.mono, marginBottom: 4 }}>PERIODS</div>
                <select value={periods} onChange={e => setPeriods(e.target.value)}
                  style={{ ...inputStyle, fontSize: 12, color: T.text, background: T.surface }}>
                  {[2,3,4,5,6,7,8,9,10,11,12,24,36,52].map(n => (
                    <option key={n} value={n}>{n} period{n > 1 ? "s" : ""}</option>
                  ))}
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 10, color: T.purple, fontFamily: T.mono, marginBottom: 4 }}>INTERVAL</div>
                <select value={intervalDays} onChange={e => setIntervalDays(e.target.value)}
                  style={{ ...inputStyle, fontSize: 12, color: T.text, background: T.surface }}>
                  <option value="7">Weekly</option>
                  <option value="14">Bi-weekly</option>
                  <option value="30">Monthly</option>
                  <option value="90">Quarterly</option>
                </select>
              </div>
            </div>

            {sats && (
              <div style={{
                marginTop: 10, padding: "10px 12px",
                background: T.surface, borderRadius: T.rs,
                border: `1px solid ${T.border}`,
              }}>
                <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono }}>SUBSCRIPTION SUMMARY</div>
                <div style={{ fontSize: 13, color: T.purple, fontFamily: T.mono, fontWeight: 700, marginTop: 4 }}>
                  {parseInt(periods)} × {parseInt(sats).toLocaleString()} sats = {(parseInt(periods) * parseInt(sats)).toLocaleString()} sats total
                </div>
                <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginTop: 2 }}>
                  {parseInt(sats).toLocaleString()} sats released every {intervalDays} days
                  {" · "}Total duration: {Math.round(parseInt(periods) * parseInt(intervalDays) / 30)} months
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <button onClick={handleSubmit} disabled={!desc || !sats || submitting} style={{
        width: "100%", padding: "16px",
        background: desc && sats && !submitting ? T.accent : T.surface,
        border: "none", borderRadius: T.rs,
        color: desc && sats && !submitting ? T.bg : T.muted,
        fontFamily: T.mono, fontSize: 14, fontWeight: 700,
        cursor: desc && sats && !submitting ? "pointer" : "default",
        letterSpacing: 0.5, transition: "all 0.2s",
      }}>
        {submitting ? "Publishing…" : "₿ PUBLISH TO RELAYS"}
      </button>
      <div style={{ textAlign: "center", marginTop: 10, fontSize: 10, color: T.muted, fontFamily: T.mono }}>
        kind:38100 CREATE · NIP-44 encrypted · multi-relay
      </div>
    </div>
  );
}
