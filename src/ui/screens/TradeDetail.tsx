import { useState } from "react";
import {
  type EscrowState,
  Role,
  Outcome,
  EscrowStatus,
} from "../../escrow-engine/types.js";
import { getWinner } from "../../escrow-engine/state-machine.js";
import { getVoteLabel } from "../../labels/vote-labels.js";
import {
  listSavedHandles,
  maskHandle,
  handleDisplayForViewer,
} from "../../payments/saved-handles.js";
import { getRailByKey } from "../../payments/rail-registry.js";
import {
  T, STATUS, ROLE_COLOR, CAT_LABEL, TRINITY_RING_ORDER,
  fmtSats, refundRecipientFor, inputStyle,
} from "../theme.js";
import { decideTradeDetailFraming, decideVotePrompt } from "../decisions.js";
import { pickArbiterFromPool } from "../../arbiters/pool.js";
import {
  hasStateBExplained,
  markStateBExplained,
} from "./state-b-explainer.js";
import { Badge } from "../components/Badge.js";
import { Dot } from "../components/Dot.js";
import { CountdownTimer } from "../components/CountdownTimer.js";
import { SubscriptionTimeline } from "../components/SubscriptionTimeline.js";
import { ChatPanel } from "../panels/ChatPanel.js";

export function TradeDetail({
  state, pubkey, homeCommunity, bootProbeFailed, fundingInProgress,
  onBack, onVote, onClaim, onJoin, onLock, onSendChat, onReleasePeriod, onOpenSettings,
}: {
  state: EscrowState; pubkey: string;
  /** User's home community slug — drives State A vs State B subtitle
   *  on CREATED listings (item 1, listing-detail half). For LOCKED+
   *  trades the subtitle reflects trade status, not framing. */
  homeCommunity: string | null;
  /** v0.3.1 Phase 3: when true (bootProbeState === "failed"), Fund +
   *  Claim buttons render disabled with the "Federation unreachable —
   *  reconnect first" subtitle. The Reconnect CTA lives in ChamaBar
   *  per the Phase 3 directive (single source of truth for Reconnect);
   *  TradeDetail just gates its action buttons. The boolean is
   *  computed by App.tsx from fedimint.bootProbeState — passing the
   *  bool keeps TradeDetail's API minimal and explicit. */
  bootProbeFailed: boolean;
  /** v0.6.5: true while another runFundAndLock flow is mid-flight on
   *  the shared OPFS wallet. Disables Fund and swaps its label to
   *  "{lockLabel} unavailable" + explanatory subtitle so users see
   *  why the button is greyed rather than just dead. */
  fundingInProgress: boolean;
  onBack: () => void;
  onVote: (outcome: Outcome) => void;
  onClaim: () => Promise<void>;
  onJoin: (role: Role) => void;
  onLock: (savedHandleId?: string) => Promise<void>;
  onSendChat: (message: string) => void;
  onReleasePeriod?: (periodIndex: number) => void | Promise<void>;
  onOpenSettings?: () => void;
}) {
  // v0.2.0 item 1: State A/B framing for CREATED listings. By the time
  // the detail screen renders, the silent re-init has already landed
  // the user on the listing's fed (the openEscrow dispatch in
  // App.tsx handles that). State B's narration is past-tense:
  // "Running on BLF · we switched you in for this trade."
  const framing = decideTradeDetailFraming({
    listingMintUrl: state.mintUrl,
    listingCommunity: state.community,
    homeCommunity,
  });
  const [voting, setVoting] = useState(false);
  const [joining, setJoining] = useState(false);
  const [locking, setLocking] = useState(false);
  // v0.3.0 Phase 3: claiming flag survives the ClaimPayoutModal lifetime
  // via the promise-based onClaim contract (mirrors Phase 2's onLock).
  // Disables the Claim button while the modal is open so re-taps can't
  // queue another flow.
  const [claiming, setClaiming] = useState(false);
  const [selectedHandleId, setSelectedHandleId] = useState<string>("");
  // v0.3.0 Phase 6: one-time educational card for State B (cross-fed
  // listing). Renders ONCE per pubkey, same gate-pattern as v0.2.0's
  // first-publish honesty card. Dismiss is sticky in localStorage.
  const [stateBDismissed, setStateBDismissed] = useState(() => hasStateBExplained(pubkey));
  const s = STATUS[state.status] || STATUS.CREATED;
  const myRole = state.participants.buyer === pubkey ? Role.BUYER
    : state.participants.seller === pubkey ? Role.SELLER
    : state.participants.arbiter === pubkey ? Role.ARBITER : null;
  // v0.6.5: deterministic preview of which arbiter LOCK will pick from
  // the community pool, used purely for the Trinity-Ring "auto-assigned"
  // dot on CREATED listings that don't yet have a JOINed arbiter. Same
  // function escrow-bridge.ts uses at LOCK time, so the predicted
  // pubkey matches the eventual real assignment.
  const previewArbiterPk = state.status === EscrowStatus.CREATED
    && !state.participants[Role.ARBITER]
    && state.communityArbiters.length > 0
    ? (pickArbiterFromPool(state.communityArbiters, state.id) ?? null)
    : null;
  const votePrompt = decideVotePrompt(state, pubkey);
  const winner = getWinner(state);
  const iAmWinner = winner?.pubkey === pubkey;

  const expectedLocker = state.category === "marketplace" ? Role.BUYER
    : state.category === "lending" ? Role.SELLER
    : (state.category === "p2p-trade" || state.category === "bill-pay") ? Role.SELLER
    : null;
  const canILock = !expectedLocker || myRole === expectedLocker;

  const lockLabel = state.category === "marketplace" ? "Pay for Item"
    : state.category === "lending" ? "Fund Loan"
    : state.category === "bill-pay" ? "Lock Sats"
    : state.category === "p2p-trade" ? "Fund Escrow"
    : "Lock Sats";

  const handleVote = async (outcome: Outcome) => {
    setVoting(true);
    try { onVote(outcome); } finally { setTimeout(() => setVoting(false), 1000); }
  };

  return (
    <div style={{ padding: 16, maxWidth: 480, margin: "0 auto" }}>
      <button onClick={onBack} style={{
        background: "none", border: "none", color: T.muted,
        fontFamily: T.mono, fontSize: 12, cursor: "pointer",
        padding: "4px 0", marginBottom: 16,
      }}>
        ← Back
      </button>

      {/* Header card */}
      <div style={{
        background: T.card, border: `1px solid ${T.border}`,
        borderRadius: T.r, padding: 20, marginBottom: 16,
        position: "relative", overflow: "hidden",
      }}>
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: `linear-gradient(90deg,${s.c},${s.c}00)` }} />
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
          <Badge status={state.status} />
          <span style={{ fontSize: 10, color: T.muted, fontFamily: T.mono }}>
            {state.createdAt ? new Date(state.createdAt * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""}
            {" · "}{state.id}
          </span>
        </div>
        <div style={{ fontSize: 16, fontWeight: 600, color: T.text, fontFamily: T.sans, marginBottom: 4, lineHeight: 1.4 }}>
          {state.description}
        </div>
        <div style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          padding: "3px 10px", borderRadius: 12, marginBottom: 12,
          background: T.surface, border: "1px solid " + T.border,
          fontSize: 10, fontFamily: T.mono, color: T.muted,
        }}>
          {CAT_LABEL[state.category] || state.category}
        </div>
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
          <div>
            <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginBottom: 2 }}>AMOUNT</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: T.accent, fontFamily: T.mono }}>
              {fmtSats(state.amountMsats)} <span style={{ fontSize: 11, color: T.muted }}>sats</span>
            </div>
          </div>
          {state.fiatAmount && (
            <div>
              <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginBottom: 2 }}>FIAT</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: T.text, fontFamily: T.mono }}>
                {state.fiatCurrency} {state.fiatAmount!.toLocaleString()}
              </div>
            </div>
          )}
          {myRole && (
            <div>
              <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginBottom: 2 }}>YOUR ROLE</div>
              <div style={{ fontSize: 14, fontWeight: 700, fontFamily: T.mono, color: ROLE_COLOR[myRole], textTransform: "capitalize" }}>
                {myRole}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* v0.2.0 item 1: State A vs State B narration. Only fires on
          CREATED listings (the funding moment); LOCKED+ trades have
          a clearer status surface elsewhere and don't need the
          home/listing-fed framing. */}
      {state.status === EscrowStatus.CREATED && framing.kind === "state-a" && (
        <div style={{
          padding: "8px 12px", marginBottom: 12,
          fontSize: 11, color: T.muted, fontFamily: T.mono,
          textAlign: "center" as const, lineHeight: 1.5,
        }}>
          {framing.sameFedSameCommunity
            ? "Same community as your Chama"
            : "Same federation as your Chama · cross-community trade"}
        </div>
      )}
      {/* v0.3.0 Phase 6: one-time State B educational card. Renders
          ONCE per pubkey above the permanent State B callout. Dismiss
          is sticky via chama_state_b_explained_<pubkey> in localStorage
          (same shape as v0.2.0's chama_first_publish_done_<pubkey>).
          Pillar 2.7: educate at the first opportunity, never lecture
          returning users. */}
      {state.status === EscrowStatus.CREATED && framing.kind === "state-b" && !stateBDismissed && (
        <div style={{
          padding: 14, marginBottom: 12,
          background: T.accentDim, border: `1px solid ${T.accent}33`,
          borderRadius: T.r,
        }}>
          <div style={{
            fontSize: 11, fontWeight: 700, color: T.accent, fontFamily: T.mono,
            letterSpacing: 1, marginBottom: 8,
          }}>
            FIRST CROSS-FEDERATION TRADE? HEADS UP
          </div>
          <div style={{ fontSize: 12, color: T.text, fontFamily: T.sans, lineHeight: 1.55, marginBottom: 12 }}>
            Your wallet was on {framing.homeFlagEmoji} {framing.homeCommunityName}.
            Since this listing is on {framing.listingFlagEmoji} {framing.listingCommunityName} and
            your balance was 0 sats, we switched automatically. No funds moved
            on Lightning — fresh wallet on {framing.listingFlagEmoji} {framing.listingCommunityName} for
            this trade. Switching back is just another tap.
          </div>
          <button
            onClick={() => {
              markStateBExplained(pubkey);
              setStateBDismissed(true);
            }}
            style={{
              background: "none", border: `1px solid ${T.accent}66`,
              color: T.accent, fontFamily: T.mono, fontSize: 11, fontWeight: 700,
              padding: "6px 12px", borderRadius: T.rs,
              cursor: "pointer", letterSpacing: 0.3,
            }}
          >
            Got it
          </button>
        </div>
      )}
      {state.status === EscrowStatus.CREATED && framing.kind === "state-b" && (
        <div style={{
          padding: 14, marginBottom: 12,
          background: T.surface, border: `1px solid ${T.amber}33`,
          borderRadius: T.rs,
        }}>
          <div style={{
            fontSize: 11, fontWeight: 700, color: T.amber, fontFamily: T.mono,
            letterSpacing: 1, marginBottom: 8,
          }}>
            CROSS-FEDERATION
          </div>
          {/* v0.3.0 Phase 6: tightened from
                "Running on {emoji} {name} · we switched you in for this trade."
              to drop "we" — the system did it; the framing is the user's. */}
          <div style={{ fontSize: 13, color: T.text, fontFamily: T.sans, lineHeight: 1.55, marginBottom: 6 }}>
            Running on {framing.listingFlagEmoji} <strong>{framing.listingCommunityName}</strong> · switched in for this trade
          </div>
          {/* v0.3.0 Phase 6: educational essay moved to the one-time
              card above. This callout is now a single reassuring
              sentence, the only thing returning State-B users see. */}
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, lineHeight: 1.5 }}>
            Your Chama switched automatically — no funds at risk.
          </div>
        </div>
      )}

      {/* Subscription timeline */}
      {state.subscription && (
        <SubscriptionTimeline
          subscription={state.subscription}
          onRelease={async (periodIndex) => {
            try {
              await onReleasePeriod?.(periodIndex);
            } catch (e: any) {
              console.error("[chama] Period release failed:", e);
            }
          }}
        />
      )}

      {/* Community arbiter pool indicator */}
      {state.communityArbiters && state.communityArbiters.length > 0 && (
        <div style={{
          marginBottom: 12, padding: "8px 14px", borderRadius: T.rs,
          background: T.purpleDim, border: `1px solid ${T.purple}22`,
          display: "flex", alignItems: "center", gap: 8,
        }}>
          <span style={{ fontSize: 14 }}>🛡️</span>
          <span style={{ fontSize: 10, color: T.purple, fontFamily: T.mono }}>
            Community arbiter pool: {state.communityArbiters.length} backup{state.communityArbiters.length !== 1 ? "s" : ""}
            {" · "}SSS share encrypted to all
          </span>
        </div>
      )}

      {/* Expiry policy — visible on all LOCKED trades */}
      {state.status === "LOCKED" && (() => {
        const now = Math.floor(Date.now() / 1000);
        const remaining = state.expiresAt - now;
        const isExpired = remaining <= 0;
        const isUrgent = remaining > 0 && remaining < 7200;
        return (
          <div style={{ marginBottom: 12 }}>
            {isExpired ? (
              <div style={{
                padding: "14px 16px", borderRadius: 8, textAlign: "center",
                background: T.redDim, border: `1px solid ${T.red}44`,
              }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: T.red, fontFamily: T.mono }}>
                  ⏰ TRADE EXPIRED
                </div>
                <div style={{ fontSize: 11, color: T.text, fontFamily: T.sans, marginTop: 6 }}>
                  🛡️ Community arbiter will auto-vote REFUND
                </div>
                <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginTop: 4 }}>
                  Sats will be returned to the {refundRecipientFor(state.category)} automatically
                </div>
              </div>
            ) : (
              <div style={{
                padding: "8px 12px", borderRadius: 6, textAlign: "center",
                background: isUrgent ? T.redDim : T.surface,
                border: `1px solid ${isUrgent ? T.red + "33" : T.amber + "22"}`,
              }}>
                <span style={{
                  fontSize: 10, fontFamily: T.mono,
                  color: isUrgent ? T.red : T.amber,
                }}>
                  {isUrgent ? "⚠️ Expiring soon! " : "⏱️ "}
                  If time expires → arbiter auto-refunds to {refundRecipientFor(state.category)}
                </span>
              </div>
            )}
          </div>
        );
      })()}

      {state.expiresAt
        && state.status !== "COMPLETED"
        && state.status !== "CANCELLED"
        && state.status !== "EXPIRED"
        && state.status !== "APPROVED"
        && state.status !== "CLAIMED" && (
        <div style={{ marginBottom: 16 }}>
          <CountdownTimer expiresAt={state.expiresAt} />
        </div>
      )}

      {/* Participants — Trinity Ring order: Buyer · Arbiter · Seller.
          Order is sourced from theme.TRINITY_RING_ORDER. PHILOSOPHY.md
          §5.2 places the arbiter at the apex with buyer/seller flanking
          below; this row mirrors that arrangement. v0.2.0 shipped with
          B/S/A — the §43 test pins B/A/S so future refactors can't
          silently revert the order.

          v0.6.5 — auto-assigned arbiter preview (see previewArbiterPk
          above the return). For freshly-created listings on communities
          with a recruited arbiter pool (BLF etc.), the arbiter slot
          would otherwise read "Empty" until LOCK lands. Pre-filling
          with the same pubkey LOCK will pick (via pickArbiterFromPool
          keyed on escrow id) is honest, not speculative — the round-
          robin is deterministic. The Dot renders this slot dimmer +
          italic "Auto · xxxx" so a real JOIN remains distinguishable. */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: T.r, padding: 20, marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 16 }}>PARTICIPANTS</div>
        <div style={{ display: "flex", justifyContent: "space-around" }}>
          {TRINITY_RING_ORDER.map(role => {
            const realPk = state.participants[role];
            const isAutoArbiter = role === Role.ARBITER && !realPk && !!previewArbiterPk;
            return (
              <Dot key={role} role={role}
                pk={realPk ?? (isAutoArbiter ? previewArbiterPk : null)}
                isYou={myRole === role}
                voted={!!state.votes[role]} outcome={state.votes[role]}
                autoAssigned={isAutoArbiter} />
            );
          })}
        </div>
      </div>

      {/* JOIN buttons — show when user is not a participant and slots are open */}
      {!myRole && state.status === EscrowStatus.CREATED && (
        <div style={{
          background: T.card, border: `1px solid ${T.border}`,
          borderRadius: T.r, padding: 20, marginBottom: 16,
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 12 }}>
            JOIN THIS TRADE
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            {!state.participants.buyer && (
              <button disabled={joining} onClick={async () => {
                setJoining(true);
                try { await onJoin(Role.BUYER); } finally { setJoining(false); }
              }} style={{
                flex: 1, padding: "14px", borderRadius: T.rs,
                background: T.accentDim, border: `1px solid ${T.accent}44`,
                color: T.accent, fontFamily: T.mono, fontSize: 13, fontWeight: 700,
                cursor: joining ? "default" : "pointer", transition: "all 0.2s",
              }}>
                {joining ? "Joining..." : "Join as Buyer"}
              </button>
            )}
            {/* v0.6.5: hide the Join-as-Arbiter affordance when the
                community pool will auto-assign one. The slot reads as
                filled (Trinity Ring dot is solid + "Auto · xxxx"), so
                offering volunteer-join would contradict that and create
                two competing arbiters. Communities without a recruited
                pool still show this button. */}
            {!state.participants.arbiter && !previewArbiterPk && (
              <button disabled={joining} onClick={async () => {
                setJoining(true);
                try { await onJoin(Role.ARBITER); } finally { setJoining(false); }
              }} style={{
                flex: 1, padding: "14px", borderRadius: T.rs,
                background: T.purpleDim, border: `1px solid ${T.purple}44`,
                color: T.purple, fontFamily: T.mono, fontSize: 13, fontWeight: 700,
                cursor: joining ? "default" : "pointer", transition: "all 0.2s",
              }}>
                {joining ? "Joining..." : "Join as Arbiter"}
              </button>
            )}
          </div>
          {!state.participants.seller && (
            <button disabled={joining} onClick={async () => {
              setJoining(true);
              try { await onJoin(Role.SELLER); } finally { setJoining(false); }
            }} style={{
              width: "100%", marginTop: 10, padding: "14px", borderRadius: T.rs,
              background: T.tealDim, border: `1px solid ${T.teal}44`,
              color: T.teal, fontFamily: T.mono, fontSize: 13, fontWeight: 700,
              cursor: joining ? "default" : "pointer", transition: "all 0.2s",
            }}>
              {joining ? "Joining..." : "Join as Seller"}
            </button>
          )}
        </div>
      )}

      {/* CREATED — atomic lock surface for the locker. Per PR 1: there is
          no FUNDED state and no readiness ceremony. The instant the
          locker spends from their Chama, shares are split and LOCK
          publishes (CREATED → LOCKED in one event). */}
      {state.status === EscrowStatus.CREATED && myRole && canILock && (() => {
        const fiatCategory = state.category === "p2p-trade"
          || state.category === "bill-pay"
          || state.category === "lending";
        const allHandles = fiatCategory ? listSavedHandles() : [];
        return (
        <div style={{
          background: T.card, border: `1px solid ${T.accent}44`,
          borderRadius: T.r, padding: 20, marginBottom: 16,
        }}>
          <div style={{
            fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono,
            letterSpacing: 1, marginBottom: 12,
          }}>
            ATOMIC LOCK
          </div>
          <div style={{
            textAlign: "center", fontFamily: T.mono, fontSize: 12,
            color: T.accent, marginBottom: 14,
          }}>
            {state.participants.buyer
              ? "Spending from your Chama will split shares and publish LOCK in one step."
              : "Waiting for buyer to acknowledge the trade…"}
          </div>

          {/* Handle reveal picker for fiat categories */}
          {fiatCategory && (
            <div style={{ marginBottom: 14 }}>
              <div style={{
                fontSize: 10, fontWeight: 600, color: T.muted,
                fontFamily: T.mono, letterSpacing: 0.5, marginBottom: 6,
              }}>
                REVEAL HANDLE TO PARTICIPANTS
              </div>
              {allHandles.length === 0 ? (
                <div style={{
                  padding: "10px 12px", borderRadius: T.rs,
                  background: T.surface, border: `1px dashed ${T.border}`,
                  color: T.muted, fontFamily: T.mono, fontSize: 11,
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                }}>
                  <span>No saved handles. Lock will proceed without one.</span>
                  {onOpenSettings && (
                    <button onClick={onOpenSettings} style={{
                      background: "none", border: "none",
                      color: T.accent, fontFamily: T.mono, fontSize: 11,
                      fontWeight: 700, cursor: "pointer", padding: 0,
                    }}>+ Add</button>
                  )}
                </div>
              ) : (
                <select
                  value={selectedHandleId}
                  onChange={e => setSelectedHandleId(e.target.value)}
                  style={{ ...inputStyle, color: T.text, background: T.surface }}
                >
                  <option value="">— don't reveal a handle —</option>
                  {allHandles.map(h => {
                    const rail = getRailByKey(h.rail);
                    return (
                      <option key={h.id} value={h.id}>
                        {(rail?.displayName || h.rail) + " · " + maskHandle(h.handle)}
                      </option>
                    );
                  })}
                </select>
              )}
            </div>
          )}

          {/* v0.3.1 Phase 3 + v0.6.5: Fund disables on bootProbeFailed
              (federation unreachable) and on fundingInProgress (another
              runFundAndLock flow holds the shared OPFS wallet), in
              addition to its existing locking/buyer guards. When mid-
              funding, the button label itself changes to "{lockLabel}
              unavailable" so the disabled state reads as intentional
              rather than broken. */}
          <button
            disabled={locking || fundingInProgress || !state.participants.buyer || bootProbeFailed}
            title={fundingInProgress ? "Another funding operation is in progress. Complete it first." : undefined}
            onClick={async () => {
              setLocking(true);
              try {
                await onLock(selectedHandleId || undefined);
              } finally {
                setLocking(false);
              }
            }}
            style={{
              width: "100%", padding: "16px", borderRadius: T.rs,
              background: locking || fundingInProgress || !state.participants.buyer || bootProbeFailed
                ? T.surface
                : `linear-gradient(135deg, ${T.accent}, ${T.amber})`,
              border: "none",
              color: locking || fundingInProgress || !state.participants.buyer || bootProbeFailed ? T.muted : T.bg,
              fontFamily: T.mono, fontSize: 14, fontWeight: 800,
              cursor: locking || fundingInProgress || !state.participants.buyer || bootProbeFailed ? "default" : "pointer",
              letterSpacing: 0.5, transition: "all 0.2s",
            }}
          >
            {locking ? "Funding…" : fundingInProgress ? lockLabel + " unavailable" : "⚡ " + lockLabel + " · " + fmtSats(state.amountMsats) + " sats"}
          </button>
          {fundingInProgress && (
            <div style={{
              textAlign: "center", marginTop: 8,
              fontSize: 10, color: T.amber, fontFamily: T.mono,
            }}>
              Another funding operation is in progress. Complete it first.
            </div>
          )}
          {bootProbeFailed && !fundingInProgress && (
            <div style={{
              textAlign: "center", marginTop: 8,
              fontSize: 10, color: T.amber, fontFamily: T.mono,
            }}>
              Federation unreachable — reconnect first
            </div>
          )}
          <div style={{
            textAlign: "center", marginTop: 8,
            fontSize: 9, color: T.muted, fontFamily: T.mono,
          }}>
            Real 2-of-3 Shamir split · ecash spent from your Chama
          </div>
        </div>
        );
      })()}

      {/* Revealed payment handle for the trade's three participants. */}
      {state.status === EscrowStatus.LOCKED && state.lock.handle && (
        <div style={{
          background: T.card, border: `1px solid ${T.amber}44`,
          borderRadius: T.r, padding: 16, marginBottom: 16,
        }}>
          <div style={{
            fontSize: 11, fontWeight: 600, color: T.muted,
            fontFamily: T.mono, letterSpacing: 1, marginBottom: 8,
          }}>
            PAYMENT HANDLE
            {state.lock.handle.rail && (
              <span style={{ color: T.amber, marginLeft: 8 }}>
                · {getRailByKey(state.lock.handle.rail)?.displayName || state.lock.handle.rail}
              </span>
            )}
          </div>
          <div style={{
            fontFamily: T.mono, fontSize: 14, color: T.text,
            padding: "10px 12px", background: T.surface,
            borderRadius: T.rs, border: `1px solid ${T.border}`,
            wordBreak: "break-all" as const,
          }} title={myRole ? state.lock.handle.value : undefined}>
            {handleDisplayForViewer(state.lock.handle.value, !!myRole)}
          </div>
          {/* v0.6.5: networks the seller accepts on this handle.
              Phone numbers serve many mobile-money networks; without
              this chip row the buyer has no honest way to know which
              one to use. Only renders for participants (the cleartext
              value itself is hidden from non-participants anyway, so
              the network tags would be a privacy leak there). */}
          {!!myRole && state.lock.handle.networks && state.lock.handle.networks.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{
                fontSize: 9, color: T.muted, fontFamily: T.mono,
                letterSpacing: 0.3, marginBottom: 5,
              }}>
                ACCEPTS
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {state.lock.handle.networks.map(networkKey => (
                  <span key={networkKey} style={{
                    padding: "4px 10px", borderRadius: 12,
                    background: T.tealDim,
                    border: `1px solid ${T.teal}66`,
                    color: T.teal, fontFamily: T.mono,
                    fontSize: 10, fontWeight: 700, letterSpacing: 0.2,
                  }}>
                    {getRailByKey(networkKey)?.displayName || networkKey}
                  </span>
                ))}
              </div>
            </div>
          )}
          <div style={{
            fontSize: 9, color: T.muted, fontFamily: T.mono,
            marginTop: 8, lineHeight: 1.4,
          }}>
            {myRole
              ? "Revealed only to the three trade participants via the LOCK event."
              : "Hidden — only the buyer, seller, and arbiter can see the full handle."}
          </div>
        </div>
      )}

      {/* Vote tally */}
      {(state.status === EscrowStatus.LOCKED || state.status === EscrowStatus.APPROVED ||
        state.status === EscrowStatus.CLAIMED || state.status === EscrowStatus.COMPLETED) && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: T.r, padding: 20, marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 16 }}>STATUS</div>
          <div style={{ display: "flex", gap: 16, justifyContent: "center" }}>
            <div style={{ textAlign: "center", flex: 1 }}>
              <div style={{ fontSize: 32, fontWeight: 900, color: T.green, fontFamily: T.mono, lineHeight: 1 }}>
                {Object.values(state.votes).filter(v => v === Outcome.RELEASE).length}
              </div>
              <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginTop: 4 }}>RELEASE ₿</div>
            </div>
            <div style={{ width: 1, background: T.border }} />
            <div style={{ textAlign: "center", flex: 1 }}>
              <div style={{ fontSize: 32, fontWeight: 900, color: T.amber, fontFamily: T.mono, lineHeight: 1 }}>
                {Object.values(state.votes).filter(v => v === Outcome.REFUND).length}
              </div>
              <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginTop: 4 }}>REFUND ₿</div>
            </div>
            {state.resolvedOutcome && (
              <>
                <div style={{ width: 1, background: T.border }} />
                <div style={{ textAlign: "center", flex: 1.2 }}>
                  <div style={{ fontSize: 13, fontWeight: 800, fontFamily: T.mono, color: state.resolvedOutcome === Outcome.RELEASE ? T.green : T.amber }}>
                    {state.resolvedOutcome.toUpperCase()} ✓
                  </div>
                  <div style={{ fontSize: 9, color: T.muted, marginTop: 4, fontFamily: T.mono }}>DECISION</div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Vote buttons — vertical-aware copy from the label dictionary.
          v0.2.0 item 9: when the user is the arbiter, the vote
          buttons mirror role colors per Pillar 5.2 — purple for
          "side with buyer," orange for "side with seller." Buyer
          and seller voting on their own experience keep the
          green/amber semantics (happy path / refund).

          Color derivation: RELEASE flows sats to the role that
          didn't lock. For marketplace, buyer locks → RELEASE goes
          to seller. For other verticals, seller locks → RELEASE
          goes to buyer. The arbiter's button color reflects who
          actually receives the sats on each vote, removing the
          ambiguity that otherwise sits in the highest-stakes UI
          interaction in the product. */}
      {votePrompt.kind === "waiting" && (
        <div style={{
          padding: "12px 14px", borderRadius: T.rs,
          background: T.surface, border: `1px solid ${T.border}`,
          color: T.muted, fontFamily: T.mono, fontSize: 11,
          lineHeight: 1.5, textAlign: "center", marginBottom: 16,
        }}>
          {votePrompt.message}
        </div>
      )}

      {votePrompt.kind === "buttons" && myRole && (() => {
        const isArbiter = myRole === Role.ARBITER;
        const isMarketplace = state.category === "marketplace";
        const showRelease = votePrompt.outcomes.includes(Outcome.RELEASE);
        const showRefund = votePrompt.outcomes.includes(Outcome.REFUND);
        // Who wins on RELEASE / REFUND
        const releaseWinner = isMarketplace ? "seller" : "buyer";
        const refundWinner = isMarketplace ? "buyer" : "seller";

        const arbiterReleaseColor = ROLE_COLOR[releaseWinner];
        const arbiterRefundColor = ROLE_COLOR[refundWinner];

        const releaseBg = isArbiter ? `${arbiterReleaseColor}22` : T.greenDim;
        const releaseBorder = isArbiter ? `${arbiterReleaseColor}66` : `${T.green}44`;
        const releaseText = isArbiter ? arbiterReleaseColor : T.green;

        const refundBg = isArbiter
          ? `${arbiterRefundColor}22`
          : state.subscription ? T.redDim : T.amberDim;
        const refundBorder = isArbiter
          ? `${arbiterRefundColor}66`
          : `${state.subscription ? T.red : T.amber}44`;
        const refundText = isArbiter
          ? arbiterRefundColor
          : state.subscription ? T.red : T.amber;

        return (
          <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
            {showRelease && (
              <button disabled={voting} onClick={() => handleVote(Outcome.RELEASE)} style={{
                flex: 1, padding: "16px", borderRadius: T.rs,
                background: voting ? T.surface : releaseBg,
                border: `1px solid ${releaseBorder}`,
                color: releaseText,
                fontFamily: T.mono, fontSize: 14, fontWeight: 700,
                cursor: voting ? "default" : "pointer", transition: "all 0.2s",
              }}>
                {isArbiter ? "Side with " + releaseWinner : "✓ " + getVoteLabel(state.category, state.fulfillment, myRole, Outcome.RELEASE)}
              </button>
            )}
            {showRefund && (
              <button disabled={voting} onClick={() => handleVote(Outcome.REFUND)} style={{
                flex: 1, padding: "16px", borderRadius: T.rs,
                background: voting ? T.surface : refundBg,
                border: `1px solid ${refundBorder}`,
                color: refundText,
                fontFamily: T.mono, fontSize: 14, fontWeight: 700,
                cursor: voting ? "default" : "pointer", transition: "all 0.2s",
              }}>
                {state.subscription
                  ? "🛑 Cancel & Refund Remaining"
                  : isArbiter
                    ? "Side with " + refundWinner
                    : "↩ " + getVoteLabel(state.category, state.fulfillment, myRole, Outcome.REFUND)}
              </button>
            )}
          </div>
        );
      })()}

      {/* Claim button.
          v0.3.1 Phase 3 expanded scope (Q4): boot probe also gates
          the Claim button. When bootProbeFailed === true, the button
          disables with "Federation unreachable — reconnect first"
          subtitle. The Reconnect CTA lives in ChamaBar (single
          source of truth). */}
      {state.status === EscrowStatus.APPROVED && iAmWinner && !state.subscription && (
        <div style={{ marginBottom: 16 }}>
          <button
            disabled={claiming || bootProbeFailed}
            onClick={async () => {
              setClaiming(true);
              try {
                await onClaim();
              } finally {
                setClaiming(false);
              }
            }}
            style={{
              width: "100%", padding: "18px", borderRadius: T.rs,
              background: claiming || bootProbeFailed
                ? T.surface
                : `linear-gradient(135deg, ${T.accent}, ${T.amber})`,
              border: "none",
              color: claiming || bootProbeFailed ? T.muted : T.bg,
              fontFamily: T.mono, fontSize: 15, fontWeight: 800,
              cursor: claiming || bootProbeFailed ? "default" : "pointer", letterSpacing: 1,
              animation: (claiming || bootProbeFailed) ? "none" : "pulse 2s ease-in-out infinite",
            }}>
            {claiming ? "Claiming…" : "⚡ CLAIM YOUR SATS"}
          </button>
          {bootProbeFailed && (
            <div style={{
              textAlign: "center", marginTop: 8,
              fontSize: 10, color: T.amber, fontFamily: T.mono,
            }}>
              Federation unreachable — reconnect first
            </div>
          )}
        </div>
      )}

      {/* Trade chat */}
      {myRole && (
        <ChatPanel state={state} myRole={myRole} onSend={onSendChat} />
      )}

      {/* Event chain */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: T.r, padding: 20 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 16 }}>
          NOSTR EVENT CHAIN
        </div>
        <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono }}>
          {state.eventChain.length} events · {state.chatMessages.length} chat messages
        </div>
        {state.eventChain.map((evt) => (
          <div key={evt.raw.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0" }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: T.green }} />
            <span style={{ fontSize: 11, fontFamily: T.mono, color: T.muted }}>
              kind:{evt.kind} — {evt.payload.type.replace("escrow:", "")}
            </span>
            <span style={{ fontSize: 9, fontFamily: T.mono, color: T.border, marginLeft: "auto" }}>
              {evt.raw.id.slice(0, 8)}…
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
