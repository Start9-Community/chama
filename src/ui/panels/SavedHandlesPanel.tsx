import { useState } from "react";
import { T, inputStyle } from "../theme.js";
import {
  type SavedHandle,
  listSavedHandles,
  addSavedHandle,
  deleteSavedHandle,
  setHandleVisibility,
  maskHandle,
} from "../../payments/saved-handles.js";
import {
  getRailByKey,
  railsForCommunity,
  railAllowsPublicHandle,
} from "../../payments/rail-registry.js";

// Add/edit/delete payment handles. Per-handle visibility toggle renders
// only when rail.allowPublicHandle === true (sensitive rails are locked
// private — saved-handles.ts enforces the same on writes as defense in
// depth). Handle preview is masked by default with reveal-on-tap so the
// owner can audit without exposing PII to a shoulder-surfer.
export function SavedHandlesPanel({ communitySlug, onClose }: {
  communitySlug: string;
  onClose: () => void;
}) {
  const [handles, setHandles] = useState<SavedHandle[]>(() => listSavedHandles());
  const [revealedIds, setRevealedIds] = useState<Set<string>>(new Set());
  const [addRail, setAddRail] = useState<string>("");
  const [addValue, setAddValue] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const refresh = () => setHandles(listSavedHandles());

  const availableRails = railsForCommunity(communitySlug);

  const handleAdd = () => {
    setError(null);
    if (!addRail || !addValue.trim()) {
      setError("Pick a rail and enter a handle");
      return;
    }
    try {
      addSavedHandle(addRail, addValue.trim());
      setAddRail("");
      setAddValue("");
      refresh();
    } catch (e: any) {
      setError(e?.message || "Failed to save");
    }
  };

  const handleDelete = (id: string) => {
    deleteSavedHandle(id);
    refresh();
  };

  const handleToggleVisibility = (h: SavedHandle) => {
    setError(null);
    const next = h.visibility === "public" ? "private" : "public";
    const result = setHandleVisibility(h.id, next);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    refresh();
  };

  const handleReveal = (id: string) => {
    setRevealedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <div style={{ padding: 16, maxWidth: 560, margin: "0 auto" }}>
      <div style={{
        display: "flex", justifyContent: "space-between",
        alignItems: "center", marginBottom: 20,
      }}>
        <span style={{ fontSize: 18, fontWeight: 700, color: T.text, fontFamily: T.sans }}>
          Payment handles
        </span>
        <button onClick={onClose} style={{
          background: "none", border: "none",
          color: T.muted, fontSize: 20, cursor: "pointer",
        }}>×</button>
      </div>

      <div style={{
        fontSize: 11, color: T.muted, fontFamily: T.mono,
        marginBottom: 16, lineHeight: 1.5,
      }}>
        Handles are private by default. They're revealed to the three
        participants of a trade only after lock. Public-by-design rails
        (Revtag, $cashtag, etc.) can be opted in for profile display.
      </div>

      {/* Existing handles list */}
      {handles.length === 0 ? (
        <div style={{
          padding: 24, textAlign: "center", borderRadius: T.r,
          background: T.surface, border: `1px dashed ${T.border}`,
          color: T.muted, fontFamily: T.mono, fontSize: 12,
          marginBottom: 20,
        }}>
          No saved handles yet. Add one below to auto-fill at trade time.
        </div>
      ) : (
        <div style={{ marginBottom: 24 }}>
          {handles.map(h => {
            const rail = getRailByKey(h.rail);
            const railName = rail?.displayName || h.rail;
            const allowsPublic = railAllowsPublicHandle(h.rail);
            const revealed = revealedIds.has(h.id);
            const display = revealed ? h.handle : maskHandle(h.handle);
            return (
              <div key={h.id} style={{
                background: T.card, border: `1px solid ${T.border}`,
                borderRadius: T.r, padding: 14, marginBottom: 10,
              }}>
                <div style={{
                  display: "flex", justifyContent: "space-between",
                  alignItems: "baseline", marginBottom: 8,
                }}>
                  <span style={{
                    fontSize: 12, fontWeight: 700, color: T.text,
                    fontFamily: T.sans,
                  }}>{railName}</span>
                  {allowsPublic ? (
                    <button
                      onClick={() => handleToggleVisibility(h)}
                      style={{
                        padding: "3px 10px", borderRadius: 12,
                        background: h.visibility === "public" ? T.greenDim : T.surface,
                        border: `1px solid ${h.visibility === "public" ? T.green + "66" : T.border}`,
                        color: h.visibility === "public" ? T.green : T.muted,
                        fontFamily: T.mono, fontSize: 9, fontWeight: 700,
                        cursor: "pointer", letterSpacing: 0.3,
                      }}
                    >
                      {h.visibility === "public" ? "PUBLIC" : "PRIVATE"}
                    </button>
                  ) : (
                    <span style={{
                      padding: "3px 10px", borderRadius: 12,
                      background: T.surface, border: `1px solid ${T.border}`,
                      color: T.muted, fontFamily: T.mono, fontSize: 9, fontWeight: 700,
                      letterSpacing: 0.3,
                    }}>PRIVATE · LOCKED</span>
                  )}
                </div>
                <div
                  onClick={() => handleReveal(h.id)}
                  style={{
                    fontFamily: T.mono, fontSize: 13, color: T.text,
                    padding: "8px 10px", background: T.surface,
                    borderRadius: T.rs, cursor: "pointer",
                    border: `1px solid ${T.border}`, marginBottom: 8,
                  }}
                  title={revealed ? "Tap to mask" : "Tap to reveal"}
                >
                  {display}
                  <span style={{ float: "right", color: T.muted, fontSize: 10 }}>
                    {revealed ? "🙈 mask" : "👁 reveal"}
                  </span>
                </div>
                <button
                  onClick={() => handleDelete(h.id)}
                  style={{
                    background: "none", border: "none",
                    color: T.red, fontFamily: T.mono, fontSize: 10,
                    cursor: "pointer", padding: 0,
                  }}
                >Delete</button>
              </div>
            );
          })}
        </div>
      )}

      {/* Add new handle */}
      <div style={{
        background: T.card, border: `1px solid ${T.border}`,
        borderRadius: T.r, padding: 16,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 600, color: T.muted,
          fontFamily: T.mono, letterSpacing: 1, marginBottom: 12,
        }}>
          ADD HANDLE
        </div>
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>
            RAIL
          </div>
          <select
            value={addRail}
            onChange={e => { setAddRail(e.target.value); setError(null); }}
            style={{ ...inputStyle, color: T.text, background: T.surface }}
          >
            <option value="">— pick a rail —</option>
            {availableRails.map(r => (
              <option key={r.key} value={r.key}>
                {r.displayName} {r.allowPublicHandle ? "" : "· private only"}
              </option>
            ))}
          </select>
        </div>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>
            HANDLE
          </div>
          <input
            value={addValue}
            onChange={e => { setAddValue(e.target.value); setError(null); }}
            placeholder={getRailByKey(addRail)?.placeholder || "Your handle"}
            style={inputStyle}
          />
        </div>
        {error && (
          <div style={{
            color: T.red, fontFamily: T.mono, fontSize: 11,
            marginBottom: 10,
          }}>{error}</div>
        )}
        <button
          onClick={handleAdd}
          disabled={!addRail || !addValue.trim()}
          style={{
            width: "100%", padding: "12px", borderRadius: T.rs,
            background: !addRail || !addValue.trim() ? T.surface : T.accentDim,
            border: `1px solid ${!addRail || !addValue.trim() ? T.border : T.accent + "44"}`,
            color: !addRail || !addValue.trim() ? T.muted : T.accent,
            fontFamily: T.mono, fontSize: 12, fontWeight: 700,
            cursor: !addRail || !addValue.trim() ? "default" : "pointer",
          }}
        >
          Save handle
        </button>
      </div>
    </div>
  );
}
