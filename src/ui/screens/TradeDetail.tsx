import { useState } from "react";
import {
  type EscrowState,
  Role,
  Outcome,
  EscrowStatus,
} from "../../escrow-engine/types.js";
import { canVote, getWinner } from "../../escrow-engine/state-machine.js";
import { getVoteLabel } from "../../labels/vote-labels.js";
import {
  listSavedHandles,
  maskHandle,
  handleDisplayForViewer,
} from "../../payments/saved-handles.js";
import { getRailByKey } from "../../payments/rail-registry.js";
import {
  T, STATUS, ROLE_COLOR, CAT_LABEL,
  fmtSats, refundRecipientFor, inputStyle,
} from "../theme.js";
import { Badge } from "../components/Badge.js";
import { Dot } from "../components/Dot.js";
import { CountdownTimer } from "../components/CountdownTimer.js";
import { SubscriptionTimeline } from "../components/SubscriptionTimeline.js";
import { ChatPanel } from "../panels/ChatPanel.js";

export function TradeDetail({
  state, pubkey, onBack, onVote, onClaim, onJoin, onLock, onSendChat, onReleasePeriod, onOpenSettings,
}: {
  state: EscrowState; pubkey: string;
  onBack: () => void;
  onVote: (outcome: Outcome) => void;
  onClaim: () => void;
  onJoin: (role: Role) => void;
  onLock: (savedHandleId?: string) => Promise<void>;
  onSendChat: (message: string) => void;
  onReleasePeriod?: (periodIndex: number) => void | Promise<void>;
  onOpenSettings?: () => void;
}) {
  const [voting, setVoting] = useState(false);
  const [joining, setJoining] = useState(false);
  const [locking, setLocking] = useState(false);
  const [selectedHandleId, setSelectedHandleId] = useState<string>("");
  const s = STATUS[state.status] || STATUS.CREATED;
  const myRole = state.participants.buyer === pubkey ? Role.BUYER
    : state.participants.seller === pubkey ? Role.SELLER
    : state.participants.arbiter === pubkey ? Role.ARBITER : null;
  const voteCheck = myRole ? canVote(state, pubkey) : { canVote: false };
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

      {/* Participants */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: T.r, padding: 20, marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 16 }}>PARTICIPANTS</div>
        <div style={{ display: "flex", justifyContent: "space-around" }}>
          {([Role.BUYER, Role.SELLER, Role.ARBITER] as Role[]).map(role => (
            <Dot key={role} role={role} pk={state.participants[role]} isYou={myRole === role}
              voted={!!state.votes[role]} outcome={state.votes[role]} />
          ))}
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
            {!state.participants.arbiter && (
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

          <button
            disabled={locking || !state.participants.buyer}
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
              background: locking || !state.participants.buyer
                ? T.surface
                : `linear-gradient(135deg, ${T.accent}, ${T.amber})`,
              border: "none",
              color: locking || !state.participants.buyer ? T.muted : T.bg,
              fontFamily: T.mono, fontSize: 14, fontWeight: 800,
              cursor: locking || !state.participants.buyer ? "default" : "pointer",
              letterSpacing: 0.5, transition: "all 0.2s",
            }}
          >
            {locking ? "Locking..." : "⚡ " + lockLabel + " · " + fmtSats(state.amountMsats) + " sats"}
          </button>
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
          }}>
            {handleDisplayForViewer(state.lock.handle.value, !!myRole)}
          </div>
          <div style={{
            fontSize: 9, color: T.muted, fontFamily: T.mono,
            marginTop: 6, lineHeight: 1.4,
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

      {/* Vote buttons — vertical-aware copy from the label dictionary */}
      {voteCheck.canVote && myRole && (
        <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
          {!state.subscription && (
            <button disabled={voting} onClick={() => handleVote(Outcome.RELEASE)} style={{
              flex: 1, padding: "16px", borderRadius: T.rs,
              background: voting ? T.surface : T.greenDim,
              border: `1px solid ${T.green}44`, color: T.green,
              fontFamily: T.mono, fontSize: 14, fontWeight: 700,
              cursor: voting ? "default" : "pointer", transition: "all 0.2s",
            }}>
              ✓ {getVoteLabel(state.category, state.fulfillment, myRole, Outcome.RELEASE)}
            </button>
          )}
          <button disabled={voting} onClick={() => handleVote(Outcome.REFUND)} style={{
            flex: 1, padding: "16px", borderRadius: T.rs,
            background: voting ? T.surface : state.subscription ? T.redDim : T.amberDim,
            border: `1px solid ${state.subscription ? T.red : T.amber}44`,
            color: state.subscription ? T.red : T.amber,
            fontFamily: T.mono, fontSize: 14, fontWeight: 700,
            cursor: voting ? "default" : "pointer", transition: "all 0.2s",
          }}>
            {state.subscription
              ? "🛑 Cancel & Refund Remaining"
              : "↩ " + getVoteLabel(state.category, state.fulfillment, myRole, Outcome.REFUND)}
          </button>
        </div>
      )}

      {/* Claim button */}
      {state.status === EscrowStatus.APPROVED && iAmWinner && !state.subscription && (
        <button onClick={onClaim} style={{
          width: "100%", padding: "18px", borderRadius: T.rs,
          background: `linear-gradient(135deg, ${T.accent}, ${T.amber})`,
          border: "none", color: T.bg,
          fontFamily: T.mono, fontSize: 15, fontWeight: 800,
          cursor: "pointer", letterSpacing: 1,
          marginBottom: 16,
          animation: "pulse 2s ease-in-out infinite",
        }}>
          ⚡ CLAIM YOUR SATS
        </button>
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
