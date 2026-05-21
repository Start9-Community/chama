import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { type ChatImageAttachment, type EscrowState, Role } from "../../escrow-engine/types.js";
import { T } from "../theme.js";

const MAX_CHAT_IMAGE_DATA_URL_CHARS = 120_000;
const CHAT_IMAGE_MAX_EDGE_PX = 960;

type SendChatInput = string | { message: string; attachments?: ChatImageAttachment[] };

async function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Couldn't read image"));
    reader.readAsDataURL(file);
  });
}

async function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't load image"));
    img.src = dataUrl;
  });
}

function imageId(): string {
  return `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function prepareChatImage(file: File): Promise<ChatImageAttachment> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Choose an image file");
  }

  const original = await readFileAsDataUrl(file);
  const img = await loadImage(original);
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;

  if (original.length <= MAX_CHAT_IMAGE_DATA_URL_CHARS) {
    return {
      id: imageId(),
      kind: "image",
      mimeType: file.type || "image/jpeg",
      dataUrl: original,
      name: file.name,
      width,
      height,
      sizeBytes: file.size,
    };
  }

  const scale = Math.min(1, CHAT_IMAGE_MAX_EDGE_PX / Math.max(width, height));
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Image preview is not available in this browser");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, targetWidth, targetHeight);
  ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

  for (const quality of [0.78, 0.68, 0.58, 0.48, 0.38]) {
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    if (dataUrl.length <= MAX_CHAT_IMAGE_DATA_URL_CHARS) {
      return {
        id: imageId(),
        kind: "image",
        mimeType: "image/jpeg",
        dataUrl,
        name: file.name,
        width: targetWidth,
        height: targetHeight,
        sizeBytes: Math.ceil(dataUrl.length * 0.75),
      };
    }
  }

  throw new Error("That image is too large for encrypted chat. Try a tighter screenshot.");
}

export function ChatPanel({ state, myRole, onSend }: {
  state: EscrowState;
  myRole: Role | null;
  onSend: (message: SendChatInput) => void;
}) {
  const [msg, setMsg] = useState("");
  const [attachment, setAttachment] = useState<ChatImageAttachment | null>(null);
  const [viewer, setViewer] = useState<ChatImageAttachment | null>(null);
  const [sending, setSending] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Auto-scroll to bottom when new messages or attachments arrive
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.chatMessages.length]);

  const handleSend = async () => {
    const text = msg.trim();
    if ((!text && !attachment) || !myRole || sending) return;
    setSending(true);
    setErr(null);
    try {
      onSend({
        message: text,
        ...(attachment ? { attachments: [attachment] } : {}),
      });
      setMsg("");
      setAttachment(null);
    } finally {
      setTimeout(() => setSending(false), 500);
    }
  };

  const handleImagePick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.currentTarget.value = "";
    if (!file || imageBusy) return;
    setImageBusy(true);
    setErr(null);
    try {
      setAttachment(await prepareChatImage(file));
    } catch (error: any) {
      setErr(error?.message || "Couldn't attach that image");
    } finally {
      setImageBusy(false);
    }
  };

  const roleColor = (role: string) =>
    role === "buyer" ? "#BF5AF2" : role === "seller" ? "#F7931A" : role === "arbiter" ? "#5AC8FA" : T.muted;

  const roleName = (role: string) =>
    role === "buyer" ? "Buyer" : role === "seller" ? "Seller" : role === "arbiter" ? "Arbiter" : "Unknown";

  const canSend = (!!msg.trim() || !!attachment) && !sending && !imageBusy;

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
          {" · private"}
        </div>
      </div>

      {/* Messages */}
      <div style={{
        maxHeight: 280, overflowY: "auto", padding: "12px 16px",
        display: "flex", flexDirection: "column", gap: 10,
      }}>
        {state.chatMessages.length === 0 ? (
          <div style={{
            textAlign: "center", padding: "20px 0",
            color: T.muted, fontFamily: T.mono, fontSize: 11,
          }}>
            No messages yet.
          </div>
        ) : (
          state.chatMessages.map((chat, i) => {
            const payload = chat.payload as any;
            const attachments: ChatImageAttachment[] = Array.isArray(payload.attachments)
              ? payload.attachments.filter((a: any): a is ChatImageAttachment => a?.kind === "image")
              : [];
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
                  padding: attachments.length > 0 ? 6 : "8px 12px",
                  borderRadius: 12,
                  background: isMe ? `${color}22` : T.surface,
                  border: `1px solid ${isMe ? color + "33" : T.border}`,
                  maxWidth: "84%",
                }}>
                  {attachments.map((image) => (
                    <button
                      key={image.id}
                      onClick={() => setViewer(image)}
                      style={{
                        display: "block", padding: 0, margin: payload.message ? "0 0 8px" : 0,
                        border: "none", background: "transparent", cursor: "zoom-in",
                        width: "100%", maxWidth: 220,
                      }}
                    >
                      <img
                        src={image.dataUrl}
                        alt={image.name || "chat attachment"}
                        style={{
                          display: "block", width: "100%", maxHeight: 180,
                          objectFit: "cover", borderRadius: 8,
                          border: `1px solid ${T.border}`,
                        }}
                      />
                    </button>
                  ))}
                  {payload.message && (
                    <div style={{
                      fontSize: 12, color: T.text, fontFamily: T.sans,
                      lineHeight: 1.4, wordBreak: "break-word",
                      padding: attachments.length > 0 ? "0 4px 2px" : 0,
                    }}>
                      {payload.message}
                    </div>
                  )}
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
          display: "grid", gap: 8,
        }}>
          {attachment && (
            <div style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: 8, background: T.surface, border: `1px solid ${T.border}`,
              borderRadius: 12,
            }}>
              <img
                src={attachment.dataUrl}
                alt={attachment.name || "selected receipt"}
                style={{
                  width: 56, height: 56, objectFit: "cover",
                  borderRadius: 8, border: `1px solid ${T.border}`,
                  flex: "0 0 auto",
                }}
              />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{
                  fontSize: 11, color: T.text, fontFamily: T.sans,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {attachment.name || "Image ready"}
                </div>
                <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, marginTop: 2 }}>
                  encrypted receipt image
                </div>
              </div>
              <button
                onClick={() => setAttachment(null)}
                style={{
                  background: "none", border: `1px solid ${T.border}`,
                  color: T.muted, borderRadius: 999, width: 28, height: 28,
                  cursor: "pointer", fontSize: 16, lineHeight: 1,
                }}
              >
                x
              </button>
            </div>
          )}
          {err && (
            <div style={{
              padding: "8px 10px", background: T.redDim,
              border: `1px solid ${T.red}33`, borderRadius: 10,
              color: T.red, fontSize: 10, fontFamily: T.mono,
            }}>
              {err}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              onChange={handleImagePick}
              style={{ display: "none" }}
            />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={imageBusy || sending}
              title="Attach receipt image"
              style={{
                width: 38, height: 38, borderRadius: 20,
                background: imageBusy ? T.surface : T.tealDim,
                border: `1px solid ${imageBusy ? T.border : T.teal + "44"}`,
                color: imageBusy ? T.muted : T.teal,
                fontFamily: T.mono, fontSize: 17, fontWeight: 900,
                cursor: imageBusy || sending ? "default" : "pointer",
                flex: "0 0 auto",
              }}
            >
              {imageBusy ? "..." : "+"}
            </button>
            <input
              value={msg}
              onChange={e => setMsg(e.target.value)}
              onKeyDown={e => e.key === "Enter" && !e.shiftKey && handleSend()}
              placeholder={attachment ? "Add a note..." : "Type a message..."}
              style={{
                flex: 1, minWidth: 0, padding: "9px 12px",
                background: T.surface, border: `1px solid ${T.border}`,
                borderRadius: 20, color: T.text,
                fontFamily: T.sans, fontSize: 12, outline: "none",
              }}
            />
            <button
              onClick={handleSend}
              disabled={!canSend}
              style={{
                padding: "9px 14px", borderRadius: 20,
                background: canSend ? T.accentDim : T.surface,
                border: `1px solid ${canSend ? T.accent + "44" : T.border}`,
                color: canSend ? T.accent : T.muted,
                fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                cursor: canSend ? "pointer" : "default",
                transition: "all 0.2s",
                flex: "0 0 auto",
              }}
            >
              Send
            </button>
          </div>
        </div>
      )}

      {viewer && (
        <div
          onClick={() => setViewer(null)}
          style={{
            position: "fixed", inset: 0, zIndex: 9999,
            background: "#000d", display: "flex",
            alignItems: "center", justifyContent: "center",
            padding: 16,
          }}
        >
          <button
            onClick={() => setViewer(null)}
            style={{
              position: "absolute", top: 14, right: 14,
              width: 36, height: 36, borderRadius: 999,
              border: `1px solid ${T.borderHi}`,
              background: T.card, color: T.text,
              fontSize: 22, lineHeight: 1, cursor: "pointer",
            }}
          >
            x
          </button>
          <img
            onClick={(e) => e.stopPropagation()}
            src={viewer.dataUrl}
            alt={viewer.name || "chat attachment"}
            style={{
              maxWidth: "100%", maxHeight: "100%",
              objectFit: "contain", borderRadius: 8,
              border: `1px solid ${T.borderHi}`,
              background: T.card,
            }}
          />
        </div>
      )}
    </div>
  );
}
