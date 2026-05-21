import { type EscrowState, EscrowStatus, Role } from "../../escrow-engine/types.js";
import { getCommunityBySlug } from "../../communities/registry.js";
import { T, CAT_ICON, CAT_LABEL, TRINITY_RING_ORDER, fmtSats, refundRecipientFor } from "../theme.js";
import { displayCounterpartyName } from "../decisions.js";
import { pickArbiterFromPool } from "../../arbiters/pool.js";
import { Badge } from "./Badge.js";
import { Dot } from "./Dot.js";

// v0.6.5: short, scannable participant summary above the Trinity Ring.
// The dots already encode this info but are visually de-emphasized;
// users were missing them at a glance and asking "who joined this
// trade?" Adding a text line answers the question without requiring
// a tap into TradeDetail. Truncated npub by default; kind:0 fetcher
// (Me toggle) can plug in later via displayCounterpartyName.
//
// Arbiter handling mirrors TradeDetail's Trinity-Ring preview: when
// the listing's community has a recruited arbiter pool and no JOIN
// ACK has landed yet, surface the deterministic round-robin pick
// (same pubkey LOCK will assign) as "Auto · prefix" — honest because
// pickArbiterFromPool is the same function escrow-bridge.ts uses at
// LOCK time. Without this, third-party browsers see "Empty arbiter"
// on every public listing until LOCK lands, which understates how
// complete the trade actually is.
function shortName(pk: string | null | undefined): string | null {
  if (!pk) return null;
  return displayCounterpartyName({
    npub: pk,
    fetchKind0Enabled: false,
    kind0Name: null,
  });
}
function participantSummary(
  state: EscrowState,
  myRole: string | null,
  previewArbiterPk: string | null,
): string | null {
  const buyer = state.participants.buyer;
  const seller = state.participants.seller;
  const arbiter = state.participants.arbiter;
  const buyerName = myRole === "buyer" ? "You" : shortName(buyer);
  const sellerName = myRole === "seller" ? "You" : shortName(seller);
  // Arbiter copy:
  //   real JOIN  → "Arbiter: xxxx" (or "You" if it's the viewer)
  //   auto pool  → "Arbiter: Auto · xxxx" (preview from pool)
  //   none       → null (omit from sentence; the dots still show Empty)
  let arbiterPhrase: string | null = null;
  if (arbiter) {
    arbiterPhrase = myRole === "arbiter" ? "Arbiter: You" : `Arbiter: ${shortName(arbiter)}`;
  } else if (previewArbiterPk) {
    arbiterPhrase = `Arbiter: Auto · ${shortName(previewArbiterPk)}`;
  }
  if (state.status === "CREATED") {
    // Pre-LOCK: surface seller identity + buyer slot state + arbiter.
    // "Open to a buyer" reads better than "Empty" in a sentence; the
    // dot row keeps the symbolic version for users who prefer that.
    const parts: string[] = [];
    if (sellerName) parts.push(`Posted by ${sellerName}`);
    if (buyerName) parts.push(`Buyer: ${buyerName}`);
    else if (sellerName) parts.push("Open to a buyer");
    if (arbiterPhrase) parts.push(arbiterPhrase);
    return parts.length ? parts.join(" · ") : null;
  }
  // LOCKED and beyond — both buyer/seller slots are filled; arbiter
  // is too (LOCK won't land without one).
  if (buyerName && sellerName) {
    const base = `Buyer: ${buyerName} · Seller: ${sellerName}`;
    return arbiterPhrase ? `${base} · ${arbiterPhrase}` : base;
  }
  return null;
}

