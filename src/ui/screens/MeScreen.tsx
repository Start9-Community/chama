import { type EscrowState } from "../../escrow-engine/types.js";
import { T } from "../theme.js";
import { TradeCard } from "../components/TradeCard.js";

// Top-level Me — profile + entries to Saved handles + Advanced + a
// trade history list. v0.2.0 will expand this into ratings, Nostr
// Profile sub-section, etc. v0.1.85 gives it a structural home.
export function MeScreen({
  pubkey,
  myTrades,
  onOpenTrade,
  onOpenSavedHandles,
  onOpenAdvanced,
  onSignOut,
}: {
  pubkey: string;
  myTrades: EscrowState[];
  onOpenTrade: (id: string) => void;
  onOpenSavedHandles: () => void;
  onOpenAdvanced: () => void;
  onSignOut: () => void;
}) {
  const npubShort = pubkey.slice(0, 8) + "…" + pubkey.slice(-4);

  return (
    <div style={{ padding: 16, maxWidth: 560, margin: "0 auto" }}>
      {/* Profile header */}
      <div style={{
        background: T.card, border: `1px solid ${T.border}`,
        borderRadius: T.r, padding: 20, marginBottom: 16,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono,
          letterSpacing: 1, marginBottom: 10,
        }}>
          PROFILE
        </div>
        <div style={{
          display: "flex", alignItems: "center", gap: 14,
        }}>
          <div style={{
            width: 48, height: 48, borderRadius: "50%",
            background: T.accentDim, border: `1px solid ${T.accent}66`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: T.mono, fontSize: 18, fontWeight: 800, color: T.accent,
            flexShrink: 0,
          }}>
            {pubkey.slice(0, 1).toUpperCase()}
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 12, color: T.muted, fontFamily: T.mono, marginBottom: 4 }}>
              npub
            </div>
            <div style={{
              fontFamily: T.mono, fontSize: 13, color: T.text,
              wordBreak: "break-all" as const,
            }}>
              {npubShort}
            </div>
          </div>
        </div>
      </div>

      {/* Sub-page entries */}
      <div style={{
        background: T.card, border: `1px solid ${T.border}`,
        borderRadius: T.r, padding: 0, marginBottom: 16, overflow: "hidden",
      }}>
        <SettingsRow label="Payment handles" hint="Saved handles for fast trade-time fill" onClick={onOpenSavedHandles} />
        <SettingsRow label="Advanced" hint="Sandbox mode and federation tools" onClick={onOpenAdvanced} />
        <SettingsRow label="Sign out" hint={null} onClick={onSignOut} danger />
      </div>

      {/* My trade history */}
      <div style={{
        fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono,
        letterSpacing: 1, marginBottom: 8,
      }}>
        MY TRADES ({myTrades.length})
      </div>
      {myTrades.length === 0 ? (
        <div style={{
          padding: 24, textAlign: "center",
          background: T.surface, border: `1px dashed ${T.border}`,
          borderRadius: T.r, color: T.muted, fontFamily: T.mono, fontSize: 11,
        }}>
          No trades yet. Browse listings to start one.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {myTrades.map((s, i) => (
            <div key={s.id} style={{ animation: `fadeIn 0.4s ease ${i * 0.05}s both` }}>
              <TradeCard state={s} pubkey={pubkey} onSelect={() => onOpenTrade(s.id)} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SettingsRow({ label, hint, onClick, danger }: {
  label: string; hint: string | null; onClick: () => void; danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        width: "100%", padding: "14px 16px",
        background: "none", border: "none", borderBottom: `1px solid ${T.border}`,
        color: danger ? T.red : T.text,
        cursor: "pointer", textAlign: "left" as const,
        fontFamily: T.sans,
      }}
    >
      <div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div>
        {hint && (
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginTop: 2 }}>
            {hint}
          </div>
        )}
      </div>
      <span style={{ color: T.muted, fontSize: 16 }}>›</span>
    </button>
  );
}
