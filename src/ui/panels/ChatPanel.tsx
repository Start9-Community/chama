import { useState, useEffect, useRef } from "react";
import { type EscrowState, Role } from "../../escrow-engine/types.js";
import { T } from "../theme.js";

export function ChatPanel({ state, myRole, onSend }: {
  state: EscrowState;
  myRole: Role | null;
  onSend: (message: string) => void;
}) {
  const [msg, setMsg] = useState("");
  const [sending, setSending] = useState(false);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.chatMessages.length]);

  const handleSend = async () => {
    const text = msg.trim();
    if (!text || !myRole || sending) return;
    setSending(true);
    try {
      onSend(text);
      setMsg("");
    } finally {
      setTimeout(() => setSending(false), 500);
    }
  };

  const roleColor = (role: string) =>
    role === "buyer" ? "#BF5AF2" : role === "seller" ? "#F7931A" : role === "arbiter" ? "#5AC8FA" : T.muted;

  const roleName = (role: string) =>
    role === "buyer" ? "Buyer" : role === "seller" ? "Seller" : role === "arbiter" ? "Arbiter" : "Unknown";

  return (
    <div style={{
      background: T.card, border: `1px solid ${T.border}`,
      borderRadius: T.r, marginBottom: 16, overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{
        padding: "12px 16px",
        borderBottom: `1px solid ${T.border}`,
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono, letterSpacing: 1 }}>
          TRADE CHAT
        </div>
        <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono }}>
          {state.chatMessages.length} message{state.chatMessages.length !== 1 ? "s" : ""}
          {" · plaintext"}
        </div>
      </div>

      {/* Messages */}
      <div style={{
        maxHeight: 240, overflowY: "auto", padding: "12px 16px",
        display: "flex", flexDirection: "column", gap: 8,
      }}>
        {state.chatMessages.length === 0 ? (
          <div style={{
            textAlign: "center", padding: "20px 0",
            color: T.muted, fontFamily: T.mono, fontSize: 11,
          }}>
            No messages yet. Say something!
          </div>
        ) : (
          state.chatMessages.map((chat, i) => {
            const payload = chat.payload as any;
            const isMe = myRole === payload.senderRole;
            const color = roleColor(payload.senderRole);
            return (
              <div key={chat.raw.id || i} style={{
                display: "flex", flexDirection: "column",
                alignItems: isMe ? "flex-end" : "flex-start",
              }}>
                <div style={{
                  fontSize: 9, color, fontFamily: T.mono,
                  fontWeight: 600, marginBottom: 2,
                }}>
                  {isMe ? "You" : roleName(payload.senderRole)}
                </div>
                <div style={{
                  padding: "8px 12px", borderRadius: 12,
                  background: isMe ? `${color}22` : T.surface,
                  border: `1px solid ${isMe ? color + "33" : T.border}`,
                  maxWidth: "80%",
                }}>
                  <div style={{
                    fontSize: 12, color: T.text, fontFamily: T.sans,
                    lineHeight: 1.4, wordBreak: "break-word",
                  }}>
                    {payload.message}
                  </div>
                </div>
                <div style={{
                  fontSize: 8, color: T.muted, fontFamily: T.mono, marginTop: 2,
                }}>
                  {new Date(payload.sentAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </div>
              </div>
            );
          })
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Input bar */}
      {myRole && (
        <div style={{
          padding: "10px 12px",
          borderTop: `1px solid ${T.border}`,
          display: "flex", gap: 8,
        }}>
          <input
            value={msg}
            onChange={e => setMsg(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleSend()}
            placeholder="Type a message..."
            style={{
              flex: 1, padding: "8px 12px",
              background: T.surface, border: `1px solid ${T.border}`,
              borderRadius: 20, color: T.text,
              fontFamily: T.sans, fontSize: 12, outline: "none",
            }}
          />
          <button
            onClick={handleSend}
            disabled={!msg.trim() || sending}
            style={{
              padding: "8px 16px", borderRadius: 20,
              background: msg.trim() && !sending ? T.accentDim : T.surface,
              border: `1px solid ${msg.trim() && !sending ? T.accent + "44" : T.border}`,
              color: msg.trim() && !sending ? T.accent : T.muted,
              fontFamily: T.mono, fontSize: 11, fontWeight: 700,
              cursor: msg.trim() && !sending ? "pointer" : "default",
              transition: "all 0.2s",
            }}
          >
            Send
          </button>
        </div>
      )}

      {/* Keet link placeholder */}
      <div style={{
        padding: "8px 16px",
        borderTop: `1px solid ${T.border}`,
        textAlign: "center",
      }}>
        <span style={{
          fontSize: 9, color: T.muted, fontFamily: T.mono,
        }}>
          Need encryption? Use{" "}
          <span style={{ color: T.purple, cursor: "pointer" }}
            onClick={() => window.open("https://keet.io", "_blank")}>
            Keet
          </span>
          {" "}for private conversations
        </span>
      </div>
    </div>
  );
}