// v0.2.0 item 4: variant="non-matching" applies an amber tint per
// chama_browse_amber_tint_sorted. Quiet, not alarmist — it's a
// teaching affordance, not a warning. Tapping a non-matching listing
// triggers the listing-tap dispatch in App.tsx (silent switch when
// balance==0; destroy-confirm modal when balance>0). The community
// flag/name appears inline so users can see at a glance which fed
// they'd be switching to.
export function TradeCard({ state, pubkey, onSelect, variant = "matching" }: {
  state: EscrowState;
  pubkey: string;
  onSelect: () => void;
  variant?: "matching" | "non-matching";
}) {
  const myRole = state.participants.buyer === pubkey ? "buyer"
    : state.participants.seller === pubkey ? "seller"
    : state.participants.arbiter === pubkey ? "arbiter" : null;

  // v0.6.5: same auto-arbiter preview TradeDetail uses, hoisted into
  // Browse cards so third-party scrolls see "2-of-3 already filled"
  // rather than a stranded Empty arbiter slot. The preview ONLY
  // applies before a real JOIN lands and only for communities that
  // have a recruited arbiter pool — pickArbiterFromPool is the same
  // deterministic function escrow-bridge.ts uses at LOCK time, so
  // the previewed pubkey matches the eventual real assignment.
  const previewArbiterPk = state.status === EscrowStatus.CREATED
    && !state.participants[Role.ARBITER]
    && state.communityArbiters.length > 0
    ? (pickArbiterFromPool(state.communityArbiters, state.id, [
        state.participants[Role.BUYER],
        state.participants[Role.SELLER],
      ]) ?? null)
    : null;

  const isAmber = variant === "non-matching";
  const cardBg = isAmber ? T.amberDim : T.card;
  const cardBorder = isAmber ? T.amber + "44" : T.border;
  const listingCommunity = state.community
    ? getCommunityBySlug(state.community)
    : null;

  return (
    <div onClick={onSelect} style={{
      background: cardBg, border: `1px solid ${cardBorder}`,
      borderRadius: T.r, padding: 16, cursor: "pointer",
      transition: "border-color 0.2s",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
            <span style={{ fontSize: 14, opacity: 0.6 }}>{CAT_ICON[state.category] || "📦"}</span>
            {state.status === "EXPIRED" && (
              <span style={{
                fontSize: 9, padding: "2px 6px", borderRadius: 8,
                background: T.redDim, color: T.red,
                fontFamily: T.mono, fontWeight: 600,
              }}>
                ⏰ Expired
              </span>
            )}
            {state.subscription && (
              <span style={{
                fontSize: 9, padding: "2px 6px", borderRadius: 8,
                background: T.purpleDim, color: T.purple,
                fontFamily: T.mono, fontWeight: 600,
              }}>
                🔄 {state.subscription.releasedCount}/{state.subscription.totalPeriods}
              </span>
            )}
            {/* Non-matching cards show the listing's community inline so
                users can see at a glance which fed they'd be switching
                to. Matching cards skip this — it's redundant with the
                Browse-header flag pill. */}
            {isAmber && listingCommunity && (
              <span style={{
                fontSize: 9, padding: "2px 6px", borderRadius: 8,
                background: T.surface, color: T.amber,
                border: `1px solid ${T.amber}33`,
                fontFamily: T.mono, fontWeight: 600,
                display: "inline-flex", alignItems: "center", gap: 3,
              }}>
                <span style={{ fontSize: 10, lineHeight: 1 }}>{listingCommunity.flagEmoji}</span>
                {listingCommunity.disambiguator ?? listingCommunity.displayName}
              </span>
            )}
            <span style={{ fontSize: 13, fontWeight: 600, color: T.text, fontFamily: T.sans, lineHeight: 1.3 }}>
              {state.description}
            </span>
            <span style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, opacity: 0.7 }}>
              {CAT_LABEL[state.category] || state.category}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: T.accent, fontFamily: T.mono }}>
              {fmtSats(state.amountMsats)} sats
            </span>
            {state.fiatAmount && (
              <span style={{ fontSize: 12, color: T.muted, fontFamily: T.mono }}>
                {state.fiatCurrency} {state.fiatAmount.toLocaleString()}
              </span>
            )}
          </div>
        </div>
        <Badge status={state.status} />
      </div>

      {/* v0.6.5: text participant summary above the dots. Answers
          "who joined?" without requiring a tap into detail. The
          Trinity Ring below stays as the symbolic state-at-a-glance.
          Arbiter slot shows "Auto · xxxx" when the community pool
          pre-assigns (no real JOIN yet) — same pubkey LOCK will pick. */}
      {(() => {
        const summary = participantSummary(state, myRole, previewArbiterPk);
        return summary ? (
          <div style={{
            marginTop: 10,
            fontSize: 11, color: T.muted, fontFamily: T.mono,
            textAlign: "center", letterSpacing: 0.2,
          }}>
            {summary}
          </div>
        ) : null;
      })()}

      {/* v0.3.1 Phase 2: participant order sourced from
          TRINITY_RING_ORDER (theme.ts). Phase 6 introduced the
          constant for TradeDetail but TradeCard still had the inline
          [B, S, A] tuple — production smoke caught the drift. The
          §43 grep tripwire test now scans src/ui/ for any inline
          three-element Role literal and fails if it finds one
          outside theme.ts. Forever-asset for brand coherence.
          v0.6.5: arbiter slot renders the pool-derived preview as
          solid + italic "Auto · xxxx" when no real arbiter JOIN
          has landed and a community pool is configured. */}
      <div style={{ display: "flex", gap: 12, marginTop: 8, justifyContent: "center" }}>
        {TRINITY_RING_ORDER.map(role => {
          const realPk = state.participants[role];
          const isAutoArbiter = role === Role.ARBITER && !realPk && !!previewArbiterPk;
          return (
            <Dot
              key={role}
              role={role}
              pk={realPk ?? (isAutoArbiter ? previewArbiterPk : null)}
              isYou={myRole === role}
              voted={!!state.votes[role]}
              outcome={state.votes[role]}
              autoAssigned={isAutoArbiter}
            />
          );
        })}
      </div>

      {/* Expiry info — what happens when time runs out */}
      {state.status === "LOCKED" && state.expiresAt && (() => {
        const now = Math.floor(Date.now() / 1000);
        const remaining = state.expiresAt - now;
        const isExpired = remaining <= 0;
        const isUrgent = remaining > 0 && remaining < 7200;
        return isExpired ? (
          <div style={{
            padding: "12px 16px", borderRadius: T.rs, textAlign: "center",
            background: T.redDim, border: `1px solid ${T.red}33`, marginBottom: 16,
          }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: T.red, fontFamily: T.mono }}>
              ⏰ TRADE EXPIRED
            </div>
            <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginTop: 4 }}>
              🛡️ Community arbiter will auto-vote REFUND → sats return to {refundRecipientFor(state.category)}
            </div>
          </div>
        ) : isUrgent ? (
          <div style={{
            padding: "8px 12px", borderRadius: T.rs, textAlign: "center",
            background: T.redDim, border: `1px solid ${T.red}22`,
            marginBottom: 8, fontSize: 9, color: T.red, fontFamily: T.mono,
          }}>
            ⚠️ Expiring soon — settle or the arbiter will auto-refund to {refundRecipientFor(state.category)}
          </div>
        ) : null;
      })()}

      {state.status === "LOCKED" && (
        <div style={{
          fontSize: 10, color: T.amber, fontFamily: T.mono,
          textAlign: "center", marginBottom: 8,
          padding: "6px 10px", borderRadius: 6,
          background: T.amberDim || T.surface, border: `1px solid ${T.amber}22`,
        }}>
          ⏱️ If expired → arbiter auto-refunds to {refundRecipientFor(state.category)}
        </div>
      )}

      {state.expiresAt && state.status !== "COMPLETED" && state.status !== "CANCELLED" && state.status !== "EXPIRED" && state.status !== "APPROVED" && state.status !== "CLAIMED" && (() => {
        const rem = state.expiresAt - Math.floor(Date.now() / 1000);
        if (rem <= 0) return <div style={{ fontSize: 9, color: T.red, fontFamily: T.mono, textAlign: "center", marginTop: 8 }}>EXPIRED</div>;
        const h = Math.floor(rem / 3600);
        const m = Math.floor((rem % 3600) / 60);
        const color = rem < 600 ? T.red : rem < 3600 ? T.amber : T.muted;
        return (
          <div style={{ fontSize: 9, color, fontFamily: T.mono, textAlign: "center", marginTop: 8 }}>
            {h > 0 ? `${h}h ${m}m remaining` : `${m}m remaining`}
          </div>
        );
      })()}

      {/* Escrow ID — tap to copy */}
      <div
        onClick={(e) => {
          e.stopPropagation();
          const id = state.id;
          if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(id).catch(() => {});
          } else {
            const el = document.createElement("input");
            el.value = id;
            document.body.appendChild(el);
            el.select();
            document.execCommand("copy");
            document.body.removeChild(el);
          }
          const t = e.currentTarget;
          const orig = t.textContent;
          t.textContent = "✅ Copied!";
          t.style.color = "#22c55e";
          setTimeout(() => { t.textContent = orig; t.style.color = ""; }, 1200);
        }}
        style={{
          fontSize: 10, color: "#6b6980", fontFamily: "'JetBrains Mono','SF Mono','Fira Code',monospace",
          textAlign: "center", marginTop: 8, cursor: "pointer",
          padding: "4px 8px", borderRadius: 6,
          transition: "all 0.2s",
        }}
      >
        {state.id} — tap to copy
      </div>
    </div>
  );
}
