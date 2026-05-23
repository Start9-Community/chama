import { type EscrowState, EscrowStatus } from "../../escrow-engine/types.js";
import { getCommunityBySlug } from "../../communities/registry.js";
import { T, CAT_ICON, fmtSats, STATUS } from "../theme.js";

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
  const myRole = state.participants.buyer === pubkey ? "Buyer"
    : state.participants.seller === pubkey ? "Seller"
    : state.participants.arbiter === pubkey ? "Arbiter" : null;
  const isAmber = variant === "non-matching";
  const cardBg = isAmber ? T.amberDim : T.card;
  const cardBorder = isAmber ? T.amber + "44" : T.border;
  const listingCommunity = state.community
    ? getCommunityBySlug(state.community)
    : null;
  const status = STATUS[state.status] ?? STATUS.CREATED;
  const timeLine = compactTimeRemaining(state);
  const fiatLine = state.fiatAmount != null && state.fiatCurrency
    ? `${state.fiatAmount.toLocaleString()} ${state.fiatCurrency}`
    : null;
  const secondaryLine = fiatLine ?? fulfillmentLabel(state.fulfillment);

  return (
    <div onClick={onSelect} style={{
      background: cardBg, border: `1px solid ${cardBorder}`,
      borderRadius: T.r, padding: 14, cursor: "pointer",
      transition: "border-color 0.2s",
    }}>
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
            {isAmber && listingCommunity && (
              <span style={{
                fontSize: 10, padding: "3px 8px", borderRadius: 999,
                background: T.surface, color: T.amber,
                border: `1px solid ${T.amber}33`,
                fontFamily: T.mono, fontWeight: 700,
                display: "inline-flex", alignItems: "center", gap: 3,
              }}>
                <span style={{ fontSize: 10, lineHeight: 1 }}>{listingCommunity.flagEmoji}</span>
                {listingCommunity.disambiguator ?? listingCommunity.displayName}
              </span>
            )}
          </div>

          <div style={{
            fontSize: 17, fontWeight: 800, color: T.text,
            fontFamily: T.sans, lineHeight: 1.2, marginBottom: 10,
            overflow: "hidden", textOverflow: "ellipsis",
            display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
          }}>
            {state.description}
          </div>

          <div style={{
            display: "flex", alignItems: "baseline", gap: 7,
            minWidth: 0, flexWrap: "wrap",
          }}>
            <span style={{ fontSize: 23, fontWeight: 800, color: T.accent, fontFamily: T.mono, lineHeight: 1 }}>
              {fmtSats(state.amountMsats)} sats
            </span>
            <span style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, lineHeight: 1.4 }}>
              {secondaryLine}
            </span>
          </div>
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
            {compactStatusLabel(state.status)}
          </span>
          <div>
            {myRole && (
              <div style={{
                fontSize: 10, color: T.muted, fontFamily: T.mono,
                marginBottom: timeLine ? 4 : 0,
              }}>
                {myRole === "Buyer" || myRole === "Seller" ? "You" : myRole}
              </div>
            )}
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
    </div>
  );
}

function shortCategoryLabel(category: string): string {
  if (category === "p2p-trade") return "P2P";
  if (category === "bill-pay") return "Bill Pay";
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

function compactStatusLabel(status: EscrowStatus): string {
  if (status === EscrowStatus.CREATED) return "Open";
  if (status === EscrowStatus.LOCKED) return "Escrow";
  if (status === EscrowStatus.APPROVED) return "Claim";
  if (status === EscrowStatus.CLAIMED) return "Settling";
  if (status === EscrowStatus.COMPLETED) return "Done";
  if (status === EscrowStatus.EXPIRED) return "Timed out";
  if (status === EscrowStatus.CANCELLED) return "Closed";
  return status;
}

function compactTimeRemaining(state: EscrowState): { label: string; tone: string } | null {
  if (!state.expiresAt) return null;
  if (
    state.status === EscrowStatus.COMPLETED
    || state.status === EscrowStatus.CANCELLED
    || state.status === EscrowStatus.CLAIMED
  ) {
    return null;
  }
  const remaining = state.expiresAt - Math.floor(Date.now() / 1000);
  if (remaining <= 0) return { label: "Expired", tone: T.red };
  const hours = Math.floor(remaining / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  const tone = remaining < 600 ? T.red : remaining < 3600 ? T.amber : T.muted;
  if (hours > 0) return { label: `${hours}h ${minutes}m`, tone };
  return { label: `${minutes}m`, tone };
}
