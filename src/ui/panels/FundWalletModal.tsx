import { useState, useEffect, lazy, Suspense } from "react";
import { T, inputStyle } from "../theme.js";
import { isSimModeOn } from "../../sim/simMode.js";

const QRCode = lazy(() => import("../QRCode.js"));

export function FundWalletModal({ onClose, onCreateInvoice, onPayInvoice, onSpendNotes, balanceMsats }: {
  onClose: () => void;
  onCreateInvoice: (amountSats: number, description: string) => Promise<string>;
  onPayInvoice: (bolt11: string) => Promise<void>;
  onSpendNotes: (amountMsats: number) => Promise<string>;
  balanceMsats: number;
}) {
  const [tab, setTab] = useState<"receive" | "send">("receive");
  const [amountSats, setAmountSats] = useState("10000");
  const [description, setDescription] = useState("Chama top-up");
  const [invoice, setInvoice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [sendType, setSendType] = useState<"lightning" | "ecash">("lightning");
  const [bolt11Input, setBolt11Input] = useState("");
  const [ecashOutput, setEcashOutput] = useState<string | null>(null);

  // Receive-confirmation tracking.
  const [balanceAtInvoice, setBalanceAtInvoice] = useState<number | null>(null);
  const [expectedMsats, setExpectedMsats] = useState<number>(0);
  const [invoiceExpiresAt, setInvoiceExpiresAt] = useState<number | null>(null);
  const [received, setReceived] = useState(false);
  const [nowTick, setNowTick] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    if (!invoice || received) return;
    const id = setInterval(() => setNowTick(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, [invoice, received]);

  // NOTE: `received` intentionally NOT in deps — see v0.1.62 bug notes.
  useEffect(() => {
    if (!invoice || received || balanceAtInvoice === null) return;
    const delta = balanceMsats - balanceAtInvoice;
    if (delta >= expectedMsats && expectedMsats > 0) {
      setReceived(true);
      if (typeof navigator !== "undefined" && navigator.vibrate) {
        navigator.vibrate([40, 30, 40, 30, 120]);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [balanceMsats, balanceAtInvoice, expectedMsats, invoice]);

  useEffect(() => {
    if (!received) return;
    const t = setTimeout(() => {
      setInvoice(null);
      setBalanceAtInvoice(null);
      setExpectedMsats(0);
      setInvoiceExpiresAt(null);
      setReceived(false);
    }, 3500);
    return () => clearTimeout(t);
  }, [received]);

  const handleGenerate = async () => {
    const n = parseInt(amountSats, 10);
    if (!n || n <= 0) { setErr("Enter a valid sats amount"); return; }
    setBusy(true); setErr(null);
    try {
      const bolt11 = await onCreateInvoice(n, description || "Chama top-up");
      setBalanceAtInvoice(balanceMsats);
      setExpectedMsats(n * 1000);
      setInvoiceExpiresAt(Math.floor(Date.now() / 1000) + 600);
      setReceived(false);
      setInvoice(bolt11);
    } catch (e: any) {
      setErr(e.message || "Failed to create invoice");
    } finally { setBusy(false); }
  };

  const handlePayInvoice = async () => {
    if (!bolt11Input.trim()) { setErr("Paste a Lightning invoice"); return; }
    setBusy(true); setErr(null); setSuccess(null);
    try {
      await onPayInvoice(bolt11Input.trim());
      setSuccess("Payment sent!"); setBolt11Input("");
    } catch (e: any) {
      setErr(e.message || "Payment failed");
    } finally { setBusy(false); }
  };

  const handleSpendAll = async () => {
    if (balanceMsats <= 0) { setErr("No balance to send"); return; }
    setBusy(true); setErr(null);
    try { setEcashOutput(await onSpendNotes(balanceMsats)); }
    catch (e: any) { setErr(e.message || "Failed"); }
    finally { setBusy(false); }
  };

  const handleSpendAmount = async () => {
    const n = parseInt(amountSats, 10);
    if (!n || n <= 0) { setErr("Enter a valid sats amount"); return; }
    setBusy(true); setErr(null);
    try { setEcashOutput(await onSpendNotes(n * 1000)); }
    catch (e: any) { setErr(e.message || "Failed"); }
    finally { setBusy(false); }
  };

  const copyText = (text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
  };

  const tabBtn = (t: "receive" | "send", label: string) => (
    <button onClick={() => { setTab(t); setErr(null); setSuccess(null); setInvoice(null); setEcashOutput(null); }} style={{
      flex: 1, padding: "8px 0", borderRadius: T.rs, border: "none",
      background: tab === t ? T.accent : T.surface,
      color: tab === t ? "#000" : T.muted,
      fontFamily: T.mono, fontSize: 11, fontWeight: 700, cursor: "pointer",
    }}>{label}</button>
  );

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "#000a", zIndex: 9998,
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 16, animation: "fadeIn 0.2s ease",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: T.card, border: `1px solid ${T.borderHi}`, borderRadius: T.r,
        padding: 24, maxWidth: 420, width: "100%",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.text, fontFamily: T.sans }}>Chama</div>
          <button onClick={onClose} style={{
            background: "none", border: "none", color: T.muted,
            fontFamily: T.mono, fontSize: 18, cursor: "pointer", padding: 0, lineHeight: 1,
          }}>×</button>
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          {tabBtn("receive", "⚡ Receive")}
          {tabBtn("send", "↗ Send")}
        </div>

        {/* RECEIVE */}
        {tab === "receive" && !invoice && (<>
          <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginBottom: 4, letterSpacing: 1 }}>AMOUNT (SATS)</div>
          <input type="number" value={amountSats} onChange={(e) => setAmountSats(e.target.value)} style={{ ...inputStyle, marginBottom: 12 }} />
          <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginBottom: 4, letterSpacing: 1 }}>DESCRIPTION</div>
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} style={{ ...inputStyle, marginBottom: 16 }} />
          <button disabled={busy} onClick={handleGenerate} style={{
            width: "100%", padding: "12px 16px", borderRadius: T.rs,
            background: busy ? T.surface : T.accent, border: `1px solid ${T.accent}`,
            color: busy ? T.muted : "#000", fontFamily: T.mono, fontSize: 12, fontWeight: 800,
            cursor: busy ? "not-allowed" : "pointer",
          }}>{busy ? "Generating..." : "⚡ Generate Lightning invoice"}</button>
        </>)}

        {tab === "receive" && invoice && received && (
          <div style={{
            padding: "32px 16px", textAlign: "center",
            background: T.greenDim, border: `1px solid ${T.green}66`,
            borderRadius: T.r, animation: "fadeIn 0.3s ease",
          }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>✓</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: T.green, fontFamily: T.sans, marginBottom: 6 }}>
              Payment received
            </div>
            <div style={{ fontSize: 22, fontWeight: 800, color: T.text, fontFamily: T.mono, letterSpacing: -0.5 }}>
              +{(expectedMsats / 1000).toLocaleString()} sats
            </div>
            <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginTop: 12 }}>
              Balance updated · closing…
            </div>
          </div>
        )}
        {tab === "receive" && invoice && !received && (<>
          <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginBottom: 8, letterSpacing: 1, textAlign: "center" }}>SCAN OR COPY TO PAY</div>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
            <Suspense fallback={<div style={{ width: 200, height: 200, background: T.surface, borderRadius: T.rs }} />}>
              <QRCode data={invoice} size={200} fgColor="#a78bfa" />
            </Suspense>
          </div>
          {(() => {
            const remaining = invoiceExpiresAt ? Math.max(0, invoiceExpiresAt - nowTick) : 0;
            const mins = Math.floor(remaining / 60);
            const secs = remaining % 60;
            const expired = invoiceExpiresAt !== null && remaining === 0;
            return (
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                gap: 8, marginBottom: 12, padding: "6px 12px",
                borderRadius: T.rs,
                background: expired ? T.redDim : T.surface,
                border: `1px solid ${expired ? T.red + "44" : T.border}`,
              }}>
                {!expired && (
                  <div style={{
                    width: 8, height: 8, borderRadius: "50%",
                    background: T.accent, animation: "pulse 1.4s ease-in-out infinite",
                  }} />
                )}
                <span style={{
                  fontSize: 10, fontFamily: T.mono,
                  color: expired ? T.red : T.muted, letterSpacing: 0.5,
                }}>
                  {expired
                    ? "Invoice expired — generate a new one"
                    : `Waiting for payment · ${mins}:${secs.toString().padStart(2, "0")}`}
                </span>
              </div>
            );
          })()}
          <div style={{ padding: 8, marginBottom: 12, borderRadius: T.rs, background: T.surface, border: `1px solid ${T.border}`, fontFamily: T.mono, fontSize: 8, color: T.muted, wordBreak: "break-all", maxHeight: 60, overflowY: "auto", textAlign: "center" }}>{invoice}</div>
          {/* v0.4.2 sim-mode honest disclosure (Pillar 2.7). Sim invoices
              auto-settle 3-8s after creation regardless of whether the
              user does anything with the QR. Without this notice, users
              report confusion when the balance credits after they've
              dismissed the modal without action. Amber matches the
              SIM MODE pill's warning palette. */}
          {isSimModeOn() && (
            <div style={{
              padding: "8px 12px", marginBottom: 12, borderRadius: T.rs,
              background: T.amberDim, border: `1px solid ${T.amber}55`,
              fontFamily: T.mono, fontSize: 10, color: T.amber,
              lineHeight: 1.5, textAlign: "center",
            }}>
              ▲ Sim mode — auto-credits in 3-8s.<br />
              Do not fund this invoice with real sats.
            </div>
          )}
          <button onClick={() => copyText(invoice)} style={{ width: "100%", padding: "10px 16px", borderRadius: T.rs, background: T.accentDim, border: `1px solid ${T.accent}44`, color: T.accent, fontFamily: T.mono, fontSize: 11, fontWeight: 700, cursor: "pointer", marginBottom: 8 }}>Copy invoice</button>
          <button onClick={() => {
            setInvoice(null);
            setBalanceAtInvoice(null);
            setExpectedMsats(0);
            setInvoiceExpiresAt(null);
          }} style={{ width: "100%", padding: "10px 16px", borderRadius: T.rs, background: T.surface, border: `1px solid ${T.border}`, color: T.muted, fontFamily: T.mono, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>New invoice</button>
        </>)}

        {/* SEND */}
        {tab === "send" && !ecashOutput && (<>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <button onClick={() => setSendType("lightning")} style={{ flex: 1, padding: "6px 0", borderRadius: T.rs, border: sendType === "lightning" ? `1px solid ${T.accent}` : `1px solid ${T.border}`, background: sendType === "lightning" ? T.accentDim : T.surface, color: sendType === "lightning" ? T.accent : T.muted, fontFamily: T.mono, fontSize: 10, cursor: "pointer" }}>Lightning</button>
            <button onClick={() => setSendType("ecash")} style={{ flex: 1, padding: "6px 0", borderRadius: T.rs, border: sendType === "ecash" ? `1px solid ${T.amber}` : `1px solid ${T.border}`, background: sendType === "ecash" ? T.amberDim : T.surface, color: sendType === "ecash" ? T.amber : T.muted, fontFamily: T.mono, fontSize: 10, cursor: "pointer" }}>Ecash</button>
          </div>

          {sendType === "lightning" && (<>
            <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginBottom: 4, letterSpacing: 1 }}>PASTE LIGHTNING INVOICE</div>
            <textarea value={bolt11Input} onChange={(e) => setBolt11Input(e.target.value)} placeholder="lnbc1..." rows={3} style={{ ...inputStyle, resize: "vertical" as const, marginBottom: 12, minHeight: 60 }} />
            <button disabled={busy} onClick={handlePayInvoice} style={{ width: "100%", padding: "12px 16px", borderRadius: T.rs, background: busy ? T.surface : T.red, border: `1px solid ${T.red}`, color: busy ? T.muted : "#fff", fontFamily: T.mono, fontSize: 12, fontWeight: 800, cursor: busy ? "not-allowed" : "pointer" }}>{busy ? "Sending..." : "⚡ Pay invoice"}</button>
          </>)}

          {sendType === "ecash" && (<>
            <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginBottom: 4, letterSpacing: 1 }}>AMOUNT (SATS)</div>
            <input type="number" value={amountSats} onChange={(e) => setAmountSats(e.target.value)} style={{ ...inputStyle, marginBottom: 12 }} />
            <div style={{ display: "flex", gap: 8 }}>
              <button disabled={busy} onClick={handleSpendAmount} style={{ flex: 1, padding: "12px 8px", borderRadius: T.rs, background: busy ? T.surface : T.amber, border: `1px solid ${T.amber}`, color: busy ? T.muted : "#000", fontFamily: T.mono, fontSize: 11, fontWeight: 800, cursor: busy ? "not-allowed" : "pointer" }}>{busy ? "Creating..." : "Create ecash"}</button>
              <button disabled={busy} onClick={handleSpendAll} style={{ flex: 1, padding: "12px 8px", borderRadius: T.rs, background: busy ? T.surface : T.red, border: `1px solid ${T.red}`, color: busy ? T.muted : "#fff", fontFamily: T.mono, fontSize: 11, fontWeight: 800, cursor: busy ? "not-allowed" : "pointer" }}>{`Send ALL (${Math.floor(balanceMsats / 1000)} sats)`}</button>
            </div>
          </>)}
        </>)}

        {tab === "send" && ecashOutput && (<>
          <div style={{ fontSize: 10, color: T.amber, fontFamily: T.mono, marginBottom: 8, letterSpacing: 1, textAlign: "center" }}>ECASH NOTES — COPY AND SEND TO RECIPIENT</div>
          <div style={{ padding: 8, marginBottom: 12, borderRadius: T.rs, background: T.surface, border: `1px solid ${T.border}`, fontFamily: T.mono, fontSize: 8, color: T.text, wordBreak: "break-all", maxHeight: 100, overflowY: "auto" }}>{ecashOutput}</div>
          <button onClick={() => copyText(ecashOutput)} style={{ width: "100%", padding: "10px 16px", borderRadius: T.rs, background: T.amberDim, border: `1px solid ${T.amber}44`, color: T.amber, fontFamily: T.mono, fontSize: 11, fontWeight: 700, cursor: "pointer", marginBottom: 8 }}>Copy ecash notes</button>
          <button onClick={() => setEcashOutput(null)} style={{ width: "100%", padding: "10px 16px", borderRadius: T.rs, background: T.surface, border: `1px solid ${T.border}`, color: T.muted, fontFamily: T.mono, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>Done</button>
        </>)}

        {success && <div style={{ marginTop: 12, padding: 10, borderRadius: T.rs, background: T.greenDim, border: `1px solid ${T.green}44`, color: T.green, fontFamily: T.mono, fontSize: 10 }}>{success}</div>}
        {err && <div style={{ marginTop: 12, padding: 10, borderRadius: T.rs, background: T.redDim, border: `1px solid ${T.red}44`, color: T.red, fontFamily: T.mono, fontSize: 10 }}>{err}</div>}
      </div>
    </div>
  );
}
